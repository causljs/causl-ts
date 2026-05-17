/**
 * @packageDocumentation
 *
 * `@causljs/sync-testing-internal` — shared test helpers for the
 * SPEC.async §15 property suites.
 *
 * Per SPEC.async §15.0 API sketch: 13 named exports across six
 * generator factories, three harness factories, two event appliers,
 * and two shrinking-aware shape preservers.
 *
 * #578 alignment: as of wave-16, the harness factories
 * (propertyResource, propertyConflict, propertyConflictWithMap)
 * wrap a LIVE @causljs/core Graph with a real @causljs/sync
 * Resource / ConflictRegistry — replacing the pre-#578 model-
 * state simulation. The applyEvents / applyConflictEvents
 * functions retain their model-state signatures for back-compat
 * with the 13 existing property tests; live-Graph variants ship
 * alongside as applyEventsLive / applyConflictEventsLive.
 *
 * Test-only. Do not import from production code. Surfaced as a
 * peer-dep of `@causljs/sync`.
 */

import { createCausl, type Graph, type InputNode, type NodeId } from '@causljs/core'
import {
  createConflictRegistry,
  resource,
  type ConflictRegistry,
  type ResourceHandle,
} from '@causljs/sync'
import fc from 'fast-check'

/**
 * Generator for arbitrary `ResourceEvent` shapes. Produces one of
 * the five §6 chart events with a uniform-ish distribution.
 */
export interface ResourceEvent {
  readonly kind:
    | 'fetch-start'
    | 'fetch-resolve'
    | 'fetch-reject'
    | 'invalidate'
    | 'fail'
  readonly value?: number
  readonly error?: string
}

