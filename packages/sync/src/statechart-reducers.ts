/**
 * @packageDocumentation
 *
 * Pure statechart reducers for the SPEC §6 composite lifecycle's two
 * implemented adapter regions: ResourceFleet and ConflictRegistry. A
 * reducer here is a pure function `(state, event, time) → Result<state,
 * ForbiddenTransition>` — no graph reads, no commits, no closure capture
 * of engine state, no clock access beyond the `time` argument the caller
 * supplies. The wiring shells in `./resource.ts` and `./conflict.ts`
 * remain the engine adapters: they translate engine I/O (read a node,
 * commit a patch) into reducer calls and route the result back through
 * the `Input<T>` the engine actually owns. The reducer is the migration
 * target.
 *
 * ## Why a carve-out lives here
 *
 * SPEC §6 commits the team to "one composite statechart for *every*
 * lifecycle in the system" — resource fetch, conflict status,
 * transaction phases, interaction modes share one chart with shared
 * event vocabulary. EPIC #680 (the WASM backend epic) calls out the
 * composite statechart as the **highest-leverage** future Rust carve:
 * Rust's zero-cost enums and exhaustiveness checks are this region's
 * natural home, and the translation from TS to Rust is mechanical *only
 * if* the reducer is already a pure function. If the reducer is tangled
 * with `graph.input` / `graph.derived` registration calls (the pre-#698
 * shape), the future Rust migration becomes a rewrite. Issue #698
 * carves the boundary now, while the engine is still TS-only, so the
 * eventual move is a translation rather than a re-design.
 *
 * ## Discipline
 *
 * Every exported function in this module:
 *
 * 1. Takes `(state, event, time)` (or the closest analogue — the
 *    conflict reducer additionally takes the conflict id because the
 *    registry's state is a `Map<NodeId, …>` and the reducer's job is to
 *    decide what record, if any, to set for one specific key). The
 *    `time` argument is always the caller's GraphTime; the reducer does
 *    not call `graph.now`.
 * 2. Returns a {@link TransitionResult} discriminated union — `ok` with
 *    the next state, or `forbidden` with the source/target tags. There
 *    are no thrown errors inside the reducer; the registration shell
 *    decides whether to throw based on the result.
 * 3. Is referentially transparent: calling the reducer twice with the
 *    same inputs returns byte-identical outputs (modulo object identity
 *    on the wrapping result; the value of the produced state is
 *    structurally equal). This is the determinism property `#698` calls
 *    out for the eventual Rust port — same contract as
 *    `transition_phased`.
 *
 * No closure-captured graph handles, no `graph.input` calls inside, no
 * implicit time reads. If a reducer here needs more inputs to make its
 * decision, those inputs flow in as arguments — the caller (the
 * registration shell) supplies them after reading from the graph.
 *
 * ## What is intentionally NOT here
 *
 * - The `Input<T>` allocation, the `Derived<T>` overlay, the `commit`
 *   call, and the `graph.read` / `graph.now` reads — those live in
 *   `./resource.ts` and `./conflict.ts` as the < 30-line shell the
 *   #698 exit criterion names.
 * - The public typed errors (`ForbiddenResourceTransitionError`,
 *   `ForbiddenConflictTransitionError`) — those are the wiring shell's
 *   surface, not the reducer's. The reducer returns a structural
 *   {@link ForbiddenTransition} record; the shell wraps it in the
 *   throwable shape callers catch.
 * - The Rust `engine-rs-core` enum gates (`#[cfg(feature = "future")]`)
 *   — those land separately as the migration target consumes them; the
 *   TS-side carve does not import Rust types.
 *
 * @see SPEC.md §6 — Composite statechart, regions 2 (ResourceFleet) and
 *   3 (ConflictRegistry).
 * @see docs/lifecycle.md §1 — the chart proper.
 * @see issue #698 — extract pure statechart reducers (this module's
 *   reason-to-exist).
 * @see issue #680 — the WASM backend epic this carve-out unblocks.
 */

import type { GraphTime, NodeId } from '@causl/core'

// ---------------------------------------------------------------------------
// Common reducer return shape
// ---------------------------------------------------------------------------

