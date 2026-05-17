/**
 * @packageDocumentation @internal
 *
 * Phase 2 / #1561 / epic #1558 — JS-side binary CommandBatch encoder
 * + diff envelope walker.
 *
 * Encodes JS-originated mutations into a contiguous Uint8Array for
 * delivery to the bridge's `apply_commands(buf_ptr, buf_len)` extern.
 * Wire shape per epic #1558 §G.10 / §E.6 (see envelope/record layouts
 * captured in-source below).
 *
 * The encoder writes into a pre-allocated ArrayBuffer the caller
 * provides. `finalize()` returns `{ptr, len}` once `n_cmds` and the
 * trailing `payload_bytes` field are known.
 *
 * NOT YET wired into `WasmStateMirror.commit()` — that flip is Wave 3b
 * (marshaler protocol selector). This module lives independently
 * today; consumers can construct + finalize directly for tests.
 *
 * Envelope (16 B, little-endian):
 *   [ 0.. 4)  magic         u32 = 0xC0DEC0DE
 *   [ 4.. 6)  version       u16 = 1
 *   [ 6.. 8)  flags         u16
 *   [ 8..12)  n_cmds        u32
 *   [12..16)  payload_bytes u32
 *
 * Per-record header (4 B):
 *   [0..2)    op   u16
 *   [2..4)    len  u16  (payload-only byte count)
 *
 * Per-record payloads (little-endian):
 *   SetInput     (op=0, len=24):
 *     [ 0.. 4)  slot         u32
 *     [ 4.. 8)  gen          u32
 *     [ 8.. 9)  value_kind   u8
 *     [ 9..12)  _pad         u8[3]
 *     [12..20)  value_inline u64  (for Number: f64 bit-pattern)
 *     [20..24)  reserved     u8[4]
 *
 *   BeginCommit  (op=1, len=8):
 *     [ 0.. 4)  intent_string_id  u32
 *     [ 4.. 8)  expected_writes   u32
 *
 *   EndCommit    (op=2, len=0)
 *
 *   Dispose      (op=3, len=8):
 *     [ 0.. 4)  slot  u32
 *     [ 4.. 8)  gen   u32
 *
 * Diff records (separate buffer, populated by the WASM side; walked
 * via `readDiffs()` and decoded via `diff-reader.ts`):
 *
 *   Per-record header (4 B):
 *     [0..2)    tag  u16
 *     [2..4)    len  u16  (payload-only byte count)
 *
 *   Committed    (tag=3, len=16):
 *     [ 0.. 8)  time              u64
 *     [ 8..12)  intent_string_id  u32
 *     [12..16)  n_changes         u32
 *
 *   NodeChanged  (tag=0, len=12):
 *     [ 0.. 4)  slot        u32
 *     [ 4.. 8)  gen         u32
 *     [ 8.. 9)  value_kind  u8
 *     [ 9..12)  _pad        u8[3]
 *
 *   NodeDisposed (tag=2, len=8):
 *     [ 0.. 4)  slot  u32
 *     [ 4.. 8)  gen   u32
 *
 *   Error        (tag=6, len=12):
 *     [ 0.. 2)  code              u16
 *     [ 2.. 4)  _pad              u16
 *     [ 4.. 8)  slot              u32
 *     [ 8..12)  message_string_id u32
 */

// ---------------------------------------------------------------------------
// Enums (const enum → inlined at call sites; no runtime symbol cost).
// ---------------------------------------------------------------------------

/** Command op-codes (JS → WASM). */
export const enum Op {
  SetInput = 0,
  BeginCommit = 1,
  EndCommit = 2,
  Dispose = 3,
  Subscribe = 4,
  Unsubscribe = 5,
  DispatchMsg = 6,
  BeginFetch = 7,
  ResolvePending = 8,
  Tick = 9,
}

/** Diff record tags (WASM → JS). */
export const enum Tag {
  NodeChanged = 0,
  NodeAdded = 1,
  NodeDisposed = 2,
  Committed = 3,
  Subscribed = 4,
  Unsubscribed = 5,
  Error = 6,
}

/** Value discriminant for inline-encoded payload values. */
export const enum ValueKind {
  Null = 0,
  False = 1,
  True = 2,
  Int32 = 3,
  Number = 4,
  StringId = 5,
  ArrayRef = 6,
  ObjectRef = 7,
  Pending = 8,
  Error = 9,
}

// ---------------------------------------------------------------------------
// Wire constants.
// ---------------------------------------------------------------------------

export const ENVELOPE_MAGIC = 0xc0dec0de
export const ENVELOPE_VERSION = 1
export const ENVELOPE_HEADER_BYTES = 16

/** Per-record header (op u16 + len u16). */
export const RECORD_HEADER_BYTES = 4

