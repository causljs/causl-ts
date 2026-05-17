/**
 * @packageDocumentation
 *
 * CauslModel intermediate representation — the JSON document that
 * `graph.exportModel()` produces and that `causl-check` consumes.
 *
 * The TypeScript engine emits this IR as the bridge to the Rust bounded
 * model checker. The Rust binary parses the model and constructs a
 * state-space exploration over it, enumerating — within configurable
 * bounds — all orderings of pending async resolutions, all orderings
 * of message dispatches the application can produce, and all branches
 * of conditional `derived` bodies that the IR captured. At every
 * reachable state the checker asserts glitch-freedom (every derived
 * value equals its compute applied to its current dependencies' values
 * with no two values disagreeing about `GraphTime`), dynamic-dependency
 * correctness (no orphan edges), cycle reachability, and replay
 * determinism.
 *
 * The IR captures registered nodes, their static and conditional
 * dependency edges, the most recent committed value, and an optional
 * capped commit log used for replay-determinism checks.
 *
 * Two-primitive discipline (§4). The IR mirrors the engine's runtime
 * universe: every node is either an {@link IRInput} (a writable
 * Behavior captured at export time) or an {@link IRDerived} (a
 * composed Behavior whose dependency set was captured during its last
 * successful compute). The previous draft of this IR re-introduced an
 * eleven-`NodeKind` taxonomy through optional `resources`,
 * `conflicts`, and `msgs` arrays alongside dedicated `IRResource`,
 * `IRConflict`, and `IRMsg` discriminated unions — that surface is
 * removed (#359). What used to be a separate "resource" node is an
 * `IRInput` whose value happens to carry a `ResourceState<T>` payload;
 * what used to be a separate "conflict" node is an `IRDerived` over
 * an Input map; what used to be a Msg union is an application-layer
 * concern the checker reads alongside the runtime IR via the static
 * walk in `tools/checker`. Roles, not kinds.
 *
 * Conventions:
 *   - Values are JSON-serialisable. Inputs that hold non-serialisable
 *     content (functions, symbols, host objects) are flagged
 *     `serializable: false` and excluded from the checker's reachable
 *     state enumeration.
 *   - Dependency edges are static snapshots: a derived's `deps` array
 *     is the dependency set observed during its last successful
 *     compute. Conditional dependencies the engine has not yet seen
 *     live in `conditionalDeps` as a best-effort over-approximation.
 *   - The IR carries the schema version so `causl-check` can refuse
 *     mismatched models cleanly.
 */
/**
 * Schema version of the CauslModel IR.
 *
 * @remarks
 * Bumped on any breaking change to the IR shape. The Rust checker
 * compares this constant against its own compiled-in version and
 * rejects mismatches rather than guessing at a migration.
 *
 * **Schema 3 (current).** Adds {@link IRGraphId | `graphId`} on every
 * node and commit (the multi-graph foreign key the future cross-graph
 * aggregator depends on); adds the bounded {@link IRCallGraph}
 * annotation slot on `IRCommit`; adds the `events: readonly never[]`
 * forward-compatibility array on the top-level document. The
 * `events` array is empty under schema 3 today; future schemas (3.x
 * or 4) widen the array element type to a discriminated union of
 * lifecycle events (`IRSubscribe | IRUnsubscribe | IRDispose | IRRead
 * | IRTxSet`) once a downstream pass consumes them. Schema 3 is the
 * shape PR-A of EPIC-1 ships per the brutal-critical review's slicing
 * recommendation: bump the wire format once for additive fields, and
 * design the event variants alongside the consuming pass rather than
 * speculatively.
 *
 * **Schema 2 (previous).** #359 collapsed the prior optional
 * `resources` / `conflicts` / `msgs` arrays in service of §4's
 * two-primitive discipline — a wire-format break for any consumer
 * that had begun parsing the optional fields.
 *
 * **Schema 1 (initial).** The pre-collapse shape with eleven node
 * `kind` constants. Retired in #359.
 */
declare const CAUSL_MODEL_SCHEMA: 3;
/**
 * Stable identifier for a single graph instance.
 *
 * @remarks
 * Schema 3 introduces multi-graph IR: a single exported document may
 * carry nodes, commits, and events that originated on more than one
 * engine instance once the future cross-graph aggregator lands. The
 * `graphId` field on every node and commit is the foreign key the
 * checker uses to partition passes per graph. Source rule (`name`
 * from `createCausl({ name })` precedence + UUID v4 fallback) lives
 * in `createCausl`'s implementation.
 */
type IRGraphId = string;
/**
 * Node identifier as represented inside the IR.
 *
 * @remarks
 * String-typed mirror of the engine's {@link NodeId}; kept distinct
 * because the IR may outlive the live graph and travels across the
 * FFI boundary to the Rust checker.
 */
type IRNodeId = string;
/**
 * IR projection of an `input` node — a writable Behavior captured at
 * export time.
 *
 * @remarks
 * The §4 two-primitive discipline lives here. What earlier drafts
 * called a "resource" is an `IRInput` whose `value` carries the
 * application's `ResourceState<T>` payload — composition at the
 * application layer, not a separate `kind` on the wire (#359).
 */
interface IRInput {
    /** Discriminator selecting the input variant of {@link IRNode}. */
    readonly kind: 'input';
    /** Identifier of the input node within the source graph. */
    readonly id: IRNodeId;
    /**
     * Identifier of the graph instance this node belongs to.
     * Required as of schema 3; sourced from the precedence rule
     * (`createCausl({ name })` first, UUID v4 fallback). Same value
     * appears on every node and commit produced by one
     * `graph.exportModel()` call.
     */
    readonly graphId: IRGraphId;
    /** Most recent committed value, mirrored verbatim into the IR. */
    readonly value: unknown;
    /**
     * Whether `value` is JSON-serialisable. Non-serialisable inputs are
     * skipped by the checker's state-space enumeration.
     */
    readonly serializable: boolean;
}
/**
 * IR projection of a `derived` node — a composed Behavior whose
 * dependency set was captured during its last successful compute.
 *
 * @remarks
 * The §4 two-primitive discipline lives here. What earlier drafts
 * called a "conflict" is an `IRDerived` over an Input map — a derived
 * view of the engine's own lifecycle, composed at the application
 * layer rather than spelled as a separate `kind` (#359).
 */
interface IRDerived {
    /** Discriminator selecting the derived variant of {@link IRNode}. */
    readonly kind: 'derived';
    /** Identifier of the derived node within the source graph. */
    readonly id: IRNodeId;
    /**
     * Identifier of the graph instance this node belongs to.
     * Required as of schema 3.
     */
    readonly graphId: IRGraphId;
    /** Dependency set as of the most recent compute. */
    readonly deps: readonly IRNodeId[];
    /** Conditional deps the engine *might* read but has not yet. */
    readonly conditionalDeps: readonly IRNodeId[];
    /**
     * The most recent committed value, mirrored here so the checker
     * does not need to re-evaluate compute closures (which Rust cannot
     * call across the FFI boundary).
     */
    readonly value: unknown;
    /**
     * Whether the mirrored `value` is JSON-serialisable; gates inclusion
     * in the checker's reachable-state enumeration.
     */
    readonly serializable: boolean;
}
/**
 * One frame of the bounded call-graph annotation captured on
 * {@link IRCommit.callGraph}.
 *
 * @remarks
 * Best-effort projection of the synchronous JS call stack at commit
 * time. `site` is the symbolic name from the V8 / JSC stack-trace
 * API; `source` and `line` are populated when the host's stack-trace
 * API exposes them (V8 typically does in dev; production-minified
 * builds may omit). All three fields are JSON-safe.
 */
interface IRCallFrame {
    /** Symbolic name of the call site (function or method name). */
    readonly site: string;
    /** File path or module specifier, when the stack-trace API exposes it. */
    readonly source?: string;
    /** Line number, when available. */
    readonly line?: number;
}
/**
 * Bounded call-graph annotation captured on {@link IRCommit.callGraph}
 * by the exporter when {@link ExportModelOptions.captureCallGraph} is
 * `true` (default).
 *
 * @remarks
 * Frames are recorded in caller-to-callee order, outermost frame at
 * index 0. The depth bound is `D = 32` per `SPEC.md` §16.2.1.3
 * granularity decisions; deeper frames are dropped and the
 * `truncatedDeeper` flag is set so consumers can distinguish "the
 * stack was exactly this deep" from "the stack was deeper, we cut it
 * off".
 */
interface IRCallGraph {
    /**
     * Frames in caller-to-callee order, capped at `D = 32`. Empty when
     * the runtime stack-trace API was unavailable.
     */
    readonly frames: readonly IRCallFrame[];
    /**
     * Set when the application's true call stack at commit time was
     * deeper than the configured bound and frames beyond it were
     * dropped.
     */
    readonly truncatedDeeper: boolean;
}
/**
 * Subscribe event — the moment an observer registers on a node.
 *
 * @remarks
 * `id` is the subscription identifier the engine mints at registration.
 * `scopeId` resolves into one of {@link CauslModel.scopes}; the
 * `SubscribeWithoutDispose` lint pass uses it to scope the
 * dispose-or-not-required decision (an `infinite` scope absolves the
 * subscription from needing a paired dispose). `target` is the node
 * id the observer registered on. `callbackSite` is the best-effort
 * source location captured by the exporter; on runtimes without a
 * stack-trace API it falls back to `'<unknown>'`.
 */
interface IRSubscribe {
    readonly kind: 'subscribe';
    readonly graphId: IRGraphId;
    readonly id: string;
    readonly scopeId: string;
    readonly target: IRNodeId;
    readonly callbackSite: string;
    readonly time: number;
}
/**
 * Subscribe-callback frame — the moment a registered observer fires
 * during Phase G of a commit.
 *
 * @remarks
 * Distinct from {@link IRSubscribe} (which is the *registration*
 * event); this variant is the *invocation* event. EPIC-2's
 * `CommitFromSubscribe` pass walks `originEvent` lineage on
 * {@link IRCommit} back to a callback frame to surface the row-1
 * cascading-commit anti-pattern. PR-B1 reserves the wire-format slot
 * but does not yet instrument the engine to emit these — adopters
 * see zero `subscribe-callback` events under PR-B1.
 */
interface IRSubscribeCallback {
    readonly kind: 'subscribe-callback';
    readonly graphId: IRGraphId;
    readonly id: string;
    readonly subscribeId: string;
    readonly firedAt: number;
}
/**
 * Unsubscribe event — the moment a subscription is torn down.
 *
 * @remarks
 * Symmetric to {@link IRSubscribe}; the pair `(id, scopeId)`
 * uniquely identifies the subscription being retired. The exporter
 * preserves a bounded ring of recent unsubscribes so the
 * `SubscribeWithoutDispose` pass can pair lifecycle records.
 */
interface IRUnsubscribe {
    readonly kind: 'unsubscribe';
    readonly graphId: IRGraphId;
    readonly id: string;
    readonly scopeId: string;
    readonly time: number;
}
/**
 * Dispose event — the moment a node is removed from the graph.
 *
 * @remarks
 * `disposeAt` is a half-open `[enqueueAt, appliedAt]` interval per
 * the brutal-critical review's recommendation. The interval gives
 * EPIC-2's `UseAfterDispose` pass an unambiguous comparison surface:
 * a read at `t_r` is a use-after-dispose iff `t_r > appliedAt`. For
 * an immediate dispose (the common case), `enqueueAt === appliedAt`.
 * The two-field shape costs two numbers per dispose record on the
 * wire; the soundness gain is the brutal-critical review's
 * recommendation #5.
 */
interface IRDispose {
    readonly kind: 'dispose';
    readonly graphId: IRGraphId;
    readonly nodeId: IRNodeId;
    readonly scopeId: string;
    readonly time: number;
    readonly disposeAt: readonly [number, number];
}
/**
 * Read event — a per-commit summary of the reads a derived performed.
 *
 * @remarks
 * Capped at K=256 reads per commit (SPEC §16.2.1.3 granularity
 * decisions). `seq` is the index in the *retained* slice
 * (`0..len-1`) — the original read sequence number is not preserved
 * past truncation. The last retained read of a truncated summary
 * carries `truncated: true` so consumers can distinguish
 * "the derived read 256 nodes" from "the derived read more than 256
 * but we only kept the first 256". PR-B1 reserves the wire-format
 * slot but does not yet instrument the engine to emit these.
 */
interface IRRead {
    readonly kind: 'read';
    readonly graphId: IRGraphId;
    readonly derivedId: IRNodeId;
    readonly readNodeId: IRNodeId;
    readonly time: number;
    readonly seq: number;
    readonly truncated: boolean;
}
/**
 * Tx-set event — a `tx.set(node, value)` call inside a commit.
 *
 * @remarks
 * Drained inside the retained `commits` window (the exporter's
 * `maxCommits` cap). Records *intent*, not effect: every
 * `tx.set(node, value)` produces an event regardless of whether the
 * staged value differs from the prior committed value (the engine's
 * Phase B equality short-circuit is a separate concern). PR-B1
 * reserves the wire-format slot but does not yet instrument the
 * engine to emit these.
 */
interface IRTxSet {
    readonly kind: 'tx-set';
    readonly graphId: IRGraphId;
    readonly inputId: IRNodeId;
    readonly time: number;
}
/**
 * Lifecycle event variant — the closed six-arm discriminated union
 * EPIC-2's lint passes pattern-match against.
 *
 * @remarks
 * PR-B1 widens this from `never` (PR-A's forward-compat placeholder)
 * to the six variants the EPIC-2 passes actually consume. The
 * discriminator is `kind`, with on-the-wire literal strings that
 * must match the Rust serde rename byte-for-byte:
 *   - `subscribe`
 *   - `subscribe-callback` (kebab; sixth variant for commit-origin
 *     lineage per the brutal-critical review's recommendation #1)
 *   - `unsubscribe`
 *   - `dispose`
 *   - `read`
 *   - `tx-set` (kebab; the engine-facing TS uses `tx.set` and the
 *     wire byte is the kebab-case form)
 *
 * Adding a seventh variant requires changing this declaration and is
 * caught at every `assertNever`-guarded reading site in the engine
 * and the checker.
 */
type IREvent = IRSubscribe | IRSubscribeCallback | IRUnsubscribe | IRDispose | IRRead | IRTxSet;
/**
 * Lifecycle scope — the `IRScope` shape EPIC-2's
 * `SubscribeWithoutDispose` pass resolves `scopeId` against.
 *
 * @remarks
 * `kind: 'infinite'` absolves a subscription from needing a paired
 * dispose (the scope outlives the process); `kind: 'process-exit'`
 * is the same arm by a different name (the scope's terminator IS the
 * process exit). `kind: 'ephemeral'` is the default — a finite-lived
 * scope (component mount, request, transaction) where dispose is
 * required.
 */
interface IRScope {
    readonly id: string;
    readonly kind: 'ephemeral' | 'infinite' | 'process-exit';
    readonly lifetime: {
        readonly origin: string;
        readonly terminator: string;
    };
}
/**
 * Bridge — a sanctioned cross-graph dependency declaration.
 *
 * @remarks
 * Schema 3 multi-graph IR documents may carry nodes from more than
 * one engine instance once the future cross-graph aggregator lands.
 * EPIC-2's `CrossGraphRead` pass refuses any cross-graph dep that is
 * not explicitly bridged; this record is the allowlist. Three policy
 * arms: `legacy-allow` (migration path, soft warning), `test-only`
 * (stripped from production exports), `read-only` (read-only access
 * to the source graph).
 */
interface IRBridge {
    readonly from: IRGraphId;
    readonly to: IRGraphId;
    readonly dep: IRNodeId;
    readonly policy: 'legacy-allow' | 'test-only' | 'read-only';
}
/**
 * Tagged union over the two node variants the checker understands.
 *
 * @remarks
 * Closed by construction. `IRNode` is exactly `IRInput | IRDerived`;
 * adding a third variant requires changing this declaration and is
 * caught at every `assertNever`-guarded switch in the engine and the
 * checker (#359, #368).
 */
