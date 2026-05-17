/**
 * @packageDocumentation
 *
 * Tests for the {@link whyNotUpdated} negative-attribution helper.
 *
 * Shaped as a `DerivedNode<WhyResult>` per §11 — the engine is its own
 * observer, and a "why didn't this update?" panel is itself a derived
 * view over `graph.commitLog` and `graph.explain`. The cases cover the
 * four reportable reasons a node can fail to update across the commit
 * log: an empty log (`no-cause`), a log whose latest commit actually
 * did update the node (`did-update`), a commit that perturbed
 * unrelated inputs (`no-dep-overlap`), and a recompute whose output
 * was collapsed by `Object.is` value-equality (`object-is-deduped`).
 *
 * Tests construct the engine with explicit `commitHistoryCap` /
 * `snapshotRetentionCap` because SPEC §5.1 Amendment 2 (#716) flipped
 * the default to 0; `whyNotUpdated` walks `graph.commitLog`, so opt-in
 * retention is a hard precondition.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { whyNotUpdated } from '../src/index.js'

/**
 * Behavioural suite for {@link whyNotUpdated}: explains the absence
 * of an update on a chosen node by classifying the reason against the
 * commit log.
 */
describe('whyNotUpdated(graph, node)', () => {
  /**
   * With an empty commit log there is nothing to attribute against,
   * so the helper must report `no-cause` with a null cause pointer.
   */
  it('returns no-cause on an empty log', () => {
    // Graph created but never committed; the log is empty.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyNotUpdated(g, a)
    const r = g.read(why)
    // Empty log -> no-cause with a null cause pointer.
    expect(r.reason).toBe('no-cause')
    expect(r.cause).toBe(null)
  })

  /**
   * A negative-attribution query against a node that was actually
   * updated by the latest commit must be honest about that
   * contradiction and report `did-update` rather than fabricate a
   * reason.
   */
  it('returns did-update when the latest commit DID change the node', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyNotUpdated(g, a)
    // The very commit being inspected directly mutates `a`.
    g.commit('a→1', (tx) => tx.set(a, 1))
    const r = g.read(why)
    // Helper detects the false premise of the question and reports it.
    expect(r.reason).toBe('did-update')
  })

  /**
   * If the latest commit only mutated inputs outside the queried
   * node's dependency set, the helper must surface `no-dep-overlap`
   * and still list the actually-changed inputs so the caller can
   * audit the boundary.
   */
  it('returns no-dep-overlap when changed nodes are not deps', () => {
    // `sum` depends only on `a`; `b` is intentionally outside its dep set.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const sum = g.derived('sum', (get) => get(a) + 0)
    const why = whyNotUpdated(g, sum)
    // Commit touches `b` only -- no overlap with `sum`'s dependencies.
    g.commit('b→7', (tx) => tx.set(b, 7))
    const r = g.read(why)
    // Reason classifies dep-set disjointness explicitly.
    expect(r.reason).toBe('no-dep-overlap')
    // The mutated-but-unrelated input should still be reported for context.
    expect(r.inputs).toContain('b')
  })

  /**
   * Distinguishes value-equality dedupe from a true non-update: when
   * a dependency changes and the derived recomputes but the resulting
   * value is `Object.is`-equal to the previous one, the helper
   * reports `object-is-deduped` along with the implicated input.
   */
  it('returns object-is-deduped when deps recomputed but value is Object.is-equal', () => {
    // `sum` clamps `a` at zero, so any non-positive `a` produces the same value (0).
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const sum = g.derived('sum', (get) => Math.max(get(a), 0))
    const why = whyNotUpdated(g, sum)
    // Mutate `a` to a value that yields the same clamped output as the seed.
    g.commit('a→-1', (tx) => tx.set(a, -1))
    const r = g.read(why)
    // Recompute happened; result was deduped via Object.is identity.
    expect(r.reason).toBe('object-is-deduped')
    // Source of the recompute is reported among the implicated inputs.
    expect(r.inputs).toContain('a')
  })
})
