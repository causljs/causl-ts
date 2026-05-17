/**
 * @packageDocumentation
 *
 * Async resource binding for the Causl engine. The semantic core
 * deliberately does not know about `fetch`; "async resources" live in
 * an adapter package whose job is to translate external loader
 * callbacks into engine commits. A Resource is therefore a Behavior
 * over GraphTime fed by an external Event source — the engine itself
 * stays synchronous and only advances time through `commit`.
 *
 * The lifecycle implemented here (Idle / Loading / Loaded / Stale /
 * Errored) is the per-resource sub-machine inside the ResourceFleet
 * orthogonal region of the composite lifecycle. The staleness guard
 * addresses the stale-async race: the case where a fetch returns
 * *after* a later commit has already advanced GraphTime past the time
 * the fetch originated. The race itself is real and unavoidable; the
 * guard makes the response defined by comparing the originating
 * GraphTime to the graph's GraphTime at resolution and routing the
 * `Loading → Stale` edge instead of `Loading → Loaded`.
 */

import type { Graph, GraphTime, InputNode, Node, NodeId } from '@causljs/core'
import { reduceResource } from './statechart-reducers.js'

/**
 * Thrown when {@link ResourceHandle.fail} targets a resource that is
 * not in a state the ResourceFleet sub-statechart names as a legal
 * source for the `* → Errored` edge.
 *
 * @remarks
 * `SPEC.md` §6 (composite chart, ResourceFleet region) and
 * `docs/lifecycle.md` §1 draw exactly two edges into `Errored`:
 * `Loading → Errored` (trigger `fetch-reject`) and
 * `Loaded → Errored` (trigger `invalidate(error)`). Every other source
 * state — `idle`, `stale`, `errored` — has no edge into `Errored` in
 * the chart, so a `fail()` on those states would ship an enum
 * transition the chart does not specify. `SPEC.md` §17 commitment 7
 * forbids exactly that. The mutator therefore refuses the call rather
 * than silently writing the `errored` tag.
 *
 * Modelled after `ForbiddenConflictTransitionError` in `./conflict.ts`
 * — same shape, same purpose: turn a forbidden statechart transition
 * into a typed error rather than a silent no-op or an out-of-chart
 * write.
 */
export class ForbiddenResourceTransitionError extends Error {
  override readonly name = 'ForbiddenResourceTransitionError'

  constructor(
    /** Identifier of the resource the mutator was called against. */
    readonly id: NodeId,
    /** The resource's current state tag. */
    readonly from: 'idle' | 'loading' | 'loaded' | 'stale' | 'errored',
    /** The state the rejected mutator would have moved it to. */
    readonly to: 'errored',
  ) {
    super(
      `Forbidden resource transition: ${from} → ${to} on '${id}'. ` +
        `Only Loading → ${to} (fetch-reject) and Loaded → ${to} ` +
        `(invalidate(error)) are permitted by the resource statechart.`,
    )
  }
}

/**
 * Tagged-union state carried by a {@link ResourceHandle.node}.
 *
 * @remarks
 * Each tag corresponds to a state in the ResourceFleet sub-statechart.
 * Accessing `.value` requires a tag check first; the type system
 * forbids reading a not-yet-loaded value, so the
 * "reading a not-yet-loaded resource" race is caught at compile time
 * by `tsc` rather than left to runtime. Every "X may or may not have
 * Y" optional field gets surfaced as a tag instead of being hidden as
 * an optional.
 *
 * - `idle`: registered, never fetched.
 * - `loading`: fetch in flight; `origin` is the GraphTime at which the
 *   fetch was issued. `promise` is the in-flight Promise for this
 *   loading episode — identity-stable across renders for the same key
 *   and origin (SPEC §9.1: "Suspense fresh-Promise-per-render breaks
 *   SuspenseList / `startTransition` … the in-flight Promise lives on
 *   `ResourceState.loading` itself"). Always resolves (never rejects):
 *   it is the Promise React's renderer awaits when the Suspense hook
 *   throws on this state, and a rejection there would surface as an
 *   unhandled-rejection warning. The loader's rejection still drives
 *   the resource to `errored`; the next render reads that tag and the
 *   error boundary catches it.
 * - `loaded`: fetch resolved while still authoritative for `origin`.
 * - `stale`: a previously-loaded value whose dependencies advanced past
 *   `origin`, or whose fetch resolved after a later commit.
 * - `errored`: the loader rejected (the `Loading → Errored`
 *   `fetch-reject` edge), or {@link ResourceHandle.fail} was invoked
 *   from `loading`/`loaded` (the chart-named host-side trigger for
 *   the same two edges into `Errored`).
 *
 * @typeParam T - Resolved value type produced by the loader.
 */
export type ResourceState<T> =
  | { state: 'idle' }
  | { state: 'loading'; origin: GraphTime; promise: Promise<unknown> }
  | { state: 'loaded'; value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'stale'; value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'errored'; error: unknown; origin: GraphTime; erroredAt: GraphTime }

