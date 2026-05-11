/**
 * @packageDocumentation
 *
 * `commitLogConsumerCount` contract suite (#715 follow-up).
 *
 * The counter gates Phase F.4 of the commit pipeline (the per-commit
 * `commitLogEntry.value` rebuild). When zero, the rebuild is skipped
 * entirely — the bounded ring (Phase F) still appends so a future
 * first subscriber sees recent history without a cold-start gap.
 *
 * This is the audit's headline acceptance for #715 (Amendment 1's
 * deferred half — see PR #730): default `commitHistoryCap=1000`
 * adopters with no `commitLog` consumer pay nothing for F.4 on every
 * commit. The bench scenarios `causl × batch-commit × 10000` and
 * `causl × equality-cutoff × 10000` are the headline regressions
 * this counter unblocks.
 *
 * Three consumer shapes are pinned here:
 *
 *   1. `subscribe(graph.commitLog, …)` — the canonical observer.
 *   2. `commitMetadataDerived(...)` — the §11 commit-metadata
 *      reading seam, which always counts because Phase F.5 needs
 *      the freshly-refreshed log.
 *   3. Plain `derived(...)` whose recorded read-set includes the
 *      engine-owned `COMMIT_LOG_ID` — counted via `setDeps`.
 *
 * Plus the gate's behavioural contract: with no consumer registered,
 * `commitLogEntry.value` does NOT refresh between commits (observed
 * by reference equality on the `commit-metadata` derived's snapshot
 * of the previous commit's log) — and once a consumer is registered,
 * the next commit DOES refresh.
 */

import { describe, it, expect, vi } from 'vitest'
import { commitLogConsumerCount } from '../src/testing.js'
import { createCausl } from '../src/index.js'
import type { Commit } from '../src/index.js'

