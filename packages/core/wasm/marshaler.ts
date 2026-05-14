/**
 * F-marshal — JS-side state mirror (epic #1133, sub-epic #1457).
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
 * `Action::Dispose` and drops the slot. No tombstones JS-side; stale
 * reads surface as {@link NodeDisposedError}.
 *
 * Filled in across F-marshal.1 → F-marshal.7. F-marshal.1 (this slice)
 * lands the slot dictionary CRUD and stale-id detection. F-marshal.2 /
 * F-marshal.3 add the JS→Rust / Rust→JS commit envelope marshal pair.
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
 * surfaces as {@link NodeDisposedError} on read.
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
 * mismatch, or no entry in the dictionary at all) is read or written.
 *
 * Surfaces deterministically rather than silently returning `undefined`
 * so adopters can catch use-after-dispose bugs at the right seam. The
 * Rust-side mirror returns the same error shape via the bridge's
 * `commit()` failure path (`NodeDisposedError` is the engine core's
 * generational-mismatch signal).
 */
export class NodeDisposedError extends Error {
  /** The offending NodeId. Exposed so adopters can introspect. */
  readonly nodeId: NodeId

  constructor(nodeId: NodeId) {
    super(`NodeId '${nodeId}' refers to a disposed slot`)
    this.name = 'NodeDisposedError'
    this.nodeId = nodeId
  }
}

/**
 * JS-side mirror of WASM-side state, per Decision 1 of #1457.
 *
 * Holds the dictionary that translates adopter-facing string `NodeId`s
 * to engine-internal `Slot` handles, the JS-side input cell mirror
 * (`Map<number, JsonValue>` keyed by slot `idx`), and the current
 * `GraphTime`.
 *
 * F-marshal.1 scope: slot dictionary CRUD + stale-id detection. The
 * commit-envelope marshal pair (F-marshal.2 / F-marshal.3) and the
 * bridge entrypoints (F-marshal.4) plug in around this surface in
 * later cascade tickets.
 */
export class WasmStateMirror {
  /**
   * Adopter NodeId → engine-internal Slot. Only live slots; disposal
   * removes the entry (Decision 4 — no JS-side tombstones).
   */
  readonly dictionary: Map<NodeId, Slot> = new Map()

  /**
   * JS-side input cell mirror, keyed by slot `idx`. The adopter-facing
   * input write path stages values here; the marshal builder
   * (F-marshal.2) rebuilds `Vec<InputCell>` from this map on commit.
   *
   * Note: keyed by `idx` (not `Slot` object) so re-registration after
   * dispose+recycle of a slot evicts the prior generation's value
   * automatically.
   */
  readonly inputs: Map<number, JsonValue> = new Map()

  /** Current `GraphTime` — mirrors WASM-side `state.now`. */
  now: GraphTime = 0 as GraphTime

  /**
   * Register a fresh slot in the dictionary. Called by the marshaler
   * after `wasm_create_input()` (F-marshal.4) returns a slot integer.
   *
   * Idempotent on `(nodeId, slot)` re-registration: replaces the
   * existing dictionary entry. Adopters that recycle a NodeId after
   * dispose+create get a fresh generation tag; the prior `Slot` value
   * they held becomes stale and reads through it throw
   * {@link NodeDisposedError}.
   *
   * @param nodeId - Adopter-facing string NodeId.
   * @param slot - Engine-internal slot handle returned by the bridge.
   */
  registerInput(nodeId: NodeId, slot: Slot): void {
    this.dictionary.set(nodeId, slot)
    // Initialise the input cell mirror with a null sentinel so the
    // marshal-builder sees a fully-populated `Vec<InputCell>` shape.
    // Adopters that subsequently write through `tx.set()` overwrite
    // this; adopters that read before writing get the null value
    // (matching the TS engine's `g.input(undefined)` shape).
    if (!this.inputs.has(slot.idx)) {
      this.inputs.set(slot.idx, { kind: 'null' })
    }
  }

  /**
   * Dispose an input slot. Removes the dictionary entry and the JS-side
   * input cell mirror so stale `Slot` handles that other code might be
   * holding fail their generation check.
   *
   * F-marshal.1 scope: dictionary mutation only. F-marshal.4 wires this
   * up to the bridge's `wasm_dispose(slot)` so the WASM-side
   * `state.disposed: BTreeSet<NodeId>` stays authoritative.
   *
   * Silently no-ops on a NodeId that's already been disposed or never
   * registered — matches the TS engine's `g.dispose()` idempotency.
   *
   * @param nodeId - Adopter-facing string NodeId.
   */
  dispose(nodeId: NodeId): void {
    const slot = this.dictionary.get(nodeId)
    if (slot === undefined) return
    this.dictionary.delete(nodeId)
    this.inputs.delete(slot.idx)
  }

  /**
   * Read the JS-side mirrored input value for a NodeId. Returns the
   * `JsonValue` mirror of the input cell; throws
   * {@link NodeDisposedError} if the NodeId is unknown (never registered
   * or already disposed).
   *
   * Derived reads pay a cross-boundary fetch (Decision 1 — deriveds
   * live WASM-side); the F-marshal cascade adds that path in
   * F-marshal.7. F-marshal.1 only resolves inputs.
   *
   * @param nodeId - Adopter-facing string NodeId.
   * @throws {NodeDisposedError} if the NodeId has no live slot.
   */
  read(nodeId: NodeId): JsonValue | undefined {
    const slot = this.dictionary.get(nodeId)
    if (slot === undefined) {
      throw new NodeDisposedError(nodeId)
    }
    return this.inputs.get(slot.idx)
  }

  /**
   * Translate adopter-facing NodeId → engine-internal Slot. Returns
   * `undefined` if the NodeId has no live entry (never registered or
   * already disposed).
   *
   * Used by F-marshal.2's commit-envelope builder to project an
   * adopter-supplied `Map<NodeId, value>` of writes to the bare-slot-
   * integer wire shape the engine consumes.
   *
   * @param nodeId - Adopter-facing string NodeId.
   */
  getSlotForNodeId(nodeId: NodeId): Slot | undefined {
    return this.dictionary.get(nodeId)
  }
}