/** Payload byte counts per command op. */
export const PAYLOAD_BYTES_SET_INPUT = 24
export const PAYLOAD_BYTES_BEGIN_COMMIT = 8
export const PAYLOAD_BYTES_END_COMMIT = 0
export const PAYLOAD_BYTES_DISPOSE = 8

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Thrown if the caller-provided buffer is too small for the writes. */
export class CommandBatchOverflowError extends Error {
  readonly code = 'CAUSL_CMD_BUF_OVERFLOW' as const
  readonly needed: number
  readonly available: number
  constructor(needed: number, available: number) {
    super(`CommandBatch needed ${needed} bytes, buffer has ${available}`)
    this.name = 'CommandBatchOverflowError'
    this.needed = needed
    this.available = available
  }
}

/** Thrown when the diff walker encounters a truncated record. */
export class DiffReaderTruncatedError extends Error {
  readonly code = 'CAUSL_DIFF_TRUNCATED' as const
  readonly offset: number
  constructor(offset: number, message?: string) {
    super(message ?? `diff buffer truncated at offset ${offset}`)
    this.name = 'DiffReaderTruncatedError'
    this.offset = offset
  }
}

/** Thrown when the diff walker encounters an unknown tag. */
export class DiffReaderUnknownTagError extends Error {
  readonly code = 'CAUSL_DIFF_UNKNOWN_TAG' as const
  readonly tag: number
  readonly offset: number
  constructor(tag: number, offset: number) {
    super(`diff buffer: unknown tag 0x${tag.toString(16)} at offset ${offset}`)
    this.name = 'DiffReaderUnknownTagError'
    this.tag = tag
    this.offset = offset
  }
}

// ---------------------------------------------------------------------------
// CommandBatch — binary writer over a caller-provided ArrayBuffer.
// ---------------------------------------------------------------------------

export interface BatchFinalized {
  /** Byte offset within the underlying buffer (always 0 today). */
  readonly ptr: number
  /** Header (16) + sum of record bytes. */
  readonly len: number
  /** Number of records written. */
  readonly nCmds: number
}

/**
 * Binary command-batch writer over a caller-provided ArrayBuffer.
 *
 * The header is written eagerly on construction with placeholders for
 * `n_cmds` and `payload_bytes`; `finalize()` back-patches them.
 *
 * Reusable: call {@link CommandBatch.reset} (or pass a fresh buffer)
 * to start a new batch.
 *
 * @example
 * ```ts
 * const buf = new ArrayBuffer(4096)
 * const cb = new CommandBatch(buf)
 * cb.beginCommit(internStringIdFor('user-rename'))
 * cb.setInputNumber(slot.idx, slot.gen, 42)
 * cb.endCommit()
 * const { ptr, len } = cb.finalize()
 * // wasm.apply_commands(ptr, len)
 * ```
 */
export class CommandBatch {
  private readonly _buffer: ArrayBuffer
  private readonly _byteOffset: number
  private readonly _capacity: number
  private _dv: DataView
  private _cursor: number
  private _nCmds: number
  private _flags: number

  /**
   * @param buffer    Backing store. Must be at least
   *                  {@link ENVELOPE_HEADER_BYTES} bytes long.
   * @param byteOffset Optional offset into the buffer (defaults to 0).
   * @param byteLength Optional length cap; defaults to
   *                  `buffer.byteLength - byteOffset`.
   */
  constructor(buffer: ArrayBuffer, byteOffset = 0, byteLength?: number) {
    const cap = byteLength ?? buffer.byteLength - byteOffset
    if (cap < ENVELOPE_HEADER_BYTES) {
      throw new CommandBatchOverflowError(ENVELOPE_HEADER_BYTES, cap)
    }
    this._buffer = buffer
    this._byteOffset = byteOffset
    this._capacity = cap
    this._dv = new DataView(buffer, byteOffset, cap)
    this._cursor = ENVELOPE_HEADER_BYTES
    this._nCmds = 0
    this._flags = 0
    this._writeHeaderPlaceholder()
  }

  // -------------------------------------------------------------------------
  // Public surface.
  // -------------------------------------------------------------------------

  /** Reset the writer; the underlying buffer is reused. */
  reset(): void {
    this._cursor = ENVELOPE_HEADER_BYTES
    this._nCmds = 0
    this._flags = 0
    this._writeHeaderPlaceholder()
  }

  /** Current write cursor (bytes used so far, including the 16 B header). */
  get bytesUsed(): number {
    return this._cursor
  }

  /** Total backing-store capacity in bytes. */
  get capacity(): number {
    return this._capacity
  }

  /** Number of records appended so far. */
  get count(): number {
    return this._nCmds
  }

