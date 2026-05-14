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
 * `JsonValue` wire shape. The Rust-side `JsonValue`
 * (`tools/engine-rs-core/src/json_value.rs`) carries a custom Serialize
 * impl that emits **plain JSON values** (not a tagged-union envelope):
 *   - `JsonValue::Null` → JS `null`
 *   - `JsonValue::Bool(b)` → JS `boolean`
 *   - `JsonValue::Number(n)` → JS `number` (integer-shaped f64 → bare
 *     int; non-finite → `null` per `JSON.stringify` rules)
 *   - `JsonValue::String(s)` → JS `string`
 *   - `JsonValue::Array(v)` → JS array
 *   - `JsonValue::Object(o)` → JS object with sorted-by-key iteration
 *
 * The marshaler therefore passes plain JS values through `serde-wasm-
 * bindgen` directly — the Rust `Deserialize` visitor accepts every JSON
 * scalar kind and reconstructs the tagged enum on the Rust side.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

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
      this.inputs.set(slot.idx, null)
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

// ---------------------------------------------------------------------------
// F-marshal.2 (#1465) — JS→Rust envelope builder for `Action::Commit`.
// ---------------------------------------------------------------------------

/**
 * Wire shape of an `InputCell` per `tools/engine-rs-core/src/cell.rs`:
 * `{ id, value, last_write_time }` (the transient `generation`,
 * `last_staged_at`, `last_staged_row`, `has_dependents` fields all
 * carry `#[serde(skip)]` — they reconstitute on the Rust side).
 *
 * `id` is the bare slot integer per the `NodeId` serde projection
 * (`tools/engine-rs-core/src/state.rs:243` — serialises as `u32`).
 */
export interface InputCellWire {
  readonly id: number
  readonly value: JsonValue
  readonly last_write_time: number
}

/**
 * Wire shape of `State` per `tools/engine-rs-core/src/state.rs` —
 * the container has `#[serde(default)]` so any subset of fields
 * suffices. F-marshal.2 only populates `now` and `inputs`; the
 * remaining ten fields default to empty on the Rust side.
 *
 * F-marshal.7 (#1470) extends this to cover the snapshot/hydrate
 * round-trip (deriveds, commit_log, retention, etc.).
 */
export interface BridgeState {
  readonly now: number
  readonly inputs: readonly InputCellWire[]
}

/**
 * Wire shape of `Action::Commit` per `tools/engine-rs-core/src/action.rs`:
 * internally tagged `#[serde(tag = "action", rename_all = "kebab-case")]`.
 * `writes` is a `Vec<NodeId>` of bare slot integers.
 */
export interface BridgeCommitAction {
  readonly action: 'commit'
  readonly intent: string
  readonly writes: readonly number[]
}

/**
 * Marshaled commit envelope — the `(state, action)` pair the bridge's
 * `commit(state, action)` extern consumes.
 */
export interface CommitEnvelope {
  readonly state: BridgeState
  readonly action: BridgeCommitAction
}

/**
 * Build the JS→Rust commit envelope from the mirror's live slot set +
 * an adopter-supplied write map.
 *
 * Per Decision 1 of #1457 the JS-side mirror is the SSOT for inputs.
 * This builder walks the mirror's `dictionary` in stable insertion
 * order (`Map` iteration preserves insertion order in JS) and emits a
 * `Vec<InputCell>` rebuilt from the live entries. Writes from the
 * adopter map are applied IN PLACE — the corresponding cell's `value`
 * is overwritten and `last_write_time` is stamped at `mirror.now + 1`
 * (the tick the commit advances to).
 *
 * Any write whose NodeId is not in the dictionary throws
 * {@link NodeDisposedError} — same surface the JS-side `read()` uses.
 *
 * The resulting `writes` array carries the bare slot integers in
 * deterministic order (sorted ascending by slot id) so the cross-
 * backend determinism gate sees a stable wire shape.
 *
 * @param mirror - JS-side state mirror.
 * @param intent - Adopter-supplied commit intent label.
 * @param writes - Map of NodeId → new value (`JsonValue` plain shape).
 */
export function marshalCommitEnvelope(
  mirror: WasmStateMirror,
  intent: string,
  writes: ReadonlyMap<NodeId, JsonValue>,
): CommitEnvelope {
  // Pre-resolve every write's NodeId → Slot. Failing fast lets the
  // adopter see the offending id before the commit envelope ships
  // across the FFI.
  const resolvedWrites = new Map<number, JsonValue>()
  for (const [nodeId, value] of writes) {
    const slot = mirror.dictionary.get(nodeId)
    if (slot === undefined) {
      throw new NodeDisposedError(nodeId)
    }
    resolvedWrites.set(slot.idx, value)
  }

  // The commit advances `now` by one tick. Stamping `last_write_time`
  // with this value mirrors what `transition_phased`'s
  // `Action::Commit` body does (`state.rs:State::commit`).
  const nextTime = (mirror.now as unknown as number) + 1

  // Rebuild `inputs: Vec<InputCell>` from the mirror's live slot set.
  // Collect every live slot from the dictionary, dedup by `idx` (a
  // disposed-then-reused slot only has the live generation in the
  // dictionary post-Decision 4), and walk in sorted-by-slot order so
  // the wire bytes are deterministic regardless of NodeId hashing.
  const slotsByIdx = new Map<number, { slot: Slot; lastWriteTime: number }>()
  for (const slot of mirror.dictionary.values()) {
    if (slotsByIdx.has(slot.idx)) continue
    slotsByIdx.set(slot.idx, {
      slot,
      // Default last_write_time = 0 for previously-untouched cells.
      // Adopter rewrites will bump this below.
      lastWriteTime: 0,
    })
  }

  const sortedIdxs = Array.from(slotsByIdx.keys()).sort((a, b) => a - b)
  const inputs: InputCellWire[] = sortedIdxs.map((idx) => {
    const entry = slotsByIdx.get(idx)
    // Safe — idx came from slotsByIdx.keys():
    if (entry === undefined) throw new Error('marshalCommitEnvelope: invariant')
    const writeValue = resolvedWrites.get(idx)
    const value =
      writeValue !== undefined ? writeValue : mirror.inputs.get(idx) ?? null
    const lastWriteTime =
      writeValue !== undefined ? nextTime : entry.lastWriteTime
    return { id: idx, value, last_write_time: lastWriteTime }
  })

  // Stable ascending order on `writes` so the bridge sees a
  // deterministic wire shape per commit (the TS engine's
  // `Commit.changedNodes` is registration-ordered today; the Rust
  // engine's `transition_phased` for `Action::Commit` sorts the
  // changed set into `commit.changed_nodes` so the cross-backend
  // gate keys on a stable order on both sides).
  const writeSlots = Array.from(resolvedWrites.keys()).sort((a, b) => a - b)

  return {
    state: {
      now: mirror.now as unknown as number,
      inputs,
    },
    action: {
      action: 'commit',
      intent,
      writes: writeSlots,
    },
  }
}
