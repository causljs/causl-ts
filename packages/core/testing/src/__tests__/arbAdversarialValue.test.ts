/**
 * Unit tests for the `arbAdversarialValue` arbitrary (issue #1073).
 *
 * The contract we're pinning:
 *
 *   1. The arbitrary is constructible at the default settings and at
 *      the documented tuning extremes (`adversarialWeight: 0`, `1`).
 *   2. Over a sample of N=2000 draws the adversarial / ordinary split
 *      lands within ±10 percentage points of the configured weight.
 *      Tolerance is generous because this is a heuristic-coverage
 *      arbitrary, not a statistical contract — the property gate
 *      already covers structural-divergence detection, this test
 *      just guards against "all weight collapses to one branch".
 *   3. Every advertised adversarial family is reachable in the
 *      output distribution: in N=2000 draws against
 *      `adversarialWeight: 1`, we observe at least one value from
 *      each of NaN / ±0 / boundary / long-string / deep-object.
 *   4. The optional `includeSurrogates` / `includeBigInts` knobs
 *      expand the reachable set (we observe the new family in the
 *      output stream) without contracting the always-on families.
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import {
  ADVERSARIAL_NUMBERS_BOUNDARY,
  ADVERSARIAL_NUMBERS_NAN,
  ADVERSARIAL_NUMBERS_SIGNED_ZERO,
  ADVERSARIAL_OBJECT_DEPTHS,
  ADVERSARIAL_STRING_LENGTHS,
  arbAdversarialValue,
} from '../arbAdversarialValue.js'

/**
 * Detect whether a value was *plausibly* drawn from the adversarial
 * branch. Distinct from {@link classify}: this is the union of
 * "looks like an adversarial-family value at all" — used for the
 * `adversarialWeight: 1` test that must accept every adversarial-
 * family value including coincidence-collision values like `+0`,
 * `0` (a member of both the signed-zero and ordinary families).
 *
 * The check is strict on numbers (NaN, finite signed zero, the
 * boundary enumeration), permissive on strings (length-based), and
 * structural on objects (the `{ next: ... }` shape from the
 * deep-object generator).
 */
function isFromAdversarialBranch(v: unknown): boolean {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return true
    // Both `+0` and `-0` belong to the signed-zero family.
    if (v === 0) return true
    // Membership in the boundary enumeration.
    for (const b of ADVERSARIAL_NUMBERS_BOUNDARY) {
      if (Object.is(v, b)) return true
    }
    return false
  }
  if (typeof v === 'string') {
    // Length in the documented enumeration (0/1/64/1024/16384) OR a
    // lone high surrogate.
    if (v === '\uD800') return true
    return (ADVERSARIAL_STRING_LENGTHS as readonly number[]).includes(v.length) &&
      (v === '' || /^a+$/.test(v))
  }
  if (typeof v === 'bigint') return true
  if (v && typeof v === 'object' && 'next' in (v as object)) return true
  return false
}

// Number of draws sampled by the distribution-shape tests below. Chosen
// to be large enough that the ±10pp tolerance on the 30/70 split is
// comfortable but small enough that the suite runs in <50ms.
const SAMPLE_SIZE = 2000

/**
 * Draw `n` values from an arbitrary using fast-check's `sample` so the
 * distribution-shape assertions don't need to spin up `fc.assert`.
 */
function drawSamples<T>(arb: fc.Arbitrary<T>, n: number): readonly T[] {
  return fc.sample(arb, n)
}