/**
 * Object returned by {@link resource}; pairs the engine node with
 * imperative triggers for the host application.
 *
 * @remarks
 * The handle does not schedule fetches itself. Callers decide when to
 * call {@link ResourceHandle.fetch}, {@link ResourceHandle.invalidate},
 * or {@link ResourceHandle.fail}; each of those produces exactly one
 * commit on the underlying graph (one GraphTime advance).
 *
 * @typeParam T - Resolved value type produced by the loader.
 */
export interface ResourceHandle<T> {
  /** The engine node carrying the current ResourceState<T>. */
  readonly node: Node<ResourceState<T>>
  /**
   * The {@link NodeId} the resource was registered under. Stable for
   * the lifetime of the handle.
   */
  readonly key: NodeId
  /** Begin or restart the load. Returns the resolved value (or rejects on error). */
  fetch(): Promise<T>
  /** Mark the current Loaded state as Stale (without refetching yet). */
  invalidate(): void
  /**
   * Drive the chart-named `Loading | Loaded → Errored` edges from the
   * host application (e.g. an out-of-band websocket pushing a
   * server-side error for an already-Loaded resource, or a host that
   * cancels an in-flight fetch and wants the resource parked in
   * `errored` instead of `loading`).
   *
   * @remarks
   * Throws {@link ForbiddenResourceTransitionError} when the current
   * state is `idle`, `stale`, or `errored` — the chart has no edge
   * into `Errored` from any of those.
   */
  fail(error: unknown): void
}

/**
 * Configuration accepted by {@link resource}.
 *
 * @typeParam T - Resolved value type produced by the loader.
 */
export interface ResourceOptions<T> {
  /** A Loader: invoked on `fetch()`. Receives the originating GraphTime. */
  readonly loader: (origin: GraphTime) => Promise<T>
  /**
   * If true (the default), a fetch that resolves AFTER another commit
   * advanced GraphTime past `origin` is reported as `stale`. Set to
   * `false` to treat late resolves as authoritative (last-writer-wins).
   */
  readonly stalenessGuard?: boolean
}

/**
 * Register a Resource on `graph` keyed by `key`. The host application
 * is responsible for scheduling `fetch()` calls; the engine merely
 * carries the state.
 *
 * @remarks
 * Internally this allocates a single {@link InputNode} initialised to
 * `{ state: 'idle' }` and returns an object that drives transitions on
 * that input through one-shot commits. The transitions implemented are
 * the ones drawn in the ResourceFleet sub-statechart:
 * `Idle → Loading → Loaded | Stale | Errored`, plus
 * `Loaded → Stale` (via {@link ResourceHandle.invalidate}) and the
 * chart-named `Loading | Loaded → Errored` edges (via
 * {@link ResourceHandle.fail}). Every transition lands as exactly one
 * engine commit, advancing GraphTime by one tick — the engine has no
 * other mutation API.
 *
 * @typeParam T - Resolved value type produced by the loader.
 * @param graph - The engine instance to register the input against.
 * @param key - Stable {@link NodeId} for the underlying input node.
 * @param options - Loader callback plus optional staleness-guard flag.
 * @returns A {@link ResourceHandle} exposing the node and triggers.
 *
 * @example
 * ```ts
 * const user = resource(graph, 'user:42', {
 *   loader: async () => fetchUser(42),
 * })
 * await user.fetch()
 * graph.read(user.node) // { state: 'loaded', value: ..., ... }
 * ```
 */
