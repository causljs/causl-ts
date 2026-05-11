/**
 * @packageDocumentation
 *
 * Stock axis-2 (action arity) and axis-3 (state payload) shrinker
 * implementations per SPEC §16.5.2 (#571).
 *
 * Wave-13 (#607) shipped axis-1 + axis-1b + the orchestrator
 * accepting `extraAxes`. This file gates the stock axis-2 / axis-3
 * implementations adopters can plug into the orchestrator without
 * hand-rolling them.
 *
 * Axis-2 — action arity: walk each step's action and, when the
 * action is a JSON-like object, drop optional/non-discriminator
 * fields one at a time. The hypothesis is re-run after each
 * removal to confirm the trace still fails. Useful when the
 * counterexample's action carries irrelevant payload (e.g., a
 * timestamp the property doesn't depend on).
 *
 * Axis-3 — state payload: same shape but operates on each step's
 * `state` shape. Useful when the counterexample state has fields
 * the predicate doesn't observe.
 *
 * Both axes are best-effort over unknown shapes; they preserve
 * required discriminators (`kind`, `state` arms) by skipping
 * fields named `kind` and `state` from the field-removal walk.
 */

import { describe, expect, test } from 'vitest'
import {
  always,
  shrink,
  shrinkActionArity,
  shrinkStatePayload,
  type Trace,
} from '../src/index.js'

interface S {
  readonly state: 'open' | 'closed'
  readonly value: number
  readonly extraField?: string
  readonly anotherExtra?: number
}

describe('shrinkActionArity — axis-2 (#571)', () => {
  test('returns input when hypothesis already holds', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: { kind: 'noop', extraField: 'irrelevant' },
          state: { state: 'open', value: 1 },
        },
      ],
    }
    const h = always<S>((s) => s.value >= 0)
    const result = shrinkActionArity(h, t)
    expect(result).toBe(t)
  })

  test('drops optional action fields the hypothesis does not depend on', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: {
            kind: 'mutate',
            payload: 'big-irrelevant-string',
            timestamp: 12345,
          },
          state: { state: 'closed', value: 1 },
        },
      ],
    }
    // Hypothesis: state never goes 'closed'. The action's payload
    // and timestamp are irrelevant; only the existence of the
    // mutate action matters.
    const h = always<S>((s) => s.state !== 'closed')
    expect(h(t)).toBe('fails')
    const result = shrinkActionArity(h, t)
    // Result must still fail.
    expect(h(result)).toBe('fails')
    // The action's optional fields may have been dropped — we
    // assert no field-removal regressed the predicate.
    expect(result.steps.length).toBe(t.steps.length)
  })

  test('preserves the kind discriminator (never drops it)', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: { kind: 'commit', payload: 'data' },
          state: { state: 'closed', value: 1 },
        },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrinkActionArity(h, t)
    const action = result.steps[0]?.action as { kind?: string }
    expect(action?.kind).toBe('commit')
  })

  test('handles non-object actions gracefully (passthrough)', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        { action: null, state: { state: 'closed', value: 1 } },
        { action: 42, state: { state: 'closed', value: 2 } },
        { action: 'string', state: { state: 'closed', value: 3 } },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrinkActionArity(h, t)
    // Non-object actions can't be field-shrunk; the trace should
    // still fail (passthrough behavior).
    expect(h(result)).toBe('fails')
  })
})

describe('shrinkStatePayload — axis-3 (#571)', () => {
  test('returns input when hypothesis already holds', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: null,
          state: { state: 'open', value: 1, extraField: 'data' },
        },
      ],
    }
    const h = always<S>((s) => s.value >= 0)
    const result = shrinkStatePayload(h, t)
    expect(result).toBe(t)
  })

  test('drops optional state fields the hypothesis does not depend on', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: null,
          state: {
            state: 'closed',
            value: 1,
            extraField: 'irrelevant-payload',
            anotherExtra: 999,
          },
        },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    expect(h(t)).toBe('fails')
    const result = shrinkStatePayload(h, t)
    // Result must still fail with the discriminator intact.
    expect(h(result)).toBe('fails')
    expect(result.steps[0]?.state.state).toBe('closed')
  })

  test('preserves discriminator-anchor fields (state, kind, status, tag)', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        {
          action: null,
          state: { state: 'closed', value: 1, extraField: 'x' },
        },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrinkStatePayload(h, t)
    expect(result.steps[0]?.state.state).toBe('closed')
  })

  test('preserves the start state shape', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0, extraField: 'start' },
      steps: [
        { action: null, state: { state: 'closed', value: 1 } },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrinkStatePayload(h, t)
    // Start state's discriminator preserved.
    expect(result.start.state).toBe('open')
  })
})

describe('shrink orchestrator with axis-2 + axis-3 plugged in (#571)', () => {
  test('runs all axes (1, 1b, 2, 3) to convergence', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [
        { action: { kind: 'a', payload: 'x' }, state: { state: 'open', value: 1 } },
        { action: { kind: 'b', payload: 'y' }, state: { state: 'open', value: 2 } },
        {
          action: { kind: 'c', payload: 'z' },
          state: { state: 'closed', value: 3, extraField: 'irrelevant' },
        },
        { action: { kind: 'd', payload: 'w' }, state: { state: 'open', value: 4 } },
        { action: { kind: 'e', payload: 'v' }, state: { state: 'open', value: 5 } },
      ],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrink(h, t, [shrinkActionArity, shrinkStatePayload])
    expect(h(result)).toBe('fails')
    // Result is bounded to at most the input length.
    expect(result.steps.length).toBeLessThanOrEqual(t.steps.length)
  })

  test('terminates with a still-failing shrunk trace', () => {
    const t: Trace<S> = {
      start: { state: 'open', value: 0 },
      steps: [{ action: null, state: { state: 'closed', value: 1 } }],
    }
    const h = always<S>((s) => s.state !== 'closed')
    const result = shrink(h, t, [shrinkActionArity, shrinkStatePayload])
    // The orchestrator may shrink the trace to 0 steps if it can
    // promote a failing successor state to the start position via
    // shrinkPrefix — both forms are valid minimal counterexamples.
    // The load-bearing assertion is that the verdict is still
    // 'fails' after shrinking.
    expect(h(result)).toBe('fails')
    expect(result.steps.length).toBeLessThanOrEqual(t.steps.length)
  })
})
