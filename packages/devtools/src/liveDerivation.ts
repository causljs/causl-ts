/**
 * @packageDocumentation
 *
 * Live-derivation editing — the REPL-style mechanism that earns the
 * comparison to spreadsheets. The thing that made spreadsheets matter is
 * that a non-programmer can change a formula in a cell and see the world
 * recompute now. If I cannot demo "edit a derivation while it's running,
 * watch the change propagate," that comparison is unearned. A REPL
 * connected to a running graph must be able to mutate, replace, and
 * replay derivations without restarting the host process.
 *
 * Because the engine forbids re-registering a derived node under the
 * same id, this module installs a stable derived once and threads its
 * compute through a mutable closure slot. A hidden version-counter
 * Input is read inside the wrapped compute so the engine tracks the
 * version as a dependency; bumping that input forces a single
 * re-evaluation per replace, exactly one new GraphTime, exactly one
 * downstream notification — the same atomicity guarantee that a normal
 * commit gives.
 *
 * {@link liveDerived} registers a single derivation; {@link replaceMany}
 * batches multiple closure swaps into one commit so downstream
 * observers fire at most once across the batch.
 */

import { CommitInProgressError } from '@causl/core'
import type { Compute, DerivedNode, Graph, InputNode, NodeId } from '@causl/core'

/**
 * Handle for a derivation registered through {@link liveDerived}.
 *
 * Owners hold this handle to swap in new compute closures without
 * tearing down the underlying node identity.
 *
 * @typeParam T - The derived value type.
 */
export interface LiveDerivedHandle<T> {
  /** The derived node registered with the graph. */
  readonly node: DerivedNode<T>
  /** Stable id under which the node was registered. */
  readonly id: NodeId
  /**
   * Swap in a new compute function. Issues exactly one commit; one
   * downstream notification fires (assuming the new compute produces
   * a non-Object.is-equal value).
   *
   * @param next - Replacement compute closure.
   */
  replace(next: Compute<T>): void
}

/**
 * Per-handle internal record kept in the {@link REGISTRY}.
 *
 * Holds the public handle, the mutable compute slot the wrapped
 * derivation reads through, and the version Input used to force
 * re-evaluation.
 *
 * @typeParam T - The derived value type.
 */
interface Internal<T> {
  readonly handle: LiveDerivedHandle<T>
  current: { compute: Compute<T> }
  readonly version: InputNode<number>
}

/**
 * Per-graph registry of live-derivation internals.
 *
 * Keyed weakly on the {@link Graph} instance so the registry does not
 * keep retired graphs alive; inner map is keyed by NodeId to allow
 * batch lookups in {@link replaceMany}.
 */
const REGISTRY: WeakMap<Graph, Map<NodeId, Internal<unknown>>> = new WeakMap()

/**
 * Insert an internal record for `id` under the given graph.
 *
 * @typeParam T - The derived value type (erased to `unknown` in storage).
 * @param graph - The owning graph.
 * @param id - The derivation's stable id.
 * @param internal - Record to store.
 */
function registerInternal<T>(graph: Graph, id: NodeId, internal: Internal<T>): void {
  // Lazily create the per-graph map on first registration.
  let map = REGISTRY.get(graph)
  if (!map) {
    map = new Map()
    REGISTRY.set(graph, map)
  }
  map.set(id, internal as unknown as Internal<unknown>)
}

/**
 * Look up the internal record for `id` under the given graph.
 *
 * @typeParam T - The derived value type to cast back to.
 * @param graph - The owning graph.
 * @param id - The derivation's stable id.
 * @returns The internal record, or `undefined` if no live derivation
 *          with that id is registered for `graph`.
 */
function getInternal<T>(graph: Graph, id: NodeId): Internal<T> | undefined {
  return REGISTRY.get(graph)?.get(id) as Internal<T> | undefined
}

