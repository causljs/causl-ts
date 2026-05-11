/**
 * @packageDocumentation
 *
 * Hypothesis combinator tests — pin the SPEC §16.5.1 grammar
 * semantics. Every combinator gets a positive (`holds`) and a
 * negative (`fails`) fixture.
 */

import { describe, expect, it } from 'vitest'
import {
  always,
  and,
  atStart,
  during,
  eventually,
  evaluate,
  implies,
  never,
  or,
  shrinkStepCount,
  until,
  afterCommit,
  type Trace,
} from '../src/index.js'

interface S {
  readonly now: number
  readonly value: number
}

function trace(start: S, ...states: readonly S[]): Trace<S> {
  return {
    start,
    steps: states.map((state, i) => ({ action: { kind: 'tick', i }, state })),
  }
}

function commitTrace(start: S, ...states: readonly S[]): Trace<S> {
  return {
    start,
    steps: states.map((state, i) => ({ action: { kind: 'commit', i }, state })),
  }
}

describe('always', () => {
  it('holds when every state satisfies the predicate', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: 2 }, { now: 2, value: 3 })
    expect(always<S>((s) => s.value > 0)(t)).toBe('holds')
  })
  it('fails when any state violates', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: -1 })
    expect(always<S>((s) => s.value > 0)(t)).toBe('fails')
  })
})

describe('eventually', () => {
  it('holds when some state satisfies', () => {
    const t = trace({ now: 0, value: 0 }, { now: 1, value: 0 }, { now: 2, value: 5 })
    expect(eventually<S>((s) => s.value === 5)(t)).toBe('holds')
  })
  it('fails when no state satisfies', () => {
    const t = trace({ now: 0, value: 0 }, { now: 1, value: 1 })
    expect(eventually<S>((s) => s.value === 99)(t)).toBe('fails')
  })
})

describe('never', () => {
  it('holds when no state satisfies', () => {
    const t = trace({ now: 0, value: 0 }, { now: 1, value: 1 })
    expect(never<S>((s) => s.value < 0)(t)).toBe('holds')
  })
  it('fails when any state satisfies', () => {
    const t = trace({ now: 0, value: 0 }, { now: 1, value: -1 })
    expect(never<S>((s) => s.value < 0)(t)).toBe('fails')
  })
})

describe('until', () => {
  it('holds when p holds up to first q', () => {
    const t = trace(
      { now: 0, value: 1 },
      { now: 1, value: 1 },
      { now: 2, value: 99 }, // q holds here
    )
    expect(
      until<S>(
        (s) => s.value === 1,
        (s) => s.value === 99,
      )(t),
    ).toBe('holds')
  })
  it('fails when p violates before q holds', () => {
    const t = trace(
      { now: 0, value: 1 },
      { now: 1, value: 0 }, // p fails here
      { now: 2, value: 99 },
    )
    expect(
      until<S>(
        (s) => s.value === 1,
        (s) => s.value === 99,
      )(t),
    ).toBe('fails')
  })
  it('fails when q never holds', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: 1 })
    expect(
      until<S>(
        (s) => s.value === 1,
        (s) => s.value === 99,
      )(t),
    ).toBe('fails')
  })
})

describe('afterCommit', () => {
  it('holds when p holds after the first commit', () => {
    const t = commitTrace({ now: 0, value: 0 }, { now: 1, value: 5 }, { now: 2, value: 5 })
    expect(afterCommit<S>((s) => s.value === 5)(t)).toBe('holds')
  })
  it('fails when p violates after the first commit', () => {
    const t = commitTrace({ now: 0, value: 0 }, { now: 1, value: 5 }, { now: 2, value: 6 })
    expect(afterCommit<S>((s) => s.value === 5)(t)).toBe('fails')
  })
})

describe('during', () => {
  it('aliases always in v1', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: 2 })
    expect(during<S>((s) => s.value > 0)(t)).toBe('holds')
    expect(during<S>((s) => s.value > 1)(t)).toBe('fails')
  })
})

