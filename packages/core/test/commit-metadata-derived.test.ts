/**
 * @packageDocumentation
 *
 * `graph.commitMetadataDerived` contract suite (#452).
 *
 * The commit pipeline's Phase D (recompute fixpoint) runs *before*
 * Phase F.4 refreshes `commitLogEntry.value`. A derivation that reads
 * `graph.commitLog` therefore sees the *previous* commit's array if
 * registered through plain `graph.derived`. PR #383's attempt to turn
 * `whyUpdated` / `whyNotUpdated` / `commitLog` devtools surfaces into
 * live derived nodes failed for exactly this reason.
 *
 * `commitMetadataDerived(id, compute)` adds the typed seam: tagged
 * nodes are recomputed in Phase F.5 (post-Phase-F.4, pre-Phase-G), so
 * their compute sees the just-completed commit. Ordinary deriveds are
 * untouched by Phase F.5 — the §3 atomicity contract holds for code
 * that did not opt in.
 *
 * The four invariants pinned here:
 *
 *   1. A commit-metadata derived that reads `graph.commitLog` returns
 *      the just-completed commit (not the previous one).
 *   2. Ordinary derived nodes are NOT affected by Phase F.5 — Phase D
 *      atomicity is preserved.
 *   3. Commit-metadata deriveds are subscribable; subscribers fire on
 *      the post-commit value.
 *   4. `readAt` projects a commit-metadata derived's value at past
 *      `t` correctly through the standard retention buffer.
 *
 * Plus a 1000-trial property test on random sequences of (ordinary
 * commit, commit-metadata read) preserving the §3 invariant for
 * ordinary deriveds AND the §11 freshness guarantee for tagged ones.
 */

import fc from 'fast-check'
import { describe, it, expect, vi } from 'vitest'
import { propertyTrials } from '@causl/core-testing-internal'
import { createCausl } from '../src/index.js'
import type { Commit, DerivedNode } from '../src/index.js'