  /** Bit-flags stamped into the envelope on `finalize()`. */
  setFlags(flags: number): void {
    this._flags = flags & 0xffff
  }

  /**
   * Live byte view over the in-progress buffer. Returned view is a
   * fresh `Uint8Array` aliasing the underlying ArrayBuffer; the
   * caller must not retain it across writes (the slice length is
   * tied to the current cursor).
   */
  peekBytes(): Uint8Array {
    return new Uint8Array(this._buffer, this._byteOffset, this._cursor)
  }

  // -------------------------------------------------------------------------
  // Record writers.
  // -------------------------------------------------------------------------

  /** Append a `BeginCommit` record (op=1, payload=8 B). */
  beginCommit(intentStringId = 0, expectedWrites = 0): void {
    this._writeRecordHeader(Op.BeginCommit, PAYLOAD_BYTES_BEGIN_COMMIT)
    this._dv.setUint32(this._cursor + 0, intentStringId >>> 0, true)
    this._dv.setUint32(this._cursor + 4, expectedWrites >>> 0, true)
    this._cursor += PAYLOAD_BYTES_BEGIN_COMMIT
    this._nCmds += 1
  }

  /** Append an `EndCommit` record (op=2, payload=0 B). */
  endCommit(): void {
    this._writeRecordHeader(Op.EndCommit, PAYLOAD_BYTES_END_COMMIT)
    this._nCmds += 1
  }

