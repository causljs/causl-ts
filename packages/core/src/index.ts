/**
 * @packageDocumentation
 *
 * Public-surface barrel for `@causl/core`.
 *
 * Re-exports the canonical seven-method API — `createCausl`,
 * `graph.input`, `graph.derived`, `graph.commit`, `graph.read`,
 * `graph.subscribe`, `graph.explain` — together with the second-tier
 * extensions justified individually on the `Graph` interface
 * (`subscribeCommits`, `commitLog`, `exportModel`, `simulate`,
 * `snapshot`, `hydrate`, `readAt`, `snapshotAt`, `now`), the structured error classes
 * for the race-class catalogue, and the CauslModel IR plus its
 * JSON Schema document — the bridge from the TypeScript engine to the
 * Rust `causl-check` bounded model checker.
 *
 * Consumers should rely on this barrel; deep imports into individual
 * modules are not part of the supported surface.
 */

// Engine constructor — entry-point to the canonical seven-method API
// (createCausl, input, derived, commit, read, subscribe, explain).
// `GRAPH_ID_REGEX` is the shared source of truth for the
// `name`/`graphId` validity rule; the schema-3 migration codemod
// imports the same constant to refuse a drift between the runtime
// validator and the migration tool.
export { createCausl, GRAPH_ID_REGEX } from './graph.js'

// Public type vocabulary surfaced from ./types.ts.
export type {
  CauslFlags,
  Commit,
  Compute,
  CreateCauslOptions,
  CycleExplanation,
  DepFrame,
  DerivedExplanation,
  DerivedNode,
  EngineTelemetry,
  ExportModelOptions,
  Explanation,
  Graph,
  GraphSnapshot,
  GraphTime,
  InputExplanation,
  InputNode,
  LiveExplanation,
  Node,
  NodeId,
  Observer,
  ObserverErrorContext,
  ObserverErrorHandler,
  RetentionResult,
  SimulateResult,
  SimulateResultClean,
  SimulateResultFailed,
  SubscribeOptions,
  SubscribeReadsObserver,
  Tx,
  Unsubscribe,
  ValueMap,
} from './types.js'

// Structured error classes — one per row in the engine's race-class
// catalogue (concurrent mutation, unknown id, derived write, cycle,
// stale tx, dispose-during-commit, hydration-mismatch, …). Callers
// branch on the tagged identity rather than parse a string.
export {
  CommitInProgressError,
  CycleError,
  DerivedRegistrationStackOverflowError,
  DisposalDuringCommitError,
  DuplicateNodeError,
  HydrationSchemaError,
  InvalidGraphNameError,
  NodeDisposedError,
  NodeHasDependentsError,
  NonDeterministicComputeError,
  NotAnInputNodeError,
  CauslError,
  StaleTxError,
  UnknownNodeError,
} from './errors.js'

// IR types and schema-version constant — bridge to `causl-check`.
// The IR mirrors §4's two-primitive runtime universe (`IRInput |
// IRDerived`); the prior `IRResource` / `IRConflict` / `IRMsg`
// surface area is removed (#359). Schema 3 (PR-B1) adds the
// lifecycle-event union (`IREvent` over `IRSubscribe |
// IRSubscribeCallback | IRUnsubscribe | IRDispose | IRRead |
// IRTxSet`) plus the `IRScope` registry and `IRBridge` allowlist
// EPIC-2's lint passes consume.
export type {
  CauslModel,
  IRBridge,
  IRCallFrame,
  IRCallGraph,
  IRCommit,
  IRDerived,
  IRDispose,
  IREvent,
  IRGraphId,
  IRInput,
  IRNode,
  IRNodeId,
  IRRead,
  IRScope,
  IRSubscribe,
  IRSubscribeCallback,
  IRTxSet,
  IRUnsubscribe,
  ParseResult,
} from './ir.js'
export { CAUSL_MODEL_SCHEMA, parseCauslModel } from './ir.js'

// JSON Schema document for the CauslModel IR.
export type { CauslModelJsonSchema } from './schema.js'
export { causlModelJsonSchema } from './schema.js'

// Pluggable WASM bridge interface (sub-task of EPIC-7 #680, this PR
// closes #691). Exposes the `Bridge` contract every WASM bridge
// implements, the `BridgeFeatures` capability surface, the
// `detectBridge()` harness that probes the host, and the
// `CodeUnitIndex` / `CodePointIndex` newtypes that keep the public
// API stable across the future `wasm:string-view` upgrade. The two
// concrete bridges (`wasmgc-builtins`/`wasmgc-classic` from #692,
// `serde-json` from #693) ship in dedicated PRs; until then
// `detectBridge()` returns a placeholder serde-json bridge.
export type {
  Bridge,
  BridgeFeatures,
  BridgeId,
  CodePointIndex,
  CodeUnitIndex,
  WasmHandle,
  WasmObjectHandle,
  WasmStringHandle,
} from './bridge.js'
export { detectBridge, detectFeatures } from './bridge.js'

// Auto-adapt decision skeleton (sub-task of EPIC-7 #680; this PR
// closes the #686 skeleton, with full wiring deferred to #687 / #685
// per the issue body's dependency note). Exposes the multi-axis
// threshold surface, the measurement-anchored defaults, and the pure
// `shouldMigrate` predicate. Internal helpers (`ewmaOver`,
// `loadThresholdsFromEnv`, `mergeThresholds`,
// `MODULE_THRESHOLD_OVERRIDES`) stay deep-import-only — the wiring
// layer imports them directly until it ships and the public surface
// stabilises around `createCausl({ backend: 'auto', adaptThresholds })`.
export type { AdaptThresholds, GraphStats } from './auto-adapt.js'
export { DEFAULT_THRESHOLDS, shouldMigrate } from './auto-adapt.js'

/**
 * Package version identifier.
 *
 * @remarks
 * Updated by the release tooling; pinned at `0.0.0` during the
 * pre-release phase covered by the current epic.
 */
export const VERSION = '0.0.0'