type IRNode = IRInput | IRDerived;
/**
 * IR projection of a single committed event in the graph's history.
 *
 * @remarks
 * Used by `causl-check` to drive replay-determinism checks:
 * replaying a captured commit sequence from a captured snapshot must
 * produce a byte-identical model state. If two replays diverge, one
 * of them is wrong — the checker reports the discrepancy with a
 * shrunk minimal counter-example.
 */
interface IRCommit {
    /** GraphTime at which the commit landed. */
    readonly time: number;
    /**
     * Identifier of the graph instance this commit landed on.
     * Required as of schema 3.
     */
    readonly graphId: IRGraphId;
    /** Human-readable label supplied to `graph.commit(intent, …)`. */
    readonly intent: string;
    /** Node identifiers whose value changed as part of the commit. */
    readonly changedNodes: readonly IRNodeId[];
    /**
     * For commits issued by `graph.hydrate(...)`, the GraphTime carried
     * by the originating snapshot envelope. `undefined` (or omitted) on
     * `graph.commit(...)`-issued records. The engine clock advances by
     * exactly one tick per hydrate (the §3 monotonicity invariant); this
     * field preserves the on-the-wire snapshot label so replay tooling
     * can distinguish hydration events from regular commits without
     * parsing `intent`.
     *
     * The optional-or-explicit-undefined typing mirrors the published
     * {@link import('./types.js').Commit.originatedAt} surface (#760):
     * the engine's in-memory IRCommit row always-sets the slot to keep
     * the V8 hidden class stable, while serialized exports may still
     * omit the key on regular commits.
     */
    readonly originatedAt?: number | undefined;
    /**
     * Bounded call-graph annotation captured at commit-issue time.
     * Optional — exporter omits the field when stack-trace capture is
     * disabled (`captureCallGraph: false` on the export options).
     * Schema 3 introduces this field; schema-2 IRs that never set it
     * should either omit it or set `undefined`.
     */
    readonly callGraph?: IRCallGraph;
    /**
     * Lineage to the {@link IRSubscribeCallback} or other event that
     * initiated this commit. Optional and presence-discriminating: a
     * commit *with* `originEvent` set was emitted from a callback frame
     * (an EPIC-2 `CommitFromSubscribe` candidate); a commit *without*
     * was user-initiated. The string value is the `id` of the
     * originating event in {@link CauslModel.events}. PR-B1 reserves the
     * field on the wire and exports it as `undefined` until the engine
     * gains in-callback commit instrumentation.
     */
    readonly originEvent?: string;
}
/**
 * Top-level IR document produced by `graph.exportModel()`.
 *
 * @remarks
 * Realises the engine's contract with the bounded model checker:
 * property-based fuzz alone is statistical, so the engine emits this
 * snapshot for an exhaustive bounded enumeration that aims to lift
 * runtime-detection rows (stale-async, dynamic-dependency cleanup,
 * cycle reachability) into compile-time-equivalent CI gates. Hosts
 * cap the commit log via {@link ExportModelOptions} to bound checker
 * workload — the same trade `kani` and `loom` make: out-of-bounds
 * programs (more nodes, more commits, longer message chains than the
 * configured bounds) are *not proven* by the checker and rely on the
 * property-based fuzz suite plus runtime guards.
 *
 * The shape is closed at two `kind` constants by construction (#359).
 * What used to be optional `resources`, `conflicts`, and `msgs`
 * arrays — each carrying its own `kind` discriminator — was the
 * eleven-`NodeKind` taxonomy §4 spent its budget collapsing. Resource
 * state is already an Input value; conflicts are a derived view over
 * an Input map; the Msg union is an application-checker concern.
 * Adapter packages that need richer model state run their own
 * projector against a public `Graph` view and emit a sibling document
 * that the checker reads alongside the engine IR — they do not extend
 * `CauslModel`.
 */
interface CauslModel {
    /** Schema version pinned to {@link CAUSL_MODEL_SCHEMA}. */
    readonly schema: typeof CAUSL_MODEL_SCHEMA;
    /** Engine GraphTime at export time. */
    readonly time: number;
    /** Snapshot of every registered node at export time. */
    readonly nodes: readonly IRNode[];
    /**
     * Optional commit log, capped by host caller. The checker uses
     * this for replay-based determinism checks.
     */
    readonly commits: readonly IRCommit[];
    /**
     * Lifecycle event stream — the closed six-arm discriminated union
     * EPIC-2's lint passes consume. PR-B1 widens this from PR-A's
     * `readonly never[]` placeholder; the engine drains its subscriber
     * registry, disposal tombstones, tx-set log, and read-trace map
     * into the array at `exportModel()` time.
     */
    readonly events: readonly IREvent[];
    /**
     * Lifecycle scopes referenced by `IRSubscribe.scopeId`,
     * `IRUnsubscribe.scopeId`, and `IRDispose.scopeId`. The exporter
     * always emits at least one default scope per graph
     * (`{ id: 'g.<graphId>:default', kind: 'infinite', ... }`) so every
     * `scopeId` resolves. Adopters that need finer scoping pass an
     * explicit scope option to `subscribe()`; PR-B1 reserves the wire
     * shape and a future PR adds the option.
     */
    readonly scopes: readonly IRScope[];
    /**
     * Sanctioned cross-graph dependency declarations. Empty under
     * single-graph IR documents (the common case); populated by a
     * future cross-graph aggregator. EPIC-2's `CrossGraphRead` pass
     * refuses any cross-graph dep not in this list.
     */
    readonly bridges: readonly IRBridge[];
    /**
     * Whether the IR's read-set capture was truncated during
     * serialisation. Per the EPIC-1 brutal-critical review's
     * recommendation #4 (#584 A17-4): when the exporter caps a
     * derived's `IRRead` summary at the K=256 retention bound,
     * downstream consumers (the checker, the bounded enumerator,
     * SARIF dashboards) need to know they're reasoning over a
     * partial picture. A `false` here is the load-bearing
     * "no truncation occurred — every read of every derived is
     * preserved" claim; a `true` is the honest acknowledgement
     * that the checker may emit false negatives on rows whose
     * proof requires reads past the cap.
     *
     * Defaults to `false` when omitted (older IR documents and
     * adopters that construct CauslModel by hand are treated as
     * complete).
     */
    readonly readsTruncated?: boolean;
}
/**
 * Result of {@link parseCauslModel} — discriminated by `ok`.
 *
 * @remarks
 * Path-precision is the contract the validator commits to: when a
 * document fails, the caller receives the JSON path to the offending
 * field, not a generic "invalid IR". This is the failure shape SPEC
 * §16.2 names: a wire format with no version discipline is a
 * bug-shaped contract; structured rejection on mismatch is what
 * makes the discipline mechanical.
 */
type ParseResult = {
    readonly ok: true;
    readonly value: CauslModel;
} | {
    readonly ok: false;
    readonly path: readonly (string | number)[];
    readonly reason: string;
};
/**
 * Runtime structural validator for {@link CauslModel}. Used by the
 * IR exporter's round-trip tests, by integration tests that feed
 * hand-rolled IR to the checker, and by the schema-3 acceptance gate
 * (TASK 1.B1.5).
 *
 * @remarks
 * Validates the seven top-level fields exactly: `schema | time |
 * nodes | commits | events | scopes | bridges`. Each field is
 * checked structurally; failures produce a {@link ParseResult} with
 * a precise JSON path to the offending value.
 *
 * The validator does NOT semantic-check (e.g., unknown-dep, cycle,
 * monotonic commit times) — those are the linter's job. This is the
 * shape gate before the linter runs.
 */
declare function parseCauslModel(input: unknown): ParseResult;

/**
 * @packageDocumentation
 *
 * **#1159 — re-calibration is deferred.** The threshold anchors below
 * (`nodeCount: 50_000`, `medianCommitMsThreshold: 1.0` ms,
 * `commitCount: 500`, `totalSubscribers: 1_000`,
 * `maxChainDepth: 500`, `rollingCommitWindow: 100`) were derived
 * against the Phase-1 TS-wrapper measurement where WasmBackend ≈
 * TS-backend perf at all sizes and the boundary round-trip was
 * effectively free (264 ns/op warm per #1006 / PR #1035). When the
 * real Rust backend ships, the boundary tax shifts (Eich/Horwat panel
 * projection per #1006: ~6 µs/op real-Rust vs. ~1.9–3.0 µs/op
 * Phase-1 stub), the per-commit savings shape changes, and the
 * trigger band needs re-derivation from measured data. **Trigger
 * condition for re-calibration: #1147 (Rust port Phase A — port
 * Phase A/B/C/C.5 into `engine-rs-core`) ships.** Until then, the
 * thresholds in {@link DEFAULT_THRESHOLDS} are intentionally
 * untouched — they are correct for the Phase-1 wrapper measurement,
 * and changing them ahead of real-Rust data would re-introduce the
 * "panel projection vs. measurement" gap the #1015 V8-inlining lesson
 * flagged. The scaffold for the post-Rust validation bench lives in
 * `packages/bench/test/auto-adapt-recalibration.test.ts` (all skipped
 * via `it.skipIf(!realRustBackend)` today; activates when #1147 lands).
 *
 * @see #1159 — this deferral.
 * @see #1147 — Rust port Phase A (Phase A/B/C/C.5 → engine-rs-core);
 *   the trigger that unblocks re-calibration.
 * @see #1145 — auto-adapt validation sweep against the real Rust
 *   backend (sibling work item under epic #1133).
 *
 * Pure auto-adapt decision function for the WASM-engine epic (#680).
 *
 * @remarks
 * This module is the **decision skeleton** for the auto-adapt heuristic
 * (#686). It computes one boolean — "should the active backend migrate
 * from the canonical TS engine to the WASM backend on the next commit
 * boundary?" — from a snapshot of `EngineTelemetry` plus a short
 * commit-history window. It is deliberately scoped to the predicate
 * itself: no I/O, no Graph reference, no `process.env` lookups on the
 * hot path, no migration call.
 *
 * The wiring layer that calls {@link shouldMigrate} from
 * `createCausl({ backend: 'auto' })` lives in #687 (state-migration
 * boundary, `wasm-7`) and is gated behind #685's determinism gate
 * (`wasm-5`). Both are still open at the time of writing; landing the
 * pure decision function ahead of them keeps the seam reviewable on
 * its own and lets the threshold defaults be regenerated without
 * touching the wiring.
 *
 * **Empirical anchors for the {@link DEFAULT_THRESHOLDS} numbers:**
 *
 * - `nodeCount: 50_000` — anchored to the crossover-curve sweep in
 *   #694 / PR #1033. The TS engine is flat at the V8 floor through
 *   N=10k on linear-chain shape (290 → 355 ns/node, 1.0× → 1.2× of
 *   floor); the inflection appears at N=50k (581 ns/node, 2.0×). The
 *   issue body's intuited `nodeCount: 5_000` was 10× too aggressive
 *   for this shape, so the default is bumped to the measured
 *   inflection point.
 *
 * - `maxChainDepth: 500` — chain-shape inflection point unchanged
 *   from the issue body. Long chains stress derivation walking, which
 *   the WASM backend addresses independently of node-count cost.
 *
 * - `medianCommitMsThreshold: 1.0` and `rollingCommitWindow: 100` —
 *   NEW per-commit-cost axis enabled by the cheap-bridge measurement
 *   in #1006 / PR #1035. Boundary round-trip is 264 ns/op warm
 *   (≈ 0.0026 ms / 10k commits), 35× under the 0.2 ms GO threshold
 *   and 70× under the STOP threshold; there is effectively no
 *   boundary tax to amortize, which makes a per-commit-shape trigger
 *   attractive. The 1.0 ms threshold is set against the macro
 *   `equality-cutoff × 10000` cell where causl spends 1.47 ms/commit
 *   (vs. mobx's 0.23 ms — a 6.4× gap driven by per-commit envelope
 *   cost, NOT per-node cost). Eich/Horwat panel estimates roughly
 *   0.7 ms/commit of that envelope is WASM-addressable. **Caveat:**
 *   the panel was 7× too optimistic three times in a row this
 *   session (#1015 V8-inlining lesson); Phase-1 implementation may
 *   close less than predicted. These thresholds are starting values
 *   that will be regenerated empirically once a real WASM backend
 *   lands per the #694 sweep methodology — they are NOT final.
 *
 * - `commitCount: 500` — break-even math from the cheap-bridge
 *   numbers: ~450 ms one-time migration cost (150 ms hydrate +
 *   300 ms fetch) divided by ~0.7 ms/commit projected savings on
 *   commit-heavy shapes ≈ 640 commits to amortize. Rounded down to
 *   500 because the activity gate AND the commit-shape gate must
 *   both fire — the conjunction is the safety, the round number is
 *   the call. The issue body's `10_000` was too conservative once
 *   the bridge cost was measured to be free.
 *
 * - `totalSubscribers: 1_000` — unchanged from the issue body. The
 *   subscriber-count axis is a fan-out heuristic that catches
 *   reactive-UI-shaped workloads independent of node count.
 *
 * **Hysteresis** (audit recommendation, retained from the issue body):
 * the predicate trips only if the multi-axis OR fires on **3
 * consecutive** commits AND the EWMA of `nodeCount` (alpha=0.1) over
 * the full history exceeds the node-count threshold. This eliminates
 * spike-triggered migration — a single 60k-node commit followed by a
 * 30k-node steady state should NOT migrate.
 *
 * **Commit-shape axis sourcing (#1048, Option B):** the per-commit
 * median wall-time used by the commit-shape axis is supplied by the
 * caller via the `commitTimings` parameter on {@link shouldMigrate}.
 * This is the auto-adapt-wrapper-side measurement path — the wrapper's
 * `commit()` shim (landing later when `createCausl({ backend: 'auto' })`
 * integration ships per #685 / #687) timestamps each commit and passes
 * a rolling-window slice of recent durations into the predicate. The
 * engine surface ({@link EngineTelemetry}) stays minimal: per-commit
 * duration is auto-adapt-specific and naturally lives in the wrapper,
 * so the engine carries no observability state for it. The
 * `stats.medianCommitMs` field on {@link GraphStats} remains accepted
 * for backends that DO pre-compute the median internally (the field is
 * still optional / undefined-as-0 on the canonical TS engine), but
 * `commitTimings` is the load-bearing source — when non-empty it
 * overrides `stats.medianCommitMs`. See the "References" footer
 * (#1048) and {@link shouldMigrate}'s `commitTimings` parameter
 * docstring for the wiring contract.
 *
 * **Env-var overrides** read once at module load via
 * {@link loadThresholdsFromEnv}, mirroring the {@link MODULE_FLAGS}
 * precedent in `flags.ts`. The hot path (the eventual `commit()` call
 * site) gets a frozen merged thresholds object captured at engine
 * construction; it does NOT touch `process.env` per commit.
 *
 * @see #686 — this issue.
 * @see #694 / PR #1033 — crossover-curve empirical sweep.
 * @see #1006 / PR #1035 — Phase 0 boundary round-trip measurement.
 * @see #696 / PR #1027 — `EngineTelemetry` cross-backend contract
 *   (the source of {@link GraphStats}).
 * @see #1015 — the V8-inlining lesson that calibrates the 7×-too-
 *   optimistic caveat on the medianCommitMs threshold.
 * @see #1048 — Option B (auto-adapt-wrapper-side measurement) that
 *   threads `commitTimings` through {@link shouldMigrate} so the
 *   engine telemetry surface stays free of per-commit wall-time state.
 * @see https://github.com/iasbuilt/causl/issues/686#issuecomment-4416013410
 *   — the comment that updated the design from single-axis to
 *   multi-axis and anchored the threshold defaults to the post-#1033 /
 *   #1006 measurements.
 */
