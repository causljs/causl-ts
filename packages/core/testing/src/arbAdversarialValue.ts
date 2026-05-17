/**
 * @packageDocumentation
 *
 * `arbAdversarialValue` — a `fast-check` arbitrary that biases ~30%
 * of generated values toward the adversarial cases that drive
 * cross-backend divergence on the WASM determinism gate (EPIC #680,
 * issue #1073).
 *
 * ## Why this exists
 *
 * The cross-backend determinism property suite
 * (`packages/core/test/properties/cross-backend-determinism.property.test.ts`)
 * compares byte-equal IR projections across `(TS, WASM)` engine
 * pairs. The dominant divergence sources between a JS engine and a
 * WASM-Rust engine are not "any random number" — they are a small,
 * well-known set of representational edge cases:
 *
 *   - **`NaN` payloads.** JS `NaN === NaN` is `false`; serde-json
 *     emits `null` for `f64::NAN`; the GC bridge's `f64.eq` returns
 *     `false`. A uniform integer arbitrary will draw `NaN` with
 *     probability zero and the gate will never exercise the
 *     divergence the spec calls out.
 *
 *   - **`±0`.** `+0 === -0` is `true` in JS, but `JSON.stringify(-0)`
 *     emits `"0"` while a future Rust serialiser may emit `"-0"` (or
 *     `"0.0"`, depending on the `f64` formatter). Byte-equal IR can
 *     drift on sign.
 *
 *   - **Very large floats / IEEE-754 boundary values.** Subnormals,
 *     `Number.MAX_VALUE`, `Number.MIN_VALUE`, `Number.MAX_SAFE_INTEGER
 *     + 1` — these round differently in Rust vs JS string formatters.
 *
 *   - **Very long strings.** WTF-8 vs UTF-8 vs USV-16 split lone
 *     surrogates at different boundaries; long strings exercise the
 *     boundary at the wasm-bindgen ABI threshold.
 *
 *   - **Deeply-nested objects.** Recursion-depth limits in the GC
 *     bridge's serde walker can clip silently. A 30%-biased depth
 *     arbitrary stresses that limit on every PR-lane run.
 *
 * ## Bias shape
 *
 * `arbAdversarialValue` returns an `fc.oneof` weighted so that ~30%
 * of trials draw from one of the five adversarial branches above and
 * ~70% draw from the "ordinary" small-integer / short-string / shallow-
 * object distribution. The 30/70 split is the issue body's pinned
 * dimension (issue #1073) — keep it stable across consumers so
 * coverage estimates are comparable.
 *
 * Each adversarial branch is itself an `fc.oneof` over the
 * representative-value enumeration for that family. Concretely:
 *
 *   - **NaN family**: `NaN`, `Number.NaN`, `0/0`, plus three
 *     non-canonical NaN bit-patterns serialised through a
 *     `Float64Array`. Cross-backend gates that compare bit-equal
 *     payloads must agree on these.
 *
 *   - **±0 family**: `+0`, `-0`, `1/Infinity` (which is `+0`),
 *     `-1/Infinity` (which is `-0`).
 *
 *   - **Boundary-float family**: `Number.MAX_VALUE`,
 *     `Number.MIN_VALUE`, `Number.MAX_SAFE_INTEGER`,
 *     `Number.MIN_SAFE_INTEGER`, `Number.EPSILON`, `Infinity`,
 *     `-Infinity`, `Number.MAX_SAFE_INTEGER + 1` (the integer
 *     precision cliff).
 *
 *   - **Long-string family**: empty string, 1-char, 64-char, 1024-char,
 *     and 16384-char strings. Optional `includeSurrogates` flag adds
 *     a lone-high-surrogate string at the boundary (off by default
 *     because some downstream serialisers reject lone surrogates
 *     with a hard error rather than a divergence).
 *
 *   - **Deep-object family**: nested `{ next: { next: ... } }` objects
 *     at depths 1, 8, 64, 256. The 256-depth case is enough to break
 *     `JSON.stringify` on default V8 stack budgets — if the WASM
 *     engine sets a lower budget, the divergence surfaces here.
 *
 * ## Usage
 *
 * ```ts
 * import { arbAdversarialValue } from '@causl/core/testing'
 *
 * fc.assert(
 *   fc.property(arbAdversarialValue(), (v) => {
 *     // `v` is drawn from the 30%-biased adversarial distribution.
 *   }),
 * )
 * ```
 *
 * Pass options to tune the bias or include extra branches:
 *
 * ```ts
 * arbAdversarialValue({ adversarialWeight: 0.5 })   // 50/50 split
 * arbAdversarialValue({ includeSurrogates: true })  // lone surrogates on
 * ```
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1073} — this arbitrary.
 * @see {@link https://github.com/iasbuilt/causl/issues/680}  — WASM EPIC.
 */

import fc from 'fast-check'

