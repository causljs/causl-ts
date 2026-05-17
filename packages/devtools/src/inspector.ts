/**
 * @packageDocumentation
 *
 * Node inspector — a thin packaging layer over `graph.explain(node)`.
 *
 * `graph.explain(node)` returns another node — a derived view of the
 * dependency lineage that can itself be subscribed to, displayed, and
 * drilled into. Not a one-shot JSON dump. Because the engine already
 * exposes lineage as a derived node, this module does not need to
 * reinvent caching or invalidation; it simply wraps reads and
 * subscriptions in a UI-friendly shape that includes the GraphTime at
 * which the view was captured.
 *
 * Two entry points: {@link inspect} for one-shot snapshots, and
 * {@link watchInspect} for streaming updates as the explanation node
 * recomputes.
 */

import type { Graph, GraphTime, Node, Explanation, Unsubscribe } from '@causljs/core'

/**
 * Capability handed to {@link inspect} and {@link watchInspect}.
 * Closes #257 (capability narrowing across factory/selector seams):
 * the inspector reads explanation lineage, subscribes to its updates,
 * and stamps each view with `graph.now`. Those four methods —
 * `read`, `explain`, `subscribe`, `now` — are the entire surface.
 *
 * `commit`, `input`, `derived`, `hydrate`, `snapshot`, `exportModel`,
 * `subscribeCommits`, `commitLog`, `readAt`/`snapshotAt` are
 * intentionally unreachable: an inspector
 * that can mutate the engine ceases to be inspection and becomes a
 * parallel writer, breaking the "engine is inspectable through its
 * own primitives, not a parallel devtools system" commitment.
 *
 * Narrowing is type-level. A real `Graph` is still assignable, so
 * call sites keep working; the discipline is enforced at compile time
 * inside the inspector implementation.
 */
export type InspectorGraph = Pick<Graph, 'read' | 'explain' | 'subscribe' | 'now'>

/**
 * UI-facing wrapper around {@link Explanation} stamped with the
 * GraphTime at which the lineage was read.
 *
 * @remarks
 * `explanation` carries the full discriminated-union tree from the
 * engine (#298) — `via: 'input' | 'derived' | 'live' | 'cycle'` plus
 * a recursive `deps[]` of `{ node, contributedAt, explanation }`
 * frames. `inspectedAt` lets a UI display "as of t=N" annotations
 * without making a second call into the engine.
 */
export interface NodeInspectorView {
  /** Recursive lineage as published by `graph.explain(...)`. */
  readonly explanation: Explanation
  /** Pulled from `graph.now` at read time. */
  readonly inspectedAt: GraphTime
}

/**
 * One-shot lineage read for `node`.
 *
 * Reads `graph.explain(node)` at the current GraphTime and tags the
 * result with that time stamp.
 *
 * @typeParam T - The inspected node's value type.
 * @param graph - The engine instance.
 * @param node - The node whose lineage to capture.
 * @returns A {@link NodeInspectorView} snapshot.
 */
export function inspect<T>(graph: InspectorGraph, node: Node<T>): NodeInspectorView {
  // Read the engine's derived explanation and stamp it with current GraphTime.
  const explanation = graph.read(graph.explain(node))
  return { explanation, inspectedAt: graph.now }
}

/**
 * Streaming lineage subscription for `node`.
 *
 * Registers `observer` to receive a fresh {@link NodeInspectorView}
 * each time the explanation node recomputes (i.e. each commit that
 * changes the node's lineage).
 *
 * @typeParam T - The inspected node's value type.
 * @param graph - The engine instance.
 * @param node - The node whose lineage to track.
 * @param observer - Callback invoked with each updated view.
 * @returns Unsubscribe handle releasing the subscription.
 */
export function watchInspect<T>(
  graph: InspectorGraph,
  node: Node<T>,
  observer: (view: NodeInspectorView) => void,
): Unsubscribe {
  // Resolve the explanation node once; subscriptions key off its identity.
  const explainNode = graph.explain(node)

  // Forward each explanation update with a fresh GraphTime stamp.
  return graph.subscribe(explainNode, (explanation) => {
    observer({ explanation, inspectedAt: graph.now })
  })
}