/**
 * Classify a value into one of the adversarial families plus an
 * "ordinary" bucket. Used by the bias-shape and reachability tests.
 *
 * Coincidence-noise note: a value drawn from the ordinary branch can
 * occasionally match an adversarial-family enumeration entry by
 * chance — e.g. the ordinary `fc.integer({min:-100,max:100})`
 * arbitrary produces `0`, which is *the same value* as the
 * `+0` entry in the signed-zero adversarial family. We classify
 * those collisions as `ordinary` (the conservative choice) so the
 * "adversarial-only" assertion below is robust:
 *
 *   - `nan` requires `Number.isNaN(v) === true` (no overlap with
 *     ordinary `fc.double({noNaN: true})`).
 *   - `signed-zero` requires `Object.is(v, -0)` (the ordinary
 *     integer/double arbitraries never produce `-0`).
 *   - `boundary` requires a value at the IEEE-754 boundaries the
 *     enumeration tabulates (ordinary arbitraries don't span that
 *     range).
 *   - `long-string` requires `length >= 64`.
 *   - `deep-object` requires the `{ next: ... }` shape.
 *
 * A value flagged as `ordinary` may still have come from the
 * adversarial branch (a coincidence like `+0` or `1`); the bias-mass
 * tests are tolerant of that by using ±10pp bounds.
 */
function classify(
  v: unknown,
):
  | 'nan'
  | 'signed-zero'
  | 'boundary'
  | 'long-string'
  | 'surrogate-string'
  | 'deep-object'
  | 'bigint'
  | 'ordinary' {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan'
    if (Object.is(v, -0)) return 'signed-zero'
    if (
      v === Number.MAX_VALUE ||
      v === Number.MIN_VALUE ||
      v === Number.EPSILON ||
      v === Number.MAX_SAFE_INTEGER ||
      v === Number.MIN_SAFE_INTEGER ||
      v === Number.MAX_SAFE_INTEGER + 1 ||
      v === Number.MIN_SAFE_INTEGER - 1 ||
      v === Infinity ||
      v === -Infinity ||
      v === -Number.MAX_VALUE
    ) {
      return 'boundary'
    }
    return 'ordinary'
  }
  if (typeof v === 'string') {
    if (v === '\uD800') return 'surrogate-string'
    if (v.length >= 64) return 'long-string'
    return 'ordinary'
  }
  if (typeof v === 'bigint') return 'bigint'
  if (v && typeof v === 'object' && 'next' in (v as object)) return 'deep-object'
  return 'ordinary'
}

