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
  hydrate,
  NodeDisposedError,
  snapshot,
  WasmStateMirror,
  type BridgeAllocator,
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
