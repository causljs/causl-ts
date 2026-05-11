/**
 * @packageDocumentation
 *
 * Behavioural parity gate for the #842 collapse of
 * `anyInputSubscriberIn` from O(|subscriptions|) to
 * O(|changedInputIds|).
 *
 * The helper is engine-private — the public surface only exposes the
 * observable consequence: subscribers fire for the inputs the engine
 * decides have downstream observers. The two implementations (the old
 * "iterate the flat `subscriptions` set" body and the new
 * "`subscriptionsByNode.has(id)`" body) answer the same query —
 * "does any active subscription target an id in `changedInputIds`?" —
 * just queried in different shape. Behavioural parity means: for any
 * sequence of subscribe / unsubscribe / commit ops, the firing pattern
 * the user observes must be identical.
 *
 * The fixture below builds a graph through the public API
 * (`createCausl`), drives a random sequence of subscribe / dispose
 * ops + per-commit input writes against a seeded mulberry32 PRNG
 * (seed 42, like the bench fixtures), and asserts that:
 *
 *   1. **Fires iff the input has at least one live subscriber** — the
 *      sole role of `anyInputSubscriberIn` is to gate Phase G
 *      dispatch; any divergence between the two implementations would
 *      manifest as a missed fire (the new one returns false where the
 *      old returned true) or a spurious fire (the new returns true
 *      where the old returned false). A reference oracle reconstructs
 *      the expected fire set from the ground-truth subscription map
 *      maintained alongside the engine-driven one.
 *
 *   2. **Per-input subscriber count drives the per-input fire count**
 *      — when the same input is written and N subscribers are live on
 *      that node, exactly N fires must land for that node. This pins
 *      the dispatch-loop side of the gate: even if the gate decision
 *      flipped to true correctly, a regression that fires the wrong
 *      number of subscribers would still slip past oracle (1).
 *
 *   3. **Disposed subscriptions stay dead** — subscriptions that were
 *      created and then disposed earlier in the trace must NEVER fire
 *      after disposal, regardless of what the gate decides for their
 *      old node. This is the per-node-index unsubscribe correctness
 *      check from #738.
 *
 * 50 random trials with the seeded PRNG → deterministic. Each trial
 * runs a random op count between 50 and 200 — large enough to drive
 * the gate through "no subscribers, return false" (cold path), "first
 * subscriber registered, gate flips" (boundary), "many subscribers
 * registered" (steady state), and "all subscribers disposed, gate
 * flips back to false" (cold-path return) regimes. The assertion
 * holds at every commit — a single missed/spurious fire fails the
 * test deterministically against the seed.
 */

import { describe, it, expect } from 'vitest'
import { createCausl, type InputNode, type Unsubscribe } from '../src/index.js'