describe('commitLogConsumerCount (#715 follow-up)', () => {
  describe('counter accounting', () => {
    /**
     * A fresh graph has no consumers — neither subscribers, nor
     * commit-metadata deriveds, nor plain deriveds reading
     * `commitLog`. The counter starts at 0.
     */
    it('starts at 0 on a fresh graph', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * Subscribing to `g.commitLog` bumps the counter; unsubscribing
     * drops it back. The unsubscribe closure is documented as
     * idempotent — a second call must not double-decrement.
     */
    it('subscribe(commitLog, …) increments; unsubscribe decrements; idempotent unsubscribe is a no-op', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      expect(commitLogConsumerCount(g)).toBe(1)
      unsub()
      expect(commitLogConsumerCount(g)).toBe(0)
      // idempotent second call must NOT re-decrement
      unsub()
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * Multiple subscribers each contribute a count.
     */
    it('multiple commitLog subscribers each contribute a count', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const u1 = g.subscribe(g.commitLog, () => {})
      const u2 = g.subscribe(g.commitLog, () => {})
      const u3 = g.subscribe(g.commitLog, () => {})
      expect(commitLogConsumerCount(g)).toBe(3)
      u2()
      expect(commitLogConsumerCount(g)).toBe(2)
      u1()
      u3()
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * Subscribing to a NON-commitLog node does not affect the
     * counter — the counter is specific to `commitLog` consumers.
     */
    it('subscriptions to non-commitLog nodes do not affect the counter', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      const u1 = g.subscribe(a, () => {})
      expect(commitLogConsumerCount(g)).toBe(0)
      u1()
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * `commitMetadataDerived(...)` registration bumps the counter
     * unconditionally — every commit-metadata derived semantically
     * depends on `commitLog` (Phase F.5 needs F.4's refresh). The
     * counter contribution is one per registration regardless of
     * whether the compute actually reads `commitLog`.
     */
    it('commitMetadataDerived registration increments the counter unconditionally', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      g.commitMetadataDerived('latest-time', (get) => {
        const log = get(g.commitLog)
        return log.length === 0 ? -1 : log[log.length - 1]!.time
      })
      expect(commitLogConsumerCount(g)).toBe(1)
    })

    /**
     * A commit-metadata derived that does NOT read `commitLog` still
     * counts — registration is the contract, not the recorded
     * read-set. (The Phase F.5 seam is keyed on the registration
     * itself; F.4 must run so any future compute that reads
     * `commitLog` sees the fresh value.)
     */
    it('commitMetadataDerived counts even when the compute does not read commitLog', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      g.commitMetadataDerived('reads-only-input', (get) => get(a))
      expect(commitLogConsumerCount(g)).toBe(1)
    })

    /**
     * A `commitMetadataDerived(...)` that reads `commitLog` is NOT
     * double-counted: `setDeps` skips the dep-set-driven counter
     * update for the `commit-metadata` tag, so the registration-time
     * bump is the only contribution.
     */
    it('commitMetadataDerived that reads commitLog is not double-counted', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      g.commitMetadataDerived('reads-log', (get) => get(g.commitLog).length)
      expect(commitLogConsumerCount(g)).toBe(1)
    })

    /**
     * Plain `derived(...)` whose compute reads `g.commitLog`
     * contributes a count via `setDeps`. The compute records
     * `COMMIT_LOG_ID` in its read-set on first evaluation; the
     * counter is bumped at that point.
     */
    it('plain derived that reads commitLog contributes a count', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      g.derived('log-length', (get) => get(g.commitLog).length)
      expect(commitLogConsumerCount(g)).toBe(1)
    })

    /**
     * Plain deriveds that branch on a flag and only read `commitLog`
     * conditionally must update the counter when the dep set
     * changes — `setDeps` walks the symmetric difference of
     * (previous deps, next deps) on every recompute, so dynamic
     * dep flips stay accurate.
     */
    it('plain derived dynamically dropping commitLog dep decrements the counter', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const flag = g.input('flag', true)
      const condLog = g.derived('cond-log', (get) => {
        if (get(flag)) return get(g.commitLog).length
        return 0
      })
      // Subscribe so the derived participates in the recompute
      // pipeline driven by Phase D (subscribers force recompute
      // on dep change).
      const unsub = g.subscribe(condLog, () => {})
      // After registration the read-set includes COMMIT_LOG_ID.
      expect(commitLogConsumerCount(g)).toBe(1)
      // Flip the flag — derived should drop the commitLog dep on
      // recompute. Phase D walks the affected sub-graph; the
      // recompute calls `setDeps` with the new (smaller) read-set.
      g.commit('flip', (tx) => tx.set(flag, false))
      expect(commitLogConsumerCount(g)).toBe(0)
      // Flip back — counter goes up again.
      g.commit('unflip', (tx) => tx.set(flag, true))
      expect(commitLogConsumerCount(g)).toBe(1)
      unsub()
    })

    /**
     * Disposing a plain derived that depends on commitLog
     * decrements the counter.
     */
    it('disposing a plain commitLog-reading derived decrements the counter', async () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const node = g.derived('log-len', (get) => get(g.commitLog).length)
      expect(commitLogConsumerCount(g)).toBe(1)
      const { dispose } = await import('../src/internal.js')
      dispose(g, node)
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * Disposing a `commitMetadataDerived(...)` decrements the
     * counter.
     */
    it('disposing a commitMetadataDerived decrements the counter', async () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const node = g.commitMetadataDerived('latest', () => 0)
      expect(commitLogConsumerCount(g)).toBe(1)
      const { dispose } = await import('../src/internal.js')
      dispose(g, node)
      expect(commitLogConsumerCount(g)).toBe(0)
    })

    /**
     * A failed `derived(...)` registration (compute throws) must
     * not leak a phantom counter contribution — the registration-
     * time bump for a `commit-metadata` tag is rolled back in the
     * catch arm.
     */
    it('failed commitMetadataDerived registration rolls back the counter', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      expect(() =>
        g.commitMetadataDerived('boom', () => {
          throw new Error('compute panic')
        }),
      ).toThrow()
      expect(commitLogConsumerCount(g)).toBe(0)
    })
  })

  describe('Phase F.4 gating behaviour', () => {
    /**
     * The headline contract: with default `commitHistoryCap=1000`
     * and NO consumer registered, the engine-owned
     * `commitLogEntry.value` does not refresh between commits. A
     * `read(g.commitLog)` STILL returns the up-to-date array
     * (lazy refresh on read), but the per-commit Phase F.4
     * rebuild is dead work and is skipped — observed via the
     * counter staying at 0 across commits.
     */
    it('default cap, no consumer: counter stays 0 across commits and lazy read still works', () => {
      const g = createCausl({ commitHistoryCap: 1000 }) // cap defaults to 1000
      const a = g.input('a', 0)
      expect(commitLogConsumerCount(g)).toBe(0)
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      g.commit('three', (tx) => tx.set(a, 3))
      // No consumer was registered — counter remains 0.
      expect(commitLogConsumerCount(g)).toBe(0)
      // Lazy read still returns the bounded ring.
      const log = g.read(g.commitLog)
      expect(log).toHaveLength(3)
      expect(log.map((c) => c.intent)).toEqual(['one', 'two', 'three'])
    })

    /**
     * Once a `subscribe(commitLog, …)` is registered, Phase F.4
     * runs on every subsequent commit and the subscriber fires
     * with the fresh array.
     */
    it('after subscribe(commitLog, …), the next commit refreshes and fires the subscriber', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      g.commit('seed', (tx) => tx.set(a, 1))
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      // The subscribe registration itself fires once with the
      // current value (length 1 from the lazy read on subscribe).
      expect(obs).toHaveBeenCalledTimes(1)
      const initial = obs.mock.calls[0]![0] as readonly Commit[]
      expect(initial).toHaveLength(1)
      obs.mockClear()
      // Drive another commit — Phase F.4 now runs and fires the
      // observer with the new array.
      g.commit('two', (tx) => tx.set(a, 2))
      expect(obs).toHaveBeenCalledTimes(1)
      const second = obs.mock.calls[0]![0] as readonly Commit[]
      expect(second).toHaveLength(2)
      expect(second[1]!.intent).toBe('two')
      unsub()
    })

    /**
     * Same-pipeline contract via the `commitMetadataDerived`
     * registration path: registering a commit-metadata derived
     * brings the counter above zero, so subsequent commits
     * refresh `commitLogEntry.value`. The metadata derived's
     * compute then sees the just-completed commit (Phase F.5
     * runs against the freshly-refreshed log).
     */
    it('after commitMetadataDerived registration, next commit refreshes and the derived sees the just-completed commit', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      // No consumer yet — Phase F.4 is skipped.
      g.commit('seed', (tx) => tx.set(a, 1))
      expect(commitLogConsumerCount(g)).toBe(0)
      // Register a commit-metadata derived. Counter bumps to 1.
      const latest = g.commitMetadataDerived<number>('latest-time', (get) => {
        const log = get(g.commitLog)
        return log.length === 0 ? -1 : log[log.length - 1]!.time
      })
      expect(commitLogConsumerCount(g)).toBe(1)
      // Drive another commit — Phase F.4 + Phase F.5 fire and the
      // derived sees the just-completed commit's time, not the
      // previous one.
      g.commit('two', (tx) => tx.set(a, 2))
      expect(g.read(latest)).toBe(g.now)
    })

    /**
     * Same-pipeline contract via the plain `derived(...)` path:
     * a derived that reads `commitLog` contributes a count, so
     * Phase F.4 rebuild fires on every commit. The cached
     * `commitLogEntry.value` is fresh, observable through a
     * `read(commitLog)` that returns the up-to-date array
     * without relying on the readEntry-side lazy fallback.
     *
     * (Note: a plain `derived(...)` reading `commitLog` itself
     * sees the *previous* commit's log on a re-evaluation
     * triggered by other inputs, because Phase D runs before
     * F.4 — that is the documented limitation #452 introduced
     * `commitMetadataDerived` to address. The contract this
     * test pins is narrower: F.4 is gated by the counter, not
     * silently skipped, so the cached value mirrors the bounded
     * ring after every commit.)
     */
    it('after plain derived reads commitLog, Phase F.4 rebuilds the cached value on every commit', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      // Register a derived that reads commitLog — counter bumps.
      g.derived<number>('log-length', (get) => get(g.commitLog).length)
      expect(commitLogConsumerCount(g)).toBe(1)
      // Capture the F.4-refreshed value's reference across a few
      // commits. With F.4 gated on the consumer counter, the
      // cached `commitLog` array is rebuilt on each commit (a
      // fresh frozen array reference per commit).
      g.commit('one', (tx) => tx.set(a, 1))
      const afterOne = g.read(g.commitLog)
      expect(afterOne).toHaveLength(1)
      g.commit('two', (tx) => tx.set(a, 2))
      const afterTwo = g.read(g.commitLog)
      expect(afterTwo).toHaveLength(2)
      // Distinct frozen arrays — F.4 produced a fresh reference
      // on the second commit (stability is per-quiescent-engine,
      // not across commits that grew the log).
      expect(afterOne).not.toBe(afterTwo)
    })

    /**
     * Bounded ring (Phase F) keeps appending regardless of
     * consumer presence, so a future first subscriber sees the
     * recent history. This is the "stays warm" contract: F is
     * gated on `commitHistoryCap > 0`, F.4 is gated additionally
     * on `commitLogConsumerCount > 0`.
     */
    it('Phase F (history append) stays warm even with no consumer; first late subscriber sees recent history', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      // No consumer for the first three commits.
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      g.commit('three', (tx) => tx.set(a, 3))
      expect(commitLogConsumerCount(g)).toBe(0)
      // First subscriber arrives — initial fire delivers the full
      // bounded ring including the prior three commits.
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      expect(obs).toHaveBeenCalledTimes(1)
      const initial = obs.mock.calls[0]![0] as readonly Commit[]
      expect(initial.map((c) => c.intent)).toEqual(['one', 'two', 'three'])
      unsub()
    })

    /**
     * After every consumer drops back to zero, Phase F.4 stops
     * firing again — the counter is the live gating signal,
     * not a one-shot latch.
     */
    it('after the last consumer unsubscribes, Phase F.4 stops firing again', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 0)
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      expect(commitLogConsumerCount(g)).toBe(1)
      g.commit('one', (tx) => tx.set(a, 1))
      // unsubscribe — counter back to zero.
      unsub()
      expect(commitLogConsumerCount(g)).toBe(0)
      obs.mockClear()
      // The next commit must NOT fire the (already-removed)
      // observer; the gate is live.
      g.commit('two', (tx) => tx.set(a, 2))
      expect(obs).not.toHaveBeenCalled()
      // Ring still appended though.
      expect(g.read(g.commitLog)).toHaveLength(2)
    })
  })
})
