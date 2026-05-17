/**
 * @packageDocumentation
 *
 * Random-DAG generator + builder for property-based engine tests
 * (EPIC #285 sub-issue #297).
 *
 * Produces by-construction acyclic dependency graphs of bounded
 * size, ready to drive against `createCausl()` for atomicity,
 * determinism, glitch-freedom, and dynamic-dep property suites.
 * One input followed by N derived nodes, each depending on a
 * non-empty random subset of earlier nodes — topologically
 * ordered, cycle-free by construction.
 *
 * Property-based tests are the engine's race-detection layer for
 * everything the type system and API shape don't catch. Five
 * load-bearing property families lean on this generator:
 *
 * - **Stale-async correctness** — random interleavings of
 *   (commit, fetch-start, fetch-resolve, …) must end in a state
 *   consistent with the configured resource policy.
 * - **Dynamic-dependency cleanup** — random derivations that
 *   switch inputs on conditional reads, followed by random
 *   commits, must leave no orphan dependency listening on a node
 *   it no longer reads.
 * - **Cycle detection completeness** — every cycle that exists
 *   in any random graph must be caught by the first commit that
 *   closes it; no cycle may go undetected.
 * - **Diamond glitch-freedom** — every observable must equal `f`
 *   of its dependencies' values *at the same `GraphTime`*, never
 *   an interleaved pair.
 * - **Replay determinism** — a recorded commit sequence replayed
 *   on a fresh graph must produce a byte-identical state.
 *
 * The trial budget for each family is 1000+ random graphs and
 * 1000+ random commit sequences per property, every CI run, with
 * deterministic logged seeds so failures are reproducible.
 *
 * The generator is the canonical seam for property tests across
 * the workspace: extracting it here means atomicity, determinism,
 * cycle-completeness, replay-determinism etc. all share the same
 * generator and the same shape invariants. A future change to the
 * generator (e.g. richer dependency patterns) lands once and
 * propagates everywhere.
 */

import * as fc from 'fast-check'
import type {
  DerivedNode,
  Graph,
  InputNode,
  Node,
} from '@causljs/core'

/**
 * Specification of a derived node in a random DAG.
 *
 * @remarks
 * `id` is unique within the DAG. `deps` reference earlier ids in
 * topo order, so the DAG is by-construction acyclic.
 */
export interface DerivedSpec {
  readonly id: string
  readonly deps: readonly string[]
}

/**
 * Top-level shape produced by {@link propertyDag} — one input id
 * followed by an ordered list of derived specs.
 */
export interface DagSpec {
  readonly inputId: string
  readonly deriveds: readonly DerivedSpec[]
}

/**
 * Caller-supplied bounds for {@link propertyDag}. Both bounds are
 * inclusive; defaults are `{ minDerived: 2, maxDerived: 12 }`,
 * matching the canonical small-graph property workload.
 */
export interface PropertyDagOptions {
  /** Minimum number of derived nodes (≥0). Default 2. */
  readonly minDerived?: number
  /** Maximum number of derived nodes (≥minDerived). Default 12. */
  readonly maxDerived?: number
}

/**
 * `fc.Arbitrary` producing a random acyclic DAG. The result has
 * exactly one input id (`"n0"`) and `min ≤ N ≤ max` derived nodes
 * (`"n1".."nN"`), each declaring a non-empty random subset of
 * earlier ids as deps. By-construction cycle-free; suitable for
 * driving the engine in any property test that needs an acyclic
 * fixture.
 *
 * @param opts - Bounds on the derived-node count (see
 *  {@link PropertyDagOptions}).
 * @returns An arbitrary producing a {@link DagSpec}.
 */
export function propertyDag(opts?: PropertyDagOptions): fc.Arbitrary<DagSpec> {
  const min = opts?.minDerived ?? 2
  const max = opts?.maxDerived ?? 12
  return fc.integer({ min, max }).chain((n) => {
    const inputId = 'n0'
    const derivedIds = Array.from({ length: n }, (_, i) => `n${i + 1}`)
    if (derivedIds.length === 0) {
      return fc.constant({ inputId, deriveds: [] as readonly DerivedSpec[] })
    }
    return fc
      .tuple(
        ...derivedIds.map((id, i) => {
          const candidates = [inputId, ...derivedIds.slice(0, i)]
          return fc
            .uniqueArray(fc.constantFrom(...candidates), {
              minLength: 1,
              maxLength: candidates.length,
            })
            .map((deps) => ({ id, deps }) as DerivedSpec)
        }),
      )
      .map((deriveds) => ({ inputId, deriveds }) as DagSpec)
  })
}

/**
 * Construct a DAG on `graph` from a {@link DagSpec}. Each derived
 * is registered with a sum-of-deps compute so its value depends
 * structurally on every dep edge.
 *
 * @param graph - Engine instance the DAG is registered on.
 * @param spec - Topology produced by {@link propertyDag}.
 * @returns The registered handles, keyed by id, for assertion
 *  by callers that need to read or commit against them.
 */
export function buildPropertyDag(
  graph: Graph,
  spec: DagSpec,
): {
  readonly input: InputNode<number>
  readonly deriveds: ReadonlyMap<string, DerivedNode<number>>
} {
  const input = graph.input(spec.inputId, 0)
  const deriveds = new Map<string, DerivedNode<number>>()
  for (const ds of spec.deriveds) {
    const handle = graph.derived<number>(ds.id, (get) => {
      let sum = 0
      for (const depId of ds.deps) {
        const node =
          depId === spec.inputId
            ? (input as Node<number>)
            : (deriveds.get(depId)! as Node<number>)
        sum += get(node)
      }
      return sum
    })
    deriveds.set(ds.id, handle)
  }
  return { input, deriveds }
}
