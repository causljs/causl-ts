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
import type { NodeId } from '../src/types.js'
import {
  NodeDisposedError,
  WasmStateMirror,
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
