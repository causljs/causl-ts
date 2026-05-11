# @causl/devtools

Inspection primitives for [Causl](../../README.md).

> Transactional state for tangled dependency graphs.

## Status

Shipped as of v0.9.0. Sits on top of `@causl/core`. The animating
principle is that the engine should be inspectable through its own
primitives, not through a parallel devtools panel sitting next to it.
So this package surfaces the things a non-programmer would expect of
a spreadsheet — see a value change, drill into why, edit a derivation
while it runs — by composing the same `derived` / `subscribe` API
every consumer already uses.

All seven primitives listed under Surface are implemented and
exercised by the package's test suite. The inspector UI that consumes
them lives in `@causl/devtools-bridge` (read-only host channel using
the narrow capability slice
`Pick<Graph, 'read' | 'subscribeCommits' | 'now' | 'commitLog' | 'snapshotAt' | 'readAt' | 'dependencies' | 'dependents'>`,
per SPEC §13 — no `commit`, no `hydrate`, JUMP is view-only).

## Surface

Exports mirror `src/index.ts`. Every primitive is a thin wrapper over
`@causl/core`; nothing here is a parallel state model.

- `inspect(graph, node)` / `watchInspect(graph, node, observer)` —
  current value, deps, dependents (each itself a derived node), with
  `watchInspect` emitting a fresh view on every commit that touches
  the node. The README's earlier `nodeInspector` binding never
  shipped; this is the surface.
- `whyUpdated(graph, node)` / `whyNotUpdated(graph, node)` —
  last-commit lineage of changes, and the same for non-recompute
  deltas (an equality cutoff fired, a dep was unchanged, etc.).
  Both return a `DerivedNode<WhyResult>` per §11 ("the engine is
  its own observer"): subscribe to the returned node and the engine
  pushes a fresh classification on the same commit that produced
  it (Phase F.5, post-`commitLog` refresh). Memoised per `(graph,
node)` so repeated calls share identity. Pair with `renderWhy`
  for a UI-ready string.
- `liveDerived(graph, id, compute)` / `replaceMany(graph, edits)` —
  REPL-style swap of compute closures without restarting the host
  process. This is the §11 "edit a derivation while it's running,
  watch the change propagate" commitment; without it the comparison
  to spreadsheets is unearned.
- `statechart(graph)` / `renderStatechartMermaid(config)` —
  current Engine-region state (`Idle | Committing`) for UI rendering,
  plus a Mermaid renderer for the same composite chart drawn in
  `docs/lifecycle.md` §1.
- `exportSnapshot(graph, options)` / `importSnapshot(graph, snapshot,
options)` — structured snapshot of input values at the current
  GraphTime, replay onto a fresh graph. Derived values are not
  serialised: per the §3 denotational definition they are pure
  functions of their inputs at the same `t` and are reconstructed on
  import. The envelope is versioned (`Snapshot.schema`) and bumps fail
  loudly on mismatch. `exportSnapshotJson` / `importSnapshotJson` are
  the string-shaped variants for transport across processes or storage.
- `commitLog(graph, options?)` — bounded, most-recent-first
  projection of the engine's commit stream as a
  `DerivedNode<readonly Commit[]>`. **The canonical transaction log
  lives on `@causl/core` itself as `graph.commitLog:
DerivedNode<readonly Commit[]>` (SPEC §12.2 / EPIC #283).** The
  devtools wrapper is sugar: a capped, reverse-chronological view
  registered through `graph.commitMetadataDerived` so subscribers
  fire on the same commit that produced the entry (Phase F.5).
  Memoised per `(graph, id)`. Reach for `graph.commitLog` first;
  use this wrapper when bounded memory or newest-first ordering is
  the actual requirement.

Devtools UI lives downstream; this package is the data layer that the
UI is rendered on top of, rather than a parallel system.
