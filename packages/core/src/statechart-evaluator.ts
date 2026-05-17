/**
 * @packageDocumentation
 *
 * Default `evaluateStatechart` implementation used by the
 * {@link JsBackend} in `./backend.ts`. This module hosts the pure
 * decision logic the BackendEngine seam exposes for the SPEC §6
 * composite-statechart's two implemented regions (ConflictRegistry
 * and ResourceFleet). Landed by issue #1068 as the deferred-from-#698
 * extension point.
 *
 * ## Why this lives in `@causl/core`
 *
 * The canonical reducers — `reduceConflict` and `reduceResource` —
 * live in `@causl/sync/src/statechart-reducers.ts` (PR #1056). The
 * BackendEngine seam in `@causl/core` cannot import from `@causl/sync`
 * (dependency direction is `sync → core`, not the reverse). To wire
 * the JsBackend's `evaluateStatechart` op without inverting the
 * package graph, this module hosts a **structurally-equivalent
 * dispatch** that mirrors the sync-side reducers' decision logic
 * one-to-one.
 *
 * The duplication is bounded (~50 LoC of decision logic; the docs
 * stay on the sync side as the contract-of-record). The two
 * implementations are kept byte-equivalent by the cross-backend
 * determinism property test (mirrored on the `@causl/sync` test side
 * in `packages/sync/test/statechart-reducers.test.ts`'s
 * `evaluateStatechart` agreement-with-reducer block): if the sync
 * reducer ever diverges from this evaluator, the gate fails CI.
 *
 * ## Why not move the reducers into core
 *
 * That would tighten the architecture (single source of truth in
 * `@causl/core`, sync re-exports), but it churns the sync package's
 * internal module layout and the existing
 * `packages/sync/test/statechart-reducers.test.ts` import path. PR
 * #1056 chose the sync-side carve as the contract; #1068's scope is
 * the extension point itself, not a re-layout of the reducer's
 * home. A future slice may consolidate; today the two homes coexist
 * with the determinism gate.
 *
 * ## Structural-only typing
 *
 * The seam types in `./backend.ts` (`StatechartInput`,
 * `StatechartResult`, `ForbiddenStatechartTransition`) type the
 * inputs and outputs structurally — `unknown` for the region-typed
 * payloads. This evaluator narrows the structural inputs through
 * region-tag and event-kind switches, identical to the sync-side
 * reducers' control flow. Adopter callers on the `@causl/sync` side
 * hold typed values and re-narrow the result's `next` after the seam
 * round-trip.
 *
 * @see issue #698 — extract pure statechart reducers.
 * @see issue #1068 — Rust enums + this extension point.
 * @see PR #1056 — TS reducer carve-out
 *   (`packages/sync/src/statechart-reducers.ts`).
 * @see `tools/engine-rs-core/src/statechart_reducers.rs` — Rust
 *   vocabulary committed under `feature = "future"`; the WASM
 *   backend's `evaluateStatechart` (Sub-D of EPIC #680) replaces this
 *   evaluator with a Rust-side implementation.
 */

import type { GraphTime, NodeId } from './types.js'
import type {
  ForbiddenStatechartTransition,
  StatechartInput,
  StatechartResult,
} from './backend.js'

// ---------------------------------------------------------------------------
// ConflictRegistry reducer — mirrors @causl/sync/src/statechart-reducers.ts
// ---------------------------------------------------------------------------

/**
 * Structural ConflictEvent shape. Mirrors the TS `ConflictEvent` DU
 * from `@causl/sync/src/statechart-reducers.ts` exactly, repeated here
 * because the seam strips the region-typed shape at the BackendEngine
 * boundary.
 */
type ConflictEventShape =
  | { readonly kind: 'resolve'; readonly resolution: unknown }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'supersede'; readonly bySupersedingId: NodeId }

/**
 * Structural ConflictReducerState — the five-tag union (four chart
 * states + the synthetic `'unknown'` sentinel for unregistered ids).
 */
type ConflictStateShape =
  | 'unknown'
  | 'open'
  | 'resolved'
  | 'ignored'
  | 'superseded'

/**
 * ConflictRegistry sub-statechart dispatch. Mirrors
 * `reduceConflict` from `@causl/sync/src/statechart-reducers.ts`.
 *
 * The chart has exactly three outgoing edges from `Open` and zero
 * outgoing edges from any terminal. Every legal transition produces
 * a `ConflictResolutionRecord` stamped with `at = time`; the
 * region-agnostic `StatechartResult.next` slot carries that record
 * structurally.
 */
