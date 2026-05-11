/**
 * @packageDocumentation
 *
 * SPEC §16.5.1 `during(phase, p)` overload (#571).
 *
 * SPEC §16.5.1 prescribes a phase-targeted form of `during`:
 *
 *   `during<S>(phase: PhaseStep, p: StepPredicate<S>): Predicate<S>`
 *
 * "at every step where `step.phase === phase`, evaluate `p`".
 *
 * The pre-fix impl in `combinators.ts` aliased every `during(...)`
 * call to `always(...)`, ignoring the phase parameter entirely. This
 * suite locks in the phase filter while preserving the back-compat
 * single-arg shape (`during(p)` continues to alias `always(p)` for
 * code that pre-dates the phase tag on `Step<S>`).
 *
 * Runtime dispatch: a function as the first argument selects the
 * single-arg back-compat form; a string selects the two-arg
 * phase-filtered form.
 */

import { describe, expect, test } from 'vitest'
import { always, during, type PhaseStep, type Trace } from '../src/index.js'

interface TestState {
  readonly v: number
}

function trace(
  start: TestState,
  steps: readonly {
    action: unknown
    state: TestState
    phase?: PhaseStep
  }[],
): Trace<TestState> {
  return { start, steps }
}

describe("#571 / during('idle', p) — phase-targeted filter", () => {
  test("evaluates p only at steps where phase === 'idle'", () => {
    // Two `idle` steps satisfy `v >= 0`; one `commit-fanout` step
    // has `v: -5` which would fail `v >= 0` if it were evaluated.
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 }, phase: 'idle' },
      {
        action: { kind: 'commit' },
        state: { v: -5 },
        phase: 'commit-fanout',
      },
      { action: { kind: 'noop' }, state: { v: 2 }, phase: 'idle' },
    ])
    expect(during('idle', (s: TestState) => s.v >= 0)(t)).toBe('holds')
  })

  test('fails when an idle step violates the predicate', () => {
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 }, phase: 'idle' },
      // The idle step here violates v >= 0.
      { action: { kind: 'noop' }, state: { v: -1 }, phase: 'idle' },
    ])
    expect(during('idle', (s: TestState) => s.v >= 0)(t)).toBe('fails')
  })
})

describe('#571 / during(phase, p) — back-compat with phase-less steps', () => {
  test('steps without a phase field are skipped (vacuous holds)', () => {
    // No step carries a phase, so nothing matches — predicate
    // is never evaluated, the trace holds vacuously.
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: -100 } },
      { action: { kind: 'noop' }, state: { v: -200 } },
    ])
    expect(during('idle', (s: TestState) => s.v >= 0)(t)).toBe('holds')
  })

  test('predicate violation at a non-matching phase does not fail', () => {
    // The `commit-fanout` step would fail `v >= 0`, but it's not
    // an `idle` step, so the phase filter excludes it.
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit' },
        state: { v: -10 },
        phase: 'commit-fanout',
      },
    ])
    expect(during('idle', (s: TestState) => s.v >= 0)(t)).toBe('holds')
  })
})

describe('#571 / during(p) — single-arg alias of always (back-compat)', () => {
  test('one-arg form behaves identically to always', () => {
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 }, phase: 'idle' },
      { action: { kind: 'noop' }, state: { v: 2 }, phase: 'commit-prepare' },
    ])
    const p = (s: TestState): boolean => s.v >= 0
    expect(during(p)(t)).toBe(always(p)(t))
    expect(during(p)(t)).toBe('holds')
  })

  test('one-arg form fails when any state violates p (matches always)', () => {
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 } },
      { action: { kind: 'noop' }, state: { v: -3 } },
    ])
    const p = (s: TestState): boolean => s.v >= 0
    expect(during(p)(t)).toBe(always(p)(t))
    expect(during(p)(t)).toBe('fails')
  })
})

describe('#571 / during(phase, p) — empty-trace and mixed-phase semantics', () => {
  test('empty trace holds vacuously', () => {
    const t = trace({ v: 0 }, [])
    expect(during('idle', (s: TestState) => s.v >= 0)(t)).toBe('holds')
  })

  test('multiple mixed phases — only matching phase contributes', () => {
    // Five steps spanning three phases. Only the two
    // `commit-fanout` steps should be evaluated; both satisfy
    // `v > 0`. The other phases include states that would fail
    // `v > 0` (the `commit-prepare` step has `v: 0`, the
    // `msg-dispatch` step has `v: -1`) but are skipped.
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit' },
        state: { v: 0 },
        phase: 'commit-prepare',
      },
      {
        action: { kind: 'commit' },
        state: { v: 5 },
        phase: 'commit-fanout',
      },
      {
        action: { kind: 'msg' },
        state: { v: -1 },
        phase: 'msg-dispatch',
      },
      {
        action: { kind: 'commit' },
        state: { v: 7 },
        phase: 'commit-fanout',
      },
      { action: { kind: 'noop' }, state: { v: 9 }, phase: 'idle' },
    ])
    expect(during('commit-fanout', (s: TestState) => s.v > 0)(t)).toBe('holds')
    // And a failing case to confirm the filter isn't accidentally
    // matching everything: `v >= 5` should fail at the second
    // `commit-fanout` step? No — both fanout states are >= 5.
    // Use `v >= 6` to break only on the first fanout step.
    expect(during('commit-fanout', (s: TestState) => s.v >= 6)(t)).toBe(
      'fails',
    )
  })
})
