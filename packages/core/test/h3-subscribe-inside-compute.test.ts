/**
 * @packageDocumentation
 *
 * H3 hazard parity gate — subscribe inside a derived `compute` closure.
 * Closes #1154.
 *
 * # Why this file exists
 *
 * `docs/wasm-backend-adopter-audit.md` § "H3 — Subscribe inside a
 * derivation's compute closure" catalogues subscribe-during-compute as
 * one of eight adopter-visible hazards the WASM port must match
 * byte-for-byte. The TS engine *permits* `graph.subscribe(...)` inside
 * a `compute` closure — it is "unwise but not throw-on-detect" — and
 * the new entry is wired into the normal dispatch index. The H3
 * contract this file pins:
 *
 *   1. Subscribe inside a derived compute → registers normally and
 *      fires on the next commit that changes the observed node's value.
 *      The initial synchronous fire happens at registration time
 *      (inside the compute), and the registration survives the commit
 *      that ran the compute (it is NOT auto-disposed as a "transient
 *      registration" unless the caller explicitly passed
 *      `{ transient: true }`).
 *
 *   2. Subscribe-then-unsubscribe inside the same compute body → the
 *      observer fires synchronously at registration time only; it
 *      does NOT fire on subsequent commits because the user-returned
 *      unsubscribe closure dropped the entry from the per-node bucket
 *      before Phase G ever visits it.
 *
 *   3. Subscribe inside compute, then dispose the parent input the
 *      registration targets → the registration is cancelled cleanly
 *      via `_dispose`'s subscription-cancel walk (`for sub of
 *      subscriptions`); subsequent commits do not visit a dangling
 *      entry. The disposal path through `@causl/core/internal`'s
 *      `dispose` helper drops the registration before
 *      `subscriptionsByNode` is deleted, so the Phase G bucket walk
 *      sees an empty bucket on the next commit and the observer is
 *      not visited.
 *
 *   4. Transient subscribe inside compute → exercises the
 *      `pendingTransientDrops` set the brief calls out: a
 *      `subscribe(..., { transient: true })` registered mid-compute
 *      lands in the same Phase H drain path that handles every other
 *      transient registration — fires once on the next value-changing
 *      commit, then auto-disposes at the end of that commit. The
 *      Phase H drain is the load-bearing mechanism the brief flags
 *      as the cross-backend parity surface.
 *
 * # Cross-backend parity
 *
 * The current TS engine implements all four clauses through the
 * Phase D recompute path (where compute closures actually run) and
 * the Phase G/H dispatch + drain paths. The future Rust port (epic
 * #1133) must produce byte-identical observer-fire sequences for
 * every commit in every fixture below; the cross-backend determinism
 * gate (issue #685, PR #1107) extends with the property arm landed
 * alongside this file in `cross-backend-determinism.property.test.ts`
 * so the property machinery shrinks subscribe-during-compute traces
 * the moment the Rust backend lands.
 *
 * @see https://github.com/iasbuilt/causl/issues/1154 — this gate.
 * @see docs/wasm-backend-adopter-audit.md § H3.
 * @see https://github.com/iasbuilt/causl/issues/685 — cross-backend determinism gate.
 */

import { describe, expect, it, vi } from 'vitest'
import { createCausl } from '../src/index.js'
import { dispose } from '../src/internal.js'