/**
 * The auto-adapt predicate's view of engine state.
 *
 * @remarks
 * Aliased from {@link EngineTelemetry} so the predicate can be invoked
 * with the same snapshot object {@link Graph.stats} returns — no
 * adapter layer, no field-renaming. The fields the predicate actually
 * reads are a strict subset of `EngineTelemetry`:
 *
 * - `inputs + deriveds` — the user-registered node count, used by the
 *   per-node-cost axis (see `nodeCount` on {@link AdaptThresholds}).
 *   The predicate computes the sum at call time rather than threading
 *   a separate `nodeCount` field through the telemetry surface.
 * - `subscribersTotal` — the fan-out axis, gated against
 *   `totalSubscribers` on {@link AdaptThresholds}.
 * - `lastCommitTime` — used as a monotonic commit-count proxy, gated
 *   against `commitCount`.
 *
 * Two fields are accepted on this surface but NOT on
 * {@link EngineTelemetry}:
 *
 * - `maxChainDepth` — chain-depth axis. The current TS engine does not
 *   surface a max-chain-depth counter (it would require an O(graph)
 *   walk on every snapshot); the predicate treats `undefined` as 0
 *   so a backend that does not measure it skips the chain-depth axis.
 * - `medianCommitMs` — per-commit median cost over the last
 *   `rollingCommitWindow` commits. The current TS engine does not
 *   surface this either; same `undefined`-as-0 treatment applies.
 *
 * The full WASM backend (#687) is expected to populate both. Until it
 * does, the predicate degrades to a node-count + subscriber-count +
 * commit-count gate, which is the issue-body design before the
 * comment-4416013410 widening.
 */
interface GraphStats {
    /** User-registered input nodes; mirrors {@link EngineTelemetry.inputs}. */
    readonly inputs: number;
    /** User-registered derived nodes; mirrors {@link EngineTelemetry.deriveds}. */
    readonly deriveds: number;
    /** Total live subscribers; mirrors {@link EngineTelemetry.subscribersTotal}. */
    readonly subscribersTotal: number;
    /** GraphTime of the most recent commit; mirrors {@link EngineTelemetry.lastCommitTime}. */
    readonly lastCommitTime: number;
    /**
     * Longest derivation chain depth in the registered graph, when the
     * backend can surface it. `undefined` on the canonical TS engine
     * (see module-level @remarks); a backend that does not measure
     * chain depth skips the chain-depth axis of the predicate.
     */
    readonly maxChainDepth?: number | undefined;
    /**
     * Median commit cost (ms) over the last `rollingCommitWindow`
     * commits, when the backend can surface it. `undefined` on the
     * canonical TS engine; a backend that does not measure per-commit
     * cost skips the commit-shape axis of the predicate UNLESS the
     * caller supplies a non-empty `commitTimings` array to
     * {@link shouldMigrate} (the wrapper-side measurement path landed
     * in #1048 / Option B — when supplied, its median takes precedence
     * over this field).
     */
    readonly medianCommitMs?: number | undefined;
}
/**
 * The post-#1033 / #1006 measurement-anchored multi-axis threshold
 * surface — see module-level @remarks for the empirical anchors.
 *
 * @remarks
 * Three independent triggers are OR'd in {@link shouldMigrate}:
 *
 * 1. **Per-node-cost axis**: `nodeCount` (where each node carries the
 *    flat-floor commit cost the crossover-curve measured) OR
 *    `maxChainDepth` (chain-shape inflection).
 * 2. **Per-commit-cost axis**: `medianCommitMsThreshold` over a
 *    `rollingCommitWindow` window — catches commit-heavy workloads
 *    regardless of node count.
 * 3. **Activity gate**: `commitCount` AND `totalSubscribers` — both
 *    must be exceeded together; this is the conjunction that
 *    amortizes the migration cost over a workload that has actually
 *    earned the migration.
 *
 * The activity gate is intentionally a conjunction (not an OR) so a
 * one-off megacommit on an idle graph does NOT migrate; the
 * subscriber-count side ensures real reactive workload, not just
 * total churn.
 */
interface AdaptThresholds {
    /**
     * Per-node-cost axis trigger — node count above which the per-node
     * commit cost on linear-chain shape is measurably above the V8
     * floor. Default `50_000` per the #694 / PR #1033 crossover-curve
     * sweep.
     */
    readonly nodeCount: number;
    /**
     * Chain-shape axis trigger — max derivation-chain depth above which
     * derivation walking dominates per-commit cost. Default `500`,
     * unchanged from the original issue-body design.
     */
    readonly maxChainDepth: number;
    /**
     * Per-commit-cost axis trigger — median commit time (ms) above
     * which the per-commit envelope cost (commitLog + changedNodes +
     * replay-determinism contracts) is large enough that the WASM
     * backend's projected ~0.7 ms/commit savings amortizes against the
     * one-time migration cost within ~640 commits. Default `1.0`,
     * anchored to the `equality-cutoff × 10000` macro cell (see
     * module-level @remarks for the caveat).
     */
    readonly medianCommitMsThreshold: number;
    /**
     * Window length (in commits) over which {@link medianCommitMsThreshold}
     * is evaluated. Default `100` — long enough to wash out single-
     * commit spikes, short enough to detect a genuine shift in commit
     * shape within a few seconds of UI activity.
     */
    readonly rollingCommitWindow: number;
    /**
     * Activity-gate trigger — minimum commit count for the
     * commit-shape axis to count as a stable workload signal. Default
     * `500`, derived from the cheap-bridge break-even math (~450 ms
     * migration cost / ~0.7 ms-per-commit savings ≈ 640 commits;
     * rounded down so the gate fires earlier on commit-heavy shapes).
     */
    readonly commitCount: number;
    /**
     * Activity-gate trigger — minimum total subscriber count for the
     * commit-shape axis to count as a real reactive workload. Default
     * `1_000`, unchanged from the issue body.
     */
    readonly totalSubscribers: number;
}
/**
 * Post-#1033 / #1006 measurement-anchored defaults.
 *
 * @remarks
 * Frozen so a consumer cannot mutate the shared snapshot — per-engine
 * overrides flow through `createCausl({ adaptThresholds })` (when the
 * wiring lands in #687) and produce a new frozen object via
 * {@link mergeThresholds}.
 *
 * **These are starting values, not final.** They are calibrated
 * against panel projections and one shape-specific bench cell; they
 * will be regenerated empirically once the real WASM backend lands
 * (#685 / #687) per the #694 sweep methodology.
 */
declare const DEFAULT_THRESHOLDS: AdaptThresholds;
/**
 * The pure auto-adapt decision predicate.
 *
 * @param stats - The current commit's `EngineTelemetry`-shaped
 *   snapshot. Read-only; the predicate does not mutate.
 * @param thresholds - The merged threshold object for the active
 *   engine instance (typically {@link DEFAULT_THRESHOLDS} merged with
 *   per-engine and env-var overrides).
 * @param history - Snapshots from prior commits, oldest first. The
 *   predicate inspects only the tail (the last
 *   {@link HYSTERESIS_TRIP_COUNT} entries for the consecutive-trip
 *   gate, plus the full sequence for the node-count EWMA gate).
 * @param commitTimings - Optional rolling window of recent per-commit
 *   wall-times (ms), oldest first. This is the **#1048 / Option B**
 *   surface for the commit-shape axis: the auto-adapt wrapper's
 *   `commit()` shim (landing later when `createCausl({ backend:
 *   'auto' })` integration ships per #685 / #687) records
 *   `performance.now() - commitStart` after each commit and passes a
 *   bounded slice (length ≤ `thresholds.rollingCommitWindow`, default
 *   100) into this parameter. When `commitTimings.length > 0` its
 *   median takes precedence over `stats.medianCommitMs` (which remains
 *   accepted for backends that pre-compute the median internally —
 *   e.g. a future WASM backend that surfaces it directly via
 *   {@link EngineTelemetry}). Default `[]` for callers that have not
 *   yet wired the wrapper, in which case the commit-shape axis
 *   falls back to `stats.medianCommitMs ?? 0` and degrades cleanly to
 *   the pre-#1048 behaviour.
 * @returns `true` iff the active backend SHOULD migrate to the WASM
 *   engine on the next commit boundary; `false` otherwise.
 *
 * @remarks
 * The body is two gates AND'd:
 *
 * 1. **Consecutive-trip gate**: the multi-axis OR (see
 *    {@link AdaptThresholds}) must fire on each of the last
 *    {@link HYSTERESIS_TRIP_COUNT} commits — the current `stats` plus
 *    the `HYSTERESIS_TRIP_COUNT - 1` most recent entries in
 *    `history`. With fewer than 3 historical snapshots the predicate
 *    short-circuits to `false`.
 *
 * 2. **EWMA gate**: the EWMA of `inputs + deriveds` (alpha=0.1) over
 *    the entire history (with `stats` appended as the newest
 *    observation) must exceed `thresholds.nodeCount`. This is the
 *    spike-rejection band — a single 60k-node commit followed by a
 *    30k-node steady state has consecutive-trip count 1 and EWMA
 *    well below 50k, so it does not migrate.
 *
 * Pure: no I/O, no clock reads, no `process.env`. The success path
 * allocates one array slice for the consecutive-trip window and (when
 * `commitTimings` is non-empty) one slice-and-sort for the median —
 * still O(n log n) on a bounded window of typically 100. Safe to call
 * from `commit()` once the wiring lands in #687.
 *
 * The wrapper-side capture of `commitTimings` (the actual `commit()`
 * shim that records `performance.now() - commitStart` and bounds the
 * ring) is intentionally deferred to the integration PR that ships
 * `createCausl({ backend: 'auto' })` per #685 / #687. This module
 * lands the decision-side signature only; the production capture
 * lives in the wrapper layer alongside the backend-selection state.
 */
declare function shouldMigrate(stats: GraphStats, thresholds: AdaptThresholds, history: ReadonlyArray<GraphStats>, commitTimings?: ReadonlyArray<number>): boolean;

/**
 * @packageDocumentation
 *
 * Cross-backend engine telemetry contract (#696, sub-task of #680).
 *
 * @remarks
 * The {@link EngineTelemetry} interface defined here is the **single
 * source of truth** for the snapshot shape returned by
 * {@link Graph.stats}. Both engine backends — the canonical TS engine
 * (`packages/core/src/graph.ts`) and the future WASM-backed engine
 * (`#680` epic) — MUST surface a record matching this shape, so devtools,
 * bench leak gates, and audit harnesses can diff two snapshots without
 * branching on backend identity.
 *
 * Why a dedicated module rather than a row in `types.ts`:
 *
 * - **Cross-backend contract.** The WASM backend (#681 BackendEngine
 *   refactor + the `engine-rs-core` Rust crate from #682) does not own
 *   `Graph` shape, but it does owe a `stats()`-equivalent
 *   `BackendEngine.telemetry()` method whose return shape must be
 *   byte-equal to the TS engine's. Hosting the contract in a leaf
 *   module lets the Rust ↔ JS bridge import the type without dragging
 *   the rest of the public Graph surface through `wasm-bindgen` /
 *   `serde-wasm-bindgen` codegen.
 *
 * - **Audit visibility.** A dedicated file makes the telemetry surface
 *   the kind of thing reviewers can spot in a `grep "EngineTelemetry"`
 *   pass; in `types.ts` it lived alongside the `Graph` interface and
 *   was easy to miss.
 *
 * - **Documentation locality.** Each field's audit-relevant
 *   collection or counter lives next to its description; future
 *   widenings land at the tail of {@link EngineTelemetry} with a
 *   matching JSDoc paragraph in this file.
 *
 * Field-evolution discipline: the existing field names listed on
 * {@link EngineTelemetry} are part of the public contract for devtools
 * and bench leak gates. Future audit-driven widenings MUST land at the
 * tail of the object (append-only) and MUST surface the same field on
 * both backends. Renames or removals are SPEC-level breaking changes
 * (#695 audit; PR-level "any new property addition is a SPEC change").
 *
 * @see Graph.stats — the public method that produces an
 *   {@link EngineTelemetry} snapshot.
 * @see #680 — the WASM-engine epic that motivates the cross-backend
 *   contract.
 * @see #696 — this issue.
 * @see #757 — the JS-side first cut (the `subscribersTotal`,
 *   `subscribersByNodeKeys`, `commitObservers`, `commitMetadataDeriveds`,
 *   `commitLogConsumerCount`, `entries`, `retainedCommits` row).
 */

/**
 * Engine-wide retained-state telemetry surface — the cross-backend
 * snapshot shape produced by {@link Graph.stats}.
 *
 * @remarks
 * Each field is a snapshot count of an engine-internal collection or
 * scalar at the moment the producing `stats()` call was made. The shape
 * is intentionally flat — one counter per audit-relevant collection — so
 * devtools consumers and bench leak gates can diff two records by field
 * rather than walk a tree. All counts are non-negative integers; the
 * `lastCommitTime` field is a {@link GraphTime}.
 *
 * The fields map onto graph-internal state as follows:
 *
 * **Node-cardinality counters (#696):**
 * - `inputs` — count of user-registered input nodes (excludes the
 *   engine-owned `commitLog` derived).
 * - `deriveds` — count of user-registered derived nodes (plain
 *   `derived(...)`, `liveDerived(...)`, and `commitMetadataDerived(...)`;
 *   excludes the engine-owned `commitLog` derived).
 *
 * **Subscription counters (#757 first cut + #696 transient breakdown):**
 * - `subscribersTotal` — size of the flat per-node `subscriptions` Set
 *   (one entry per live `subscribe(node, observer)` registration; each
 *   member of a `subscribeMany(...)` group contributes one entry).
 * - `subscribersByNodeKeys` — size of the per-node subscriber index Map
 *   (i.e., the number of distinct nodes with at least one live
 *   per-node subscription).
 * - `transientSubscribers` — count of live `subscribe(...)` /
 *   `subscribeMany(...)` registrations whose `options.transient === true`
 *   slot is set. A transient observer auto-disposes after its first
 *   Phase G fire (#766); this counter is the number of such registrations
 *   *not yet* fired (and therefore still pinned in `subscriptions`).
 *   On a steady-state graph this is almost always 0; a non-zero residual
 *   between commit boundaries means a transient registration is waiting
 *   for its first non-initial fire.
 * - `commitObservers` — size of the `subscribeCommits` listener Set
 *   (one entry per live `subscribeCommits(observer)` registration;
 *   commit-bus observers are NOT counted in `subscribersTotal`).
 *
 * **Engine-internal index counters:**
 * - `commitMetadataDeriveds` — size of the registered
 *   `commitMetadataDerived` id Set (#452 Phase F.5 seed set).
 * - `commitLogConsumerCount` — current value of the consumer counter
 *   that gates Phase F.4 commit-log refresh under
 *   `commitHistoryCap > 0` (#715).
 * - `entries` — size of the canonical id → entry Map (registered nodes
 *   including the engine-owned `commitLog` derived; for user-only
 *   counts use `inputs + deriveds`).
 *
 * **Commit-history counters (#696):**
 * - `lastCommitTime` — current {@link GraphTime}; equals 0 at engine
 *   genesis and advances by exactly 1 per successfully published
 *   commit. A failed commit leaves this byte-identical to its
 *   pre-commit value (atomicity rollback). Useful as the "did anything
 *   commit between snapshots?" predicate (`after.lastCommitTime !==
 *   before.lastCommitTime`).
 * - `retainedCommits` — current length of the bounded `commitHistory`
 *   ring (capped by `commitHistoryCap`; 0 when the engine was
 *   constructed with `commitHistoryCap: 0`, the post-#778 default).
 *
 * **Optional engine-status counters (audit-flagged, host-dependent):**
 * - `deopts` — count of V8 deoptimisations attributed to the engine
 *   since construction. `undefined` when the host backend cannot
 *   surface this counter at runtime (the canonical TS engine does not
 *   wire `--trace-deopt` into its retained state; the bench harness
 *   captures this externally — see
 *   `packages/bench/report/engine-status-deopts/SUMMARY.md`). Future
 *   host-supported paths (e.g. a worker-side `--trace-deopt` adapter)
 *   may populate the field; the contract guarantees the *field name*,
 *   not its presence on every backend.
 * - `gcPauses` — count of GC pause events attributed to the engine
 *   since construction. `undefined` on the canonical TS engine for
 *   the same host-dependence reason as `deopts`. The WASM backend
 *   does not run inside a JS GC and SHOULD report `gcPauses: 0`
 *   (linear-memory allocation is bump-pointer; "pauses" is not a
 *   Rust-side concept).
 *
 * @example Diffing two snapshots
 * ```ts
 * const before = graph.stats()
 * await runAdopterCode(graph)
 * const after = graph.stats()
 * if (after.subscribersTotal !== before.subscribersTotal) {
 *   throw new Error('subscriber leak across boundary')
 * }
 * ```
 *
 * @example Cross-backend parity assertion
 * ```ts
 * // Engine-status integration: the cross-backend determinism gate
 * // asserts that for the same workload trace the TS and WASM
 * // backends produce byte-equal `inputs`, `deriveds`, and
 * // `lastCommitTime` (the snapshot fields a host-independent
 * // workload determines). `subscribersTotal` is similarly equal
 * // because subscription counts are caller-driven, not host-driven.
 * expect(tsEngine.stats().inputs).toBe(wasmEngine.stats().inputs)
 * expect(tsEngine.stats().lastCommitTime).toBe(wasmEngine.stats().lastCommitTime)
 * ```
 */
