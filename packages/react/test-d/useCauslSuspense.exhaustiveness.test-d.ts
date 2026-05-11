/**
 * Compile-time exhaustiveness fixture for SuspendableResource<T> (#231).
 *
 * PR #182 review row 4 (P0): adding a sixth tag to the union must
 * produce a type-check failure, not a runtime throw at first render.
 *
 * The runtime assertNever(x: never) in useCauslSuspense.ts is
 * belt-and-suspenders only -- SPEC section 9 commits the engine-wide
 * discipline that every discriminated union is enforced structurally
 * at compile time. This fixture is the load-bearing gate.
 *
 * Mechanism (three independent locks; any one failing breaks tsc):
 *
 *   Lock 1 (AssertExact) -- locks the current 5-tag set. Adding or
 *   removing a tag widens or narrows the Tags union; the equality
 *   probe fails to type-check, breaking pnpm typecheck.
 *
 *   Lock 2 (Widened negative-assertion) -- proves the union is not
 *   open. A hypothetical 6th-tag value cannot be assigned back to
 *   SuspendableResource<T>; ts-expect-error requires tsc to flag the
 *   line. If the assignment silently succeeds (e.g. union widened to
 *   structural shape), ts-expect-error reports unused-directive.
 *
 *   Lock 3 (assertNever switch probe) -- a switch over Tags with all
 *   five arms covered must satisfy a never parameter at the default
 *   arm. If a sixth tag were added without a matching case, value
 *   reaching the default would not be never and tsc would fail.
 *   Mirrors the actual call-site in useCauslSuspense.ts.
 *
 * Naming: *.test-d.ts is the conventional suffix for type-only tests.
 * The file is included by tsconfig.json via test-d/**\/* so tsc
 * --noEmit (the existing CI step) is the gate. No new dependency, no
 * new runner, no new CI hook.
 *
 * No runtime assertions in this file. Runtime exhaustiveness mirror
 * lives in test/useCauslSuspense.test.tsx.
 */

import type { SuspendableResource } from '../src/useCauslSuspense.js'

// The discriminator tag set under test. Sourced through the public
// SuspendableResource<T> re-export; touching the source-side type
// propagates here immediately.
type Tags = SuspendableResource<unknown>['state']

// Bidirectional-extends equality. Plain extends is one-directional;
// the bidirectional form is the canonical "exact match" probe in
// TypeScript type-level testing.
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Lock 1: exact 5-tag closure. If a sixth tag is added, Tags widens;
// the equality below resolves to false and the annotation fails. If
// a tag is removed, the same probe fails the other direction.
type _ExactTagSet = AssertExact<Tags, 'idle' | 'loading' | 'loaded' | 'stale' | 'errored'>
const _tagSet: _ExactTagSet = true
void _tagSet

// Lock 2: closure under widening. A hypothetical 6th-tag union does
// NOT assign back to SuspendableResource<T>. The ts-expect-error
// directive *requires* tsc to flag the line; if the assignment
// silently succeeds (e.g. because the union was widened to a
// structural shape rather than a tagged closure), the directive
// itself reports an unused-directive diagnostic and CI fails. Either
// failure mode breaks the build -- that is the exhaustiveness gate.
type Widened<T> = SuspendableResource<T> | { readonly state: 'cancelled' }
declare const widenedSample: Widened<number>
// @ts-expect-error -- adding a 6th tag must break assignment back to
// the canonical SuspendableResource union (would otherwise fall
// through to runtime assertNever in production code).
const _wider: SuspendableResource<number> = widenedSample
void _wider

// Lock 3: assertNever exhaustiveness pattern. A function that
// switches over Tags with all five arms covered must satisfy a never
// parameter at the default arm. If a sixth tag were added without a
// matching case, value reaching _assertExhaustive would not be never
// and the call would fail to type-check. Mirrors the actual
// call-site in useCauslSuspense.ts.
declare function _assertExhaustive(_value: never): never
function _exhaustivenessImpl<T>(r: SuspendableResource<T>): T | never {
  switch (r.state) {
    case 'idle':
      return undefined as never
    case 'loading':
      return undefined as never
    case 'loaded':
      return r.value
    case 'stale':
      return r.value
    case 'errored':
      return undefined as never
    default:
      return _assertExhaustive(r)
  }
}
void _exhaustivenessImpl
