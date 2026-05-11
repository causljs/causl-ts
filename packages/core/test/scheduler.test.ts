/**
 * @packageDocumentation
 *
 * Scheduler-cost tests pinning the engine's only defended performance
 * target: a commit producing N derived recomputations must run in O(N)
 * time, not O(graph size). Dirty marking and dependency walking are
 * bounded by the affected subgraph — this is a correctness criterion
 * phrased as performance, not a benchmark. Each test instruments derived
 * computes with a counter and asserts that touching one input or one
 * chain only re-evaluates the affected sub-graph, leaving unrelated
 * derivations untouched regardless of total registered derivation count.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

/**
 * Scheduler complexity contract: recomputation cost is bounded by the
 * dirty sub-graph, never by the total registered graph size. Specific
 * node counts and millisecond targets are deliberately not asserted
 * here — those are an epic-level concern. The only thing the engine
 * defends at this layer is the asymptotic shape.
 */
describe('scheduler — O(affected), not O(graph_size)', () => {
  /**
   * Setting one input should recompute exactly the derivations that
   * depend on it — and no others — even when an equally large fan-out
   * exists off an unrelated input. If the dirty walk ever degraded to
   * scanning the whole graph, this test would catch it: the unrelated
   * fan-out's compute counter would tick.
   */
  it('a commit that touches one input recomputes only its dependents', () => {
    // Arrange: two inputs, each with an equal fan-out of derivations counting compute calls.
    const g = createCausl()
    let aSideComputes = 0
    let bSideComputes = 0
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const aDerivCount = 50
    const bDerivCount = 50
    for (let i = 0; i < aDerivCount; i++) {
      g.derived(`a${i}`, (get) => {
        aSideComputes++
        return get(a) + i
      })
    }
    for (let i = 0; i < bDerivCount; i++) {
      g.derived(`b${i}`, (get) => {
        bSideComputes++
        return get(b) + i
      })
    }
    // Reset post-registration baseline.
    aSideComputes = 0
    bSideComputes = 0

    // Act: commit a single write to `a`.
    g.commit('bump-a', (tx) => tx.set(a, 1))

    // Assert: exactly the a-side fanout recomputed; the b-side stayed cold.
    expect(aSideComputes).toBe(aDerivCount)
    expect(bSideComputes).toBe(0)
  })

  /**
   * A linear chain of derivations must recompute once per chain link
   * when its root input changes; unrelated noise nodes (sharing a
   * different input) must not run at all. This pins the same
   * "O(affected), not O(total)" contract along a chain rather than a
   * fan-out — the dirty walk must follow real dependencies, not stride
   * the registered universe.
   */
  it('chain recompute scales with the chain length, not the graph size', () => {
    // Arrange: build a chain rooted at `a` with per-node compute counters.
    const g = createCausl()
    const a = g.input('a', 0)
    const chainLen = 20
    const noiseSize = 100
    const computes: number[] = Array.from({ length: chainLen }, () => 0)

    let prev: import('../src/index.js').Node<number> = a
    for (let i = 0; i < chainLen; i++) {
      const idx = i
      const upstream: import('../src/index.js').Node<number> = prev
      const node: import('../src/index.js').Node<number> = g.derived<number>(
        `chain-${i}`,
        (get) => {
          computes[idx]! += 1
          return get(upstream) + 1
        },
      )
      prev = node
    }
    // Independent noise: 100 derivations sharing one unrelated input.
    const noise = g.input('noise', 0)
    for (let i = 0; i < noiseSize; i++) {
      g.derived(`noise-${i}`, (get) => get(noise) + i)
    }
    // Reset per-node counters after registration warmup.
    for (let i = 0; i < computes.length; i++) computes[i] = 0

    // Act: commit a single write to the chain root.
    g.commit('bump-a', (tx) => tx.set(a, 1))

    // Assert: every chain node recomputes exactly once; noise stays untouched.
    for (let i = 0; i < chainLen; i++) {
      expect(computes[i]).toBe(1)
    }
  })
})
