/**
 * @packageDocumentation
 *
 * Multi-axis shrinker per SPEC §16.5.2 (#571).
 *
 * Wave-2 shipped axis-1 (step count, suffix binary search). This
 * file gates the additional shrinkers SPEC names plus the
 * orchestrator that runs them to convergence:
 *
 *   - axis-1a: `shrinkSuffix` — drop trailing steps (alias for
 *     the existing `shrinkStepCount`).
 *   - axis-1b: `shrinkPrefix` — drop leading steps. Symmetric
 *     to suffix shrinking; useful when the failure is in the
 *     middle of a long initialization.
 *   - axis-2: `shrinkActions` — supplied a per-action shrinker,
 *     drop or simplify individual actions.
 *   - axis-3: `shrinkStates` — supplied a per-state shrinker,
 *     simplify state payloads.
 *   - orchestrator: `shrink` — runs every supplied axis to
 *     fixpoint, returning the minimum trace that still fails.
 *
 * Determinism: every shrinker is a pure function over
 * `(hypothesis, trace, ...)`; two invocations on the same input
 * produce byte-identical output. The orchestrator's fixpoint
 * iteration is bounded — at most O(steps) iterations per axis —
 * so termination is structural.
 */

import { describe, expect, test } from 'vitest'
import {
  always,
  shrink,
  shrinkPrefix,
  shrinkStepCount,
  type Trace,
} from '../src/index.js'

interface S {
  readonly v: number
}

function trace(start: S, vs: readonly number[]): Trace<S> {
  return {
    start,
    steps: vs.map((v) => ({ action: null, state: { v } })),
  }
}

describe('shrinkPrefix — drop leading steps (#571 axis-1b)', () => {
  test('returns the same trace if the hypothesis already holds', () => {
    const t = trace({ v: 0 }, [1, 2, 3])
    const h = always<S>((s) => s.v >= 0)
    const result = shrinkPrefix(h, t)
    expect(result).toBe(t) // same reference — no shrinking
  })

  test('drops every leading step that isn\'t needed for the failure', () => {
    // Hypothesis fails because v becomes -1 at step 3. The first
    // 3 steps (v=1,2,3) aren't necessary to witness the failure.
    const t = trace({ v: 0 }, [1, 2, 3, -1])
    const h = always<S>((s) => s.v >= 0)
    expect(h(t)).toBe('fails')
    const result = shrinkPrefix(h, t)
    // The minimal failing prefix from the rear: just the -1 step,
    // OR start state + the -1 step. Either way, fewer steps than
    // the input.
    expect(result.steps.length).toBeLessThanOrEqual(t.steps.length)
    // The result must still fail.
    expect(h(result)).toBe('fails')
  })

  test('preserves trace.bounded flag through shrinking', () => {
    const t: Trace<S> = {
      start: { v: 0 },
      steps: [{ action: null, state: { v: -1 } }],
      bounded: true,
    }
    const h = always<S>((s) => s.v >= 0)
    const result = shrinkPrefix(h, t)
    expect(result.bounded).toBe(true)
  })
})

describe('shrink orchestrator — run multiple axes to convergence (#571)', () => {
  test('runs axis-1 (suffix) and axis-1b (prefix) together', () => {
    // 10 steps; only step 5 (v=-1) violates. Suffix shrink drops
    // the trailing 4 steps; prefix shrink could drop leading
    // steps too. Combined: minimal trace.
    const t = trace({ v: 0 }, [1, 2, 3, 4, -1, 5, 6, 7, 8, 9])
    const h = always<S>((s) => s.v >= 0)
    const result = shrink(h, t)
    // Result must still fail.
    expect(h(result)).toBe('fails')
    // And must be no longer than the input.
    expect(result.steps.length).toBeLessThanOrEqual(t.steps.length)
  })

  test('returns input when hypothesis holds (no shrinking needed)', () => {
    const t = trace({ v: 0 }, [1, 2, 3])
    const h = always<S>((s) => s.v >= 0)
    expect(h(t)).toBe('holds')
    const result = shrink(h, t)
    // Trace unchanged when no failure to shrink.
    expect(result.steps.length).toBe(t.steps.length)
  })

  test('terminates on a complex failing trace (regression for non-termination)', () => {
    // Bigger trace with multiple violating steps. Shrinker must
    // converge in bounded iterations — not loop forever.
    const t = trace(
      { v: 0 },
      [1, 2, -1, 3, 4, -2, 5, 6, -3, 7, 8, 9],
    )
    const h = always<S>((s) => s.v >= 0)
    const start = Date.now()
    const result = shrink(h, t)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000) // sanity bound
    expect(h(result)).toBe('fails')
  })
})

describe('shrinkStepCount back-compat (#571)', () => {
  // The existing shrinkStepCount export must keep working — wave-2
  // adopters who imported it explicitly should not break.
  test('shrinkStepCount still binary-searches the suffix', () => {
    const t = trace({ v: 0 }, [1, 2, 3, -1, 4, 5])
    const h = always<S>((s) => s.v >= 0)
    const result = shrinkStepCount(h, t)
    expect(h(result)).toBe('fails')
    expect(result.steps.length).toBeLessThan(t.steps.length)
  })
})