interface EngineTelemetry {
    /**
     * Count of user-registered input nodes — excludes the engine-owned
     * `commitLog` derived. Maintained as a running counter; bumps on
     * `graph.input(...)` and decrements on `dispose(graph, inputNode)`
     * via `@causl/core/internal`.
     */
    readonly inputs: number;
    /**
     * Count of user-registered derived nodes — plain `derived(...)`,
     * `liveDerived(...)` (devtools), and `commitMetadataDerived(...)`.
     * Excludes the engine-owned `commitLog` derived (whose presence is
     * an engine-implementation detail; counting it would tear the
     * "user-registered nodes" semantics this counter advertises).
     */
    readonly deriveds: number;
    /** Total count of live `subscribe(node, observer)` registrations. */
    readonly subscribersTotal: number;
    /** Number of distinct nodes with at least one live subscriber. */
    readonly subscribersByNodeKeys: number;
    /**
     * Count of live `subscribe(...)` / `subscribeMany(...)` registrations
     * with `options.transient === true` (#766 transient auto-dispose).
     * A non-zero value between commit boundaries indicates transient
     * observers waiting for their first non-initial Phase G fire.
     */
    readonly transientSubscribers: number;
    /** Count of live `subscribeCommits(observer)` registrations. */
    readonly commitObservers: number;
    /** Count of registered `commitMetadataDerived` nodes. */
    readonly commitMetadataDeriveds: number;
    /** Count of consumers gating Phase F.4 commit-log refresh. */
    readonly commitLogConsumerCount: number;
    /**
     * Size of the engine's id → entry registry. Includes the
     * engine-owned `commitLog` derived; for user-only node counts use
     * `inputs + deriveds`.
     */
    readonly entries: number;
    /**
     * GraphTime of the most recently published commit (0 at engine
     * genesis; advances by exactly 1 per successful `commit(...)`).
     * Failed commits leave this byte-identical to its pre-commit value.
     */
    readonly lastCommitTime: GraphTime;
    /** Current length of the bounded commit-history ring. */
    readonly retainedCommits: number;
    /**
     * Count of V8 deoptimisations attributed to the engine since
     * construction, when the host backend can surface it; `undefined`
     * otherwise. The canonical TS engine does not wire `--trace-deopt`
     * into runtime state and reports `undefined`. See
     * `packages/bench/report/engine-status-deopts/SUMMARY.md` for the
     * external-capture path.
     */
    readonly deopts?: number | undefined;
    /**
     * Count of GC pause events attributed to the engine since
     * construction, when the host backend can surface it; `undefined`
     * otherwise. The canonical TS engine reports `undefined` for the
     * same host-dependence reason as {@link EngineTelemetry.deopts}.
     * The WASM backend SHOULD report `0` (linear-memory bump-pointer
     * allocation has no GC pauses).
     */
    readonly gcPauses?: number | undefined;
    /**
     * Auto-adapt migration payback counter (#1072).
     *
     * @remarks
     * Only populated by `createCausl({ backend: 'auto' })`'s wrapper —
     * `undefined` on the canonical TS engine and on the (synchronous)
     * Phase-1 WASM backend. Semantics:
     *
     * - `undefined` — the wrapper has not yet migrated (still on the
     *   TS backend).
     * - `N > 0` — the wrapper migrated `commitCount`-threshold
     *   commits ago and is still amortising the migration cost.
     *   Decrements by 1 on every successful commit.
     * - `0` — payback complete; the migration has earned back its
     *   one-time cost per the post-#1006 break-even math (~640
     *   commits at 0.7 ms/commit projected savings vs. ~450 ms
     *   migration cost). The wrapper emits this as the "payback"
     *   telemetry event by transitioning from a positive integer to
     *   zero; adopters who subscribed to {@link Graph.subscribeCommits}
     *   poll `stats.migrationPaybackCommits` to detect the transition.
     *
     * The field is at the tail of the object (append-only) per the
     * cross-backend telemetry contract — adopters that diff two
     * snapshots can branch on `before.migrationPaybackCommits !==
     * after.migrationPaybackCommits` without breaking on TS-engine
     * snapshots where both sides are `undefined`.
     */
    readonly migrationPaybackCommits?: number | undefined;
    /**
     * Per-node version counter (#1242, SPEC §15.1).
     *
     * @remarks
     * Returns the monotonically-increasing counter for how many commits
     * the given node has appeared in `Commit.changedNodes`. The counter
     * advances by exactly 1 each time the node's value changed in a
     * commit (per SPEC §15.1 / #1129 semantics: change =
     * `!Object.is(prevValue, nextValue)`); it advances by 0 on a
     * commit where the node's value did not change (no-op commit,
     * equality-cutoff path, sibling-shape isolation). The initial value
     * (before any commit changes the node) is implementation-defined;
     * the canonical TS engine returns `0` for a never-changed node,
     * including nodes the engine has never seen.
     *
     * The accessor is the load-bearing memoisation surface for adopters
     * who can no longer rely on `read()` reference identity (H1 hazard,
     * fixed in PR #1245). Memoise on `engine.stats().nodeVersion(node)`
     * and downstream caches invalidate iff the node's value actually
     * changed — a no-op commit will not bump the counter and so will
     * not invalidate the cache.
     *
     * Cross-backend contract: `nodeVersion(node)` MUST be byte-identical
     * across the canonical TS engine and the Phase-1 WasmBackend wrapper
     * for the same commit sequence, because `nodeVersion` is a pure
     * derivation of `Commit.changedNodes`, which is already pinned
     * byte-identically by the determinism gate (#1059 / PR #1107).
     *
     * Disposed-node semantics (#1164 generational NodeId): a disposed
     * node's counter is reset. If the slot is reused with a new
     * generation, the new node starts at counter 0.
     *
     * @param node - Any handle reachable through the engine's public
     *   surface — input, derived, or commit-metadata derived.
     * @returns The number of commits in which `node.id` has appeared in
     *   `commit.changedNodes` over this engine's lifetime; `0` if the
     *   node has never changed (or has never been seen).
     *
     * @example Cache key for adopter-side memoisation
     * ```ts
     * const v = engine.stats().nodeVersion(node)
     * if (v !== prevVersion) {
     *   // The node's value changed; recompute the memoised projection.
     *   cache.set(node.id, project(engine.read(node)))
     *   prevVersion = v
     * }
     * ```
     */
    nodeVersion(node: Node<unknown>): number;
}

/**
 * @packageDocumentation
 *
 * Engine-level feature-flag protocol (#706b).
 *
 * Centralises the engine's `CAUSL_*` environment-variable parsing into a
 * single module loaded once at startup, so that hot paths in
 * {@link createCausl | graph.ts} and {@link ./internal-dispatch.ts}
 * pay the env-lookup cost exactly once per process rather than on every
 * commit, derivation walk, or explanation frame allocation.
 *
 * @remarks
 * The design follows three rules:
 *
 * 1. **Read once at module load.** {@link MODULE_FLAGS} is the frozen
 *    snapshot of {@link loadFlagsFromEnv} captured the first time this
 *    module is imported. Subsequent reads of `process.env` by the engine
 *    are forbidden — every flag-driven branch points at this snapshot.
 *    That is the design contract that keeps the per-commit hot path free
 *    of `process.env` lookups.
 *
 * 2. **Engine-instance overrides via `experimentalFlags`.**
 *    {@link createCausl}'s options accept `experimentalFlags?:
 *    Partial<CauslFlags>` so a single test or a single embedded engine
 *    instance can flip a flag without mutating the process-wide env.
 *    The construction-time merge is `{...MODULE_FLAGS, ...overrides}`.
 *
 * 3. **One source of truth per flag.** A consumer module imports either
 *    {@link MODULE_FLAGS} (for module-scope constants) or the merged
 *    flags object captured by `createCausl` (for engine-instance scope).
 *    The same flag is never re-parsed inline elsewhere.
 *
 * The current surface lists exactly one flag — {@link
 * CauslFlags.freezeOffInProd} — because that is the only consumer that
 * has shipped (PR #732 / #702). Additional flags are added when their
 * consumer ships, not preemptively.
 */
/**
 * Engine-level feature flags surfaced through `CAUSL_*` env vars
 * and `createCausl({ experimentalFlags })`.
 *
 * @remarks
 * Every field on this interface is a deliberate, audit-tracked opt-in
 * that gates a measured engine behaviour. Fields are added here only
 * when a consumer module ships that needs them; the bar mirrors the
 * one defended on {@link CreateCauslOptions}: name the unavoidable
 * concept the engine cannot express without the flag, or take the
 * teaching cost of growing every README and every consumer's mental
 * model.
 */
interface CauslFlags {
    /**
     * Skip engine-internal defensive freezes on inner arrays nested
     * inside frozen Commit / Explanation payloads (#702). Public-surface
     * Commit / Explanation objects stay frozen at the outer boundary
     * unconditionally; this flag controls only the inner defensive
     * `Object.freeze` calls on `changedNodes` and `deps`.
     *
     * @remarks
     * Driven by env var `CAUSL_FREEZE_OFF_IN_PROD`. The flag is `true`
     * iff the env value is exactly `'1'`. Adopters who set it accept
     * that the engine will not freeze the inner arrays — those values
     * are still readable like any other JS value, but they are not
     * runtime-immutable.
     *
     * Audit verdict (#702): land as opt-in measurement only; flip the
     * default only if the measured drop on `scrolling-viewport × 10000`
     * AND `batch-commit × 10000` is ≥ 10%. Until then this stays a
     * deliberate opt-in for adopters running with their own
     * immutability discipline.
     */
    readonly freezeOffInProd: boolean;
    /**
     * Enable the SPEC §15.1 NonDeterministicComputeError invariant
     * gate (#750). When on, every derived `compute(get)` is re-invoked
     * a second time against the same dependency snapshot; if the
     * second call's result `!Object.is` the first, the engine throws
     * a {@link NonDeterministicComputeError} naming the offending node.
     *
     * @remarks
     * Driven by env var `CAUSL_ASSERT_DETERMINISTIC_COMPUTE`. The flag
     * is `true` iff the env value is exactly `'1'`; truthy-coercion
     * vectors (`'true'`, `'yes'`, …) leave the flag at `false`.
     *
     * Default `false` because re-running every `compute()` doubles
     * derivation work — the gate is useful only in dev / test / CI
     * environments where the cost is acceptable as the price of a
     * structural invariant check. Production runs leave the flag off
     * and pay zero overhead.
     *
     * The audit's adversarial-fanin scenario (#718) injects 0.1%
     * `Math.random()` returns and asks the engine to detect them via
     * a NonDeterministicComputeError thrown at commit time; this flag
     * is the seam that gates the detection at construction time so
     * adopters opt into the cost only when they want the guarantee.
     */
    readonly assertDeterministicCompute: boolean;
}

/**
 * Stable identifier for a node within a single graph instance.
 *
 * @remarks
 * Caller-supplied; uniqueness is enforced by the engine
 * ({@link DuplicateNodeError}). The identifier namespace belongs to
 * the user's information model — names like `cell:wb1:Sheet1:A1` or
 * `asset:property-1:HVAC-3` — and must not be mixed with editor-
 * controller identifiers like `controller:gridSelection:wb1`. That
 * separation is non-negotiable: keeping selected ranges and asset
 * locations in different identifier namespaces is what makes the
 * engine teachable.
 */
type NodeId = string;
/**
 * Discrete moment in a graph's history.
 *
 * @remarks
 * Monotonically increasing across commits. A `Behavior a` is, by
 * definition, a function `GraphTime → a`; this type is the domain.
 * `commit` is the only operation that advances the value, by exactly
 * one — there is no fractional time, and no API by which time can
 * advance any other way.
 */
type GraphTime = number;
declare const _NODE_BRAND_TAG: unique symbol;
/**
 * Internal phantom-tag type used to brand {@link Node} descriptors.
 *
 * @internal
 */
type NodeBrandTag = typeof _NODE_BRAND_TAG;
/**
 * Phantom-branded node descriptors. The runtime universe is exactly
 * two kinds — a writable Behavior (`InputNode`) and a Behavior
 * computed from other Behaviors (`DerivedNode`) — and the engine
 * deliberately does not carry a `kind` discriminator on the public
 * type. A node is its `compute` (or the lack of one); the
 * input/derived distinction is a denotational property of the
 * engine, not an observable tag on the value. The previous draft
 * threaded eleven NodeKind values through every consumer; collapsing
 * to two and refusing to ship the discriminator is what keeps the
 * runnable concept count down to single digits.
 *
 * The `_phantom` brand carries the type parameter for inference and
 * has no runtime existence (declared as a never-present field).
 * Runtime detection of input-ness happens inside the engine via the
 * {@link Graph} entry table, not by branching on a public field.
 */
/**
 * Handle to a writable Behavior — an `input` node.
 *
 * @typeParam T - Value type carried by the input.
 *
 * @remarks
 * Created via {@link Graph.input}. Realises the writable Behavior
 * primitive: `input(initial) : Behavior a where input(t₀) = initial`.
 * The handle becomes a write target for `tx.set` inside a commit
 * and a read target for `read`/`subscribe`/`explain` outside one.
 */
interface InputNode<T> {
    /** Stable identifier. */
    readonly id: NodeId;
    /**
     * Phantom brand carrying the value type AND the input/derived
     * polarity for type-system narrowing. Never present at runtime —
     * `_phantom` is `undefined` on every value the engine produces.
     * Polarity is encoded in the `tag` field type so the public
     * `Node<T>` union remains structural while still type-discriminable
     * at the call sites that need it (e.g. `Tx.set`).
     */
    readonly _phantom?: {
        readonly value: T;
        readonly tag: NodeBrandTag;
        readonly polarity: 'input';
    };
}
/**
 * Handle to a composed Behavior — a `derived` node.
 *
 * @typeParam T - Value type produced by the compute function.
 *
 * @remarks
 * Created via {@link Graph.derived}. Realises the composed Behavior
 * primitive: `derived(f, b₁, …, bₙ) : Behavior a where derived(t) =
 * f(b₁(t), …, bₙ(t))`. Dependencies are captured by ref-counting
 * `get()` calls inside `f` rather than declared up front, which lets
 * conditional reads track input-set changes naturally.
 */
interface DerivedNode<T> {
    /** Stable identifier. */
    readonly id: NodeId;
    /**
     * Phantom brand carrying the value type and derived polarity.
     * Never present at runtime; the polarity is type-system-only and
     * is not observable on a constructed handle (the engine constructs
     * handles via `Object.freeze({ id })` with no `_phantom` field).
     */
    readonly _phantom?: {
        readonly value: T;
        readonly tag: NodeBrandTag;
        readonly polarity: 'derived';
    };
}
/**
 * Tagged union over the two node kinds the engine recognises. Both
 * variants are structurally `{ readonly id: NodeId }` at runtime;
 * the `_phantom` brand provides type-level narrowing without leaking
 * a discriminator onto the value. Everything else previous drafts
 * called a "kind" (`formula`, `selector`, `constraint`, `resource`,
 * `effect`, `conflict`, `collection`, `index`, `workflow`) is a
 * *role* a node can play, not a kind it permanently is — a
 * `formula` is just a `derived` whose compute happens to interpret
 * an expression string, a `constraint` is a `derived` returning a
 * validation result, an `effect` is not a node at all but a post-
 * commit subscription.
 *
 * @typeParam T - Value type carried by the node.
 */
