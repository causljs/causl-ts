/**
 * @packageDocumentation
 *
 * Lineage explainers for the devtools surface — the "did-this-update"
 * and "did-this-not-update" root-cause views over a node and the
 * engine's commit log.
 *
 * §11 framing: the engine is its own observer. `graph.explain(node)` is
 * itself a derived node carrying lineage; `graph.commitLog` is itself a
 * derived node carrying the transaction log. The right shape for a
 * "why did (or didn't) this update?" panel composes those two into a
 * third derived node that recomputes on every commit and is itself
 * subscribable — UIs `subscribe(whyUpdated(g, n), …)` and the engine
 * dispatches them on the same commit that produced the answer.
 *
 * The derivation is registered through {@link
 * Graph.commitMetadataDerived} so the compute reads the just-completed
 * `commitLog` array (Phase F.5, post-`commitLog` refresh, pre-Phase-G
 * subscriber dispatch). Registering through plain {@link Graph.derived}
 * would race the §5 commit pipeline — the previous PR-#383 attempt
 * surfaced exactly that regression and was reverted; #452 / #455 added
 * the typed seam this module now consumes.
 *
 * Both {@link whyUpdated} and {@link whyNotUpdated} return a
 * `DerivedNode<WhyResult>` tagged by {@link WhyReason}. Tagging each
 * outcome explicitly is a deliberate application of the
 * "make-impossible-states-impossible" discipline: optional fields with
 * implicit semantics are state machines in disguise, so the explainers
 * surface the discriminant directly. The human-readable `because`
 * string is derived from the tag through {@link renderWhy}, so
 * consumers can render their own copy without regex-parsing the default
 * message and tests can assert on `reason` rather than substring-
 * matching documentation.
 *
 * Closes #383.
 */

import type { Commit, DerivedNode, Graph, Node, NodeId } from '@causljs/core'
import { assertNever } from '@causljs/core/internal'

/**
 * Capability slice handed to {@link whyUpdated} / {@link whyNotUpdated}.
 *
 * The explainers register a {@link Graph.commitMetadataDerived} whose
 * compute reads the engine's {@link Graph.commitLog} and the node's
 * {@link Graph.explain} derivation. `read` is consumed only inside the
 * `compute` callback through `get(...)`, but it is also accepted on
 * the surface so call sites can pass a full `Graph` without casting.
 *
 * `commit`, `input`, `derived`, `hydrate`, `snapshot`, `exportModel`,
 * `subscribeCommits`, the per-node `subscribe`, and the time-travel
 * readers are intentionally unreachable — a lineage explainer that can
 * mutate the engine ceases to be inspection and becomes a parallel
 * writer, breaking the §11 "engine is its own observer" commitment.
 */
export type WhyGraph = Pick<
  Graph,
  'commitMetadataDerived' | 'commitLog' | 'read' | 'explain'
>

/**
 * Tagged classification for a {@link WhyResult}.
 *
 * Each variant documents the precise condition under which the
 * corresponding explainer returns it.
 */
export type WhyReason =
  /** whyUpdated: a recomputed derivation. */
  | 'recomputed'
  /** whyUpdated: a direct tx.set on the node. */
  | 'directly-set'
  /** whyUpdated / whyNotUpdated: no commit in the window touched it. */
  | 'no-cause'
  /** whyNotUpdated: the latest commit DID update this node. */
  | 'did-update'
  /** whyNotUpdated: the latest commit's changedNodes don't intersect deps. */
  | 'no-dep-overlap'
  /** whyNotUpdated: deps recomputed but produced Object.is-equal results. */
  | 'object-is-deduped'

/**
 * Structured result returned by both lineage explainers.
 *
 * @remarks
 * `cause` is the commit responsible for the classification (or `null`
 * for `no-cause`); `path` is the node ids forming the dependency
 * chain that led to the conclusion (or `null` when no chain applies);
 * `inputs` carries contextual node ids used to render `because`.
 */