describe('arbAdversarialValue (issue #1073)', () => {
  it('returns a constructible arbitrary at default settings', () => {
    const arb = arbAdversarialValue()
    expect(arb).toBeDefined()
    // A single sample doesn't throw — proves the composition is valid.
    const draws = drawSamples(arb, 1)
    expect(draws.length).toBe(1)
  })

  it('30/70 split: adversarial branch is hit ~30% of the time at default settings (±10pp)', () => {
    const arb = arbAdversarialValue()
    const draws = drawSamples(arb, SAMPLE_SIZE)
    let adversarialCount = 0
    for (const v of draws) {
      if (classify(v) !== 'ordinary') adversarialCount++
    }
    const observed = adversarialCount / SAMPLE_SIZE
    // ±10pp tolerance — see the test-file docstring for why we don't
    // tighten this. Lower bound 20%, upper bound 40%.
    expect(observed).toBeGreaterThanOrEqual(0.2)
    expect(observed).toBeLessThanOrEqual(0.4)
  })

  it('adversarialWeight: 1 produces only adversarial-branch draws', () => {
    const arb = arbAdversarialValue({ adversarialWeight: 1 })
    const draws = drawSamples(arb, 200)
    for (const v of draws) {
      expect(isFromAdversarialBranch(v)).toBe(true)
    }
  })

  it('adversarialWeight: 0 produces only ordinary draws', () => {
    const arb = arbAdversarialValue({ adversarialWeight: 0 })
    const draws = drawSamples(arb, 200)
    // The ordinary branch never produces NaN, ±Infinity, signed -0,
    // long strings, or deep-object shapes — those are the strictly-
    // adversarial witnesses.
    for (const v of draws) {
      expect(Number.isNaN(v)).toBe(false)
      expect(Object.is(v, -0)).toBe(false)
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true)
      }
      if (typeof v === 'string') {
        expect(v.length).toBeLessThanOrEqual(16)
      }
      expect(typeof v).not.toBe('bigint')
      if (v && typeof v === 'object') {
        expect('next' in v).toBe(false)
      }
    }
  })

  it('clamps out-of-range adversarialWeight values into [0, 1]', () => {
    // Negative weight collapses to 0 (ordinary only) — no strictly-
    // adversarial witness can appear.
    const arbNeg = arbAdversarialValue({ adversarialWeight: -5 })
    for (const v of drawSamples(arbNeg, 100)) {
      expect(Number.isNaN(v)).toBe(false)
      expect(Object.is(v, -0)).toBe(false)
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
    // Weight > 1 collapses to 1 (adversarial only).
    const arbHigh = arbAdversarialValue({ adversarialWeight: 30 })
    for (const v of drawSamples(arbHigh, 100)) {
      expect(isFromAdversarialBranch(v)).toBe(true)
    }
  })

  it('all five adversarial families are reachable at adversarialWeight: 1', () => {
    const arb = arbAdversarialValue({ adversarialWeight: 1 })
    const draws = drawSamples(arb, SAMPLE_SIZE)
    const families = new Set<string>()
    for (const v of draws) families.add(classify(v))
    expect(families.has('nan')).toBe(true)
    expect(families.has('signed-zero')).toBe(true)
    expect(families.has('boundary')).toBe(true)
    expect(families.has('long-string')).toBe(true)
    expect(families.has('deep-object')).toBe(true)
  })

  it('includeSurrogates: true makes the surrogate-string family reachable', () => {
    const arb = arbAdversarialValue({
      adversarialWeight: 1,
      includeSurrogates: true,
    })
    const draws = drawSamples(arb, SAMPLE_SIZE)
    const families = new Set<string>()
    for (const v of draws) families.add(classify(v))
    expect(families.has('surrogate-string')).toBe(true)
  })

  it('includeSurrogates: false (default) does not produce lone surrogates', () => {
    const arb = arbAdversarialValue({ adversarialWeight: 1 })
    const draws = drawSamples(arb, SAMPLE_SIZE)
    for (const v of draws) {
      expect(classify(v)).not.toBe('surrogate-string')
    }
  })

  it('includeBigInts: true makes the bigint family reachable', () => {
    const arb = arbAdversarialValue({
      adversarialWeight: 1,
      includeBigInts: true,
    })
    const draws = drawSamples(arb, SAMPLE_SIZE)
    const families = new Set<string>()
    for (const v of draws) families.add(classify(v))
    expect(families.has('bigint')).toBe(true)
  })

  it('includeBigInts: false (default) does not produce bigints', () => {
    const arb = arbAdversarialValue({ adversarialWeight: 1 })
    const draws = drawSamples(arb, SAMPLE_SIZE)
    for (const v of draws) {
      expect(typeof v).not.toBe('bigint')
    }
  })

  it('exposes stable family enumerations (regression guard on issue #1073 spec dimensions)', () => {
    // Document-shape: a future PR widening or narrowing these tables
    // is a breaking change to downstream property tests that target a
    // specific family directly. The table contents are pinned here.
    expect(ADVERSARIAL_NUMBERS_NAN.length).toBeGreaterThanOrEqual(4)
    expect(ADVERSARIAL_NUMBERS_NAN.every((v) => Number.isNaN(v))).toBe(true)

    expect(ADVERSARIAL_NUMBERS_SIGNED_ZERO).toEqual([0, -0, 0, -0])

    expect(ADVERSARIAL_NUMBERS_BOUNDARY).toContain(Number.MAX_VALUE)
    expect(ADVERSARIAL_NUMBERS_BOUNDARY).toContain(Number.MIN_VALUE)
    expect(ADVERSARIAL_NUMBERS_BOUNDARY).toContain(Infinity)
    expect(ADVERSARIAL_NUMBERS_BOUNDARY).toContain(-Infinity)

    expect(ADVERSARIAL_STRING_LENGTHS).toEqual([0, 1, 64, 1024, 16384])
    expect(ADVERSARIAL_OBJECT_DEPTHS).toEqual([1, 8, 64, 256])
  })
})