/**
 * Register a derived node whose compute can be hot-swapped.
 *
 * The returned {@link LiveDerivedHandle} exposes a `replace(next)`
 * method that updates the closure and bumps a hidden version Input in
 * a single commit, producing exactly one downstream notification.
 *
 * @typeParam T - The derived value type.
 * @param graph - The graph to register the derivation against.
 * @param id - Stable id for the derivation; must be unique within
 *             `graph`.
 * @param initial - The initial compute closure.
 * @returns A handle whose `replace` swaps the compute in-place.
 *
 * @example
 * ```ts
 * const total = liveDerived(graph, 'total', (get) => get(a) + get(b))
 * total.replace((get) => get(a) * get(b))  // one commit, one notify
 * ```
 */
export function liveDerived<T>(
  graph: Graph,
  id: NodeId,
  initial: Compute<T>,
): LiveDerivedHandle<T> {
  // Mutable slot the wrapped compute reads through; swapped on replace().
  const slot = { compute: initial }

  // Hidden version counter; reading it inside the compute forces the
  // engine to track it as a dep and to recompute when bumped.
  const version = graph.input<number>(`${id}::__version`, 0)

  // Stable derived node — its compute identity never changes, so the
  // engine's "no re-registering" rule is respected across edits. The
  // `tag: 'live'` option flags this node so `graph.explain(...)` can
  // report `via: 'live'` (#298 T7) without the engine guessing.
  const node = graph.derived<T>(
    id,
    (get) => {
      void get(version)
      return slot.compute(get)
    },
    { tag: 'live' },
  )

  const handle: LiveDerivedHandle<T> = {
    node,
    id,
    replace(next: Compute<T>) {
      // Same closure ref → no-op. Avoids a wasted recompute under
      // StrictMode-style double invocation (#294 T6).
      if (slot.compute === next) return
      // Swap the closure first so the recompute triggered below sees it.
      slot.compute = next
      // If a commit is already in flight (e.g. `live.replace` invoked
      // from inside a `g.commit(_, tx => …)` callback per #294 T5),
      // skip the inner commit — nesting throws `CommitInProgressError`,
      // and the outer commit's own writes will re-run the wrapped
      // compute against the freshly-installed closure. If the outer
      // commit happens not to touch any tracked dep, the swap is
      // applied lazily on the next read. The trade-off is documented
      // here so the call-site contract is recoverable.
      try {
        graph.commit(`replace:${id}`, (tx) => tx.set(version, graph.read(version) + 1))
      } catch (e) {
        if (e instanceof CommitInProgressError) return
        throw e
      }
    },
  }

  // Record under the per-graph registry so replaceMany can find it later.
  registerInternal<T>(graph, id, { handle, current: slot, version })
  return handle
}

/**
 * Batch-replace multiple live derivations atomically.
 *
 * All compute closures are swapped before the commit, then every
 * version input is bumped within a single commit so subscribers
 * downstream of any of the affected derivations fire at most once
 * across the batch.
 *
 * @param graph - The owning graph (must match the graph each handle
 *                was registered against).
 * @param edits - Pairs of `{ handle, next }` describing each swap.
 * @throws {Error} If any handle is not registered with `graph`.
 *
 * @example
 * ```ts
 * replaceMany(graph, [
 *   { handle: total, next: (get) => get(a) * get(b) },
 *   { handle: tax,   next: (get) => get(total.node) * 0.1 },
 * ])
 * ```
 */
export function replaceMany(
  graph: Graph,
  edits: ReadonlyArray<{ readonly handle: LiveDerivedHandle<unknown>; readonly next: Compute<unknown> }>,
): void {
  // Apply closures FIRST so the commit's recompute sees the new code.
  const internals: Internal<unknown>[] = []
  for (const { handle, next } of edits) {
    // Resolve the internal record; reject handles foreign to this graph.
    const internal = getInternal<unknown>(graph, handle.id)
    if (!internal) {
      throw new Error(`replaceMany: handle ${handle.id} is not registered with this graph`)
    }
    internal.current.compute = next
    internals.push(internal)
  }

  // Single commit that bumps every version input, batching notifications.
  graph.commit(
    `replaceMany:${edits.map((e) => e.handle.id).join(',')}`,
    (tx) => {
      for (const internal of internals) {
        tx.set(internal.version, graph.read(internal.version) + 1)
      }
    },
  )
}