export interface WhyResult {
  /** The id of the node being explained. */
  readonly node: NodeId
  /** Tag classifying the outcome; see {@link WhyReason}. */
  readonly reason: WhyReason
  /** Commit that produced the outcome, or `null` for `no-cause`. */
  readonly cause: Commit | null
  /** Dependency-chain path, or `null` when no chain applies. */
  readonly path: readonly NodeId[] | null
  /** Optional contextual node ids, depending on `reason`. */
  readonly inputs?: readonly NodeId[]
  /** Human-readable, derived from `reason`. */
  readonly because: string
}

/**
 * Result type alias produced by {@link whyUpdated}.
 *
 * Same shape as {@link WhyResult}; the alias documents the call-site
 * intent and survives any future narrowing of the `reason` union to a
 * `whyUpdated`-only sub-set.
 */
export type WhyUpdatedResult = WhyResult

/**
 * Result type alias produced by {@link whyNotUpdated}.
 *
 * Same shape as {@link WhyResult}; the alias documents the call-site
 * intent and survives any future narrowing of the `reason` union to a
 * `whyNotUpdated`-only sub-set.
 */
export type WhyNotUpdatedResult = WhyResult

/**
 * Attach a derived `because` string to a partial result.
 *
 * @param partial - A {@link WhyResult} missing only the `because` field.
 * @returns The fully populated {@link WhyResult}.
 */
function withBecause(
  partial: Omit<WhyResult, 'because'>,
): WhyResult {
  return { ...partial, because: renderWhy(partial) }
}

/**
 * Render the human-readable `because` string for a {@link WhyResult}.
 *
 * Public so consumers can re-render the message in their own tone or
 * locale without round-tripping through string parsing. The output
 * format is non-API and may change between releases.
 *
 * Exhaustive over {@link WhyReason} via {@link assertNever}: adding a
 * new variant produces a compile error here instead of a silent
 * runtime fallback.
 *
 * @param r - A result missing the `because` field.
 * @returns A short English sentence describing the classification.
 */
export function renderWhy(r: Omit<WhyResult, 'because'>): string {
  // Pull commit time and intent for inclusion in the rendered text.
  const t = r.cause?.time
  const i = r.cause?.intent

  // Switch on the discriminant tag; each branch produces its own copy.
  switch (r.reason) {
    case 'directly-set':
      return `Set directly in commit "${i}" (t=${t}).`
    case 'recomputed':
      return `Recomputed because ${(r.inputs ?? []).join(', ')} changed in commit "${i}" (t=${t}).`
    case 'no-cause':
      return `${r.node} has not changed in the visible commit window.`
    case 'did-update':
      return `${r.node} DID update in the latest commit "${i}".`
    case 'no-dep-overlap':
      return `Latest commit "${i}" touched ${(r.inputs ?? ['(nothing)']).join(', ')}, none of which are dependencies of ${r.node}.`
    case 'object-is-deduped':
      return `Dependencies (${(r.inputs ?? []).join(', ')}) recomputed but produced an Object.is-equal value; the engine skipped notification.`
    default:
      return assertNever(r.reason, 'renderWhy: unhandled WhyReason')
  }
}

/**
 * Per-graph cache of `(graph, nodeId) → DerivedNode<WhyResult>` for
 * each explainer flavour.
 *
 * Memoising on the graph + target node id keeps a stable identity
 * across re-invocations: a UI that calls `whyUpdated(g, n)` twice
 * receives the same `DerivedNode<WhyResult>` and therefore subscribes
 * to one node, not two. The outer `WeakMap` releases the cache when
 * the graph is collected; the inner `Map` is keyed on the *target*
 * node's id so explainers for distinct nodes coexist on one graph.
 */
const WHY_UPDATED_REGISTRY = new WeakMap<
  WhyGraph,
  Map<NodeId, DerivedNode<WhyUpdatedResult>>
>()
const WHY_NOT_UPDATED_REGISTRY = new WeakMap<
  WhyGraph,
  Map<NodeId, DerivedNode<WhyNotUpdatedResult>>
>()

