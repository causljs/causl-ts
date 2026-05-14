/**
 * F-marshal scaffold (epic #1133, sub-epic #1457, ticket #1463).
 *
 * Typestate scaffold for the JS↔Rust state marshaler.
 *
 * Per Decision 1 of {@link https://github.com/iasbuilt/causl/issues/1457#issuecomment-4454257401 #1457 design pin}
 * the canonical-state location is **hybrid**:
 *   - JS-side: input cells (`inputs: Map<Slot, JsonValue>`) — adopters
 *     poke inputs on the JS adopter surface so the authoritative copy
 *     lives JS-side to avoid a round-trip on every write.
 *   - WASM-side: `commit_log`, `retention`, `subscribers`, `observers`,
 *     `disposed`, `resource_fleet`, `pending_pipeline`, AND `deriveds`
 *     (Phase D recompute needs them inline). Derived reads pay one
 *     cross-boundary fetch per read.
 *
 * Per Decision 2 the JS-side dictionary maps adopter-facing string
 * `NodeId`s to engine-internal slot integers (`{ idx: u32, gen: u32 }`).
 * The engine core never speaks string ids — only the bare slot integer
 * crosses the wire.
 *
 * Per Decision 4 disposed cells are WASM-side authoritative. The JS-side
 * dictionary mirrors live slots only; `dispose()` marshals
 * `Action::Dispose` and drops the slot. No tombstones JS-side.
 *
 * This file is the F-marshal.0 typestate scaffold — methods are
 * declared but unimplemented (each throws `'not yet implemented'`).
 * Filled in by:
 *   - F-marshal.1 (#1464) — `WasmStateMirror` class body, slot
 *     dictionary CRUD, stale-id `NodeDisposedError`.
 *   - F-marshal.2 (#1465) — `marshalCommitEnvelope`.
 *   - F-marshal.3 (#1466) — `applyBridgeResult`.
 *   - F-marshal.4 (#1467) — `allocateSlot` (calls into bridge
 *     `wasm_create_input` / `wasm_create_derived`).
 *
 * @internal
 */

import type { GraphTime, NodeId } from '../src/types.js'

/**
 * Slot handle — the JS-side mirror of a WASM-side `NodeId { slot, gen }`.
 *
 * The `idx` field is the dense slot integer the engine core consumes
 * (the wire-format projection of {@link NodeId}). The `gen` field is the
 * generation tag the cell carried when this handle was minted; a stale
 * `Slot` (one whose `gen` no longer matches the cell's `generation`)
 * surfaces as `NodeDisposedError` on read.
 */
export interface Slot {
  readonly idx: number
  readonly gen: number
}

/**
 * `JsonValue` shape mirroring the Rust-side tagged-union value tree
 * (`tools/engine-rs-core/src/json_value.rs`). The marshaler converts
 * adopter-supplied JS values to this shape on commit and reads them
 * back on read.
 */
export type JsonValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'array'; readonly value: readonly JsonValue[] }
  | {
      readonly kind: 'object'
      readonly value: Readonly<Record<string, JsonValue>>
    }

/**
 * Thrown when a `NodeId` whose slot has been disposed (generational
 * mismatch) is read or written. The marshaler surfaces this rather than
 * silently returning `undefined` so adopters can catch use-after-dispose
 * bugs deterministically.
 */
export class NodeDisposedError extends Error {
  constructor(nodeId: NodeId) {
    super(`NodeId '${nodeId}' refers to a disposed slot`)
    this.name = 'NodeDisposedError'
  }
}

/**
 * JS-side mirror of WASM-side state, per Decision 1 of #1457.
 *
 * Holds the dictionary that translates adopter-facing string `NodeId`s
 * to engine-internal `Slot` handles, the JS-side input cell mirror
 * (`Map<Slot, JsonValue>`), and the current `GraphTime`.
 *
 * F-marshal.0 stub: methods declared, bodies throw. F-marshal.1 fills
 * in the slot dictionary CRUD; F-marshal.2 / F-marshal.3 add the
 * commit envelope marshal pair.
 */
export class WasmStateMirror {
  /** Dictionary: adopter NodeId → engine-internal Slot handle. */
  readonly dictionary: Map<NodeId, Slot> = new Map()

  /** JS-side input cell mirror — keyed by slot `idx`. */
  readonly inputs: Map<number, JsonValue> = new Map()

  /** Current `GraphTime` — mirrors WASM-side `state.now`. */
  now: GraphTime = 0 as GraphTime

  /**
   * Register an input slot in the dictionary. Called after
   * `wasm_create_input()` returns a fresh slot integer.
   *
   * F-marshal.0: stub. Filled in by F-marshal.1.
   */
  registerInput(_nodeId: NodeId, _slot: Slot): void {
    throw new Error('WasmStateMirror.registerInput: not yet implemented')
  }

  /**
   * Dispose an input slot. Marshals `Action::Dispose { node }` to the
   * bridge and drops the slot from the dictionary.
   *
   * F-marshal.0: stub. Filled in by F-marshal.1 / F-marshal.4.
   */
  dispose(_nodeId: NodeId): void {
    throw new Error('WasmStateMirror.dispose: not yet implemented')
  }

  /**
   * Read the latest known value for a NodeId. Returns the JS-side
   * mirror's input value for inputs; derived reads pay a cross-boundary
   * fetch (Decision 1). Throws {@link NodeDisposedError} if the slot
   * generation no longer matches.
   *
   * F-marshal.0: stub. Filled in by F-marshal.1.
   */
  read(_nodeId: NodeId): JsonValue | undefined {
    throw new Error('WasmStateMirror.read: not yet implemented')
  }

  /**
   * Translate adopter-facing NodeId → engine-internal Slot handle.
   * Returns `undefined` if the NodeId is unknown (never registered)
   * or has been disposed.
   *
   * F-marshal.0: stub. Filled in by F-marshal.1.
   */
  getSlotForNodeId(_nodeId: NodeId): Slot | undefined {
    throw new Error('WasmStateMirror.getSlotForNodeId: not yet implemented')
  }
}
