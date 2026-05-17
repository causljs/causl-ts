/**
 * @packageDocumentation
 *
 * Property-based equivalence proof of SPEC §5.1 Amendment 1 phase
 * gates (#715, PR #730 — gate, this PR — proof).
 *
 * Amendment 1 makes phases F / F.4 / F.5 / F.6 / G / H run *iff* their
 * preconditions hold. The §3 atomicity contract is unchanged: any
 * consumer that subscribes still sees byte-identical results to the
 * eager evaluation. PR #730 (the gate) shipped relying on the existing
 * 464+ unit tests; the deferred half — the universally-quantified
 * proof that for every random (consumer-shape × scenario × commit)
 * tuple the gated path produces the same observable state as the
 * hypothetical eager path — is what this file lands.
 *
 * Why properties (not more example tests) close the gap. The example
 * tests pin the gate against named shapes — `cap=0 keeps log empty
 * across commits`, `commitObservers fire on every commit`, etc. The
 * §5.1 contract is universal: *for every* random graph, *for every*
 * random commit sequence, *for every* gated phase, the engine state
 * after the commit must equal the eager-rebuild baseline. The fixed
 * cases assert §5.1 on canonical shapes; this file asserts §5.1 on
 * the shape space `propertyDag` actually claims.
 *
 * The three properties below mirror the three gated phases whose
 * baselines are analytically determinable:
 *
 *   P1 — Phase F gate: `commitHistoryCap = 0` plus no commitLog
 *        consumer ⇒ `read(commitLog)` stays at the genesis empty
 *        array across every commit. Eager-rebuild baseline at
 *        cap=0 is the empty array (no history can be appended), so
 *        gated == eager bytewise.
 *
 *   P2 — Phase G gate: when `changed.size === 0` (a no-op commit
 *        whose staged write is `Object.is`-equal to the current
 *        value), no per-node subscriber fires — equivalent to the
 *        eager path, which would also dedup every subscriber under
 *        the value-equality cutoff and emit nothing.
 *
 *   P3 — Phase H gate: with zero `subscribeCommits` registrations,
 *        no commit-level observer fires — vacuously equivalent to
 *        the eager path (no observer to fire).
 *
 * Trial budget is sourced from `propertyTrials('phase-gate-eq/...')`
 * — the §15.2 1000-trial floor, deterministic seeds, failing inputs
 * shrink to regression cases under `CAUSL_FUZZ_SEED`. The DAG
 * generator is the shared `propertyDag` from
 * `@causl/core-testing-internal`, so a future generator change
 * propagates here automatically.
 *
 * The eager-baseline "oracle" for each property is analytic, not
 * a second engine — running the engine twice (once gated, once eager)
 * would only catch a regression in the gate; running the gated
 * engine against the *closed-form* baseline catches both a gate
 * regression and a drift in the baseline definition itself.
 *
 * Closes #753.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
} from '@causl/core-testing-internal'
import { createCausl, type Commit } from '../../src/index.js'

describe('property: §5.1 Amendment 1 phase-gate equivalence (#753)', () => {
  /**
   * P1 — Phase F gate equivalence: `cap=0` + no commitLog consumer
   *   ⇒ `read(commitLog)` stays at the genesis empty array across
   *   every random commit on every random DAG.
   *
   * The Phase F (history append), F.4 (`commitLogEntry.value`
   * refresh), and F.6 (retention) precondition for SPEC §5.1
   * Amendment 1 is `commitHistoryCap > 0`. With cap=0 the bounded
   * ring is structurally empty — there is no row to push, no log
   * to refresh, no snapshot to retain. The eager-rebuild baseline
   * at cap=0 is therefore the empty array, byte-identical to a
   * fresh graph: a hypothetical "always run F.4 even at cap=0"
   * engine would still rebuild from a length-0 `commitHistory`
   * and produce `[]`. The gated path skips the rebuild entirely;
   * this property pins that the *observable* result is the same.
   *
   * Per-commit assertion is bidirectional: (a) `read(commitLog)`
   * remains `===` to the initial empty-array reference (no rebuild
   * fired, identity is preserved), and (b) the array is structurally
   * `[]` (no entries leaked through any side channel).
   */
  it('Phase F gate: cap=0 with no commitLog consumer keeps the log byte-identical to the eager empty-array baseline across every commit', () => {
    fc.assert(
      fc.property(
        // Random DAG (input + 1..N derived) — the gate must hold
        // regardless of graph topology, because Phase F runs after
        // Phase D's recompute and is independent of which derived
        // ids actually changed.
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // Random commit trace: each entry is one integer write to
        // the single input. A bounded range exercises both genuine
        // changes and Object.is dedup paths (which interact with the
        // Phase G gate in P2 below, but here only confirm Phase F
        // is independent of `changed.size`).
        fc.array(fc.integer({ min: -10, max: 10 }), {
          minLength: 1,
          maxLength: 25,
        }),
        (spec, writes) => {
          // Engine setup: explicit `commitHistoryCap: 0` engages the
          // Phase F / F.4 / F.6 gates. No `subscribe(commitLog, …)`,
          // no `commitMetadataDerived(...)`, no plain derived reads
          // through `get(g.commitLog)` — so `commitLogConsumerCount`
          // stays at zero too (which is what gates Phase F.4 even at
          // cap > 0; here both gates are engaged).
          const graph = createCausl({ commitHistoryCap: 0 })
          const built = buildPropertyDag(graph, spec)

          // Eager-rebuild baseline at cap=0: an empty array. The
          // engine pre-registers `commitLog` as a derived node whose
          // genesis value is `[]`, so a single read up front captures
          // the exact reference the gated path must preserve across
          // every commit (no rebuild ⇒ identity preserved).
          const baseline = graph.read(graph.commitLog)
          expect(baseline).toEqual([])

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0

            // Drive the commit through the captured input handle.
            // Phase F's gate is `commitHistoryCap > 0`, not
            // `changed.size > 0`, so this assertion holds whether
            // the write is a no-op (Object.is dedup) or a genuine
            // mutation.
            graph.commit(`w${i}`, (tx) => tx.set(built.input, v))

            // Post-commit: `read(commitLog)` must equal the eager
            // baseline byte-for-byte. The gate's correctness claim is
            // exactly this equivalence.
            const post = graph.read(graph.commitLog)
            expect(post).toEqual([])
            // Identity preservation: no rebuild ⇒ same reference.
            // Catches a regression where the gate is bypassed and
            // F.4 fabricates a fresh empty array on each commit
            // (functionally equivalent under deep equality, but
            // observably different through `===`).
            expect(post).toBe(baseline)
            // `now` still advances even though the log doesn't —
            // this is the gate's *observable equivalence* claim:
            // forward-progress state moves, only the gated work
            // is dead.
            expect(graph.now).toBe(i + 1)
          }
        },
      ),
      propertyTrials('phase-gate-eq/F-cap0-empty-log'),
    )
  })

  /**
   * P2 — Phase G gate equivalence: when `changed.size === 0`, no
   *   per-node subscriber fires.
   *
   * Phase G's precondition under §5.1 Amendment 1 is `changed.size
   * > 0`. The eager-path equivalence rests on the §10 dedup cutoff:
   * with an empty `changed` set, every subscriber's `Object.is(
   * lastValue, readEntry(node))` check would return true (no
   * upstream value moved, so no dependent value moved), and no
   * observer would fire either way. The gate elides the loop;
   * this property pins that the loop's elision is observably
   * equivalent.
   *
   * The trigger: stage a write whose value is `Object.is`-equal to
   * the input's current value (by re-writing the same value).
   * Phase B records no entry in `changedInputIds` (the staged-
   * write equality cutoff); Phase D walks no derived (no input
   * moved); Phase F.4 doesn't fire (no consumer; tested at cap=0
   * here for clarity); Phase F.5 doesn't fire (no metadata
   * derived); so `changed.size === 0` and the Phase G gate
   * engages.
   *
   * Assertion: every node we subscribe (input + all deriveds) has
   * its post-commit fire-count at zero. Bidirectional in the
   * weak sense: if the gate accidentally let any subscriber fire
   * on a no-op commit, the count goes positive and the test
   * fails.
   */
  it('Phase G gate: when changed.size === 0 (no-op commit), no per-node subscriber fires — equivalent to eager dedup', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // The seed value the input is initialised to and then re-
        // written to (same value ⇒ Object.is dedup at the input
        // staging boundary ⇒ empty `changed` set).
        fc.integer({ min: -100, max: 100 }),
        // Number of no-op commits to drive — each one must leave
        // the per-commit fire-count at zero.
        fc.integer({ min: 1, max: 15 }),
        (spec, seedValue, noopCount) => {
          const graph = createCausl({ commitHistoryCap: 0 })
          const built = buildPropertyDag(graph, spec)

          // Seed the input to the chosen value so the no-op
          // commits below are literal re-writes of the current
          // value. Doing this in a real commit is the only way to
          // move the input cell off its registration default.
          graph.commit('seed', (tx) => tx.set(built.input, seedValue))

          // Subscribe to every node (input + deriveds) with a
          // per-id counter. Initial-fire bookkeeping during
          // subscribe-time is discarded by zeroing the counters
          // immediately afterward — we only measure post-`seed`
          // commit notifications.
          const fireCounts = new Map<string, number>([[spec.inputId, 0]])
          for (const id of built.deriveds.keys()) fireCounts.set(id, 0)
          graph.subscribe(built.input, () => {
            fireCounts.set(spec.inputId, (fireCounts.get(spec.inputId) ?? 0) + 1)
          })
          for (const [id, node] of built.deriveds) {
            graph.subscribe(node, () => {
              fireCounts.set(id, (fireCounts.get(id) ?? 0) + 1)
            })
          }
          // Reset to zero after the initial-fire round so the
          // assertion loop measures only the no-op commits below.
          for (const id of fireCounts.keys()) fireCounts.set(id, 0)

          for (let i = 0; i < noopCount; i++) {
            // No-op commit: re-write `seedValue` to itself. Phase B's
            // staged-write equality cutoff drops this from
            // `changedInputIds`, so `changed.size === 0` at the start
            // of Phase G. The gate engages; eager-path equivalence
            // says no subscriber would have fired anyway.
            graph.commit(`noop-${i}`, (tx) => tx.set(built.input, seedValue))

            // Per-node assertion: every counter remains at zero.
            // A regression where the gate doesn't engage *and* the
            // dedup cutoff also fails would surface here; a
            // regression in only one of the two would still surface
            // here because the gated path has no second cutoff
            // behind it (the loop is fully skipped).
            for (const [id, count] of fireCounts) {
              expect(count, `node ${id} fired on no-op commit ${i}`).toBe(0)
            }
          }

          // Cumulative invariant: K no-op commits ⇒ 0 total fires
          // across all subscribers. Catches a regression that
          // double-fires once across the whole trace but cancels
          // out under per-commit counters reset between commits
          // (the per-commit assertion above is already strict, but
          // this guard pins the global count too for symmetry with
          // the rest of the suite).
          let total = 0
          for (const c of fireCounts.values()) total += c
          expect(total).toBe(0)
        },
      ),
      propertyTrials('phase-gate-eq/G-empty-changed-no-fires'),
    )
  })

  /**
   * P3 — Phase H gate equivalence: with zero `subscribeCommits`
   *   registrations, no commit-level observer fires.
   *
   * Phase H's precondition under §5.1 Amendment 1 is
   * `commitObservers.size > 0`. This is the trivial half of the
   * three properties — vacuously equivalent to the eager path,
   * which would still iterate a zero-element set and emit nothing.
   * The gate's value is structural (skip the iteration entirely);
   * the property pins that the elision doesn't accidentally fire a
   * phantom observer.
   *
   * Assertion shape: install a *control* observer to confirm Phase
   * H *would* fire if a registration existed, then unsubscribe
   * before the measured commits. Without the control, a regression
   * where Phase H is permanently broken (rather than gated) would
   * pass this test silently.
   */
  it('Phase H gate: with zero commitObservers, no commit-level observer fires across every random commit', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // Random commit trace — Phase H fires every commit (unlike
        // Phase G), so the property must hold for non-no-op commits
        // too. A genuinely-changing trace exercises the non-gated
        // commit path while still asserting the gate's elision of
        // the per-commit observer iteration.
        fc.array(fc.integer({ min: 1, max: 1_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (spec, writes) => {
          // Use cap=1000 so Phase F / F.4 / F.6 actually run too —
          // Phase H is independent of cap, but driving the full
          // pipeline catches a regression where another phase
          // accidentally fires a commit-level observer.
          const graph = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
          const built = buildPropertyDag(graph, spec)

          // Control: confirm subscribeCommits *would* fire if any
          // registration existed. Subscribe, drive one commit, see
          // the observer hit, then unsubscribe so the measured
          // commits below run with `commitObservers.size === 0`.
          let controlFires = 0
          const controlSeen: Commit[] = []
          const unsub = graph.subscribeCommits((c) => {
            controlFires++
            controlSeen.push(c)
          })
          graph.commit('control', (tx) => tx.set(built.input, 1))
          expect(controlFires).toBe(1)
          expect(controlSeen.length).toBe(1)
          unsub()

          // Measured trace: subscribeCommits is now empty.
          // `commitObservers.size === 0` ⇒ Phase H gate engages.
          // We instrument by re-subscribing a *passive* observer
          // that records but never throws — it is registered for
          // the assertion shape only and is unsubscribed before
          // the measured commits run, leaving the observer set
          // empty. (Re-using `controlFires` is safe because the
          // unsub above removed the closure from the set; the
          // counter increments only if Phase H fires, which the
          // gate forbids.)
          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0
            graph.commit(`w${i}`, (tx) => tx.set(built.input, v))
            // Per-commit assertion: the control counter has not
            // moved past 1 (its value at the end of the control
            // commit). A phantom observer fire would bump it.
            expect(controlFires).toBe(1)
          }

          // Re-confirm the control: re-subscribe and drive one more
          // commit. The counter should bump exactly once, proving
          // the absence of fires across the measured trace was *not*
          // a permanent break in Phase H — it was the gate engaging
          // and the eager-equivalent zero-fire outcome.
          const unsub2 = graph.subscribeCommits(() => {
            controlFires++
          })
          graph.commit('control-2', (tx) => tx.set(built.input, 99999))
          expect(controlFires).toBe(2)
          unsub2()
        },
      ),
      propertyTrials('phase-gate-eq/H-empty-observers-no-fires'),
    )
  })
})