/**
 * Compute the `whyUpdated` answer for `id` against the engine's commit
 * log and a `get`-bound dependency-set reader.
 *
 * Pure helper extracted so the registered compute closure stays small
 * and so the classification logic is the same shape it always was —
 * walk newest-first, bucket the first hit, fall back to `no-cause`.
 *
 * @param id - The id of the node being explained.
 * @param log - The engine's commit log (oldest-first, per
 *   `graph.commitLog`'s contract).
 * @param directDeps - Dep ids resolved through `graph.explain(node)`
 *   on the current commit; empty for cycles and inputs.
 * @returns A populated {@link WhyResult}.
 */
function classifyWhyUpdated(
  id: NodeId,
  log: readonly Commit[],
  directDeps: readonly NodeId[],
): WhyUpdatedResult {
  // The engine's `commitLog` is oldest-first; walk it newest-first so
  // the *most recent* cause wins. The previous shape took an
  // explicitly newest-first array; reversing here lets the public
  // surface align with the engine's canonical orientation.
  for (let k = log.length - 1; k >= 0; k--) {
    const c = log[k]!
    if (!c.changedNodes.includes(id)) continue

    // Inputs are the commit's other changed nodes that are also deps.
    const inputs = c.changedNodes.filter(
      (other) => other !== id && directDeps.includes(other),
    )

    // Any dependency overlap implies the change came via recomputation.
    if (inputs.length > 0) {
      return withBecause({
        node: id,
        reason: 'recomputed',
        cause: c,
        path: [...inputs, id],
        inputs,
      })
    }

    // No dep overlap → the node was set directly inside the commit body.
    return withBecause({
      node: id,
      reason: 'directly-set',
      cause: c,
      path: [id],
    })
  }

  // Walked the entire window without finding a touching commit.
  return withBecause({
    node: id,
    reason: 'no-cause',
    cause: null,
    path: null,
  })
}

/**
 * Compute the `whyNotUpdated` answer for `id` against the latest
 * commit and the resolved dep set. See {@link classifyWhyUpdated} for
 * the rationale on extracting the helper.
 *
 * @param id - The id of the node being explained.
 * @param log - The engine's commit log (oldest-first).
 * @param directDeps - Dep ids resolved through `graph.explain(node)`.
 * @returns A populated {@link WhyResult}.
 */
function classifyWhyNotUpdated(
  id: NodeId,
  log: readonly Commit[],
  directDeps: readonly NodeId[],
): WhyNotUpdatedResult {
  // Empty window — nothing to explain against.
  if (log.length === 0) {
    return withBecause({
      node: id,
      reason: 'no-cause',
      cause: null,
      path: null,
    })
  }

  // Only the latest commit is in scope for "did-not-update" reasoning.
  const latest = log[log.length - 1]!

  // Reject the premise: the node DID update in the latest commit.
  if (latest.changedNodes.includes(id)) {
    return withBecause({
      node: id,
      reason: 'did-update',
      cause: latest,
      path: [id],
    })
  }

  // Intersect commit-changed nodes with this node's dependencies.
  const overlap = latest.changedNodes.filter((d) => directDeps.includes(d))

  // Empty intersection → the commit affected unrelated parts of the graph.
  if (overlap.length === 0) {
    return withBecause({
      node: id,
      reason: 'no-dep-overlap',
      cause: latest,
      path: null,
      inputs: latest.changedNodes,
    })
  }

  // Non-empty intersection but no recorded change → Object.is-dedup elided
  // the downstream notification.
  return withBecause({
    node: id,
    reason: 'object-is-deduped',
    cause: latest,
    path: [...overlap, id],
    inputs: overlap,
  })
}

/**
 * Resolve the current dependency ids of `node` through
 * `graph.explain` from inside a `commitMetadataDerived` compute.
 *
 * Reading through `get` registers the explanation node as a
 * dependency, so the explainer recomputes whenever the lineage
 * changes — exactly the §11 framing the issue cites.
 */
function resolveDirectDeps<T>(
  get: <U>(n: Node<U>) => U,
  graph: WhyGraph,
  node: Node<T>,
): readonly NodeId[] {
  const exp = get(graph.explain(node))
  return exp.via === 'cycle' ? [] : exp.deps.map((d) => d.node)
}

