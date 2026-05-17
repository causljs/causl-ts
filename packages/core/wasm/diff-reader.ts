/**
 * @packageDocumentation @internal
 *
 * Phase 2 / #1561 / epic #1558 — JS-side typed-array view over the
 * WASM diff buffer.
 *
 * Refreshes its views on every `memory.grow` (compares
 * `view.buffer === memory.buffer` at access time). Without refresh,
 * stale `Uint8Array`/`DataView` views point at a detached
 * `ArrayBuffer` and reads throw `TypeError` (V8) or return garbage
 * (other engines).
 *
 * Record layouts are pinned in `cmd-buf.ts` (see file header).
 * Decoder methods here surface payload fields directly; the
 * structural walker is {@link readDiffs} in `cmd-buf.ts`.
 *
 * NOT YET wired into `WasmStateMirror.apply()` — that flip is
 * Wave 3b (marshaler protocol selector). Today this module is a
 * standalone reader; tests construct one over an arbitrary
 * `WebAssembly.Memory` (or a synthetic `ArrayBuffer` via
 * {@link DiffReader.fromBuffer}) and exercise the public surface
 * directly.
 */

import {
  RECORD_HEADER_BYTES,
  Tag,
  readDiffs,
  type DiffRecord,
} from './cmd-buf.js'

// Re-export shared enums + helpers so consumers only need this file
// for the read path (mirrors the `cmd-buf.ts` self-contained pattern
// for the write path).
export { Op, Tag, ValueKind, readDiffs } from './cmd-buf.js'
export type { DiffRecord } from './cmd-buf.js'

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Thrown when a view access detects a stale (detached) buffer. */
export class DiffReaderStaleViewError extends Error {
  readonly code = 'CAUSL_DIFF_VIEW_STALE' as const
  constructor(message?: string) {
    super(
      message ??
        'DiffReader view is stale (detached) — call refresh() after memory.grow',
    )
    this.name = 'DiffReaderStaleViewError'
  }
}

/** Thrown when a decoder method is called with the wrong record length. */
export class DiffReaderShapeError extends Error {
  readonly code = 'CAUSL_DIFF_SHAPE' as const
  constructor(message: string) {
    super(message)
    this.name = 'DiffReaderShapeError'
  }
}

// ---------------------------------------------------------------------------
// Decoded payload shapes.
// ---------------------------------------------------------------------------

export interface CommittedRecord {
  readonly time: bigint
  readonly intentStringId: number
  readonly nChanges: number
}

export interface NodeChangedRecord {
  readonly slot: number
  readonly gen: number
  readonly valueKind: number
}

export interface NodeDisposedRecord {
  readonly slot: number
  readonly gen: number
}

export interface ErrorRecord {
  readonly errorCode: number
  readonly slot: number
  readonly messageStringId: number
}

// ---------------------------------------------------------------------------
// DiffReader.
// ---------------------------------------------------------------------------

/** Construction options for {@link DiffReader}. */
export interface DiffReaderOptions {
  /**
   * Test-only escape hatch. When true, the reader does NOT refresh
   * its typed-array views on access — used by the regression test
   * in `wasm-cmd-buf-memgrow.test.ts` to pin the "loud-failure"
   * contract (stale views must throw, never silently read garbage).
   *
   * Production callers have no path to set this.
   *
   * @internal
   */
  __skipViewRefresh?: boolean
}

/**
 * Typed-array view over a WASM linear-memory diff buffer.
 *
 * Holds two cached views (`Uint8Array` + `DataView`) over
 * `memory.buffer`. Every public read transparently calls
 * {@link DiffReader.refresh} which rebuilds the cached views iff the
 * underlying `ArrayBuffer` identity changed (the canonical signal
 * that `memory.grow()` ran).
 *
 * When constructed with `{ __skipViewRefresh: true }`, refresh is
 * suppressed; accessing a stale view throws
 * {@link DiffReaderStaleViewError} rather than reading garbage.
 *
 * Alternative constructor {@link DiffReader.fromBuffer} wraps an
 * existing `ArrayBuffer` (e.g. a hand-rolled diff for tests) — no
 * `WebAssembly.Memory` needed.
 */
