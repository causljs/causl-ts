/**
 * Compile-time exhaustiveness fixture for `@causljs/sync`'s
 * `ResourceState<T>` discriminated union (#581).
 *
 * Pins the closed five-arm shape: `idle | loading | loaded | stale |
 * errored`. The runtime contract is verified by the property witness
 * suite (`forbidden-resource-transitions.property.test.ts` and
 * friends); this file is the load-bearing compile-time gate proving
 * the union is *closed* — adding a sixth tag without a matching arm
 * in every consumer's switch is a type-check failure rather than a
 * runtime throw.
 *
 * SPEC §9 commits the engine-wide discipline that every discriminated
 * union is enforced structurally at compile time. The five-arm
 * `ResourceState<T>` is the §6 chart's per-resource sub-machine, and
 * widening it without updating consumers re-creates the
 * "make-impossible-states-impossible" failure mode the union exists
 * to prevent.
 *
 * Mechanism (three independent locks; any one failing breaks tsd):
 *
 *   Lock 1 (closed-tag set) — locks the five-tag union to exactly
 *   `'idle' | 'loading' | 'loaded' | 'stale' | 'errored'`. A future
 *   widening to a sixth tag fails the AssertEquals probe.
 *
 *   Lock 2 (per-arm payload narrowing) — confirms each tag narrows
 *   to its expected payload shape. Dropping `value` from the
 *   `loaded` arm or widening `origin` to `unknown` fails.
 *
 *   Lock 3 (exhaustiveness via assertNever) — confirms `assertNever`
 *   on the union catches drift: if a sixth arm lands without a
 *   matching `case`, this file fails to compile.
 */

import { expectAssignable, expectType } from 'tsd'
import type { ResourceState } from '../src/index.js'

// ─── Lock 1: closed-tag set ─────────────────────────────────────────

type ResourceStateTags<T> = ResourceState<T>['state']

type AssertEquals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false

const _tagsClosed: AssertEquals<
  ResourceStateTags<number>,
  'idle' | 'loading' | 'loaded' | 'stale' | 'errored'
> = true
void _tagsClosed

// ─── Lock 2: per-arm payload narrowing ──────────────────────────────

declare const state: ResourceState<number>

// Each arm narrows to its specific payload shape; tsd's expectType
// catches widening of any single field. Idle and Loading do not
// expose `value` — accessing `state.value` after narrowing to
// `'idle'` or `'loading'` would fail tsc, which the regular
// typecheck step already catches; this fixture focuses on the
// closed-tag set and the positive narrowings.
if (state.state === 'loading') {
  expectAssignable<{ origin: number; promise: Promise<unknown> }>(state)
}

if (state.state === 'loaded') {
  expectType<number>(state.value)
  expectAssignable<{ origin: number; loadedAt: number }>(state)
}

if (state.state === 'stale') {
  expectType<number>(state.value)
  expectAssignable<{ origin: number; loadedAt: number }>(state)
}

if (state.state === 'errored') {
  expectType<unknown>(state.error)
  expectAssignable<{ origin: number; erroredAt: number }>(state)
}

// ─── Lock 3: exhaustiveness via assertNever ─────────────────────────

function assertNever(_value: never): never {
  throw new Error('unreachable')
}

function describe<T>(s: ResourceState<T>): string {
  switch (s.state) {
    case 'idle':
      return 'idle'
    case 'loading':
      return 'loading'
    case 'loaded':
      return 'loaded'
    case 'stale':
      return 'stale'
    case 'errored':
      return 'errored'
    default:
      // If a sixth arm is added, this assertNever call fails to
      // compile — the engine's exhaustiveness discipline lives here.
      return assertNever(s)
  }
}

void describe

// The closed-tag set lock plus the assertNever exhaustiveness
// gate together prove that adding a sixth tag fails to compile.
// Foreign-tag negative tests aren't expressible in tsd without
// hitting unsupported error codes, but the AssertEquals lock
// fails identically when the union widens.