/**
 * Explain the most recent change to `node` as a live {@link DerivedNode}.
 *
 * The returned node recomputes on every commit through Phase F.5 so
 * subscribers fire on the *same* commit that produced the answer
 * (the previous one-shot snapshot shape returned the *previous*
 * commit's answer — the regression #383 documents). UIs subscribe and
 * compose the result like any other derived; `read(node)` returns the
 * current classification, `readAt(node, t)` projects it historically.
 *
 * Repeated calls with the same `(graph, node)` return the same handle
 * (memoised) — registering the underlying derived twice would throw
 * `DuplicateNodeError`, and stable identity lets a UI compose the
 * result into downstream `derived(...)` without juggling handles.
 *
 * @typeParam T - The node's value type.
 * @param graph - The engine instance.
 * @param node - The node being explained.
 * @returns A {@link DerivedNode} carrying the most recent {@link
 *   WhyUpdatedResult}.
 */
export function whyUpdated<T>(
  graph: WhyGraph,
  node: Node<T>,
): DerivedNode<WhyUpdatedResult> {
  const id = node.id

  // Memoise per (graph, target id). Stable identity is load-bearing:
  // a UI that calls `whyUpdated(g, n)` twice must receive the same
  // node so it subscribes to one stream.
  let perGraph = WHY_UPDATED_REGISTRY.get(graph)
  if (!perGraph) {
    perGraph = new Map()
    WHY_UPDATED_REGISTRY.set(graph, perGraph)
  }
  const cached = perGraph.get(id)
  if (cached) return cached

  // The id encodes the explainer flavour and the target node id so
  // `graph.explain` can render a useful lineage frame and so the
  // engine's `DuplicateNodeError` gate fires on accidental re-use.
  const derivedId = `__devtools.whyUpdated:${id}`

  const handle = graph.commitMetadataDerived<WhyUpdatedResult>(
    derivedId,
    (get) => {
      const log = get(graph.commitLog)
      const directDeps = resolveDirectDeps(get, graph, node)
      return classifyWhyUpdated(id, log, directDeps)
    },
  )

  perGraph.set(id, handle)
  return handle
}

/**
 * Explain the absence of a change to `node` as a live {@link DerivedNode}.
 *
 * Considers only the head of the commit log (the most recent commit).
 * The classification distinguishes four outcomes:
 *
 * - `no-cause`         — the log is empty.
 * - `did-update`       — the latest commit actually updated the node;
 *                        the caller's premise was wrong.
 * - `no-dep-overlap`   — the latest commit changed nodes, but none of
 *                        them are dependencies of this node.
 * - `object-is-deduped` — dependencies overlapped, so the node was
 *                        recomputed, but the new value was
 *                        Object.is-equal to the prior one and the
 *                        engine suppressed notification.
 *
 * Memoised per `(graph, node)` — same rationale as {@link whyUpdated}.
 *
 * @typeParam T - The node's value type.
 * @param graph - The engine instance.
 * @param node - The node being explained.
 * @returns A {@link DerivedNode} carrying the most recent {@link
 *   WhyNotUpdatedResult}.
 */
export function whyNotUpdated<T>(
  graph: WhyGraph,
  node: Node<T>,
): DerivedNode<WhyNotUpdatedResult> {
  const id = node.id

  // Memoise per (graph, target id). See `whyUpdated` for rationale.
  let perGraph = WHY_NOT_UPDATED_REGISTRY.get(graph)
  if (!perGraph) {
    perGraph = new Map()
    WHY_NOT_UPDATED_REGISTRY.set(graph, perGraph)
  }
  const cached = perGraph.get(id)
  if (cached) return cached

  const derivedId = `__devtools.whyNotUpdated:${id}`

  const handle = graph.commitMetadataDerived<WhyNotUpdatedResult>(
    derivedId,
    (get) => {
      const log = get(graph.commitLog)
      const directDeps = resolveDirectDeps(get, graph, node)
      return classifyWhyNotUpdated(id, log, directDeps)
    },
  )

  perGraph.set(id, handle)
  return handle
}
