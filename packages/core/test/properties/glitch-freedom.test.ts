import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { tieredPropertyOptions } from './seed.js'

/**
 * @packageDocumentation
 *
 * Property-based proof of diamond glitch-freedom for the engine.
 *
 * The semantic foundation I refuse to skip: a derived value at time `t` is
 * a pure function of its inputs at the same time `t`. There is no
 * intermediate "B updated but C did not" state because there is no
 * intermediate time. Whatever the scheduler does, the meaning is fixed —
 * `derived(t) = f(b₁(t), ..., bₙ(t))` is a function, so two
 * implementations either agree or one of them is wrong, and a transaction
 * creates exactly one new `t` (no fractional time). Property-based fuzz
 * is the race-detection layer for everything the type system and API
 * shape don't catch; this file is the diamond-glitch row of that
 * commitment.
 *
 * For any diamond `D = f(B(A), C(A))` and any write trace, every
 * observation of `D` is consistent at a single `GraphTime` — `D` never
 * appears formed from one branch's old value and the other branch's new
 * value. Generators produce random write traces; the oracle reconstructs
 * the legal observation sequence by walking the trace and de-duplicating
 * contiguous repeats. The trial budget (1000 trials per property) is the
 * floor I commit to on every CI run; failing inputs shrink to regression
 * cases, and seeds are deterministic so a CI failure is reproducible.
 */

/**
 * Glitch-freedom theorem instantiated for a diamond:
 *   For D = f(B, C) with B = g(A) and C = h(A), every observation of D
 *   equals f(g(A_t), h(A_t)) — never f(g(A_old), h(A_new)) or its mirror.
 *
 * The semantic equation makes the bad state non-existent: `D(t) =
 * f(B(t), C(t))` is a function, so the diamond-glitch question doesn't
 * exist in the model. This suite is the property-test confirmation that
 * the implementation corresponds to the model.
 */
describe('property: glitch-freedom (diamond)', () => {
  /**
   * Universally-quantified contract: for every random write trace into the
   * single-input diamond, the subscriber stream on `D` equals the
   * de-duplicated legal-observation sequence reconstructed from the trace.
   * Any glitch — `D` formed from `g(A_old)` paired with `h(A_new)` — would
   * insert a value that fails this equality.
   *
   * Run with the 1000-trial floor I commit to on every CI run; failing
   * inputs shrink to regression cases under deterministic seeds.
   */
  it('every observation of D equals f(g(A_t), h(A_t)) for the same t (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        // Generator: a non-empty list of bounded integer writes for input `a`.
        // The bounded range keeps the joined-string oracle compact; the array
        // length covers up to 60 commits per trial.
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), { minLength: 1, maxLength: 60 }),
        (writes) => {
          // Engine setup: the canonical diamond `b = a + 1`, `c = a * 2`,
          // `d = "${b}|${c}"`. The string join makes glitches loud — any
          // mismatched pair shows up as a token combination outside the
          // legal trace.
          const g = createCausl()
          const a = g.input('a', 0)
          const b = g.derived('b', (get) => get(a) + 1)
          const c = g.derived('c', (get) => get(a) * 2)
          const d = g.derived('d', (get) => `${get(b)}|${get(c)}`)

          // Drive: subscribe to `d` and replay the random write trace.
          const seen: string[] = []
          g.subscribe(d, (v) => seen.push(v))

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0
            g.commit(`c${i}`, (tx) => tx.set(a, v))
          }

          // Oracle computation: the legal observation sequence is the
          // de-duplicated trace of `${a + 1}|${a * 2}` evaluated at every
          // value `a` takes — initial 0 plus every write.
          const trail = [0, ...writes]
          const expected: string[] = []
          let prev: string | null = null
          for (const av of trail) {
            const e = `${av + 1}|${av * 2}`
            if (e !== prev) {
              expected.push(e)
              prev = e
            }
          }
          // Assertion: subscriber stream equals the oracle trace exactly.
          expect(seen).toEqual(expected)
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial CI floor; `CAUSL_FUZZ_TIER` raises it to the
      // PR-lane (5k) / nightly (100k) tiers without a code change (#1073).
      tieredPropertyOptions(),
    )
  })

  /**
   * Universally-quantified contract: for every random `(a1, a2)` write trace,
   * the subscriber stream on a two-input diamond equals the de-duplicated
   * legal-observation sequence. Stresses glitch-freedom across simultaneous
   * multi-input commits where both upstream derivations share `a1` and one
   * of them additionally depends on `a2`.
   *
   * Multi-input commits exercise atomicity directly — a single transaction
   * with two `tx.set` calls advances `GraphTime` by exactly one, so any
   * cross-input glitch would surface here as a token pair outside the
   * legal trace.
   */
  it('multi-input diamond: D = f(B(A1), C(A1, A2)) — every D-observation is consistent', () => {
    fc.assert(
      fc.property(
        // Generator: random `(a1, a2)` write pairs. The narrow integer range
        // keeps the oracle string short while still exploring sign and
        // magnitude variation across both inputs.
        fc.array(
          fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 })),
          { minLength: 1, maxLength: 30 },
        ),
        (writes) => {
          // Engine setup: two inputs, with `b` depending on `a1` only and `c`
          // depending on both `a1` and `a2`. `d` joins the two — any glitch
          // surfaces as a token pair outside the legal trace.
          const g = createCausl()
          const a1 = g.input('a1', 0)
          const a2 = g.input('a2', 0)
          const b = g.derived('b', (get) => get(a1) + 100)
          const c = g.derived('c', (get) => get(a1) * 10 + get(a2))
          const d = g.derived('d', (get) => `${get(b)}|${get(c)}`)

          // Drive: subscribe and replay the random trace.
          const seen: string[] = []
          g.subscribe(d, (v) => seen.push(v))

          let last = { a1: 0, a2: 0 }
          const trail = [last, ...writes.map(([x, y]) => ({ a1: x, a2: y }))]
          for (let i = 0; i < writes.length; i++) {
            const w = writes[i]
            if (!w) continue
            const [x, y] = w
            g.commit(`c${i}`, (tx) => {
              tx.set(a1, x)
              tx.set(a2, y)
            })
            last = { a1: x, a2: y }
          }

          // Oracle computation: legal observation sequence is the
          // de-duplicated trace of `d` evaluated at each `(a1, a2)` snapshot.
          const expected: string[] = []
          let prev: string | null = null
          for (const s of trail) {
            const e = `${s.a1 + 100}|${s.a1 * 10 + s.a2}`
            if (e !== prev) {
              expected.push(e)
              prev = e
            }
          }
          // Assertion: subscriber stream equals the oracle trace exactly.
          expect(seen).toEqual(expected)
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial CI floor; `CAUSL_FUZZ_TIER` raises it to the
      // PR-lane (5k) / nightly (100k) tiers without a code change (#1073).
      tieredPropertyOptions(),
    )
  })
})