/**
 * Structural description of a forbidden statechart transition. The
 * tuple `(region, from, to, id)` is enough for a wiring shell to
 * construct the public typed error, and enough for a future Rust port
 * to map onto a `ForbiddenTransition` enum without rewriting the
 * decision logic.
 *
 * @remarks
 * Kept structural (not a class, not a thrown value) so the reducer
 * stays a pure function. The shell decides whether to throw; the
 * reducer decides whether the transition was permitted by the chart.
 */
export interface ForbiddenTransition {
  /** Which orthogonal region the rejection comes from. */
  readonly region: 'resource' | 'conflict'
  /**
   * Source state tag as the chart names it. For the conflict region
   * this includes the synthetic `'unknown'` tag (the registry has
   * never observed the id); the chart itself has no `Unknown` state.
   */
  readonly from: string
  /** Target state tag the rejected event would have moved to. */
  readonly to: string
  /** The node id the event targeted. */
  readonly id: NodeId
}

/**
 * Discriminated result returned by every pure reducer in this module.
 *
 * @remarks
 * The `ok` arm carries the next state; the `forbidden` arm carries
 * enough metadata for the wiring shell to construct the appropriate
 * typed error. The reducer never throws — exception-based control
 * flow does not translate cleanly to a future Rust port where the
 * natural shape is `Result<State, ForbiddenTransition>`.
 *
 * @typeParam S - State type produced on the `ok` arm.
 */
export type TransitionResult<S> =
  | { readonly kind: 'ok'; readonly next: S }
  | { readonly kind: 'forbidden'; readonly reason: ForbiddenTransition }

// ---------------------------------------------------------------------------
// ConflictRegistry sub-statechart reducer
// ---------------------------------------------------------------------------

/**
 * One of the four states a conflict can occupy in the §6
 * ConflictRegistry region, or the synthetic `'unknown'` tag for ids
 * the registry has never observed. The chart itself has no `Unknown`
 * state; the synthetic tag exists so the reducer can report
 * "transition rejected because the id is not registered" without
 * silently materialising an `open` record.
 *
 * @see SPEC.md §6.1, ConflictRegistry region — "Open | Resolved |
 *   Ignored | Superseded".
 */
export type ConflictReducerState =
  | 'unknown'
  | 'open'
  | 'resolved'
  | 'ignored'
  | 'superseded'

/**
 * Internal record kept in the registry's resolution `Input<Map>`.
 *
 * @remarks
 * Mirrors the discriminated-union shape the registration shell stores;
 * exported here so the reducer module is the single source of truth
 * for the record's shape. The shell imports this type and feeds the
 * reducer's `next` value straight back into a `commit`.
 *
 * Each variant carries the GraphTime `at` which the transition
 * committed and any payload supplied by the caller of the matching
 * mutator.
 */
export type ConflictResolutionRecord =
  | { readonly kind: 'resolved'; readonly value: unknown; readonly at: GraphTime }
  | { readonly kind: 'ignored'; readonly at: GraphTime }
  | { readonly kind: 'superseded'; readonly bySupersedingId: NodeId; readonly at: GraphTime }

/**
 * Event vocabulary the ConflictRegistry reducer accepts. Each event
 * names exactly one chart edge out of `Open`; the reducer rejects the
 * event when the source state is not `open`.
 *
 * @remarks
 * The vocabulary is intentionally narrow — the three legal outgoing
 * edges from `Open` plus the data each carries. The chart has no
 * `Raise` edge into `Open` because the open-set membership is a
 * derived projection of the application's compute, not a mutator
 * event; the reducer does not see raise events.
 */
export type ConflictEvent =
  | { readonly kind: 'resolve'; readonly resolution: unknown }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'supersede'; readonly bySupersedingId: NodeId }

