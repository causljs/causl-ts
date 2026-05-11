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
export const CAUSL_MODEL_SCHEMA = 3 as const

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
export type IRGraphId = string

/**
 * Node identifier as represented inside the IR.
 *
 * @remarks
 * String-typed mirror of the engine's {@link NodeId}; kept distinct
 * because the IR may outlive the live graph and travels across the
 * FFI boundary to the Rust checker.
 */
export type IRNodeId = string

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
export interface IRInput {
  /** Discriminator selecting the input variant of {@link IRNode}. */
  readonly kind: 'input'
  /** Identifier of the input node within the source graph. */
  readonly id: IRNodeId
  /**
   * Identifier of the graph instance this node belongs to.
   * Required as of schema 3; sourced from the precedence rule
   * (`createCausl({ name })` first, UUID v4 fallback). Same value
   * appears on every node and commit produced by one
   * `graph.exportModel()` call.
   */
  readonly graphId: IRGraphId
  /** Most recent committed value, mirrored verbatim into the IR. */
  readonly value: unknown
  /**
   * Whether `value` is JSON-serialisable. Non-serialisable inputs are
   * skipped by the checker's state-space enumeration.
   */
  readonly serializable: boolean
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
export interface IRDerived {
  /** Discriminator selecting the derived variant of {@link IRNode}. */
  readonly kind: 'derived'
  /** Identifier of the derived node within the source graph. */
  readonly id: IRNodeId
  /**
   * Identifier of the graph instance this node belongs to.
   * Required as of schema 3.
   */
  readonly graphId: IRGraphId
  /** Dependency set as of the most recent compute. */
  readonly deps: readonly IRNodeId[]
  /** Conditional deps the engine *might* read but has not yet. */
  readonly conditionalDeps: readonly IRNodeId[]
  /**
   * The most recent committed value, mirrored here so the checker
   * does not need to re-evaluate compute closures (which Rust cannot
   * call across the FFI boundary).
   */
  readonly value: unknown
  /**
   * Whether the mirrored `value` is JSON-serialisable; gates inclusion
   * in the checker's reachable-state enumeration.
   */
  readonly serializable: boolean
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
export interface IRCallFrame {
  /** Symbolic name of the call site (function or method name). */
  readonly site: string
  /** File path or module specifier, when the stack-trace API exposes it. */
  readonly source?: string
  /** Line number, when available. */
  readonly line?: number
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
export interface IRCallGraph {
  /**
   * Frames in caller-to-callee order, capped at `D = 32`. Empty when
   * the runtime stack-trace API was unavailable.
   */
  readonly frames: readonly IRCallFrame[]
  /**
   * Set when the application's true call stack at commit time was
   * deeper than the configured bound and frames beyond it were
   * dropped.
   */
  readonly truncatedDeeper: boolean
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
export interface IRSubscribe {
  readonly kind: 'subscribe'
  readonly graphId: IRGraphId
  readonly id: string
  readonly scopeId: string
  readonly target: IRNodeId
  readonly callbackSite: string
  readonly time: number
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
export interface IRSubscribeCallback {
  readonly kind: 'subscribe-callback'
  readonly graphId: IRGraphId
  readonly id: string
  readonly subscribeId: string
  readonly firedAt: number
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
export interface IRUnsubscribe {
  readonly kind: 'unsubscribe'
  readonly graphId: IRGraphId
  readonly id: string
  readonly scopeId: string
  readonly time: number
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
export interface IRDispose {
  readonly kind: 'dispose'
  readonly graphId: IRGraphId
  readonly nodeId: IRNodeId
  readonly scopeId: string
  readonly time: number
  readonly disposeAt: readonly [number, number]
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
export interface IRRead {
  readonly kind: 'read'
  readonly graphId: IRGraphId
  readonly derivedId: IRNodeId
  readonly readNodeId: IRNodeId
  readonly time: number
  readonly seq: number
  readonly truncated: boolean
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
export interface IRTxSet {
  readonly kind: 'tx-set'
  readonly graphId: IRGraphId
  readonly inputId: IRNodeId
  readonly time: number
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
export type IREvent =
  | IRSubscribe
  | IRSubscribeCallback
  | IRUnsubscribe
  | IRDispose
  | IRRead
  | IRTxSet

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
export interface IRScope {
  readonly id: string
  readonly kind: 'ephemeral' | 'infinite' | 'process-exit'
  readonly lifetime: {
    readonly origin: string
    readonly terminator: string
  }
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
export interface IRBridge {
  readonly from: IRGraphId
  readonly to: IRGraphId
  readonly dep: IRNodeId
  readonly policy: 'legacy-allow' | 'test-only' | 'read-only'
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
export type IRNode = IRInput | IRDerived

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
export interface IRCommit {
  /** GraphTime at which the commit landed. */
  readonly time: number
  /**
   * Identifier of the graph instance this commit landed on.
   * Required as of schema 3.
   */
  readonly graphId: IRGraphId
  /** Human-readable label supplied to `graph.commit(intent, …)`. */
  readonly intent: string
  /** Node identifiers whose value changed as part of the commit. */
  readonly changedNodes: readonly IRNodeId[]
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
  readonly originatedAt?: number | undefined
  /**
   * Bounded call-graph annotation captured at commit-issue time.
   * Optional — exporter omits the field when stack-trace capture is
   * disabled (`captureCallGraph: false` on the export options).
   * Schema 3 introduces this field; schema-2 IRs that never set it
   * should either omit it or set `undefined`.
   */
  readonly callGraph?: IRCallGraph
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
  readonly originEvent?: string
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
export interface CauslModel {
  /** Schema version pinned to {@link CAUSL_MODEL_SCHEMA}. */
  readonly schema: typeof CAUSL_MODEL_SCHEMA
  /** Engine GraphTime at export time. */
  readonly time: number
  /** Snapshot of every registered node at export time. */
  readonly nodes: readonly IRNode[]
  /**
   * Optional commit log, capped by host caller. The checker uses
   * this for replay-based determinism checks.
   */
  readonly commits: readonly IRCommit[]
  /**
   * Lifecycle event stream — the closed six-arm discriminated union
   * EPIC-2's lint passes consume. PR-B1 widens this from PR-A's
   * `readonly never[]` placeholder; the engine drains its subscriber
   * registry, disposal tombstones, tx-set log, and read-trace map
   * into the array at `exportModel()` time.
   */
  readonly events: readonly IREvent[]
  /**
   * Lifecycle scopes referenced by `IRSubscribe.scopeId`,
   * `IRUnsubscribe.scopeId`, and `IRDispose.scopeId`. The exporter
   * always emits at least one default scope per graph
   * (`{ id: 'g.<graphId>:default', kind: 'infinite', ... }`) so every
   * `scopeId` resolves. Adopters that need finer scoping pass an
   * explicit scope option to `subscribe()`; PR-B1 reserves the wire
   * shape and a future PR adds the option.
   */
  readonly scopes: readonly IRScope[]
  /**
   * Sanctioned cross-graph dependency declarations. Empty under
   * single-graph IR documents (the common case); populated by a
   * future cross-graph aggregator. EPIC-2's `CrossGraphRead` pass
   * refuses any cross-graph dep not in this list.
   */
  readonly bridges: readonly IRBridge[]
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
  readonly readsTruncated?: boolean
}

// ─── Runtime structural validator ─────────────────────────────────────

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
export type ParseResult =
  | { readonly ok: true; readonly value: CauslModel }
  | {
      readonly ok: false
      readonly path: readonly (string | number)[]
      readonly reason: string
    }

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
export function parseCauslModel(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, path: [], reason: 'not-an-object' }
  }
  const m = input as Record<string, unknown>

