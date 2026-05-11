/**
 * Compile-time exhaustiveness fixture for `@causl/sync`'s
 * `ConflictKind` discriminated union (#581).
 *
 * Pins the closed four-arm shape: `open | resolved | ignored |
 * superseded`. The runtime contract is verified by
 * `conflict-lifecycle-exhaustiveness.property.test.ts`; this file
 * is the load-bearing compile-time gate.
 *
 * Per SPEC.async §6, the conflict sub-statechart has exactly one
 * non-terminal state (`open`) with three outgoing transitions
 * (`resolve`, `ignore`, `supersede`) leading to three terminal
 * states. Adding a fifth state — or widening an existing arm's
 * payload — re-creates the "make-impossible-states-impossible"
 * failure mode the four-arm union exists to prevent.
 */

import { expectType } from 'tsd'
import type { ConflictKind } from '../src/index.js'

// ─── Lock 1: closed-tag set ─────────────────────────────────────────

type AssertEquals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false

const _kindsClosed: AssertEquals<
  ConflictKind,
  'open' | 'resolved' | 'ignored' | 'superseded'
> = true
void _kindsClosed

// Direct typeOf assertion — duplicates the lock at a different
// API surface so a future change to ConflictKind that satisfies
// AssertEquals through some structural fluke still trips here.
declare const kind: ConflictKind
expectType<'open' | 'resolved' | 'ignored' | 'superseded'>(kind)

// ─── Lock 2: exhaustiveness via assertNever ─────────────────────────

function assertNever(_value: never): never {
  throw new Error('unreachable')
}

function isTerminal(k: ConflictKind): boolean {
  switch (k) {
    case 'open':
      return false
    case 'resolved':
      return true
    case 'ignored':
      return true
    case 'superseded':
      return true
    default:
      return assertNever(k)
  }
}

void isTerminal

// The closed-tag AssertEquals lock plus the assertNever
// exhaustiveness gate above are the load-bearing negative
// tests — both fail to compile if a fifth tag is added or an
// existing tag is renamed. Foreign-tag tests via `satisfies`
// produce ts errors tsd doesn't classify under expectError,
// so the negative coverage lives in the AssertEquals lock.