/**
 * Pure reducer for the ConflictRegistry sub-statechart. Given the
 * conflict's current state, an event, and the GraphTime at which the
 * caller wants the transition stamped, return either the next
 * resolution record (which the wiring shell commits to the registry's
 * resolution Input) or a structural rejection.
 *
 * @remarks
 * The chart has exactly three outgoing edges from `Open` and zero
 * outgoing edges from any terminal. Every legal transition writes a
 * fresh {@link ConflictResolutionRecord} stamped with `at = time`. The
 * reducer does not read the graph and does not call `now()`; the
 * caller supplies `time` after reading `graph.now` once per mutator
 * call.
 *
 * Determinism: same `(state, event, time, id)` always returns a
 * structurally-equal result. Calling twice produces the same `kind`
 * and, on the `ok` arm, a record whose fields compare equal under
 * structural comparison. This is the byte-identity property #698
 * names for the future Rust port.
 *
 * @param state - The current conflict state, or `'unknown'` if the id
 *   is not registered.
 * @param event - One of the three legal mutator events out of `Open`.
 * @param time - GraphTime at which the transition is being requested;
 *   stamped onto the produced record on success.
 * @param id - Conflict id targeted by the event; echoed back in the
 *   rejection record when the transition is forbidden.
 * @returns Either `{ kind: 'ok', next }` carrying the resolution
 *   record to commit, or `{ kind: 'forbidden', reason }` carrying
 *   enough metadata to construct
 *   {@link ./conflict.ts!ForbiddenConflictTransitionError}.
 */
export function reduceConflict(
  state: ConflictReducerState,
  event: ConflictEvent,
  time: GraphTime,
  id: NodeId,
): TransitionResult<ConflictResolutionRecord> {
  // Map the event tag to the corresponding target-state tag once;
  // used for both the success record and the forbidden-rejection
  // reason. The mapping is total over `ConflictEvent`.
  const to: 'resolved' | 'ignored' | 'superseded' =
    event.kind === 'resolve'
      ? 'resolved'
      : event.kind === 'ignore'
        ? 'ignored'
        : 'superseded'
  // The only legal source state for any transition is `open`. Every
  // other tag — terminals and the synthetic `unknown` — is rejected.
  if (state !== 'open') {
    return {
      kind: 'forbidden',
      reason: { region: 'conflict', from: state, to, id },
    }
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
        next: { kind: 'superseded', bySupersedingId: event.bySupersedingId, at: time },
      }
  }
}

// ---------------------------------------------------------------------------
// ResourceFleet sub-statechart reducer
// ---------------------------------------------------------------------------

/**
 * Tagged-union state of a single resource. Mirrors the public
 * `ResourceState<T>` exported from `./resource.ts` exactly; re-stated
 * here as the reducer's input/output shape so the reducer module
 * compiles without depending on the wiring shell (the dependency
 * direction is shell → reducer, never the reverse).
 *
 * @typeParam T - Resolved value type produced by the loader.
 */
export type ResourceReducerState<T> =
  | { readonly state: 'idle' }
  | { readonly state: 'loading'; readonly origin: GraphTime; readonly promise: Promise<unknown> }
  | { readonly state: 'loaded'; readonly value: T; readonly origin: GraphTime; readonly loadedAt: GraphTime }
  | { readonly state: 'stale'; readonly value: T; readonly origin: GraphTime; readonly loadedAt: GraphTime }
  | { readonly state: 'errored'; readonly error: unknown; readonly origin: GraphTime; readonly erroredAt: GraphTime }

/**
 * Event vocabulary the ResourceFleet reducer accepts. Each event
 * names exactly one chart edge family; the reducer routes onto the
 * legal target state when the source state permits it, and rejects
 * otherwise.
 *
 * @remarks
 * - `fetch-start`: caller wants to begin a load. Legal from any
 *   source state — issuing a fetch from `idle`, `loaded`, `stale`,
 *   `errored`, or even mid-`loading` is the host-driven trigger. The
 *   reducer always produces `loading` with the caller's `origin` and
 *   the caller-supplied Suspense `promise`.
 * - `fetch-resolve`: the loader resolved. Routes to `loaded` when
 *   `loadedAt === loadingAt` (no other commit intervened) or to
 *   `stale` when `loadedAt > loadingAt` (the §9.1 staleness guard).
 *   Legal only from `loading`.
 * - `fetch-reject`: the loader rejected. Routes to `errored`. Legal
 *   only from `loading` (the chart-named `Loading → Errored`
 *   `fetch-reject` edge).
 * - `invalidate`: caller wants to mark a Loaded value as Stale. Legal
 *   from `loaded` (the chart-named `Loaded → Stale` edge); no-op on
 *   every other source state, matching the existing
 *   {@link ./resource.ts!ResourceHandle.invalidate} silent-no-op
 *   behaviour. The reducer reports the no-op as `kind: 'ok'` with
 *   `next` unchanged structurally; the shell sees no change and
 *   skips the commit.
 * - `fail`: caller wants to drive a host-side `* → Errored`. Legal
 *   only from `loading` and `loaded`; every other source state
 *   rejects with `ForbiddenTransition`.
 */