function evaluateConflict(
  state: ConflictStateShape,
  event: ConflictEventShape,
  time: GraphTime,
  id: NodeId,
): StatechartResult {
  // Map the event tag to the corresponding target-state tag — used
  // for both the success record and the forbidden-rejection reason.
  // The mapping is total over `ConflictEventShape`.
  const to: 'resolved' | 'ignored' | 'superseded' =
    event.kind === 'resolve'
      ? 'resolved'
      : event.kind === 'ignore'
        ? 'ignored'
        : 'superseded'

  // The only legal source state for any transition is `open`. Every
  // other tag — terminals and the synthetic `unknown` — is rejected.
  if (state !== 'open') {
    const reason: ForbiddenStatechartTransition = {
      region: 'conflict',
      from: state,
      to,
      id,
    }
    return { kind: 'forbidden', reason }
  }

  // Open → terminal. Each event names exactly one chart edge.
  switch (event.kind) {
    case 'resolve':
      return {
        kind: 'ok',
        next: { kind: 'resolved', value: event.resolution, at: time },
      }
    case 'ignore':
      return { kind: 'ok', next: { kind: 'ignored', at: time } }
    case 'supersede':
      return {
        kind: 'ok',
        next: {
          kind: 'superseded',
          bySupersedingId: event.bySupersedingId,
          at: time,
        },
      }
  }
}

// ---------------------------------------------------------------------------
// ResourceFleet reducer — mirrors @causl/sync/src/statechart-reducers.ts
// ---------------------------------------------------------------------------

/**
 * Structural ResourceEvent shape. Mirrors `ResourceEvent` from
 * `@causl/sync/src/statechart-reducers.ts`. The promise slot is
 * `unknown` here because the seam never inspects the promise.
 */
type ResourceEventShape =
  | {
      readonly kind: 'fetch-start'
      readonly origin: GraphTime
      readonly promise: unknown
    }
  | {
      readonly kind: 'fetch-resolve'
      readonly value: unknown
      readonly loadingAt: GraphTime
      readonly stalenessGuard: boolean
    }
  | { readonly kind: 'fetch-reject'; readonly error: unknown }
  | { readonly kind: 'invalidate' }
  | { readonly kind: 'fail'; readonly error: unknown }

/**
 * Structural ResourceReducerState shape. Mirrors
 * `ResourceReducerState<T>` from
 * `@causl/sync/src/statechart-reducers.ts`. Generic `T` is structural
 * `unknown` at the seam.
 */
type ResourceStateShape =
  | { readonly state: 'idle' }
  | {
      readonly state: 'loading'
      readonly origin: GraphTime
      readonly promise: unknown
    }
  | {
      readonly state: 'loaded'
      readonly value: unknown
      readonly origin: GraphTime
      readonly loadedAt: GraphTime
    }
  | {
      readonly state: 'stale'
      readonly value: unknown
      readonly origin: GraphTime
      readonly loadedAt: GraphTime
    }
  | {
      readonly state: 'errored'
      readonly error: unknown
      readonly origin: GraphTime
      readonly erroredAt: GraphTime
    }

/**
 * ResourceFleet sub-statechart dispatch. Mirrors `reduceResource`
 * from `@causl/sync/src/statechart-reducers.ts` exactly.
 *
 * Chart edges (see `docs/lifecycle.md` §1, ResourceFleet region):
 * - `* → Loading` via `fetch-start` (host-driven trigger).
 * - `Loading → Loaded` via `fetch-resolve` (no staleness).
 * - `Loading → Stale` via `fetch-resolve` (SPEC §9.1 guard fires).
 * - `Loading → Errored` via `fetch-reject` or `Loading → Errored`
 *   via `fail`.
 * - `Loaded → Stale` via `invalidate` (no-op on every other source).
 * - `Loaded → Errored` via `fail`.
 *
 * Every other source state for `fetch-resolve`, `fetch-reject`, or
 * `fail` is forbidden — these are the rejection cases
 * `ForbiddenResourceTransitionError` catches today.
 */
