/**
 * F-marshal.1 — unit tests for `WasmStateMirror` slot dictionary CRUD
 * and stale-id detection (issue #1464).
 *
 * Per the cascade design in #1457 the JS-side mirror is the authoritative
 * input-cell holder; the dictionary translates adopter-facing string
 * NodeIds to engine-internal `Slot { idx, gen }` handles. Stale reads
 * (NodeId not in the dictionary — never registered or already disposed)
 * surface as `NodeDisposedError`.
 */

import { describe, it, expect } from 'vitest'
import type { GraphSnapshot, GraphTime, NodeId } from '../src/types.js'
import {
  applyBatchBridgeResult,
  applyBridgeResult,
  hydrate,
  marshalBatchEnvelope,
  marshalCommitEnvelope,
  NodeDisposedError,
  snapshot,
  WasmStateMirror,
  type BatchBridgeResult,
  type BridgeAllocator,
  type BridgeResult,
  type Slot,
} from '../wasm/marshaler.js'

describe('WasmStateMirror — F-marshal.1 slot dictionary CRUD', () => {
  it('registerInput stores the slot in the dictionary', () => {
    const m = new WasmStateMirror()
    const id = 'a' as NodeId
    const slot: Slot = { idx: 0, gen: 0 }
    m.registerInput(id, slot)
    expect(m.dictionary.get(id)).toEqual(slot)
  })

  it('registerInput seeds the inputs mirror with a null sentinel', () => {
    const m = new WasmStateMirror()
    const id = 'a' as NodeId
    m.registerInput(id, { idx: 7, gen: 0 })
    expect(m.inputs.get(7)).toEqual(null)
  })

  it('registerInput does not clobber an existing value on re-register at same slot', () => {
    const m = new WasmStateMirror()
    const id = 'a' as NodeId
    m.registerInput(id, { idx: 0, gen: 0 })
    m.inputs.set(0, 42)
    // Re-register the SAME slot — should not reset the value.
    m.registerInput(id, { idx: 0, gen: 0 })
    expect(m.inputs.get(0)).toBe(42)
  })

  it('getSlotForNodeId returns the live slot', () => {
    const m = new WasmStateMirror()
    const id = 'b' as NodeId
    const slot: Slot = { idx: 3, gen: 1 }
    m.registerInput(id, slot)
    expect(m.getSlotForNodeId(id)).toEqual(slot)
  })

  it('getSlotForNodeId returns undefined for unknown NodeId', () => {
    const m = new WasmStateMirror()
    expect(m.getSlotForNodeId('missing' as NodeId)).toBeUndefined()
  })

  it('dispose removes the dictionary entry and the inputs entry', () => {
    const m = new WasmStateMirror()
    const id = 'c' as NodeId
    m.registerInput(id, { idx: 5, gen: 0 })
    m.inputs.set(5, 'hello')
    m.dispose(id)
    expect(m.dictionary.has(id)).toBe(false)
    expect(m.inputs.has(5)).toBe(false)
  })

  it('dispose is idempotent — silently no-ops on unknown NodeId', () => {
    const m = new WasmStateMirror()
    expect(() => m.dispose('never-registered' as NodeId)).not.toThrow()
  })

  it('dispose is idempotent — double-dispose is a no-op', () => {
    const m = new WasmStateMirror()
    const id = 'd' as NodeId
    m.registerInput(id, { idx: 0, gen: 0 })
    m.dispose(id)
    expect(() => m.dispose(id)).not.toThrow()
  })

  it('read returns the JS-side mirrored input value', () => {
    const m = new WasmStateMirror()
    const id = 'e' as NodeId
    m.registerInput(id, { idx: 2, gen: 0 })
    m.inputs.set(2, true)
    expect(m.read(id)).toBe(true)
  })

  it('read throws NodeDisposedError on stale id (never registered)', () => {
    const m = new WasmStateMirror()
    expect(() => m.read('ghost' as NodeId)).toThrow(NodeDisposedError)
  })

  it('read throws NodeDisposedError after dispose', () => {
    const m = new WasmStateMirror()
    const id = 'f' as NodeId
    m.registerInput(id, { idx: 0, gen: 0 })
    m.dispose(id)
    expect(() => m.read(id)).toThrow(NodeDisposedError)
  })

  it('NodeDisposedError exposes the offending NodeId', () => {
    const m = new WasmStateMirror()
    try {
      m.read('stale-id' as NodeId)
      expect.unreachable('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(NodeDisposedError)
      expect((e as NodeDisposedError).nodeId).toBe('stale-id')
    }
  })

  it('recycled slot — re-register clears the prior generation', () => {
    const m = new WasmStateMirror()
    const id = 'g' as NodeId
    m.registerInput(id, { idx: 0, gen: 0 })
    m.inputs.set(0, 1)
    // Slot recycled at a new generation after dispose.
    m.dispose(id)
    m.registerInput(id, { idx: 0, gen: 1 })
    // Fresh null sentinel, NOT the prior value:
    expect(m.read(id)).toBeNull()
    // And the dictionary reflects the new generation:
    expect(m.getSlotForNodeId(id)).toEqual({ idx: 0, gen: 1 })
  })

  it('now starts at 0', () => {
    const m = new WasmStateMirror()
    expect(m.now).toBe(0)
  })

  it('now is mutable — adopters and the marshal pair update it', () => {
    const m = new WasmStateMirror()
    // Cast through `unknown` because `GraphTime` is a branded number;
    // production code mutates this via the marshaler's apply path.
    ;(m as { now: number }).now = 42
    expect(m.now).toBe(42)
  })

  it('independent mirror instances do not share dictionary state', () => {
    const a = new WasmStateMirror()
    const b = new WasmStateMirror()
    a.registerInput('x' as NodeId, { idx: 0, gen: 0 })
    expect(b.dictionary.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// F-marshal.7 (#1470) — snapshot()/hydrate() round-trip via marshaler.
// ---------------------------------------------------------------------------

/**
 * Mock {@link BridgeAllocator} for the hydrate path. Mints fresh slot
 * integers monotonically from the supplied starting index; the
 * generation tag is always `0` (a fresh allocator never recycled a
 * slot). Mirrors the bridge's `wasmCreateInput()` return shape: low
 * 32 bits → `idx`, high 32 bits → `gen`.
 */
function mockAllocator(start = 0): BridgeAllocator & {
  readonly minted: ReadonlyArray<{ idx: number; gen: number }>
} {
  let next = start
  const minted: Array<{ idx: number; gen: number }> = []
  return {
    wasmCreateInput() {
      const idx = next++
      const gen = 0
      minted.push({ idx, gen })
      return (BigInt(gen) << 32n) | BigInt(idx)
    },
    wasmCreateDerived() {
      throw new Error('mockAllocator: wasmCreateDerived not expected in hydrate')
    },
    wasmDispose() {
      throw new Error('mockAllocator: wasmDispose not expected in hydrate')
    },
    minted,
  }
}

describe('snapshot()/hydrate() — F-marshal.7 round-trip', () => {
  it('snapshot emits schema=1 and the mirror clock as time', () => {
    const m = new WasmStateMirror()
    ;(m as { now: number }).now = 7
    const snap = snapshot(m)
    expect(snap.schema).toBe(1)
    expect(snap.time).toBe(7)
    expect(snap.inputs).toEqual({})
  })

  it('snapshot captures every live NodeId with its mirrored value', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })
    m.registerInput('c' as NodeId, { idx: 2, gen: 0 })
    m.inputs.set(0, 42)
    m.inputs.set(1, 'hello')
    // c gets the null sentinel from registerInput

    const snap = snapshot(m)
    expect(snap.inputs).toEqual({ a: 42, b: 'hello', c: null })
  })

  it('snapshot does NOT emit disposed NodeIds', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })
    m.inputs.set(0, 1)
    m.inputs.set(1, 2)
    m.dispose('a' as NodeId)

    const snap = snapshot(m)
    expect(Object.keys(snap.inputs)).toEqual(['b'])
    expect(snap.inputs).toEqual({ b: 2 })
  })

  it('snapshot does NOT populate schemaHash (adopter Graph layer owns it)', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    const snap = snapshot(m)
    // `schemaHash` is optional on the wire; the marshaler emits the
    // canonical shape without it. Adopter `Graph.snapshot()` overlays
    // the hash when it knows the registered id-set.
    expect(snap.schemaHash).toBeUndefined()
  })

  it('snapshot iterates the dictionary in insertion order', () => {
    const m = new WasmStateMirror()
    // Insert in non-sorted order so dictionary order is observable.
    m.registerInput('c' as NodeId, { idx: 10, gen: 0 })
    m.registerInput('a' as NodeId, { idx: 5, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 7, gen: 0 })

    const snap = snapshot(m)
    expect(Object.keys(snap.inputs)).toEqual(['c', 'a', 'b'])
  })

  it('hydrate restores the mirror clock', () => {
    const m = new WasmStateMirror()
    const snap: GraphSnapshot = {
      schema: 1,
      time: 42 as GraphTime,
      inputs: {},
    }
    hydrate(m, snap, mockAllocator())
    expect(m.now).toBe(42)
  })

  it('hydrate mints fresh slots through the allocator for every NodeId', () => {
    const m = new WasmStateMirror()
    const alloc = mockAllocator()
    const snap: GraphSnapshot = {
      schema: 1,
      time: 0 as GraphTime,
      inputs: { a: 1, b: 'two', c: null },
    }
    hydrate(m, snap, alloc)

    expect(alloc.minted).toHaveLength(3)
    expect(m.dictionary.size).toBe(3)
    expect(m.dictionary.has('a' as NodeId)).toBe(true)
    expect(m.dictionary.has('b' as NodeId)).toBe(true)
    expect(m.dictionary.has('c' as NodeId)).toBe(true)
  })

  it('hydrate seeds the inputs mirror with snapshot values', () => {
    const m = new WasmStateMirror()
    const snap: GraphSnapshot = {
      schema: 1,
      time: 0 as GraphTime,
      inputs: { a: 1, b: 'two', c: null, d: [1, 2, 3], e: { k: 'v' } },
    }
    hydrate(m, snap, mockAllocator())
    expect(m.read('a' as NodeId)).toBe(1)
    expect(m.read('b' as NodeId)).toBe('two')
    expect(m.read('c' as NodeId)).toBeNull()
    expect(m.read('d' as NodeId)).toEqual([1, 2, 3])
    expect(m.read('e' as NodeId)).toEqual({ k: 'v' })
  })

  it('hydrate wipes prior mirror state (clean-slate restore)', () => {
    const m = new WasmStateMirror()
    m.registerInput('old' as NodeId, { idx: 99, gen: 0 })
    m.inputs.set(99, 'stale')
    ;(m as { now: number }).now = 5

    const snap: GraphSnapshot = {
      schema: 1,
      time: 100 as GraphTime,
      inputs: { fresh: 1 },
    }
    hydrate(m, snap, mockAllocator())

    expect(m.dictionary.has('old' as NodeId)).toBe(false)
    expect(m.dictionary.has('fresh' as NodeId)).toBe(true)
    expect(m.inputs.has(99)).toBe(false)
    expect(m.now).toBe(100)
  })

  it('hydrate rejects unsupported schema versions', () => {
    const m = new WasmStateMirror()
    const bad = {
      schema: 2 as 1,
      time: 0 as GraphTime,
      inputs: {},
    } as GraphSnapshot
    expect(() => hydrate(m, bad, mockAllocator())).toThrow(
      /unsupported snapshot schema/,
    )
  })

  it('hydrate ignores the optional schemaHash (adopter Graph layer validates it)', () => {
    const m = new WasmStateMirror()
    const snap: GraphSnapshot = {
      schema: 1,
      time: 0 as GraphTime,
      inputs: { a: 1 },
      schemaHash: 'some-hash-the-marshaler-does-not-check',
    }
    expect(() => hydrate(m, snap, mockAllocator())).not.toThrow()
  })

  it('snapshot → hydrate → snapshot round-trips byte-equal on inputs', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })
    m.inputs.set(0, 99)
    m.inputs.set(1, 'world')
    ;(m as { now: number }).now = 13

    const snap1 = snapshot(m)

    const restored = new WasmStateMirror()
    hydrate(restored, snap1, mockAllocator())

    const snap2 = snapshot(restored)
    // JSON.stringify is the determinism gate (object keys serialise
    // in insertion order per ES2015).
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap1))
  })

  it('post-hydrate slot integers are minted by the allocator (not snapshot-derived)', () => {
    const m = new WasmStateMirror()
    const alloc = mockAllocator(50) // Start at slot 50
    const snap: GraphSnapshot = {
      schema: 1,
      time: 0 as GraphTime,
      inputs: { a: 1 },
    }
    hydrate(m, snap, alloc)
    // Slot integer comes from the allocator, NOT from any prior
    // dictionary state.
    expect(m.getSlotForNodeId('a' as NodeId)).toEqual({ idx: 50, gen: 0 })
  })

  it('post-hydrate the mirror is fully writable via the standard surface', () => {
    const m = new WasmStateMirror()
    const snap: GraphSnapshot = {
      schema: 1,
      time: 0 as GraphTime,
      inputs: { a: 1 },
    }
    hydrate(m, snap, mockAllocator())
    // Standard mirror surface still works: read, write through
    // inputs map, dispose.
    expect(m.read('a' as NodeId)).toBe(1)
    const slot = m.getSlotForNodeId('a' as NodeId)!
    m.inputs.set(slot.idx, 999)
    expect(m.read('a' as NodeId)).toBe(999)
    m.dispose('a' as NodeId)
    expect(() => m.read('a' as NodeId)).toThrow(NodeDisposedError)
  })

  it('empty snapshot round-trips to an empty mirror', () => {
    const m = new WasmStateMirror()
    ;(m as { now: number }).now = 7
    const snap = snapshot(m)
    expect(snap.inputs).toEqual({})

    const restored = new WasmStateMirror()
    hydrate(restored, snap, mockAllocator())
    expect(restored.dictionary.size).toBe(0)
    expect(restored.inputs.size).toBe(0)
    expect(restored.now).toBe(7)
  })
})