type Node<T> = InputNode<T> | DerivedNode<T>;
/**
 * Compute closure for a derived node.
 *
 * @typeParam T - Value type produced by the closure.
 *
 * @remarks
 * Receives a tracked `get` accessor; the engine records every node
 * read through `get` as a dependency edge for the current evaluation.
 * Conditional reads are tracked dynamically — a derivation that
 * switches inputs based on an `if` branch must leave no orphan
 * dependency listening on a node it no longer reads. The type
 * system cannot see across `if`-branches inside a `derived` body, so
 * dynamic-dependency cleanup is enforced as a property-based fuzz
 * gate: random derivations that switch inputs based on conditional
 * reads, followed by random commits, must leave no orphan dep.
 */
type Compute<T> = (get: <U>(node: Node<U>) => U) => T;
/**
 * Disposer returned by subscription methods on {@link Graph}.
 *
 * @remarks
 * Calling it detaches the observer; idempotent — repeated invocations
 * are harmless.
 */
type Unsubscribe = () => void;
/**
 * Per-node observer callback.
 *
 * @typeParam T - Value type of the observed node.
 * @param value - The node's value at `time`.
 * @param time - GraphTime at which the value was emitted.
 */
type Observer<T> = (value: T, time: GraphTime) => void;
/**
 * Optional knobs accepted by {@link Graph.subscribe} and
 * {@link Graph.subscribeMany} (#766).
 *
 * @remarks
 * The bar for adding a field here is the same as for adding a public
 * method on {@link Graph}: name an unavoidable concept the engine
 * cannot express without it. `transient` clears that bar — adopters
 * routinely want a "fire once then unmount" observer to react to a
 * one-shot derived signal (e.g. SSR-hydrate completion, a
 * `commitMetadataDerived` that publishes "the just-completed commit
 * is the one I was waiting for") without leaking a manual
 * `unsubscribe()` into every consumer call site. The engine drops a
 * transient observer at the end of the same commit pass that fired
 * it, so subsequent commits never see it again.
 */
interface SubscribeOptions {
    /**
     * When `true`, the observer is registered as a one-shot: the engine
     * fires it on the first commit whose Phase G dispatch passes the
     * usual `Object.is` equality cutoff for the observed node, then
     * auto-disposes the registration before the commit returns. A
     * subsequent commit on the same graph never sees the observer
     * again.
     *
     * @remarks
     * Subtleties:
     *
     * - If the registration's value never changes, the observer never
     *   fires and the registration is never auto-disposed. `transient`
     *   is "fire at most once," not "exists for at most one commit." A
     *   caller that needs the latter constructs a normal subscription
     *   and unsubscribes from inside the observer.
     * - The synchronous initial fire from {@link Graph.subscribe} does
     *   NOT count as the transient observer's fire — initial fire is
     *   always synchronous from the call to `subscribe`, and its purpose
     *   is to surface the current value to the new observer, not to
     *   satisfy the one-shot contract. The engine treats the initial
     *   fire as bookkeeping (`hasFired` flips), and the auto-dispose
     *   trigger is the next Phase G fire.
     * - On {@link Graph.subscribeMany}, transient applies to the whole
     *   group: the observer fires on the first commit during which any
     *   of the registered nodes' values changed, and the entire group
     *   is dropped at the end of that commit.
     *
     * Defaults to `false` — the engine retains the registration across
     * commits as the canonical {@link Graph.subscribe} contract requires.
     */
    readonly transient?: boolean;
}
/**
 * Maps a tuple of {@link Node} handles to the tuple of value types
 * they carry — the inverse of `Node<T>` over a tuple. Powers the
 * observer signature for {@link Graph.subscribeMany}: an observer
 * registered for `[Node<number>, Node<string>, Node<boolean>]`
 * receives `[number, string, boolean]` at fire-time.
 *
 * @typeParam Ts - Tuple of `Node<T>` handles.
 *
 * @remarks
 * Implemented as a recursive mapped type rather than `infer`-based
 * because the latter is brittle under `readonly` tuples. The shape
 * preserves the input tuple's positions, so call sites get the same
 * tuple back as a value-type tuple — no name-based lookup, no
 * dictionary intermediate.
 */
type ValueMap<Ts extends readonly Node<unknown>[]> = {
    readonly [K in keyof Ts]: Ts[K] extends Node<infer V> ? V : never;
};
/**
 * Per-projection observer callback for {@link Graph.subscribeReads}
 * (#701, SPEC §11.1 amended).
 *
 * @typeParam T - Value type produced by the projection closure.
 * @param commit - The just-published {@link Commit} whose
 *   `changedNodes` intersected the projection's recorded read-set.
 * @param value - The projection re-evaluated under the engine's
 *   tracking accessor at fire-time, so observers see the post-commit
 *   value without needing to call {@link Graph.read} themselves.
 */
type SubscribeReadsObserver<T> = (commit: Commit, value: T) => void;
/**
 * Record describing a single committed event.
 *
 * @remarks
 * Returned from {@link Graph.commit} and broadcast to commit
 * subscribers. The commit log itself is exposed as a `Behavior
 * [Commit]` via {@link Graph.commitLog} — queryable by the same
 * `read`/`subscribe`/`explain` API as any other graph value, which
 * is the engine's promise that "a non-programmer can change a
 * formula in a cell and see the world recompute *now*" turned into
 * an inspection primitive rather than a separate devtools system.
 */
interface Commit {
    /** GraphTime assigned to this commit. */
    readonly time: GraphTime;
    /** Caller-supplied label passed to `graph.commit(intent, …)`. */
    readonly intent: string;
    /** Identifiers of nodes whose value changed during the commit. */
    readonly changedNodes: readonly NodeId[];
    /**
     * For commits produced by {@link Graph.hydrate}, the GraphTime
     * carried by the originating snapshot envelope. `undefined` on
     * `graph.commit(...)`-issued records. The engine clock advances by
     * exactly one tick per hydrate (the §3 monotonicity invariant); this
     * field preserves the on-the-wire snapshot label so persistence and
     * devtools consumers can still answer "this commit replays a server
     * snapshot from t=N" without inspecting `intent` strings.
     *
     * Always-set per #703 Win 5 / #760 (monomorphize hidden classes);
     * the explicit `| undefined` admits the no-tag case via explicit
     * undefined under `exactOptionalPropertyTypes`, so regular and
     * hydrate commits share the same V8 hidden class. Consumers can
     * still branch on `c.originatedAt !== undefined` to distinguish
     * the two — runtime behaviour is unchanged.
     */
    readonly originatedAt: GraphTime | undefined;
}
/**
 * Transaction handle scoped to a single `commit` callback.
 *
 * @remarks
 * The only mutation entry-point on the graph. Outside a commit the
 * graph is read-only; inside a commit reads see staged writes,
 * outside reads see the previous committed snapshot. There is no
 * "concurrent mutation" question because there is no concurrent
 * mutation API — the absence of the construct is what catches the
 * concurrent-engine-mutations race class. The handle becomes invalid
 * the moment its callback returns ({@link StaleTxError}).
 */
interface Tx {
    /**
     * Stage a new value for an input node.
     *
     * @typeParam T - Value type of the target input.
     * @param node - Input node to write.
     * @param value - New value, applied atomically with all other
     *   `set` calls in the same commit. Multiple `set` calls in one
     *   commit land at the same `GraphTime` — one transaction creates
     *   exactly one new `t`, never a fractional moment.
     * @throws {@link NotAnInputNodeError} when `node` is a derived node.
     * @throws {@link StaleTxError} when the handle has escaped its commit.
     */
    set<T>(node: InputNode<T>, value: T): void;
}
/**
 * Result returned by {@link Graph.simulate} — the §5 dry-run API.
 *
 * @remarks
 * §5 names exactly three commit-mode shapes — `strict`, `with-conflicts`,
 * and a separate `graph.simulate(...)` API for dry-run. `simulate`
 * answers the question "what *would* happen if I ran this transaction?"
 * without ever advancing {@link Graph.now}, appending to the commit log,
 * or firing any subscriber. After return, engine state is byte-identical
 * to the pre-call moment — the dry-run is observer-invisible.
 *
 * The discriminator splits two arms:
 *
 * - `'clean'` — the simulated transaction would have committed
 *   successfully. {@link SimulateResultClean.commit} is the {@link Commit}
 *   record that *would* have been published, with the GraphTime it
 *   *would* have landed at; {@link SimulateResultClean.stagedDiff}
 *   carries only the input ids whose value the staged write would have
 *   changed; {@link SimulateResultClean.derivedDiff} carries only the
 *   transitively-affected derived ids whose recomputed value would have
 *   differed. Their union is byte-equal to `commit.changedNodes` (modulo
 *   the engine-owned `commitLog` node, which `simulate` does not touch
 *   and therefore does not include).
 * - `'failed'` — the simulated transaction would have thrown. The typed
 *   error that would have escaped `commit` is surfaced on
 *   {@link SimulateResultFailed.error} instead, so the caller can branch
 *   on `instanceof CycleError` / `NotAnInputNodeError` /
 *   `UnknownNodeError` / etc. without a `try/catch`. `stagedDiff`
 *   reports the input ids the user callback staged before the throw —
 *   useful for debugging which write closed the cycle.
 *
 * Re-entrancy: a `simulate` invoked inside an in-flight `commit` (or
 * another `simulate`) throws {@link CommitInProgressError} synchronously
 * — the same contract as nested `commit`. The throw is the one
 * exception to "errors return as part of the result"; nesting is a
 * structural misuse caught by absence-of-API, not a transactional
 * failure mode.
 */
type SimulateResult = SimulateResultClean | SimulateResultFailed;
/**
 * Successful arm of {@link SimulateResult}: the simulated transaction
 * would have committed cleanly.
 */
interface SimulateResultClean {
    /** Discriminator tag. */
    readonly status: 'clean';
    /**
     * The {@link Commit} record the simulated transaction *would* have
     * published. Its `time` is the GraphTime the commit *would* have
     * landed at — exactly `graph.now + 1` at simulate-time — but
     * {@link Graph.now} is unchanged after `simulate` returns.
     */
    readonly commit: Commit;
    /**
     * Input node ids whose value the staged writes would have changed,
     * in iteration order over the user callback's `tx.set` calls. A
     * staged write that lands on the same value as the prior commit
     * (Object.is equality) is omitted, mirroring `commit`'s Phase B.
     */
    readonly stagedDiff: readonly NodeId[];
    /**
     * Transitively-affected derived ids whose recomputed value would
     * have differed from the prior. In topological order over the
     * affected sub-graph, mirroring `commit`'s Phase D.
     */
    readonly derivedDiff: readonly NodeId[];
}
/**
 * Failure arm of {@link SimulateResult}: the simulated transaction
 * would have escaped `commit` with a typed engine error.
 *
 * @remarks
 * The error is one of the structured `CauslError` subclasses —
 * `CycleError`, `NotAnInputNodeError`, `UnknownNodeError`,
 * `NodeDisposedError`, `StaleTxError`, or any other engine-emitted
 * typed error. Caller branches on `instanceof` rather than `try/catch`.
 * A throw out of the user-supplied callback that is *not* a
 * `CauslError` is also surfaced through this arm — `simulate` does
 * not pretend to own the user's exception hierarchy.
 */
interface SimulateResultFailed {
    /** Discriminator tag. */
    readonly status: 'failed';
    /**
     * The error that would have escaped `commit`. Typed `CauslError`
     * subclasses are surfaced as-is so callers can `instanceof` against
     * the canonical taxonomy; non-engine throws from inside the user
     * callback flow through unchanged.
     */
    readonly error: unknown;
    /**
     * Input node ids whose value the staged writes had changed before
     * the throw — useful as a debugging breadcrumb naming the partial
     * write set that closed (for example) a derivation cycle.
     */
    readonly stagedDiff: readonly NodeId[];
}
/**
 * Recursive lineage view for a single node, returned by
 * {@link Graph.explain}.
 *
 * @remarks
 * The engine is inspectable through its own primitives rather than
 * through a side-channel devtools API: `explain(node)` returns
 * *another node* — a derived view of the dependency lineage that can
 * itself be subscribed to, displayed, and drilled into, not a one-
 * shot JSON dump. The discriminator on `via` lets a UI render
 * inputs, derived nodes, hot-swappable `liveDerived` nodes, and the
 * cycle marker without re-traversing engine internals; devtools
 * panels become a UI rendered on top of these primitives, not a
 * parallel system.
 */
type Explanation = InputExplanation | DerivedExplanation | LiveExplanation | CycleExplanation;
/** Frame for one direct dependency, with the dep's own recursive lineage. */
interface DepFrame {
    /** The dep node's id. */
    readonly node: NodeId;
    /** GraphTime at which the dep last produced its current value. */
    readonly contributedAt: GraphTime;
    /** Recursive lineage rooted at the dep. */
    readonly explanation: Explanation;
}
/** Common fields on the value-bearing variants of {@link Explanation}. */
interface ExplanationCommon {
    /** Node whose lineage is being described. */
    readonly node: NodeId;
    /** Current value of the node at {@link computedAt}. */
    readonly value: unknown;
    /** GraphTime at which {@link value} was last produced. */
    readonly computedAt: GraphTime;
    /** Direct dependencies, each with its own recursive lineage. */
    readonly deps: readonly DepFrame[];
}
/** Lineage of an `input` node — always a leaf with `deps: []`. */
interface InputExplanation extends ExplanationCommon {
    readonly via: 'input';
    readonly deps: readonly [];
}
/** Lineage of a vanilla `derived` node. */
interface DerivedExplanation extends ExplanationCommon {
    readonly via: 'derived';
}
/**
 * Lineage of a `liveDerived` node — a derived registered through the
 * devtools hot-swap primitive. Same shape as {@link DerivedExplanation}
 * but tagged so a UI can render the "edit-live" affordance, which is
 * the engine's commitment that one can edit a derivation while it's
 * running and watch the change propagate.
 */
interface LiveExplanation extends ExplanationCommon {
    readonly via: 'live';
}
/**
 * Cycle marker — emitted instead of recursing when explain re-enters
 * a node already on the traversal stack. The engine's structural
 * registration guard rejects cycles, so this is a defensive frame
 * that keeps the walker total under any future relaxation.
 */
interface CycleExplanation {
    readonly via: 'cycle';
    readonly node: NodeId;
    /** The ancestor node id whose subtree this frame would re-enter. */
    readonly cycleBackTo: NodeId;
}
/**
 * Caller-supplied tuning for {@link Graph.exportModel}.
 *
 * @remarks
 * The IR is consumed by `causl-check`, the bounded model checker
 * that lifts runtime race-detection into a CI gate. Hosts cap the
 * IR's commit log to bound the workload the checker faces during
 * replay-determinism enumeration: a recorded commit sequence
 * replayed on a fresh graph must produce a byte-identical model
 * state, and exhaustively exploring that property over an unbounded
 * log would defeat the checker's CI budget.
 */
interface ExportModelOptions {
    /** Cap on number of commits included; defaults to 100. */
    readonly maxCommits?: number;
    /**
     * Whether to attach a bounded call-graph annotation to every
     * exported {@link import('./ir.js').IRCommit}. Defaults to `true`.
     *
     * @remarks
     * When enabled, the exporter walks the synchronous JS call stack at
     * commit-issue time, captures up to `D = 32` frames, and emits them
     * as `IRCommit.callGraph`. Per `SPEC.md` §16.2.1.3, frames beyond
     * the bound are dropped and the `truncatedDeeper` flag is set so
     * consumers can tell partial captures apart from genuinely-shallow
     * stacks. Hosts that cannot afford the stack-trace API cost in
     * production builds set this to `false` — schema-3 IRs with the
     * field absent are still wire-format-valid, the field is optional
     * by design.
     */
    readonly captureCallGraph?: boolean;
}
/**
 * JSON-serialisable engine state — inputs only. Derived nodes
 * recompute from inputs deterministically (`derived(t) = f(b₁(t), …,
 * bₙ(t))` is a function), so they are not part of the on-wire
 * payload — they would be redundant at best and a determinism risk
 * at worst. Schema versioned for forward compatibility.
 */