export class DiffReader {
  private readonly _memory: WebAssembly.Memory | null
  private readonly _staticBuffer: ArrayBuffer | null
  private readonly _skipRefresh: boolean
  private _u8!: Uint8Array
  private _dv!: DataView

  /**
   * @param memory  Live `WebAssembly.Memory`. View refresh is keyed
   *                off `memory.buffer` identity.
   * @param options See {@link DiffReaderOptions}.
   */
  constructor(memory: WebAssembly.Memory, options?: DiffReaderOptions) {
    this._memory = memory
    this._staticBuffer = null
    this._skipRefresh = options?.__skipViewRefresh === true
    this._rebuild(memory.buffer)
  }

  /**
   * Construct a reader over a fixed `ArrayBuffer` (no
   * memory.grow semantics). Useful for tests with synthetic diff
   * buffers, and for the property-test seam that does not own a
   * live WASM instance.
   */
  static fromBuffer(buffer: ArrayBuffer): DiffReader {
    const r = Object.create(DiffReader.prototype) as DiffReader
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(r as any)._memory = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(r as any)._staticBuffer = buffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(r as any)._skipRefresh = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(r as any)._rebuild(buffer)
    return r
  }

  // -------------------------------------------------------------------------
  // View management.
  // -------------------------------------------------------------------------

  /**
   * Refresh the cached typed-array views if the underlying
   * `ArrayBuffer` identity changed (the post-`memory.grow` signal).
   * Cheap when the buffer is unchanged: one identity compare.
   *
   * If the reader was constructed with `{ __skipViewRefresh: true }`
   * and the views are stale, throws {@link DiffReaderStaleViewError}.
   */
  refresh(): void {
    const live = this._liveBuffer()
    if (this._u8.buffer === live) return
    if (this._skipRefresh) {
      throw new DiffReaderStaleViewError()
    }
    this._rebuild(live)
  }

  /** Current `Uint8Array` view (post-refresh). */
  get viewU8(): Uint8Array {
    this.refresh()
    return this._u8
  }

  /** Current `DataView` (post-refresh). */
  get viewDV(): DataView {
    this.refresh()
    return this._dv
  }

  // -------------------------------------------------------------------------
  // Primitive reads (kept narrow; tests pin every public read path).
  // -------------------------------------------------------------------------

  readU8(offset: number): number {
    this.refresh()
    return this._dv.getUint8(offset)
  }

  readU16(offset: number): number {
    this.refresh()
    return this._dv.getUint16(offset, true)
  }

  readU32(offset: number): number {
    this.refresh()
    return this._dv.getUint32(offset, true)
  }

  readU64(offset: number): bigint {
    this.refresh()
    return this._dv.getBigUint64(offset, true)
  }

  readF64(offset: number): number {
    this.refresh()
    return this._dv.getFloat64(offset, true)
  }

  // -------------------------------------------------------------------------
  // Record decoders.
  //
  // Per cmd-buf.ts wire layout. Each takes the payload offset
  // (i.e. past the 4-byte tag/len header) and validates `len` when
  // the caller passes it.
  // -------------------------------------------------------------------------

  /**
   * Decode a `Committed` record (tag=3, len=16) at `byteOffset`
   * (payload start).
   */
  readCommitted(byteOffset: number, len = 16): CommittedRecord {
    if (len !== 16) {
      throw new DiffReaderShapeError(
        `Committed: expected len=16, got len=${len}`,
      )
    }
    this.refresh()
    const time = this._dv.getBigUint64(byteOffset + 0, true)
    const intentStringId = this._dv.getUint32(byteOffset + 8, true)
    const nChanges = this._dv.getUint32(byteOffset + 12, true)
    return { time, intentStringId, nChanges }
  }

