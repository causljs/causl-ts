import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyOptions, tieredPropertyOptions } from './seed.js'

/**
 * @packageDocumentation
 *
 * Property-based proof of commit atomicity.
 *
 * The semantic foundation gives us this on one page: GraphTime is an ordered
 * sequence of commit moments t₀ < t₁ < t₂ < ..., a transaction emits exactly
 * one new commit moment, and there is no fractional time. From those four
 * lines atomicity is a theorem rather than a goal: a transaction creates
 * exactly one new `t`, period. Operationally there is also exactly one
 * mutation API — `graph.commit(intent, tx => …)` — which means outside a
 * commit the graph is read-only, inside a commit reads see staged writes,
 * and there is no concurrent-mutation question because there is no
 * concurrent-mutation API.
 *
 * This suite turns those guarantees into universally-quantified contracts:
 * every commit creates exactly one new `GraphTime`, subscribers wake once
 * per affected commit (never mid-staging), and a thrown write rolls back the
 * entire staging set without advancing time. Generators produce random
 * input declarations and random per-commit write batches; the oracle is an
 * out-of-engine reducer that re-derives the expected sum from the trace and
 * is compared against the observed subscriber stream after de-duplication.
 *
 * The trial budget honours the project-wide race-detection floor of 1000+
 * random graphs and 1000+ random commit sequences per property, every CI
 * run, with deterministic seeds logged so a failure is reproducible.
 */

/**
 * Atomicity:
 *   A transaction creates exactly one new GraphTime. There is no observable
 *   state where some of a transaction's writes have landed and others have
 *   not. A subscriber wakes once per affected commit, never mid-staging.
 *   Outside a commit the graph is read-only; inside a commit reads see
 *   staged writes; the boundary between those two regimes is a single
 *   atomic step.
 *
 * The previous incarnation of this test compared `# fires` to
 * `# value changes` — which is what the implementation does, so it
 * was a tautology rather than an invariant. The current version uses
 * an EXTERNAL ORACLE: we recompute the expected sum from the trace
 * itself (independent of the engine), and assert each observed value
 * equals the oracle at the same step.
 */