/**
 * Context object passed to {@link ObserverErrorHandler} when an
 * observer callback throws.
 *
 * @remarks
 * Observer plumbing is a first-class engine primitive, not an
 * afterthought; this record gives error handlers enough information
 * to attribute the failure to a specific subscription path
 * (per-node fire vs. per-commit fire vs. the initial-fire that
 * happens at subscription time).
 */
interface ObserverErrorContext {
    /**
     * Where the error came from.
     *
     * - `node-subscriber` — Phase G per-node observer fire.
     * - `commit-subscriber` — Phase H per-commit observer fire.
     * - `subscribe-initial` — synchronous initial fire from
     *   {@link Graph.subscribe}.
     * - `subscribe-reads-initial` — synchronous initial fire from
     *   {@link Graph.subscribeReads} (#701).
     * - `subscribe-reads` — Phase G per-projection observer fire from
     *   {@link Graph.subscribeReads} (#701).
     * - `subscribe-reads-projection` — projection closure threw during a
     *   Phase G re-run (#701); the registration is preserved and the
     *   recorded read-set is left intact, so the next commit will retry.
     */
    readonly source: 'node-subscriber' | 'commit-subscriber' | 'subscribe-initial' | 'subscribe-reads-initial' | 'subscribe-reads' | 'subscribe-reads-projection';
    /** Node id when source is `node-subscriber` or `subscribe-initial`. */
    readonly nodeId?: NodeId;
    /** GraphTime at which the observer was invoked. */
    readonly time: GraphTime;
}
/**
 * Hook fired when a subscriber throws during observer dispatch.
 *
 * @param error - The thrown value, surfaced as `unknown` per
 *   TypeScript's catch-clause typing.
 * @param context - Attribution metadata for the failed dispatch.
 */
type ObserverErrorHandler = (error: unknown, context: ObserverErrorContext) => void;
/**
 * Result of {@link Graph.readAt}: either the value retained for the
 * requested time, or an `evicted` marker carrying the oldest still-
 * retained time so callers can clamp future requests into the
 * window.
 *
 * @remarks
 * The `Evicted` arm is the engine's honesty about bounded retention.
 * Snapshot history is a ring buffer with a configurable cap; a read
 * for a time that falls outside the window cannot return a value,
 * and dressing that case up as `undefined` or throwing would force
 * every caller to invent the same handling. Returning a
 * discriminated union forces a tag check at the call site, the same
 * pattern used for `Resource` and `Formula` to make impossible
 * states unrepresentable.
 */
type RetentionResult<T> = {
    readonly status: 'retained';
    readonly value: T;
    readonly time: GraphTime;
} | {
    readonly status: 'evicted';
    readonly oldestRetainedTime: GraphTime;
};
/**
 * Options accepted by `createCausl`.
 *
 * @remarks
 * Intentionally minimal — every additional public option is a
 * teaching cost paid by every future user. The bar for adding a
 * field here is the same as for adding a public method: name the
 * unavoidable concept the engine cannot express without it, or take
 * the cost of growing every README and every consumer's mental
 * model.
 */
interface CreateCauslOptions {
    /** Bound on internally-retained commit log; default 1000. */
    readonly commitHistoryCap?: number;
    /**
     * Bound on retained per-commit snapshots used by `readAt(t)` and
     * the DevTools bridge. Default 50. Long-lived processes that don't
     * need history pass `commitHistoryCap: 0` (or `1`) at construction
     * — the bound is the engine's memory-hygiene knob.
     */
    readonly snapshotRetentionCap?: number;
    /**
     * Bound on retained disposed-node tombstones. Default 1000.
     *
     * @remarks
     * Disposal records a tombstone keyed by node id so that subsequent
     * public-surface access surfaces a typed `NodeDisposedError` rather
     * than `UnknownNodeError`. Under churn with **fresh ids each
     * lifecycle** (timestamped keys, `family(uuid())`, generated row ids
     * in a virtualized list), an unbounded tombstone map is a monotonic
     * retention root. The cap is the same shape as `commitHistoryCap`:
     * a FIFO ring on insertion order. Past the cap, very-old tombstones
     * are evicted and their ids fall back to `UnknownNodeError` — the
     * "log rotated" arm — which is acceptable because the typed disposal
     * error is most useful immediately after disposal, not years later.
     */
    readonly disposedTombstoneCap?: number;
    /**
     * Hook fired when an observer (per-node or per-commit) throws.
     * Defaults to `console.error`. Pass a no-op to silence.
     */
    readonly onObserverError?: ObserverErrorHandler;
    /**
     * @deprecated As of #670 / #705 this option is a **no-op**. The
     * pre-#705 strict-cycle gate ran an O(|nodes|) forward DFS at every
     * `derived()` registration to refuse a back-edge before the entry
     * landed; the cost was load-bearing on `linear-chain × 1000`
     * (420 ms median against a 5 ms audit floor) and structurally
     * lethal on `linear-chain × 10000` (V8 stack overflow on the
     * registration recursion). Phase D's augmented Kahn pass now
     * catches the same race-class at first-commit-time without
     * paying the registration-time cost — see SPEC §9.1 row 8 (and
     * its Amendment 1) for the contract. The option remains accepted
     * on `createCausl({ strictCycles })` for one major version so
     * adopter call sites do not have to be edited in lockstep with
     * the gate removal; both `true` and `false` produce identical
     * first-commit-time semantics. A future amendment will remove
     * the surface entirely (semver-major).
     */
    readonly strictCycles?: boolean;
    /**
     * Stable identifier for this graph instance. Surfaced as `graphId`
     * on every IR node and commit in the schema-3 IR
     * (`graph.exportModel()`). Optional — the engine assigns a UUID v4
     * when absent.
     *
     * @remarks
     * Validity rule: must match `/^[A-Za-z0-9_.:-]{1,256}$/`. The engine
     * throws {@link InvalidGraphNameError} at construction if the regex
     * does not match. The character set is the intersection of "safe in
     * JSON", "safe in URL fragments", and "safe in filesystem paths" —
     * the three places adopters have been observed pasting a graphId.
     * The 256-char cap mirrors the §12.2 teaching-cost cap on public
     * surface names.
     *
     * The precedence rule is **application-supplied wins**: a name
     * passed here lands on the IR; absence falls back to a UUID v4 the
     * engine mints once at construction. The field is read-only on the
     * graph instance once construction returns — there is no public
     * mutator and no rebrand operation.
     */
    readonly name?: string;
    /**
     * Engine-instance overrides for the `CAUSL_*` env-var flag protocol
     * (#706). Each field on {@link CauslFlags} can be flipped here for
     * a single engine instance without mutating the process-wide env.
     * Keys not present fall back to the value parsed once at module
     * load from `process.env` (the {@link CauslFlags | MODULE_FLAGS}
     * snapshot in `./flags.ts`).
     *
     * @remarks
     * The `experimental` prefix mirrors the `experimentalFlags` naming
     * adopted by other long-lived TypeScript libraries: callers should
     * read each entry as "this knob is opt-in measurement only; the
     * default is the safe behaviour, and the field exists so an
     * adopter or a benchmark can flip it without an env-var dance."
     * Construction-time merge only — the engine captures the merged
     * snapshot in its closures and never re-reads `process.env` for
     * that flag again over the engine's lifetime.
     */
    readonly experimentalFlags?: Partial<CauslFlags>;
    /**
     * Engine-backend selector. Default `'js'` — the canonical TypeScript
     * engine in this module.
     *
     * - `'js'` — pure-TS engine; no WASM artifacts are fetched.
     * - `'auto'` — start on the TS engine and migrate to the WASM
     *   backend at runtime when the {@link shouldMigrate} heuristic
     *   trips (closes #1072; the wrapper lives in `auto-adapt-wrapper.ts`).
     *   Migration is one-way: once on WASM the wrapper stops checking
     *   so a transient spike cannot ping-pong the backend selection.
     *
     * @remarks
     * `'wasm'` is intentionally NOT an accepted value on the synchronous
     * `createCausl` constructor — loading the WASM artifact requires an
     * async `import('@causl/core/wasm')` + `loadWasmBackend()` call.
     * Adopters who want WASM unconditionally drive `loadWasmBackend()`
     * directly; the canonical adopter-facing path for opt-in is `'auto'`.
     */
    readonly backend?: 'js' | 'auto';
    /**
     * Per-engine overrides for the auto-adapt heuristic thresholds.
     *
     * @remarks
     * Only consumed when `backend === 'auto'`. Each field on
     * {@link AdaptThresholds} can be flipped here for a single engine
     * instance without mutating the process-wide env. Keys not present
     * fall back to the value parsed once at module load from
     * `process.env` via `CAUSL_WASM_*` env vars (the
     * `MODULE_THRESHOLD_OVERRIDES` snapshot in `./auto-adapt.ts`).
     * Construction-time merge only — the wrapper captures the merged
     * snapshot once and never re-reads `process.env` over its lifetime.
     */
    readonly adaptThresholds?: Partial<AdaptThresholds>;
    /**
     * Enable the dev-only H1 hazard warning (#1155, #1241).
     *
     * Per `docs/wasm-backend-adopter-audit.md` H1 and SPEC §15.1 (PR #1129),
     * the engine does NOT guarantee reference-identity stability for values
     * returned from {@link Graph.read}: a commit may produce a structurally
     * equivalent but distinct object, and adopters who cache a `read()`
     * return across a commit boundary will silently desynchronise from the
     * graph's current value. The symptom is subtle — no error fires; the
     * cached reference simply stops tracking the live state.
     *
     * When enabled, every non-null object/function returned by `read()`
     * outside a tracking projection is recorded as a {@link WeakRef} along
     * with the read-time GraphTime. After each commit advances `now`, the
     * engine walks live WeakRefs and emits one `console.warn` per survivor
     * whose recorded GraphTime predates the post-commit clock — naming the
     * offending node id and pointing at SPEC §15.1. The warning never
     * throws; the contract is informational only.
     *
     * @remarks
     * Default is **`false`** (opt-in) per the panel review of #1241. PR
     * #1238 originally shipped with an auto-detected dev/prod default,
     * but the canonical `@causl/react` adapter holds the `read()`
     * return inside `useSyncExternalStore`'s snapshot cache for tearing
     * detection — that single retained reference triggered the warning
     * on every commit for any adapter usage.
     *
     * The follow-up (#1241) ships three coordinated fixes:
     *
     *   - **A.** Default `enableH1HazardWarning` is now `false`; adopters
     *     who want the dev safety net opt in explicitly with
     *     `createCausl({ enableH1HazardWarning: true })`.
     *   - **B.** An internal `__causl_*` adapter-exemption seam (used by
     *     `@causl/react`'s canonical hooks) suppresses H1 tracking for
     *     reads inside an adapter's `getSnapshot` boundary, so opt-in
     *     adopters do not see false positives from official adapters.
     *   - **C.** The instrumentation is wrapped in
     *     `process.env.NODE_ENV !== 'production'` literal blocks so
     *     esbuild / terser can dead-code-eliminate the WeakRef apparatus
     *     in production builds.
     *
     * Pass `true` explicitly to engage the dev-only WeakRef tracker; pass
     * `false` (or omit the option) to keep the engine on the production
     * hot path with no per-`read()` bookkeeping.
     *
     * Bookkeeping cost when armed: one `WeakRef` allocation per qualifying
     * `read()` call (primitives, `null`, reads inside a tracking
     * projection, and reads inside the adapter-exemption seam are
     * skipped); one O(N) walk per commit over the survivor list with
     * dead-ref pruning. Empirically <1% on `linear-chain × 1000` traces
     * in dev mode.
     */
    readonly enableH1HazardWarning?: boolean;
    /**
     * C.4 (#1505) — per-graph batched-flush opt-in for the WASM backend
     * (epic #1493, option-c batched-commit boundary scaffolding).
     *
     * @remarks
     * Only consumed on the `backend: 'auto'` path (forwarded to
     * `loadWasmBackend({ batchedFlush })` when the auto-adapt wrapper
     * migrates to the WASM backend). Adopters driving `loadWasmBackend()`
     * directly pass it there instead.
     *
     * **Omitting this is byte-identical to dev `b15069fa`** — the
     * load-bearing C.4 acceptance property. No queue is installed; the
     * pre-C.3 per-commit shadow path runs unchanged; `commit()` /
     * `read()` / `subscribe()` results are exactly what they were before
     * this cascade. Zero codemod, zero deprecation, zero behavioural
     * change unless the adopter explicitly opts in. Per-graph, not
     * global (option-c doc §2.3).
     *
     * **No adopter-visible perf change at v1.x even when opted in** —
     * the JS engine remains SSOT; only the WASM-side wire crossing
     * batches. This is scaffolding for a future v2.x Rust-SSOT cutover,
     * NOT a perf win. See `docs/epic-1483/option-c-batched-boundary.md`.
     *
     * The shape is `{ afterN?: number; intervalMs?: number }` — kept as
     * a structural type here so `./types.js` does not depend on the
     * `@causl/core/wasm` subpath (which the main barrel must never pull
     * in). The canonical declaration is `BatchedFlushOptions` in
     * `packages/core/wasm/index.ts`.
     */
    readonly batchedFlush?: {
        readonly afterN?: number;
        readonly intervalMs?: number;
    };
    /**
     * V2.1 (#1519) — per-graph Rust-SSOT cutover opt-in for the WASM
     * backend (epic #1515, V2-DESIGN §2).
     *
     * @remarks
     * Only consumed on the `backend: 'auto'` path (forwarded to
     * `loadWasmBackend({ engine })` when the auto-adapt wrapper
     * migrates to the WASM backend). Adopters driving
     * `loadWasmBackend()` directly pass it there instead.
     *
     *   - `'js-ssot'` — DEFAULT. TS engine canonical; the Rust
     *     `commit_batch` result is discarded into the shadow mirror.
     *   - `'rust-ssot'` — opt in to the v2.x cutover surface: the Rust
     *     post-state becomes the candidate canonical for the WASM-side
     *     mirror at the batched-flush boundary, validated byte-identical
     *     against the always-on JS-SSOT shadow first (the compare guard
     *     lands in V2.2; promotion is gated to V2.4).
     *
     * **Omitting this (or passing `'js-ssot'`) is byte-identical to
     * dev `97da8420`** — the load-bearing V2.1 acceptance property
     * (V2-DESIGN §2.2). Purely additive, per-graph, zero-codemod,
     * zero-deprecation, default-off.
     *
     * **No adopter-visible perf change and no perf win at v2.x.** The
     * Rust-engine-in-WASM per-commit execution cost is ~85x the TS
     * engine at current WASM maturity (#1479 comment 4455257530) — a
     * property of today's runtime that #1493's batching provably
     * cannot amortise. v2.x is future-facing infrastructure behind
     * this opt-in plus the V2-DESIGN §3 maturity tripwire; the #1133
     * falsification is NOT refuted. Promotion of the default to
     * `'rust-ssot'` is a tripwire-gated future decision explicitly out
     * of epic #1515 scope.
     *
     * The canonical declaration is `WasmEngineMode` in
     * `packages/core/wasm/index.ts`; the literal union is inlined here
     * so `./types.js` does not depend on the `@causl/core/wasm`
     * subpath (which the main barrel must never pull in).
     */
    readonly engine?: 'js-ssot' | 'rust-ssot';
}

/**
 * Public surface of a causl engine instance.
 *
 * @remarks
 * Realises the canonical seven primitives — `input`, `derived`,
 * `commit`, `read`, `subscribe`, `explain`, plus `createCausl`
 * itself — together with the second-tier extensions
 * (`subscribeCommits`, `commitLog`, `exportModel`, `snapshot`,
 * `hydrate`, `readAt`, `snapshotAt`, `simulate`, `dependencies`,
 * `dependents`, `now`). Each of those rows justifies itself
 * individually: each names an unavoidable concept the engine cannot
 * express without it. The seven canonical methods are the load-
 * bearing surface defended on every PR review; the second tier is
 * acknowledged drift, reviewed quarterly, and any row whose
 * justification fades gets demoted to internals or removed. Keeping
 * this surface small is the design discipline the engine commits to
 * — the alternative is the previous draft's nine kinds of hooks and
 * fifty-seven enum tags before a developer could write a counter.
 */