export const resourceEventGen: fc.Arbitrary<ResourceEvent> = fc.oneof(
  fc.record({ kind: fc.constant('fetch-start' as const) }),
  fc.record({
    kind: fc.constant('fetch-resolve' as const),
    value: fc.integer({ min: -100, max: 100 }),
  }),
  fc.record({
    kind: fc.constant('fetch-reject' as const),
    error: fc.string({ maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant('invalidate' as const) }),
  fc.record({ kind: fc.constant('fail' as const) }),
)

/**
 * Generator for arbitrary `ConflictEvent` shapes. Produces one of
 * the four §4 chart events.
 */
export interface ConflictEvent {
  readonly kind: 'raise' | 'resolve' | 'ignore' | 'supersede'
  readonly id: string
  readonly bySupersedingId?: string
}

export const conflictEventGen: fc.Arbitrary<ConflictEvent> = fc.oneof(
  fc.record({
    kind: fc.constant('raise' as const),
    id: fc.string({ minLength: 1, maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('resolve' as const),
    id: fc.string({ minLength: 1, maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('ignore' as const),
    id: fc.string({ minLength: 1, maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('supersede' as const),
    id: fc.string({ minLength: 1, maxLength: 4 }),
    bySupersedingId: fc.string({ minLength: 1, maxLength: 4 }),
  }),
)

/**
 * Conflict id generator — short alphanumeric strings.
 */
export const conflictIdGen: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 4,
})

/**
 * Loading episode — a contiguous sequence of resource events
 * that together drive a single fetch-begin → resolve/reject
 * cycle. Per SPEC.async §15.0 the LoadingEpisode shape is the
 * unit Property 2 (origin-bound resolution) shrinks against.
 */
export type LoadingEpisode = readonly ResourceEvent[]

/**
 * Loading-episode generator. A loading episode is a contiguous
 * interleaving of fetch-start / fetch-resolve / fetch-reject events.
 * Used by Property 2 (origin-bound resolution) which needs the
 * episode boundary preserved across shrinks.
 */
export const loadingEpisodeGen: fc.Arbitrary<LoadingEpisode> = fc.array(
  resourceEventGen,
  { minLength: 1, maxLength: 8 },
)

/**
 * Read schedule — a sequence of read offsets relative to a
 * fetch's lifecycle. Per SPEC.async §15.0 the ReadSchedule
 * shape is the unit Property 4 (Promise-identity stability)
 * generates over.
 */
export type ReadSchedule = readonly number[]

/**
 * Read-schedule generator — random read offsets relative to a
 * fetch's lifecycle. Used by Property 4 (Promise-identity
 * stability).
 */
export const readScheduleGen: fc.Arbitrary<ReadSchedule> = fc.array(
  fc.integer({ min: 0, max: 5 }),
  { minLength: 1, maxLength: 4 },
)

/**
 * Open-set sample — a sample of conflict ids that should be open
 * at the start of a property trial. Per SPEC.async §15.0.
 */
export type OpenSetSample = readonly string[]

/**
 * Open-set generator — sample of conflict ids that should be open.
 * Used by Property 8 (open-set computation).
 */
export const openSetSampleGen: fc.Arbitrary<OpenSetSample> = fc.array(
  conflictIdGen,
  { minLength: 0, maxLength: 6 },
)

/**
 * Apply a sequence of ResourceEvents to a state machine model.
 * Returns the final state. Pure function over the state shape.
 */
export interface ResourceModelState {
  readonly tag: 'idle' | 'loading' | 'loaded' | 'stale' | 'errored'
  readonly value?: number
  readonly origin?: number
}

export function applyEvents(
  state: ResourceModelState,
  events: readonly ResourceEvent[],
  startTime: number,
): ResourceModelState {
  let s = state
  let t = startTime
  for (const e of events) {
    t++
    switch (e.kind) {
      case 'fetch-start':
        if (s.tag === 'idle' || s.tag === 'stale' || s.tag === 'errored') {
          s = { tag: 'loading', origin: t }
        }
        break
      case 'fetch-resolve':
        if (s.tag === 'loading') {
          const origin = s.origin ?? t
          if (e.value !== undefined) {
            s = { tag: 'loaded', value: e.value, origin }
          } else {
            s = { tag: 'loaded', origin }
          }
        }
        break
      case 'fetch-reject':
        if (s.tag === 'loading') {
          s = { tag: 'errored' }
        }
        break
      case 'invalidate':
        if (s.tag === 'loaded') {
          if (s.value !== undefined) {
            s = { tag: 'stale', value: s.value }
          } else {
            s = { tag: 'stale' }
          }
        }
        break
      case 'fail':
        if (s.tag === 'loading' || s.tag === 'loaded') {
          s = { tag: 'errored' }
        }
        break
    }
  }
  return s
}

/**
 * Apply a sequence of ResourceEvents to a LIVE Resource handle +
 * Graph, driving the resource through real chart transitions per
 * SPEC.async §15.0 (#578).
 *
 * Each event maps to a real chart-driver call:
 *   - `fetch-start`   → `handle.fetch()` (kicked off; not awaited)
 *   - `fetch-resolve` → settle the pending loader with `value`
 *   - `fetch-reject`  → settle the pending loader with `error`
 *   - `invalidate`    → `handle.invalidate()`
 *   - `fail`          → `handle.fail(error)` (chart-legal source
 *                       states only; throws otherwise)
 *
 * Tests pair this with `propertyResource()` whose `settle`
 * callback this function calls internally. Returns void — the
 * test reads the post-state via `graph.read(handle.node)`.
 */
export async function applyEventsLive<T>(
  harness: PropertyResourceHarness<T>,
  events: readonly ResourceEvent[],
): Promise<void> {
  for (const e of events) {
    switch (e.kind) {
      case 'fetch-start':
        // Fire-and-forget: the test drives the loader's settlement
        // via subsequent fetch-resolve / fetch-reject events.
        // Discard the returned promise — tests can re-fetch later
        // when the harness handles concurrent fetches.
        void harness.handle.fetch().catch(() => {
          /* swallow — settle drives the outcome */
        })
        // Yield to the microtask queue so the loader call has
        // a chance to register its pending promise.
        await Promise.resolve()
        break
      case 'fetch-resolve':
        harness.settle({
          ok: true,
          value: (e.value ?? 0) as T,
        })
        // Yield so the resource's then-handler runs.
        await Promise.resolve()
        await Promise.resolve()
        break
      case 'fetch-reject':
        harness.settle({
          ok: false,
          error: new Error(e.error ?? 'rejected'),
        })
        await Promise.resolve()
        await Promise.resolve()
        break
      case 'invalidate':
        harness.handle.invalidate()
        break
      case 'fail':
        // fail() throws on chart-illegal source states (idle/stale/
        // errored). Tests that drive a sequence including a
        // fail must ensure the source is loading or loaded.
        try {
          harness.handle.fail(new Error(e.error ?? 'failed'))
        } catch {
          // Swallow — the chart guard is the test's regression
          // surface; this helper is for chart-legal sequences.
        }
        break
    }
  }
}

/**
 * Apply a sequence of ConflictEvents to a registry model. Returns
 * the resulting conflict-id → kind map.
 */
export type ConflictKind = 'open' | 'resolved' | 'ignored' | 'superseded'

export function applyConflictEvents(
  state: Record<string, ConflictKind>,
  events: readonly ConflictEvent[],
): Record<string, ConflictKind> {
  const out: Record<string, ConflictKind> = { ...state }
  for (const e of events) {
    switch (e.kind) {
      case 'raise':
        if (!(e.id in out)) out[e.id] = 'open'
        break
      case 'resolve':
        if (out[e.id] === 'open') out[e.id] = 'resolved'
        break
      case 'ignore':
        if (out[e.id] === 'open') out[e.id] = 'ignored'
        break
      case 'supersede':
        if (out[e.id] === 'open') out[e.id] = 'superseded'
        break
    }
  }
  return out
}

/**
 * Apply a sequence of ConflictEvents to a LIVE ConflictRegistry +
 * Graph, driving the registry through real chart transitions per
 * SPEC.async §15.0 (#578).
 *
 * Each event maps to a real registry mutator:
 *   - `raise`     → harness.raise(id, target, value)
 *   - `resolve`   → registry.resolve(graph, id, value)
 *   - `ignore`    → registry.ignore(graph, id)
 *   - `supersede` → registry.supersede(graph, id, bySupersedingId)
 *
 * Forbidden transitions throw `ForbiddenConflictTransitionError`;
 * this helper swallows them so tests can drive randomised sequences
 * that include illegal events. Tests that want to assert the throw
 * should call the registry mutator directly rather than via this
 * helper.
 */
export function applyConflictEventsLive<T>(
  harness: PropertyConflictHarness<T>,
  events: readonly ConflictEvent[],
  defaults: { target: NodeId; value: T },
): void {
  for (const e of events) {
    try {
      switch (e.kind) {
        case 'raise':
          harness.raise(e.id, defaults.target, defaults.value)
          break
        case 'resolve':
          harness.registry.resolve(harness.graph, e.id, defaults.value)
          break
        case 'ignore':
          harness.registry.ignore(harness.graph, e.id)
          break
        case 'supersede':
          harness.registry.supersede(
            harness.graph,
            e.id,
            e.bySupersedingId ?? `${e.id}-superseder`,
          )
          break
      }
    } catch {
      // Forbidden-transition throws are swallowed; the test
      // observes the chart's refusal via post-state reads.
    }
  }
}

/**
 * Shrinking-aware preserver — the SPEC-canonical generic
 * Arbitrary-transformer signature per SPEC.async §15.0.
 *
 * Pre-#578 the function operated on event arrays directly; it now
 * accepts an `fc.Arbitrary<T>` and returns one with the same type.
 * The implementation passes through unchanged today (the default
 * fast-check shrinker is sufficient for the property suite's
 * current coverage); future PRs add a custom `chain` shrinker that
 * pins the loading-episode boundary against fast-check's default
 * structural collapse.
 *
 * The signature change is the SPEC-aligned acceptance criterion
 * from #578; the preserved-shape behavior is the load-bearing
 * future work the API surface enables without a SemVer break.
 */
export function preserveLoadingEpisode<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T> {
  return arb
}

/**
 * Shrinking-aware preserver — generic Arbitrary transformer per
 * SPEC.async §15.0. Same shape as {@link preserveLoadingEpisode};
 * future versions pin the open-set `raise` anchor for the target
 * id against fast-check's default shrink.
 */
export function preserveOpenPriming<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T> {
  return arb
}

/**
 * Property-resource harness — wraps a LIVE @causljs/core Graph with a
 * real @causljs/sync Resource. Per SPEC.async §15.0 API sketch.
 *
 * Each property trial constructs a fresh harness via
 * {@link propertyResource}. The harness exposes:
 *   - `graph`: the live engine.
 *   - `handle`: the live ResourceHandle<T>; tests drive transitions
 *     via `handle.fetch()` / `handle.invalidate()` / `handle.fail()`.
 *   - `settle`: a deterministic test-controlled loader settler. Tests
 *     supply an outcome (`{ ok: true, value }` or `{ ok: false, error }`)
 *     to the next pending fetch's loader; this lets the property suite
 *     drive the loading episode without touching real `fetch()` or
 *     timers.
 */
export interface PropertyResourceHarness<T> {
  readonly graph: Graph
  readonly handle: ResourceHandle<T>
  readonly settle: (
    outcome: { ok: true; value: T } | { ok: false; error: unknown },
  ) => void
}

/**
 * Build a fresh property-resource harness with a live Graph and a
 * registered Resource. Loader resolution is gated by a deferred
 * promise the test controls via `settle`.
 *
 * The `T` parameter is the resource's value type. Defaults to
 * `unknown` for property tests that don't care about the value.
 */
export function propertyResource<T = unknown>(): PropertyResourceHarness<T> {
  const graph = createCausl({ name: 'g.property-resource' })
  // Each fetch episode hangs on a Promise the harness owns; tests
  // call `settle(outcome)` to resolve or reject the next pending
  // loader. This decouples the property suite's event sequence
  // from real-world async timing.
  let pendingResolve: ((value: T) => void) | null = null
  let pendingReject: ((reason: unknown) => void) | null = null
  const handle = resource<T>(graph, 'r', {
    loader: () =>
      new Promise<T>((res, rej) => {
        pendingResolve = res
        pendingReject = rej
      }),
  })
  return {
    graph,
    handle,
    settle(outcome) {
      if (outcome.ok) {
        const r = pendingResolve
        pendingResolve = null
        pendingReject = null
        if (r !== null) r(outcome.value)
      } else {
        const r = pendingReject
        pendingResolve = null
        pendingReject = null
        if (r !== null) r(outcome.error)
      }
    },
  }
}

/**
 * Property-conflict harness — wraps a live Graph + ConflictRegistry.
 * Per SPEC.async §15.0 API sketch.
 */
export interface PropertyConflictHarness<T> {
  readonly graph: Graph
  readonly registry: ConflictRegistry<T>
  /**
   * Raise a conflict by mutating the source Input that the registry
   * watches. The registry's compute function detects the new entry
   * and surfaces it as `open`.
   */
  readonly raise: (id: NodeId, target: NodeId, value: T) => void
  /**
   * Remove a conflict id from the source set so the registry no
   * longer surfaces it. (The registry's `resolve` / `ignore` /
   * `supersede` mutators close a conflict in-place; `unraise` is
   * the test-side helper that drops the entry from the source
   * entirely.)
   */
  readonly unraise: (id: NodeId) => void
}

/**
 * Build a fresh property-conflict harness with a live Graph and a
 * registered ConflictRegistry. The registry watches an Input
 * carrying a `Map<NodeId, { target, value }>`; raise/unraise
 * mutate that map.
 */
export function propertyConflict<T = unknown>(): PropertyConflictHarness<T> {
  const graph = createCausl({ name: 'g.property-conflict' })
  type Entry = { readonly target: NodeId; readonly value: T }
  const sourceInput = graph.input(
    'conflict-source',
    new Map<NodeId, Entry>() as ReadonlyMap<NodeId, Entry>,
  )
  const registry = createConflictRegistry<T>(graph, {
    id: 'registry',
    compute: (get) => {
      const m = get(sourceInput)
      const out: { id: NodeId; target: NodeId; value: T; raisedAt: number }[] = []
      for (const [id, entry] of m) {
        out.push({
          id,
          target: entry.target,
          value: entry.value,
          raisedAt: 0,
        })
      }
      return out
    },
  })
  return {
    graph,
    registry,
    raise(id, target, value) {
      graph.commit(`raise:${id}`, (tx) => {
        const current = graph.read(sourceInput)
        const next = new Map(current)
        next.set(id, { target, value })
        tx.set(sourceInput, next as ReadonlyMap<NodeId, Entry>)
      })
    },
    unraise(id) {
      graph.commit(`unraise:${id}`, (tx) => {
        const current = graph.read(sourceInput)
        const next = new Map(current)
        next.delete(id)
        tx.set(sourceInput, next as ReadonlyMap<NodeId, Entry>)
      })
    },
  }
}

/**
 * Property-conflict-with-map harness — exposes the source Input
 * directly so tests can mutate the open set as a Map. Per
 * SPEC.async §15.0.
 */
export interface PropertyConflictWithMapHarness<T> {
  readonly graph: Graph
  readonly registry: ConflictRegistry<T>
  /** The source Input carrying the open-set map. */
  readonly sourceInput: InputNode<ReadonlyMap<NodeId, T>>
}

/**
 * Like {@link propertyConflict} but pre-seeds the open set with the
 * supplied ids and exposes the source Input directly. Tests use the
 * returned `sourceInput` to drive the open set as a single
 * `tx.set(sourceInput, newMap)` rather than the per-id raise/unraise
 * pair.
 */
export function propertyConflictWithMap<T = unknown>(
  openIds: readonly NodeId[],
): PropertyConflictWithMapHarness<T> {
  const graph = createCausl({ name: 'g.property-conflict-with-map' })
  // Seed with `null` values so the type matches the
  // `ReadonlyMap<NodeId, T>` shape SPEC names. Tests that need
  // typed values mutate the map via tx.set.
  const initialMap = new Map<NodeId, T>(
    openIds.map((id) => [id, null as unknown as T]),
  )
  const sourceInput = graph.input(
    'conflict-source',
    initialMap as ReadonlyMap<NodeId, T>,
  )
  const registry = createConflictRegistry<T>(graph, {
    id: 'registry',
    compute: (get) => {
      const m = get(sourceInput)
      const out: { id: NodeId; target: NodeId; value: T; raisedAt: number }[] = []
      for (const [id, value] of m) {
        out.push({ id, target: id, value, raisedAt: 0 })
      }
      return out
    },
  })
  return { graph, registry, sourceInput }
}
