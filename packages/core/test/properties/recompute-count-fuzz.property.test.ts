/**
 * @packageDocumentation
 *
 * Property-based fuzz of the recompute-count invariant (#250).
 *
 * `perf-recompute.test.ts` ships fixed-shape gates — chain, diamond,
 * single-input, no-op. Necessary, but the §14 invariant is not "the
 * engine recomputes correctly on these four shapes": it is *for any
 * shape*, a commit producing N derived recomputations runs O(N), not
 * O(graph size). The fixed cases assert §14 on canonical shapes; this
 * file asserts §14 on the shape space `propertyDag` actually claims.
 *
 * The 50-trial pattern that bit Epic A #180 and Epic B-Concurrent #189
 * is the regression case for this test. To prevent that drift, trial
 * budget is sourced from `propertyTrials('label')` from the testing
 * seam — sub-1000 `numRuns` throws unless `unsafeTrials` is passed,
 * which the lint rule rejects without a documented exception. Using
 * `propertyTrials` rather than the local `propertyOptions` is the
 * contract anchor the cross-cutting review calls out by name.
 *
 * The reference walker (`affectedFromInput`) lives in this file, NOT
 * in the engine — otherwise the test couldn't fail when the engine
 * over- or under-walks. Per-id assertions (`counter.count(id) === 1`
 * for affected, `=== 0` for non-affected) are bidirectional: a leak
 * in one node and a miss in another can't average out under
 * `counter.total()` alone.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  propertyDag,
  propertyTrials,
  recomputeCounter,
  type DagSpec,
} from '@causl/core-testing-internal'
import { createCausl } from '../../src/index.js'

/**
 * Reference walker (oracle): forward-reachable derived ids from the
 * single mutated input. A derived is in the affected set iff at least
 * one of its declared deps is affected (or is the input itself).
 *
 * `propertyDag` produces deps strictly in topo order, so a single
 * forward pass is sufficient — no iteration to fixpoint needed. The
 * input id is removed from the result before comparison because the
 * engine's recompute counter measures *derived* recomputes, not the
 * input write itself.
 */
function affectedFromInput(spec: DagSpec): Set<string> {
  const affected = new Set<string>([spec.inputId])
  for (const ds of spec.deriveds) {
    if (ds.deps.some((d) => affected.has(d))) affected.add(ds.id)
  }
  affected.delete(spec.inputId)
  return affected
}

/**
 * Build a `propertyDag` graph but wrap every derived's compute with
 * `counter.wrap(fn, id)` so the recompute counter sees per-node hits.
 * The compute body is the canonical sum-of-deps from
 * `buildPropertyDag`, mirrored here (rather than reused) so the
 * counter wrapping happens at registration time — `buildPropertyDag`
 * registers raw computes by design, which is what every other
 * property suite needs.
 */
function buildInstrumentedDag(spec: DagSpec): {
  readonly graph: ReturnType<typeof createCausl>
  readonly input: ReturnType<ReturnType<typeof createCausl>['input']>
  readonly counter: ReturnType<typeof recomputeCounter>
  readonly deriveds: ReadonlyMap<
    string,
    ReturnType<ReturnType<typeof createCausl>['derived']>
  >
} {
  const graph = createCausl()
  const counter = recomputeCounter()
  // Use buildPropertyDag for the dependency wiring, but wrap each
  // compute via the counter. We register input directly (so we hold
  // a typed handle); the rest mirrors buildPropertyDag's body with
  // counter.wrap injected.
  const input = graph.input(spec.inputId, 0)
  const deriveds = new Map<
    string,
    ReturnType<ReturnType<typeof createCausl>['derived']>
  >()
  for (const ds of spec.deriveds) {
    const handle = graph.derived<number>(
      ds.id,
      counter.wrap((get) => {
        let sum = 0
        for (const depId of ds.deps) {
          const node =
            depId === spec.inputId
              ? input
              : deriveds.get(depId)!
          sum += get(node) as number
        }
        return sum
      }, ds.id),
    )
    deriveds.set(ds.id, handle)
  }
  return { graph, input, counter, deriveds }
}

/**
 * Force initial settle: subscribe to every derived so the engine's
 * eager-on-registration computes are accounted as setup, not as the
 * recompute event being measured. The test resets the counter after
 * settle so only post-mutation computes count.
 */
function settle(deriveds: ReadonlyMap<string, unknown>, graph: ReturnType<typeof createCausl>): void {
  for (const node of deriveds.values()) {
    graph.subscribe(node as Parameters<typeof graph.subscribe>[0], () => {})
  }
}