/**
 * Adversarial value families. Re-exported so consumers can compose a
 * narrower arbitrary without rebuilding the constant tables. Each
 * family is a finite enumeration of representative bit-patterns; the
 * arbitrary draws uniformly within a family.
 *
 * Public-shape: stable across this minor. Adding a new family is a
 * minor-version change; removing or renaming one is a breaking change
 * to consumers that target a specific family directly.
 */
export const ADVERSARIAL_NUMBERS_NAN: readonly number[] = (() => {
  // Build a few non-canonical NaN bit-patterns. JS hides NaN
  // bit-payload behind `===` but cross-backend serialisers may not —
  // the gate has to see all of them.
  const buf = new ArrayBuffer(8)
  const f64 = new Float64Array(buf)
  const u32 = new Uint32Array(buf)
  // Quiet NaN, signalling NaN (payload bit 51 vs 50), and one with a
  // random payload. The `>>> 0` keeps the high half in the IEEE-754
  // NaN exponent range (all ones).
  const nans: number[] = []
  for (const hi of [0x7ff80000, 0x7ff40000, 0x7ff80001, 0xfff80000]) {
    u32[1] = hi >>> 0
    u32[0] = 0
    nans.push(f64[0]!)
  }
  return [Number.NaN, NaN, 0 / 0, ...nans]
})()

/**
 * Signed-zero family. `+0` and `-0` compare equal under `===` but
 * stringify differently in some IEEE-754 formatters; cross-backend
 * IR equality must agree on the sign bit.
 */
export const ADVERSARIAL_NUMBERS_SIGNED_ZERO: readonly number[] = [
  0,
  -0,
  1 / Infinity, // +0
  -1 / Infinity, // -0
]

/**
 * IEEE-754 boundary values + integer precision cliff. Each value
 * round-trips through different code paths in different serialisers
 * (printf-family formatters in Rust, V8's number-to-string in JS) —
 * a divergence here means the backends disagree on representation.
 */
export const ADVERSARIAL_NUMBERS_BOUNDARY: readonly number[] = [
  Number.MAX_VALUE,
  Number.MIN_VALUE, // smallest positive subnormal
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1, // precision cliff: not representable exactly as f64
  Number.MIN_SAFE_INTEGER - 1,
  Infinity,
  -Infinity,
  -Number.MAX_VALUE,
]

/**
 * Long-string family. Lengths chosen at log-spaced powers of 4 so a
 * shrinking failure trace points cleanly at the boundary that broke.
 * 16384 chars is past the wasm-bindgen string-passing
 * boundary on most ABIs; if a future Rust bridge bounds inputs by
 * length, the divergence surfaces here.
 */
export const ADVERSARIAL_STRING_LENGTHS: readonly number[] = [
  0,
  1,
  64,
  1024,
  16384,
]

/**
 * Deep-object nesting depths. 256 is past the default
 * `JSON.stringify` recursion budget on some V8 configurations; cross-
 * backend engines that bound recursion lower MUST surface the
 * divergence in a property test, not at runtime.
 */
export const ADVERSARIAL_OBJECT_DEPTHS: readonly number[] = [1, 8, 64, 256]

/**
 * Caller-tunable knobs for {@link arbAdversarialValue}. Defaults pin
 * the issue body's 30/70 split and the conservative-by-default
 * "no lone surrogates" stance — flip `includeSurrogates` on for
 * gates whose downstream serialisers can survive a lone-high-
 * surrogate input rather than throwing.
 */
export interface ArbAdversarialValueOptions {
  /**
   * Probability mass placed on the adversarial branch. Defaults to
   * `0.3` per issue #1073. Values below `0` or above `1` are clamped
   * to the valid range; consumers that pass an out-of-range value
   * are likely making a typo rather than intentionally disabling the
   * bias.
   */
  readonly adversarialWeight?: number
  /**
   * If `true`, the long-string family additionally draws a string
   * containing a lone high surrogate (`\uD800`) — useful for the
   * WTF-8 / UTF-8 boundary on the WASM gate, but rejected by stricter
   * downstream serialisers. Off by default.
   */
  readonly includeSurrogates?: boolean
  /**
   * If `true`, include a `bigint`-flavoured branch in the adversarial
   * pool: `0n`, `Number.MAX_SAFE_INTEGER + 1n`, `2n ** 64n`,
   * `-(2n ** 64n)`. Off by default because some IR projections JSON-
   * stringify and `BigInt` throws under `JSON.stringify` by default.
   * Cross-backend gates that test a `bigint`-aware projection should
   * flip this on.
   */
  readonly includeBigInts?: boolean
}

/**
 * Build the adversarial branch — the ~30% slice of the bias. Composed
 * out of the family enumerations above plus the long-string and
 * deep-object generators so a single failing draw shrinks down to the
 * minimal adversarial witness.
 *
 * Exported for tests that want to see the adversarial draw deterministically.
 *
 * @internal
 */