describe('implies', () => {
  it('holds vacuously when antecedent fails', () => {
    const t = trace({ now: 0, value: 0 })
    const a = always<S>((s) => s.value > 99) // fails
    const c = always<S>((s) => s.value > 99) // would also fail
    expect(implies(a, c)(t)).toBe('holds')
  })
  it('holds when both antecedent and consequent hold', () => {
    const t = trace({ now: 0, value: 1 })
    expect(
      implies(always<S>((s) => s.value > 0), always<S>((s) => s.value < 99))(t),
    ).toBe('holds')
  })
  it('fails when antecedent holds but consequent fails', () => {
    const t = trace({ now: 0, value: 1 })
    expect(
      implies(always<S>((s) => s.value > 0), always<S>((s) => s.value > 99))(t),
    ).toBe('fails')
  })
})

describe('and', () => {
  it('holds when every hypothesis holds', () => {
    const t = trace({ now: 0, value: 1 })
    expect(and(always<S>((s) => s.value > 0), always<S>((s) => s.value < 99))(t)).toBe('holds')
  })
  it('fails when any hypothesis fails', () => {
    const t = trace({ now: 0, value: 1 })
    expect(and(always<S>((s) => s.value > 0), always<S>((s) => s.value > 99))(t)).toBe('fails')
  })
})

describe('or', () => {
  it('holds when any hypothesis holds', () => {
    const t = trace({ now: 0, value: 1 })
    expect(or(always<S>((s) => s.value > 99), always<S>((s) => s.value > 0))(t)).toBe('holds')
  })
  it('fails when every hypothesis fails', () => {
    const t = trace({ now: 0, value: 1 })
    expect(or(always<S>((s) => s.value > 99), always<S>((s) => s.value > 100))(t)).toBe('fails')
  })
})

describe('atStart', () => {
  it('checks only the start state', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: -1 })
    expect(atStart<S>((s) => s.value > 0)(t)).toBe('holds')
    expect(atStart<S>((s) => s.value < 0)(t)).toBe('fails')
  })
})

describe('shrinkStepCount', () => {
  it('binary-searches the minimal failing prefix', () => {
    const t = trace(
      { now: 0, value: 1 },
      { now: 1, value: 1 },
      { now: 2, value: 1 },
      { now: 3, value: -1 }, // first failing state
      { now: 4, value: -1 },
      { now: 5, value: -1 },
    )
    const h = always<S>((s) => s.value > 0)
    const shrunk = shrinkStepCount(h, t)
    // The shortest failing prefix has 3 steps (the negative first
    // appears at step index 2, post-state index 3 in the trace's
    // [start, ...steps] view — so the prefix length is 3).
    expect(shrunk.steps.length).toBe(3)
    // And the shrunk trace still fails.
    expect(h(shrunk)).toBe('fails')
  })
  it('returns the original trace when the hypothesis holds', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: 2 })
    const h = always<S>((s) => s.value > 0)
    const shrunk = shrinkStepCount(h, t)
    expect(shrunk.steps.length).toBe(t.steps.length)
  })
})

describe('evaluate', () => {
  it('returns the verdict when holding', () => {
    const t = trace({ now: 0, value: 1 })
    const r = evaluate(always<S>((s) => s.value > 0), t)
    expect(r.verdict).toBe('holds')
    expect(r.counterexample).toBeUndefined()
  })
  it('returns a shrunk counterexample when failing', () => {
    const t = trace({ now: 0, value: 1 }, { now: 1, value: 1 }, { now: 2, value: -1 })
    const r = evaluate(always<S>((s) => s.value > 0), t)
    expect(r.verdict).toBe('fails')
    expect(r.counterexample).toBeDefined()
    expect(r.counterexample!.steps.length).toBeLessThanOrEqual(t.steps.length)
  })
})
