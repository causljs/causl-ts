/**
 * @packageDocumentation
 *
 * Commit-log panel data source for the devtools surface.
 *
 * §11 framing: the engine is its own observer. The transaction log is a
 * `Behavior [Commit]` exposed at `graph.commitLog: DerivedNode<readonly
 * Commit[]>`, queryable by the same API as any other graph value. The
 * devtools wrapper is sugar for the UI case where a long-running host
 * wants a smaller, capped projection — most-recent-first, bounded
 * capacity — without giving up the engine's `subscribe` / `read` /
 * `explain` surface. Realised as a `commitMetadataDerived` over
 * `graph.commitLog`, so the projection updates on the *same* commit
 * that produced the source array (Phase F.5, post-`commitLog` refresh,
 * pre-Phase-G subscriber dispatch).
 *
 * The previous shape returned a `dispose`-token wrapper around a
 * private ring buffer fed through `subscribeCommits`. That was a
 * parallel system in §11's terms — UIs could not `subscribe` it,
 * compose it into a downstream `derived(...)`, or read it through
 * `readAt`. Closes #383.
 */

import type { Commit, DerivedNode, Graph, NodeId } from '@causljs/core'

/**
 * Capability slice handed to {@link commitLog}.
 *
 * The function registers a {@link Graph.commitMetadataDerived} that
 * reads {@link Graph.commitLog} — those two methods are the entire
 * surface. `commit`, `input`, `derived`, `hydrate`, `snapshot`,
 * `exportModel`, the per-node `subscribe`, and the time-travel readers
 * are intentionally unreachable: a bounded buffer that can mutate the
 * engine ceases to be a buffer and becomes a parallel writer, breaking
 * §11's "the engine is its own observer" commitment.
 *
 * Narrowing is type-level. A real `Graph` is still assignable, so call
 * sites keep working; the discipline is enforced at compile time inside
 * the implementation.
 */
export type CommitLogGraph = Pick<Graph, 'commitMetadataDerived' | 'commitLog'>

/**
 * Construction options for {@link commitLog}.
 *
 * @remarks
 * Callers tune `capacity` to balance UI history depth against retained
 * memory. The default cap is suitable for interactive devtools sessions
 * but small for long-running batch hosts. `id` is the registration key
 * for the underlying derived node and defaults to a deterministic name
 * derived from `capacity` so distinct capacities coexist in the same
 * graph; supply a custom id to host multiple devtools panels.
 */
export interface CommitLogOptions {
  /** Maximum number of commits to retain; defaults to 1000. */
  readonly capacity?: number
  /** Registration id for the underlying derived node. */
  readonly id?: NodeId
}

/** Default ring-buffer capacity when {@link CommitLogOptions.capacity} is omitted. */
const DEFAULT_CAPACITY = 1000

/**
 * Per-graph cache of `(graph, id) → DerivedNode<readonly Commit[]>`.
 *
 * Memoising on the graph handle keeps a stable identity across
 * re-invocations: a UI that calls `commitLog(g)` twice receives the
 * same `DerivedNode<...>` and therefore subscribes to one node, not
 * two. The outer `WeakMap` is keyed on the graph so disposed graphs
 * release their cache eagerly; the inner `Map` is keyed on the
 * registration id so distinct (capacity, id) pairs coexist.
 */
const REGISTRY = new WeakMap<
  CommitLogGraph,
  Map<NodeId, DerivedNode<readonly Commit[]>>
>()

/**
 * A bounded, most-recent-first projection of the engine's commit log,
 * shaped as a {@link DerivedNode}.
 *
 * The returned node is registered through {@link
 * Graph.commitMetadataDerived} so its compute reads the just-completed
 * commit on the same commit that produced it. UIs subscribe and
 * compose the result like any other derived: `subscribe(node, …)`
 * fires on every commit, `read(node)` returns the current bounded
 * projection, `explain(node)` traces lineage back to `graph.commitLog`,
 * and `readAt(node, t)` projects historical bounded views.
 *
 * Repeated calls with the same `(graph, id)` return the same handle
 * (memoised) — registering the underlying derived twice would throw
 * `DuplicateNodeError`, and stable identity lets a UI compose the
 * result into downstream `derived(...)` without juggling handles.
 *
 * @param graph - The engine to project.
 * @param options - Optional buffer configuration.
 * @returns A {@link DerivedNode} carrying the bounded, most-recent-first
 *   commit window.
 * @throws {Error} If `options.capacity` is non-positive.
 *
 * @example
 * ```ts
 * const log = commitLog(graph, { capacity: 200 })
 * graph.subscribe(log, ({ value }) => render(value))
 * const entries = graph.read(log) // most-recent first
 * ```
 */
export function commitLog(
  graph: CommitLogGraph,
  options: CommitLogOptions = {},
): DerivedNode<readonly Commit[]> {
  // Resolve capacity, falling back to the module default; reject
  // non-positive values up front so the misconfiguration surfaces at
  // construction rather than during the first commit.
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  if (capacity <= 0) throw new Error('CommitLog capacity must be > 0')

  // Default id encodes the capacity so two callers asking for distinct
  // bounded views get distinct nodes; explicit ids let multi-panel UIs
  // partition further.
  const id = options.id ?? `__devtools.commitLog.${capacity}`

  // Memoise per (graph, id): repeat calls are stable.
  let perGraph = REGISTRY.get(graph)
  if (!perGraph) {
    perGraph = new Map()
    REGISTRY.set(graph, perGraph)
  }
  const cached = perGraph.get(id)
  if (cached) return cached

  // The compute reads the engine's canonical log node, slices the most
  // recent `capacity` entries, and reverses to most-recent-first. The
  // engine's `commitLog` is oldest-first; the devtools convention
  // inherited from the previous ring-buffer shape is newest-first.
  const node = graph.commitMetadataDerived<readonly Commit[]>(id, (get) => {
    const log = get(graph.commitLog)
    const start = Math.max(0, log.length - capacity)
    const window: Commit[] = []
    for (let i = log.length - 1; i >= start; i--) {
      window.push(log[i]!)
    }
    return window
  })

  perGraph.set(id, node)
  return node
}
