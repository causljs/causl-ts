/**
 * @packageDocumentation
 *
 * Snapshot capture and replay for the devtools surface.
 *
 * The semantic foundation of the engine is that a derived value at time
 * `t` is a pure function of its inputs at the same time `t` — every
 * `derived(t) = f(b₁(t), ..., bₙ(t))` is, by definition, a function. Two
 * implementations either agree on what a graph at time `t` evaluates to,
 * or one of them is wrong. That is why this module captures *only*
 * inputs at the current GraphTime: derived values are not state, they
 * are a deterministic readout of the input snapshot, and reconstructing
 * them on import is cheaper than serialising them and risks fewer
 * version-skew bugs.
 *
 * The matching property — that a recorded commit sequence replayed on a
 * fresh graph produces a byte-identical state — is one of the
 * property-based fuzz invariants the engine commits to. That replay
 * guarantee is what makes an exported snapshot sufficient to reconstruct
 * a byte-identical state across sessions or processes.
 *
 * Schema versioning lives in {@link Snapshot.schema} and is checked on
 * import; mismatched payloads fail loudly rather than silently
 * misinterpreting the bytes — the same discipline persistence layers
 * have to follow when the storage adapter refuses to overwrite on a
 * load-failure path.
 */

import type { Graph, InputNode, NodeId } from '@causl/core'

/**
 * Capability slice handed to {@link exportSnapshot} /
 * {@link exportSnapshotJson}.
 *
 * Closes #364: snapshot export is read-only by definition — it freezes
 * the requested input values at the current GraphTime and emits an
 * envelope. The full `Graph` parameter that #257 left in place handed
 * the read-side accessor `commit`, `input`, `derived`, `hydrate`, the
 * time-travel readers, and the admin handles, despite the export path
 * touching only `read` and `now`. Per §12.3 the parameter exposes only
 * those two methods.
 *
 * `importSnapshot` legitimately needs the full `Graph` (it opens a
 * commit), so its parameter stays as `Graph` — only the read-side
 * accessors narrow.
 *
 * Narrowing is type-level. A real `Graph` is still assignable, so call
 * sites keep working; the discipline is enforced at compile time inside
 * the implementation.
 */
export type SnapshotReadGraph = Pick<Graph, 'read' | 'now'>

/**
 * On-disk envelope produced by {@link exportSnapshot}.
 *
 * @remarks
 * Bump {@link Snapshot.schema} when the shape changes so older imports
 * fail loudly rather than silently misinterpreting the payload.
 */
export interface Snapshot {
  /** Schema version; bump when the on-disk shape changes. */
  readonly schema: 1
  /** GraphTime the snapshot was taken at. */
  readonly time: number
  /** Captured input values, keyed by node id. */
  readonly inputs: Readonly<Record<NodeId, unknown>>
  /** Optional intent label for the import commit. */
  readonly intent?: string
}

/**
 * Options for {@link exportSnapshot} / {@link exportSnapshotJson}.
 */
export interface ExportOptions {
  /** Input nodes to capture. */
  readonly inputs: ReadonlyArray<InputNode<unknown>>
  /** Optional intent for the snapshot file. */
  readonly intent?: string
}

/**
 * Options for {@link importSnapshot} / {@link importSnapshotJson}.
 */
export interface ImportOptions {
  /** Map of input id → InputNode<T> on the destination graph. */
  readonly inputs: ReadonlyMap<NodeId, InputNode<unknown>>
  /** Optional intent override for the import commit. */
  readonly intent?: string
}

/**
 * Capture the values of the requested input nodes into a {@link Snapshot}.
 *
 * @param graph - The source graph.
 * @param options - Specifies the inputs to capture and an optional intent.
 * @returns A {@link Snapshot} envelope at the current GraphTime.
 *
 * @example
 * ```ts
 * const snap = exportSnapshot(graph, { inputs: [a, b, c], intent: 'before-edit' })
 * ```
 */
export function exportSnapshot(graph: SnapshotReadGraph, options: ExportOptions): Snapshot {
  // Read each requested input at current GraphTime.
  const inputs: Record<NodeId, unknown> = {}
  for (const node of options.inputs) {
    inputs[node.id] = graph.read(node)
  }

  // Build envelope, omitting `intent` when absent so JSON stays minimal.
  const snapshot: Snapshot = options.intent
    ? { schema: 1, time: graph.now, inputs, intent: options.intent }
    : { schema: 1, time: graph.now, inputs }
  return snapshot
}

/**
 * Convenience wrapper around {@link exportSnapshot} that returns a
 * JSON string suitable for writing to disk or transmitting over a wire.
 *
 * @param graph - The source graph.
 * @param options - Forwarded to {@link exportSnapshot}.
 * @returns The serialised snapshot.
 */
export function exportSnapshotJson(graph: SnapshotReadGraph, options: ExportOptions): string {
  return JSON.stringify(exportSnapshot(graph, options))
}

/**
 * Re-apply a {@link Snapshot} onto `graph` in a single commit.
 *
 * Inputs in the snapshot whose ids are not present in
 * `options.inputs` are silently skipped — destinations are free to
 * import only the subset of inputs they recognise.
 *
 * @param graph - The destination graph.
 * @param snapshot - The envelope produced by a prior export.
 * @param options - Maps snapshot input ids to destination
 *                  {@link InputNode} handles, and optionally overrides
 *                  the import commit's intent.
 * @throws {Error} If `snapshot.schema` is not a supported version.
 */
export function importSnapshot(
  graph: Graph,
  snapshot: Snapshot,
  options: ImportOptions,
): void {
  // Reject envelopes whose schema we do not understand.
  if (snapshot.schema !== 1) {
    throw new Error(`Unsupported snapshot schema: ${snapshot.schema}`)
  }

  // Resolve the commit intent, preferring caller override → envelope → default.
  const intent = options.intent ?? snapshot.intent ?? 'import-snapshot'

  // Apply every recognised input in a single commit so observers fire once.
  graph.commit(intent, (tx) => {
    for (const [id, value] of Object.entries(snapshot.inputs)) {
      const node = options.inputs.get(id)
      if (!node) continue
      tx.set(node, value)
    }
  })
}

/**
 * Convenience wrapper around {@link importSnapshot} that accepts a
 * JSON string. Parsing is delegated to `JSON.parse`; malformed JSON
 * surfaces as a parse exception before any commit is opened.
 *
 * @param graph - The destination graph.
 * @param json - Serialised snapshot (as produced by {@link exportSnapshotJson}).
 * @param options - Forwarded to {@link importSnapshot}.
 */
export function importSnapshotJson(
  graph: Graph,
  json: string,
  options: ImportOptions,
): void {
  importSnapshot(graph, JSON.parse(json) as Snapshot, options)
}