export function adversarialBranch(
  opts: ArbAdversarialValueOptions = {},
): fc.Arbitrary<unknown> {
  // String branch — short to very long, with optional lone-surrogate
  // padding for the WTF-8 boundary case.
  const stringArb = fc.constantFrom(...ADVERSARIAL_STRING_LENGTHS).map((n) => {
    if (n === 0) return ''
    // Fixed-pattern string of length n. Using `'a'.repeat(n)` rather
    // than a random arbitrary because the failure mode we're hunting
    // is length-driven (wasm-bindgen ABI boundary), not content-driven.
    return 'a'.repeat(n)
  })
  const surrogateStringArb = fc.constant('\uD800') // lone high surrogate

  // Deep-object branch — `{ next: { next: ... { leaf: 0 } } }` to the
  // selected depth. Building iteratively to avoid the very stack
  // overflow we're trying to detect on the consumer side.
  const deepObjectArb = fc
    .constantFrom(...ADVERSARIAL_OBJECT_DEPTHS)
    .map((depth) => {
      let obj: unknown = { leaf: 0 }
      for (let i = 0; i < depth; i++) {
        obj = { next: obj }
      }
      return obj
    })

  // BigInt branch — off by default. Each entry round-trips through
  // a different serde path in the bridge candidates.
  const bigIntArb = fc.constantFrom<bigint>(
    0n,
    1n,
    -1n,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    -(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    2n ** 64n,
    -(2n ** 64n),
  )

  const stringBranches: fc.Arbitrary<unknown>[] = [stringArb]
  if (opts.includeSurrogates === true) stringBranches.push(surrogateStringArb)

  const branches: fc.Arbitrary<unknown>[] = [
    fc.constantFrom(...ADVERSARIAL_NUMBERS_NAN),
    fc.constantFrom(...ADVERSARIAL_NUMBERS_SIGNED_ZERO),
    fc.constantFrom(...ADVERSARIAL_NUMBERS_BOUNDARY),
    ...stringBranches,
    deepObjectArb,
  ]
  if (opts.includeBigInts === true) branches.push(bigIntArb)

  return fc.oneof(...branches.map((arb) => ({ arbitrary: arb, weight: 1 })))
}

/**
 * Build the "ordinary" branch — the ~70% slice of the bias. A simple
 * uniform distribution over small integers and short strings. This is
 * intentionally bland; the adversarial branch is where the divergence-
 * detection coverage lives, and any time spent here is buffer against
 * fast-check pruning all weight onto the adversarial side.
 *
 * @internal
 */
export function ordinaryBranch(): fc.Arbitrary<unknown> {
  // Note: `fc.double()` will occasionally emit `-0` even with
  // `noNaN`/`noDefaultInfinity` set — strip those by mapping the
  // double-arbitrary's output through a `+0` normaliser. The
  // adversarial branch owns the signed-zero coverage; the ordinary
  // branch must stay strictly free of those witnesses so the
  // distribution-shape tests can pin the bias cleanly.
  return fc.oneof(
    fc.integer({ min: -100, max: 100 }),
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .map((v) => (Object.is(v, -0) ? 0 : v)),
    fc.string({ maxLength: 16 }),
    fc.boolean(),
    fc.constant(null),
  )
}

/**
 * Top-level `fc.Arbitrary` for adversarial-biased value generation.
 * Composes {@link adversarialBranch} and {@link ordinaryBranch} under
 * an `fc.oneof` whose weights realise the issue's 30/70 split.
 *
 * The returned arbitrary's shrinking behaviour:
 *   - A failing adversarial draw shrinks toward the earliest
 *     enumeration entry in its family (e.g. `NaN` → `Number.NaN`,
 *     the canonical token).
 *   - A failing ordinary draw shrinks toward the family's standard
 *     fast-check shrink targets (0 for integers, '' for strings).
 *   - Cross-branch shrinking lets the property report the minimal
 *     witness in whichever family broke first.
 */
export function arbAdversarialValue(
  options: ArbAdversarialValueOptions = {},
): fc.Arbitrary<unknown> {
  // Clamp the weight into [0, 1]. Out-of-range values almost always
  // mean a typo (e.g. `30` instead of `0.3`); silently clamping is
  // better than a runtime throw on a fuzz arbitrary that ships under
  // a property gate.
  const raw = options.adversarialWeight ?? 0.3
  const adversarialWeight = Math.max(0, Math.min(1, raw))
  const ordinaryWeight = 1 - adversarialWeight
  // `fc.oneof` weights are integers — convert by multiplying both
  // sides by 100. The resulting integer ratio is exact for any
  // weight that's a multiple of 0.01 (which covers every realistic
  // tuning), and within 1% otherwise — the bias is heuristic, not a
  // statistical contract.
  const adversarialBucket = Math.round(adversarialWeight * 100)
  const ordinaryBucket = Math.round(ordinaryWeight * 100)
  return fc.oneof(
    { arbitrary: adversarialBranch(options), weight: adversarialBucket },
    { arbitrary: ordinaryBranch(), weight: ordinaryBucket },
  )
}