export type ResourceEvent =
  | {
      readonly kind: 'fetch-start'
      readonly origin: GraphTime
      readonly promise: Promise<unknown>
    }
  | {
      readonly kind: 'fetch-resolve'
      /** Loader's resolved value, deposited onto `loaded` or `stale`. */
      readonly value: unknown
      /** GraphTime captured immediately after the loading commit. */
      readonly loadingAt: GraphTime
      /** Whether the staleness guard is enabled (default true). */
      readonly stalenessGuard: boolean
    }
  | { readonly kind: 'fetch-reject'; readonly error: unknown }
  | { readonly kind: 'invalidate' }
  | { readonly kind: 'fail'; readonly error: unknown }

/**
 * Pure reducer for the ResourceFleet sub-statechart. Given the
 * resource's current state, an event, the GraphTime at which the
 * transition is being stamped, and the resource id, return either
 * the next `ResourceReducerState` (which the wiring shell commits to
 * the resource's Input) or a structural rejection.
 *
 * @remarks
 * The chart's legal edges (from `docs/lifecycle.md` §1, ResourceFleet
 * region):
 *
 * - `* → Loading` via `fetch-start` (the host-driven trigger).
 * - `Loading → Loaded` via `fetch-resolve` when the staleness guard
 *   does not fire.
 * - `Loading → Stale` via `fetch-resolve` when `loadedAt > loadingAt`
 *   and the guard is enabled.
 * - `Loading → Errored` via `fetch-reject` (the loader's rejection or
 *   the host-side `fail()` from `loading`).
 * - `Loaded → Stale` via `invalidate`.
 * - `Loaded → Errored` via `fail` (the host-side
 *   `invalidate(error)` trigger named on the chart).
 *
 * Every other source state for `fetch-resolve`, `fetch-reject`, or
 * `fail` is forbidden — those are exactly the rejection cases
 * `ForbiddenResourceTransitionError` catches today.
 *
 * `invalidate` on any source state other than `loaded` is the
 * chart-named no-op (the chart has no `Idle → Stale`, no
 * `Stale → Stale` self-loop, no `Errored → Stale` edge); the reducer
 * surfaces this as `{ kind: 'ok', next: state }`, identical to the
 * pre-#698 silent-no-op behaviour on the wiring side.
 *
 * Determinism: same `(state, event, time, id)` always returns a
 * structurally-equal result. The reducer does not consult any clock
 * or graph state outside its arguments.
 *
 * @typeParam T - Resolved value type produced by the loader.
 */
export function reduceResource<T>(
  state: ResourceReducerState<T>,
  event: ResourceEvent,
  time: GraphTime,
  id: NodeId,
): TransitionResult<ResourceReducerState<T>> {
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
        return {
          kind: 'forbidden',
          reason: { region: 'resource', from: state.state, to: 'loaded', id },
        }
      }
      // Staleness guard: if any other commit advanced GraphTime
      // between the loading commit and this resolve, the loader's
      // value is no longer authoritative for `origin`.
      const isStale = event.stalenessGuard && time > event.loadingAt
      return {
        kind: 'ok',
        next: isStale
          ? { state: 'stale', value: event.value as T, origin: state.origin, loadedAt: time }
          : { state: 'loaded', value: event.value as T, origin: state.origin, loadedAt: time },
      }
    }
    // `Loading → Errored` via the loader's rejection branch. Legal
    // only from `loading`.
    case 'fetch-reject': {
      if (state.state !== 'loading') {
        return {
          kind: 'forbidden',
          reason: { region: 'resource', from: state.state, to: 'errored', id },
        }
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
    case 'invalidate':
      if (state.state !== 'loaded') {
        // No-op — the chart has no edge from this source state under
        // this trigger. The shell reads `state === state` and skips
        // the commit, preserving the pre-#698 GraphTime ledger.
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
    // `Loading | Loaded → Errored` via the host-side `fail()`
    // trigger. Every other source state is forbidden and surfaces
    // through ForbiddenResourceTransitionError on the wiring side.
    case 'fail':
      if (state.state !== 'loading' && state.state !== 'loaded') {
        return {
          kind: 'forbidden',
          reason: { region: 'resource', from: state.state, to: 'errored', id },
        }
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