interface Graph {
    /**
     * Register a writable Behavior.
     *
     * @typeParam T - Value type carried by the input.
     * @param id - Stable, graph-unique identifier from the user's
     *   information-model namespace (e.g. `cell:wb1:Sheet1:A1`), kept
     *   strictly separate from editor-controller identifiers.
     * @param initial - Value at `GraphTime` zero, satisfying
     *   `input(t₀) = initial`.
     * @returns A handle suitable for `tx.set`, `read`, `subscribe`,
     *   and `explain`.
     * @throws {@link DuplicateNodeError} if `id` is already registered.
     */
    input<T>(id: NodeId, initial: T): InputNode<T>;
    /**
     * Register a composed Behavior.
     *
     * @typeParam T - Value type produced by `compute`.
     * @param id - Stable, graph-unique identifier.
     * @param compute - Closure invoked with a tracked `get` accessor;
     *   dependencies are inferred from observed `get` calls rather
     *   than declared up front, so a derivation that switches inputs
     *   on an `if` branch naturally rewires its dependency set on the
     *   next evaluation.
     * @param options - Optional engine-internal tag; `tag: 'live'` is
     *   used by `liveDerived` (devtools) so `graph.explain` reports
     *   `via: 'live'` for hot-swappable nodes — the affordance that
     *   makes "edit a derivation while it's running" demoable.
     * @returns A handle to the derived node.
     * @throws {@link DuplicateNodeError} if `id` is already registered.
     */
    derived<T>(id: NodeId, compute: Compute<T>, options?: {
        readonly tag?: 'live' | 'commit-metadata';
    }): DerivedNode<T>;
    /**
     * Register a derived Behavior whose compute reads commit metadata —
     * `graph.commitLog`, the just-completed commit's stamp, or values
     * produced by other commit-metadata-tagged deriveds — and whose
     * value is expected to reflect the *just-completed* commit, not the
     * previous one.
     *
     * Internally a `commitMetadataDerived` is a {@link DerivedNode} like
     * any other; it participates in `read`, `subscribe`, `explain`, and
     * `readAt` uniformly with plain {@link Graph.derived}. The seam
     * this factory adds is scheduling: the engine recomputes commit-
     * metadata deriveds in Phase F.5, *after* Phase D's regular
     * fixpoint has settled and Phase F.4 has refreshed
     * `commitLogEntry.value`, but *before* Phase G fires per-node
     * subscribers. A derivation registered through this factory
     * therefore sees the new commit log entry on the same commit that
     * produced it; subscribers fire once, with the post-commit value.
     *
     * @typeParam T - Value type produced by the derivation.
     * @param id - Stable, application-chosen identifier within the
     *   graph.
     * @param compute - Pure function expressing the derivation's
     *   semantics. Reads through `get(graph.commitLog)` see the
     *   bounded ring of recent commits including the in-flight one.
     * @returns A handle to the derived node.
     * @throws {@link DuplicateNodeError} if `id` is already registered.
     * @throws {@link CycleError} if the initial compute closes a cycle.
     *
     * @remarks
     * Realises §11's "first-class derived for inspection" framing for
     * the commit-metadata-reading case (#452). PR #383 attempted to
     * turn `whyUpdated` / `whyNotUpdated` / `commitLog` into live
     * derived nodes through plain `derived(...)`; the attempt failed
     * because Phase D's recompute saw the *previous* commit's log
     * array. This factory adds the typed seam #452 picks up: tagged
     * nodes are recomputed in Phase F.5 against the just-refreshed
     * `commitLogEntry.value`, so devtools surfaces can be derived
     * nodes rather than one-shot snapshots. Ordinary deriveds are NOT
     * affected by Phase F.5 — they settle exactly once per commit in
     * Phase D, preserving the §3 atomicity contract for code that did
     * not opt in.
     */
    commitMetadataDerived<T>(id: NodeId, compute: Compute<T>): DerivedNode<T>;
    /**
     * Advance time by one and apply staged writes atomically.
     *
     * @param intent - Caller-supplied label retained on the {@link Commit}
     *   record and the commit log. Labels surface in devtools and
     *   replay logs; the engine treats `'hydrate'` specially so SSR-
     *   restore events are distinguishable from user-initiated
     *   commits.
     * @param run - Callback receiving a {@link Tx}; all `tx.set` calls
     *   land at the same `GraphTime`. There is no fractional time and
     *   no nested-commit story — `commit` is the only operation that
     *   advances time, by exactly one.
     * @returns The {@link Commit} record describing the moment.
     * @throws {@link CommitInProgressError} on nested commits. The
     *   re-entrancy guard fires the moment a commit is invoked while
     *   another is already in flight on the same graph, defeating the
     *   concurrent-engine-mutation row of the SPEC §9.1 race catalogue
     *   by absence-of-API.
     * @throws {@link CycleError} if the commit closes a derivation
     *   cycle. Cycles are detected at the first commit that closes
     *   them, with a structured error naming the cycle path; static
     *   cycle detection is reserved for the bounded model checker.
     * @throws {@link StaleTxError} if the captured {@link Tx} handle is
     *   used after `run` returned. The handle is bounded to its
     *   commit; a write through an escaped reference would land
     *   outside the staging window and break the "exactly one new
     *   `GraphTime` per commit" invariant.
     * @throws {@link NotAnInputNodeError} if `tx.set` targets a
     *   {@link DerivedNode}. Permitting the write would tear the
     *   denotational equation `derived(t) = f(b₁(t), …, bₙ(t))`, so
     *   the engine rejects the call at the API boundary.
     * @throws {@link NodeDisposedError} if `tx.set` targets a node
     *   that has been released through the adapter-layer `dispose`
     *   hook. Disposal records a tombstone keyed by node id; the
     *   typed error lets adapters distinguish "released" from "never
     *   registered" — the use-after-dispose row of SPEC §9.1.
     * @throws {@link UnknownNodeError} if `tx.set` targets a
     *   fabricated handle whose id is not registered on this graph.
     *   The same `getEntry` gate that protects every read-side
     *   primitive in SPEC §12.1's canonical seven catches the write
     *   side here.
     */
    commit(intent: string, run: (tx: Tx) => void): Commit;
    /**
     * Predict what `commit(intent, run)` would do *without* committing.
     *
     * @param intent - Caller-supplied label that would have been recorded
     *   on the predicted {@link Commit}. Treated as opaque metadata; not
     *   appended to the commit log because no commit is published.
     * @param run - Callback receiving a transient {@link Tx}; staged
     *   writes drive the same recompute pipeline `commit` runs, then
     *   the entire effect is discarded before this method returns.
     * @returns A {@link SimulateResult}: `'clean'` carrying the would-be
     *   {@link Commit}, the staged-input diff, and the derived diff;
     *   `'failed'` carrying the typed error the simulated transaction
     *   would have thrown. Re-entrancy is the only failure mode that
     *   *does* throw — see {@link CommitInProgressError} below.
     *
     * @remarks
     * §5 names exactly three commit-mode shapes — `strict`,
     * `with-conflicts`, and a separate `graph.simulate(...)` API for
     * dry-run. `simulate` runs the staging + recompute phases of `commit`
     * against a transient view and discards the result, so application
     * code can answer "what *would* happen if I ran this transaction?"
     * without an out-of-band rollback. The §5 contract is the strong
     * one: after `simulate` returns,
     *
     * - {@link Graph.now} is unchanged,
     * - no entry has been appended to the commit log
     *   ({@link Graph.commitLog} subscribers do not fire),
     * - no per-node {@link Graph.subscribe} observer fires,
     * - no {@link Graph.subscribeCommits} observer fires,
     * - every input cell still holds its pre-call value,
     * - every derived cell still holds its pre-call value (and dep set,
     *   and `lastTime`) — `simulate` reuses `commit`'s atomicity
     *   rollback to restore byte-identical post-recompute state.
     *
     * The dry-run is therefore observer-invisible. {@link Graph.exportModel}
     * called immediately after `simulate` returns produces the same IR
     * document that an `exportModel` call immediately *before* would
     * have produced.
     *
     * @throws {@link CommitInProgressError} on re-entry from inside an
     *   in-flight `commit` callback or another `simulate`. Same contract
     *   as nested `commit`: there is exactly one mutation pipeline and
     *   it does not nest, and `simulate` borrows that pipeline. Every
     *   *other* engine-emitted error — `CycleError`,
     *   `NotAnInputNodeError`, `UnknownNodeError`, `NodeDisposedError`,
     *   `StaleTxError` — is surfaced on the `'failed'` arm of the result
     *   rather than thrown, so callers can predict the failure mode
     *   without `try/catch`.
     *
     * @example
     * ```ts
     * const result = graph.simulate('preview', tx => tx.set(a, 42))
     * if (result.status === 'clean') {
     *   console.log('would change:', result.commit.changedNodes)
     * } else {
     *   console.error('would fail with:', result.error)
     * }
     * // graph.now and every cell value are unchanged at this line.
     * ```
     */
    simulate(intent: string, run: (tx: Tx) => void): SimulateResult;
    /**
     * Read a node's value at the current committed time.
     *
     * @typeParam T - Value type carried by the node.
     * @param node - Input or derived node to read.
     * @returns The committed value at `now`. There is no API to read
     *   inside another transaction's staging window; that race class
     *   is caught by the absence of the construct.
     * @throws {@link UnknownNodeError} if `node` is not registered.
     */
    read<T>(node: Node<T>): T;
    /**
     * Observe value changes on a single node.
     *
     * @typeParam T - Value type of the observed node.
     * @param node - Target node.
     * @param observer - Callback invoked once per commit during which
     *   the node's value changed. A multi-write commit produces
     *   exactly one notification per affected subscriber, never one
     *   per `tx.set` — the worked example `graph.commit('bump-both',
     *   tx => { tx.set(a, 100); tx.set(b, 200) })` fires a single
     *   `301` and not two.
     * @returns A disposer that detaches the observer.
     * @throws {@link UnknownNodeError} if `node.id` is not registered
     *   on this graph. `subscribe` validates the entry up front (the
     *   same `getEntry` gate as `read`) so a fabricated handle is
     *   rejected before any subscription bookkeeping is allocated —
     *   the symmetric guard against the "fabricated id" race that
     *   protects every read-side primitive in SPEC §12.1's canonical
     *   seven.
     * @throws {@link NodeDisposedError} if `node.id` has been released
     *   through the adapter-layer `dispose` hook
     *   (`@causl/core/internal`). Disposal records a tombstone keyed
     *   by node id; subsequent subscribe calls surface this typed error
     *   rather than the generic `UnknownNodeError` so adapter authors
     *   can branch on "released" vs. "never registered" — the
     *   discriminated tag the React `useCauslFamily` hook depends on
     *   to clean up after a component's mount window closes.
     * @param options - Optional {@link SubscribeOptions}: pass
     *   `{ transient: true }` to register the observer as a one-shot
     *   that auto-disposes after its first Phase G fire (#766). The
     *   synchronous initial fire does NOT consume the transient slot —
     *   the auto-dispose trigger is the next commit-time fire.
     */
    subscribe<T>(node: Node<T>, observer: Observer<T>, options?: SubscribeOptions): Unsubscribe;
    /**
     * Register a single observer against a tuple of nodes. The observer
     * is invoked once synchronously with each node's current value, and
     * afterwards once per commit during which **any** of the registered
     * nodes' values changed — the engine fires the group exactly once
     * per commit even when several of the group's members move in the
     * same transaction (#766).
     *
     * @typeParam Ts - Tuple of {@link Node} handles being observed. The
     *   observer's `values` parameter is typed as {@link ValueMap}`<Ts>`,
     *   so a registration over `[Node<number>, Node<string>]` receives
     *   `[number, string]` at fire-time.
     * @param nodes - Tuple of nodes whose value changes should fire the
     *   observer. Order is preserved in the value tuple passed to the
     *   observer. Empty tuples are accepted: the observer fires once
     *   synchronously with `[]` and then never again.
     * @param observer - Callback receiving the freshly-read value tuple
     *   on each notification.
     * @param options - Optional {@link SubscribeOptions}: pass
     *   `{ transient: true }` to register the group as a one-shot that
     *   auto-disposes after its first commit-time fire.
     * @returns An {@link Unsubscribe} that drops the entire group as a
     *   single operation. Idempotent — repeated invocations are
     *   harmless.
     * @throws {@link UnknownNodeError} if any `nodes[i].id` is not
     *   registered on this graph. The error is raised before any
     *   subscription bookkeeping is allocated, so a partial group never
     *   exists from the engine's perspective.
     * @throws {@link NodeDisposedError} if any `nodes[i].id` has been
     *   released through the adapter-layer `dispose` hook.
     *
     * @remarks
     * The engine maintains the per-node subscriber index introduced in
     * #671 to keep Phase G's `changed → bucket` walk cheap; #738 shipped
     * the index but not the multi-node convenience surface. This method
     * registers one {@link SubscriptionEntry} per node sharing a single
     * observer reference, so:
     *
     * - When **one** node in the group changes, the engine walks the
     *   per-node bucket for that id alone, fires the shared observer
     *   once, and skips the buckets for the unchanged nodes.
     * - When **multiple** nodes in the group change in the same commit,
     *   the engine dedupes via a per-commit "fired this many-group"
     *   marker (the same shape `subscribeReads` uses for its
     *   re-entered-via-multiple-deps case), so the observer still fires
     *   exactly once.
     * - When **no** node in the group is in `changedNodes`, the engine
     *   never visits the group's buckets at all — same `O(1)`-per-commit
     *   firehose acceptance the per-node `subscribe` enjoys.
     *
     * Cheaper than N independent {@link Graph.subscribe} calls because
     * the per-node index is built once at registration and the dedupe
     * marker amortises the multi-write fan-in.
     */
    subscribeMany<Ts extends readonly Node<unknown>[]>(nodes: Ts, observer: (values: ValueMap<Ts>) => void, options?: SubscribeOptions): Unsubscribe;
    /**
     * Subscribe to every commit on this graph. The commit log is
     * itself a `Behavior [Commit]`; this is the narrow per-fire
     * notification capability — one Commit object per fire, no log
     * read — that adapters (React, devtools, persistence, SSR
     * hydrate) use to listen for "any change at all" without being
     * handed access to the full log. Callers that need the log itself
     * consume {@link Graph.commitLog} instead.
     *
     * @param observer - Callback invoked once per commit with the
     *   {@link Commit} record.
     * @returns A disposer that detaches the observer.
     */
    subscribeCommits(observer: (commit: Commit) => void): Unsubscribe;
    /**
     * Subscribe to a projection's value, with the engine tracking the
     * projection's read-set automatically (SPEC §11.1 amended, #701).
     *
     * The engine runs `projection()` once at registration under the same
     * tracking `get` accessor it uses for derived computes, captures the
     * set of node ids the projection reads, and fires
     * `observer(commit, value)` on every commit whose
     * {@link Commit.changedNodes} intersects the captured set. The
     * projection is re-run on every fire — both to refresh the value
     * passed to the observer and to refresh the recorded read-set so
     * conditional reads "follow the live branch" without the adopter
     * managing dep arrays by hand. The initial registration also fires
     * once synchronously with the projection's initial value, mirroring
     * {@link Graph.subscribe}'s initial-fire contract.
     *
     * Conditional reads are handled automatically: a projection like
     * `() => flag.read() ? get(b) : get(a)` initially records
     * `{flag, a}`; after `flag` flips and the projection re-runs the
     * recorded set becomes `{flag, b}` and writes to `a` no longer
     * fire the observer. This is the contract-layer surface for
     * "subscribe to a derived projection without registering a
     * `derived` node," and is the dispatch shape that `useCauslNode`
     * and similar React adapters can build on without round-tripping
     * through `subscribeCommits`'s every-commit fan-in.
     *
     * @typeParam T - Value type produced by the projection closure.
     * @param observer - Callback invoked with the just-published commit
     *   and the projection's freshly-evaluated value.
     * @param projection - Pure read closure executed under the engine's
     *   tracking accessor. The set of nodes the projection touches via
     *   the supplied tracking `get` becomes the registration's recorded
     *   read-set; subsequent commits only fire the observer when their
     *   `changedNodes` intersect this set.
     * @returns A disposer that idempotently removes the registration.
     */
    subscribeReads<T>(observer: SubscribeReadsObserver<T>, projection: () => T): Unsubscribe;
    /**
     * Derived view of a node's lineage, itself subscribable.
     *
     * @typeParam T - Value type of the explained node.
     * @param node - Target node.
     * @returns A {@link DerivedNode} carrying an {@link Explanation}.
     *   Returning a node rather than a one-shot JSON dump is
     *   deliberate — it makes the engine inspectable through its own
     *   primitives, which is the only way devtools earn the
     *   comparison to spreadsheets the engine commits to.
     * @throws {@link UnknownNodeError} if `node.id` is not registered
     *   on this graph. `explain` validates the entry up front (the same
     *   `getEntry` gate as `read` and `subscribe`) so the error surface
     *   is uniform across the read-side primitives in SPEC §12.1's
     *   canonical seven — no read-side primitive silently fabricates
     *   lineage for an id the graph has never seen.
     * @throws {@link NodeDisposedError} if `node.id` has been released
     *   through the adapter-layer `dispose` hook
     *   (`@causl/core/internal`). The typed disposal error mirrors
     *   the contract on `read` and `subscribe` so adapter code can
     *   branch on "released" vs. "never registered" no matter which
     *   read-side primitive surfaced the post-disposal access.
     */
    explain<T>(node: Node<T>): DerivedNode<Explanation>;
    /**
     * Direct (depth-1) dependencies of `node` at the current committed
     * time — every upstream node id `node` reads on its most recent
     * evaluation, in lexicographic order for stable iteration.
     *
     * @typeParam T - Value type of the node being inspected.
     * @param node - The node whose dependency set to enumerate. Inputs
     *   never have dependencies; the call is well-defined on inputs and
     *   returns the empty array.
     * @returns A frozen `readonly NodeId[]` snapshot of the dep set as of
     *   `now`. The array is a one-shot projection of the engine's
     *   internal `entries.get(id).deps` set; topology changes after the
     *   call (a derivation re-evaluating onto a different conditional
     *   branch, a fresh `derived` registration, an adapter `dispose`)
     *   are NOT reflected. Callers that need a live view should re-query
     *   on the {@link Graph.subscribeCommits} fire of interest.
     * @throws {@link UnknownNodeError} if `node.id` is not registered on
     *   this graph. Same `getEntry` gate as `read`/`subscribe`/`explain`,
     *   so the read-side error surface stays uniform across the §12.1
     *   canonical seven and the §11 inspection primitives layered on
     *   top.
     * @throws {@link NodeDisposedError} if `node.id` has been released
     *   through the adapter-layer `dispose` hook
     *   (`@causl/core/internal`). Adapter code branches on this typed
     *   error to distinguish "released" from "never registered" — the
     *   same discriminator `read`/`subscribe`/`explain` already produce.
     *
     * @remarks
     * Realises the third bullet of SPEC §11's liveness commitment: *"a
     * node's current dependents and current dependency are themselves
     * derived nodes."* This implementation ships the one-shot snapshot
     * shape rather than a {@link DerivedNode}-valued handle. The reason
     * is structural: a live derived `dependencies(node)` would have to
     * be invalidated by the same commit pipeline that mutates the
     * dep-set, and the pipeline cannot host derived nodes whose value
     * is metadata about the commit pipeline itself without a
     * recursive-fire path the §5 "exactly one new GraphTime per commit"
     * invariant cannot absorb (#383). The snapshot shape preserves the
     * §11 semantics — *the engine is its own observer* — without
     * re-entering the commit pipeline; a future PR may layer a derived
     * handle on top once the recursive-fire question is settled.
     */
    dependencies<T>(node: Node<T>): readonly NodeId[];
    /**
     * Direct (depth-1) dependents of `node` at the current committed
     * time — every derived node id whose most recent evaluation read
     * `node`, in lexicographic order for stable iteration.
     *
     * @typeParam T - Value type of the node being inspected.
     * @param node - The node whose consumer set to enumerate. Both
     *   inputs and derived nodes can have dependents; the call is
     *   well-defined on either, and returns the empty array when no
     *   live derivation reads `node`.
     * @returns A frozen `readonly NodeId[]` snapshot of the reverse-dep
     *   set as of `now`. Same one-shot semantics as
     *   {@link Graph.dependencies}: topology changes after the call are
     *   NOT reflected. The array is sourced from the engine's internal
     *   reverse-dep adjacency map (`dependents: Map<NodeId,
     *   Set<NodeId>>`) which the commit pipeline already maintains for
     *   invalidation; this method publishes the same view as a
     *   read-only projection.
     * @throws {@link UnknownNodeError} if `node.id` is not registered on
     *   this graph.
     * @throws {@link NodeDisposedError} if `node.id` has been released
     *   through the adapter-layer `dispose` hook.
     *
     * @remarks
     * Pairs with {@link Graph.dependencies} as the §11 third-bullet
     * inspection primitive. The spreadsheet question — *what depends on
     * this cell?* — is answerable through engine primitives instead of
     * by walking every other node's `explain`. See
     * {@link Graph.dependencies} for the detailed rationale on why this
     * ships as a snapshot rather than a {@link DerivedNode}-valued
     * handle (#383).
     */
    dependents<T>(node: Node<T>): readonly NodeId[];
    /**
     * Export a CauslModel IR snapshot — the bridge to
     * `causl-check`, the bounded model checker that lifts runtime
     * race-detection into a CI gate.
     *
     * @param options - Optional caller tuning (e.g. commit-log cap).
     * @returns A {@link CauslModel} document suitable for the Rust
     *   model checker. The document describes the registered nodes,
     *   the dependency edges (static and conditional), the registered
     *   resources and their statechart, the registered constraints,
     *   and the application's `Msg` union. The checker enumerates
     *   bounded interleavings over this IR and asserts glitch-
     *   freedom, dynamic-dep correctness, statechart conformance,
     *   cycle reachability, and replay determinism at every reachable
     *   state.
     */
    exportModel(options?: ExportModelOptions): CauslModel;
    /**
     * Capture the current input set + GraphTime as a serialisable
     * {@link GraphSnapshot} suitable for SSR transfer, persistence, or
     * DevTools time-travel. Derived nodes are intentionally omitted —
     * they are pure functions of inputs and recompute on first read,
     * so transmitting them is redundant at best and a determinism risk
     * at worst.
     *
     * @returns A {@link GraphSnapshot} capturing every input whose
     *  current value is JSON-serialisable, plus a `schemaHash` derived
     *  from the registered node id-set for {@link Graph.hydrate}-side
     *  capability validation. Without a single-call snapshot every
     *  adapter would rebuild the equivalent and they would drift.
     */
    snapshot(): GraphSnapshot;
    /**
     * Bulk-apply a {@link GraphSnapshot} to this graph by routing the
     * snapshot's input set through the same Phase A–H commit pipeline
     * that {@link Graph.commit} drives: stages the writes, advances
     * {@link Graph.now} by exactly one tick (the §3 monotonicity
     * invariant), recomputes the affected derivations, publishes a single
     * {@link Commit} with `intent: 'hydrate'` and `originatedAt:
     * snap.time`, fires per-node subscribers whose value changed, and
     * notifies `subscribeCommits` observers — uniformly with any other
     * commit. The §5 "one mutation pipeline" contract holds: hydrate is
     * a privileged caller of `commit`'s pipeline, not a parallel one.
     *
     * @param snap - The snapshot to apply.
     * @throws {@link CommitInProgressError} when invoked mid-commit
     *  (re-entrant hydrate is forbidden, identical to nested commits).
     * @throws {@link HydrationSchemaError} when the snapshot's
     *  `schema` version is unsupported, or when its `schemaHash` does
     *  not match the live graph's registered node id-set. The
     *  capability check closes the hydration-mismatch race class
     *  structurally rather than by hope: a mismatched server snapshot
     *  is rejected at the door, not silently absorbed. The schema gates
     *  run BEFORE the commit pipeline is entered so a rejected hydrate
     *  never appears in `commitLog` and never fires subscribers.
     *
     * @remarks
     * The snapshot's recorded `time` is preserved on the published
     * {@link Commit} as `originatedAt` so persistence and devtools can
     * answer "this commit replays a server snapshot from t=N" without
     * inspecting `intent` strings. The engine clock advances by exactly
     * one tick regardless of `snap.time` — `graph.now` after a
     * successful hydrate is `prev.now + 1`, not `snap.time`. This is
     * what closes #366 (monotonic GraphTime ordering) and #378 (single
     * mutation pipeline) in one stroke.
     */
    hydrate(snap: GraphSnapshot): void;
    /**
     * Read the value of `node` at a past committed time `t`.
     *
     * @typeParam T - Value type of the node.
     * @param node - The node handle whose past value should be retrieved.
     * @param t - GraphTime to read at; must be ≤ {@link Graph.now}.
     * @returns A {@link RetentionResult} carrying either the retained
     *  value (and the snapshot's actual time) or an `evicted` marker
     *  with the oldest still-retained time so callers can clamp future
     *  requests into the bounded window.
     *
     * @remarks
     * Bounded by `snapshotRetentionCap` (default 50): the engine keeps
     * the most recent N committed input snapshots and drops older
     * ones. Derived nodes are recomputed against the retained input
     * snapshot; the recompute is wavefront-memoised so a diamond DAG
     * resolves each join exactly once. Time-travel devtools and
     * replay-determinism tests both consume this primitive — and
     * because `JUMP_TO_*` is observed *as a read* via this method
     * (returning a discriminated `Retained | Evicted` rather than
     * mutating the graph), inconsistent-snapshot-history races are
     * caught by the type narrow plus the engine's branch-fork record.
     */
    readAt<T>(node: Node<T>, t: GraphTime): RetentionResult<T>;
    /**
     * Project a whole-graph {@link GraphSnapshot} at a historical
     * GraphTime `t`, sourced from the engine's bounded retention
     * buffer. Returns `{ status: 'evicted', oldestRetainedTime }` when
     * `t` falls outside the retention window.
     *
     * @remarks
     * The bridge consumes this on JUMP / IMPORT_STATE / ROLLBACK so
     * time travel is observed *as a read* on a `Behavior`, not as a
     * mutation — preserving the denotational contract that the only
     * way time advances is through `commit`. Cheaper than enumerating
     * inputs and calling `readAt` per node, and yields a value of the
     * same shape as `snapshot()`.
     */
    snapshotAt(t: GraphTime): RetentionResult<GraphSnapshot>;
    /** Current committed time. A getter, not a method — the
     * denotational vocabulary needs an external observer to ask "what
     * time is it?" without firing a commit. */
    readonly now: GraphTime;
    /**
     * The engine's commit log surfaced as a {@link DerivedNode} —
     * realises the engine's promise that *"the transaction log is a
     * `Behavior [Commit]`, queryable by the same API as any other
     * graph value."* Subscribers via the standard `subscribe(node,
     * observer)` see the array initially and once per successful
     * commit thereafter; the log is `read`able, `subscribe`able, and
     * appears in `explain(node)` lineage views — there is no separate
     * "log API" because the log is just another node.
     *
     * @remarks
     * The value is the bounded ring-buffer history (capped by
     * `commitHistoryCap`, default 1000). Failed commits do not append
     * entries — atomicity demands a transaction either creates exactly
     * one new `t` or none at all, and a failed commit must leave no
     * trace in the log. Long-lived processes that want zero retention
     * pass `commitHistoryCap: 0` at construction.
     *
     * Coexists with `subscribeCommits`, which carries the narrower
     * per-fire notification capability (one Commit per fire, no log
     * read). Capability-narrow consumers prefer `subscribeCommits`;
     * consumers that need the log itself (devtools panels, persistence
     * replay) consume `commitLog`.
     */
    readonly commitLog: DerivedNode<readonly Commit[]>;
    /**
     * Snapshot the engine's retained-state telemetry counters as a
     * single, frozen-shape {@link EngineTelemetry} record.
     *
     * @remarks
     * The §11 inspection-primitives bullet promised "the engine surfaces
     * its own retained shape so a long-running host can audit drift." This
     * method realises that promise as a *pure* read: it iterates no
     * collection, allocates exactly one object, and never mutates engine
     * state. Callers query before/after a workload boundary (fixture
     * teardown, bench scenario end, devtools tab refresh) and compare
     * counters; a non-zero residual on `subscribersTotal` after every
     * subscribe/unsubscribe round-trip has been performed is a
     * subscriber-leak proof.
     *
     * Driven by #757 (the JS-side first cut of the audit-required
     * telemetry surface flagged by #695 wasm cluster) and consumed by the
     * `subscriber-churn-1k` bench scenario (#733/#738) as its end-of-run
     * leak gate. Future refinements may extend the shape (additional
     * counters land at the tail of the object; never reorder or remove);
     * the stable contract is the field names listed on
     * {@link EngineTelemetry}.
     */
    stats(): EngineTelemetry;
}

