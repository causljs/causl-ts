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

import type { Commit, GraphTime, NodeId } from '../src/types.js'

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

  /**
   * F-marshal.4 (#1467) — allocate a fresh input slot via the bridge
   * and register the resulting `Slot` under `nodeId` in the dictionary.
   *
   * The {@link BridgeAllocator} adapter is supplied by the caller —
   * production paths plug in the bridge's `wasmCreateInput` /
   * `wasmDispose` exports; tests can supply a mock allocator to exercise
   * the dictionary's invariants without the wasm bundle.
   *
   * Per Decision 2 of #1457 the engine core's NodeId allocator
   * (`state.rs:create_input`) drives the slot integer + generation tag.
   * The JS-side just stores the returned `Slot`.
   */
  allocateSlot(nodeId: NodeId, allocator: BridgeAllocator): Slot {
    const packed = allocator.wasmCreateInput()
    const slot = unpackSlot(packed)
    this.registerInput(nodeId, slot)
    return slot
  }

  /**
   * F-marshal.4 (#1467) — allocate a fresh derived slot via the bridge.
   * Same shape as {@link allocateSlot} but routes through
   * `wasmCreateDerived` for the engine's `Vec<DerivedCell>` allocator.
   *
   * Deriveds and inputs index separate Vecs in the engine, so a slot
   * integer returned from `wasmCreateDerived` may collide numerically
   * with a slot integer from `wasmCreateInput` — the dictionary keys on
   * adopter NodeId so this is safe; the engine's read path
   * disambiguates by which Vec it indexes.
   */
  allocateDerivedSlot(nodeId: NodeId, allocator: BridgeAllocator): Slot {
    const packed = allocator.wasmCreateDerived()
    const slot = unpackSlot(packed)
    this.registerInput(nodeId, slot)
    return slot
  }

  /**
   * F-marshal.4 (#1467) — dispose a slot via the bridge.
   *
   * Drops the dictionary entry first (so a stale read in flight sees
   * `NodeDisposedError` immediately), then calls into the bridge's
   * `wasmDispose` so the WASM-side `state.disposed` set carries the
   * authoritative marker (Decision 4). The engine bumps the cell's
   * generation tag so any stale `NodeId` referencing this slot
   * surfaces as `NodeDisposedError::Disposed`.
   *
   * Idempotent: silently no-ops if `nodeId` has no live entry. The
   * bridge call is short-circuited in that case so the engine never
   * sees a stale-generation `Action::Dispose`.
   */
  disposeSlot(nodeId: NodeId, allocator: BridgeAllocator): void {
    const slot = this.dictionary.get(nodeId)
    if (slot === undefined) return
    // Drop JS-side mirror first.
    this.dispose(nodeId)
    // Engine-side dispose. Pack the (slot, gen) back into the u64 the
    // bridge expects.
    allocator.wasmDispose(packSlot(slot))
  }
}

/**
 * Bridge allocator adapter. The serde / gc bridges export
 * `wasmCreateInput` / `wasmCreateDerived` / `wasmDispose` (F-marshal.4
 * — `tools/engine-rs-bridge-serde/src/lib.rs` and
 * `tools/engine-rs-bridge-gc/src/lib.rs`); this interface abstracts the
 * concrete bridge type so the marshaler can target either one (and so
 * tests can supply mock allocators).
 *
 * All three methods are synchronous — the wasm module compile happens
 * at load time; the allocator calls are cheap thread-local State
 * mutations.
 */
export interface BridgeAllocator {
  /**
   * Allocate a fresh input slot. Returns the packed `(slot, gen)` u64
   * as a JS `bigint` (the wasm-pack `u64 → bigint` projection).
   */
  wasmCreateInput(): bigint
  /** Allocate a fresh derived slot. Returns the packed `(slot, gen)`. */
  wasmCreateDerived(): bigint
  /**
   * Dispose a slot. Throws on stale generation or out-of-range slot —
   * the engine's `dispose_input` returns `NodeDisposedError` for those
   * cases and the bridge propagates as a JS throw.
   */
  wasmDispose(packed: bigint): void
}

/**
 * Unpack a `bigint` from the bridge's `wasmCreateInput` /
 * `wasmCreateDerived` return shape: low 32 bits → `idx`, high 32 bits
 * → `gen`.
 */
function unpackSlot(packed: bigint): Slot {
  const idx = Number(packed & 0xffff_ffffn)
  const gen = Number((packed >> 32n) & 0xffff_ffffn)
  return { idx, gen }
}

/**
 * Inverse of {@link unpackSlot} — pack `(idx, gen)` back into a
 * `bigint` for the bridge's `wasmDispose` argument.
 */
