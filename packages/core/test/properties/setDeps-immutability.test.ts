/**
 * @packageDocumentation
 *
 * Property-based proof of the `setDeps` swap-not-mutate invariant
 * (#703 Win 3 acceptance gate).
 *
 * The audit's third optimisation drops the `new Set(e.deps)` clone in
 * the Phase D / Phase F.5 rollback capture sites and at the recompute
 * driver's "did the dep set shift?" probe, replacing the clone with a
 * by-reference capture. The optimisation is sound iff `setDeps` never
 * mutates a previously-captured deps Set after capture — the engine's
 * internal contract is that `setDeps` swaps `e.deps` to a fresh Set
 * reference rather than calling `add`/`delete` on the existing one.
 *
 * This suite turns that contract into a universally-quantified
 * property: across 1000+ random DAGs and 1000+ random commit
 * sequences, capture each derived's `deps` Set BEFORE the commit
 * sequence and assert it is byte-identical AFTER the sequence — same
 * size, same membership. A buggy refactor that mutated the captured
 * Set in place would fail the membership invariant on the first run
 * that reshapes a derived's read-set.
 *
 * Trial budget honours the project-wide ≥1000-run floor (see
 * `propertyTrials`); seeds are deterministic via `CAUSL_FUZZ_SEED` and
 * logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  derivedDeps,
  propertyDag,
  propertyTrials,
  type DagSpec,
} from '@causljs/core-testing-internal'
import { createCausl } from '../../src/index.js'

/**
 * Snapshot every derived's deps as a captured `(reference, members)`
 * pair. The reference is the engine's live Set instance; the members
 * are a structural copy taken at capture time so the assertion can
 * detect mutation through the reference (which would change the
 * reference's `.size` / iteration order without changing identity).
 */
function captureDeps(
  graph: ReturnType<typeof createCausl>,
  spec: DagSpec,
): ReadonlyMap<string, { ref: ReadonlySet<string>; members: readonly string[] }> {
  const out = new Map<
    string,
    { ref: ReadonlySet<string>; members: readonly string[] }
  >()
  for (const ds of spec.deriveds) {
    const ref = derivedDeps(graph, ds.id)
    if (ref === null) continue
    out.set(ds.id, {
      ref,
      members: Array.from(ref).sort(),
    })
  }
  return out
}

/**
 * Build the DAG fixture: an input + chain of `sum-of-deps` deriveds
 * registered in topo order. Returns the input handle so the property
 * driver can issue commits against it.
 */
function buildDag(
  spec: DagSpec,
): {
  readonly graph: ReturnType<typeof createCausl>
  readonly input: ReturnType<ReturnType<typeof createCausl>['input']>
} {
  const graph = createCausl()
  const input = graph.input(spec.inputId, 0)
  const handles = new Map<string, ReturnType<ReturnType<typeof createCausl>['derived']>>()
  for (const ds of spec.deriveds) {
    const handle = graph.derived<number>(ds.id, (get) => {
      let sum = 0
      for (const depId of ds.deps) {
        const node = depId === spec.inputId ? input : handles.get(depId)!
        sum += get(node) as number
      }
      return sum
    })
    handles.set(ds.id, handle)
  }
  return { graph, input }
}