export function resource<T>(
  graph: Graph,
  key: NodeId,
  options: ResourceOptions<T>,
): ResourceHandle<T> {
  // Allocate the backing input node in the Idle state. All later
  // transitions are commits onto this single input.
  const initial: ResourceState<T> = { state: 'idle' }
  const node = graph.input<ResourceState<T>>(key, initial) as InputNode<ResourceState<T>>
  const stalenessGuard = options.stalenessGuard ?? true

  /**
   * Commit a single state transition with `intent` as the commit label.
   * Each call advances GraphTime by exactly one tick — `commit` is the
   * one-and-only mutation API; outside a commit the graph is read-only.
   */
  function setState(intent: string, next: ResourceState<T>): void {
    graph.commit(intent, (tx) => tx.set(node, next))
  }

  /**
   * Wiring shell for one resource event. Reads the resource's current
   * state, asks the pure {@link reduceResource} reducer to decide what
   * the next state should be, and either commits the produced state
   * (on `ok`, when `next !== state` — the chart-named no-op is
   * surfaced as `next === state` and skipped here so GraphTime does
   * not advance) or throws {@link ForbiddenResourceTransitionError}
   * (on `forbidden`). The decision logic lives in the reducer module
   * #698 carved out; this shell is the engine adapter.
   *
   * @internal
   */
  function applyEvent(
    intent: string,
    event: Parameters<typeof reduceResource>[1],
  ): ResourceState<T> {
    const current = graph.read(node)
    const result = reduceResource<T>(current, event, graph.now, key)
    if (result.kind === 'forbidden') {
      throw new ForbiddenResourceTransitionError(
        key,
        result.reason.from as 'idle' | 'loading' | 'loaded' | 'stale' | 'errored',
        'errored',
      )
    }
    // Chart-named no-op: reducer returned the input state unchanged.
    // Skip the commit so the GraphTime ledger doesn't advance for a
    // transition the chart doesn't specify (the pre-#698 invalidate
    // silent-no-op behaviour).
    if (result.next === current) return current
    setState(intent, result.next)
    return result.next
  }

  /**
   * Drive one fetch through the Loading-to-{Loaded|Stale|Errored}
   * sub-statechart, returning the resolved value or re-throwing the
   * loader error.
   *
   * @remarks
   * The loader's Promise is constructed *before* the `loading` commit
   * so it can be carried on the `loading` state itself (SPEC §9.1's
   * "Suspense fresh-Promise-per-render" row). Identity is engine-owned:
   * one Promise per loading episode, observable to every render that
   * reads the node while it's loading. The carried Promise always
   * resolves (never rejects); the loader's rejection still fans out to
   * the awaited `fetch()` call and to the `errored` state, but the
   * Suspense renderer needs a Promise it can await without producing
   * an unhandled-rejection warning. The settle-only-resolve shape lets
   * the renderer re-attempt cleanly, after which the next read returns
   * the `errored` tag and the error boundary catches it.
   *
   * The state-shape decisions (Loaded vs Stale at resolve time, the
   * Errored shape on reject) are delegated to the pure
   * {@link reduceResource} reducer through {@link applyEvent}. The
   * loader invocation, Promise plumbing, and per-edge commit-intent
   * labels are the engine-adapter side that stays in this file.
   */
  function fetchOnce(): Promise<T> {
    // Capture the GraphTime that originates this fetch so the resolver
    // can compare against later commits.
    const origin = graph.now
    // Construct the loader's Promise BEFORE the loading commit so it
    // can be carried on the state. The loader is invoked exactly once
    // per `fetchOnce` call.
    const loaderPromise = options.loader(origin)
    // Suspense-safe Promise: settles on either branch without
    // rejecting, so throwing it to React's renderer never produces an
    // unhandled rejection. The original `loaderPromise` is what the
    // host awaits via the returned `Promise<T>`.
    const suspensePromise: Promise<unknown> = loaderPromise.then(
      () => undefined,
      () => undefined,
    )
    // Transition: * -> Loading. The commit advances GraphTime by 1.
    applyEvent(`fetch:${key}:start`, {
      kind: 'fetch-start',
      origin,
      promise: suspensePromise,
    })
    // The loading commit advances time by exactly 1. Anything beyond
    // that during the fetch is *external* and signals staleness; the
    // reducer compares `loadingAt` against `graph.now` at resolve.
    const loadingAt = graph.now
    return loaderPromise.then(
      (value) => {
        // Transition: Loading -> Stale (guard hit) | Loaded (clean).
        // The reducer decides which branch; the shell only labels the
        // commit intent for `whyUpdated` per-edge classification.
        const isStale = stalenessGuard && graph.now > loadingAt
        applyEvent(isStale ? `fetch:${key}:stale` : `fetch:${key}:loaded`, {
          kind: 'fetch-resolve',
          value,
          loadingAt,
          stalenessGuard,
        })
        return value
      },
      (error) => {
        // Transition: Loading -> Errored. The loader's rejection is
        // surfaced both on the node (via the reducer) and re-thrown
        // to the caller of fetch().
        applyEvent(`fetch:${key}:error`, { kind: 'fetch-reject', error })
        throw error
      },
    )
  }

  return {
    node,
    key,
    fetch: fetchOnce,
    /**
     * Transition Loaded -> Stale without re-fetching. No-op when the
     * current state is not Loaded — the statechart has no edge from
     * Idle/Loading/Stale/Errored under this trigger; the reducer
     * surfaces the no-op as `next === state` and `applyEvent` skips
     * the commit.
     */
    invalidate(): void {
      applyEvent(`invalidate:${key}`, { kind: 'invalidate' })
    },
    /**
     * Drive the chart-named `Loading | Loaded → Errored` edges from
     * the host application. Refuses every other source state with a
     * {@link ForbiddenResourceTransitionError}.
     *
     * @remarks
     * `SPEC.md` §6 / `docs/lifecycle.md` §1 specify exactly two edges
     * into `Errored`: `Loading → Errored` (trigger `fetch-reject`) and
     * `Loaded → Errored` (trigger `invalidate(error)`). The
     * `fetch-reject` edge is also driven by the loader's rejection
     * branch in {@link fetchOnce}; this mutator covers the host-side
     * trigger for the same two edges (e.g. a host that cancels an
     * in-flight fetch, or that learns about a server-side error for
     * an already-Loaded resource via an out-of-band channel like a
     * websocket).
     *
     * `Idle → Errored`, `Stale → Errored`, and `Errored → Errored`
     * are not in the chart, so a previous total-over-state-space
     * `fail()` shipped enum tags whose transitions are not specified
     * by §6 — the exact failure mode `SPEC.md` §17 commitment 7
     * forbids. Those source states now throw rather than silently
     * write `errored`. The chart-guard decision lives in
     * {@link reduceResource}; this shell only wires the event in.
     */
    fail(error: unknown): void {
      applyEvent(`fail:${key}`, { kind: 'fail', error })
    },
  }
}
