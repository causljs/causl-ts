/**
 * @packageDocumentation
 *
 * Public entry point for `@causljs/devtools`.
 *
 * I won't make the engine "live" by bolting a devtools panel onto the
 * side. The engine is inspectable through its own primitives:
 * `graph.explain(node)` returns another node — a derived view of the
 * dependency lineage that can itself be subscribed to, displayed,
 * drilled into. The transaction log is a `Behavior [Commit]` — queryable
 * by the same API as any other graph value. A REPL connected to a
 * running graph can mutate, replace, and replay derivations without
 * restarting the host process. Devtools become a UI rendered on top of
 * those primitives, not a parallel system. If I cannot demo "edit a
 * derivation while it's running, watch the change propagate," I have not
 * earned the comparison to spreadsheets.
 *
 * This package re-exports those primitives in UI-friendly shapes: a
 * commit-log buffer, node inspector, statechart configuration view,
 * lineage explainers (`whyUpdated` / `whyNotUpdated`), live-derivation
 * REPL handles, and snapshot export/import. Each export is a thin
 * surface over `@causljs/core` so a devtools UI can render directly on
 * top of the engine without a parallel state model.
 */

// Commit-log panel — bounded, most-recent-first projection of
// `graph.commitLog` returned as a `DerivedNode<readonly Commit[]>`.
export type { CommitLogGraph, CommitLogOptions } from './commitLog.js'
export { commitLog } from './commitLog.js'

// Node inspector — packages `graph.explain` reads for UI consumption.
export type { NodeInspectorView, InspectorGraph } from './inspector.js'
export { inspect, watchInspect } from './inspector.js'

// Statechart configuration — current Engine-region state for UI rendering.
export type { EngineState, StatechartConfiguration, StatechartGraph } from './statechart.js'
export { renderStatechartMermaid, statechart } from './statechart.js'

// Lineage explainers — recompute / non-recompute root-cause analysis,
// each returned as a `DerivedNode<WhyResult>` per §11.
export type {
  WhyGraph,
  WhyNotUpdatedResult,
  WhyReason,
  WhyResult,
  WhyUpdatedResult,
} from './why.js'
export { renderWhy, whyNotUpdated, whyUpdated } from './why.js'

// Live derivations — REPL-style swap of compute closures without restart.
export type { LiveDerivedHandle } from './liveDerivation.js'
export { liveDerived, replaceMany } from './liveDerivation.js'

// Snapshot capture/replay — deterministic re-application of input state.
export type { ExportOptions, ImportOptions, Snapshot, SnapshotReadGraph } from './snapshot.js'
export {
  exportSnapshot,
  exportSnapshotJson,
  importSnapshot,
  importSnapshotJson,
} from './snapshot.js'

/**
 * Package version string. Bumped in lock-step with the npm release.
 *
 * @remarks
 * Phase 5 ships at `0.0.0` while the public surface is being validated
 * against the liveness commitment — that the engine be inspectable
 * through its own primitives rather than a parallel devtools system.
 */
export const VERSION = '0.0.0'