describe('property: setDeps swap-not-mutate invariant (#703 Win 3)', () => {
  /**
   * Universally-quantified contract: for any random DAG and any
   * random sequence of input writes, every captured `deps` Set
   * reference must remain byte-identical (same size, same members)
   * across the entire sequence. The audit's load-bearing claim — that
   * `setDeps` swaps the reference rather than mutating in place — is
   * exactly what makes the by-reference rollback capture sound.
   *
   * The structural-copy `members` array is the witness: a buggy
   * refactor that called `Set#add`/`Set#delete` on the captured
   * reference would shift `ref.size` or `Array.from(ref)` while
   * leaving the reference identity intact — caught by the
   * post-sequence membership assertion.
   */
  it('captured deps Set is byte-identical after arbitrary commit sequences (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 10 }),
        // Random commit sequence: each entry is the integer to write
        // to the single input. Distinct values (mostly) bypass the
        // Object.is dedup so the recompute fixpoint actually runs.
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (spec, writes) => {
          const { graph, input } = buildDag(spec)

          // Capture every derived's live deps reference at the
          // pre-sequence moment.
          const captured = captureDeps(graph, spec)

          // Drive the random commit sequence through the engine.
          // `setDeps` runs on every recomputed derived inside Phase D;
          // each call must SWAP `e.deps` to a fresh Set, not mutate
          // the captured reference.
          for (let i = 0; i < writes.length; i++) {
            graph.commit(`bump-${i}`, (tx) => tx.set(input, writes[i]!))
          }

          // Assert: every captured reference has the same size and
          // the same membership set as at capture time. Identity of
          // the reference itself does not need to be preserved (the
          // engine may swap), but mutation through the reference is
          // the violation.
          for (const [id, cap] of captured) {
            const after = Array.from(cap.ref).sort()
            expect(after.length).toBe(cap.members.length)
            expect(after).toEqual(cap.members)
          }
          // Sanity check: every spec'd derived was captured (the
          // engine always populates `deps` after the eager initial
          // compute).
          expect(captured.size).toBe(spec.deriveds.length)
        },
      ),
      propertyTrials('setDeps-immutability/swap-not-mutate'),
    )
  })

  /**
   * Strengthened variant: the load-bearing rollback case. Build a
   * graph with one derived that throws on a sentinel input value;
   * run a successful commit (so derived rollback bookkeeping has a
   * non-trivial pre-state to capture), then write the sentinel value
   * to trigger the throw inside Phase D recompute. The commit() catch
   * arm reaches into `derivedRollback` and calls `setDeps(id,
   * prior.deps)` with the captured-by-reference set; the engine must
   * not mutate the captured reference even when that reference is
   * round-tripped through `setDeps`.
   *
   * Trial axis: random non-sentinel values driving the pre-throw
   * recompute. The sentinel is fixed (-9999) and reserved by the
   * generator's range so the property never collides with it
   * accidentally.
   */
  it('rollback path round-trips the captured reference without mutation (≥1000 cases)', () => {
    const SENTINEL = -9999
    fc.assert(
      fc.property(
        // Random non-sentinel value drives the pre-throw recompute.
        fc.integer({ min: 1, max: 100 }),
        (warmupValue) => {
          const graph = createCausl()
          const a = graph.input('a', 0)
          const b = graph.input('b', 0)
          // Derived reads BOTH inputs (so the dep set is `{a, b}`)
          // and throws on the sentinel — the throw escapes Phase D
          // recompute, exercising the catch-arm rollback that calls
          // `setDeps(id, prior.deps)` with a captured-by-reference
          // set.
          const trackedId = 'tracked'
          graph.derived<number>(trackedId, (get) => {
            const av = get(a) as number
            const bv = get(b) as number
            if (av === SENTINEL) {
              throw new Error('property-test rollback trigger')
            }
            return av + bv
          })

          // Capture the deps Set BEFORE any commit.
          const trackedRefPre = derivedDeps(graph, trackedId)!
          const trackedMembersPre = Array.from(trackedRefPre).sort()

          // Pre-throw commit: drives a normal recompute through
          // setDeps, validating the captured-pre reference survives
          // a non-throwing recompute.
          graph.commit('warmup', (tx) => tx.set(b, warmupValue))

          // Re-capture so the rollback variant sees a post-settle
          // reference (which is what derivedRollback captures and
          // hands back into setDeps on throw).
          const trackedRefPost = derivedDeps(graph, trackedId)!
          const trackedMembersPost = Array.from(trackedRefPost).sort()

          // Throwing commit: the sentinel write triggers the
          // derived's throw inside Phase D. The catch arm runs
          // `setDeps(id, prior.deps)` with the captured-by-reference
          // post-settle set.
          let threw = false
          try {
            graph.commit('throw', (tx) => tx.set(a, SENTINEL))
          } catch (e) {
            threw = true
            expect((e as Error).message).toBe('property-test rollback trigger')
          }
          expect(threw).toBe(true)

          // Both captured references must remain byte-identical:
          // the recompute driver swaps `e.deps`, the rollback path
          // round-trips through setDeps, and at no point does the
          // engine mutate either captured Set.
          expect(Array.from(trackedRefPre).sort()).toEqual(trackedMembersPre)
          expect(Array.from(trackedRefPost).sort()).toEqual(trackedMembersPost)
        },
      ),
      propertyTrials('setDeps-immutability/rollback-roundtrip'),
    )
  })
})
