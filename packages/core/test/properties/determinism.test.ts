import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl, type InputNode } from '../../src/index.js'
import { tieredPropertyOptions } from './seed.js'

/**
 * @packageDocumentation
 *
 * Property-based proof of replay determinism.
 *
 * The semantic equation for a derived value is `derived(t) = f(b₁(t), ...,
 * bₙ(t))` — a pure function of its dependencies' values *at the same `t`*.
 * Determinism falls out as a theorem: two implementations either agree, or
 * one of them is wrong. A recorded commit sequence replayed on a fresh
 * graph must therefore produce byte-identical state, because every step in
 * the replay is the same function applied to the same arguments.
 *
 * This suite turns that theorem into a universally-quantified contract:
 * two fresh graphs that share a declaration set and commit trace must agree
 * byte-for-byte on every input read, every derived read, and the final
 * `GraphTime`. A divergence between the two would prove the engine is
 * observing non-deterministic scheduler state — i.e. it is using something
 * other than the function `f(b₁(t), ..., bₙ(t))` to compute its outputs.
 * Generators produce random declaration sets and random commit-write
 * batches; the oracle is a sibling graph driven by the identical trace.
 *
 * The trial budget honours the project-wide race-detection floor of 1000+
 * random graphs and 1000+ random commit sequences per property, every CI
 * run, with deterministic seeds logged so a failure is reproducible.
 */

/**
 * Determinism (the function-semantics theorem):
 *   `derived(t) = f(b₁(t), ..., bₙ(t))` is a function. Replaying a recorded
 *   commit sequence on a fresh graph must therefore yield byte-identical
 *   state — because at every step the engine is computing the same `f`
 *   over the same `(b₁(t), ..., bₙ(t))`. Any divergence is a failure of
 *   that functional guarantee.
 */
describe('property: determinism (replay)', () => {
  /**
   * Universally-quantified contract: for any declaration set and any commit
   * trace, two fresh `createCausl()` graphs replayed against that trace
   * agree on every input read, on the joined derived view, and on `g.now`.
   * A divergence would prove the engine is observing non-deterministic
   * scheduler state — a violation of the `derived(t) = f(b₁(t), ..., bₙ(t))`
   * functional guarantee.
   */
  it('replaying a recorded commit sequence yields equal reads (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        // Generator: random `(id, initial)` declarations plus a list of
        // commit-write batches. Bounds keep the trace exploration broad while
        // remaining fast to shrink.
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.integer()), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(
          fc.array(fc.tuple(fc.nat(), fc.integer()), { minLength: 0, maxLength: 5 }),
          { minLength: 1, maxLength: 30 },
        ),
        (inputDecls, commits) => {
          // Build two fresh graphs with identical declarations.
          const seenIds = new Set<string>()
          const cleaned = inputDecls.filter(([id]) => {
            if (seenIds.has(id)) return false
            seenIds.add(id)
            return true
          })
          if (cleaned.length === 0) return

          /**
           * Build a fresh graph with the deduplicated declaration set and a
           * single derived `__view` that joins every input value in declared
           * order. This is the unit-under-test: a function whose output must
           * be identical across two independent constructions of the graph.
           */
          function build(): {
            g: ReturnType<typeof createCausl>
            inputs: InputNode<number>[]
          } {
            const g = createCausl()
            const inputs = cleaned.map(([id, init]) => g.input<number>(id, init))
            // Derive a single view that depends on every input in declared
            // order so the assertion captures any reordering bug.
            g.derived('__view', (get) => inputs.map((n) => get(n)).join('|'))
            return { g, inputs }
          }

          // Oracle pairing: `left` is the graph under test; `right` is the
          // sibling oracle graph driven by the identical trace.
          const left = build()
          const right = build()
          // Drive: replay the same commit on both graphs in the same order.
          for (let i = 0; i < commits.length; i++) {
            const writes = commits[i] ?? []
            const intent = `c${i}`
            for (const ctx of [left, right]) {
              ctx.g.commit(intent, (tx) => {
                for (const [idx, v] of writes) {
                  const n = ctx.inputs[idx % ctx.inputs.length]
                  if (n) tx.set(n, v)
                }
              })
            }
          }

          // Assertion: per-input agreement, derived-view agreement, and
          // `g.now` agreement. Any divergence indicates a determinism
          // violation in the engine's commit pipeline.
          for (let i = 0; i < cleaned.length; i++) {
            const li = left.inputs[i]
            const ri = right.inputs[i]
            if (li && ri) expect(left.g.read(li)).toBe(right.g.read(ri))
          }
          // Derived agreement is the strong claim — it covers any compute
          // ordering bug that input reads alone could miss.
          const lview = left.g.read({ id: '__view' })
          const rview = right.g.read({ id: '__view' })
          expect(lview).toBe(rview)
          expect(left.g.now).toBe(right.g.now)
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial race-detection floor and honours
      // `CAUSL_FUZZ_TIER` so the PR-lane (5k) and nightly (100k) tiers
      // (#1073) take effect without a code change.
      tieredPropertyOptions(),
    )
  })

  /**
   * Universally-quantified contract: two graphs that share a derived chain
   * `a -> b -> c -> d` and replay the identical write trace agree on every
   * derived value. Demonstrates that pure compute functions composed through
   * the engine remain pure end-to-end — the function-semantics guarantee
   * `derived(t) = f(b₁(t), ..., bₙ(t))` holds across composition, not just
   * on a single derivation.
   */
  it('two graphs with identical traces and identical compute functions agree on derived chains', () => {
    fc.assert(
      fc.property(
        // Generator: a list of integer writes destined for input `a`. Empty
        // arrays are allowed so the property covers the no-commit baseline.
        fc.array(fc.integer(), { minLength: 0, maxLength: 50 }),
        (writes) => {
          /**
           * Construct a fresh diamond-free chain `a -> b -> c -> d`. The
           * compute closures are referentially identical between the two
           * builds, so any divergence is necessarily an engine artefact.
           */
          function build(): { g: ReturnType<typeof createCausl>; a: InputNode<number> } {
            const g = createCausl()
            const a = g.input<number>('a', 0)
            const b = g.derived('b', (get) => get(a) * 2)
            const c = g.derived('c', (get) => get(b) + 1)
            g.derived('d', (get) => get(c) - get(b))
            return { g, a }
          }
          // Oracle pairing: `left` is the graph under test, `right` is the
          // sibling oracle. Both replay the identical commit trace.
          const left = build()
          const right = build()
          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0
            left.g.commit(`c${i}`, (tx) => tx.set(left.a, v))
            right.g.commit(`c${i}`, (tx) => tx.set(right.a, v))
          }
          // Assertion: every link in the chain agrees byte-for-byte. The
          // chain shape ensures both forward dependency tracking and
          // diamond-free re-computation are exercised.
          for (const id of ['a', 'b', 'c', 'd']) {
            const l = left.g.read({ id })
            const r = right.g.read({ id })
            expect(l).toBe(r)
          }
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial race-detection floor and honours
      // `CAUSL_FUZZ_TIER` so the PR-lane (5k) and nightly (100k) tiers
      // (#1073) take effect without a code change.
      tieredPropertyOptions(),
    )
  })
})