/**
 * Mulberry32 PRNG — the same seeded PRNG the bench fixtures use, so
 * the test trace is deterministic and reproducible from the seed
 * alone. Returns an integer in [0, 2^32) shape callers can normalise
 * with `% range`.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

interface FireRecord {
  inputIndex: number
  subId: number
  value: number
}

describe('#842 — anyInputSubscriberIn behavioural parity', () => {
  it('fires iff a live subscription exists on the changed input across 50 random subscribe/dispose/commit traces', () => {
    const TRIALS = 50
    const INPUTS = 8 // small enough to fuzz collisions, large enough to exercise per-node bucketing
    const seedBase = 42

    for (let trial = 0; trial < TRIALS; trial++) {
      // Seed evolves per trial so each trial walks a distinct trace,
      // but the trial-0 seed is fixed at 42 — a CI failure on trial K
      // is reproducible by re-running with the same K.
      const rng = mulberry32(seedBase + trial)
      const graph = createCausl()

      // Build N inputs through the public API. The helper under test
      // is `anyInputSubscriberIn`, which queries the per-node
      // `subscriptionsByNode` index that subscribe / dispose
      // maintain. By using only `input`, `subscribe`, `commit`, and
      // the dispose handle the public surface returns, the test
      // exercises the helper purely through its observable effect:
      // subscribers fire iff the gate returns true for their node.
      const inputs: InputNode<number>[] = []
      for (let i = 0; i < INPUTS; i++) {
        inputs.push(graph.input(`input-${trial}-${i}`, 0))
      }

      // Per-subscription bookkeeping. `live` mirrors the engine's
      // `subscriptionsByNode` shape so the oracle can compute the
      // expected fire pattern without inspecting engine internals.
      // Map<inputIndex, Map<subId, expectedFireRecord>>.
      const live = new Map<number, Map<number, FireRecord>>()
      for (let i = 0; i < INPUTS; i++) live.set(i, new Map())

      const disposers = new Map<number, Unsubscribe>()
      const fires: FireRecord[] = []
      let nextSubId = 0

      // Discard initial subscribe-time fires from accounting — the
      // gate under test runs at commit-time Phase G, not at
      // subscribe time. Resetting `fires.length = 0` after each
      // subscribe drops that one notification cleanly.
      const subscribeAt = (inputIdx: number): number => {
        const subId = nextSubId++
        const node = inputs[inputIdx]!
        const unsub = graph.subscribe(node, (value) => {
          fires.push({ inputIndex: inputIdx, subId, value })
        })
        // Drop the subscribe-time replay fire — only commit-time
        // fires count toward the gate parity oracle.
        fires.length = 0
        live.get(inputIdx)!.set(subId, { inputIndex: inputIdx, subId, value: 0 })
        disposers.set(subId, unsub)
        return subId
      }

      const disposeAt = (subId: number): void => {
        const dispose = disposers.get(subId)
        if (!dispose) return
        dispose()
        disposers.delete(subId)
        for (const bucket of live.values()) bucket.delete(subId)
      }

      const opCount = 50 + Math.floor(rng() * 150)
      for (let op = 0; op < opCount; op++) {
        // Op-mix probabilities tuned so the gate sees all four
        // regimes (no-subs, first-sub-flip, many-subs, all-gone).
        // 35% subscribe, 20% dispose, 45% commit.
        const r = rng()
        if (r < 0.35) {
          const inputIdx = Math.floor(rng() * INPUTS)
          subscribeAt(inputIdx)
        } else if (r < 0.55) {
          // Dispose a random live subscription, if any.
          const liveIds = Array.from(disposers.keys())
          if (liveIds.length > 0) {
            const pick = liveIds[Math.floor(rng() * liveIds.length)]!
            disposeAt(pick)
          }
        } else {
          // Random commit: write to a random subset of inputs in a
          // single transaction. The gate decides per changed input
          // whether Phase G runs; the oracle decides per changed
          // input whether at least one live subscription targets it.
          const writeCount = 1 + Math.floor(rng() * 3)
          const writes = new Map<number, number>()
          for (let w = 0; w < writeCount; w++) {
            writes.set(Math.floor(rng() * INPUTS), op + 1)
          }

          // Snapshot pre-commit live subscribers per input so the
          // oracle compares against the state the gate sees when it
          // runs (subscribe / dispose during the commit body would
          // muddy this, but the test does NOT call those inside
          // the commit lambda — only `tx.set`).
          const expectedFires = new Map<number, number>() // input -> count
          for (const [inputIdx, value] of writes) {
            const pre = graph.read(inputs[inputIdx]!)
            // Engine dedupes equal writes (Object.is) — match that.
            if (Object.is(pre, value)) continue
            const liveCount = live.get(inputIdx)!.size
            if (liveCount > 0) expectedFires.set(inputIdx, liveCount)
          }

          fires.length = 0
          graph.commit(`t${trial}-c${op}`, (tx) => {
            for (const [inputIdx, value] of writes) {
              tx.set(inputs[inputIdx]!, value)
            }
          })

          // Oracle (1)+(2): tally fires per input and compare to
          // expectedFires. A divergence means the gate either
          // dropped a notification (missed fire) or fired with
          // no live subscriber (spurious fire). Either is a
          // parity break.
          const observed = new Map<number, number>()
          for (const f of fires) {
            observed.set(f.inputIndex, (observed.get(f.inputIndex) ?? 0) + 1)
          }
          expect(observed).toEqual(expectedFires)

          // Oracle (3): no fire's subId can be one we previously
          // disposed.
          for (const f of fires) {
            expect(disposers.has(f.subId)).toBe(true)
          }
        }
      }

      // End-of-trial sanity: every disposer the trace handed out
      // must still resolve to either a live entry in `live` or have
      // been removed from `disposers` (i.e. dispose was called).
      for (const subId of disposers.keys()) {
        let present = false
        for (const bucket of live.values()) {
          if (bucket.has(subId)) {
            present = true
            break
          }
        }
        expect(present).toBe(true)
      }
    }
  })

  it('boundary: gate flips correctly when subscribers cross 0↔1↔0 on the same input', () => {
    // Hand-built shape exercising the exact regime the new O(1)
    // implementation must respect: a single input, subscribe, fire,
    // dispose, write again (no fire expected), re-subscribe, write
    // (fire expected). The new body is `subscriptionsByNode.has(id)`,
    // which the per-node index from #671/#738 maintains across
    // subscribe + the dispose path. If subscribe / dispose did NOT
    // mutate the index symmetrically, this case is the one that
    // surfaces it deterministically.
    const graph = createCausl()
    const a = graph.input('a', 0)
    const fires: number[] = []

    // 0 subscribers: gate must return false. We can't observe the
    // gate directly, but a write that would have fired had a
    // subscriber existed is harmless — we just assert that NO fire
    // lands.
    graph.commit('w0', (tx) => tx.set(a, 1))
    expect(fires.length).toBe(0)

    // 1 subscriber, gate must return true.
    const dispose = graph.subscribe(a, (v) => fires.push(v))
    fires.length = 0 // discard subscribe-time fire
    graph.commit('w1', (tx) => tx.set(a, 2))
    expect(fires).toEqual([2])

    // 0 subscribers (dispose called). Gate must flip back to false.
    // The §842 fix's correctness hinges on `subscriptionsByNode`
    // dropping the per-node bucket when it becomes empty (#738).
    dispose()
    fires.length = 0
    graph.commit('w2', (tx) => tx.set(a, 3))
    expect(fires.length).toBe(0)

    // Re-subscribe: gate must flip back to true on the next commit
    // — i.e. the per-node index must repopulate the bucket on a
    // fresh subscribe call.
    graph.subscribe(a, (v) => fires.push(v))
    fires.length = 0
    graph.commit('w3', (tx) => tx.set(a, 4))
    expect(fires).toEqual([4])
  })
})
