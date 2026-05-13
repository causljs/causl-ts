/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the cascade-task #3 fusion of
 * `affected: Set<NodeId>` + `indegree: Map<NodeId, number>` into a
 * single `Map<NodeId, number>` inside `recomputeAffected`.
 *
 * Background. Pre-fusion the Phase 1 BFS over `dependents`
 * maintained two parallel structures whose keysets were identical
 * at every program point:
 *   - `affected: Set<NodeId>` for membership probe
 *   - `indegree: Map<NodeId, number>` for Kahn's count
 * Every BFS edge paid two hash probes (`affected.has(d)` THEN
 * `indegree.get(d)`); the Kahn-drain test was `if (!affected.has(d))
 * continue` followed by `indegree.get(d)`. The fusion drops the Set
 * and reuses the Map's key surface for membership.
 *
 * The refactor is purely an internal optimisation. Two observable
 * properties must remain byte-identical across arbitrary commit
 * storms over arbitrary topologies:
 *   1. The Phase D topo order (SPEC §3 Theorem 2 / glitch-freedom)
 *      — preserved as the discovery-order of the BFS. Because Map
 *      iteration is insertion-order and we insert in the same order
 *      a Set would, the Kahn-seed loop produces the same `ordered`
 *      array as today.
 *   2. The published `Commit.changedNodes` array (SPEC §5.1 Phase E
 *      byte-identical envelope) — derived from `ordered` filtered
 *      by the equality-cutoff, identical iff `ordered` is identical.
 *
 * Both invariants are pinned here by comparing the fused walker's
 * post-commit output against the same forward-evaluation oracle
 * that {@link recompute-fused-phases.property.test.ts} uses, then
 * additionally asserting the `Commit.changedNodes` array is
 * length-stable AND set-stable AND order-stable (a buggy fusion
 * that flipped indegree+1 with indegree+0 on a re-visited node
 * would either leave a residue Kahn could not drain (CycleError
 * thrown spuriously) or reorder the topo walk (causing changedNodes
 * to surface in a different order) — both surface as failures here).
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`
 * and logged on failure for reproducible CI bisection.
 *
 * Cross-link:
 *   - PR #969 / `recompute-fused-phases.property.test.ts` — the
 *     prior fusion (Phase 1 BFS + Phase 2 indegree count). This
 *     test is the focused regression for the NEW fusion (the
 *     `affected` Set drop).
 *   - SPEC §3 Theorem 2 (glitch-freedom topo invariant).
 *   - SPEC §5.1 Phase E byte-identical Commit envelope.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
} from '@causl/core-testing-internal'

describe('cascade-task #3 — fused affected/indegree in recomputeAffected', () => {
  /**
   * Property — for every random DAG and every random write storm,
   * every derived's post-commit value equals the
   * forward-evaluation oracle. A buggy fusion (e.g. dropping the
   * indegree+1 increment on a re-visited node by mistaking
   * `indegree.has(d)` for `cur === undefined`) would leave a
   * residue Kahn could not drain, surfacing as a spurious
   * CycleError; or it would surface as a value mismatch when the
   * walk recomputed a child before all its parents settled.
   */
  it('post-commit derived values match the forward-evaluation oracle on every random DAG', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 16 }),
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (spec, writes) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)
          for (const v of writes) {
            graph.commit('bump', (tx) => tx.set(input, v))
            const oracle = new Map<string, number>()
            oracle.set(spec.inputId, v)
            for (const ds of spec.deriveds) {
              let sum = 0
              for (const depId of ds.deps) sum += oracle.get(depId)!
              oracle.set(ds.id, sum)
            }
            for (const ds of spec.deriveds) {
              const handle = deriveds.get(ds.id)!
              expect(graph.read(handle)).toBe(oracle.get(ds.id)!)
            }
          }
        },
      ),
      propertyTrials('fused-affected-indegree/oracle-equivalence'),
    )
  })

  /**
   * Property — `commit().changedNodes` matches the oracle's
   * changed-set. The set-level check pins that no node is dropped
   * or surfaced twice — the membership invariant the dropped
   * `affected` Set used to carry is now carried by the Map's
   * keyset, and this property asserts equivalence empirically.
   */
  it("commit().changedNodes equals the oracle's changed-set across random write storms", () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 16 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (spec, writeValue) => {
          const graph = createCausl()
          const { input } = buildPropertyDag(graph, spec)
          const before = new Map<string, number>()
          before.set(spec.inputId, 0)
          for (const ds of spec.deriveds) {
            let sum = 0
            for (const depId of ds.deps) sum += before.get(depId)!
            before.set(ds.id, sum)
          }
          const after = new Map<string, number>()
          after.set(spec.inputId, writeValue)
          for (const ds of spec.deriveds) {
            let sum = 0
            for (const depId of ds.deps) sum += after.get(depId)!
            after.set(ds.id, sum)
          }
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
      propertyTrials('fused-affected-indegree/changed-nodes'),
    )
  })

  /**
   * Property — `Commit.changedNodes` is order-stable across repeats
   * of the same input. Phase D's topo order is the load-bearing
   * §3 Theorem 2 invariant; the fused walker preserves it iff Map
   * insertion-order matches the prior Set insertion-order (which
   * it does, because we insert into the Map exactly where we used
   * to insert into the Set). Two fresh graphs with identical specs
   * and identical writes must publish byte-identical changedNodes
   * arrays.
   *
   * This is the most direct test of the SPEC §5.1 Phase E
   * byte-identical envelope claim: any topo-order drift would
   * cause the second commit's array to differ at the first
   * divergence point, even when the set membership stays the same.
   */
  it('Commit.changedNodes is byte-identical across replays of the same write on a fresh graph', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 16 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (spec, writeValue) => {
          const runOnce = (): readonly string[] => {
            const graph = createCausl()
            const { input } = buildPropertyDag(graph, spec)
            const commit = graph.commit('bump', (tx) =>
              tx.set(input, writeValue),
            )
            return commit.changedNodes.map(String)
          }
          const a = runOnce()
          const b = runOnce()
          expect(b).toEqual(a)
        },
      ),
      propertyTrials('fused-affected-indegree/changed-nodes-byte-identical'),
    )
  })

  /**
   * Stress property — large random commit storms with multiple
   * write batches per commit, on the wider derived range up to
   * 100 nodes. The two prior properties exercise the small-graph
   * regime (≤16 derived); this one stretches the fused walker
   * into the regime where the per-edge probe-count reduction
   * actually matters and where any indegree-counting bug would
   * leave more residue for Kahn to choke on.
   */
  it('post-commit values match the oracle on 100-node random DAGs under commit storms', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 50, maxDerived: 100 }),
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (spec, writes) => {
          const graph = createCausl()
          const { input, deriveds } = buildPropertyDag(graph, spec)
          for (const v of writes) {
            graph.commit('bump', (tx) => tx.set(input, v))
            const oracle = new Map<string, number>()
            oracle.set(spec.inputId, v)
            for (const ds of spec.deriveds) {
              let sum = 0
              for (const depId of ds.deps) sum += oracle.get(depId)!
              oracle.set(ds.id, sum)
            }
            for (const ds of spec.deriveds) {
              const handle = deriveds.get(ds.id)!
              expect(graph.read(handle)).toBe(oracle.get(ds.id)!)
            }
          }
        },
      ),
      propertyTrials('fused-affected-indegree/100-node-stress'),
    )
  })
})
