/**
 * @packageDocumentation
 *
 * Cross-implementation agreement property test for the SPEC §6
 * composite-statechart reducers. Pins the `JsBackend.evaluateStatechart`
 * extension point's default implementation
 * (`packages/core/src/statechart-evaluator.ts`) byte-equivalent with
 * the canonical reducer functions
 * (`reduceConflict` / `reduceResource` from
 * `packages/sync/src/statechart-reducers.ts`).
 *
 * Landed by issue #1068 as the cross-implementation determinism gate
 * for the statechart-reducer carve-out. Mirrors the cross-backend
 * gate in #685 (which keys on commit-log byte-equality across JS and
 * WASM backends); this gate keys on reducer-output byte-equality
 * across the two TS implementations (`@causljs/sync` canonical reducer
 * + the `@causljs/core` evaluator that the JsBackend's
 * `evaluateStatechart` method routes through).
 *
 * ## Why two implementations
 *
 * The package boundary forces the seam: `@causljs/core` cannot import
 * `@causljs/sync` (dependency direction is `sync → core`, not the
 * reverse). The `JsBackend.evaluateStatechart` extension point lives
 * in core; the canonical reducer lives in sync. Rather than invert
 * the package graph or factor the reducer into a third package, the
 * two implementations coexist with this gate enforcing
 * byte-equivalence. If the two ever drift, this property fails CI.
 *
 * Once the WASM backend's `evaluateStatechart` lands (Sub-D of EPIC
 * #680, consuming the
 * `tools/engine-rs-core/src/statechart_reducers.rs` enums gated
 * behind `feature = "future"`), a sibling property in
 * `packages/core/test/properties/cross-backend-determinism.property.test.ts`
 * extends this gate to a tri-implementation agreement (TS-reducer,
 * TS-evaluator, WASM-reducer).
 *
 * ## What this file covers
 *
 * - **ConflictRegistry region.** Every `(state × event × time × id)`
 *   combination from the arbitraries used in the canonical
 *   reducer's determinism property. The seam's
 *   `StatechartResult.next` is compared structurally against
 *   `reduceConflict(...).next`; the `forbidden.reason` is compared
 *   structurally against `reduceConflict(...).reason`.
 *
 * - **ResourceFleet region.** Same shape — every event variant
 *   sampled from `ResourceEvent`'s five arms against every source
 *   state from `ResourceReducerState<number>`'s five arms.
 *
 * @see issue #698 — extract pure statechart reducers.
 * @see issue #1068 — Rust enums + the `evaluateStatechart` extension
 *   point this gate keys on.
 * @see issue #685 — cross-backend determinism gate this gate mirrors.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { propertyTrials } from '@causljs/core-testing-internal'

import {
  reduceConflict,
  reduceResource,
  type ConflictEvent,
  type ConflictReducerState,
  type ResourceEvent,
  type ResourceReducerState,
} from '../../src/statechart-reducers.js'

// Deep import: the seam evaluator is not on `@causljs/core`'s public
// barrel — it is the package-internal implementation behind the
// `JsBackend.evaluateStatechart` op. Reaching across the workspace
// boundary via the src-relative path is the same pattern other
// cross-package tests use (see `packages/sync/test/why-updated.test.ts`
// imports of internal core helpers). The path resolves through
// vitest's workspace-aware module graph.
import { evaluateStatechart as evaluateStatechartViaSeam } from '../../../core/src/statechart-evaluator.js'

// ---------------------------------------------------------------------------
// ConflictRegistry agreement
// ---------------------------------------------------------------------------

describe('JsBackend.evaluateStatechart agrees with reduceConflict (SPEC §6 ConflictRegistry)', () => {
  it('produces structurally-equal results for every (state, event, time, id)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ConflictReducerState>(
          'open',
          'resolved',
          'ignored',
          'superseded',
          'unknown',
        ),
        fc.oneof(
          fc.record({
            kind: fc.constant('resolve' as const),
            resolution: fc.anything(),
          }),
          fc.record({ kind: fc.constant('ignore' as const) }),
          fc.record({
            kind: fc.constant('supersede' as const),
            bySupersedingId: fc.string({ minLength: 1, maxLength: 16 }),
          }),
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (state, event, time, id) => {
          // Canonical reducer (TS, `@causljs/sync`).
          const oracle = reduceConflict(state, event as ConflictEvent, time, id)
          // Seam evaluator (TS, `@causljs/core` — what the JsBackend's
          // `evaluateStatechart` op routes through).
          const seam = evaluateStatechartViaSeam({
            region: 'conflict',
            state,
            event,
            time,
            id,
          })
          // Both implementations MUST produce structurally-equal
          // outputs. The `ok` arm carries the same
          // `ConflictResolutionRecord`; the `forbidden` arm carries
          // the same `(region, from, to, id)` rejection metadata.
          expect(seam).toEqual(oracle)
        },
      ),
      propertyTrials('evaluateStatechart.conflict.agrees-with-reducer'),
    )
  })
})

// ---------------------------------------------------------------------------
// ResourceFleet agreement
// ---------------------------------------------------------------------------

describe('JsBackend.evaluateStatechart agrees with reduceResource (SPEC §6 ResourceFleet)', () => {
  it('produces structurally-equal results for every (state, event, time, id)', () => {
    // The reducer is generic over T; we pin T = number so the
    // arbitraries below can sample concrete payloads. The seam's
    // structural typing erases T at the boundary, but the
    // byte-equality of the produced `next` slot does not depend on T.
    const promise = Promise.resolve('handle-stand-in')
    const stateArb = fc.oneof(
      fc.record({ state: fc.constant('idle' as const) }),
      fc.record({
        state: fc.constant('loading' as const),
        origin: fc.integer({ min: 0, max: 1000 }),
        promise: fc.constant(promise),
      }),
      fc.record({
        state: fc.constant('loaded' as const),
        value: fc.integer(),
        origin: fc.integer({ min: 0, max: 1000 }),
        loadedAt: fc.integer({ min: 0, max: 1000 }),
      }),
      fc.record({
        state: fc.constant('stale' as const),
        value: fc.integer(),
        origin: fc.integer({ min: 0, max: 1000 }),
        loadedAt: fc.integer({ min: 0, max: 1000 }),
      }),
      fc.record({
        state: fc.constant('errored' as const),
        error: fc.string(),
        origin: fc.integer({ min: 0, max: 1000 }),
        erroredAt: fc.integer({ min: 0, max: 1000 }),
      }),
    )
    const eventArb = fc.oneof(
      fc.record({
        kind: fc.constant('fetch-start' as const),
        origin: fc.integer({ min: 0, max: 1000 }),
        promise: fc.constant(promise),
      }),
      fc.record({
        kind: fc.constant('fetch-resolve' as const),
        value: fc.integer(),
        loadingAt: fc.integer({ min: 0, max: 1000 }),
        stalenessGuard: fc.boolean(),
      }),
      fc.record({ kind: fc.constant('fetch-reject' as const), error: fc.string() }),
      fc.record({ kind: fc.constant('invalidate' as const) }),
      fc.record({ kind: fc.constant('fail' as const), error: fc.string() }),
    )

    fc.assert(
      fc.property(
        stateArb,
        eventArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (state, event, time, id) => {
          const oracle = reduceResource(
            state as ResourceReducerState<number>,
            event as ResourceEvent,
            time,
            id,
          )
          const seam = evaluateStatechartViaSeam({
            region: 'resource',
            state,
            event,
            time,
            id,
          })
          // Same byte-equality contract as the conflict block — ok-arm
          // `next` and forbidden-arm `reason` must match structurally.
          expect(seam).toEqual(oracle)
        },
      ),
      propertyTrials('evaluateStatechart.resource.agrees-with-reducer'),
    )
  })
})