  // Schema must be exactly the current version.
  if (m.schema !== CAUSL_MODEL_SCHEMA) {
    return {
      ok: false,
      path: ['schema'],
      reason: `expected schema ${CAUSL_MODEL_SCHEMA}, got ${String(m.schema)}`,
    }
  }
  if (typeof m.time !== 'number') {
    return { ok: false, path: ['time'], reason: 'expected number' }
  }
  if (!Array.isArray(m.nodes)) {
    return { ok: false, path: ['nodes'], reason: 'expected array' }
  }
  if (!Array.isArray(m.commits)) {
    return { ok: false, path: ['commits'], reason: 'expected array' }
  }
  if (!Array.isArray(m.events)) {
    return { ok: false, path: ['events'], reason: 'expected array' }
  }
  if (!Array.isArray(m.scopes)) {
    return { ok: false, path: ['scopes'], reason: 'expected array' }
  }
  if (!Array.isArray(m.bridges)) {
    return { ok: false, path: ['bridges'], reason: 'expected array' }
  }

  // Validate each event variant by `kind` discriminator.
  for (let i = 0; i < m.events.length; i++) {
    const e = m.events[i]
    if (typeof e !== 'object' || e === null) {
      return {
        ok: false,
        path: ['events', i],
        reason: 'event is not an object',
      }
    }
    const ev = e as Record<string, unknown>
    const kind = ev.kind
    switch (kind) {
      case 'subscribe':
      case 'subscribe-callback':
      case 'unsubscribe':
      case 'read':
      case 'tx-set':
        // Structural fields validated downstream by passes; PR-B1's
        // shape gate accepts any object with a known kind.
        break
      case 'dispose': {
        // disposeAt must be a two-element tuple of numbers.
        const da = ev.disposeAt
        if (
          !Array.isArray(da) ||
          da.length !== 2 ||
          typeof da[0] !== 'number' ||
          typeof da[1] !== 'number'
        ) {
          return {
            ok: false,
            path: ['events', i, 'disposeAt'],
            reason: 'expected [number, number]',
          }
        }
        break
      }
      default:
        return {
          ok: false,
          path: ['events', i, 'kind'],
          reason: `unknown event kind: ${String(kind)}`,
        }
    }
  }

  return { ok: true, value: input as CauslModel }
}