describe('marshalBatchEnvelope() — C.2 (#1498) JS→Rust batch builder', () => {
  // Option (c) batched-commit boundary scaffolding (epic #1493). The
  // batch envelope is the (state, actions: Vec<Action>) pair the C.1
  // commit_batch(state, actions) extern (PR #1496/#1497) consumes.
  //
  // NOTE: option (c) delivers ZERO adopter perf at v1.x — the JS engine
  // remains SSOT; only the wire crossing is batched. These tests assert
  // the marshal shape is correct scaffolding, NOT a perf win.

  it('empty batch produces an empty actions list and the current input snapshot', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.inputs.set(0, 42)
    const env = marshalBatchEnvelope(m, [])
    expect(env.actions).toEqual([])
    expect(env.state.inputs).toEqual([
      { id: 0, value: 42, last_write_time: 0 },
    ])
  })

  it('N=1 batch action is byte-identical to marshalCommitEnvelope', () => {
    // The option-c doc §7 "N=1 byte-identical" invariant at the JS
    // marshal boundary: a single-commit batch's action and state must
    // equal what the single-commit builder emits for the same input.
    const m = new WasmStateMirror()
    m.registerInput('x' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('y' as NodeId, { idx: 1, gen: 0 })
    ;(m as { now: number }).now = 3

    const writes = new Map<NodeId, number>([
      ['x' as NodeId, 99],
      ['y' as NodeId, 7],
    ])
    const single = marshalCommitEnvelope(
      m,
      'edit',
      writes as ReadonlyMap<NodeId, number>,
    )
    const batch = marshalBatchEnvelope(m, [{ intent: 'edit', writes }])

    expect(batch.actions).toHaveLength(1)
    expect(batch.actions[0]).toEqual(single.action)
    expect(batch.state).toEqual(single.state)
  })

  it('emits one BridgeCommitAction per commit, in order', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })

    const env = marshalBatchEnvelope(m, [
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      { intent: 'c1', writes: new Map([['b' as NodeId, 2]]) },
      {
        intent: 'c2',
        writes: new Map([
          ['a' as NodeId, 3],
          ['b' as NodeId, 4],
        ]),
      },
    ])
    expect(env.actions).toEqual([
      { action: 'commit', intent: 'c0', writes: [0] },
      { action: 'commit', intent: 'c1', writes: [1] },
      { action: 'commit', intent: 'c2', writes: [0, 1] },
    ])
  })

  it('only the FIRST commit writes land in the input snapshot (Rust threads the rest)', () => {
    // The single `state` carries the pre-batch input snapshot with
    // commit #0's writes applied; commits 1..N-1 ride the per-action
    // `writes` slot list and are applied by the Rust extern as it
    // threads the post-state. Pre-applying them here would double-count
    // commit #0's effect on the wire.
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.inputs.set(0, 'initial')
    ;(m as { now: number }).now = 5

    const env = marshalBatchEnvelope(m, [
      { intent: 'c0', writes: new Map([['a' as NodeId, 'first']]) },
      { intent: 'c1', writes: new Map([['a' as NodeId, 'second']]) },
    ])
    // Input block reflects commit #0's write ('first'), stamped at
    // now+1; commit #1's 'second' is NOT pre-applied.
    expect(env.state.inputs).toEqual([
      { id: 0, value: 'first', last_write_time: 6 },
    ])
    expect(env.actions[1]).toEqual({
      action: 'commit',
      intent: 'c1',
      writes: [0],
    })
  })

  it('writes are sorted ascending per action (deterministic wire shape)', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 2, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('c' as NodeId, { idx: 1, gen: 0 })

    const env = marshalBatchEnvelope(m, [
      {
        intent: 'wide',
        writes: new Map([
          ['a' as NodeId, 1],
          ['b' as NodeId, 2],
          ['c' as NodeId, 3],
        ]),
      },
    ])
    expect(env.actions[0]?.writes).toEqual([0, 1, 2])
  })

  it('throws NodeDisposedError on a write to an unregistered NodeId (fail-fast before wire)', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    expect(() =>
      marshalBatchEnvelope(m, [
        { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
        { intent: 'c1', writes: new Map([['missing' as NodeId, 2]]) },
      ]),
    ).toThrow(NodeDisposedError)
  })

  it('input block is the full live slot set in sorted-by-slot order', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 5, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })
    m.inputs.set(5, 'five')
    m.inputs.set(1, 'one')

    const env = marshalBatchEnvelope(m, [
      { intent: 'c0', writes: new Map() },
    ])
    expect(env.state.inputs).toEqual([
      { id: 1, value: 'one', last_write_time: 0 },
      { id: 5, value: 'five', last_write_time: 0 },
    ])
  })
})

