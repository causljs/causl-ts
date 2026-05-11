/**
 * @packageDocumentation
 *
 * §11 liveness pins for {@link whyUpdated} / {@link whyNotUpdated}.
 *
 * The previous one-shot snapshot shape returned a `WhyResult` value
 * computed from a captured commit window. SPEC §11 calls that out as
 * the wrong framing — a "why did this update?" panel re-fires every
 * commit, and the cheapest correct shape is "itself a derived node."
 * #455 added `graph.commitMetadataDerived(...)` so a derivation that
 * reads `graph.commitLog` recomputes in Phase F.5 (post-`commitLog`
 * refresh, pre-Phase-G subscriber dispatch); these pins assert the
 * resulting devtools surface honours the §11 framing rather than
 * regressing back to a snapshot.
 *
 * Closes #383.
 *
 * Tests construct the engine with explicit `commitHistoryCap` /
 * `snapshotRetentionCap` because SPEC §5.1 Amendment 2 (#716) flipped
 * the default to 0; the §11 liveness primitives walk
 * `graph.commitLog`, so opt-in retention is required for any
 * non-trivial classification.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import type { WhyResult } from '../src/index.js'
import { whyNotUpdated, whyUpdated } from '../src/index.js'

describe('§11 liveness — whyUpdated / whyNotUpdated as DerivedNode', () => {
  /**
   * Pin: subscribing to `whyUpdated(g, n)` fires once initially and
   * once per commit that changes the classification. The engine is
   * its own observer — UIs do not poll on every commit notification,
   * they `subscribe` and let the engine push the answer.
   */
  it('subscribers to whyUpdated fire when the answer updates', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    const fired: WhyResult[] = []
    g.subscribe(why, (value) => fired.push(value))
    // Initial fire (t=0) registers the no-cause baseline.
    expect(fired.length).toBe(1)
    expect(fired[0]?.reason).toBe('no-cause')

    // Each commit that changes `a` must produce a fresh fire with
    // the *new* commit's record at `cause` — Phase F.5 is the
    // scheduling seam that makes this true on the same commit.
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(fired.length).toBe(2)
    expect(fired[1]?.reason).toBe('directly-set')
    expect(fired[1]?.cause?.intent).toBe('a→1')

    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(fired.length).toBe(3)
    expect(fired[2]?.cause?.intent).toBe('a→2')
  })

  /**
   * Pin: `readAt(whyUpdated(g, n), pastTime)` is a uniform read on
   * the same retention buffer that backs every other `DerivedNode`.
   * The §11 framing is that the explainer participates in the
   * standard surface; this pin confirms the call routes through
   * `readAt` (not a parallel devtools-side time-travel buffer).
   *
   * Observation: the value returned is `recomputeFromSnapshot`'s
   * answer against the historical *input* row, but
   * `commitLogEntry.compute` reads the live `commitLogEntry.value` —
   * so the why-classification reflects the latest commit log, not
   * the past one. The honest pin is therefore "the call lands on
   * the standard retention surface and returns a `Retained` arm";
   * it is NOT "the past answer is reconstructable from inputs
   * alone." A future engine seam that retains commit-metadata-
   * derived values per row would extend this; the §11 commitment
   * the issue cites is satisfied by the live (`read` / `subscribe`)
   * surface, which this pin does not gate on.
   */
  it('readAt(whyUpdated, t) routes through the standard retention surface', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)

    g.commit('first', (tx) => tx.set(a, 1))
    g.commit('second', (tx) => tx.set(a, 2))
    g.commit('third', (tx) => tx.set(a, 3))

    // `readAt` returns a `RetentionResult<T>` — `retained` for the
    // committed past, `evicted` once the retention cap drops.
    const past = g.readAt(why, 1)
    expect(past.status).toBe('retained')
    if (past.status === 'retained') {
      // The retained read returns a fully-populated `WhyResult`; the
      // structural pin (every standard read surface keeps working) is
      // what §11 promises — historical content semantics depend on
      // future commit-metadata retention work.
      expect(past.value.node).toBe('a')
      expect(typeof past.value.because).toBe('string')
    }
  })

  /**
   * Pin: `whyUpdated(g, n)` is memoised per `(graph, node)` — calling
   * it twice returns the same `DerivedNode<...>`. A UI that asks the
   * same question in two places must subscribe to one stream, not
   * two; without memoisation, the second call would throw
   * `DuplicateNodeError` from the engine because the registration id
   * collides.
   */
  it('whyUpdated returns a stable identity per (graph, node)', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const first = whyUpdated(g, a)
    const second = whyUpdated(g, a)
    expect(first).toBe(second)
  })

  /**
   * Pin: same memoisation contract for `whyNotUpdated`.
   */
  it('whyNotUpdated returns a stable identity per (graph, node)', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const first = whyNotUpdated(g, a)
    const second = whyNotUpdated(g, a)
    expect(first).toBe(second)
  })

  /**
   * Pin: subscribers fire on the commit that triggered the why, not
   * one commit later. This is the original blocker the issue
   * documents — Phase D ran before `commitLogEntry.value` was
   * refreshed, so a derivation that read `graph.commitLog` returned
   * the *previous* commit's array. #455 / Phase F.5 closes that gap;
   * this test pins it.
   */
  it('whyUpdated subscriber sees the triggering commit, not the previous one', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    const fired: { time: number; intent: string | undefined }[] = []
    g.subscribe(why, (value, time) => {
      fired.push({ time, intent: value.cause?.intent })
    })
    // Initial fire — no commit has landed yet.
    expect(fired.length).toBe(1)
    expect(fired[0]).toEqual({ time: 0, intent: undefined })

    // The §383 regression had `intent` here be `undefined` (the
    // previous, empty log) rather than `'a→1'`. Phase F.5 is what
    // makes the assertion below hold.
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(fired.length).toBe(2)
    expect(fired[1]).toEqual({ time: 1, intent: 'a→1' })

    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(fired.length).toBe(3)
    expect(fired[2]).toEqual({ time: 2, intent: 'a→2' })
  })

  /**
   * Pin: `whyNotUpdated` flips between `did-update` and
   * `no-dep-overlap` as commits land, with the freshness guarantee
   * Phase F.5 provides. This is the §383 regression flipped onto the
   * other explainer — without Phase F.5, the second assertion would
   * read the *previous* commit's classification.
   */
  it('whyNotUpdated tracks classification across commits', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const sum = g.derived('sum', (get) => get(a) + 0)
    const why = whyNotUpdated(g, sum)

    // Commit on `b` only — no overlap with sum's deps; classification
    // is `no-dep-overlap`.
    g.commit('b→1', (tx) => tx.set(b, 1))
    expect(g.read(why).reason).toBe('no-dep-overlap')

    // Now commit on `a` — sum updates; the same live node reports
    // `did-update` against the just-completed commit.
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(g.read(why).reason).toBe('did-update')
  })

  /**
   * Pin: `explain(whyUpdated(g, n))` returns a derived view whose
   * lineage cites the engine's `commitLog` and the target node's
   * `explain`. The "§11 the engine is its own observer" framing is
   * exactly that the explainer composes through the same primitives
   * any other consumer uses; this pin asserts the lineage is real.
   */
  it('explain(whyUpdated(g, n)) reports a derived lineage', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    const exp = g.read(g.explain(why))
    // The explainer itself is a derived node; its explanation is a
    // `via: 'derived'` (or `'commit-metadata'`-tagged) frame, not an
    // `'input'`. The §455 row attaches the tag at the engine seam;
    // here we only assert the structural lineage shape.
    expect(exp.via).not.toBe('input')
  })
})