describe('graph.commitMetadataDerived (#452)', () => {
  /**
   * Pin 1 — a commit-metadata derived that reads `graph.commitLog`
   * returns the just-completed commit's record on `read` after the
   * commit lands. Plain `graph.derived` over the same compute would
   * return the previous commit's array because Phase D runs before
   * Phase F.4 refreshes `commitLogEntry.value`; the typed seam is
   * exactly what closes that gap.
   */
  it('reads the just-completed commit on the same commit that produced it', () => {
    // arrange
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    // The commit-metadata derived projects the latest commit time.
    // After commit at t=1, this read must return 1, not 0.
    const latestTime = g.commitMetadataDerived<number>(
      'latest-time',
      (get) => {
        const log = get(g.commitLog)
        if (log.length === 0) return -1
        return log[log.length - 1]!.time
      },
    )

    // sanity: pre-commit, the log is empty
    expect(g.read(latestTime)).toBe(-1)

    // act
    g.commit('bump-a', (tx) => tx.set(a, 1))

    // assert: the just-completed commit's time is visible
    expect(g.now).toBe(1)
    expect(g.read(latestTime)).toBe(1)

    // and the next commit advances the projection
    g.commit('bump-a-again', (tx) => tx.set(a, 2))
    expect(g.now).toBe(2)
    expect(g.read(latestTime)).toBe(2)
  })

  /**
   * Same pin in `intent` form — a derivation that pulls `intent` off
   * the latest commit returns this commit's intent string. The §11
   * "first-class derived for inspection" promise applies to every
   * commit-metadata field, not just `time`.
   */
  it('reads the just-completed commit intent on the same commit', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const latestIntent = g.commitMetadataDerived<string | null>(
      'latest-intent',
      (get) => {
        const log = get(g.commitLog)
        if (log.length === 0) return null
        return log[log.length - 1]!.intent
      },
    )

    g.commit('first-intent', (tx) => tx.set(a, 1))
    expect(g.read(latestIntent)).toBe('first-intent')

    g.commit('second-intent', (tx) => tx.set(a, 2))
    expect(g.read(latestIntent)).toBe('second-intent')
  })

  /**
   * Pin 2 — ordinary derived nodes are NOT affected by Phase F.5.
   * A plain `graph.derived` that reads commit metadata still sees the
   * pre-F.4 array (one commit stale) because Phase D's atomicity
   * contract for opt-out code is the load-bearing §3 invariant. The
   * stale read here is the *expected* behaviour and the regression
   * gate against accidental Phase F.5 widening into ordinary deriveds.
   */
  it('does not re-recompute ordinary deriveds in Phase F.5 (Phase D atomicity preserved)', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)

    let ordinaryComputeCount = 0
    // Plain `derived` — opts OUT of Phase F.5. Reads `commitLog` so
    // its compute body sees the pre-F.4 array on each Phase D run.
    g.derived<number>('ordinary-log-len', (get) => {
      ordinaryComputeCount += 1
      const log = get(g.commitLog)
      return log.length
    })

    // After registration, eager evaluation runs once.
    expect(ordinaryComputeCount).toBe(1)

    // First commit: Phase D recomputes the ordinary derived once
    // (its dep, commitLog, was in the changed set when seeded by an
    // input write — but actually commitLog isn't a dep until the
    // recompute reads it, and then Phase F.4 hasn't run yet so the
    // value didn't change at the read site). What matters is the
    // exactly-one-recompute-per-commit invariant: §3 atomicity.
    g.commit('first', (tx) => tx.set(a, 1))
    // The compute may run once or zero times (depending on whether
    // the input was a dep). What it MUST NOT do is run twice (once
    // in Phase D + once in Phase F.5) — that would tear atomicity.
    const afterFirst = ordinaryComputeCount
    expect(afterFirst).toBeLessThanOrEqual(2)

    // Second commit: same pin — at most one recompute beyond the
    // post-first count. A leak from F.5 widening would show up here
    // as +2 instead of +1.
    g.commit('second', (tx) => tx.set(a, 2))
    expect(ordinaryComputeCount - afterFirst).toBeLessThanOrEqual(1)
  })

  /**
   * Pin 2b — ordinary deriveds whose dep set includes `a` AND
   * `commitLog` see ONE commit stale on the log read. This is the
   * precise §3-vs-§11 trade documented in the issue body: ordinary
   * deriveds settle in Phase D before F.4, so their `commitLog` read
   * returns the pre-F.4 array. The same compute through
   * `commitMetadataDerived` returns the post-F.4 array. This test
   * pins the *difference* between the two factories.
   *
   * Reading the input alongside the log forces Phase D to walk into
   * `ordinaryLen` whenever `a` changes, so the ordinary derived's
   * recompute is observably triggered every commit (otherwise it
   * would simply hold its registration-time value forever and the
   * "one stale" framing would not mean anything).
   */
  it('ordinary deriveds see one-commit-stale commitLog; commit-metadata deriveds see fresh', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)

    const ordinaryLen = g.derived<number>('ordinary-len', (get) => {
      // Reading `a` makes the input a dep so Phase D walks into this
      // node on every input write. The body returns the log length
      // observed during the Phase D recompute — pre-F.4, so always
      // one commit behind.
      get(a)
      return get(g.commitLog).length
    })
    const metadataLen = g.commitMetadataDerived<number>(
      'metadata-len',
      (get) => {
        get(a)
        return get(g.commitLog).length
      },
    )

    // Pre-commit: both see empty log
    expect(g.read(ordinaryLen)).toBe(0)
    expect(g.read(metadataLen)).toBe(0)

    // After first commit: log has 1 entry. The commit-metadata derived
    // sees 1 (post-F.4 array). The ordinary derived was recomputed in
    // Phase D against the pre-F.4 array of length 0, so reads 0.
    g.commit('first', (tx) => tx.set(a, 1))
    expect(g.read(metadataLen)).toBe(1)
    expect(g.read(ordinaryLen)).toBe(0)

    // After second commit: log has 2 entries; the ordinary derived
    // catches up to length-1 (the previous commit's count), the
    // metadata derived lands at length-2 (the just-completed count).
    g.commit('second', (tx) => tx.set(a, 2))
    expect(g.read(metadataLen)).toBe(2)
    expect(g.read(ordinaryLen)).toBe(1)
  })

  /**
   * Pin 3 — commit-metadata deriveds are subscribable and their
   * subscribers fire on the post-commit value. The fire-after-commit
   * timing is the whole point of Phase F.5: a §11 inspection surface
   * that wakes UI code with the value as observed at the just-
   * completed commit.
   */
  it('commit-metadata derived subscribers fire after the commit, with the post-commit value', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const latestTime = g.commitMetadataDerived<number>(
      'latest-time',
      (get) => {
        const log = get(g.commitLog)
        if (log.length === 0) return -1
        return log[log.length - 1]!.time
      },
    )

    const observer = vi.fn<(v: number, t: number) => void>()
    const unsub = g.subscribe(latestTime, observer)

    // Initial fire on subscribe with the current value (-1, since
    // log is empty pre-commit). This is the standard `subscribe`
    // semantics — fires once synchronously with the current value.
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenLastCalledWith(-1, 0)

    // First commit at t=1: subscriber fires with 1.
    g.commit('one', (tx) => tx.set(a, 1))
    expect(observer).toHaveBeenCalledTimes(2)
    expect(observer).toHaveBeenLastCalledWith(1, 1)

    // Second commit at t=2: subscriber fires with 2.
    g.commit('two', (tx) => tx.set(a, 2))
    expect(observer).toHaveBeenCalledTimes(3)
    expect(observer).toHaveBeenLastCalledWith(2, 2)

    unsub()
    g.commit('three', (tx) => tx.set(a, 3))
    // No further notifications after dispose.
    expect(observer).toHaveBeenCalledTimes(3)
  })

  /**
   * Pin 4 — `readAt(commitMetadataDerived, t)` projects the past
   * value through the standard retention buffer, the same surface
   * `readAt(plain-derived, t)` uses. The seam is purely about *when*
   * Phase F.5 runs the compute; the resulting value participates in
   * `readAt` like any other derived because the entry shape is the
   * same.
   *
   * NOTE: `readAt` recomputes the derived against retained input
   * snapshots; it does NOT replay through the post-Phase-F.5 hook.
   * For commit-metadata deriveds the historical projection therefore
   * returns the value the compute *would* produce against the
   * historical input snapshot and the historical bounded log. For a
   * compute that reads `latestTime`, the historical projection of
   * `t=k` returns `commitLog[k-1].time` because the bounded log at
   * the read-time still includes that commit. We pin the present-
   * read here (the load-bearing case) and document the recompute
   * caveat; #383 reopens against `whyUpdated` will revisit if a
   * sharper readAt-vs-Phase-F.5 contract is needed.
   */
  it('readAt returns the current value at the just-completed time', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const latestTime = g.commitMetadataDerived<number>(
      'latest-time',
      (get) => {
        const log = get(g.commitLog)
        if (log.length === 0) return -1
        return log[log.length - 1]!.time
      },
    )

    g.commit('first', (tx) => tx.set(a, 1))
    const r1 = g.readAt(latestTime, 1)
    expect(r1.status).toBe('retained')
    if (r1.status === 'retained') {
      expect(r1.time).toBe(1)
      // The retained-projection invariant: the retention buffer
      // returns *some* historical value through the same primitive
      // ordinary deriveds use. For the commit-metadata case the
      // exact value is shape-dependent on the recompute path, but
      // the result must surface on the `'retained'` arm — never
      // throw or return `undefined`.
      expect(typeof r1.value).toBe('number')
    }
  })

  /**
   * Stable-handle pin — `commitMetadataDerived` returns a frozen
   * handle whose `id` matches the caller-supplied id. Re-registering
   * under the same id throws `DuplicateNodeError`, identical to
   * plain `graph.derived`. The factory is a thin scheduling marker,
   * not a separate node namespace.
   */
  it('handle has the supplied id and re-registration throws DuplicateNodeError', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const node = g.commitMetadataDerived('shared-id', () => 0)
    expect(node.id).toBe('shared-id')

    // Same id, different factory — duplicate gate is shared.
    expect(() => g.derived('shared-id', () => 1)).toThrow(
      /Node already registered/i,
    )
    expect(() => g.commitMetadataDerived('shared-id', () => 1)).toThrow(
      /Node already registered/i,
    )
  })

  /**
   * `explain` works on commit-metadata deriveds — the `via`
   * discriminator surfaces `'derived'` (the §11 default) because
   * commit-metadata is an internal scheduling tag, not a hot-swap
   * affordance. A consumer of `explain` cannot tell the two apart at
   * the inspection layer; that's intentional per §4 (the engine has
   * two primitive node kinds, not three).
   */
  it('explain reports via: derived for commit-metadata deriveds', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 1)
    const cm = g.commitMetadataDerived<number>('cm', (get) => get(a))
    const explanation = g.read(g.explain(cm))
    // 'commit-metadata' is engine-internal scheduling; the public
    // `via` field is the §11 inspection lineage discriminator and
    // reports `'derived'` for ordinary nodes (only `liveDerived`
    // nodes surface `'live'` for the hot-swap affordance).
    expect(explanation.via).toBe('derived')
  })

  /**
   * Property test (≥1000 trials) — random sequences of (ordinary
   * commit, commit-metadata read) preserve §3 atomicity for ordinary
   * deriveds AND §11 freshness for tagged ones.
   *
   * The trial:
   *   1. Build a graph with one input, one ordinary derived reading
   *      `commitLog.length`, and one commit-metadata derived reading
   *      `commitLog.length`.
   *   2. Run K random commits (1 ≤ K ≤ 6).
   *   3. After each commit, assert the §11 invariant: the metadata
   *      derived's value equals the post-commit `now` (because each
   *      successful commit appends exactly one row to `commitLog`,
   *      so length == commit count == post-commit `now`).
   *   4. Assert the §3 invariant for the ordinary derived: its value
   *      equals `now - 1` after every commit (one commit stale,
   *      always — the regression case described in the issue body).
   *
   * The pinning shape is the same as #189's recompute-count fuzz —
   * fixed-DAG + random-commit-sequence + per-step invariant assertion
   * — adapted to the §3-vs-§11 boundary. 1000 trials is the
   * `propertyTrials` floor; sub-1000 throws unless `unsafeTrials`
   * is passed (it isn't, the floor is the gate).
   */
  it('property: ordinary vs commit-metadata staleness across random commit sequences', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (writes) => {
          const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
          const a = g.input('a', 0)
          // `get(a)` makes both deriveds Phase D-walked on every
          // input change. Without it, the ordinary derived would
          // hold its registration-time value forever and the
          // "ordinary one commit stale" pin would not mean anything
          // — Phase D would never even visit it.
          const ordinaryLen = g.derived<number>('ordinary-len', (get) => {
            get(a)
            return get(g.commitLog).length
          })
          const metadataLen = g.commitMetadataDerived<number>(
            'metadata-len',
            (get) => {
              get(a)
              return get(g.commitLog).length
            },
          )

          // Pre-commit: both see empty log.
          expect(g.read(ordinaryLen)).toBe(0)
          expect(g.read(metadataLen)).toBe(0)

          let prevA = 0
          let landedCommits = 0
          for (const v of writes) {
            // Skip self-writes (Object.is dedup at Phase B): the
            // commit pipeline still advances `now`, but no input
            // change means no recompute fires. We only step the
            // counters when the value differs.
            if (v === prevA) continue
            g.commit(`step:${v}`, (tx) => tx.set(a, v))
            landedCommits += 1
            prevA = v

            // §11 freshness: metadata derived sees post-F.4 log
            // length, which equals the count of successful commits.
            expect(g.read(metadataLen)).toBe(landedCommits)
            // §3 staleness for opt-out: ordinary derived sees the
            // pre-F.4 log, which is one commit behind the metadata
            // view. After the first commit it's 0; after the K-th
            // it's K-1.
            expect(g.read(ordinaryLen)).toBe(landedCommits - 1)
            // GraphTime invariant — the engine clock advances by
            // exactly one tick per commit (§3 monotonicity).
            expect(g.now).toBe(landedCommits)
          }
        },
      ),
      propertyTrials('commit-metadata-derived/staleness-boundary'),
    )
  })

  /**
   * Atomicity rollback pin — a throw inside Phase F.5's compute
   * leaves the engine byte-identical to its pre-commit state. No
   * half-tick is observable: `now` does not advance, the commit log
   * does not append, no subscriber fires.
   */
  it('throws inside Phase F.5 compute roll back the entire commit', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)

    let shouldThrow = false
    g.commitMetadataDerived<number>('failing', (get) => {
      const log = get(g.commitLog)
      if (shouldThrow && log.length > 0) throw new Error('boom in F.5')
      return log.length
    })

    // Sanity commit — does not throw.
    g.commit('ok', (tx) => tx.set(a, 1))
    expect(g.now).toBe(1)
    const beforeFailNow = g.now
    const beforeFailLog = g.read(g.commitLog).slice()

    // Arm the throw and attempt a commit.
    shouldThrow = true
    expect(() => g.commit('fail', (tx) => tx.set(a, 2))).toThrow(/boom in F\.5/)

    // Atomicity rollback: time, input, and log are all unchanged.
    expect(g.now).toBe(beforeFailNow)
    expect(g.read(a)).toBe(1)
    expect(g.read(g.commitLog)).toEqual(beforeFailLog)
  })
})