describe('applyBatchBridgeResult() — C.2 (#1498) Rust→JS batch projection', () => {
  // Option (c) batched-commit boundary scaffolding (epic #1493).
  // applyBatchBridgeResult iterates the N CommitRecord entries the C.1
  // commit_batch extern (PRs #1496/#1497) returns and projects each
  // into a Commit, reusing applyBridgeResult's post-state projection.
  //
  // NOTE: option (c) delivers ZERO adopter perf at v1.x — the JS engine
  // remains SSOT; only the wire crossing is batched. These tests assert
  // correct scaffolding, NOT a perf win.

  it('refreshes mirror.now and mirror.inputs from the post-batch state', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })

    const result: BatchBridgeResult = {
      state: { now: 12, inputs: [
        { id: 0, value: 'A', last_write_time: 12 },
        { id: 1, value: 'B', last_write_time: 11 },
      ] },
      commit: { time: 12, intent: 'c2', changedNodes: [1] },
      commits: [
        { time: 10, intent: 'c0', changedNodes: [0] },
        { time: 11, intent: 'c1', changedNodes: [1] },
        { time: 12, intent: 'c2', changedNodes: [1] },
      ],
      events: [],
    }
    const commits = applyBatchBridgeResult(m, result)
    expect(m.now).toBe(12)
    expect(m.inputs.get(0)).toBe('A')
    expect(m.inputs.get(1)).toBe('B')
    expect(commits).toHaveLength(3)
  })

  it('projects every CommitRecord in replay order with reverse-translated NodeIds', () => {
    const m = new WasmStateMirror()
    m.registerInput('alpha' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('beta' as NodeId, { idx: 1, gen: 0 })

    const result: BatchBridgeResult = {
      state: { now: 3, inputs: [] },
      commit: { time: 3, intent: 'last', changedNodes: [] },
      commits: [
        { time: 1, intent: 'first', changedNodes: [0] },
        { time: 2, intent: 'second', changedNodes: [0, 1] },
        { time: 3, intent: 'last', changedNodes: [] },
      ],
      events: [],
    }
    const commits = applyBatchBridgeResult(m, result)
    expect(commits).toEqual([
      {
        time: 1,
        intent: 'first',
        changedNodes: ['alpha'],
        originatedAt: undefined,
      },
      {
        time: 2,
        intent: 'second',
        changedNodes: ['alpha', 'beta'],
        originatedAt: undefined,
      },
      { time: 3, intent: 'last', changedNodes: [], originatedAt: undefined },
    ])
  })

  it('N=1 batch projection is byte-identical to applyBridgeResult', () => {
    // The option-c doc §7 "N=1 byte-identical" invariant at the JS
    // projection boundary.
    const single = new WasmStateMirror()
    single.registerInput('x' as NodeId, { idx: 0, gen: 0 })
    const batch = new WasmStateMirror()
    batch.registerInput('x' as NodeId, { idx: 0, gen: 0 })

    const post = { now: 5, inputs: [{ id: 0, value: 42, last_write_time: 5 }] }
    const record = { time: 5, intent: 'edit', changedNodes: [0] }

    const singleResult: BridgeResult = {
      state: post,
      commit: record,
      events: [],
    }
    const batchResult: BatchBridgeResult = {
      state: post,
      commit: record,
      commits: [record],
      events: [],
    }

    const singleCommit = applyBridgeResult(single, singleResult)
    const batchCommits = applyBatchBridgeResult(batch, batchResult)

    expect(batchCommits).toHaveLength(1)
    expect(batchCommits[0]).toEqual(singleCommit)
    expect(batch.now).toBe(single.now)
    expect(batch.inputs.get(0)).toBe(single.inputs.get(0))
  })

  it('empty batch produces an empty Commit[] but still refreshes the mirror', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    const result: BatchBridgeResult = {
      state: { now: 9, inputs: [{ id: 0, value: 1, last_write_time: 0 }] },
      commit: { time: 9, intent: 'batch-empty', changedNodes: [] },
      commits: [],
      events: [],
    }
    const commits = applyBatchBridgeResult(m, result)
    expect(commits).toEqual([])
    expect(m.now).toBe(9)
    expect(m.inputs.get(0)).toBe(1)
  })

  it('drops changedNodes slots absent from the live dictionary (dispose race)', () => {
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    // slot 9 was never registered (or disposed) — must be dropped.
    const result: BatchBridgeResult = {
      state: { now: 2, inputs: [] },
      commit: { time: 2, intent: 'c1', changedNodes: [0, 9] },
      commits: [{ time: 2, intent: 'c1', changedNodes: [0, 9] }],
      events: [],
    }
    const commits = applyBatchBridgeResult(m, result)
    expect(commits[0]?.changedNodes).toEqual(['a'])
  })

  it('round-trips marshalBatchEnvelope → (bridge) → applyBatchBridgeResult shape', () => {
    // End-to-end shape check: the batch the marshaler emits and the
    // batch result the bridge returns compose into N Commits. This is
    // the JS-side half of the option-c wire path; the byte-identity
    // vs sequential is pinned Rust-side by C.1's tests.
    const m = new WasmStateMirror()
    m.registerInput('a' as NodeId, { idx: 0, gen: 0 })
    m.registerInput('b' as NodeId, { idx: 1, gen: 0 })

    const env = marshalBatchEnvelope(m, [
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      { intent: 'c1', writes: new Map([['b' as NodeId, 2]]) },
    ])
    expect(env.actions).toHaveLength(2)

    // Simulated bridge result for that 2-commit batch.
    const result: BatchBridgeResult = {
      state: { now: 2, inputs: [
        { id: 0, value: 1, last_write_time: 1 },
        { id: 1, value: 2, last_write_time: 2 },
      ] },
      commit: { time: 2, intent: 'c1', changedNodes: [1] },
      commits: [
        { time: 1, intent: 'c0', changedNodes: [0] },
        { time: 2, intent: 'c1', changedNodes: [1] },
      ],
      events: [],
    }
    const commits = applyBatchBridgeResult(m, result)
    expect(commits.map((c) => c.intent)).toEqual(['c0', 'c1'])
    expect(commits.map((c) => c.changedNodes)).toEqual([['a'], ['b']])
    expect(m.now).toBe(2)
  })
})
