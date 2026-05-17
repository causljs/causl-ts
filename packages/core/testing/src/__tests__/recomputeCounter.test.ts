/**
 * Tests for recomputeCounter.
 *
 * The seam itself must be deterministic and side-effect-free; if the
 * helper miscounts, every downstream test that consumes it lies.
 */

import { describe, it, expect } from 'vitest'
import { createCausl } from '@causljs/core'
import { recomputeCounter } from '../recomputeCounter.js'

describe('recomputeCounter', () => {
  it('counts a derived recompute exactly once per dirty commit', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', counter.wrap((get) => get(a) * 2, 'b'))
    graph.subscribe(b, () => {}) // force engine to compute

    expect(counter.count('b')).toBe(1) // initial settle

    graph.commit('bump', (tx) => tx.set(a, 2))
    expect(counter.count('b')).toBe(2)

    graph.commit('bump', (tx) => tx.set(a, 3))
    expect(counter.count('b')).toBe(3)
  })

  it('counts the initial eager compute that derived registration runs', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    graph.derived('b', counter.wrap((get) => get(a) * 2, 'b'))
    // Engine contract (graph.ts: derived → computeDerived): registration
    // eagerly evaluates the compute once to populate the value and seed
    // the dependency set. The seam observes that one settle.
    expect(counter.count('b')).toBe(1)
  })

  it('SPEC §14: diamond mutation recomputes exactly the affected nodes', () => {
    // A → B; A → C; B + C → D. Bump A. Expect:
    //   B: 1 recompute, C: 1 recompute, D: 1 recompute.
    // Total 3, not 4 (no spurious join), not >3.
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', counter.wrap((get) => get(a) + 10, 'b'))
    const c = graph.derived('c', counter.wrap((get) => get(a) + 100, 'c'))
    const d = graph.derived('d', counter.wrap((get) => get(b) + get(c), 'd'))
    graph.subscribe(d, () => {})
    counter.reset()

    graph.commit('bump-a', (tx) => tx.set(a, 2))

    expect(counter.count('b')).toBe(1)
    expect(counter.count('c')).toBe(1)
    expect(counter.count('d')).toBe(1)
    expect(counter.total()).toBe(3)
  })

  it('SPEC §14: equality cutoff prevents downstream recompute', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    // b returns a constant; even when a changes, b's value never does.
    const b = graph.derived('b', counter.wrap(() => 42, 'b'))
    const c = graph.derived('c', counter.wrap((get) => get(b) + 1, 'c'))
    graph.subscribe(c, () => {})
    counter.reset()

    graph.commit('bump-a', (tx) => tx.set(a, 2))

    // b *might* be recomputed by the engine to discover its value is
    // stable — that's a 0 or 1 we can't pin without knowing the engine
    // strategy. But c MUST NOT recompute, because b's value didn't
    // change. That is the equality-cutoff promise.
    expect(counter.count('c')).toBe(0)
  })

  it('byNode is shorthand for count(node.id) when wrap was given the node id', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', counter.wrap((get) => get(a) + 1, 'b'))
    graph.subscribe(b, () => {})
    expect(counter.byNode(b)).toBe(counter.count('b'))
  })

  it('reset zeroes counters but does not detach instrumentation', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', counter.wrap((get) => get(a) + 1, 'b'))
    graph.subscribe(b, () => {})
    graph.commit('1', (tx) => tx.set(a, 2))
    expect(counter.count('b')).toBeGreaterThan(0)

    counter.reset()
    expect(counter.count('b')).toBe(0)

    graph.commit('2', (tx) => tx.set(a, 3))
    expect(counter.count('b')).toBe(1) // still instrumented
  })

  it('snapshot returns a frozen object', () => {
    const counter = recomputeCounter()
    const snap = counter.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
  })

  it('two independent counters do not share state', () => {
    const graph = createCausl()
    const c1 = recomputeCounter()
    const c2 = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', c1.wrap((get) => get(a) + 1, 'b'))
    graph.derived('c', c2.wrap((get) => get(a) + 2, 'c'))
    graph.subscribe(b, () => {})
    graph.commit('1', (tx) => tx.set(a, 2))

    // Each counter only sees its own wrapped node; neither leaks into
    // the other's tally.
    expect(c1.count('b')).toBeGreaterThan(0)
    expect(c2.count('c')).toBeGreaterThan(0)
    expect(c1.count('c')).toBe(0)
    expect(c2.count('b')).toBe(0)
  })

  it('preserves the wrapped compute return value', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 7)
    const b = graph.derived('b', counter.wrap((get) => get(a) * 11, 'b'))
    expect(graph.read(b)).toBe(77)
  })

  it('auto-labels anonymous wraps so they appear in snapshot', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 1)
    const b = graph.derived('b', counter.wrap((get) => get(a) + 1)) // no label
    graph.subscribe(b, () => {})
    const snap = counter.snapshot()
    expect(Object.keys(snap)).toHaveLength(1)
    expect(Object.values(snap)[0]).toBeGreaterThan(0)
  })
})
