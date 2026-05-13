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

  /**
   * Stable-chain glitch-freedom (NEW rec #16 / #1305 partner):
   *
   *   For every random write trace into a chain where an intermediate
   *   derived is `Object.is`-stable across all writes, every observer
   *   of the chain tail sees a value consistent with the pre-commit
   *   state of the upstream — never a mid-commit interleaving.
   *
   * The chain shape — `a → erase = a*0 → succ = erase + offset` —
   * exercises exactly the propagation-skip surface added by NEW rec
   * #16: `erase` is `Object.is`-stable at 0 for every write, so
   * `succ`'s recompute is skipped under the cutoff-propagation gate.
   * The skip must not be observable to a subscriber on `succ` — every
   * notification must reflect the SAME value as the prior commit's
   * `succ` (since `succ`'s value didn't change), and the value itself
   * must equal `offset` for the lifetime of the trace.
   *
   * If the skip were to leak a stale value or fire a spurious
   * notification, this property would surface it as either a wrong
   * value in the observer stream or an extra entry in the stream.
   */
  it('stable-chain: intermediate Object.is-stable derived never leaks a glitch', () => {
    fc.assert(
      fc.property(
        // Write traces into `a`. Range chosen so multiplication by
        // zero is exact in IEEE-754 (the cutoff hinges on `Object.is`,
        // so we avoid NaN-class edge cases from random-large floats).
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: -100, max: 100 }), // constant offset added by `succ`
        (writes, offset) => {
          // Engine setup: `a → erase → succ` where `erase = a * 0` is
          // `Object.is`-stable at 0 and `succ = erase + offset` is
          // therefore stable at `offset`. The propagation-skip gate
          // fires for `succ` on every commit where `a` changes; the
          // subscriber on `succ` must never see anything but `offset`.
          const g = createCausl()
          const a = g.input('a', 0)
          const erase = g.derived('erase', (get) => (get(a) as number) * 0)
          const succ = g.derived(
            'succ',
            (get) => (get(erase) as number) + offset,
          )

          // Drive: subscribe to `succ` and replay the random write trace.
          const seen: number[] = []
          g.subscribe(succ, (v) => seen.push(v))

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i] ?? 0
            g.commit(`c${i}`, (tx) => tx.set(a, v))
          }

          // Oracle: `succ` is constant at `offset` across the entire
          // trace. The subscriber fires exactly once — the
          // registration-time settle that yields the initial value;
          // no commit changes `succ`'s value (the cutoff suppresses
          // both Phase D recompute AND Phase G dispatch), so no
          // further notifications fire.
          expect(seen).toEqual([offset])

          // Post-trace read: every observable read of `succ` returns
          // `offset` — the cutoff-propagation skip preserved the
          // value byte-identically across the entire trace.
          expect(g.read(succ)).toBe(offset)
        },
      ),
      tieredPropertyOptions(),
    )
  })
})
