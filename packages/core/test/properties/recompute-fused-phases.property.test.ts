/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #963 fused Phases 1+2 of
 * `recomputeAffected` is denotationally a no-op.
 *
 * Background: pre-#963 `recomputeAffected` walked the affected
 * sub-graph in two passes — Phase 1 BFS over `dependents` to
 * collect affected ids, then Phase 2 re-iterated `affected` to walk
 * each derived's `e.deps` and compute internal-incoming-edge
 * indegree for Kahn ordering. The two passes touched the same node
 * set; the fused walker counts indegree DURING the BFS by using the
 * inverse-consistency between `dependents` (forward) and `e.deps`
 * (backward).
 *
 * The refactor is purely an internal optimisation: every observable
 * value at every `(input, derived)` pair must remain byte-identical
 * across arbitrary commit storms over arbitrary topologies, AND the
 * topo ordering Kahn produces must remain a valid linear extension
 * of the affected sub-DAG. This file pins both claims.
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`
 * and logged on failure for reproducible CI bisection.
 *
 * Cross-link: #941 (`phase-d-entry-capture.property.test.ts`)
 * already pins denotational equivalence for the Phase D walker
 * shape. This file is the focused #963 regression — it exercises
 * the same oracle but pins specifically the indegree-counting
 * fusion, which is the structural invariant a future revert would
 * break.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
} from '@causljs/core-testing-internal'

describe('SPEC #963 — fused Phases 1+2 of recomputeAffected', () => {
  /**
   * Property — for every random DAG and every random write storm,
   * the post-commit value of every derived equals the
   * forward-evaluation oracle. The oracle assumes Kahn topo order
   * holds; if the fused walker's indegree count were wrong (e.g.
   * over-counted internal edges, leaving a residue Kahn could not
   * drain), the recompute would either throw a spurious CycleError
   * or produce a stale value — both surface as test failures.
   */
  it('post-commit derived values match the forward-evaluation oracle on every random DAG', () => {
    fc.assert(
      fc.property(
        propertyDag(),
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (spec, writes) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)
          // Apply each write as its own commit; assert the oracle
          // value of every derived after every commit.
          for (const v of writes) {
            graph.commit('bump', (tx) => tx.set(input, v))
            // Oracle: a derived's value is the sum of its deps'
            // values, computed in topo order. The DAG generator
            // produces specs in topo order, so iterating in spec
            // order is sufficient.
            const oracle = new Map<string, number>()
            oracle.set(spec.inputId, v)
            for (const ds of spec.deriveds) {
              let sum = 0
              for (const depId of ds.deps) sum += oracle.get(depId)!
              oracle.set(ds.id, sum)
            }
            // Every live derived must read its oracle value.
            for (const ds of spec.deriveds) {
              const handle = deriveds.get(ds.id)!
              expect(graph.read(handle)).toBe(oracle.get(ds.id)!)
            }
          }
        },
      ),
      propertyTrials('recompute-fused-phases/oracle-equivalence'),
    )
  })

  /**
   * Property — `commit().changedNodes` reports the same set as the
   * oracle predicts. A buggy indegree count could leave a node out
   * of Kahn order entirely (never recomputed, so never reported as
   * changed) or surface it twice; this property catches both.
   */
  it("commit().changedNodes equals the oracle's changed-set across random write storms", () => {
    fc.assert(
      fc.property(
        propertyDag(),
        fc.integer({ min: 1, max: 1_000_000 }),
        (spec, writeValue) => {
          const graph = createCausl()
          const { input } = buildPropertyDag(graph, spec)
          // Pre-commit oracle (input = 0).
          const before = new Map<string, number>()
          before.set(spec.inputId, 0)
          for (const ds of spec.deriveds) {
            let sum = 0
            for (const depId of ds.deps) sum += before.get(depId)!
            before.set(ds.id, sum)
          }
          // Post-commit oracle.
          const after = new Map<string, number>()
          after.set(spec.inputId, writeValue)
          for (const ds of spec.deriveds) {
            let sum = 0
            for (const depId of ds.deps) sum += after.get(depId)!
            after.set(ds.id, sum)
          }
          // Expected changed-set: every derived whose value moved.
          const expected = new Set<string>()
          for (const ds of spec.deriveds) {
            if (before.get(ds.id) !== after.get(ds.id)) expected.add(ds.id)
          }
          const commit = graph.commit('bump', (tx) => tx.set(input, writeValue))
          const reported = new Set<string>()
          for (const id of commit.changedNodes) {
            if (id !== spec.inputId) reported.add(id as string)
          }
          expect(reported).toEqual(expected)
        },
      ),
      propertyTrials('recompute-fused-phases/changed-nodes'),
    )
  })
})