  /**
   * Decode a `NodeChanged` record (tag=0, len=12) at `byteOffset`
   * (payload start). Use {@link DiffReader.readF64} on a follow-up
   * NodeValueInline payload if your wire profile carries one.
   */
  readNodeChanged(byteOffset: number, len = 12): NodeChangedRecord {
    if (len !== 12) {
      throw new DiffReaderShapeError(
        `NodeChanged: expected len=12, got len=${len}`,
      )
    }
    this.refresh()
    const slot = this._dv.getUint32(byteOffset + 0, true)
    const gen = this._dv.getUint32(byteOffset + 4, true)
    const valueKind = this._dv.getUint8(byteOffset + 8)
    return { slot, gen, valueKind }
  }

  /**
   * Decode a `NodeDisposed` record (tag=2, len=8) at `byteOffset`
   * (payload start).
   */
  readNodeDisposed(byteOffset: number, len = 8): NodeDisposedRecord {
    if (len !== 8) {
      throw new DiffReaderShapeError(
        `NodeDisposed: expected len=8, got len=${len}`,
      )
    }
    this.refresh()
    const slot = this._dv.getUint32(byteOffset + 0, true)
    const gen = this._dv.getUint32(byteOffset + 4, true)
    return { slot, gen }
  }

  /**
   * Decode an `Error` record (tag=6, len=12) at `byteOffset`
   * (payload start).
   */
  readError(byteOffset: number, len = 12): ErrorRecord {
    if (len !== 12) {
      throw new DiffReaderShapeError(
        `Error: expected len=12, got len=${len}`,
      )
    }
    this.refresh()
    const errorCode = this._dv.getUint16(byteOffset + 0, true)
    // [+2..+4) is _pad u16, ignored.
    const slot = this._dv.getUint32(byteOffset + 4, true)
    const messageStringId = this._dv.getUint32(byteOffset + 8, true)
    return { errorCode, slot, messageStringId }
  }

  // -------------------------------------------------------------------------
  // Convenience: full-buffer envelope walk.
  // -------------------------------------------------------------------------

  /**
   * Walk a `[start, end)` byte range of the live view and yield the
   * structural `{tag, offset, len}` records. Delegates to the
   * walker in `cmd-buf.ts` (single source of truth for envelope
   * arithmetic) against the *currently-live* `ArrayBuffer`.
   */
  *iter(start: number, end: number): Iterable<DiffRecord> {
    this.refresh()
    yield* readDiffs(this._u8.buffer as ArrayBuffer, start, end)
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private _liveBuffer(): ArrayBuffer {
    if (this._memory !== null) return this._memory.buffer
    // `_staticBuffer` is set in both constructor paths that don't
    // own a `WebAssembly.Memory`.
    return this._staticBuffer as ArrayBuffer
  }

  private _rebuild(buf: ArrayBuffer): void {
    this._u8 = new Uint8Array(buf)
    this._dv = new DataView(buf)
  }
}

// ---------------------------------------------------------------------------
// Compatibility shim: re-export the per-record header size so consumers
// importing only `diff-reader.ts` don't need to also import cmd-buf.ts
// just for envelope arithmetic.
// ---------------------------------------------------------------------------

export const DIFF_RECORD_HEADER_BYTES = RECORD_HEADER_BYTES

/**
 * Narrow type guard for known {@link Tag} values. Useful in the
 * decoder dispatch switch inside consumer code (Wave 3b apply path
 * will use this in `WasmStateMirror.apply()`).
 */
export function isKnownTag(tag: number): tag is Tag {
  switch (tag) {
    case Tag.NodeChanged:
    case Tag.NodeAdded:
    case Tag.NodeDisposed:
    case Tag.Committed:
    case Tag.Subscribed:
    case Tag.Unsubscribed:
    case Tag.Error:
      return true
    default:
      return false
  }
}