describe('H3 — subscribe inside derived compute (issue #1154)', () => {
  // ---------------------------------------------------------------
  // Clause 1: subscribe-inside-compute registers normally and fires
  // on subsequent value-changing commits.
  // ---------------------------------------------------------------
  describe('Clause 1: subscribe inside compute fires on subsequent commits', () => {
    /**
     * The audit clause: the TS engine "permits `graph.subscribe(...)`
     * inside a `compute` closure (it is unwise but not throw-on-detect)."
     * After the registration completes, the entry lives in the per-node
     * bucket index and the next commit that changes the subscribed
     * node's value invokes the observer through Phase G.
     */
    it('observer fires synchronously inside the compute and again on the next changing commit', () => {
      const g = createCausl({ name: 'h3-clause-1' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: Array<readonly [number, number]> = []

      // Subscribe-from-compute fires on the FIRST run of the compute
      // (which happens at registration time because `derived()` eagerly
      // computes), capturing `(value, time)` for both the synchronous
      // initial fire and every subsequent commit fire.
      let subscribed = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!subscribed) {
          subscribed = true
          g.subscribe(b, (v, t) => {
            seen.push([v, t] as const)
          })
        }
        return va
      })

      // Initial synchronous fire: subscribe() is documented to fire
      // once with the current value at registration time.
      expect(seen).toEqual([[100, 0]])

      // A commit that does not change `b` must not re-fire the b-observer.
      g.commit('a→1', (tx) => tx.set(a, 1))
      expect(seen).toEqual([[100, 0]])

      // A commit that DOES change `b` fires the observer through
      // Phase G's per-node bucket walk.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([
        [100, 0],
        [200, 2],
      ])

      // Another b-change fires once more.
      g.commit('b→300', (tx) => tx.set(b, 300))
      expect(seen).toEqual([
        [100, 0],
        [200, 2],
        [300, 3],
      ])
    })

    /**
     * Subscribe-from-compute against the same node the compute is
     * tracking — the registration targets an input that is also in
     * the compute's read-set. The next commit that changes that input
     * fires both the derived's recompute path (Phase D) and the
     * subscribe observer (Phase G); the orderings must remain stable.
     */
    it('observer registered against a tracked input still fires when that input changes', () => {
      const g = createCausl({ name: 'h3-clause-1-self' })
      const a = g.input('a', 0)
      const obs = vi.fn()

      let subscribed = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!subscribed) {
          subscribed = true
          g.subscribe(a, obs)
        }
        return va * 2
      })

      // Initial sync fire at registration time.
      expect(obs).toHaveBeenCalledTimes(1)
      expect(obs).toHaveBeenNthCalledWith(1, 0, 0)

      g.commit('a→5', (tx) => tx.set(a, 5))
      expect(obs).toHaveBeenCalledTimes(2)
      expect(obs).toHaveBeenNthCalledWith(2, 5, 1)
    })
  })

  // ---------------------------------------------------------------
  // Clause 2: subscribe-then-unsubscribe inside the same compute
  // body — observer fires only at synchronous registration time, NOT
  // on later commits.
  // ---------------------------------------------------------------
  describe('Clause 2: subscribe-then-unsubscribe inside compute leaves no live registration', () => {
    /**
     * The user-returned `unsubscribe` closure drops the entry from
     * the flat `subscriptions` Set, the per-node bucket index, and
     * decrements the running consumer counters. After it runs, Phase G
     * cannot visit the registration because the bucket walk reads from
     * the same per-node index the unsubscribe just mutated.
     */
    it('fires synchronously at registration but not on subsequent value-changing commits', () => {
      const g = createCausl({ name: 'h3-clause-2' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: number[] = []

      let registered = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          const off = g.subscribe(b, (v) => {
            seen.push(v)
          })
          // Drop the registration before the compute returns. Phase G
          // never sees this entry on future commits.
          off()
        }
        return va
      })

      // Synchronous initial fire was captured.
      expect(seen).toEqual([100])

      // A commit that changes `b` must NOT fire — registration was
      // dropped before any Phase G visit.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([100])

      // Multiple subsequent commits — still no fire.
      g.commit('b→300', (tx) => tx.set(b, 300))
      g.commit('a→1', (tx) => tx.set(a, 1))
      expect(seen).toEqual([100])
    })

    /**
     * Double-unsubscribe is documented to be idempotent on the
     * returned closure. Calling it twice inside the compute body
     * must not throw and must not corrupt the bucket index.
     */
    it('double-unsubscribe inside compute is idempotent and the index stays clean', () => {
      const g = createCausl({ name: 'h3-clause-2-double-off' })
      const a = g.input('a', 0)
      const b = g.input('b', 0)
      const obs = vi.fn()

      // Gate the subscribe-then-unsubscribe pair so it runs once at
      // registration time only. Without the gate, every recompute of
      // `d` triggered by a future `a`-write would re-subscribe and
      // immediately unsubscribe again — burning a sync initial-fire
      // per recompute and obscuring the contract this test pins.
      let registered = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          const off = g.subscribe(b, obs)
          // Idempotent: second call is a no-op per the documented
          // subscribe contract.
          off()
          off()
        }
        return va
      })

      // Initial sync fire captured at registration time.
      expect(obs).toHaveBeenCalledTimes(1)

      // No further fires — registration was dropped.
      g.commit('b→1', (tx) => tx.set(b, 1))
      expect(obs).toHaveBeenCalledTimes(1)

      // Sanity: subsequent commits do not throw and do not fire.
      g.commit('a→1', (tx) => tx.set(a, 1))
      expect(obs).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------
  // Clause 3: dispose the parent input after subscribing inside
  // compute — the registration is cancelled cleanly through
  // `_dispose`'s subscription-cancel walk.
  // ---------------------------------------------------------------
  describe('Clause 3: dispose target after subscribe-inside-compute drops the registration', () => {
    /**
     * The subscribe registration targets `b`. After the derived `d`
     * (which depends on `a`, not `b`) registers and the compute
     * completes, the registration is live on `b`. Disposing `b`
     * walks the subscriptions Set and drops every entry pinned to
     * the disposed id; Phase G's bucket walk on a later commit
     * cannot visit the (now-dead) registration because
     * `subscriptionsByNode.get(b.id)` returns `undefined`.
     */
    it('disposing the subscribed input cancels the registration; no further fires after dispose', () => {
      const g = createCausl({ name: 'h3-clause-3' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: number[] = []

      let registered = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          g.subscribe(b, (v) => {
            seen.push(v)
          })
        }
        return va
      })

      // Sync fire on subscribe — captured.
      expect(seen).toEqual([100])

      // Sanity: a regular commit on `b` fires the observer.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([100, 200])

      // Now dispose `b`. The dispose path walks `subscriptions` and
      // drops every entry whose `sub.node.id === b.id`.
      dispose(g, b)

      // Subsequent commits cannot touch `b` (it is disposed), and
      // the registration must not fire on commits to unrelated nodes.
      g.commit('a→1', (tx) => tx.set(a, 1))
      g.commit('a→2', (tx) => tx.set(a, 2))
      expect(seen).toEqual([100, 200])
    })

    /**
     * Disposing the *derived* host (the node whose compute body
     * subscribed) does NOT affect the subscribe registration — the
     * registration targets the input `b`, not the derived `d`. After
     * `d` is disposed, the live subscription on `b` continues to fire
     * on `b`-changing commits.
     *
     * This case exists because adopters reading the audit might
     * expect "subscribe inside compute" to be lifetime-tied to the
     * compute — it is not. The engine treats subscribe registrations
     * uniformly: they are tied to the *subscribed* node, not the
     * call site.
     */
    it('disposing the derived host leaves the subscribe-from-compute registration live', () => {
      const g = createCausl({ name: 'h3-clause-3-host' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: number[] = []

      let registered = false
      // Derived `d` reads `a` and one-shot subscribes to `b`.
      const d = g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          g.subscribe(b, (v) => {
            seen.push(v)
          })
        }
        return va
      })

      // Synchronous fire on subscribe.
      expect(seen).toEqual([100])

      // Dispose the derived host. The registration on `b` survives.
      dispose(g, d)

      // A commit on `b` still fires the observer.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([100, 200])
    })
  })

  // ---------------------------------------------------------------
  // Clause 4: transient subscribe inside compute — the brief's
  // load-bearing `pendingTransientDrops` (Phase H dispose) path.
  // ---------------------------------------------------------------
  describe('Clause 4: transient subscribe inside compute routes through pendingTransientDrops', () => {
    /**
     * `subscribe(node, observer, { transient: true })` registers a
     * one-shot observer that auto-disposes after its first Phase G
     * fire. The drop happens through the `pendingTransientDrops` set
     * the brief calls out — Phase G adds the entry mid-dispatch, and
     * the `finally` arm of `commitInternal` (Phase H) drains the set,
     * walking each entry once to remove it from the flat
     * `subscriptions` Set and the per-node bucket index.
     *
     * When the transient subscribe lands *inside a compute body*, the
     * registration's lifecycle is identical to any other transient:
     *   - Initial synchronous fire on registration does NOT consume
     *     the transient slot (per SubscribeOptions docs).
     *   - The next value-changing commit fires the observer through
     *     Phase G, adds the entry to `pendingTransientDrops`, and
     *     Phase H drains it at end-of-commit.
     *   - Subsequent commits cannot fire it — the entry is gone.
     */
    it('transient subscribe in compute fires once on the next changing commit, then auto-disposes via Phase H', () => {
      const g = createCausl({ name: 'h3-clause-4' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: number[] = []

      let registered = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          g.subscribe(
            b,
            (v) => {
              seen.push(v)
            },
            { transient: true },
          )
        }
        return va
      })

      // Initial sync fire — does NOT consume the transient slot.
      expect(seen).toEqual([100])

      // First value-changing commit on `b`: Phase G fires the observer
      // and adds the entry to `pendingTransientDrops`; Phase H drains.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([100, 200])

      // Second changing commit on `b`: entry was dropped by Phase H
      // last commit, so the per-node bucket walk finds an empty bucket
      // and the observer is NOT invoked.
      g.commit('b→300', (tx) => tx.set(b, 300))
      expect(seen).toEqual([100, 200])

      // Many more commits — no fires.
      g.commit('a→1', (tx) => tx.set(a, 1))
      g.commit('b→400', (tx) => tx.set(b, 400))
      g.commit('b→500', (tx) => tx.set(b, 500))
      expect(seen).toEqual([100, 200])
    })

    /**
     * The transient drain runs even when the post-fire commit
     * surfaces no other side effects — the entry must not survive
     * across two value-changing commits regardless of intervening
     * no-op commits. The `pendingTransientDrops` drain in the
     * `finally` arm fires unconditionally when the set is non-empty.
     */
    it('transient observer does not fire twice across an Object.is-equal commit', () => {
      const g = createCausl({ name: 'h3-clause-4-equal' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: number[] = []

      let registered = false
      g.derived<number>('d', (get) => {
        const va = get(a)
        if (!registered) {
          registered = true
          g.subscribe(
            b,
            (v) => {
              seen.push(v)
            },
            { transient: true },
          )
        }
        return va
      })

      // Initial sync fire only.
      expect(seen).toEqual([100])

      // A commit that writes the same value to `b` is `Object.is`-
      // equal and does NOT fire Phase G for that observer. The
      // transient registration survives because Phase G never visited
      // it on this commit.
      g.commit('b→100-again', (tx) => tx.set(b, 100))
      expect(seen).toEqual([100])

      // Now an actual change. Fires once and auto-disposes.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([100, 200])

      // Another change. Must not fire — Phase H drained the entry.
      g.commit('b→300', (tx) => tx.set(b, 300))
      expect(seen).toEqual([100, 200])
    })
  })

  // ---------------------------------------------------------------
  // Bonus: multiple subscribe-from-compute registrations interleave
  // cleanly with the engine's normal commit ordering. Pins the H3
  // contract against a small graph where two derived nodes each
  // subscribe inside their compute and a single commit fires both.
  // ---------------------------------------------------------------
  describe('Clause 5: multiple subscribe-from-compute registrations co-exist', () => {
    /**
     * Two distinct derived nodes each subscribe to the same input
     * during their compute. The single commit that changes the input
     * must fire both observers in a deterministic order
     * (registration order — SPEC §15 subscriber-fire ordering).
     */
    it('two subscribe-from-compute observers both fire on the same commit', () => {
      const g = createCausl({ name: 'h3-clause-5' })
      const a = g.input('a', 0)
      const b = g.input('b', 100)
      const seen: Array<readonly [string, number]> = []

      let registeredD1 = false
      let registeredD2 = false
      g.derived<number>('d1', (get) => {
        const va = get(a)
        if (!registeredD1) {
          registeredD1 = true
          g.subscribe(b, (v) => {
            seen.push(['d1', v] as const)
          })
        }
        return va
      })
      g.derived<number>('d2', (get) => {
        const va = get(a)
        if (!registeredD2) {
          registeredD2 = true
          g.subscribe(b, (v) => {
            seen.push(['d2', v] as const)
          })
        }
        return va * 2
      })

      // Both observers fired their initial synchronous notification at
      // registration time — `d1` first because it registered first.
      expect(seen).toEqual([
        ['d1', 100],
        ['d2', 100],
      ])

      // One commit on `b`: both observers fire, in registration order.
      g.commit('b→200', (tx) => tx.set(b, 200))
      expect(seen).toEqual([
        ['d1', 100],
        ['d2', 100],
        ['d1', 200],
        ['d2', 200],
      ])
    })
  })
})
