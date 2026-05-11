/**
 * @packageDocumentation
 *
 * Behavioural pinning for the SPEC §15.1 NonDeterministicComputeError
 * invariant gate (#750).
 *
 * Contract being pinned:
 *
 * - With `experimentalFlags.assertDeterministicCompute === false`
 *   (the default), a derivation that reads `Math.random()` succeeds
 *   without detection — production pays zero overhead.
 * - With the flag on, the engine re-runs every `compute(get)` against
 *   the captured dependency snapshot and throws
 *   {@link NonDeterministicComputeError} when the second result
 *   disagrees with the first under `Object.is`. The error names the
 *   offending node id and carries a `path` ending with that id.
 * - The error class extends {@link CauslError}, so a generic
 *   `instanceof CauslError` branch in caller code captures the
 *   detection alongside other engine-emitted failures.
 *
 * The audit's adversarial-fanin scenario (#718) injects 0.1%
 * `Math.random()` returns and asks the engine to detect them; this
 * file is the unit-level pin of that detection.
 */

import { describe, expect, it } from 'vitest'
import {
  CauslError,
  createCausl,
  NonDeterministicComputeError,
} from '../src/index.js'

describe('SPEC §15.1 — NonDeterministicComputeError invariant gate (#750)', () => {
  describe('flag off (default)', () => {
    /**
     * Default behaviour: a derivation that reads `Math.random()` is
     * not policed. Production pays zero overhead because the
     * second-call verify pass is gated on the flag and absent here.
     */
    it('a non-deterministic derived succeeds (no detection cost)', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      // The compute reads Math.random() — non-deterministic by SPEC
      // §15.1 — but registers and reads cleanly because the gate is
      // off by default.
      const d = g.derived<number>('d', (get) => Math.random() * get(a))
      // Two reads can disagree (Math.random advances between them);
      // the gate's job is detection, not stabilisation, so we only
      // assert the read does not throw.
      expect(() => g.read(d)).not.toThrow()
      // A subsequent commit on the upstream also does not throw —
      // the gate is the only detection point, and it is off.
      expect(() =>
        g.commit('bump', (tx) => tx.set(a, 2)),
      ).not.toThrow()
    })

    /**
     * Default behaviour also passes through a deterministic compute —
     * the flag is opt-in and the absent gate must not affect ordinary
     * derivations either.
     */
    it('a deterministic derived also succeeds (control)', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      const sum = g.derived<number>('sum', (get) => get(a) + get(b))
      expect(g.read(sum)).toBe(3)
      g.commit('bump', (tx) => tx.set(a, 10))
      expect(g.read(sum)).toBe(12)
    })
  })

  describe('flag on — assertDeterministicCompute: true', () => {
    /**
     * With the gate enabled, registering a derivation whose compute
     * reads `Math.random()` throws because the engine evaluates the
     * derivation eagerly at registration and the verify pass returns
     * a different value. The error is a
     * `NonDeterministicComputeError`, names the offending node id,
     * and ends its `path` with that id. SPEC §15.1's commit-time
     * detection point is satisfied by the eager evaluation: every
     * registration is itself a "first commit" for that derivation's
     * domain.
     */
    it('Math.random() derived → NonDeterministicComputeError, path includes node id', () => {
      const g = createCausl({
        experimentalFlags: { assertDeterministicCompute: true },
      })
      const a = g.input('a', 1)
      let caught: unknown
      try {
        g.derived<number>('rand', (get) => Math.random() * get(a))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(NonDeterministicComputeError)
      // CauslError tag — generic `instanceof CauslError` catches it.
      expect(caught).toBeInstanceOf(CauslError)
      const err = caught as NonDeterministicComputeError
      expect(err.id).toBe('rand')
      // Path ends with the offending id so callers can locate it in
      // a deeper graph.
      expect(err.path).toContain('rand')
      expect(err.path[err.path.length - 1]).toBe('rand')
      expect(err.kind).toBe('NonDeterministicCompute')
    })

    /**
     * Detection also fires on a later-commit recompute, not just
     * registration. We exploit a closure-leak `calls` counter that
     * is even-stable on the first compute call but odd-toggled
     * thereafter, so the verify pass on a recompute disagrees with
     * the first pass.
     *
     * The shape we want: the first compute (registration) returns
     * the same value on call-1 (`compute`) AND call-2 (`verify`),
     * so registration succeeds. A subsequent commit triggers a
     * fresh pair of calls (call-3 + call-4); the gap-of-two between
     * those gives a detection moment in the commit pipeline rather
     * than at registration.
     */
    it('detection fires on commit-time recompute', () => {
      const g = createCausl({
        experimentalFlags: { assertDeterministicCompute: true },
      })
      const a = g.input('a', 1)
      let calls = 0
      // Returns `get(a) + 0` on calls 1+2 (registration verify pair),
      // returns `get(a) + 1` on call 3, `get(a) + 2` on call 4. The
      // first pair agrees; the second pair (commit-time) disagrees,
      // surfacing the detection at commit rather than registration.
      const d = g.derived<number>('d', (get) => {
        const v = get(a)
        const offset = calls < 2 ? 0 : calls - 1
        calls++
        return v + offset
      })
      // Registration succeeded — calls advanced 0 → 2 with both
      // returns equal to `get(a)`.
      expect(g.read(d)).toBe(1)
      let commitErr: unknown
      try {
        g.commit('bump', (tx) => tx.set(a, 10))
      } catch (err) {
        commitErr = err
      }
      expect(commitErr).toBeInstanceOf(NonDeterministicComputeError)
      const e = commitErr as NonDeterministicComputeError
      expect(e.id).toBe('d')
    })

    /**
     * A deterministic derived registers and recomputes cleanly with
     * the gate on; the second-call verify pass confirms equality and
     * does not raise. This is the negative control for the
     * Math.random() positive test.
     */
    it('deterministic derived passes through with flag on', () => {
      const g = createCausl({
        experimentalFlags: { assertDeterministicCompute: true },
      })
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      const sum = g.derived<number>('sum', (get) => get(a) + get(b))
      expect(g.read(sum)).toBe(3)
      g.commit('bump', (tx) => tx.set(a, 10))
      expect(g.read(sum)).toBe(12)
    })

    /**
     * Object identity follows `Object.is` semantics — a compute that
     * returns a fresh array on every call is non-deterministic from
     * the gate's perspective even if the array contents are equal.
     * SPEC §15.1's pure-function definition is satisfied by referen-
     * tial equality on the result, not by structural equality, so
     * the gate is honest about that distinction.
     */
    it('fresh-array compute → NonDeterministicComputeError (Object.is is reference equality)', () => {
      const g = createCausl({
        experimentalFlags: { assertDeterministicCompute: true },
      })
      const a = g.input('a', 1)
      let caught: unknown
      try {
        // Each call returns a new array reference, so the second
        // call's result `!Object.is` the first. The gate detects.
        g.derived<readonly number[]>('arr', (get) => [get(a)])
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(NonDeterministicComputeError)
      expect((caught as NonDeterministicComputeError).id).toBe('arr')
    })

    /**
     * A failed registration leaves the engine atomic: the entry is
     * not visible to subsequent reads. Mirrors the existing
     * `derived.test.ts` atomicity contract for cycle detection,
     * carried into the new error class.
     */
    it('failed registration is atomic — node id is reusable', () => {
      const g = createCausl({
        experimentalFlags: { assertDeterministicCompute: true },
      })
      const a = g.input('a', 1)
      expect(() =>
        g.derived<number>('rand', () => Math.random()),
      ).toThrow(NonDeterministicComputeError)
      // Re-using the same id with a deterministic compute succeeds
      // — proof that the failed registration did not leak the entry.
      const d = g.derived<number>('rand', (get) => get(a) * 2)
      expect(g.read(d)).toBe(2)
    })
  })
})
