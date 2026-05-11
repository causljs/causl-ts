/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the Phase D capture-by-reference
 * refactor (#941) is denotationally a no-op.
 *
 * Background: PR #907 / #882 (Phase B array-fill) replaced the
 * per-write `entries.get(id)` Map probe in Phase B / C.5 / rollback
 * with a parallel `stagedEntries: InputEntry[]` array populated at
 * `tx.set` time. #941 mirrors that shape in Phase D's recompute
 * walker — `recomputeAffected` now captures the resolved
 * `DerivedEntry` reference once during the BFS over `dependents`
 * and walks the captured array (instead of looking each id up
 * through `entries.get(id)` on every Phase 4 iteration).
 *
 * The refactor is purely an internal optimisation: every observable
 * value at every `(input, derived)` pair must remain byte-identical
 * across arbitrary commit storms over arbitrary topologies. This
 * file is the cross-shape oracle that pins that claim.
 *
 * Why a property test rather than a fixed-shape regression: the
 * capture-by-reference pattern's failure modes are ones a fixed
 * topology can hide. A bug that drops the captured reference for
 * one branch of a diamond, or that under-walks a fan-out's tail,
 * would produce a stale value on a *specific* topology with a
 * *specific* commit pattern; only a generator that explores the
 * shape space surfaces the regression. The reference oracle is the
 * forward-evaluation walker mirrored from
 * `recompute-count-fuzz.property.test.ts` — a derived's value is
 * the sum of its declared deps' values, computed in topo order
 * (which `propertyDag` produces by construction). Asserting the
 * engine's `read` matches the oracle on every random commit catches
 * any divergence between the captured-reference walker and a
 * faithful `entries.get` walker.
 *
 * Trial floor: `propertyTrials('phase-d-entry-capture/...')` —
 * SPEC §15.2 1000-trial minimum, enforced by the helper.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
  type DagSpec,
} from '@causl/core-testing-internal'
import { createCausl } from '../../src/index.js'

/**
 * Reference oracle: forward-evaluation walker. `propertyDag`
 * produces deps strictly in topo order, so a single forward pass
 * computes every derived's value as the sum of its declared deps'
 * values (mirroring `buildPropertyDag`'s compute body).
 *
 * Returns a `Map<NodeId, number>` whose entries match what the
 * engine's `read(node)` should return after a commit that writes
 * `inputValue` to the single input.
 */
function oracleValues(spec: DagSpec, inputValue: number): Map<string, number> {
  const values = new Map<string, number>()
  values.set(spec.inputId, inputValue)
  for (const ds of spec.deriveds) {
    let sum = 0
    for (const depId of ds.deps) sum += values.get(depId) ?? 0
    values.set(ds.id, sum)
  }
  return values
}

describe('property: Phase D entry-capture denotational equivalence (#941)', () => {
  /**
   * P1 — single-write commit equivalence:
   *   For every random DAG and every random input write, every
   *   derived's `read(node)` value matches the oracle's forward
   *   evaluation. The captured-reference walker must agree with a
   *   faithful `entries.get` walker on every shape.
   *
   * Catches: any failure mode where a captured reference drops a
   * branch, a topo-ordering regression downstream of the rewrite,
   * or a stale-rollback leak that shows up as a wrong value on the
   * *next* commit.
   */
  it('every (input, derived) read matches the forward-evaluation oracle on every random DAG', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 12 }),
        fc.integer({ min: 1, max: 1_000 }),
        (spec, value) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)

          graph.commit('mutate-input', (tx) => tx.set(input, value))

          const oracle = oracleValues(spec, value)
          // Every derived node's engine value must match the oracle.
          for (const ds of spec.deriveds) {
            const node = deriveds.get(ds.id)
            // `deriveds` always contains every spec.deriveds id by
            // construction; non-null assertion is denotational.
            expect(node).toBeDefined()
            expect(graph.read(node!)).toBe(oracle.get(ds.id))
          }
          // The input itself must read back as the just-written value
          // (no Phase B leak).
          expect(graph.read(input)).toBe(value)
        },
      ),
      propertyTrials('phase-d-entry-capture/single-write-equivalence'),
    )
  })

  /**
   * P2 — commit-storm equivalence:
   *   For every random DAG and every random sequence of distinct
   *   integer writes, every derived's value at every commit boundary
   *   matches the oracle's forward evaluation against the just-
   *   written input value. Cumulatively pins that the captured-
   *   reference walker is denotationally a fixed point under
   *   repeated commits — a stale-reference leak that produced wrong
   *   values on the second or later commit would fail this clause
   *   even if the first commit happened to look right.
   */
  it('every read at every commit boundary in a random write storm matches the oracle', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (spec, writes) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i]!
            graph.commit(`w${i}`, (tx) => tx.set(input, v))

            const oracle = oracleValues(spec, v)
            // Every derived must agree with the oracle at this commit
            // boundary. A stale-rollback or stale-capture regression
            // would surface as the read returning a previous-commit
            // value here.
            for (const ds of spec.deriveds) {
              const node = deriveds.get(ds.id)!
              expect(graph.read(node)).toBe(oracle.get(ds.id))
            }
            expect(graph.read(input)).toBe(v)
          }
        },
      ),
      propertyTrials('phase-d-entry-capture/commit-storm-equivalence'),
    )
  })

  /**
   * P3 — equality-cutoff preservation:
   *   For every random DAG, a commit that writes the input's current
   *   value to itself leaves every derived's value byte-identical to
   *   its pre-commit value. Pins that the capture-by-reference
   *   refactor preserved the SPEC §5.1 equality-cutoff invariant —
   *   Object.is dedup at the input layer must still short-circuit
   *   the wavefront, and the refactored Phase 4 must not gratuitously
   *   touch derived values.
   */
  it('a commit that writes the input value to itself leaves every derived byte-identical', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 12 }),
        fc.integer({ min: 1, max: 1_000 }),
        (spec, initial) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)
          graph.commit('settle', (tx) => tx.set(input, initial))

          // Snapshot pre-noop reads.
          const before = new Map<string, number>()
          for (const ds of spec.deriveds) {
            before.set(ds.id, graph.read(deriveds.get(ds.id)!) as number)
          }

          // Noop commit — Object.is dedup must short-circuit.
          graph.commit('noop', (tx) => tx.set(input, initial))

          for (const ds of spec.deriveds) {
            expect(graph.read(deriveds.get(ds.id)!)).toBe(before.get(ds.id))
          }
        },
      ),
      propertyTrials('phase-d-entry-capture/noop-byte-identical'),
    )
  })
})