  /**
   * Append a `SetInput` record encoding a JS `number` value.
   * Uses {@link ValueKind.Number} and stores the f64 bit pattern in
   * the inline u64 slot.
   */
  setInputNumber(slot: number, gen: number, value: number): void {
    this._writeSetInputHeader(slot, gen, ValueKind.Number)
    // value_inline at payload+12: write the f64 directly into the
    // 8-byte inline slot (LE).
    this._dv.setFloat64(this._cursor + 12, value, true)
    // Trailing reserved bytes (payload[20..24)) stay zero (buffer
    // is allocated zeroed; we never read from them on this path).
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /** Append a `SetInput` record encoding a JS `boolean` value. */
  setInputBoolean(slot: number, gen: number, value: boolean): void {
    this._writeSetInputHeader(
      slot,
      gen,
      value ? ValueKind.True : ValueKind.False,
    )
    // No inline payload needed; True/False are kind-only.
    this._dv.setBigUint64(this._cursor + 12, 0n, true)
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /** Append a `SetInput` record encoding a JS `null` value. */
  setInputNull(slot: number, gen: number): void {
    this._writeSetInputHeader(slot, gen, ValueKind.Null)
    this._dv.setBigUint64(this._cursor + 12, 0n, true)
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /** Append a `SetInput` record encoding a 32-bit signed integer. */
  setInputInt32(slot: number, gen: number, value: number): void {
    this._writeSetInputHeader(slot, gen, ValueKind.Int32)
    // Int32 stored in the low 4 bytes of the inline u64 (LE).
    this._dv.setInt32(this._cursor + 12, value | 0, true)
    this._dv.setInt32(this._cursor + 16, 0, true)
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /**
   * Append a `SetInput` record carrying an interned string id
   * (caller is responsible for interning).
   */
  setInputStringId(slot: number, gen: number, stringId: number): void {
    this._writeSetInputHeader(slot, gen, ValueKind.StringId)
    this._dv.setUint32(this._cursor + 12, stringId >>> 0, true)
    this._dv.setUint32(this._cursor + 16, 0, true)
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /**
   * Append a `SetInput` record with a caller-supplied raw u64
   * inline value. Use for opaque/foreign kinds (ArrayRef, ObjectRef,
   * Pending, Error) — caller is responsible for the kind/value
   * contract on the WASM side.
   */
  setInputRaw(
    slot: number,
    gen: number,
    valueKind: ValueKind,
    valueInline: bigint,
  ): void {
    this._writeSetInputHeader(slot, gen, valueKind)
    this._dv.setBigUint64(this._cursor + 12, valueInline, true)
    this._cursor += PAYLOAD_BYTES_SET_INPUT
    this._nCmds += 1
  }

  /** Append a `Dispose` record (op=3, payload=8 B). */
  dispose(slot: number, gen: number): void {
    this._writeRecordHeader(Op.Dispose, PAYLOAD_BYTES_DISPOSE)
    this._dv.setUint32(this._cursor + 0, slot >>> 0, true)
    this._dv.setUint32(this._cursor + 4, gen >>> 0, true)
    this._cursor += PAYLOAD_BYTES_DISPOSE
    this._nCmds += 1
  }

  // -------------------------------------------------------------------------
  // Finalize.
  // -------------------------------------------------------------------------

  /**
   * Back-patch the header with the final `n_cmds` and
   * `payload_bytes`, then return the `{ptr, len, nCmds}` triple the
   * caller passes to `apply_commands`.
   */
  finalize(): BatchFinalized {
    const payloadBytes = this._cursor - ENVELOPE_HEADER_BYTES
    // version + flags packed into [4..8): version u16 then flags u16.
    this._dv.setUint16(4, ENVELOPE_VERSION, true)
    this._dv.setUint16(6, this._flags, true)
    this._dv.setUint32(8, this._nCmds >>> 0, true)
    this._dv.setUint32(12, payloadBytes >>> 0, true)
    return {
      ptr: this._byteOffset,
      len: this._cursor,
      nCmds: this._nCmds,
    }
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private _writeHeaderPlaceholder(): void {
    this._dv.setUint32(0, ENVELOPE_MAGIC, true)
    this._dv.setUint16(4, ENVELOPE_VERSION, true)
    this._dv.setUint16(6, 0, true) // flags
    this._dv.setUint32(8, 0, true) // n_cmds (back-patched in finalize)
    this._dv.setUint32(12, 0, true) // payload_bytes (back-patched in finalize)
  }

  private _ensureRoom(payloadBytes: number): void {
    const needed = this._cursor + RECORD_HEADER_BYTES + payloadBytes
    if (needed > this._capacity) {
      throw new CommandBatchOverflowError(needed, this._capacity)
    }
  }

  private _writeRecordHeader(op: Op, payloadBytes: number): void {
    this._ensureRoom(payloadBytes)
    this._dv.setUint16(this._cursor + 0, op, true)
    this._dv.setUint16(this._cursor + 2, payloadBytes, true)
    this._cursor += RECORD_HEADER_BYTES
  }

  private _writeSetInputHeader(
    slot: number,
    gen: number,
    valueKind: ValueKind,
  ): void {
    this._writeRecordHeader(Op.SetInput, PAYLOAD_BYTES_SET_INPUT)
    this._dv.setUint32(this._cursor + 0, slot >>> 0, true)
    this._dv.setUint32(this._cursor + 4, gen >>> 0, true)
    this._dv.setUint8(this._cursor + 8, valueKind & 0xff)
    this._dv.setUint8(this._cursor + 9, 0)
    this._dv.setUint8(this._cursor + 10, 0)
    this._dv.setUint8(this._cursor + 11, 0)
    // Caller writes the 8-byte value_inline at +12 and the 4-byte
    // reserved tail (zeroed) stays at +20.
  }
}

// ---------------------------------------------------------------------------
// readDiffs — generic envelope walker over a diff buffer.
// ---------------------------------------------------------------------------

/** One diff record located by `readDiffs`. */
export interface DiffRecord {
  /** Wire tag value (cast to {@link Tag} for the known set). */
  readonly tag: number
  /** Byte offset of the payload (past the 4-byte tag/len header). */
  readonly offset: number
  /** Payload byte length (header `len` field). */
  readonly len: number
}

/**
 * Walk the per-record headers in a diff buffer range and yield
 * `{tag, offset, len}` records. The caller is responsible for
 * decoding payloads via the {@link DiffReader} typed accessors.
 *
 * Throws {@link DiffReaderTruncatedError} if a header or payload
 * runs past `end`.
 *
 * Note: this walker does NOT validate tags — `readDiffs` is the
 * cheap structural walker. Stricter contracts (unknown-tag
 * rejection) live on the decoder seam in `diff-reader.ts` and on
 * the property tests.
 */
export function* readDiffs(
  buf: ArrayBuffer,
  start: number,
  end: number,
): Iterable<DiffRecord> {
  if (start === end) return
  if (start < 0 || end > buf.byteLength || start > end) {
    throw new DiffReaderTruncatedError(
      start,
      `readDiffs: invalid range [${start}, ${end}) over ${buf.byteLength}-byte buffer`,
    )
  }
  const dv = new DataView(buf)
  let cursor = start
  while (cursor < end) {
    if (cursor + RECORD_HEADER_BYTES > end) {
      throw new DiffReaderTruncatedError(
        cursor,
        `readDiffs: truncated record header at offset ${cursor}`,
      )
    }
    const tag = dv.getUint16(cursor + 0, true)
    const len = dv.getUint16(cursor + 2, true)
    const payloadOffset = cursor + RECORD_HEADER_BYTES
    const nextCursor = payloadOffset + len
    if (nextCursor > end) {
      throw new DiffReaderTruncatedError(
        cursor,
        `readDiffs: record payload (tag=${tag}, len=${len}) overruns range end ${end}`,
      )
    }
    yield { tag, offset: payloadOffset, len }
    cursor = nextCursor
  }
}
