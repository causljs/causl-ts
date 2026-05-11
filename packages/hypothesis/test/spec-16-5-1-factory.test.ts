/**
 * @packageDocumentation
 *
 * SPEC §16.5.1 hypothesis() factory + holds() builder (#571 rest).
 *
 * Wave-2 (#595) shipped the three semantic fixes — afterCommit
 * immediate-successor, eventually three-valued, fromPredicate
 * factory. This wave-8 file completes the SPEC §16.5.1 surface:
 *
 *   - hypothesis(name, body) factory returning NamedHypothesis<S>
 *     with { name, body, run }. Walks every step, fail-fast on
 *     invariant, then evaluates predicate.
 *
 *   - holds(p).until(q) builder — Lamport's strong-U operator.
 *     p must hold at every step up to and including the first step
 *     where q holds; if q never holds, fail.
 *
 *   - holds(p).weakUntil(q) variant — q is not required to be
 *     witnessed (vacuously holds if p holds throughout).
 *
 * The full SPEC §16.5.1 surface (CommitMatcher, builder DSL beyond
 * holds, axes 2/3 of shrinker) is the remaining #571 follow-on
 * scope; this commit closes the factory + holds-builder portion
 * of the issue.
 */

import { describe, expect, test } from 'vitest'
import {
  always,
  hypothesis,
  holds,
  type NamedHypothesis,
  type Trace,
} from '../src/index.js'

interface TestState {
  readonly v: number
}

function trace(
  start: TestState,
  steps: readonly { action: unknown; state: TestState }[],
  bounded = false,
): Trace<TestState> {
  return { start, steps, bounded }
}

describe('hypothesis(name, body) factory (#571)', () => {
  test('returns a NamedHypothesis with { name, body, run }', () => {
    const h: NamedHypothesis<TestState> = hypothesis('positive', {
      predicate: always((s: TestState) => s.v >= 0),
    })
    expect(h.name).toBe('positive')
    expect(h.body.predicate).toBeDefined()
    expect(typeof h.run).toBe('function')
  })

  test('run walks the trace and returns the predicate verdict', () => {
    const h = hypothesis<TestState>('all-positive', {
      predicate: always((s) => s.v >= 0),
    })
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
    ])
    expect(h.run(t)).toBe('holds')
  })

  test('run returns fails when the predicate fails', () => {
    const h = hypothesis<TestState>('strictly-positive', {
      predicate: always((s) => s.v > 0),
    })
    const t = trace({ v: 0 }, [{ action: null, state: { v: -1 } }])
    expect(h.run(t)).toBe('fails')
  })

  test('invariant short-circuits the predicate (fail-fast)', () => {
    // Per SPEC: invariant is checked at every step; fails with
    // 'invariant-violation' before the predicate is evaluated.
    let predicateCalled = false
    const h = hypothesis<TestState>('with-invariant', {
      invariant: (s) => s.v >= 0,
      predicate: () => {
        predicateCalled = true
        return 'holds'
      },
    })
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: -1 } }, // invariant violated
    ])
    expect(h.run(t)).toBe('fails')
    expect(predicateCalled).toBe(false)
  })

  test('invariant passes through when satisfied at every step', () => {
    const h = hypothesis<TestState>('inv-ok', {
      invariant: (s) => s.v >= 0,
      predicate: always((s) => s.v < 100),
    })
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
    ])
    expect(h.run(t)).toBe('holds')
  })
})

describe('holds(p).until(q) — strong-U (#571)', () => {
  test('holds when q is reached and p held until then', () => {
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
      { action: null, state: { v: 100 } }, // q holds
    ])
    const verdict = holds<TestState>((s) => s.v < 100).until(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('holds')
  })

  test('fails when q never holds', () => {
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
    ])
    const verdict = holds<TestState>((s) => s.v < 100).until(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('fails')
  })

  test('fails when p stops holding before q', () => {
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: -1 } }, // p violated, q not yet held
    ])
    const verdict = holds<TestState>((s) => s.v >= 0).until((s) => s.v >= 100)(
      t,
    )
    expect(verdict).toBe('fails')
  })

  test('q at start state holds without checking p', () => {
    // If q holds at the start, p is vacuously satisfied (no
    // intermediate steps to check).
    const t = trace({ v: 100 }, [])
    const verdict = holds<TestState>((s) => s.v < 0).until(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('holds')
  })
})

describe('holds(p).weakUntil(q) — weak-U (#571)', () => {
  test('holds when q is reached and p held until then (same as until)', () => {
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 100 } },
    ])
    const verdict = holds<TestState>((s) => s.v < 100).weakUntil(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('holds')
  })

  test('holds when q never holds but p holds throughout', () => {
    // The defining difference from strong-U: q is not required
    // to be reached if p holds for the entire trace.
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
    ])
    const verdict = holds<TestState>((s) => s.v >= 0).weakUntil(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('holds')
  })

  test('fails when p stops holding before q', () => {
    const t = trace({ v: 0 }, [
      { action: null, state: { v: -1 } }, // p violated, q not yet held
    ])
    const verdict = holds<TestState>((s) => s.v >= 0).weakUntil(
      (s) => s.v >= 100,
    )(t)
    expect(verdict).toBe('fails')
  })
})
