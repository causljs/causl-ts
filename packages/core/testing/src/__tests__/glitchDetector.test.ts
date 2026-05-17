/**
 * Tests for glitchDetector.
 *
 * The detector is a contract gate. If it reports false negatives we
 * lose the §3 invariant; if it reports false positives every property
 * suite fails for the wrong reason.
 */

import { describe, it, expect } from 'vitest'
import { createCausl } from '@causl/core'
import { glitchDetector } from '../glitchDetector.js'

describe('glitchDetector', () => {
  it('reports zero glitches on a stable engine', () => {
    const graph = createCausl()
    const a = graph.input('a', 1)
    const b = graph.input('b', 2)
    const sum = graph.derived('sum', (get) => get(a) + get(b))
    const detector = glitchDetector(
      graph,
      sum,
      ([av, bv]) => av + bv,
      [a, b],
    )
    for (let i = 0; i < 100; i++) graph.commit('bump', (tx) => tx.set(a, i))
    expect(detector.observed).toBe(0)
    detector.dispose()
  })

  it('reports a glitch when the expected fn disagrees with the engine value', () => {
    const graph = createCausl()
    const a = graph.input('a', 1)
    const b = graph.input('b', 2)
    const sum = graph.derived('sum', (get) => get(a) + get(b))
    // Wrong expected: claims sum = a * b. Every observation should glitch.
    const detector = glitchDetector(
      graph,
      sum,
      ([av, bv]) => av * bv,
      [a, b],
    )
    graph.commit('bump', (tx) => tx.set(a, 5)) // engine: 5+2=7, expected: 5*2=10
    expect(detector.observed).toBeGreaterThan(0)
    expect(detector.isGlitched()).toBe(true)
    detector.dispose()
  })

  it('reset zeroes the count without disposing', () => {
    const graph = createCausl()
    const a = graph.input('a', 1)
    const b = graph.input('b', 2)
    const sum = graph.derived('sum', (get) => get(a) + get(b))
    const detector = glitchDetector(graph, sum, ([av, bv]) => av * bv, [a, b])
    graph.commit('1', (tx) => tx.set(a, 5))
    expect(detector.observed).toBeGreaterThan(0)
    detector.reset()
    expect(detector.observed).toBe(0)
    graph.commit('2', (tx) => tx.set(a, 6))
    expect(detector.observed).toBeGreaterThan(0) // still attached
    detector.dispose()
  })

  it('dispose removes subscriptions (no further observations)', () => {
    const graph = createCausl()
    const a = graph.input('a', 1)
    const b = graph.input('b', 2)
    const sum = graph.derived('sum', (get) => get(a) + get(b))
    const detector = glitchDetector(graph, sum, ([av, bv]) => av * bv, [a, b])
    detector.dispose()
    detector.reset()
    graph.commit('after-dispose', (tx) => tx.set(a, 99))
    expect(detector.observed).toBe(0)
  })

  it('respects custom equality (e.g. structural for objects)', () => {
    const graph = createCausl()
    const a = graph.input<{ x: number }>('a', { x: 1 })
    const wrapped = graph.derived('wrapped', (get) => ({ x: get(a).x }))
    // Default equality is Object.is — every commit yields a fresh object,
    // so even a "correct" expected fn would glitch. Custom shallow equals
    // makes the detector see them as equal.
    const detector = glitchDetector(
      graph,
      wrapped,
      ([{ x }]) => ({ x }),
      [a],
      { equals: (p, q) => p.x === q.x },
    )
    graph.commit('1', (tx) => tx.set(a, { x: 42 }))
    expect(detector.observed).toBe(0)
    detector.dispose()
  })
})
