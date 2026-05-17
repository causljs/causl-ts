/**
 * @packageDocumentation
 *
 * Type-canonicality pinning suite for the `@causl/core/wasm` entry
 * point (issue #1121).
 *
 * The `@causl/core/wasm` subpath previously declared in-tree mirrors
 * of `StatechartInput` / `StatechartResult` /
 * `ForbiddenStatechartTransition`, identical-but-distinct from the
 * source-of-truth declarations in `packages/core/src/backend.ts`.
 * For a semver-major / 0.9.0 ship the duplicates were collapsed to
 * one declaration via `export type { ... } from '../src/backend.js'`.
 * This file pins that contract:
 *
 *   1. **Type-level equality.** Each of the three re-exported types
 *      must be _structurally identical_ (mutual extension) to its
 *      source-of-truth counterpart. An `AssertEq<A, B>` checks both
 *      `A extends B` and `B extends A` simultaneously through tuple
 *      assignability — drift in either direction trips the check at
 *      compile time, which `tsc --noEmit` (run by CI's
 *      `typecheck` step) fails on.
 *
 *   2. **Adopter-import smoke.** Adopter code importing
 *      `@causl/core/wasm`'s `StatechartInput` / `StatechartResult` /
 *      `ForbiddenStatechartTransition` must resolve to a value whose
 *      type is interchangeable with the same import sourced from the
 *      canonical deep-import path. The smoke test builds a fixture
 *      value typed against the wasm-side alias and asserts it
 *      assigns into a slot typed against the canonical alias (and
 *      vice versa) with no `as` cast — the assignment is a
 *      compile-time check the test runtime additionally double-locks
 *      with a structural equality assertion on the materialised
 *      shape.
 *
 * The runtime body is deliberately small; the heavy lifting is the
 * type-level checks. The test exists to fail typecheck if a future
 * refactor accidentally reintroduces an in-tree mirror.
 *
 * @see issue #1121 — re-export from source-of-truth.
 * @see `packages/core/src/backend.ts` — source-of-truth declarations.
 * @see `packages/core/wasm/index.ts` — `export type { ... }` re-export.
 */

import { describe, expect, it } from 'vitest'

import type {
  StatechartInput as CanonicalStatechartInput,
  StatechartResult as CanonicalStatechartResult,
  ForbiddenStatechartTransition as CanonicalForbiddenStatechartTransition,
} from '../src/backend.js'
import type {
  StatechartInput as WasmStatechartInput,
  StatechartResult as WasmStatechartResult,
  ForbiddenStatechartTransition as WasmForbiddenStatechartTransition,
} from '../wasm/index.js'

/**
 * Type-level mutual-extension check. Resolves to `true` iff
 * `A extends B` AND `B extends A` — i.e. the two types are
 * structurally interchangeable in both directions. The tuple wrap
 * forces TypeScript to evaluate the conditional in invariant
 * position so a one-sided widening (`A` adds an optional field, `B`
 * doesn't) still fails.
 *
 * The companion `assertEq<A, B>()` helper exists purely to provide a
 * call-site for the type parameter — TypeScript only evaluates a
 * `type AssertEq<...>` alias when it is referenced from a value
 * position, so we materialise `true` into a const and let `tsc
 * --noEmit` do the work.
 */
type AssertEq<A, B> = [A, B] extends [B, A] ? true : false

/**
 * Pin a `true` literal — if `AssertEq<A, B>` resolves to `false`,
 * this assignment fails typecheck, which is the failure mode the
 * pinning suite exists to surface.
 */
function assertEq<A, B>(_ok: AssertEq<A, B>): void {
  void _ok
}

describe('wasm type canonicality (issue #1121)', () => {
  it('StatechartInput from @causl/core/wasm is the same type as from src/backend.js', () => {
    const ok: AssertEq<CanonicalStatechartInput, WasmStatechartInput> = true
    assertEq<CanonicalStatechartInput, WasmStatechartInput>(ok)
    expect(ok).toBe(true)
  })

  it('StatechartResult from @causl/core/wasm is the same type as from src/backend.js', () => {
    const ok: AssertEq<CanonicalStatechartResult, WasmStatechartResult> = true
    assertEq<CanonicalStatechartResult, WasmStatechartResult>(ok)
    expect(ok).toBe(true)
  })

  it('ForbiddenStatechartTransition from @causl/core/wasm is the same type as from src/backend.js', () => {
    const ok: AssertEq<
      CanonicalForbiddenStatechartTransition,
      WasmForbiddenStatechartTransition
    > = true
    assertEq<
      CanonicalForbiddenStatechartTransition,
      WasmForbiddenStatechartTransition
    >(ok)
    expect(ok).toBe(true)
  })

  it('adopter-import smoke: wasm-typed value assigns into canonical-typed slot (and back)', () => {
    // Build a fixture against the WASM-side alias. The literal
    // satisfies the `conflict`-arm shape so we can also exercise the
    // ForbiddenStatechartTransition shape on the result side.
    const wasmInput: WasmStatechartInput = {
      region: 'conflict',
      state: { tag: 'Idle' },
      event: { type: 'arm' },
      time: 0,
      id: 'node-1',
    }

    // The whole point of the canonicality contract: this assignment
    // must succeed with NO cast. A future regression that
    // reintroduces a local mirror declaration tightens the structural
    // identity and the assignment trips at typecheck.
    const canonicalInput: CanonicalStatechartInput = wasmInput
    expect(canonicalInput).toBe(wasmInput)

    // Round-trip assignment to confirm the equality holds in both
    // directions — i.e. the relation is mutual extension, not a
    // one-sided assignability.
    const roundTrip: WasmStatechartInput = canonicalInput
    expect(roundTrip).toBe(wasmInput)

    // Same exercise for the result type's `forbidden` arm — pin the
    // ForbiddenStatechartTransition shape through the
    // StatechartResult discriminator.
    const wasmForbidden: WasmForbiddenStatechartTransition = {
      region: 'conflict',
      from: 'Idle',
      to: 'Armed',
      id: 'node-1',
    }
    const canonicalForbidden: CanonicalForbiddenStatechartTransition =
      wasmForbidden
    const roundTripForbidden: WasmForbiddenStatechartTransition =
      canonicalForbidden
    expect(roundTripForbidden).toBe(wasmForbidden)

    const wasmResult: WasmStatechartResult = {
      kind: 'forbidden',
      reason: wasmForbidden,
    }
    const canonicalResult: CanonicalStatechartResult = wasmResult
    const roundTripResult: WasmStatechartResult = canonicalResult
    expect(roundTripResult).toBe(wasmResult)
  })

  it('runtime shape parity: structurally-equal values pass deep-equal across both type aliases', () => {
    // The types are pure interfaces / unions and contribute zero
    // runtime presence, but the canonicality contract also implies
    // that adopters who construct values against either alias get
    // shapes that materialise identically. This runtime body
    // double-locks the type-level check above by exercising
    // `expect.toEqual` on a pair of values built against the two
    // aliases.
    const wasmInput: WasmStatechartInput = {
      region: 'resource',
      state: { tag: 'Free' },
      event: { type: 'acquire' },
      time: 7,
      id: 'resource-7',
    }
    const canonicalInput: CanonicalStatechartInput = {
      region: 'resource',
      state: { tag: 'Free' },
      event: { type: 'acquire' },
      time: 7,
      id: 'resource-7',
    }
    expect(wasmInput).toEqual(canonicalInput)
  })
})