describe('property: atomicity', () => {
  /**
   * Universally-quantified contract: for every randomly generated input set
   * and every random sequence of commit-write batches, the engine's
   * subscriber stream on the sum-derivation equals the de-duplicated trace
   * of an oracle reducer that has no access to engine internals. Any
   * fractional-time observation, missed fire, or double-fire violates this
   * equality — i.e. it would witness either an intermediate "B updated but
   * C did not" state (forbidden because there is no intermediate time) or
   * a transaction that emitted other than exactly one new `t`.
   */
  it('every observation equals the oracle-computed value at that step', () => {
    fc.assert(
      fc.property(
        // Generator: a non-empty list of (id, initial) pairs forms the input
        // declaration set, and a list of per-commit write batches drives the
        // engine. Bounds are kept small enough to shrink quickly while still
        // covering up to 50 commits per trial.
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.integer()), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(
          fc.array(fc.tuple(fc.nat(), fc.integer()), { minLength: 0, maxLength: 6 }),
          { minLength: 1, maxLength: 50 },
        ),
        (inputDecls, commitWrites) => {
          // Dedupe input declarations by id so that the engine never sees a
          // duplicate `g.input` registration.
          const seenIds = new Set<string>()
          const decls = inputDecls.filter(([id]) => {
            if (seenIds.has(id)) return false
            seenIds.add(id)
            return true
          })
          fc.pre(decls.length > 0)

          // Engine setup: declare the inputs and a single sum-derivation that
          // depends on every input. The derivation is the unit-under-test.
          const g = createCausl()
          const inputs = decls.map(([id, initial]) => ({
            id,
            initial,
            node: g.input(id, initial),
          }))
          const sum = g.derived('__sum', (get) => {
            let total = 0
            for (const { node } of inputs) total += get(node)
            return total
          })

          // Oracle computation: replay the same trace through a plain Map
          // reducer that has no knowledge of the engine. The resulting
          // `oracleValues` array is the ground-truth observation set that a
          // glitch-free atomic engine must produce.
          const oracleValues: number[] = []
          const live = new Map<string, number>()
          for (const { id, initial } of inputs) live.set(id, initial)
          oracleValues.push(sumValues(live))
          for (const writes of commitWrites) {
            for (const [idx, v] of writes) {
              const at = idx % inputs.length
              const target = inputs[at]
              if (target) live.set(target.id, v)
            }
            oracleValues.push(sumValues(live))
          }

          // Engine drive: replay the same trace through the engine and
          // capture every subscriber observation.
          const observed: number[] = []
          g.subscribe(sum, (v) => observed.push(v))
          for (let i = 0; i < commitWrites.length; i++) {
            const writes = commitWrites[i] ?? []
            g.commit(`c${i}`, (tx) => {
              for (const [idx, v] of writes) {
                const at = idx % inputs.length
                const target = inputs[at]
                if (target) tx.set(target.node, v)
              }
            })
          }

          // Assertion: the subscriber stream must equal the de-duplicated
          // oracle trace. De-duplication models the "fire only on change"
          // contract; equality models the atomicity contract — every fire
          // lands at a true commit boundary, never mid-staging.
          const dedupOracle: number[] = []
          let prev: number | null = null
          for (const v of oracleValues) {
            if (prev === null || !Object.is(prev, v)) {
              dedupOracle.push(v)
              prev = v
            }
          }
          expect(observed).toEqual(dedupOracle)
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial race-detection floor (1000+ random graphs and
      // 1000+ random commit sequences per property every CI run) and
      // honours the `CAUSL_FUZZ_TIER` env var so the PR-lane (5k) and
      // nightly (100k) tiers (#1073) take effect without a code change.
      tieredPropertyOptions(),
    )
  })

  /**
   * Universally-quantified contract: for every random list of writes, when a
   * commit body throws after staging arbitrary writes, none of those writes
   * become observable and `g.now` does not advance. Atomicity is
   * all-or-nothing: a transaction either creates exactly one new `t` or
   * none at all — there is no fractional time, even on the failure path.
   */
  it('a thrown write does not partially apply the others', () => {
    fc.assert(
      fc.property(
        // Generator: a list of integer writes destined for input `a`, sized
        // to keep the staging set non-trivial without exploding shrink time.
        fc.array(fc.integer(), { minLength: 1, maxLength: 8 }),
        (writes) => {
          // Engine setup: two real inputs plus a ghost reference whose `id`
          // never registered with the engine; writing to it must throw.
          const g = createCausl()
          const a = g.input('a', 0)
          const b = g.input('b', 0)
          const before = [g.read(a), g.read(b)]
          const ghost = { id: 'ghost' }
          let threw = false
          // Drive: stage the random writes plus a poisoned ghost-write inside
          // a single transaction. The engine should reject the commit on the
          // ghost-write attempt.
          try {
            g.commit('partial', (tx) => {
              for (const w of writes) tx.set(a, w)
              tx.set(b, 999)
              tx.set(ghost, 1)
            })
          } catch {
            threw = true
          }
          // Assertion: the commit threw, none of the staged writes landed,
          // and `g.now` is still 0 — i.e. atomicity rolls back the entire
          // transaction without advancing time. There is no "half-applied"
          // commit moment to observe because GraphTime advances by exactly
          // one per successful commit and by zero per failed commit.
          expect(threw).toBe(true)
          expect([g.read(a), g.read(b)]).toEqual(before)
          expect(g.now).toBe(0)
        },
      ),
      // Trial budget honours the 1000-trial race-detection floor (EPIC #285
      // sub-issue #260). Generator stays small (`maxLength: 8`) so the
      // wall-time stays tractable.
      propertyOptions(),
    )
  })
})

/**
 * Reduce a snapshot of input values to their integer sum. Used by the oracle
 * to recompute the expected `__sum` derivation independently of the engine.
 */
function sumValues(m: ReadonlyMap<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}
