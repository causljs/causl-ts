/**
 * @packageDocumentation
 *
 * Behavioural contract for `graph.stats()` (#757) — the JS-side first
 * cut of the engine-wide retained-state telemetry surface flagged by
 * the #695 wasm-cluster audit and consumed by the
 * `subscriber-churn-1k` bench scenario (#733/#738) as its end-of-run
 * leak gate.
 *
 * Each clause pins one column of {@link EngineTelemetry}:
 *
 *   1. Default state — every counter at the genesis value.
 *   2. Subscribe + unsubscribe round-trip drains
 *      `subscribersTotal` to zero — the leak gate the bench scenario
 *      asserts on.
 *   3. `commitMetadataDerived` registration bumps
 *      `commitMetadataDeriveds`; disposal would drain it (covered by
 *      the dispose suite — here we only pin the increment).
 *   4. A 30-tick subscriber-churn loop (mount/unmount fan paired) ends
 *      with `subscribersTotal` exactly equal to the active-only
 *      residual, proving the per-node index does not pin entries past
 *      their dispose closure.
 *
 * The shape of the returned object is frozen (the type guarantees it);
 * we additionally pin field-by-field equality on a snapshot record so a
 * future widening of the surface lands at the tail rather than
 * silently reordering existing keys.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'
import type { EngineTelemetry } from '../src/index.js'

describe('graph.stats() — engine telemetry surface (#757)', () => {
  describe('default state on a fresh graph', () => {
    /**
     * A graph constructed with default options has no user-registered
     * nodes, no subscribers, no commit-metadata deriveds, and an empty
     * commit-history ring. The `entries` count is 1 because the
     * engine-owned `commitLog` derived is registered at genesis.
     * `commitLogConsumerCount` is 0 because nothing yet consumes the
     * log. With the post-#778 default of `commitHistoryCap=0`, the
     * history starts (and stays) at length 0.
     */
    it('returns the genesis-shape record on a freshly-created graph', () => {
      const g = createCausl()
      const s = g.stats()

      // #696 — node-cardinality fields. No user-registered nodes yet.
      expect(s.inputs).toBe(0)
      expect(s.deriveds).toBe(0)
      expect(s.subscribersTotal).toBe(0)
      expect(s.subscribersByNodeKeys).toBe(0)
      expect(s.transientSubscribers).toBe(0)
      expect(s.commitObservers).toBe(0)
      expect(s.commitMetadataDeriveds).toBe(0)
      expect(s.commitLogConsumerCount).toBe(0)
      // Engine-owned `commitLog` is the sole genesis entry.
      expect(s.entries).toBe(1)
      // #696 — `lastCommitTime` is GraphTime 0 at engine genesis.
      expect(s.lastCommitTime).toBe(0)
      expect(s.retainedCommits).toBe(0)
      // #696 — optional engine-status fields are absent on the TS
      // backend (the canonical engine does not wire `--trace-deopt`
      // into retained state at runtime; the bench harness captures
      // these externally — see
      // `packages/bench/report/engine-status-deopts/SUMMARY.md`).
      expect(s.deopts).toBeUndefined()
      expect(s.gcPauses).toBeUndefined()
    })

    /**
     * Registering an input bumps `entries` by 1 and leaves every other
     * counter alone — a pure namespace operation, not a subscription
     * or a commit.
     */
    it('input() registration bumps `entries` and `inputs` only', () => {
      const g = createCausl()
      g.input('cell:a', 0)
      const s = g.stats()
      expect(s.entries).toBe(2)
      // #696 — input registration bumps the per-kind counter.
      expect(s.inputs).toBe(1)
      expect(s.deriveds).toBe(0)
      expect(s.subscribersTotal).toBe(0)
      expect(s.subscribersByNodeKeys).toBe(0)
      expect(s.transientSubscribers).toBe(0)
      expect(s.commitObservers).toBe(0)
      expect(s.commitMetadataDeriveds).toBe(0)
      expect(s.commitLogConsumerCount).toBe(0)
      expect(s.lastCommitTime).toBe(0)
      expect(s.retainedCommits).toBe(0)
    })

    /**
     * Calling `stats()` twice returns two distinct objects (no shared
     * mutable reference) carrying identical counts. The function is
     * pure and the snapshot is owned by the caller.
     */
    it('returns a fresh object on each call (no shared reference)', () => {
      const g = createCausl()
      const s1 = g.stats()
      const s2 = g.stats()
      expect(s1).not.toBe(s2)
      expect(s1).toEqual(s2)
    })
  })

  describe('subscribe + unsubscribe leak gate', () => {
    /**
     * The headline contract: every `subscribe(node, observer)` call
     * must have a matching `unsubscribe()` that drains both the flat
     * `subscriptions` Set and the per-node `subscriptionsByNode`
     * index. The `subscriber-churn-1k` bench scenario asserts this
     * exact shape end-of-run; this test pins it on a tiny graph so a
     * regression surfaces here rather than only under the bench
     * harness.
     */
    it('drains subscribersTotal to 0 after subscribe/unsubscribe round-trip', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)

      const u = g.subscribe(a, () => {})
      const mid = g.stats()
      expect(mid.subscribersTotal).toBe(1)
      expect(mid.subscribersByNodeKeys).toBe(1)

      u()
      const after = g.stats()
      expect(after.subscribersTotal).toBe(0)
      expect(after.subscribersByNodeKeys).toBe(0)
    })

    /**
     * Two subscribers on the same node count as 2 in
     * `subscribersTotal` but as 1 in `subscribersByNodeKeys` — the
     * latter counts distinct nodes with at least one subscriber.
     * Unsubscribing both drains both counters to zero.
     */
    it('two subscribers on one node: total=2, byNodeKeys=1; both drain to 0', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      const u1 = g.subscribe(a, () => {})
      const u2 = g.subscribe(a, () => {})
      const mid = g.stats()
      expect(mid.subscribersTotal).toBe(2)
      expect(mid.subscribersByNodeKeys).toBe(1)
      u1()
      u2()
      const after = g.stats()
      expect(after.subscribersTotal).toBe(0)
      expect(after.subscribersByNodeKeys).toBe(0)
    })

    /**
     * `subscribeCommits` registrations land in a separate observer
     * Set surfaced through the `commitObservers` counter; they do
     * NOT bump `subscribersTotal` (that counter is per-node only).
     */
    it('subscribeCommits increments commitObservers; unsubscribe drains', () => {
      const g = createCausl()
      const u = g.subscribeCommits(() => {})
      expect(g.stats().commitObservers).toBe(1)
      expect(g.stats().subscribersTotal).toBe(0)
      u()
      expect(g.stats().commitObservers).toBe(0)
    })
  })

  describe('commitMetadataDerived registration', () => {
    /**
     * Registering a `commitMetadataDerived` bumps both
     * `commitMetadataDeriveds` (the seed set Phase F.5 walks) and
     * `commitLogConsumerCount` (the F.4 gate — every commit-metadata
     * derived needs the freshly-refreshed log on the same commit it
     * was produced).
     */
    it('commitMetadataDerived bumps commitMetadataDeriveds and commitLogConsumerCount', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      const before = g.stats()
      expect(before.commitMetadataDeriveds).toBe(0)
      expect(before.commitLogConsumerCount).toBe(0)

      g.commitMetadataDerived('meta:latest', (get) => {
        const log = get(g.commitLog)
        return log[log.length - 1] ?? null
      })

      const after = g.stats()
      expect(after.commitMetadataDeriveds).toBe(1)
      expect(after.commitLogConsumerCount).toBe(1)
      // Bumped `entries` too (every registration adds an id).
      expect(after.entries).toBe(before.entries + 1)
    })
  })

  describe('subscriber-churn drain', () => {
    /**
     * 30 ticks of paired mount/unmount: each tick mounts 10 fresh
     * subscribers and disposes 10 from the front of the FIFO queue
     * (after the first tick, when the queue has filled). The harness
     * matches the per-tick shape `runSubscriberChurn` runs at scale
     * 1000 — here scaled down so the unit test stays fast.
     *
     * End-of-run, after draining the residual queue, every subscribe
     * has its matching dispose closure called: `subscribersTotal`
     * must be exactly 0. A non-zero residual is a leak — the bench
     * scenario raises on it; this test pins it as a unit-level
     * regression gate.
     */
    it('30 ticks of mount/unmount drain subscribersTotal to 0', () => {
      const g = createCausl()
      const NODE_COUNT = 20
      const PER_TICK = 10
      const TICKS = 30
      const inputs = Array.from({ length: NODE_COUNT }, (_, i) =>
        g.input(`sc:${i}`, 0),
      )
      const active: Array<() => void> = []

      for (let t = 0; t < TICKS; t++) {
        // Mount PER_TICK fresh subscribers, round-robin over nodes.
        for (let m = 0; m < PER_TICK; m++) {
          const n = inputs[(t * PER_TICK + m) % NODE_COUNT]!
          active.push(g.subscribe(n, () => {}))
        }
        // Unmount the oldest PER_TICK (or fewer on the first tick).
        const drop = Math.min(active.length, PER_TICK)
        for (let d = 0; d < drop; d++) {
          active.shift()!()
        }
      }

      // Drain whatever remains so the leak gate sees a clean slate.
      for (const dispose of active) dispose()

      const after = g.stats()
      expect(after.subscribersTotal).toBe(0)
      expect(after.subscribersByNodeKeys).toBe(0)
    })

    /**
     * Variant: 30 ticks where 5 of the per-tick mounts are kept
     * across the whole run (active-only residual). End-of-run,
     * `subscribersTotal` equals exactly the residual count, with
     * `subscribersByNodeKeys` ≤ residual (when multiple residuals
     * landed on the same node).
     */
    it('30 ticks with 5 active-only residuals: count drains to active-only', () => {
      const g = createCausl()
      const NODE_COUNT = 20
      const PER_TICK = 10
      const TICKS = 30
      const RESIDUAL = 5
      const inputs = Array.from({ length: NODE_COUNT }, (_, i) =>
        g.input(`sc:${i}`, 0),
      )
      const churn: Array<() => void> = []
      const residuals: Array<() => void> = []

      // Lock in 5 residuals up front, on distinct nodes.
      for (let r = 0; r < RESIDUAL; r++) {
        residuals.push(g.subscribe(inputs[r]!, () => {}))
      }

      for (let t = 0; t < TICKS; t++) {
        for (let m = 0; m < PER_TICK; m++) {
          const n = inputs[(t * PER_TICK + m) % NODE_COUNT]!
          churn.push(g.subscribe(n, () => {}))
        }
        const drop = Math.min(churn.length, PER_TICK)
        for (let d = 0; d < drop; d++) {
          churn.shift()!()
        }
      }
      for (const dispose of churn) dispose()

      const after = g.stats()
      expect(after.subscribersTotal).toBe(RESIDUAL)
      expect(after.subscribersByNodeKeys).toBe(RESIDUAL)
      // And tearing down the residuals lands at zero.
      for (const dispose of residuals) dispose()
      expect(g.stats().subscribersTotal).toBe(0)
      expect(g.stats().subscribersByNodeKeys).toBe(0)
    })
  })

  describe('node-cardinality counters (#696)', () => {
    /**
     * #696 — `inputs` and `deriveds` are running counters maintained at
     * the `entries.set` / `entries.delete` sites. The engine-owned
     * `commitLog` derived registered at `createCausl` boot is NOT
     * counted (it advertises *user-registered* nodes); `entries` still
     * includes it.
     */
    it('input() / derived() bump `inputs` / `deriveds` independently', () => {
      const g = createCausl()
      const a = g.input('cell:a', 1)
      const b = g.input('cell:b', 2)
      g.derived('sum', (get) => get(a) + get(b))
      const s = g.stats()
      expect(s.inputs).toBe(2)
      expect(s.deriveds).toBe(1)
      // `entries` accounts for both user-registered nodes plus the
      // engine-owned `commitLog`.
      expect(s.entries).toBe(2 + 1 + 1)
    })

    /**
     * `commitMetadataDerived` is a flavour of derived; it bumps
     * `deriveds` along with `commitMetadataDeriveds`.
     */
    it('commitMetadataDerived bumps `deriveds` (along with the metadata index)', () => {
      const g = createCausl({ commitHistoryCap: 1000 })
      g.commitMetadataDerived('meta:latest', (get) => {
        const log = get(g.commitLog)
        return log[log.length - 1] ?? null
      })
      const s = g.stats()
      expect(s.deriveds).toBe(1)
      expect(s.commitMetadataDeriveds).toBe(1)
    })

    /**
     * A failed `derived` registration (a compute body that throws on
     * its first eager evaluation) MUST NOT leak a count — atomicity
     * applies to the running counter as much as it does to the
     * `entries` map.
     */
    it('failed derived() registration leaves `deriveds` at 0', () => {
      const g = createCausl()
      expect(() => {
        g.derived('boom', () => {
          throw new Error('compute body throws on first evaluation')
        })
      }).toThrow()
      const s = g.stats()
      expect(s.deriveds).toBe(0)
    })
  })

  describe('lastCommitTime (#696)', () => {
    /**
     * Genesis: `lastCommitTime` is GraphTime 0. The first successful
     * `commit` advances it to 1; the second to 2; and so on. The field
     * is the post-commit value (`now` after Phase C's `now += 1`).
     */
    it('advances by 1 per successful commit', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      expect(g.stats().lastCommitTime).toBe(0)
      g.commit('first', (tx) => {
        tx.set(a, 1)
      })
      expect(g.stats().lastCommitTime).toBe(1)
      g.commit('second', (tx) => {
        tx.set(a, 2)
      })
      expect(g.stats().lastCommitTime).toBe(2)
    })

    /**
     * A failed commit (one whose `run` body throws after staging a
     * write) leaves `lastCommitTime` byte-identical to its pre-call
     * value — `now` is restored under §3 atomicity rollback, and the
     * telemetry surface reads the same `now`.
     */
    it('failed commit leaves lastCommitTime untouched (atomicity)', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      g.commit('seed', (tx) => {
        tx.set(a, 1)
      })
      const before = g.stats().lastCommitTime
      expect(() => {
        g.commit('boom', (tx) => {
          tx.set(a, 2)
          throw new Error('user-thrown abort')
        })
      }).toThrow()
      expect(g.stats().lastCommitTime).toBe(before)
    })
  })

  describe('transientSubscribers (#696)', () => {
    /**
     * Plain `subscribe(...)` does NOT bump the transient counter; only
     * `subscribe(node, observer, { transient: true })` does. The
     * canonical-shape contract is preserved field-by-field.
     */
    it('plain subscribe leaves transientSubscribers at 0', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      g.subscribe(a, () => {})
      expect(g.stats().transientSubscribers).toBe(0)
    })

    /**
     * `subscribe(..., { transient: true })` bumps the counter; manual
     * `unsubscribe()` decrements it; a duplicate `unsubscribe()` is a
     * no-op (gated on `wasPresent`).
     */
    it('transient subscribe → unsubscribe round-trip drains', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      const u = g.subscribe(a, () => {}, { transient: true })
      expect(g.stats().transientSubscribers).toBe(1)
      u()
      expect(g.stats().transientSubscribers).toBe(0)
      // Idempotency: a second unsubscribe MUST NOT under-count.
      u()
      expect(g.stats().transientSubscribers).toBe(0)
    })

    /**
     * Phase G transient drain: a transient subscription that fires on a
     * commit auto-disposes in the commit's `finally` arm. The drain
     * decrements `transientSubscriberCount` for every entry it pulls
     * from the global subscriptions Set.
     */
    it('Phase G drain decrements transientSubscribers after first non-initial fire', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      g.subscribe(a, () => {}, { transient: true })
      // After registration the transient is pinned, awaiting its
      // first non-initial fire (synchronous initial fire does not
      // consume the slot — see #766).
      expect(g.stats().transientSubscribers).toBe(1)
      // A commit that moves the value triggers Phase G's fire and
      // the post-commit drain.
      g.commit('move', (tx) => {
        tx.set(a, 1)
      })
      expect(g.stats().transientSubscribers).toBe(0)
    })

    /**
     * `subscribeMany(..., { transient: true })` contributes one
     * count per group entry (mirroring `subscribersTotal`'s
     * per-entry shape). `unsubscribe()` drops the whole group and
     * decrements all entries at once.
     */
    it('subscribeMany transient counts per-entry; group unsubscribe drains all', () => {
      const g = createCausl()
      const a = g.input('cell:a', 0)
      const b = g.input('cell:b', 0)
      const u = g.subscribeMany([a, b], () => {}, { transient: true })
      expect(g.stats().transientSubscribers).toBe(2)
      expect(g.stats().subscribersTotal).toBe(2)
      u()
      expect(g.stats().transientSubscribers).toBe(0)
      expect(g.stats().subscribersTotal).toBe(0)
    })
  })

  describe('shape stability', () => {
    /**
     * Pin the public shape of {@link EngineTelemetry} field-by-field.
     * A future audit-driven widening of the surface MUST land at the
     * tail of the object; existing field names are part of the
     * public contract for devtools and bench leak gates.
     */
    it('exposes the documented EngineTelemetry shape', () => {
      const g = createCausl()
      const s: EngineTelemetry = g.stats()
      const keys = Object.keys(s).sort()
      expect(keys).toEqual(
        [
          'commitLogConsumerCount',
          'commitMetadataDeriveds',
          'commitObservers',
          'deriveds',
          'entries',
          'inputs',
          'lastCommitTime',
          // #1242 — `nodeVersion(node)` accessor on the snapshot
          // surface (SPEC §15.1 memoisation key). Lands at the tail
          // of the literal per the cross-backend telemetry contract's
          // append-only discipline.
          'nodeVersion',
          'retainedCommits',
          'subscribersByNodeKeys',
          'subscribersTotal',
          'transientSubscribers',
        ].sort(),
      )
      // #696 — optional engine-status fields are NOT included in the
      // per-call literal on the canonical TS engine (the producer
      // intentionally omits them rather than spreading `undefined`
      // values). The type allows them; backends that wire host-level
      // deopt / GC counters MAY add them at the tail of the literal
      // without breaking this snapshot.
      expect(s).not.toHaveProperty('deopts')
      expect(s).not.toHaveProperty('gcPauses')
    })
  })
})