function packSlot(slot: Slot): bigint {
  return (BigInt(slot.gen) << 32n) | BigInt(slot.idx)
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

// ---------------------------------------------------------------------------
// F-marshal.3 (#1466) — Rust→JS application of BridgeResult.
// ---------------------------------------------------------------------------

/**
 * Wire shape of `CommitRecord` per `tools/engine-rs-core/src/state.rs`
 * (`pub struct CommitRecord { time, intent, changed_nodes }`). Note
 * the `changedNodes` camelCase rename matches the rest of the engine's
 * camelCase JSON surface (the Rust `Serialize` derive maps `changed_nodes`
 * → `changedNodes` via `#[serde(rename_all = "camelCase")]`).
 *
 * `changedNodes` carries bare slot integers (the `NodeId` serde
 * projection); the JS-side `applyBridgeResult` reverse-translates them
 * via the mirror's dictionary into adopter-facing string NodeIds.
 */
export interface BridgeCommitRecord {
  readonly time: number
  readonly intent: string
  readonly changedNodes: readonly number[]
}

/**
 * Wire shape of `BridgeResult` per
 * `tools/engine-rs-bridge-serde/src/lib.rs:321-326`. The bridge's
 * `commit()` extern emits this triple on every successful call.
 */
export interface BridgeResult {
  readonly state: {
    readonly now: number
    readonly inputs: readonly InputCellWire[]
    // Other fields (deriveds, commit_log, observers, ...) are present
    // on the wire but ignored by F-marshal.3 — F-marshal.7 extends to
    // the full snapshot/hydrate shape.
    readonly [k: string]: unknown
  }
  readonly commit: BridgeCommitRecord
  readonly events: readonly unknown[]
}

/**
 * Apply the bridge's `BridgeResult` to the JS-side mirror and project
 * the commit envelope into the JS-shape {@link Commit} adopters consume.
 *
 * Per Decision 1 of #1457 the JS-side mirror is the SSOT for input
 * cells; this function refreshes `mirror.inputs` from the post-state
 * the bridge returned (every input cell's `value`) and stamps
 * `mirror.now` from the post-state's clock.
 *
 * The `changedNodes` slot integers in the bridge's `CommitRecord` are
 * reverse-translated to adopter-facing string NodeIds via the mirror's
 * dictionary. Slot ids absent from the dictionary (would indicate a
 * disposed cell still being touched by the engine — should not happen
 * post Decision 4) are silently dropped to keep the gate green.
 *
 * The returned {@link Commit}'s `originatedAt` is `undefined` — this
 * function never produces hydrate-replay records (#1470 covers
 * snapshot/hydrate).
 *
 * @param mirror - Live JS-side state mirror to update in place.
 * @param result - The `BridgeResult` returned by the bridge's
 *   `commit(state, action)` extern.
 */
export function applyBridgeResult(
  mirror: WasmStateMirror,
  result: BridgeResult,
): Commit {
  // Refresh `mirror.now` from the post-state clock.
  mirror.now = result.state.now as unknown as GraphTime

  // Refresh the input cell mirror from the post-state's inputs. The
  // bridge returns every input slot's value; we overwrite the mirror's
  // entry for each. We do NOT remove entries that are absent from the
  // post-state — Decision 4 keeps the JS-side dictionary mirroring
  // live slots only, and the dispose path drops those entries
  // explicitly via `WasmStateMirror.dispose()`.
  for (const cell of result.state.inputs) {
    mirror.inputs.set(cell.id, cell.value)
  }

  // Reverse-translate the bridge's slot-integer `changedNodes` to
  // adopter-facing string NodeIds via the mirror's dictionary. We walk
  // the dictionary once and build an `idx → NodeId` index so the
  // changedNodes mapping is O(N + M); a per-id linear scan would be
  // O(N · M) on a wide commit.
  const idxToNodeId = new Map<number, NodeId>()
  for (const [nodeId, slot] of mirror.dictionary) {
    idxToNodeId.set(slot.idx, nodeId)
  }

  const changedNodes: NodeId[] = []
  for (const slot of result.commit.changedNodes) {
    const nodeId = idxToNodeId.get(slot)
    if (nodeId !== undefined) {
      changedNodes.push(nodeId)
    }
    // Else: slot is not in the live JS-side dictionary. This can
    // happen on a dispose race (the engine's commit walk touched a
    // slot the JS-side has since dropped). Drop silently — the
    // adopter-facing Commit only carries live NodeIds.
  }

  return {
    time: result.commit.time as unknown as GraphTime,
    intent: result.commit.intent,
    changedNodes,
    originatedAt: undefined,
  }
}