/**
 * Wire-format envelope produced by {@link Graph.snapshot} and
 * consumed by {@link Graph.hydrate}.
 *
 * @remarks
 * Inputs are captured by their JSON-serialisable values; non-
 * serialisable values are omitted (mirrors {@link Graph.exportModel}
 * conservatism). The optional `schemaHash` is a deterministic digest
 * over the registered node id-set; when present, hydrate rejects
 * snapshots whose hash does not match the live graph's id-set with
 * a {@link HydrationSchemaError}. That capability check is the
 * structural defence against the hydration-mismatch race —
 * server-snapshot id-set ≠ client node-set is not "almost certainly
 * fine in practice," it is rejected at the door.
 */
interface GraphSnapshot {
    /** Wire-format schema version; pinned at `1` for the current epic. */
    readonly schema: 1;
    /** GraphTime at which the snapshot was captured. */
    readonly time: GraphTime;
    /** Map of input id → JSON-serialisable value. */
    readonly inputs: Readonly<Record<NodeId, unknown>>;
    /**
     * Deterministic digest over the registered node id-set at capture
     * time. Optional on the wire so hand-authored snapshots and
     * pre-hash test fixtures stay valid; when present, validated by
     * {@link Graph.hydrate}.
     */
    readonly schemaHash?: string;
}

export { type ValueMap as $, type AdaptThresholds as A, type IRRead as B, type Commit as C, DEFAULT_THRESHOLDS as D, type EngineTelemetry as E, type IRScope as F, type Graph as G, type IRSubscribe as H, type InputNode as I, type IRSubscribeCallback as J, type IRTxSet as K, type IRUnsubscribe as L, type InputExplanation as M, type Node as N, type Observer as O, type LiveExplanation as P, type ObserverErrorContext as Q, type RetentionResult as R, type ObserverErrorHandler as S, type ParseResult as T, type Unsubscribe as U, type SimulateResult as V, type SimulateResultClean as W, type SimulateResultFailed as X, type SubscribeOptions as Y, type SubscribeReadsObserver as Z, type Tx as _, type GraphSnapshot as a, parseCauslModel as a0, shouldMigrate as a1, type GraphTime as b, type NodeId as c, type CauslModel as d, type CreateCauslOptions as e, CAUSL_MODEL_SCHEMA as f, type CauslFlags as g, type Compute as h, type CycleExplanation as i, type DepFrame as j, type DerivedExplanation as k, type DerivedNode as l, type Explanation as m, type ExportModelOptions as n, type GraphStats as o, type IRBridge as p, type IRCallFrame as q, type IRCallGraph as r, type IRCommit as s, type IRDerived as t, type IRDispose as u, type IREvent as v, type IRGraphId as w, type IRInput as x, type IRNode as y, type IRNodeId as z };
