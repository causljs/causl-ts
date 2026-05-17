/**
 * @packageDocumentation
 *
 * Property-based proof of `subscribe`'s exactly-one-notification-per-actual-
 * change invariant (#409).
 *
 * `subscribe` is one of the canonical seven public methods, and §10's worked
 * example pins its load-bearing demo: `commit('bump-both', tx => { tx.set(a,
 * 100); tx.set(b, 200) })` against a derived `sum = a + b` fires the
 * subscriber on `sum` ONCE with `300`, not twice with `(102, 300)`. The
 * other eight property suites cover atomicity, glitch-freedom, determinism,
 * cycle completeness, dynamic-dep cleanup, replay determinism, recompute-
 * count, snapshot roundtrip, and the disposed-tombstone bound — but until
 * now the most user-visible canonical-seven invariant was the only one
 * with no fuzz coverage. `subscribe.test.ts` example-tests it once and
 * once only, on a hand-built two-input diamond.
 *
 * I close that gap here. Two universally-quantified contracts:
 *
 * 1. Random DAG, random commit trace, single input. Subscribe to every
 *    node up front, capture pre/post `read(node)` on each commit. Per
 *    commit, every subscriber fires AT MOST ONCE, and fires IFF
 *    `Object.is(post, pre) === false`. This is the §10 invariant on
 *    every node of every random shape `propertyDag` claims.
 *
 * 2. Two inputs feeding one derived `sum = a + b`. Random batched
 *    `(a, b)` writes per commit. Subscriber on `sum` fires at most once
 *    per commit, and fires iff the new sum differs from the old under
 *    `Object.is`. This is the §10 worked example as a fuzz contract,
 *    direct on the demo shape rather than via the generator.
 *
 * Trial budget is sourced from `propertyTrials('subscribe-emission/...')`
 * — the §15.2 1000-trial floor, deterministic seeds, failing inputs
 * shrink to regression cases. Comparison is `Object.is` per the spec —
 * the de-duplication boundary the engine commits to.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
} from '@causl/core-testing-internal'
import { createCausl, type Node } from '../../src/index.js'

describe('property: subscribe emission count (#409)', () => {
  /**
   * P1 — exactly-one-notification-per-actual-change on every random DAG:
   *   For every random DAG (input + 1..N derived) and every random
   *   commit trace, every subscribed node fires AT MOST ONCE per commit,
   *   and fires IFF the post-commit `read(node)` differs from the
   *   pre-commit `read(node)` under `Object.is`. This is §10's load-
   *   bearing canonical-seven invariant pinned across the shape space
   *   `propertyDag` actually claims, not just the hand-built diamond
   *   that `subscribe.test.ts` ships.
   *
   *   Per-node bidirectional assertion: the "at most once" half catches
   *   double-fire regressions (the §10 anti-pattern: two notifications
   *   on a single commit for a glitchy intermediate value); the "fires
   *   iff value changed" half catches both spurious fires (a node that
   *   wakes when nothing changed) and missed fires (a node whose value
   *   did change but whose subscriber was never told).
   */
  it('every subscriber fires at most once per commit, and fires iff the read value changed', () => {
    fc.assert(
      fc.property(
        // Random DAG with at least one derived so subscriptions cover
        // both the input and downstream derived shapes.
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // Random commit trace: each entry is a single integer write to
        // the single input. The propertyDag generator declares one
        // input, so the "input ordinal" is always 0; the per-commit
        // value is what varies. A bounded range keeps shrinking quick
        // while still exercising the Object.is dedup boundary (repeats
        // are common at small ranges, exercising the no-op path).
        fc.array(fc.integer({ min: -10, max: 10 }), {
          minLength: 1,
          maxLength: 25,
        }),
        (spec, writes) => {
          // Engine setup: build the random DAG and gather every node
          // (input + all deriveds) into a single iteration list keyed
          // by id, so the assertion loop touches every subscribable
          // surface.
          const graph = createCausl()
          const built = buildPropertyDag(graph, spec)
          const nodes = new Map<string, Node<number>>()
          nodes.set(spec.inputId, built.input)
          for (const [id, node] of built.deriveds) {
            nodes.set(id, node as Node<number>)
          }

          // Subscribe to every node BEFORE any commit, with a per-id
          // counter and a per-id "last seen value". The initial fire
          // (one per subscription) lands during setup; I reset the
          // counters to zero immediately afterward so the assertion
          // loop below measures only post-commit notifications.
          const fireCounts = new Map<string, number>()
          const lastSeen = new Map<string, number>()
          for (const [id, node] of nodes) {
            fireCounts.set(id, 0)
            graph.subscribe(node, (v) => {
              fireCounts.set(id, (fireCounts.get(id) ?? 0) + 1)
              lastSeen.set(id, v)
            })
          }
          for (const id of nodes.keys()) fireCounts.set(id, 0)

          // Drive: one commit per write. Around each commit, capture
          // every node's pre/post `read(node)` so the per-commit
          // assertion can compare under `Object.is` exactly as the
          // §10 spec dedup boundary requires.
          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0

            // Pre-commit reads: what the engine reports right now,
            // before the transaction lands. The §10 invariant is
            // anchored on `read`, not on the engine's internal cache
            // shape, so I source the oracle from `read` directly.
            const pre = new Map<string, number>()
            for (const [id, node] of nodes) pre.set(id, graph.read(node))

            // Reset per-commit fire counters so the at-most-once
            // assertion measures THIS commit's emissions only.
            for (const id of nodes.keys()) fireCounts.set(id, 0)

            graph.commit(`w${i}`, (tx) => tx.set(built.input, v))

            // Post-commit reads: source of truth for the "fires iff
            // value changed under Object.is" oracle.
            const post = new Map<string, number>()
            for (const [id, node] of nodes) post.set(id, graph.read(node))

            // Per-id assertions: bidirectional, AND clamped to the
            // exactly-once ceiling. The ceiling is the §10 canonical-
            // seven contract: one commit, at most one notification per
            // subscriber, regardless of how many internal recomputes
            // the wavefront performs along the way.
            for (const id of nodes.keys()) {
              const fires = fireCounts.get(id) ?? 0
              const preVal = pre.get(id) as number
              const postVal = post.get(id) as number
              const changed = !Object.is(preVal, postVal)

              // (a) AT MOST ONCE per commit. A double-fire here is the
              // §10 worked-example regression — a glitchy intermediate
              // emission breaking through the dedup boundary.
              expect(fires).toBeLessThanOrEqual(1)

              // (b) FIRES IFF VALUE CHANGED under Object.is. Spurious
              // fire ⇒ `changed === false && fires === 1`; missed fire
              // ⇒ `changed === true && fires === 0`. Both arms fail
              // the equality below.
              expect(fires === 1).toBe(changed)

              // When fired, the observed value must equal the post-
              // commit `read(node)` exactly. A subscriber that fires
              // with anything other than the post-commit value is the
              // "fractional time" anti-pattern §10 rules out.
              if (fires === 1) {
                expect(lastSeen.get(id)).toBe(postVal)
              }
            }
          }
        },
      ),
      propertyTrials('subscribe-emission/at-most-once-per-actual-change'),
    )
  })

  /**
   * P2 — §10 worked example as a fuzz contract:
   *   Two inputs `a`, `b` and one derived `sum = a + b`. For every
   *   random sequence of batched `(a, b)` writes inside a single
   *   commit, the subscriber on `sum` fires AT MOST ONCE per commit
   *   and fires IFF the new sum differs from the old under `Object.is`.
   *
   *   This is the §10 demo (`tx.set(a, 100); tx.set(b, 200)` ⇒ one
   *   `300` emission, not two of `(102, 300)`) lifted into the
   *   property layer. The hand-authored example in `subscribe.test.ts`
   *   pins one fixture; this fuzzes the same shape across 1000 random
   *   `(a, b)` traces, including no-op commits where neither input
   *   changes (both fires zero) and "one of the two changes but the
   *   sum stays equal" cases that exercise the post-derived dedup.
   */
  it('§10 worked example: a single commit mutating two inputs fires the downstream subscriber once', () => {
    fc.assert(
      fc.property(
        // Random commit trace of `(aValue, bValue)` pairs. Bounded
        // integer range keeps shrinking fast and intentionally permits
        // collisions where `a + b` ends up unchanged — the post-derived
        // Object.is dedup must still skip those.
        fc.array(fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 })), {
          minLength: 1,
          maxLength: 30,
        }),
        (writes) => {
          const graph = createCausl()
          const a = graph.input('a', 0)
          const b = graph.input('b', 0)
          const sum = graph.derived('sum', (get) => get(a) + get(b))

          // Subscribe to all three observable surfaces. Per-node
          // counters and per-node last-value captures mirror P1.
          const fireCounts = new Map<string, number>([
            ['a', 0],
            ['b', 0],
            ['sum', 0],
          ])
          const lastSeen = new Map<string, number>()
          graph.subscribe(a, (v) => {
            fireCounts.set('a', (fireCounts.get('a') ?? 0) + 1)
            lastSeen.set('a', v)
          })
          graph.subscribe(b, (v) => {
            fireCounts.set('b', (fireCounts.get('b') ?? 0) + 1)
            lastSeen.set('b', v)
          })
          graph.subscribe(sum, (v) => {
            fireCounts.set('sum', (fireCounts.get('sum') ?? 0) + 1)
            lastSeen.set('sum', v)
          })
          // Discard the initial-fire bookkeeping — only post-commit
          // notifications count.
          fireCounts.set('a', 0)
          fireCounts.set('b', 0)
          fireCounts.set('sum', 0)

          for (let i = 0; i < writes.length; i++) {
            const w = writes[i]
            if (!w) continue
            const [av, bv] = w

            const preA = graph.read(a)
            const preB = graph.read(b)
            const preSum = graph.read(sum)

            // Reset the per-commit counters before staging the writes.
            fireCounts.set('a', 0)
            fireCounts.set('b', 0)
            fireCounts.set('sum', 0)

            // The §10 worked-example commit shape: stage two input
            // writes inside a single transaction. The engine MUST fold
            // both staged writes into one notification per affected
            // subscriber, never two.
            graph.commit(`bump-${i}`, (tx) => {
              tx.set(a, av)
              tx.set(b, bv)
            })

            const postA = graph.read(a)
            const postB = graph.read(b)
            const postSum = graph.read(sum)

            // §10 invariant on every observable surface — bidirectional,
            // exactly-once-clamped, Object.is comparison.
            const changedA = !Object.is(preA, postA)
            const changedB = !Object.is(preB, postB)
            const changedSum = !Object.is(preSum, postSum)

            expect(fireCounts.get('a')).toBeLessThanOrEqual(1)
            expect(fireCounts.get('b')).toBeLessThanOrEqual(1)
            expect(fireCounts.get('sum')).toBeLessThanOrEqual(1)

            expect(fireCounts.get('a') === 1).toBe(changedA)
            expect(fireCounts.get('b') === 1).toBe(changedB)
            expect(fireCounts.get('sum') === 1).toBe(changedSum)

            if (fireCounts.get('a') === 1) expect(lastSeen.get('a')).toBe(postA)
            if (fireCounts.get('b') === 1) expect(lastSeen.get('b')).toBe(postB)
            if (fireCounts.get('sum') === 1) expect(lastSeen.get('sum')).toBe(postSum)
          }
        },
      ),
      propertyTrials('subscribe-emission/spec-10-worked-example'),
    )
  })
})
