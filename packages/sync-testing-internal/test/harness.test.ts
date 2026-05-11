/**
 * @packageDocumentation
 *
 * Tests for the SPEC.async §15.0 harness factories (#578).
 *
 * The harness factories must wrap a LIVE @causl/core Graph with
 * a real @causl/sync Resource / ConflictRegistry — replacing the
 * pre-#578 model-state simulation. These tests pin that
 * structural property so a future regression that swaps the
 * harness back to a model-state shadow trips at PR time.
 */

import { describe, expect, it } from 'vitest'
import {
  propertyConflict,
  propertyConflictWithMap,
  propertyResource,
} from '../src/index.js'

describe('propertyResource — live-Graph harness (#578)', () => {
  it('returns a live Graph + ResourceHandle', () => {
    const harness = propertyResource<number>()
    expect(harness.graph).toBeDefined()
    // The Graph is real if it has a working `now` accessor.
    expect(typeof harness.graph.now).toBe('number')
    expect(harness.handle).toBeDefined()
    expect(harness.handle.node).toBeDefined()
    expect(typeof harness.handle.fetch).toBe('function')
    expect(typeof harness.handle.invalidate).toBe('function')
    expect(typeof harness.handle.fail).toBe('function')
    expect(typeof harness.settle).toBe('function')
  })

  it('initial resource state is idle', () => {
    const { graph, handle } = propertyResource<number>()
    const state = graph.read(handle.node)
    expect(state.state).toBe('idle')
  })

  it('settle resolves a pending fetch with the supplied value', async () => {
    const { graph, handle, settle } = propertyResource<number>()
    const pending = handle.fetch()
    expect(graph.read(handle.node).state).toBe('loading')
    settle({ ok: true, value: 42 })
    const value = await pending
    expect(value).toBe(42)
    const state = graph.read(handle.node)
    expect(state.state).toBe('loaded')
    if (state.state === 'loaded') {
      expect(state.value).toBe(42)
    }
  })

  it('settle rejects a pending fetch with the supplied error', async () => {
    const { graph, handle, settle } = propertyResource<number>()
    const pending = handle.fetch()
    settle({ ok: false, error: new Error('boom') })
    await expect(pending).rejects.toThrow(/boom/)
    expect(graph.read(handle.node).state).toBe('errored')
  })

  it('each harness instance has an independent Graph', () => {
    const a = propertyResource<number>()
    const b = propertyResource<number>()
    expect(a.graph).not.toBe(b.graph)
  })
})

describe('propertyConflict — live-Graph harness (#578)', () => {
  it('returns a live Graph + ConflictRegistry', () => {
    const harness = propertyConflict<number>()
    expect(harness.graph).toBeDefined()
    expect(typeof harness.graph.now).toBe('number')
    expect(harness.registry).toBeDefined()
    expect(typeof harness.registry.read).toBe('function')
    expect(typeof harness.registry.resolve).toBe('function')
    expect(typeof harness.raise).toBe('function')
    expect(typeof harness.unraise).toBe('function')
  })

  it('initial registry is empty', () => {
    const { graph, registry } = propertyConflict<number>()
    expect(registry.read(graph)).toEqual([])
  })

  it('raise adds a conflict to the registry', () => {
    const { graph, registry, raise } = propertyConflict<number>()
    raise('c1', 'targetA', 100)
    const conflicts = registry.read(graph)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.id).toBe('c1')
    expect(conflicts[0]?.kind).toBe('open')
  })

  it('unraise removes the conflict from the source', () => {
    const { graph, registry, raise, unraise } = propertyConflict<number>()
    raise('c1', 't', 1)
    expect(registry.read(graph)).toHaveLength(1)
    unraise('c1')
    expect(registry.read(graph)).toEqual([])
  })

  it('registry.resolve transitions Open → Resolved', () => {
    const { graph, registry, raise } = propertyConflict<number>()
    raise('c1', 't', 1)
    registry.resolve(graph, 'c1', 999)
    const conflicts = registry.read(graph)
    expect(conflicts[0]?.kind).toBe('resolved')
  })
})

describe('propertyConflictWithMap — live-Graph harness with map (#578)', () => {
  it('returns a live Graph + ConflictRegistry + sourceInput', () => {
    const harness = propertyConflictWithMap<number>(['a', 'b'])
    expect(harness.graph).toBeDefined()
    expect(harness.registry).toBeDefined()
    expect(harness.sourceInput).toBeDefined()
  })

  it('seeds the registry with the supplied open ids', () => {
    const { graph, registry } = propertyConflictWithMap<number>(['a', 'b', 'c'])
    const conflicts = registry.read(graph)
    expect(conflicts).toHaveLength(3)
    expect(conflicts.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
    for (const c of conflicts) {
      expect(c.kind).toBe('open')
    }
  })

  it('exposes the source Input for direct mutation', () => {
    const { graph, registry, sourceInput } = propertyConflictWithMap<number>(['a'])
    expect(registry.read(graph)).toHaveLength(1)
    // Mutate the source map directly.
    graph.commit('replace', (tx) => {
      tx.set(sourceInput, new Map([['x', null]]) as ReadonlyMap<string, number>)
    })
    const conflicts = registry.read(graph)
    expect(conflicts.map((c) => c.id)).toEqual(['x'])
  })

  it('each harness instance has an independent Graph', () => {
    const a = propertyConflictWithMap<number>(['a'])
    const b = propertyConflictWithMap<number>(['b'])
    expect(a.graph).not.toBe(b.graph)
    expect(a.registry.read(a.graph)[0]?.id).toBe('a')
    expect(b.registry.read(b.graph)[0]?.id).toBe('b')
  })
})