function evaluateResource(
  state: ResourceStateShape,
  event: ResourceEventShape,
  time: GraphTime,
  id: NodeId,
): StatechartResult {
  switch (event.kind) {
    // `* → Loading` is unconditional in the chart — issuing a fetch
    // from any source state is the host-driven trigger.
    case 'fetch-start':
      return {
        kind: 'ok',
        next: {
          state: 'loading',
          origin: event.origin,
          promise: event.promise,
        },
      }
    // `Loading → Loaded | Stale` is legal only from `loading`. Every
    // other source state is a forbidden edge.
    case 'fetch-resolve': {
      if (state.state !== 'loading') {
        const reason: ForbiddenStatechartTransition = {
          region: 'resource',
          from: state.state,
          to: 'loaded',
          id,
        }
        return { kind: 'forbidden', reason }
      }
      // Staleness guard: if any other commit advanced GraphTime
      // between the loading commit and this resolve, the loader's
      // value is no longer authoritative for `origin`.
      const isStale = event.stalenessGuard && time > event.loadingAt
      return {
        kind: 'ok',
        next: isStale
          ? {
              state: 'stale',
              value: event.value,
              origin: state.origin,
              loadedAt: time,
            }
          : {
              state: 'loaded',
              value: event.value,
              origin: state.origin,
              loadedAt: time,
            },
      }
    }
    // `Loading → Errored` via the loader's rejection branch. Legal
    // only from `loading`.
    case 'fetch-reject': {
      if (state.state !== 'loading') {
        const reason: ForbiddenStatechartTransition = {
          region: 'resource',
          from: state.state,
          to: 'errored',
          id,
        }
        return { kind: 'forbidden', reason }
      }
      return {
        kind: 'ok',
        next: {
          state: 'errored',
          error: event.error,
          origin: state.origin,
          erroredAt: time,
        },
      }
    }
    // `Loaded → Stale` via `invalidate`. Every other source state is
    // a chart-named no-op (the pre-#698 silent-no-op).
    case 'invalidate': {
      if (state.state !== 'loaded') {
        // No-op — the chart has no edge from this source state
        // under this trigger. The sync-side shell reads `next ===
        // state` and skips the commit, preserving the pre-#698
        // GraphTime ledger.
        return { kind: 'ok', next: state }
      }
      return {
        kind: 'ok',
        next: {
          state: 'stale',
          value: state.value,
          origin: state.origin,
          loadedAt: state.loadedAt,
        },
      }
    }
    // `Loading | Loaded → Errored` via the host-side `fail()` trigger.
    // Every other source state is forbidden and surfaces through
    // `ForbiddenResourceTransitionError` on the wiring side.
    case 'fail':
      if (state.state !== 'loading' && state.state !== 'loaded') {
        const reason: ForbiddenStatechartTransition = {
          region: 'resource',
          from: state.state,
          to: 'errored',
          id,
        }
        return { kind: 'forbidden', reason }
      }
      return {
        kind: 'ok',
        next: {
          state: 'errored',
          error: event.error,
          origin: state.origin,
          erroredAt: time,
        },
      }
  }
}

// ---------------------------------------------------------------------------
// Region dispatcher — the JsBackendOps.evaluateStatechart payload
// ---------------------------------------------------------------------------

/**
 * Default `evaluateStatechart` implementation wired into the
 * {@link JsBackend} by `createCausl`. Dispatches by `input.region`
 * to either {@link evaluateConflict} or {@link evaluateResource}.
 *
 * The structural input narrowing matches the sync-side
 * `reduceConflict` / `reduceResource` contracts exactly. The
 * cross-backend determinism gate (the sync-side property test that
 * pins agreement with this evaluator) keys on this byte-equality.
 *
 * @param input - Region-tagged envelope from the BackendEngine seam.
 * @returns The reducer result, region-agnostic at the seam.
 *
 * @see {@link StatechartInput} — input envelope shape.
 * @see {@link StatechartResult} — result shape.
 * @see `@causl/sync/src/statechart-reducers.ts` — canonical contract.
 */
export function evaluateStatechart(input: StatechartInput): StatechartResult {
  switch (input.region) {
    case 'conflict':
      return evaluateConflict(
        input.state as ConflictStateShape,
        input.event as ConflictEventShape,
        input.time,
        input.id,
      )
    case 'resource':
      return evaluateResource(
        input.state as ResourceStateShape,
        input.event as ResourceEventShape,
        input.time,
        input.id,
      )
  }
}
