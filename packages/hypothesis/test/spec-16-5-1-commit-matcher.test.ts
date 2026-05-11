/**
 * @packageDocumentation
 *
 * SPEC §16.5.1 `afterCommit(match: CommitMatcher, p)` overload (#571).
 *
 * SPEC §16.5.1 prescribes a CommitMatcher arg on afterCommit so
 * adopters can target a subset of commits (by node touched, by
 * intent tag, or `any: true`). Wave-2 (#595) shipped the
 * single-arg `afterCommit(p)` semantic fix (immediate-successor
 * filtering). This wave adds the matcher overload while
 * preserving back-compat with the single-arg form.
 *
 * The two-arg form's `match` parameter:
 *   - `touches: NodeId` — fires for commits whose `changedNodes`
 *     includes the named id.
 *   - `tag: string` — fires for commits whose `intent` contains
 *     the named substring (e.g., `tag: 'fetch:'` matches every
 *     resource fetch commit per SPEC.async §6).
 *   - `any: true` — fires for every commit (equivalent to the
 *     single-arg form).
 *
 * The `phase === 'idle'` gate from SPEC §16.5.1 is documented
 * but currently a no-op since the simple Trace shape doesn't
 * carry phase. A future schema bump on Trace adds the gate
 * proper.
 */

import { describe, expect, test } from 'vitest'
import { afterCommit, type Trace } from '../src/index.js'

interface TestState {
  readonly v: number
}

interface TestAction {
  readonly kind: string
  readonly intent?: string
  readonly changedNodes?: readonly string[]
}

function trace(
  start: TestState,
  steps: readonly { action: TestAction | null; state: TestState }[],
): Trace<TestState> {
  return { start, steps }
}

describe('#571 / afterCommit({ touches }, p) — node-targeted matcher', () => {
  test('fires only for commits whose changedNodes includes the named id', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', changedNodes: ['inputA'] },
        state: { v: 1 },
      },
      {
        action: { kind: 'commit', changedNodes: ['inputB'] },
        state: { v: 100 },
      },
      {
        action: { kind: 'commit', changedNodes: ['inputA'] },
        state: { v: 2 },
      },
    ])
    // Predicate: post-commit value is small. Fails if applied to
    // the inputB commit (state.v = 100). With the touches-matcher,
    // only the two inputA commits are checked, and both are small.
    const verdict = afterCommit<TestState>(
      { touches: 'inputA' },
      (s) => s.v < 50,
    )(t)
    expect(verdict).toBe('holds')
  })

  test('fails when a matched commit has a violating successor state', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', changedNodes: ['inputA'] },
        state: { v: 999 }, // violates the predicate
      },
    ])
    const verdict = afterCommit<TestState>(
      { touches: 'inputA' },
      (s) => s.v < 50,
    )(t)
    expect(verdict).toBe('fails')
  })

  test('vacuously holds when no commit matches the touches filter', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', changedNodes: ['inputB'] },
        state: { v: 100 },
      },
    ])
    const verdict = afterCommit<TestState>(
      { touches: 'inputA' },
      (s) => s.v < 50,
    )(t)
    // No matching commit → vacuously holds.
    expect(verdict).toBe('holds')
  })
})

describe('#571 / afterCommit({ tag }, p) — intent-tag matcher', () => {
  test('fires for commits whose intent contains the tag substring', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', intent: 'fetch:user:start' },
        state: { v: 1 },
      },
      {
        action: { kind: 'commit', intent: 'invalidate:user' },
        state: { v: 2 },
      },
      {
        action: { kind: 'commit', intent: 'fetch:user:loaded' },
        state: { v: 3 },
      },
    ])
    // Match all 'fetch:' commits — there are two, and both have
    // small post-commit states.
    const verdict = afterCommit<TestState>(
      { tag: 'fetch:' },
      (s) => s.v < 50,
    )(t)
    expect(verdict).toBe('holds')
  })

  test('skips commits whose intent does not contain the tag', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', intent: 'invalidate:x' },
        state: { v: 999 }, // would fail if checked
      },
    ])
    // tag: 'fetch:' doesn't match — vacuously holds.
    const verdict = afterCommit<TestState>(
      { tag: 'fetch:' },
      (s) => s.v < 50,
    )(t)
    expect(verdict).toBe('holds')
  })
})

describe('#571 / afterCommit({ any: true }, p) — match-all', () => {
  test('matches every commit (equivalent to single-arg form)', () => {
    const t = trace({ v: 0 }, [
      { action: { kind: 'commit' }, state: { v: 1 } },
      { action: { kind: 'noop' }, state: { v: 2 } },
      { action: { kind: 'commit' }, state: { v: 3 } },
    ])
    const verdictMatcher = afterCommit<TestState>(
      { any: true },
      (s) => s.v < 50,
    )(t)
    const verdictSingle = afterCommit<TestState>((s) => s.v < 50)(t)
    expect(verdictMatcher).toBe(verdictSingle)
    expect(verdictMatcher).toBe('holds')
  })
})

describe('#571 / afterCommit single-arg back-compat', () => {
  // The single-arg form (wave-2) must keep working. This is
  // critical: no existing call site changes when the matcher
  // overload lands.
  test('afterCommit(p) without matcher still works', () => {
    const t = trace({ v: 0 }, [
      { action: { kind: 'commit' }, state: { v: 1 } },
    ])
    const verdict = afterCommit<TestState>((s) => s.v < 50)(t)
    expect(verdict).toBe('holds')
  })

  test('afterCommit(p) without matcher matches all commits (no filter)', () => {
    const t = trace({ v: 0 }, [
      {
        action: { kind: 'commit', changedNodes: ['inputB'] },
        state: { v: 999 }, // would only fail under match-all
      },
    ])
    const verdict = afterCommit<TestState>((s) => s.v < 50)(t)
    expect(verdict).toBe('fails')
  })
})

describe('#571 / matcher composition: touches + tag combine', () => {
  test('both touches and tag must match (AND semantics)', () => {
    const t = trace({ v: 0 }, [
      {
        action: {
          kind: 'commit',
          intent: 'fetch:user:start',
          changedNodes: ['user'],
        },
        state: { v: 1 },
      },
      {
        action: {
          kind: 'commit',
          intent: 'fetch:user:loaded',
          changedNodes: ['user'],
        },
        state: { v: 2 },
      },
      {
        action: {
          kind: 'commit',
          intent: 'fetch:other:start',
          changedNodes: ['other'],
        },
        state: { v: 999 }, // would fail if checked
      },
    ])
    // Both filters: must touch 'user' AND have 'fetch:' tag.
    // First two commits match; third doesn't (different node).
    const verdict = afterCommit<TestState>(
      { touches: 'user', tag: 'fetch:' },
      (s) => s.v < 50,
    )(t)
    expect(verdict).toBe('holds')
  })
})
