/**
 * @packageDocumentation
 *
 * SPEC §16.5.1 semantic fixes — closes the high-value subset of
 * #571 + #588 (merged) the Phase 8 critical review identified:
 *
 *   1. `afterCommit(p)` evaluates `p` at the IMMEDIATE successor of
 *      each commit, not at every step after the first commit.
 *      Pre-#571 the impl flipped a `seenCommit` flag and then
 *      evaluated `p` at every subsequent state forever — a
 *      "stays-true-after-first-commit" semantics, not the
 *      "true-immediately-after-each-matching-commit" SPEC names.
 *
 *   2. `eventually(p)` returns `'unknown'` when the trace is
 *      truncated by a bound and no witness was found. Pre-#571 the
 *      impl returned `'fails'` for this case, conflating "the
 *      property doesn't hold" with "we ran out of trace before
 *      checking". This is the three-valued honesty SPEC §16.5.1
 *      commits to and #588's A9-3 finding called out.
 *
 *   3. `fromPredicate(name, fn)` factory exported. Pre-#571 SPEC
 *      named the factory but no export shipped — adopters writing
 *      named predicates for counterexample reports had to hand-roll
 *      the wrapper.
 *
 * The follow-on work (CommitMatcher arg to afterCommit, builder
 * DSL `holds(p).until(q)`, axis-2/3 shrinker, hypothesis() factory)
 * is tracked in #571's body and lands in subsequent PRs — the
 * SPEC.async-canonical tests + fixtures need to settle first.
 */

import { describe, expect, test } from 'vitest'
import {
  afterCommit,
  eventually,
  fromPredicate,
} from '../src/index.js'
import type { Hypothesis, Trace } from '../src/index.js'

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

describe('#571 / A9-1 — afterCommit fires at the immediate successor of each commit', () => {
  test('p at start state is irrelevant (no commit observed yet)', () => {
    // Before any commit is seen, afterCommit should not evaluate p.
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 } },
      { action: { kind: 'noop' }, state: { v: 2 } },
    ])
    // p is intentionally false at every state; without a commit in
    // the trace, afterCommit must hold (vacuously true).
    const result = afterCommit<TestState>((s) => s.v === 999)(t)
    expect(result).toBe('holds')
  })

  test('p at the successor state is checked once per commit (positive case)', () => {
    // commit at index 1 — the successor (index 2) must satisfy p.
    const t = trace({ v: 0 }, [
      { action: { kind: 'noop' }, state: { v: 1 } },
      { action: { kind: 'commit' }, state: { v: 2 } },
      { action: { kind: 'noop' }, state: { v: 3 } },
    ])
    // The state-after-commit is { v: 2 }. p tests v === 2.
    const result = afterCommit<TestState>((s) => s.v === 2)(t)
    expect(result).toBe('holds')
  })

  test('p must hold at every commit-successor (multiple commits)', () => {
    // Two commits at indices 0 and 2. Successors are { v: 1 } and { v: 3 }.
    const t = trace({ v: 0 }, [
      { action: { kind: 'commit' }, state: { v: 1 } },
      { action: { kind: 'noop' }, state: { v: 2 } },
      { action: { kind: 'commit' }, state: { v: 3 } },
    ])
    // p holds at both commit successors (every state is positive).
    expect(afterCommit<TestState>((s) => s.v > 0)(t)).toBe('holds')

    // p fails at the second commit's successor.
    expect(afterCommit<TestState>((s) => s.v < 2)(t)).toBe('fails')
  })

  test('p violation between commits does not fail (only successors are checked)', () => {
    // Commits at 0 and 2. Successor states { v: 5 } and { v: 5 }.
    // Intermediate state { v: 100 } is between commits — afterCommit
    // must NOT evaluate p there (the SPEC's "successor of a commit"
    // is exactly one step after each commit).
    const t = trace({ v: 0 }, [
      { action: { kind: 'commit' }, state: { v: 5 } },
      { action: { kind: 'noop' }, state: { v: 100 } },
      { action: { kind: 'commit' }, state: { v: 5 } },
    ])
    // p tests v === 5 — true at both successors, false at the
    // intermediate state. Pre-#571 this would have failed at the
    // intermediate state under the "every-step-after-first-commit"
    // semantics. SPEC's semantics says it should hold.
    expect(afterCommit<TestState>((s) => s.v === 5)(t)).toBe('holds')
  })
})

describe('#571 / A9-3 — eventually returns unknown on bounded exhaustion', () => {
  test('returns holds when a witness is found (bound irrelevant)', () => {
    const t = trace(
      { v: 0 },
      [{ action: null, state: { v: 1 } }],
      /* bounded */ true,
    )
    expect(eventually<TestState>((s) => s.v === 1)(t)).toBe('holds')
  })

  test('returns fails when bound is NOT hit and no witness found', () => {
    const t = trace(
      { v: 0 },
      [{ action: null, state: { v: 1 } }],
      /* bounded */ false,
    )
    // Trace was complete (not truncated) and the predicate never
    // held — that's a real failure.
    expect(eventually<TestState>((s) => s.v === 999)(t)).toBe('fails')
  })

  test("returns unknown when bound IS hit and no witness found", () => {
    const t = trace(
      { v: 0 },
      [{ action: null, state: { v: 1 } }],
      /* bounded */ true,
    )
    // Trace was truncated by the enumerator's bound. The predicate
    // didn't hold within the partial trace — but we cannot conclude
    // it never holds (a longer trace might satisfy it). The honest
    // answer is 'unknown'.
    expect(eventually<TestState>((s) => s.v === 999)(t)).toBe('unknown')
  })
})

describe('#571 — fromPredicate factory exports a named hypothesis wrapper', () => {
  test('wraps a state predicate as a hypothesis equivalent to always(p)', () => {
    const positive = fromPredicate<TestState>('positive', (s) => s.v >= 0)
    const t = trace({ v: 0 }, [
      { action: null, state: { v: 1 } },
      { action: null, state: { v: 2 } },
    ])
    expect(positive(t)).toBe('holds')
  })

  test('the wrapped hypothesis carries the supplied name on the function', () => {
    const positive = fromPredicate<TestState>('positive-only', (s) => s.v >= 0)
    // The name is exposed for counterexample reports.
    expect(
      (positive as Hypothesis<TestState> & { hypothesisName?: string })
        .hypothesisName,
    ).toBe('positive-only')
  })

  test('a named hypothesis fails when the predicate is violated', () => {
    const allTwo = fromPredicate<TestState>('all-two', (s) => s.v === 2)
    const t = trace({ v: 0 }, [{ action: null, state: { v: 1 } }])
    expect(allTwo(t)).toBe('fails')
  })
})
