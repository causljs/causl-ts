/**
 * @packageDocumentation
 *
 * Tests for the {@link whyUpdated} causal-attribution helper.
 *
 * The helper is shaped as a `DerivedNode<WhyResult>` per §11 — the
 * engine is its own observer, and a "why did this update?" panel is
 * itself a derived view over `graph.commitLog` and `graph.explain`.
 * Each case builds a small graph, threads commits through it, and
 * reads the live node at the engine's current time to assert the
 * helper correctly identifies the responsible commit, the propagation
 * path, and the implicated input set for both directly-set inputs and
 * recomputed derived nodes — including the no-cause case when nothing
 * along the dependency frontier changed.
 *
 * Tests construct the engine with explicit `commitHistoryCap` /
 * `snapshotRetentionCap` because SPEC §5.1 Amendment 2 (#716) flipped
 * the default to 0; `whyUpdated` walks `graph.commitLog`, so opt-in
 * retention is a hard precondition.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { whyUpdated } from '../src/index.js'

/**
 * Behavioural suite for {@link whyUpdated}, the developer-facing
 * helper that answers causal-attribution queries against the engine's
 * commit log.
 */
describe('whyUpdated(graph, node)', () => {
  /**
   * Confirms that for a derived node, the helper walks back to the
   * most recent commit that perturbed any of its transitive
   * dependencies and reports `recomputed` along with the offending
   * input and propagation path.
   */
  it('finds the most recent commit that changed a derived node', () => {
    // Two independent inputs feeding one summation derived node.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const why = whyUpdated(g, sum)
    // Two consecutive commits; the second is the most-recent perturbation of `sum`.
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('b→5', (tx) => tx.set(b, 5))
    const result = g.read(why)
    // Derived nodes report `recomputed` rather than `directly-set`.
    expect(result.reason).toBe('recomputed')
    // Cause must point at the latest commit that touched a dependency.
    expect(result.cause?.intent).toBe('b→5')
    // Propagation path includes the queried node itself.
    expect(result.path).toContain('sum')
    // The implicated input list surfaces the actually-mutated upstream input.
    expect(result.inputs).toContain('b')
  })

  /**
   * For an input node mutated within the commit log, the helper must
   * classify the cause as `directly-set` and produce a single-element
   * propagation path naming only the input itself.
   */
  it('reports direct sets on inputs', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    // A simple direct mutation of input `a`.
    g.commit('a→7', (tx) => tx.set(a, 7))
    const result = g.read(why)
    // Direct mutation -> `directly-set` reason and single-node path.
    expect(result.reason).toBe('directly-set')
    expect(result.cause?.intent).toBe('a→7')
    expect(result.path).toEqual(['a'])
  })

  /**
   * When the queried node was never touched (directly or transitively)
   * the helper must yield `no-cause` with both the cause and path
   * nulled out so callers can distinguish absence from error.
   */
  it('returns no-cause when the node has not changed in the log', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const why = whyUpdated(g, b)
    // Only `a` is mutated; `b` is intentionally left untouched.
    g.commit('a→1', (tx) => tx.set(a, 1))
    const result = g.read(why)
    // No causal attribution exists -> all three signal-fields are nulled.
    expect(result.reason).toBe('no-cause')
    expect(result.cause).toBe(null)
    expect(result.path).toBe(null)
  })

  /**
   * Pins down the formatting contract for the human-readable `because`
   * field: the sentence is fully determined by the structured `reason`,
   * the commit intent string, and the commit's `GraphTime`, with no
   * other sources of variation.
   */
  it('the human `because` string is derived from `reason` deterministically', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    g.commit('a→1', (tx) => tx.set(a, 1))
    const result = g.read(why)
    // Exact-match assertion locks the rendered phrasing in place.
    expect(result.because).toBe('Set directly in commit "a→1" (t=1).')
  })
})
