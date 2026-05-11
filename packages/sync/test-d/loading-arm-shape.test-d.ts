/**
 * Compile-time fixture for SPEC.async §3.1 Theorem 3 —
 * Promise-identity stability (#575).
 *
 * SPEC.async §3.1 (line 251) prescribes:
 *
 *   "The type-fixture gate `loading-arm-shape.types.ts` asserts via
 *   tsd that `Extract<ResourceState<unknown>, { state: 'loading' }>['promise']`
 *   is reachable directly from the union and is not optional — the
 *   field cannot be elided to a side-channel without `tsc --noEmit`
 *   failing."
 *
 * Theorem 3 (Promise-identity stability) requires that every read of
 * a resource in the `loading` arm during one loading episode returns
 * the SAME Promise reference. The contract depends on the field
 * existing on the union itself, not behind a discriminator-tagged
 * accessor or in a sibling registry. If a future refactor moves
 * `promise` to an optional field, or onto a separate `LoadingMeta`
 * shape, React's SuspenseList breaks: it would receive a fresh
 * Promise per render, suspend forever, and never resolve.
 *
 * tsd-naming note: file lives in `test-d/` (the standard tsd
 * directory) rather than the SPEC's original `test/theorems/`
 * location — same content, different location. The typecheck:test-d
 * workspace gate (#581) picks it up automatically.
 */

import { expectAssignable, expectType } from 'tsd'
import type { ResourceState } from '../src/index.js'

// ─── Lock 1: 'loading' arm has a 'promise' field, non-optional ──────

type LoadingArm<T> = Extract<ResourceState<T>, { state: 'loading' }>

// Reachable directly: typing a value as the loading-arm extraction
// must include `promise` as a required field. tsd's expectType
// rejects the assertion if the field becomes optional.
declare const loadingState: LoadingArm<number>

// Non-optional: this assignment must succeed without `?`-narrowing.
expectType<Promise<unknown>>(loadingState.promise)

// ─── Lock 2: 'promise' field carries a Promise type ─────────────────

// The field type must be assignable to Promise<unknown>. The
// adapter wraps the user-supplied loader's promise in a
// .then(() => undefined, () => undefined) chain that produces a
// Promise<unknown> with stable identity; the public type captures
// this with Promise<unknown>.
expectAssignable<Promise<unknown>>(loadingState.promise)

// ─── Lock 3: loading-arm carries origin (GraphTime) ─────────────────

// Theorem 1 (origin pinning) requires the loading arm to carry the
// originating GraphTime. If a future widening drops `origin` from
// loading, both Theorem 1 and Theorem 3 break.
expectType<number>(loadingState.origin)

// ─── Lock 4: 'loaded'/'stale' arms also carry origin (Theorem 1) ────

type LoadedArm<T> = Extract<ResourceState<T>, { state: 'loaded' }>
type StaleArm<T> = Extract<ResourceState<T>, { state: 'stale' }>
type ErroredArm<T> = Extract<ResourceState<T>, { state: 'errored' }>

declare const loaded: LoadedArm<number>
declare const stale: StaleArm<number>
declare const errored: ErroredArm<number>

// Each non-idle arm carries the originating GraphTime. The chart
// transitions preserve this — Theorem 1 is total over the four
// non-idle arms.
expectType<number>(loaded.origin)
expectType<number>(stale.origin)
expectType<number>(errored.origin)

// ─── Lock 5: 'loaded'/'stale' carry value, 'errored' carries error ──

expectType<number>(loaded.value)
expectType<number>(stale.value)
expectType<unknown>(errored.error)
expectType<number>(loaded.loadedAt)
expectType<number>(stale.loadedAt)
expectType<number>(errored.erroredAt)

// ─── Lock 6: idle arm has NO origin/value (it's pre-fetch) ──────────

type IdleArm = Extract<ResourceState<number>, { state: 'idle' }>
type IdleKeys = keyof IdleArm

// Idle arm has only `state`. If a future widening adds origin/value/
// promise to idle, this AssertEquals fails.
type AssertEquals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false

const _idleKeysClosed: AssertEquals<IdleKeys, 'state'> = true
void _idleKeysClosed