describe('property: recompute-count fuzz over random DAGs (#250)', () => {
  /**
   * P1 — recompute count equals oracle's `|affected|`:
   *   For every random DAG and every random write to the single input,
   *   the engine recomputes exactly the forward-reachable set from the
   *   input — no over-walks, no under-walks. Per-id assertions are
   *   bidirectional: every affected id recomputes once, every non-
   *   affected id recomputes zero. `counter.total() === affected.size`
   *   pins the sum invariant; per-id pins the partition.
   *
   * Random integer write avoids the Object.is dedup short-circuit by
   * starting input at 0 and writing a non-zero value (when generated;
   * separate property covers the no-op case).
   */
  it('engine recomputes exactly |affected(input)| derivations on every random DAG', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 12 }),
        fc.integer({ min: 1, max: 1_000 }), // non-zero ⇒ Object.is dedup never fires
        (spec, value) => {
          const { graph, input, counter, deriveds } = buildInstrumentedDag(spec)
          settle(deriveds, graph)
          counter.reset()

          graph.commit('mutate-input', (tx) => tx.set(input, value))

          const affected = affectedFromInput(spec)

          // Sum invariant: total recomputes equals |affected|. Pinned
          // independently of the per-id partition so a regression that
          // miscounts in one direction can't balance against the
          // other.
          expect(counter.total()).toBe(affected.size)

          // Per-id partition: affected ids recompute exactly once, non-
          // affected ids recompute exactly zero. Bidirectional
          // assertion — over-walk fails the second clause, under-walk
          // fails the first.
          for (const ds of spec.deriveds) {
            const expected = affected.has(ds.id) ? 1 : 0
            expect(counter.count(ds.id)).toBe(expected)
          }
        },
      ),
      propertyTrials('recompute-count-fuzz/affected-equals-recomputes'),
    )
  })

  /**
   * P2 — no-op commit recomputes nothing:
   *   For every random DAG, a commit that writes the input's current
   *   value triggers zero recomputes anywhere in the graph (Object.is
   *   dedup at the input layer prevents the wavefront from starting).
   *   This is the §14 invariant at the boundary case `|affected| = 0` —
   *   "O(N) where N=0" must be exactly zero recomputes, not "small".
   */
  it('a commit that writes the input value to itself recomputes nothing', () => {
    fc.assert(
      fc.property(propertyDag({ minDerived: 1, maxDerived: 12 }), (spec) => {
        const { graph, input, counter, deriveds } = buildInstrumentedDag(spec)
        settle(deriveds, graph)
        counter.reset()

        // Write the current value back; Object.is dedup must short-
        // circuit the wavefront entirely.
        graph.commit('noop', (tx) => tx.set(input, 0))

        expect(counter.total()).toBe(0)
        for (const ds of spec.deriveds) {
          expect(counter.count(ds.id)).toBe(0)
        }
      }),
      propertyTrials('recompute-count-fuzz/noop-zero'),
    )
  })

  /**
   * P3 — multi-commit fuzz:
   *   For every random DAG and every random sequence of distinct
   *   integer writes, every commit recomputes exactly `|affected|`
   *   derivations. The affected set is shape-invariant for this
   *   generator (single input, fixed deps), so the per-commit count
   *   is constant — but the per-id partition repeats every commit and
   *   the cumulative `counter.total()` after K commits equals
   *   `K × affected.size`.
   *
   * Catches the dep-flip regression class the cross-cutting review
   * called out: a derived that retained a stale dep edge would
   * over-walk on subsequent commits, surfacing as a per-commit count
   * higher than the static `|affected|`.
   */
  it('K random commits trigger exactly K × |affected| recomputes total', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // Distinct writes — shrink-friendly fc.uniqueArray ensures
        // every commit is non-noop, so per-commit `|affected|` is
        // exact rather than ≤.
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (spec, writes) => {
          const { graph, input, counter, deriveds } = buildInstrumentedDag(spec)
          settle(deriveds, graph)
          counter.reset()

          const affected = affectedFromInput(spec)

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i]!
            const before = counter.total()
            graph.commit(`w${i}`, (tx) => tx.set(input, v))
            const delta = counter.total() - before
            // Per-commit invariant: exactly `|affected|` recomputes
            // per commit, no fewer (under-walk) and no more
            // (over-walk / stale-dep leak).
            expect(delta).toBe(affected.size)
          }

          // Cumulative invariant: K commits × |affected| recomputes
          // each. A dep-flip regression where one node started over-
          // walking partway through the trace would fail this clause
          // even if the first commit happened to look right.
          expect(counter.total()).toBe(writes.length * affected.size)
        },
      ),
      propertyTrials('recompute-count-fuzz/multi-commit-cumulative'),
    )
  })

  /**
   * Self-check: oracle correctness. A degenerate constant-shape DAG
   * with known `|affected|` validates `affectedFromInput` against the
   * fixture — without this, a buggy oracle that always returned the
   * full derived set would silently let the engine pass even when it
   * over-walked.
   */
  it('oracle: affectedFromInput agrees with hand-computed cases', () => {
    // Linear chain n0 → n1 → n2 → n3: every derived is affected by
    // the input.
    const chain: DagSpec = {
      inputId: 'n0',
      deriveds: [
        { id: 'n1', deps: ['n0'] },
        { id: 'n2', deps: ['n1'] },
        { id: 'n3', deps: ['n2'] },
      ],
    }
    expect([...affectedFromInput(chain)].sort()).toEqual(['n1', 'n2', 'n3'])

    // Diamond: every derived reachable from n0.
    const diamond: DagSpec = {
      inputId: 'n0',
      deriveds: [
        { id: 'n1', deps: ['n0'] },
        { id: 'n2', deps: ['n0'] },
        { id: 'n3', deps: ['n1', 'n2'] },
      ],
    }
    expect([...affectedFromInput(diamond)].sort()).toEqual(['n1', 'n2', 'n3'])
  })
})
