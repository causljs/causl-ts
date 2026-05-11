/**
 * @packageDocumentation
 *
 * End-to-end smoke test running the smallest worked example as a single
 * linear scenario: build the tiny diamond (`a`, `b`, `sum`, `sumPlusOne`),
 * subscribe at the leaf, then drive two commits and assert the observed
 * sequence. This is the gate for "the engine is real" — until this works,
 * no other phase begins. The four invariants we care about (atomic
 * commit, dependency tracking, dynamic-dep cleanup, glitch-free diamond)
 * all fall out of this example, so even though the deeper coverage lives
 * in `spec-10-worked-example.test.ts`, the smoke variant earns its place
 * as the quickest signal that the engine still holds together.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

/**
 * Single-scenario smoke check that the smallest worked example runs
 * end-to-end and emits the documented value sequence — the canonical
 * `[4, 13, 301]` of "subscribe, bump-a, bump-both", with exactly one
 * notification per commit even when both inputs change.
 */
describe('smoke: smallest worked example', () => {
  /**
   * Drives the worked example top-to-bottom and asserts each emission:
   * initial subscribe, single-input commit, multi-input commit (one
   * notification, not two — atomicity is structural, not a hope).
   */
  it('runs the smallest worked example end-to-end', () => {
    // Arrange: build the tiny diamond and start observing the leaf.
    const observed: number[] = []

    const graph = createCausl()
    const a = graph.input('a', 1)
    const b = graph.input('b', 2)
    const sum = graph.derived('sum', (get) => get(a) + get(b))
    const sumPlusOne = graph.derived('sumPlusOne', (get) => get(sum) + 1)

    // Act + assert: subscribing fires once with the current value (1 + 2 + 1).
    graph.subscribe(sumPlusOne, (v) => observed.push(v))
    expect(observed).toEqual([4])

    // Act + assert: bumping a single input produces one notification (10 + 2 + 1).
    graph.commit('bump-a', (tx) => tx.set(a, 10))
    expect(observed).toEqual([4, 13])

    // Act: write both inputs in a single transaction.
    graph.commit('bump-both', (tx) => {
      tx.set(a, 100)
      tx.set(b, 200)
    })
    // Assert: exactly one notification per commit even when both inputs changed.
    expect(observed).toEqual([4, 13, 301])
  })
})
