/**
 * @packageDocumentation
 *
 * Reference implementation of the Causl engine: a deterministic, transactional
 * dependency graph built around a one-page denotational definition. GraphTime is an
 * ordered sequence of commit moments t₀ < t₁ < t₂ < …; an input is a writable
 * Behavior whose value at time `t` is the last write at or before `t`; a derived
 * node is `derived(t) = f(b₁(t), …, bₙ(t))`, a pure function of its dependencies
 * sampled at the *same* time. From those equations glitch-freedom, determinism, and
 * atomicity are theorems rather than goals: there is no intermediate "B updated but
 * C did not" state because there is no intermediate time, two implementations either
 * agree on `f(b₁(t), …, bₙ(t))` or one is wrong, and a transaction creates exactly
 * one new `t` so fractional time does not exist.
 *
 * Two primitives — {@link InputNode} and {@link DerivedNode} — and one operation
 * ({@link Graph.commit | commit}) are everything the engine ships. This module owns
 * every piece of mutable state the runtime needs — the entry table for inputs and
 * derivations, the reverse-dependency adjacency map, the staged-write buffer for the
 * in-flight commit, the per-node and per-commit observer registries, and a bounded
 * commit history that realises the engine's "the transaction log is itself a
 * Behavior" inspection promise. A single mutation surface ({@link Graph.commit})
 * advances {@link GraphTime} by one and drives the recompute fixpoint: dirty inputs
 * seed an affected set over the reverse-dep graph, that set is Kahn-ordered,
 * derivations are evaluated under a tracking `get` that captures dynamic
 * dependencies, and equality cutoffs (`Object.is`) prune downstream work and
 * silence redundant subscriber notifications. Errors thrown inside observers are
 * isolated through {@link ObserverErrorHandler} so a faulty subscriber cannot abort
 * the commit pipeline. The surface returned by {@link createCausl} realises the
 * canonical primitives — `input`, `derived`, `commit`, `read`, `subscribe`,
 * `subscribeCommits`, `explain` — plus the second-tier extensions (`commitLog`,
 * `exportModel`, `simulate`, `snapshot`, `hydrate`, `readAt`, `now`) that each
 * justify a slot by naming a concept the engine cannot otherwise express.
 */

import {
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
import { type BackendEngine, JsBackend } from './backend.js'
import { createAutoAdaptGraph } from './auto-adapt-wrapper.js'
import { evaluateStatechart as evaluateStatechartImpl } from './statechart-evaluator.js'
import { type CauslFlags, mergeFlags } from './flags.js'
import { registerInternalDispatch } from './internal-dispatch.js'
import { assertNever } from './internal.js'
import { registerTestingDispatch } from './testing-dispatch.js'
import {
  CAUSL_MODEL_SCHEMA,
  type CauslModel,
  type IRCommit,
  type IREvent,
  type IRNode,
  type IRScope,
} from './ir.js'
import type {
  Commit,
  Compute,
  CreateCauslOptions,
  DepFrame,
  DerivedNode,
  EngineTelemetry,
  ExportModelOptions,
  Explanation,
  Graph,
  GraphSnapshot,
  GraphTime,
  InputNode,
  Node,
  NodeId,
  Observer,
  ObserverErrorContext,
  ObserverErrorHandler,
  RetentionResult,
  SimulateResult,
  SubscribeOptions,
  Tx,
  Unsubscribe,
  ValueMap,
} from './types.js'

/**
 * Ambient `process` declaration for the bundler-replacement
 * `process.env.NODE_ENV !== 'production'` literal gate used by the
 * H1 hazard tree-shake region (#1241 fix C). `@causl/core`'s
 * tsconfig does not include `@types/node` so the type-checker
 * cannot resolve `process` from the Node global; this minimal
 * declaration is the smallest patch that makes the literal
 * expression typecheck.
 *
 * @remarks
 * Critically, the declaration is a literal `const` rather than a
 * `function` or method access. esbuild / terser / webpack
 * substitute the literal string `'production'` for
 * `process.env.NODE_ENV` at build time (the
 * `DefinePlugin` / `--define:process.env.NODE_ENV='"production"'`
 * conventions every major JS bundler honours) iff the access is
 * shape `process.env.NODE_ENV` exactly. Any indirection
 * (`globalThis.process`, `import.meta.env`, etc.) defeats the
 * substitution. So this file uses the bare `process.env.NODE_ENV`
 * form and relies on this declaration to keep the TS source
 * typecheck-clean for adopters whose tsconfig does not include
 * `@types/node`.
 *
 * At runtime (when no bundler substitution has happened — e.g.
 * Vitest's source-on-the-fly transform), `process.env.NODE_ENV`
 * is the actual Node global, which is always present in the
 * supported runtime matrix (Node ≥ 22 per
 * `package.json#engines.node`). In browser bundles consumers go
 * through a bundler that substitutes `process.env.NODE_ENV`
 * anyway.
 */
declare const process: { env: { NODE_ENV?: string } }

/**
 * Internal alias used everywhere the engine needs to refer to a node whose value
 * type is irrelevant to the surrounding logic. The public API is generic; the
 * engine bookkeeping is uniform.
 */
type AnyNode = Node<unknown>

/**
 * Storage record for an {@link InputNode}. Inputs are the writable half of the
 * engine's two-primitive universe: a Behavior whose denotational definition is
 * `input(initial) : Behavior a where input(t₀) = initial`, with the value at any
 * later GraphTime `t` being the most recent write at or before `t`.
 *
 * @remarks
 * `value` is mutated only at the publish step of {@link createCausl | commit}
 * once a transaction's staged writes have been merged. Outside a commit the
 * field is read-only by API construction — there is no concurrent-write surface
 * to misuse.
 */
interface InputEntry {
  readonly kind: 'input'
  readonly id: NodeId
  value: unknown
  readonly node: InputNode<unknown>
  /**
   * GraphTime at which this input's current `value` was last written.
   * Set on registration (to `now` at that moment) and updated by the
   * commit publish step. Powers `Explanation.computedAt` and per-dep
   * `contributedAt` for input frames (#298).
   *
   * #994 — also doubles as the in-tx fast-path dedup sentinel: when
   * `tx.set` writes via the {@link InputEntry.hasDependents} fast
   * path it stamps `now + 1` (the post-tick value Phase C.5 will
   * idempotently re-stamp on commit success); subsequent fast-path
   * writes to the same entry detect the prior touch via
   * `e.lastWriteTime > now`. The slow path is unaffected — Phase
   * C.5 walks `inputRollbackEntries` and re-stamps both fast-path
   * and slow-path rows to `now`, leaving the field byte-identical
   * to the pre-#994 publish step.
   */
  lastWriteTime: GraphTime
  /**
   * #994 — O(1) cache of "this input has at least one derived
   * consumer". Mirrors the `dependents.get(id)?.size > 0` predicate
   * the reverse-dep adjacency map already encodes; promoting it to
   * a per-entry boolean lets `tx.set` ask the question without a
   * Map probe.
   *
   * Maintained at the two `setDeps` edge-add and edge-remove sites
   * (the only places `dependents` mutates outside dispose) and at
   * `disposeNode` for the disposed-derived case (which drops a row
   * of forward edges). The flag is structurally a downstream of
   * `dependents.get(id)?.size > 0`; any drift is a maintenance bug.
   *
   * The fast path in `commit`'s `tx.set` body consults this flag
   * to decide whether a write is "isolated" — no derivation reads
   * this input, so the staged-Map / stagedEntries-array work the
   * slow path performs is dead bookkeeping for an input that no
   * Phase D recompute walk will visit. Atomicity is preserved
   * because the fast path still pushes to the rollback arrays
   * (`inputRollbackEntries / PriorValues / PriorLastWrite`), so a
   * throw escaping a *different* slow-path write's Phase D recompute
   * still rolls the isolated input's value byte-identically back
   * to its pre-commit state.
   */
  hasDependents: boolean
  /**
   * #995 — split-staged read-shadow sentinel. Holds the `now` at
   * which `tx.set`'s slow path FIRST staged this entry in the
   * currently-active commit/simulate frame; sentinel `-1` means
   * "not staged in any active frame." Combined with
   * {@link InputEntry.lastStagedRow}, this triple lets `tx.set`
   * answer "is this a re-stage in the same tx?" with a single
   * field comparison (was: `staged.has(id)` Map probe), and
   * `readEntry` answer "what's the in-tx staged value?" with a
   * single comparison + array index access (was: `staged.has` +
   * `staged.get` — two Map probes).
   *
   * Lifecycle: stamped on first slow-path stage in `tx.set` (set
   * to engine-closure `now` BEFORE Phase C's `now += 1`). Never
   * explicitly cleared — engine-closure `now` advances by exactly
   * one tick per published commit (and is restored to `beforeNow`
   * on rollback / simulate teardown), so the sentinel `=== now`
   * check is automatically false on subsequent commits regardless
   * of whether prior commits succeeded or threw. Initial value is
   * `-1` (a value `now` never holds, since engine genesis is
   * `now = 0`) so the check is correct on a freshly-registered
   * input under a genesis-time commit.
   */
  lastStagedAt: GraphTime
  /**
   * #995 — row index of this entry in the engine-closure
   * `stagedWriteEntries` / `stagedWriteValues` parallel arrays.
   * Meaningful only while {@link InputEntry.lastStagedAt} `=== now`;
   * outside that window the field's value is stale-but-harmless
   * because the read-shadow probe gates on `lastStagedAt` first.
   */
  lastStagedRow: number
  // #915 — `inputRegisteredAt` and `serializableMemo` moved to
  // sibling Maps (`inputRegisteredAtMap` and `inputSerializableMemo`
  // in the `createCausl` closure). Both are observability /
  // diagnostic state read only at `readAt` and `exportModel` /
  // Phase F.6 boundaries respectively, never on the per-commit hot
  // path. Keeping them off the entry shrinks the per-input
  // allocation (5 fields after #915, plus #994's
  // `hasDependents` boolean for the `tx.set` fast-path gate);
  // matches the lazy-mint discipline PR #929 (#916) applied to
  // SubscriptionEntry. The microbench `op-input-create-1k` paid
  // for both fields on every input creation even when the user
  // never opted into retention or serialization.
}

/**
 * Storage record for a {@link DerivedNode}. Derivations are the read-only half of
 * the two-primitive universe: a Behavior computed from other Behaviors with the
 * denotational definition `derived(f, b₁, …, bₙ)(t) = f(b₁(t), …, bₙ(t))`. The
 * compute function is a pure projection over the dependency snapshot at GraphTime
 * `t`; "kinds" like formula, selector, constraint, or resource are roles a
 * derivation plays at the application layer, not runtime tags this engine sees.
 *
 * @remarks
 * `deps` is rebuilt on every recompute so that conditional reads taking new
 * branches drop stale upstream subscriptions — the type system cannot see across
 * `if`-branches inside a `compute` body, so dynamic-dependency cleanup is closed
 * structurally by replacing the dep-set on every successful evaluation.
 */
interface DerivedEntry {
  readonly kind: 'derived'
  readonly id: NodeId
  readonly compute: Compute<unknown>
  /** Last computed value, valid as of `lastTime`. */
  value: unknown
  /** Whether `value` has ever been computed. */
  computed: boolean
  /** Last time `value` was recomputed. */
  lastTime: GraphTime
  /** Set of node ids this derivation read on its last successful compute. */
  deps: Set<NodeId>
  /**
   * GraphTime at which this derivation was registered (the value of
   * `now` the moment `graph.derived(id, compute)` ran). Anchors the
   * Behavior's domain symmetrically with {@link InputEntry.inputRegisteredAt}:
   * a derivation registered at `t_r` is denotationally defined on
   * `[t_r, ∞)` only — `derived(t)` for `t < t_r` is not "missing data"
   * but undefined per §3, because the Behavior did not exist as an
   * entity in the graph at that moment. `readAt(derived, t)` for
   * `t < t_r` surfaces `{ status: 'evicted', oldestRetainedTime:
   * derivedRegisteredAt }`, mirroring the input-domain branch (#277,
   * #374). Without this field the engine would happily recompute the
   * derivation against the retained input snapshot at `t < t_r` and
   * fabricate a value for a Behavior that did not exist at that time —
   * breaking §3's domain claim and the §15.1 replay-determinism
   * property.
   *
   * #914 — audited as a lazy-mint candidate mirror of #915 (PR #930)
   * and #916 (PR #929): moving this slot to a sibling `Map<NodeId,
   * GraphTime>` populated only when `now > 0` would shrink
   * DerivedEntry from 9 fields to 8 with zero map writes on the
   * common "register-everything-at-genesis" shape the
   * `op-derived-create-1k-fresh` microbench (#868) exercises. The
   * trial captured at
   * `packages/bench/report/derived-create-audit/lazy-mint-trial.json`
   * versus `baseline.json` measures the median-of-trial-medians at
   * ~443 ns/op (baseline) vs ~439 ns/op (trial) across 3-trial
   * flights run back-to-back on the same host (7 trials × 15
   * samples each per capture, median-of-medians aggregation).
   * Per-flight variance is roughly ±10 ns on a ~440 ns median, so
   * the −1% delta sits well inside sampling noise. The single-field
   * reduction does not move the
   * `op-derived-create-1k-fresh` envelope — the cost is dominated
   * by the eager `computeDerivedIterative` evaluation, the
   * `setDeps` reverse-edge writes, and the per-derivation
   * `new Set()` for `deps`, none of which the field-shape audit
   * touches. See PR closing #914 for the full audit body and the
   * baseline / trial JSON captures; this slot is preserved on the
   * entry as a denotationally-load-bearing anchor for the §3
   * Behavior-domain rule.
   */
  readonly derivedRegisteredAt: GraphTime
  /**
   * Optional kind tag. `liveDerived(...)` (devtools) registers nodes
   * with `tag: 'live'` so `graph.explain` reports `via: 'live'` for
   * the hot-swap affordance — the engine's "edit a derivation while
   * it's running, watch the change propagate" promise; without this
   * marker, devtools cannot tell a hot-swappable node apart from a
   * static one (#298 T7). `commitMetadataDerived(...)` registers
   * nodes with `tag: 'commit-metadata'` so the commit pipeline's
   * Phase F.5 post-commit recompute pass knows which derived nodes
   * need to be re-evaluated *after* `commitLogEntry.value` has been
   * refreshed — the seam that lets a derivation read
   * `graph.commitLog` and see the just-completed commit, not the
   * previous one (#452). Plain `derived(...)` leaves this
   * `undefined` and explain reports `via: 'derived'`.
   */
  // Always-set per #703 Win 5 (monomorphize hidden classes); the
  // explicit `| undefined` admits the no-tag case without
  // conditional spread, so plain `derived(...)` and tagged callers
  // share the same V8 hidden class.
  tag: 'live' | 'commit-metadata' | undefined
}

/**
 * Internal entry tag — every node in the engine is exactly one of these two
 * shapes. The previous draft of this engine collapsed eleven `NodeKind` values
 * (formula, selector, constraint, resource, effect, conflict, collection, index,
 * workflow, …) into a runtime taxonomy; this implementation refuses that surface
 * area. A node is its `compute` (or the lack of one). Everything else is
 * composition at the application layer.
 */
type Entry = InputEntry | DerivedEntry

/**
 * Bookkeeping record for a single live {@link createCausl | subscribe}
 * registration. Stores the most recent value the observer was notified with so
 * the engine can apply the per-commit equality cutoff: a transaction that lands
 * on the same final value as the prior commit fires no notification, and a
 * multi-write commit that converges to a single new value fires exactly one
 * notification, not two. That promise — "exactly one notification, not two" —
 * is the worked example's load-bearing invariant.
 */
interface SubscriptionEntry {
  readonly node: AnyNode
  readonly observer: Observer<unknown>
  /** Last value the observer was notified with. */
  lastValue: unknown
  hasFired: boolean
  /**
   * `GraphTime` at which the registration occurred. Pinned at
   * registration so the wire-format event records when the
   * subscription was created, not when it was exported.
   *
   * Retained on the entry (load-bearing) because `now` is only
   * available at registration; we cannot reconstruct it at export.
   */
  readonly subscribedAt: number
  /**
   * One-shot flag set by `subscribe(node, observer, { transient:
   * true })` and `subscribeMany(nodes, observer, { transient: true })`
   * (#766). When `true`, Phase G adds this entry to the engine's
   * `pendingTransientDrops` set after firing the observer; the set is
   * drained at the end of {@link commitInternal} (in a `finally` arm
   * so the auto-dispose still runs when an observer in the same
   * commit later threw). The synchronous initial fire from
   * {@link subscribe} does NOT trigger auto-dispose — only the next
   * Phase G fire does.
   */
  readonly transient: boolean
  /**
   * Multi-node group reference for subscriptions registered via
   * {@link subscribeMany} (#766). When non-null, every entry sharing
   * the same {@link ManyGroup} fires the observer once for the whole
   * group per commit (deduped via a per-commit `firedManyGroups` set
   * in Phase G), and the entire group is the unit of unsubscribe and
   * the unit of transient auto-dispose. Plain {@link subscribe}
   * registrations leave this `null`; the per-node Phase G dispatch
   * still works uniformly because the dedupe set only checks entries
   * whose `manyGroup !== null`.
   */
  readonly manyGroup: ManyGroup | null
}

/**
 * Memory-optimization (#916): observability fields previously stored
 * directly on every {@link SubscriptionEntry} are minted lazily at
 * `exportModel()` time instead. This keeps the per-subscription
 * retained footprint to the load-bearing fields only — `node`,
 * `observer`, `lastValue`, `hasFired`, `subscribedAt`, `transient`,
 * `manyGroup` — at the cost of one cheap counter increment per entry
 * walked during export.
 *
 * Under PR-B1 these fields are constants (`scopeId` =
 * `${graphId}:default`, `callbackSite` = `'<unknown>'`) and the
 * `subscriptionId` only needs uniqueness within a single
 * `exportModel` call; minting at export time preserves every
 * exportModel-events test invariant without retaining a separate
 * id-string-allocation per live subscription. Future PRs that
 * introduce user-supplied scope or a real stack-trace capture will
 * reintroduce a sibling WeakMap to retain the per-entry overrides.
 */

/**
 * Shared bookkeeping across the {@link SubscriptionEntry | entries}
 * registered by a single {@link subscribeMany} call (#766). One per
 * `subscribeMany` invocation; every per-node entry references the
 * same record so Phase G can:
 *
 * - dedupe a multi-write commit that moves several of the group's
 *   nodes (the entries share the {@link observer} reference but the
 *   engine fires it only once per commit per group, mediated by the
 *   per-commit `firedManyGroups` set);
 * - auto-dispose the whole group when {@link transient} is `true`
 *   and any one of its members fires;
 * - drop the whole group atomically from the {@link unsubscribe}
 *   closure returned to the caller.
 */
interface ManyGroup {
  /**
   * Live entries belonging to this group. Mutated in lockstep with
   * {@link subscriptions} and {@link subscriptionsByNode} on group
   * dispose.
   */
  readonly entries: Set<SubscriptionEntry>
  /**
   * Tuple of nodes the group was registered against, in caller order.
   * Used at fire-time to assemble the `values` argument the observer
   * receives — `nodes.map(read)` reads each member's current
   * committed value at `now`.
   */
  readonly nodes: readonly AnyNode[]
  /**
   * The user-supplied observer. Called with a tuple of values, one
   * per `nodes[i]`, at fire-time. Identical reference across every
   * entry in {@link entries} — the dedupe contract relies on object
   * identity.
   */
  readonly observer: (values: readonly unknown[]) => void
  /** Mirror of {@link SubscriptionEntry.transient} for the group. */
  readonly transient: boolean
  /**
   * Idempotency latch — flipped `true` when the group is dropped
   * (either by the user-returned unsubscribe or by transient
   * auto-dispose). Phase G consults this to skip a group that was
   * dropped by an earlier observer in the same commit's dispatch
   * loop.
   */
  disposed: boolean
}

/**
 * Default ring-buffer cap on the in-memory commit history exposed via
 * {@link createCausl | exportModel} and {@link Graph.commitLog}.
 *
 * SPEC §5.1 Amendment 2 (#716, semver-major): the default flips from
 * 1000 to 0. Adopters who consume `graph.commitLog`,
 * `graph.readAt`, or `graph.snapshotAt` must opt in explicitly via
 * `createCausl({ commitHistoryCap: 1000 })` (or any positive
 * integer). The flip pairs with §5.1 Amendment 1 (#715) so the
 * cap=0 path skips Phases F, F.4, F.6 — the per-commit envelope
 * cost is dead work for the 90%+ of adopters who never read the
 * log, and cap=0 makes that the default. See
 * `docs/migration/cap-zero-default.md` for the migration recipe.
 *
 * The retention cap on per-commit snapshots backs {@link Graph.readAt} and
 * {@link Graph.snapshotAt}: any time strictly older than the buffered window
 * resolves to a typed `Evicted` arm rather than a fabricated value. The honesty
 * about bounded retention is structural — the discriminated result forces
 * callers to handle the miss path. The retention cap default also flips to 0
 * under Amendment 2 because Phase F.6 is gated on `commitHistoryCap > 0` —
 * leaving the snapshot cap at 50 with a zero-history cap would be misleading
 * (the snapshot chain would never grow past genesis anyway).
 */
const DEFAULT_COMMIT_HISTORY_CAP = 0
const DEFAULT_SNAPSHOT_RETENTION_CAP = 0

/**
 * Build the engine-instance-scoped freeze helper for a given flag
 * snapshot (#702 / #706). Adopters who set
 * `CAUSL_FREEZE_OFF_IN_PROD=1` (or pass
 * `experimentalFlags: { freezeOffInProd: true }`) accept that the
 * engine will not freeze inner arrays nested inside frozen Commit /
 * Explanation payloads — those values are still readable like any
 * other JS value, but they are not runtime-immutable. Public-surface
 * Commits stay frozen at the outer object boundary unconditionally;
 * this helper covers only the inner defensive copies.
 *
 * @remarks
 * Audit verdict (#702): land as opt-in measurement only; flip the
 * default only if the measured drop on `scrolling-viewport × 10000`
 * AND `batch-commit × 10000` is ≥ 10%. Until then this stays a
 * deliberate opt-in for adopters running with their own
 * immutability discipline.
 *
 * The returned closure captures the flag value once at engine
 * construction; the commit / derivation / explanation hot paths
 * never re-read the flag (or `process.env`) for the engine's
 * lifetime. That is the design contract enforced by the #706b
 * flag-protocol layer.
 */
function makeFreezeIfDev(flags: CauslFlags): <T>(value: T) => T {
  if (flags.freezeOffInProd) {
    return <T>(value: T): T => value
  }
  return <T>(value: T): T => Object.freeze(value)
}

/**
 * Default cap for the disposed-node tombstone map.
 *
 * @remarks
 * `_dispose` records `(id → GraphTime)` so that subsequent reads on a
 * released id surface a typed `NodeDisposedError` rather than the more
 * generic `UnknownNodeError`. Under churn with **fresh ids each
 * lifecycle** (timestamped keys, `family(uuid())`, virtualized-row
 * uuids) the map is a monotonic retention root. The cap mirrors
 * `commitHistoryCap`: insertion-ordered FIFO eviction past the bound.
 * Past the cap, evicted tombstones fall back to `UnknownNodeError`.
 * The trade matches `commitHistory`'s "log rotated" contract: the
 * typed disposal error is most useful immediately after disposal,
 * and the bound is the price of keeping long-running churn bounded.
 */
const DEFAULT_DISPOSED_TOMBSTONE_CAP = 1000

/**
 * Default handler invoked when a user-supplied observer throws during
 * notification. Logs to the console with enough provenance (source phase,
 * triggering node, GraphTime) to diagnose the failure without breaking the
 * commit pipeline. Because `commit` is the engine's *only* mutation entry point
 * — the contract that lets atomicity hold as a theorem rather than a hope — a
 * faulty subscriber must never be able to abort the commit it observes; this
 * handler is the firewall that keeps that invariant.
 *
 * @param error - The value thrown by the observer.
 * @param ctx - Provenance describing the dispatch site that caught the throw.
 */
const defaultOnObserverError: ObserverErrorHandler = (error, ctx) => {
  // Mirror what console.error does for an Error: print prefix + message + stack.

  console.error(
    `[causl] observer threw (${ctx.source}${ctx.nodeId ? ':' + ctx.nodeId : ''} @ t=${ctx.time}):`,
    error,
  )
}

/**
 * Construct the frozen public handle for an input node. The two-primitive
 * design deliberately keeps the public {@link Node} type free of a `kind`
 * discriminator — that taxonomy is class-naming masquerading as a domain
 * model. The handle therefore carries only its identity; input-vs-derived
 * is decided by the engine's internal {@link Entry} table at the call
 * sites that actually need to branch (currently `tx.set` and `getEntry`).
 *
 * @typeParam T - Value type of the input.
 * @param id - Caller-chosen stable identifier within the graph.
 * @returns An immutable {@link InputNode} reference.
 *
 * @remarks
 * #917 audit: V8's `--trace-deopt` surfaces two `marking dependent code
 * ... reason: dependent allocation site tenuring changed` events
 * attributed to this `SharedFunctionInfo` on `causl × scrolling-viewport
 * × 10000`. They are the V8 allocation-site feedback loop retuning the
 * `Object.freeze({ id })` literal from young-gen to old-gen as the bench
 * harness allocates 10000 long-lived input handles in a tight loop —
 * MAGLEV's first compile assumes young, the second wave of survivors
 * forces a retune to old, and the third compile stabilises. The marker
 * we see is the construction-phase *transition*, not a steady-state
 * penalty: the per-commit `scrolling-viewport` step loop never re-enters
 * `makeInputNode`. Documented as a negative finding per the #883/#881
 * precedent in `packages/bench/report/engine-status-deopts/SUMMARY.md`;
 * any future PR that introduces a per-commit InputEntry-shaped
 * allocation must reconfirm the steady-state cost here before merging.
 */
function makeInputNode<T>(id: NodeId): InputNode<T> {
  return Object.freeze({ id }) as InputNode<T>
}

/**
 * Construct the frozen public handle for a derived node. The handle
 * carries only its identity; the compute function and dependency
 * state live exclusively in the engine's {@link DerivedEntry}.
 *
 * @typeParam T - Value type produced by the derivation.
 * @param id - Caller-chosen stable identifier within the graph.
 * @returns An immutable {@link DerivedNode} reference.
 */
function makeDerivedNode<T>(id: NodeId): DerivedNode<T> {
  return Object.freeze({ id }) as DerivedNode<T>
}

/**
 * Construct a fresh {@link InputEntry} record for the engine's
 * forward-index `entries` Map. Carries the input's seed value plus
 * the bookkeeping fields the per-commit hot path consults.
 *
 * @remarks
 * #1014 pre-tenure: extracted from the inline literal that previously
 * lived inside `input()` so the InputEntry hidden-class allocation
 * site has a single, module-level source position. The
 * {@link pretenureInputAllocationSites} warmup runs this helper a few
 * thousand times the first time any consumer calls {@link createCausl}
 * in a process; that drives V8's allocation-site feedback into the
 * old-gen-tenured steady state BEFORE the user's measured workload
 * begins, eliminating the two `dependent allocation site tenuring
 * changed` MAGLEV deopts that previously surfaced on `causl ×
 * equality-cutoff × 10000` (#1014, post-#917 audit revisited).
 *
 * The literal property order is identical to the previous inline
 * literal in `input()`; appending a field (or reordering one) here
 * regresses the V8 hidden-class monomorphism guarantee documented at
 * the {@link InputEntry} interface (#915 / #994 / #995). Add new
 * fields at the bottom of the literal *and* the bottom of the
 * {@link InputEntry} interface declaration in lockstep.
 *
 * @typeParam T - Value type carried by the input.
 * @param id - Stable identifier of the input within the graph.
 * @param value - Seed value (input(t₀)).
 * @param lastWriteTime - GraphTime stamped on the entry's value.
 * @param node - The frozen public handle returned by
 *   {@link makeInputNode}.
 * @returns A freshly-allocated {@link InputEntry} ready for insertion
 *   into the engine's `entries` Map.
 */
function makeInputEntry<T>(
  id: NodeId,
  value: T,
  lastWriteTime: GraphTime,
  node: InputNode<unknown>,
): InputEntry {
  // Property order matches `InputEntry`'s field declaration order so
  // V8's hidden-class transition stays monomorphic across every
  // call site (see #915 / #994 / #995 audit comments on the
  // interface).
  return {
    kind: 'input',
    id,
    value,
    node,
    lastWriteTime,
    // #994 — every freshly-registered input starts with no derived
    // consumers. Edges flip this true on the first `setDeps` add and
    // back to false on the last edge remove.
    hasDependents: false,
    // #995 — split-staged read-shadow sentinel. `-1` is the
    // never-staged value; `tx.set`'s slow path stamps `now` on first
    // stage. See InputEntry's field comment for the lifecycle
    // rationale.
    lastStagedAt: -1,
    lastStagedRow: -1,
  }
}

/**
 * Process-wide latch ensuring the {@link pretenureInputAllocationSites}
 * warmup runs at most once, on the first {@link createCausl} call in
 * the process. Subsequent `createCausl` calls find the latch tripped
 * and skip the warmup loop, paying zero allocation cost (#1014).
 */
let pretenureLatchTripped = false

/**
 * Default warmup cardinality for the {@link pretenureInputAllocationSites}
 * loop. Set to `2 ×` the bench-gate scale (`equality-cutoff × 10000`)
 * so V8's allocation-site feedback retunes the
 * {@link makeInputNode}, {@link makeInputEntry} and per-instance
 * `input()` (closure-captured) sites past the young→old transition
 * before any user-measured workload runs (#1014 / #1123).
 */
const PRETENURE_WARMUP_COUNT = 20_000

/**
 * One-shot warmup that drives V8's allocation-site feedback for the
 * {@link makeInputNode} (`Object.freeze({ id })`),
 * {@link makeInputEntry} (InputEntry literal) and the per-instance
 * `input()` (closure-captured InputEntry write into `entries`) call
 * sites into their old-gen-tenured steady state.
 *
 * @remarks
 * #1014 — Background: pre-#1014 the post-wave engine-status audit on
 * `causl × equality-cutoff × 10000` surfaced four `dependent allocation
 * site tenuring changed` MAGLEV deopts (`input` ×2 + `makeInputNode`
 * ×2). Sequence per #917 audit:
 *
 *   1. V8's first MAGLEV compile assumes young-gen for the literals.
 *   2. The bench harness allocates `N=10000` long-lived inputs; survival
 *      statistics force V8 to retune to old-gen and invalidate the
 *      compilation.
 *   3. V8 recompiles with the old-gen assumption and stabilises.
 *
 * The retune *transition* is what the deopt log captures, not a
 * steady-state penalty. But the transition still costs the bench
 * harness a real ~0.1-0.2 ms on the measured cell because it lands
 * inside the user's tight allocation loop.
 *
 * Mitigation: run a process-wide warmup loop the first time a
 * consumer constructs a graph. The loop calls
 * {@link makeInputNode} + {@link makeInputEntry} `2 ×` the bench-gate
 * scale, allocating handles that are immediately discarded (no
 * reference held; the next minor GC reclaims them). V8 observes the
 * survival ratio go to ~0 once the warmup finishes, but the same
 * call sites have already been MAGLEV-recompiled at the steady-state
 * old-gen tenuring decision; subsequent user-driven `input()` calls
 * pay nothing further.
 *
 * The warmup is process-wide (`pretenureLatchTripped` module-level)
 * because V8's allocation-site feedback is per `SharedFunctionInfo`,
 * which is a module-scope identity; running the warmup per
 * `createCausl` would reload the same retune on the same SFI, which
 * is wasted work. A single one-shot at first construction is the
 * smallest unit that makes the engine status report drop the four
 * deopts to zero on `equality-cutoff × 10000`.
 *
 * #1123 follow-up: the post-#1036 engine-status audit
 * (`packages/bench/report/engine-status.md`) surfaced a *new*
 * `dependent allocation site tenuring changed` pair on `input` (×2)
 * alongside the surviving `makeInputNode` (×2) pair. The post-wave
 * Eich/Horwat ship-verdict panel attributed this to V8 attributing
 * the InputEntry allocation site to its enclosing SFI (`input` —
 * the closure-captured per-instance function inside `createCausl`),
 * not just the inner `makeInputEntry` SFI #1036 already warmed. The
 * fix here is to also drive `input()` directly: we construct a
 * throwaway graph (re-entering {@link createCausl}; the latch
 * already-tripped above short-circuits the recursive
 * `pretenureInputAllocationSites` call) and register
 * {@link PRETENURE_WARMUP_COUNT} inputs on it. The throwaway graph
 * is dropped on warmup return; V8 reclaims it at the next minor GC,
 * but the SFI-keyed allocation-site feedback for the `input()`
 * closure has already converged on the old-gen tenuring decision
 * by then. Per-instance `input()` functions allocated by later
 * `createCausl()` calls share the same source position and SFI as
 * the warmup throwaway's `input`, so the feedback ledger entry
 * transfers without a retune.
 *
 * Why not a class-form refactor of `InputEntry`? The #917 audit
 * (`packages/bench/report/engine-status-deopts/SUMMARY.md` §3) tried
 * the allocate-via-prototype / class-form alternatives and concluded
 * V8's allocation-site feedback still observes the survival
 * statistics on the resulting handle and retunes — the
 * transition would still happen, just attributed to a different SFI.
 * The class-form path also breaks the `#703 Win 5` hidden-class
 * monomorphism guarantee that gates #735. The warmup approach
 * preserves both the literal shape and the monomorphism contract
 * while eliminating the user-visible deopt.
 *
 * Cost: ~20 000 raw {@link makeInputNode} + {@link makeInputEntry}
 * allocations + ~20 000 closure-driven `input()` calls (which run
 * through the engine's `entries.set` / `inputCount++` /
 * `inputRegisteredAtMap` bookkeeping), plus the construction cost of
 * one throwaway `createCausl()` graph. All paid once per process at
 * the first `createCausl()` call. Empirically ~5-8 ms on a modern
 * laptop; amortises to zero across the lifetime of any program that
 * constructs more than one engine OR one engine with more than ~100
 * inputs.
 */
function pretenureInputAllocationSites(): void {
  if (pretenureLatchTripped) return
  pretenureLatchTripped = true
  // The warmup discards every allocation: the `node` and `entry`
  // bindings live only inside the loop body, so the next minor GC
  // reclaims them. The allocation events themselves are what V8's
  // site-feedback ledger counts; the resulting objects are
  // immediately unreachable.
  //
  // `Object.freeze` (called inside `makeInputNode`) has observable
  // side effects on the resulting object's prototype/extensibility,
  // which V8's optimiser conservatively treats as a non-removable
  // call — that anchors the loop body against DCE without needing
  // an explicit sink slot. (An earlier draft pushed the entry
  // identity through a module-level `unknown` slot; the slot
  // introduced its own `dependent field type constness changed`
  // deopt on the warmup function as V8 retuned the slot's hidden-
  // type representation across the loop. Removing the sink kept
  // the warmup deopt-clean while the freeze call alone defeats the
  // optimiser's DCE pass.)
  for (let i = 0; i < PRETENURE_WARMUP_COUNT; i++) {
    const id = `__causl_pretenure__:${i}`
    const node = makeInputNode<unknown>(id)
    // Seed the warmup InputEntry with a Smi `value` (rather than
    // `undefined`) so V8's type-feedback ledger for the
    // `makeInputEntry` allocation site converges on the same Smi
    // shape the bench harness exercises (`g.input(id, i)` writes
    // integer counters in every measured scenario). Seeding with
    // `undefined` was observed to introduce a separate `Smi`-flavour
    // MAGLEV deopt on the first user-driven `input()` call as V8
    // retuned the `value` field's representation from `undefined` to
    // Smi (#1014 follow-up — engine-status capture pre-fix surfaced
    // this transition once on `equality-cutoff × 10000`).
    makeInputEntry<number>(id, i, 0, node as InputNode<unknown>)
  }
  // #1123 — Drive the per-instance `input()` SFI through its own
  // warmup. The latch above is already `true` so the recursive
  // `createCausl()` call below short-circuits the
  // `pretenureInputAllocationSites` body inside the throwaway
  // construction (no infinite recursion). We register
  // PRETENURE_WARMUP_COUNT inputs on the throwaway graph so V8's
  // allocation-site feedback for the closure-captured `input`
  // function converges on the same old-gen tenuring decision the
  // bench harness's `equality-cutoff × 10000` workload drives — the
  // SFI is shared across every `createCausl()` instance because the
  // source position is identical, so the feedback transfers to the
  // caller's measured graph without a retune.
  //
  // The throwaway graph is local; it goes out of scope at function
  // return and the next minor GC reclaims it. Construction cost
  // (commit-history / snapshot-retention rings, deps Maps, etc.)
  // is ~1-2 ms — well-amortised by the PRETENURE_WARMUP_COUNT input
  // registrations that follow.
  const warmupGraph = createCausl()
  for (let i = 0; i < PRETENURE_WARMUP_COUNT; i++) {
    // Seed with a Smi `value` (matching `makeInputEntry` seed above)
    // so the `input()` body's `entries.set(id, makeInputEntry<T>(...))`
    // call observes the same hidden-class monomorphism the bench
    // harness exercises.
    warmupGraph.input(`__causl_pretenure_input__:${i}`, i)
  }
}

/**
 * Regex pattern for valid `graphId` values.
 *
 * @remarks
 * Per SPEC.md §16.2.1.5, the intersection of "safe in JSON",
 * "safe in URL fragments", and "safe in filesystem paths". The
 * runtime validator (`createCausl({ name })`) and the schema-3
 * migration codemod both consume this constant so a regex drift
 * between them is impossible by construction. A unit test asserts
 * the source string is exactly `^[A-Za-z0-9_.:-]{1,256}$` to catch
 * a future PR that loosens the constraint without coordinating.
 */
export const GRAPH_ID_REGEX: RegExp = /^[A-Za-z0-9_.:-]{1,256}$/

/**
 * Construct a fresh Causl graph at GraphTime t₀ = 0.
 *
 * Implements the canonical primitive surface — `input`, `derived`, `commit`,
 * `read`, `subscribe`, `subscribeCommits`, `explain` — plus the second-tier
 * extensions `commitLog`, `exportModel`, `simulate`, `snapshot`, `snapshotAt`,
 * `hydrate`, `readAt`, and the `now` accessor. Each non-canonical
 * row earned its slot by naming a concept the engine cannot otherwise express:
 * the commit log realises the "transaction log is a Behavior" promise; export
 * is the bridge to the bounded model checker; `simulate` is the §5 dry-run
 * API that lets a caller predict a commit's effect without committing;
 * snapshot/hydrate/readAt are SSR
 * transfer, persistence, and time-travel; `now` lets external observers ask
 * "what time is it?" without firing a commit.
 *
 * @param options - Engine-wide knobs: history cap and observer-error handler.
 * @returns A {@link Graph} instance whose lifetime is owned by the caller.
 *
 * @remarks
 * The closure returned here owns every piece of mutable state the engine
 * touches. There is no module-level state and no implicit singleton — each
 * call yields an independent universe with its own GraphTime. This is the
 * smallest example the engine must support: an input, a derivation, a
 * subscription, and a commit that fires exactly one notification when the
 * downstream value actually changes. If this works, the engine is real;
 * everything else is downstream of getting it right.
 *
 * @example
 * ```ts
 * const graph = createCausl()
 * const a = graph.input('a', 1)
 * const b = graph.input('b', 2)
 * const sum = graph.derived('sum', (get) => get(a) + get(b))
 * graph.subscribe(sum, (v) => console.log(v)) // 3
 * graph.commit('bump', tx => tx.set(a, 10))   // 12
 * ```
 */
export function createCausl(options: CreateCauslOptions = {}): Graph {
  // Backend selector (#1072). `backend === 'auto'` dispatches into the
  // auto-adapt wrapper, which holds a real TS engine as its `inner`
  // and may migrate to the WASM backend at runtime once the
  // {@link shouldMigrate} heuristic trips. The wrapper module is
  // imported lazily-via-direct-import here (not dynamic-import) so
  // the wrapper's source is part of the main bundle but the
  // `@causl/core/wasm` entry point it lazy-loads on migration stays
  // out of the main bundle. The wrapper re-enters `createCausl` with
  // the `backend` field stripped, so this dispatch is non-recursive.
  if (options.backend === 'auto') {
    return createAutoAdaptGraph(
      (innerOptions) => createCausl(innerOptions),
      options,
    )
  }
  // #1014 / #1123 — Process-wide one-shot warmup that drives V8's
  // allocation-site feedback for `makeInputNode`, `makeInputEntry`
  // AND the closure-captured `input()` SFI into the old-gen-tenured
  // steady state BEFORE the user's measured workload begins. The
  // latch (`pretenureLatchTripped`) ensures only the first
  // `createCausl()` call in a process pays the cost; every
  // subsequent construction returns from the function in O(1) without
  // looping. Eliminates the four `dependent allocation site tenuring
  // changed` MAGLEV deopts the post-wave engine-status audit
  // surfaced on `causl × equality-cutoff × 10000` (#1014), plus the
  // two new `input` events the post-wave Eich/Horwat ship-verdict
  // panel surfaced after #1036 landed (#1123).
  pretenureInputAllocationSites()
  // Bind option defaults at construction; later mutation of `options` has no effect.
  const commitHistoryCap = options.commitHistoryCap ?? DEFAULT_COMMIT_HISTORY_CAP
  const snapshotRetentionCap =
    options.snapshotRetentionCap ?? DEFAULT_SNAPSHOT_RETENTION_CAP
  const disposedTombstoneCap =
    options.disposedTombstoneCap ?? DEFAULT_DISPOSED_TOMBSTONE_CAP
  const onObserverError = options.onObserverError ?? defaultOnObserverError
  // `strictCycles` is preserved for backward compatibility but is a
  // **no-op** as of #670/#705. SPEC §9.1's race-class catalogue
  // commits to "Detected at the first commit that closes the cycle,
  // with a structured error naming the cycle path"; the previous
  // strict-mode gate (#360) walked an O(|nodes|) DFS at every
  // `derived()` call to force upstream recomputes, which was both
  // O(N²) on chains AND blew the V8 stack past ~10000 nodes. First-
  // commit-time Phase D Kahn detection (#705) plus the in-flight
  // `currentlyProcessing` guard during commit drain (#705) cover the
  // same race-class without the registration-time cost. The option
  // remains accepted for one major version so adopters do not have to
  // edit construction sites; future amendment 2 (#705 follow-up) may
  // remove it.
  const _strictCyclesDeprecated = options.strictCycles ?? true
  // Resolve the engine-instance flag snapshot: process-wide
  // {@link MODULE_FLAGS} merged with per-instance `experimentalFlags`
  // overrides (#706b). Construction-time merge only — the engine's
  // commit / derivation / explanation hot paths capture the bound
  // {@link freezeIfDev} closure below and never re-read `process.env`
  // (or this `flags` object) for the engine's lifetime.
  const flags = mergeFlags(options.experimentalFlags)
  // Engine-instance-scoped freeze helper. Captures the resolved flag
  // value once at construction. See {@link makeFreezeIfDev} for the
  // gating contract — the inner array freezes are the only ones this
  // helper covers; outer Commit / Explanation objects stay frozen
  // unconditionally at the public-surface boundary.
  const freezeIfDev = makeFreezeIfDev(flags)
  // #1155 / #1241 — H1 hazard warning (SPEC §15.1). Per
  // `docs/wasm-backend-adopter-audit.md`, the load-bearing adopter
  // hazard surfaced by the Markbåge/Miller panel review of #1133 is
  // holding a `graph.read(node)` return value across a commit
  // boundary: reference-identity is not guaranteed, so a cached
  // reference can silently desynchronise from the live cell. The
  // dev-only WeakRef instrumentation here catches the hazard at
  // runtime with a `console.warn`. The warning never throws — it is
  // informational only, preserving backward compatibility with
  // adopters who deliberately cache `read()` values (PR #1129
  // amended SPEC §15.1 to make the non-guarantee explicit; this is
  // the runtime safety net).
  //
  // #1241 — the default is now **`false`** (opt-in). PR #1238
  // originally shipped with an auto-detected dev/prod default, but
  // the canonical `@causl/react` adapter retains the `read()` return
  // inside `useSyncExternalStore`'s snapshot cache for tearing
  // detection — that single retained reference triggered the
  // warning on every commit for any adapter usage. Adopters who
  // want the dev safety net opt in via
  // `createCausl({ enableH1HazardWarning: true })`. The
  // adapter-exemption seam below (the `adapterReadDepth` counter)
  // keeps the opt-in path honest for adopters who legitimately want
  // the warning AND use `@causl/react`'s canonical hooks: the
  // adapters bracket their `getSnapshot` boundary so reads inside
  // are exempted from H1 tracking.
  const enableH1HazardWarning =
    options.enableH1HazardWarning ?? false
  /**
   * #1155 — H1 hazard tracking ring. Each entry records a WeakRef
   * to a value returned by {@link read} together with the GraphTime
   * at which the value was observed and the offending nodeId.
   *
   * @remarks
   * Engine-closure scoped: allocated once at construction, grown by
   * `read()` on every qualifying call (non-null object/function;
   * primitive returns are not WeakRef-trackable and are skipped).
   * Drained at the end of {@link commitInternal}'s success arm
   * after `now += 1`: any entry whose `capturedAt < now` AND whose
   * WeakRef still has a live referent represents an adopter holding
   * the read return across a commit boundary, and earns a single
   * `console.warn`. Dead refs (deref() returns undefined) are
   * pruned in the same walk so the list does not grow unbounded
   * over the engine's lifetime. The list is also pruned-and-checked
   * incrementally on the cap boundary to bound worst-case walk
   * cost; see {@link H1_HAZARD_TRACK_CAP}.
   *
   * The whole structure is `null` when `enableH1HazardWarning` is
   * false (production default), so the `read()` hot path pays
   * exactly one nullable check in the prod build — no WeakRef
   * allocation, no Array push, no extra closure capture. The
   * commit-boundary walk is short-circuited on the same null check.
   */
  interface H1HazardRecord {
    readonly ref: WeakRef<object>
    readonly nodeId: NodeId
    readonly capturedAt: GraphTime
  }
  // #1241 — wrap the H1 hazard allocation in a literal
  // `process.env.NODE_ENV !== 'production'` block so esbuild / terser
  // can DCE the WeakRef apparatus in production builds. The bundler
  // sees the constant `'production'` after substitution; the dead
  // branch (and every helper closure inside) drops from the prod
  // bundle. In dev / test the branch evaluates to true, and the
  // tracker materialises iff `enableH1HazardWarning` opted in.
  let h1HazardTrack: H1HazardRecord[] | null = null
  if (process.env.NODE_ENV !== 'production') {
    h1HazardTrack = enableH1HazardWarning ? [] : null
  }
  // #1241 — adapter-exemption seam. Canonical `@causl/react` hooks
  // call `graph.read(node)` from inside `useSyncExternalStore`'s
  // `getSnapshot` callback, which React invokes during render AND
  // retains across commits for tearing detection. The retention is
  // intrinsic to the adapter contract, not an adopter bug — so the
  // H1 tracker must skip reads originating inside that boundary.
  //
  // The seam is a single closure-scoped counter incremented by the
  // adapter via the internal-dispatch entrypoint
  // `runInAdapterReadMode(fn)`. When the counter is non-zero the
  // `read()` hot path's H1 instrumentation is short-circuited
  // exactly as it is for `activeReadTracker`-windowed reads. The
  // counter is a depth (not a boolean) so nested adapter calls
  // compose correctly — a hook that reads through another hook's
  // selector still suppresses tracking for the whole sub-tree.
  //
  // The seam is INTERNAL: it lives behind `@causl/core/internal`'s
  // `__causlAdapterRead(graph, fn)` helper and is NOT part of the
  // public `Graph` interface. Adopters MUST NOT depend on the
  // shape — the next adapter primitive (e.g., a fence around
  // `subscribe` callbacks) may extend the same counter or split it.
  let adapterReadDepth = 0
  // Validate and bind the graph name (schema-3 graphId source).
  // Application-supplied wins; absence falls back to UUID v4. The
  // regex pattern is exported as {@link GRAPH_ID_REGEX} so the
  // schema-3 migration codemod imports the same source of truth and
  // a regex drift between the runtime validator and the codemod is
  // impossible by construction.
  if (options.name !== undefined && !GRAPH_ID_REGEX.test(options.name)) {
    throw new InvalidGraphNameError(options.name)
  }
  // `graphId` is read-only on the graph instance for the lifetime of
  // the engine. There is no public mutator and no rebrand operation;
  // re-keying nodes onto a different graph is a different graph.
  // Fallback minter uses the WebCrypto `randomUUID` (Node ≥14.17 +
  // modern browsers). The 122-bit UUID v4 collision space is the
  // structural defence against accidental id-reuse across two
  // un-named graphs in the same process.
  const graphId: string = options.name ?? mintGraphIdUuid()

  function mintGraphIdUuid(): string {
    // `globalThis.crypto?.randomUUID()` is available in Node ≥14.17
    // and every evergreen browser. The optional chain keeps the
    // fallback inert in environments that ship only `subtle`.
    const fromCrypto = globalThis.crypto?.randomUUID?.()
    if (fromCrypto !== undefined) return fromCrypto
    // Pure-JS fallback for runtimes without `randomUUID` (legacy
    // bundlers, sandboxed JS engines). RFC 4122 v4 layout: 128 bits
    // of `Math.random` with the version (`4`) and variant (`8|9|a|b`)
    // nibbles fixed.
    const hex = '0123456789abcdef'
    let s = ''
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        s += '-'
      } else if (i === 14) {
        s += '4'
      } else if (i === 19) {
        s += hex[(Math.random() * 16) & 0x3 | 0x8]
      } else {
        s += hex[(Math.random() * 16) | 0]
      }
    }
    return s
  }
  /**
   * Per-commit input snapshots for `readAt(t)`, structurally shared as a
   * delta-chain (#235). Each row owns a `delta` of *only* the input ids whose
   * values changed at that commit; resolution walks `prev` until a row owns
   * the requested id. Memory grows in `O(N_inputs + changed_cells × R)`
   * rather than the pre-#235 `O(N_inputs × R)` — the §16.6 perf bound that
   * makes `readAt` affordable as a second-tier surface (§12.2).
   *
   * @remarks
   * `prev` is null for the chain root (the oldest still-retained row). On
   * FIFO eviction the dropped row's deltas are folded into the new root for
   * any ids the new root doesn't already define, so each row is self-
   * contained as a chain root the moment it becomes one. That promotion is
   * `O(N_changed_cells_along_chain)` once per eviction and amortises to
   * `O(1)` per commit because each cell can only be promoted to the chain
   * root at most once before being overwritten by a later delta.
   */
  interface RetainedRow {
    readonly time: GraphTime
    delta: Map<NodeId, unknown>
    prev: RetainedRow | null
  }
  const retainedSnapshots: RetainedRow[] = []

  /**
   * Resolve an input id against a retained row, walking the delta chain
   * until a row owns the id (or the chain runs out).
   *
   * @param row - The row whose effective input set is being queried.
   * @param id - The input id to resolve.
   * @returns `{ found: true, value }` if any row in the chain owns the id;
   *  `{ found: false }` otherwise (id was registered after this row's time
   *  or was non-serialisable at every commit since registration).
   */
  function resolveRetained(
    row: RetainedRow,
    id: NodeId,
  ): { found: true; value: unknown } | { found: false } {
    let cur: RetainedRow | null = row
    while (cur !== null) {
      if (cur.delta.has(id)) return { found: true, value: cur.delta.get(id) }
      cur = cur.prev
    }
    return { found: false }
  }

  /**
   * Materialise the effective input set at a retained row by walking the
   * chain top-down. Used by surfaces that need a flat `Record<NodeId,
   * unknown>` (e.g. `snapshotAt`'s on-the-wire envelope). The walk is
   * `O(R × cells_in_chain)` worst-case but typically `O(N_inputs)` because
   * the chain is short (≤ R rows) and each cell appears at most once in
   * the materialised output.
   */
  function materialiseRetained(row: RetainedRow): Record<NodeId, unknown> {
    const out: Record<NodeId, unknown> = {}
    // Walk top-down so the most recent (closest-to-row) value wins —
    // older rows along the chain are fall-throughs only for ids the
    // top hasn't already claimed.
    let cur: RetainedRow | null = row
    while (cur !== null) {
      for (const [id, v] of cur.delta) {
        if (!(id in out)) out[id] = v
      }
      cur = cur.prev
    }
    return out
  }

  // Forward index: id → {input | derived} entry. The single source of truth for node existence.
  const entries = new Map<NodeId, Entry>()
  /**
   * #915 — sibling map for the `inputRegisteredAt` GraphTime,
   * lazy-minted at registration only when `now > 0` (i.e., the input
   * was registered after at least one commit advanced the clock).
   * For the common case of all inputs registered at genesis (now=0),
   * the map stays empty and `readAt`'s domain check falls back to 0.
   * Storing this off the InputEntry collapses the per-input
   * allocation from 7 fields to 5 — matches the lazy-mint discipline
   * PR #929 (#916) applied to SubscriptionEntry.
   */
  const inputRegisteredAtMap = new Map<NodeId, GraphTime>()
  /**
   * #915 — sibling map for the {@link isSerializable} verdict cache
   * on input values. "Not in map" means "unknown / not yet probed"
   * (the previous `serializableMemo === undefined` state); a
   * present `true`/`false` is the cached verdict reused on every
   * subsequent Phase F.6 retention pass and every {@link exportModel}
   * / {@link snapshot} call until the next `tx.set` write deletes it.
   *
   * @remarks
   * #703 Win 1 (the original cache) is preserved by this sibling
   * map: Phase F.6 still pays `JSON.stringify(value)` exactly once
   * across the input's lifetime instead of every commit. The
   * structural invariant is unchanged — the cache is invalidated
   * only when {@link InputEntry.value} mutates (commit Phase B,
   * commit catch-arm rollback, simulate Phase B, simulate
   * unconditional rollback). Concurrent in-place mutation of the
   * value outside the engine remains a contract violation.
   *
   * Off-entry storage means inputs that never serialize (the
   * common case for the `op-input-create-1k` microbench and any
   * adopter who never opts into `commitHistoryCap > 0` /
   * `exportModel` / `snapshot`) pay nothing for the cache slot —
   * neither at registration nor on `tx.set`'s `delete` (`Map.delete`
   * on a missing key is O(1) and ~free).
   */
  const inputSerializableMemo = new Map<NodeId, boolean>()
  /**
   * Set of derived ids registered through {@link Graph.commitMetadataDerived}
   * — the §11 "first-class derived for inspection" seam (#452).
   *
   * @remarks
   * Phase D's recompute walks the affected sub-graph *before* Phase F.4
   * has refreshed `commitLogEntry.value`, so a derivation that reads
   * `graph.commitLog` would see the previous commit's array. Phase F.5
   * runs a *second* recompute pass restricted to the ids in this set,
   * by which point `commitLogEntry.value` has been updated and `now`
   * stamps the just-completed commit. The set is the seed for that
   * pass; iteration order is registration order. Ordinary deriveds
   * are intentionally NOT widened into by Phase F.5 — they settled
   * in Phase D against the prior `commitLog` value and re-running
   * them now would tear the §3 atomicity contract for code that did
   * not opt in. Application code that needs an ordinary derived to
   * track a commit-metadata derived's output composes the
   * commit-metadata derived as a leaf node and reads it on the next
   * commit, when Phase D will have caught up.
   */
  const commitMetadataIds = new Set<NodeId>()
  /**
   * Memoised handles for `graph.explain(node)` keyed by the synthetic
   * explainer id `__explain__:<nodeId>`. Two calls with the same target
   * return the same `DerivedNode<Explanation>` reference (#298 T6).
   */
  const explainHandles = new Map<NodeId, DerivedNode<Explanation>>()
  /** Reverse-dependency graph: for each node, the set of derived ids that read it. */
  const dependents = new Map<NodeId, Set<NodeId>>()
  /**
   * Disposed-node tombstones: id → GraphTime at which disposal was recorded.
   * Lookups on disposed ids surface {@link NodeDisposedError} rather than
   * {@link UnknownNodeError} so adapter code can distinguish a released node
   * from one that was never registered. Disposal itself is an adapter-level
   * concern — the React `useCauslFamily` hook owns the concept of "this
   * node's lifetime is bounded by a component's mount" — and is therefore
   * reachable only via the internal-dispatch entry point, never the public
   * Graph interface.
   *
   * Bounded by `disposedTombstoneCap` (default
   * {@link DEFAULT_DISPOSED_TOMBSTONE_CAP}) under FIFO insertion-order
   * eviction. The shape mirrors {@link commitHistory}'s ring: a long-running
   * process that mints fresh ids each lifecycle (timestamped keys,
   * `family(uuid())`, virtualized-row uuids) does not accumulate tombstones
   * without bound. Past the cap, an evicted tombstone falls back to
   * {@link UnknownNodeError} — accepted because the typed disposal error
   * is most useful immediately after disposal, not after the ring has
   * rotated through `cap` later disposals (#251).
   *
   * JS `Map` iteration is insertion-ordered, so the eviction primitive
   * is `disposed.delete(disposed.keys().next().value)` against the head
   * of the iterator — no parallel ring buffer required.
   */
  const disposed = new Map<NodeId, GraphTime>()
  // Per-node subscriptions deliver the value-changed notifications that turn
  // the engine's `derived` results into a live signal: the equality cutoff
  // applied during commit means an observer fires at most once per commit and
  // only when its node's value actually changes.
  const subscriptions = new Set<SubscriptionEntry>()
  /**
   * Per-node subscriber index (#671). Maps each subscribed node id
   * to the set of {@link SubscriptionEntry} entries observing it,
   * so Phase G can dispatch in O(|changed| × subs/node) instead of
   * O(|subscriptions|). The flat `subscriptions` Set above remains
   * the source of truth (used by snapshot/clear paths); this Map
   * is a derived view maintained at subscribe + unsubscribe time.
   *
   * Bench impact (audit prediction): the post-change
   * `scrolling-viewport × 10000` cell with 10000 subscribers and
   * 100 changed cells per commit moves from 54.9ms (10k Set walk
   * × 100 commits) toward the floor at ~5.5ms.
   */
  const subscriptionsByNode = new Map<NodeId, Set<SubscriptionEntry>>()
  /**
   * Per-commit "to-drop" set populated by Phase G when a transient
   * subscription fires (#766). Drained at the end of {@link commit}
   * (in a `finally` arm so auto-dispose still runs when an observer
   * threw earlier in the same dispatch loop), removing each entry
   * from {@link subscriptions} and {@link subscriptionsByNode} and
   * latching its {@link ManyGroup}'s `disposed` flag when the entry
   * belongs to a `subscribeMany` group.
   *
   * Membership is per-entry, not per-group: when a many-group fires,
   * Phase G walks the group's `entries` and adds every member to this
   * set, so a single drain pass cleans up the whole group without
   * group-aware logic in the drain loop itself.
   */
  const pendingTransientDrops = new Set<SubscriptionEntry>()
  // #916 — subscription ids are minted lazily at `exportModel` time;
  // the registration-time counter that previously seeded the
  // per-entry `subscriptionId` field is no longer needed because no
  // load-bearing path consumes the id outside of export. See the
  // `SubscriptionEntry` and `exportModel` comments for context.
  // Per-commit observers, invoked once per published commit regardless of value changes.
  // This is the narrow-capability adapter primitive — devtools, persistence, and
  // SSR-hydrate listeners want "wake me on any change" without holding the full log.
  const commitObservers = new Set<(commit: Commit) => void>()
  /**
   * `subscribeReads` registry (#701, SPEC §11.1 amended). Each entry
   * pairs a projection closure with the read-set the engine captured
   * the last time it ran the projection under {@link activeReadTracker}.
   * Phase G walks this map alongside the per-node subscriber index:
   * for each registration it tests `changed ∩ recordedDeps !== ∅`,
   * re-runs the projection (which refreshes `recordedDeps` to absorb
   * conditional-read branch flips), and dispatches the observer with
   * the freshly-computed value. The dispatch shape is O(|changed| ×
   * registrations-per-node) once we mirror the dep edges into
   * {@link subscribeReadsByNode} below — the same shape as the per-
   * node subscriber index from #671.
   */
  interface SubscribeReadsRegistration {
    readonly observer: (commit: Commit, value: unknown) => void
    readonly projection: () => unknown
    /** Read-set captured by the most recent projection run. */
    recordedDeps: Set<NodeId>
  }
  const subscribeReadsRegistrations = new Set<SubscribeReadsRegistration>()
  /**
   * Per-node index over `subscribeReadsRegistrations` (mirrors the
   * #671 optimisation for per-node subscribers). Maintained at
   * registration + on every projection re-run by
   * {@link reconcileProjectionDeps}; Phase G dispatch walks it via
   * the same `changed → bucket` lookup the per-node subscriber
   * dispatch already uses, so the projection fan-out is O(1) per
   * commit when no recorded dep is in `changedNodes`.
   */
  const subscribeReadsByNode = new Map<NodeId, Set<SubscribeReadsRegistration>>()
  /**
   * Active read-tracker for the currently-executing
   * {@link subscribeReads} projection. When non-null,
   * {@link readEntry} appends every visited node id into this Set so
   * the engine learns the projection's read-set without an explicit
   * `get` accessor — the projection is plain JS that calls
   * `graph.read(node)`. Outside the projection window the field is
   * `null`; the read hot-path test is one nullable check per call.
   *
   * The same hook composes with {@link computeDerived}'s tracking
   * `get` because that path uses its own `nextDeps` set built up by
   * the `get` closure rather than this tracker; the two never
   * collide. (A projection that itself reads a derived node still
   * adds the derived id to the projection tracker — `readEntry`
   * runs after `computeDerived` returns and the tracker captures
   * what the projection asked for, not what the derived's compute
   * read internally.)
   */
  let activeReadTracker: Set<NodeId> | null = null
  // Bounded ring of recent commits, exposed through `exportModel` and through the
  // engine-owned `commitLog` derived node. The bound is what makes the inspection
  // primitive affordable in a long-running host process.
  const commitHistory: IRCommit[] = []
  /**
   * Stable internal id for the {@link Graph.commitLog} derived node.
   * The double-underscore prefix marks it as engine-owned; user code
   * cannot collide because `input()` and `derived()` accept any id
   * but the engine reserves this one at construction time.
   *
   * @internal
   */
  const COMMIT_LOG_ID: NodeId = '__causl_commit_log__'
  // Public handle to the commitLog node — registered eagerly at
  // construction so it has a stable reference for the lifetime of
  // the graph. The commit log is itself a `Behavior [Commit]`, queryable
  // by the same `subscribe` / `read` / `explain` API as any other graph
  // value; this is the engine-owned realisation of that promise (EPIC #283 / #281).
  const commitLogNode = makeDerivedNode<readonly Commit[]>(COMMIT_LOG_ID)
  /**
   * #715 follow-up — count of registered commitLog consumers. A
   * "consumer" is any one of:
   *
   *   1. A `subscribe(graph.commitLog, …)` registration — the
   *      observer needs the post-commit array on each fire.
   *   2. An ordinary `derived(...)` whose recorded read-set
   *      includes `COMMIT_LOG_ID`. Recorded by `setDeps`
   *      (entry into / exit from the dep set both flip the
   *      counter), so dynamic-dep flips on derivations that
   *      branch on `get(graph.commitLog)` stay accurate.
   *   3. A `commitMetadataDerived(...)` registration — every
   *      commit-metadata derived reads `commitLog` semantically,
   *      and Phase F.5 needs the refreshed value to recompute
   *      against. Bumped at registration, dropped on dispose.
   *
   * Phase F (history append) and Phase F.6 (retention) remain
   * gated only on `commitHistoryCap > 0` — the bounded ring stays
   * warm so a future first subscriber sees recent history without
   * a cold-start gap. Only Phase F.4 (the `commitLogEntry.value`
   * rebuild + `changed.add(COMMIT_LOG_ID)`) and the F / F.4
   * rollback bookkeeping are conditional on this counter being
   * non-zero, so the default `commitHistoryCap=1000` adopter who
   * never subscribes to `commitLog` skips the per-commit rebuild
   * — the audit's headline acceptance for #715 (≥30% drop on
   * `causl × batch-commit × 10000` and `causl × equality-cutoff
   * × 10000`).
   */
  let commitLogConsumerCount = 0
  // #696 — per-kind node-cardinality running counters surfaced through
  // `graph.stats()`. Maintained at the (single) `entries.set` /
  // `entries.delete` sites for user-registered nodes — `input(...)`,
  // `derived(...)`, `commitMetadataDerived(...)`, and `_dispose(...)`.
  // The engine-owned `commitLog` derived registered at `createCausl`
  // boot is **not** counted; `inputCount + derivedCount` is the
  // user-only node total, while `entries.size` (surfaced as
  // `EngineTelemetry.entries`) includes the engine-owned slot. Running
  // counters are O(1) at the mutation site and O(1) at the read site;
  // an alternate iteration-on-demand implementation pays O(N) every
  // `stats()` call, which is the wrong shape for a long-running
  // devtools tab calling `stats()` once per render.
  let inputCount = 0
  let derivedCount = 0
  // #696 — running counter for live transient subscriptions
  // (`options.transient === true` on `subscribe` / `subscribeMany`).
  // Maintained at the four mutation sites: increment in `subscribe` /
  // `subscribeMany` when the option is set, decrement in (a) the
  // user-returned unsubscribe closures, (b) the Phase G transient
  // auto-dispose drain, and (c) `_dispose` on the underlying node.
  // Iterating `subscriptions` to count `entry.transient === true` would
  // be the alternative; the running counter keeps `stats()` allocation
  // -free and constant-time on a 10k-subscriber graph.
  let transientSubscriberCount = 0
  // GraphTime counter; advances by exactly one per published commit. A
  // transaction creates exactly one new `t` — there is no fractional time —
  // and `commit` is the only API in the engine that touches this counter.
  let now: GraphTime = 0
  // Re-entrancy guard for `commit` — the engine refuses nested commits. The
  // commit pipeline is the only mutation entry point, so a nested attempt
  // would mean a single moment in time was being constructed twice.
  let committing = false
  /**
   * #995 — Per-commit staged input writes, split into two roles
   * across two structures:
   *
   *   - `stagedWriteEntries` / `stagedWriteValues` — the commit-log
   *     role. A pair of linear, insertion-ordered parallel arrays
   *     that Phase B walks once to publish. Replaces the pre-#995
   *     `stagedEntries` array AND the value half of the `staged`
   *     Map. Phase B no longer probes a Map for the value; it
   *     reads `stagedWriteValues[i]` directly. Backing storage is
   *     reused across commits via `length = 0` truncation; the
   *     arrays are engine-closure scoped rather than re-allocated
   *     per `commitInternal` invocation.
   *
   *   - {@link InputEntry.lastStagedAt} /
   *     {@link InputEntry.lastStagedRow} — the read-shadow / dedup
   *     role. Two per-entry fields that replace the pre-#995
   *     `staged: Map<NodeId, unknown>` *entirely*. `tx.set`
   *     answers "is this a re-stage in the same tx?" with a
   *     single field comparison (`e.lastStagedAt === now`) — was:
   *     `staged.has(id)` Map probe; `readEntry` answers "what's
   *     the in-tx staged value?" with the same field comparison
   *     plus an array index access
   *     (`stagedWriteValues[e.lastStagedRow]`) — was:
   *     `staged.has(id)` + `staged.get(id)`, two Map probes. The
   *     fields cost 16 bytes per registered input but eliminate
   *     the per-commit `new Map()` allocation entirely (an earlier
   *     draft kept a lazy index Map; even the lazy form allocated
   *     on every commit that did at least one slow-path write,
   *     which on `op-tx-shadow-read-1k` regressed against the
   *     pre-#995 single-Map shape).
   *
   * Both halves are commit-local in *effect* — `stagedActive`
   * gates the read-shadow probe so the per-entry sentinels are
   * inert outside an active frame, and `now`'s monotonic
   * advancement (one tick per published commit; restored to
   * `beforeNow` on rollback / simulate teardown) means
   * `lastStagedAt === now` self-resets across frames without an
   * explicit clear walk. Atomicity (SPEC §3) is unchanged: the
   * catch-arm rollback walks `inputRollbackEntries`, not these
   * structures, so they vanish on throw without bookkeeping.
   */
  const stagedWriteEntries: InputEntry[] = []
  const stagedWriteValues: unknown[] = []
  // True iff a commit/simulate frame is currently staging. Gates
  // the per-entry-sentinel read-shadow probe in `readEntry`;
  // outside a frame, even an entry whose `lastStagedAt` was last
  // stamped at the current `now` (e.g. immediately after a
  // commit's Phase A but before Phase C's `now += 1`, an
  // unreachable state externally) is treated as not-staged so
  // plain `read()` calls bypass the staging arrays entirely.
  let stagedActive = false

  /**
   * Seed the genesis snapshot at GraphTime t₀ so `readAt(node, 0)` on
   * a fresh graph returns `Retained` over the seed inputs (P0 review
   * item: any time inside the retention window must resolve, and t₀
   * is structurally inside it).
   *
   * @remarks
   * Inputs registered after t₀ are recorded into the running snapshot
   * record by {@link input} so the genesis row keeps its meaning as
   * "the input table at the most recent snapshot moment that still
   * carried no committed writes." Subsequent commits append fresh
   * snapshots; FIFO eviction never removes the genesis row until its
   * own time predates the retention window.
   */
  retainedSnapshots.push({ time: 0, delta: new Map(), prev: null })

  // Register the engine-owned commitLog derived entry. The transaction
  // log is itself a `Behavior [Commit]` — queryable through subscribe,
  // read, and explain like any other graph value — and this is its
  // realisation. The value is normally maintained directly by the
  // commit pipeline's Phase F.4 (after Phase F history append, before
  // Phase F.5 commit-metadata recompute and Phase G subscriber
  // dispatch); the compute function below acts as a fallback that
  // refreshes the cached value from `commitHistory` whenever the
  // engine's strict-cycles DFS or any other code path forces a
  // recompute on a stale entry. Hosting it as a regular DerivedEntry
  // lets it participate in subscribe/explain/read like any other
  // node. EPIC #283 / #281.
  //
  // #715 follow-up — when `commitLogConsumerCount === 0`, Phase F.4
  // is skipped, so the cached `value` lags the bounded ring. The
  // compute below rebuilds from `commitHistory` on demand. The same
  // rebuild lives in `readEntry` as a lazy fallback for the bare
  // `g.read(g.commitLog)` path that does not route through
  // `computeDerived`. Both paths produce structurally-identical
  // arrays, satisfying the byte-stability contract pinned by
  // `commitLog.test.ts` (the cached array is reused for repeated
  // reads on a quiescent engine).
  const commitLogEntry: DerivedEntry = {
    kind: 'derived',
    id: COMMIT_LOG_ID,
    compute: (() => buildCommitLogValue()) as Compute<unknown>,
    value: Object.freeze([]) as unknown as readonly Commit[],
    computed: true,
    lastTime: 0,
    deps: new Set(),
    // Engine-owned commit log: registered at genesis t₀ alongside the
    // graph itself, so its Behavior domain is [0, ∞) — no caller ever
    // hits the pre-existence branch on this id.
    derivedRegisteredAt: 0,
    // Always-set tag field per #703 Win 5 (monomorphic hidden class).
    tag: undefined,
  }
  entries.set(COMMIT_LOG_ID, commitLogEntry)

  /**
   * Build the engine-owned `commitLog` value from the current
   * `commitHistory`. Shared between Phase F.4 (per-commit refresh
   * when consumers are present) and the readEntry / sentinel-compute
   * lazy fallbacks (when consumers are absent). Returns the same
   * frozen-array shape `commitLog.test.ts` pins.
   */
  function buildCommitLogValue(): readonly Commit[] {
    return Object.freeze(
      commitHistory.map(
        (row) =>
          // Always-set the optional `originatedAt` field (#703 Win 5 /
          // #760) so the published Commit hidden class is monomorphic
          // across regular and hydrate-issued records. The conditional
          // spread previously produced two hidden classes the moment
          // the first hydrate landed, sending every commit-log
          // consumer's `c.originatedAt` access megamorphic.
          Object.freeze({
            time: row.time,
            intent: row.intent,
            changedNodes: freezeIfDev(row.changedNodes.slice()),
            originatedAt: row.originatedAt,
          }) as Commit,
      ),
    )
  }

  /**
   * Invoke the user-supplied observer-error handler under a defensive try/catch
   * so a faulty handler cannot itself escape the commit pipeline.
   *
   * @param error - The original throw from the observer.
   * @param ctx - Provenance for the failed dispatch.
   */
  function reportObserverError(error: unknown, ctx: ObserverErrorContext): void {
    // Outer try guards the user handler; inner catch logs a fallback message.
    try {
      onObserverError(error, ctx)
    } catch {
      console.error('[causl] onObserverError threw while reporting:', error)
    }
  }

  /**
   * Resolve a node id to its storage entry, raising a structured error if the
   * id is not registered with this graph.
   *
   * @param id - The node id to look up.
   * @returns The matching {@link Entry}.
   * @throws {@link UnknownNodeError} if no entry is registered under `id`.
   */
  function getEntry(id: NodeId): Entry {
    const e = entries.get(id)
    if (!e) {
      // Disposed nodes get a typed error so adapter code can branch on
      // "released" vs. "never registered".
      const disposedAt = disposed.get(id)
      if (disposedAt !== undefined) throw new NodeDisposedError(id, disposedAt)
      throw new UnknownNodeError(id)
    }
    return e
  }

  /**
   * Read a node's value at the engine's current logical time. Inside a commit,
   * staged input writes shadow committed values; outside, reads see the
   * previous committed snapshot. There is no "concurrent mutation" question
   * because there is no concurrent mutation API — the only way to advance
   * time is through `commit`, and a captured `tx` cannot escape its callback.
   * Derivations are lazily computed on first read.
   *
   * @typeParam T - Value type of the node.
   * @param node - The node handle returned by `input` or `derived`.
   * @returns The node's value at the appropriate snapshot.
   */
  function readEntry<T>(node: Node<T>): T {
    const e = getEntry(node.id)
    return readEntryFromResolved(e, node)
  }

  /**
   * #964 — Read a node's value when the caller has ALREADY resolved
   * the entry via `getEntry(id)`. Hot-path callers (the iterative
   * registration walker's `get` accessor and `computeDerived`'s `get`
   * accessor — see `packages/core/src/graph.ts:1540`+) historically
   * called `getEntry(id)` to dispatch on `e.kind` (lazy-upstream
   * detection / cycle check / dedup) and THEN called `readEntry(n)`
   * to read the value — which internally called `getEntry(id)` AGAIN.
   *
   * The double probe was a latent overhead: `entries.get(id)` is
   * monomorphic and V8's IC inlines it into a `Builtins_MapGet` slot,
   * but the second probe still re-walks the same Map slot and re-runs
   * the disposed-tombstone branch. Threading the resolved entry
   * through `readEntryFromResolved` eliminates the second probe and
   * the disposed re-check.
   *
   * The `activeReadTracker` check from #701 is preserved here so the
   * contract is unchanged: `subscribeReads` projections still record
   * every node touched by the projection, regardless of whether the
   * caller went through `read()` or `readEntry` or this helper.
   */
  function readEntryFromResolved<T>(e: Entry, node: Node<T>): T {
    // #701 — when a `subscribeReads` projection is in flight (or any
    // future tracking-read context), record the dep into the active
    // tracker so the registration's read-set captures every node the
    // projection actually touched. The check is one nullable Map read
    // on the engine-instance closure; non-projection reads pay
    // exactly the same cost they did pre-#701.
    if (activeReadTracker !== null) {
      activeReadTracker.add(e.id)
    }
    // Inputs short-circuit through the staged buffer when one is active.
    // #995 — split-staged read-shadow: when a commit/simulate frame is
    // active AND `tx.set` has stamped `lastStagedAt = now` on this
    // input's entry, the in-tx staged value lives at
    // `stagedWriteValues[e.lastStagedRow]`. The probe costs one
    // monomorphic field load + one number compare + one array index
    // access — pre-#995 it cost two Map probes (`staged.has` +
    // `staged.get`) on the `staged` Map. Frames whose only writes
    // hit the `hasDependents` fast-path (#994) or the equal-value
    // fast-path (#972) never stamp `lastStagedAt` and the probe
    // falls through to `e.value` after the field check.
    if (e.kind === 'input') {
      if (stagedActive && e.lastStagedAt === now) {
        return stagedWriteValues[e.lastStagedRow] as T
      }
      return e.value as T
    }
    // #715 follow-up — lazy rebuild for the engine-owned commitLog
    // node. Phase F.4 only refreshes `commitLogEntry.value` when a
    // tracked consumer is registered (subscribe / commit-metadata
    // derived / plain derived with COMMIT_LOG_ID in its read-set).
    // A bare `g.read(g.commitLog)` call is NOT counted as a
    // consumer (reads are untracked by design — they don't
    // participate in change propagation), so its cached value can
    // lag the bounded ring. Refresh on demand so callers see the
    // current bounded history without paying for per-commit
    // rebuilds when nobody is listening. The rebuild is the same
    // shape as Phase F.4's, ported here as a lazy fallback. The
    // `lastTime < now` guard keeps repeated reads on a quiescent
    // engine cheap (the cached array is byte-stable, satisfying
    // the `commitLog.test.ts` stability contract).
    if (e.id === COMMIT_LOG_ID && e.lastTime < now && commitHistoryCap > 0) {
      e.value = buildCommitLogValue() as unknown
      e.lastTime = now
    }
    // Lazy first-evaluation for derivations that have never been computed.
    // Note: in the iterative registration walker the `get` accessor
    // throws `MissingUpstream` BEFORE reaching here when `!e.computed`,
    // so this branch is unreachable from that hot path. It remains
    // load-bearing as the lazy-first-read fallback for any future
    // surface that bypasses eager registration (and the
    // `node` parameter is the `Node<T>` handle the recursive
    // `computeDerived` would re-look-up the entry from anyway —
    // unchanged from pre-#964 semantics).
    if (e.kind === 'derived' && !e.computed) {
      computeDerived(e)
    }
    return e.value as T
  }

  /**
   * Reconcile the dependency edges of a derivation after a recompute.
   *
   * Walks the symmetric difference of (previous deps, next deps) and updates
   * the reverse-dep adjacency map (`dependents`) in place: edges no longer
   * read are dropped, newly read edges are added. The forward record on the
   * derivation entry is then replaced with `nextDeps`.
   *
   * @param derivedId - Id of the derivation being reconciled.
   * @param nextDeps - The dependency set captured by the most recent compute.
   *
   * @remarks
   * Dropping stale edges is the structural mechanism that closes the dynamic-
   * dependency-cleanup race: a derivation taking a different conditional
   * branch must not continue to receive change notifications from inputs it
   * no longer reads. The type system can't see across `if`-branches inside a
   * `derived` body, so the cleanup contract is enforced at runtime by
   * rebuilding the dep set on every successful evaluation and reconciling
   * the reverse-dep adjacency map here.
   */
  /**
   * Helper for the #704 empty-derivation fast path. Returns true iff
   * any active subscription targets one of the changed input ids.
   *
   * #842 collapses this to O(|changedInputIds|) by querying the
   * per-node `subscriptionsByNode` index that subscribe / dispose
   * already maintain (#671/#738). The previous body iterated the
   * flat `subscriptions` set and tested each entry against a Set
   * view of `changedInputIds`, which is O(|subscriptions|) per
   * call — at `scrolling-viewport × 10k` (10k subscriptions, ~1
   * changed input per commit) that landed at 27% of trace
   * self-time per #809 D6/D7/D16, dwarfing the rest of the commit
   * pipeline. The new shape mirrors {@link anyProjectionDepIn}'s
   * `subscribeReadsByNode.has(id)` lookup: O(1) per changed-input
   * id, regardless of subscription count.
   */
  function anyInputSubscriberIn(changedInputIds: readonly NodeId[]): boolean {
    if (changedInputIds.length === 0) return false
    if (subscriptionsByNode.size === 0) return false
    for (const id of changedInputIds) {
      if (subscriptionsByNode.has(id)) return true
    }
    return false
  }

  /**
   * #701 fast-path companion to {@link anyInputSubscriberIn}: returns
   * true iff any changed input id appears in the per-node
   * `subscribeReads` index. Lets the empty-derivation fast path stay
   * dead-work-free for graphs that haven't registered any projection
   * observers, while still firing them on direct-input commits when
   * one is registered.
   */
  function anyProjectionDepIn(changedInputIds: readonly NodeId[]): boolean {
    if (changedInputIds.length === 0) return false
    if (subscribeReadsByNode.size === 0) return false
    for (const id of changedInputIds) {
      if (subscribeReadsByNode.has(id)) return true
    }
    return false
  }

  function setDeps(derivedId: NodeId, nextDeps: Set<NodeId>): void {
    const prev = entries.get(derivedId)
    if (!prev || prev.kind !== 'derived') return
    // #703 Win 2 — early-return when the recorded read-set didn't
    // shift this recompute. The two diff loops below walk both
    // `prev.deps` and `nextDeps` even when they are set-equal, which
    // is the steady-state case for the canonical scrolling-viewport
    // workload (a derivation reads a stable set of inputs every
    // commit). When the sets are equal:
    //   - the remove-loop's `nextDeps.has(oldDep)` guard is true for
    //     every iteration ⇒ no reverse-dep edge is removed;
    //   - the add-loop re-adds the same `derivedId` to every existing
    //     `dependents.get(newDep)` set ⇒ the `Set#add` is a no-op
    //     because the entry was already present from the previous
    //     `setDeps` call.
    // Both loops are observable-equivalent to a no-op when the dep
    // sets agree; the early return collapses the per-recompute cost
    // from `O(|deps_before| + |deps_after|)` to `O(min(size))` (the
    // size+membership check). The reference is *not* swapped — see
    // Win 3: the previous reference is the same set, captured by
    // rollback consumers, so retaining `prev.deps` keeps the
    // captured-by-reference rollback row aligned with the live
    // entry.
    if (nextDeps.size === prev.deps.size) {
      // Identity short-circuit (the rollback path passes the
      // captured reference back in; Win 3): same Set ⇒ identical
      // memberships by definition.
      if (prev.deps === nextDeps) return
      let identical = true
      for (const id of nextDeps) {
        if (!prev.deps.has(id)) {
          identical = false
          break
        }
      }
      if (identical) {
        // Same set, same memberships. The reverse-dep adjacency map
        // already records exactly the right edges; no counter flip
        // is possible because `commitLog` is a member of `nextDeps`
        // iff it was a member of `prev.deps`. Skip the swap so any
        // captured-by-reference rollback row continues to share
        // identity with the live `prev.deps`. (The caller — the
        // recompute driver — passes a freshly-allocated `nextDeps`
        // each call; that allocation is dropped on the floor here,
        // which is the desired behaviour: the engine never holds two
        // structurally-equal deps sets for the same derived.)
        return
      }
    }
    // Remove reverse-dep edges for upstreams the derivation no longer reads.
    for (const oldDep of prev.deps) {
      if (!nextDeps.has(oldDep)) {
        const bucket = dependents.get(oldDep)
        if (bucket !== undefined) {
          bucket.delete(derivedId)
          // #994 — last consumer dropped: clear the cached
          // "has any consumer" flag on the upstream input entry
          // so `tx.set`'s fast path correctly observes the
          // now-isolated state. Derived upstreams have no flag
          // (only `InputEntry` carries `hasDependents`); guard
          // on `kind === 'input'` to avoid a load on the wrong
          // shape.
          if (bucket.size === 0) {
            const upstream = entries.get(oldDep)
            if (upstream !== undefined && upstream.kind === 'input') {
              upstream.hasDependents = false
            }
          }
        }
      }
    }
    // Add reverse-dep edges for upstreams newly read on this evaluation.
    for (const newDep of nextDeps) {
      let set = dependents.get(newDep)
      if (!set) {
        set = new Set()
        dependents.set(newDep, set)
      }
      const sizeBefore = set.size
      set.add(derivedId)
      // #994 — first consumer added: mark upstream input as having
      // dependents so subsequent `tx.set` writes route through the
      // slow path (the per-write rollback + staging bookkeeping
      // that Phase D's recompute walk relies on).
      if (sizeBefore === 0 && set.size === 1) {
        const upstream = entries.get(newDep)
        if (upstream !== undefined && upstream.kind === 'input') {
          upstream.hasDependents = true
        }
      }
    }
    // #715 follow-up — keep `commitLogConsumerCount` in sync with the
    // derived's read-set. Plain `derived(...)` callers that branch on
    // `get(graph.commitLog)` flip in/out of the counter as their dep
    // set changes; commit-metadata-tagged deriveds are credited
    // unconditionally at registration (in `derived(...)` below) and
    // are NOT double-counted here because their `derived` registration
    // bumps the counter once at registration time, regardless of the
    // recorded dep set. The `tag === 'commit-metadata'` check guards
    // against a metadata-tagged derived whose compute happens to read
    // `commitLog` (the typical case) inflating the count to 2 on the
    // same registration.
    if (prev.tag !== 'commit-metadata') {
      const hadBefore = prev.deps.has(COMMIT_LOG_ID)
      const hasAfter = nextDeps.has(COMMIT_LOG_ID)
      if (hasAfter && !hadBefore) commitLogConsumerCount++
      else if (!hasAfter && hadBefore) commitLogConsumerCount--
    }
    // Forward record swap — the entry now reflects the latest read-set.
    prev.deps = nextDeps
  }

  /**
   * #880 Shape B — array-based read-set fast path. The
   * `computeDerived` / `computeDerivedIterative` get-tracker collects
   * upstream ids into a per-frame `NodeId[]` instead of allocating a
   * fresh `Set<NodeId>` every recompute. On the steady-state
   * linear-chain bump (and any workload where a derived's read-set
   * does not shift commit-to-commit), this lets `setDeps` keep the
   * existing `prev.deps` reference without ever materialising a new
   * Set, eliminating one allocation + GC root per derived recompute.
   *
   * Invariant: the caller guarantees `arr[0..len)` contains a
   * **deduplicated** sequence of node ids (the get-tracker dedups via
   * a linear scan on push; for the read-set sizes the engine actually
   * sees, that is faster than `Set#add` because there is no hash and
   * no per-call closure allocation).
   *
   * Path 1 (deps unchanged): structural-equality comparison of the
   * array against `prev.deps`. On match, the function returns
   * immediately — no Set allocation, no `dependents` map walk, no
   * counter touch. The captured-by-reference rollback contract
   * (#703 Win 3) holds because `prev.deps` is preserved.
   *
   * Path 2 (deps shifted): build a fresh `Set<NodeId>` from the
   * array, then run the diff/counter logic inline (mirroring
   * {@link setDeps}, but specialised for the freshly-built Set so
   * we don't pay the Win 2 size+membership re-check that would
   * always miss on this path). The freshly-built Set is the new
   * `prev.deps`; the swap-not-mutate invariant
   * (`test/properties/setDeps-immutability.test.ts`) is preserved
   * by construction — we only touch the new Set, never the old.
   *
   * @param derivedId - The derived entry whose dep set is being
   *   reconciled.
   * @param arr - Caller-owned scratch buffer; `arr[0..len)` carries
   *   the deduplicated read-set captured during compute. The buffer
   *   is read-only from this function's perspective.
   * @param len - Effective length of `arr` (the buffer is reused
   *   across compute frames so its `.length` is not authoritative).
   *
   * @internal
   */
  function setDepsFromArray(
    derivedId: NodeId,
    arr: readonly NodeId[],
    len: number,
  ): void {
    const prev = entries.get(derivedId)
    if (!prev || prev.kind !== 'derived') return
    const prevDeps = prev.deps
    if (len === prevDeps.size) {
      // Path 1 — structural-equality fast path. Walk the deduplicated
      // array against `prev.deps`; on a clean match keep the existing
      // reference (no allocation, no `dependents`-map churn, no
      // commit-log consumer counter touch).
      let identical = true
      for (let i = 0; i < len; i++) {
        if (!prevDeps.has(arr[i]!)) {
          identical = false
          break
        }
      }
      if (identical) return
    }
    // Path 2 — deps shifted. Build the new Set, then inline the diff
    // loops + commit-log counter update. Inlining (vs calling
    // `setDeps`) lets us skip the Win 2 short-circuit which is dead
    // code on this path: by construction, the fast-path branch above
    // already proved the sets disagree if they had the same size.
    const next = new Set<NodeId>()
    for (let i = 0; i < len; i++) next.add(arr[i]!)
    // Remove reverse-dep edges for upstreams the derivation no longer
    // reads.
    for (const oldDep of prevDeps) {
      if (!next.has(oldDep)) {
        const bucket = dependents.get(oldDep)
        if (bucket !== undefined) {
          bucket.delete(derivedId)
          // #994 — clear the upstream input's `hasDependents`
          // flag when the last consumer drops. See the matching
          // block in `setDeps` for the full rationale.
          if (bucket.size === 0) {
            const upstream = entries.get(oldDep)
            if (upstream !== undefined && upstream.kind === 'input') {
              upstream.hasDependents = false
            }
          }
        }
      }
    }
    // Add reverse-dep edges for upstreams newly read on this
    // evaluation.
    for (let i = 0; i < len; i++) {
      const newDep = arr[i]!
      let set = dependents.get(newDep)
      if (!set) {
        set = new Set()
        dependents.set(newDep, set)
      }
      const sizeBefore = set.size
      set.add(derivedId)
      // #994 — first consumer added: mark upstream input as
      // having dependents. See the matching block in `setDeps`
      // for the full rationale.
      if (sizeBefore === 0 && set.size === 1) {
        const upstream = entries.get(newDep)
        if (upstream !== undefined && upstream.kind === 'input') {
          upstream.hasDependents = true
        }
      }
    }
    // #715 follow-up — keep `commitLogConsumerCount` in sync with
    // the derived's read-set. See the matching block in `setDeps`
    // for the full rationale; replicated verbatim here so the array
    // path does not need to walk the new Set twice.
    if (prev.tag !== 'commit-metadata') {
      const hadBefore = prevDeps.has(COMMIT_LOG_ID)
      const hasAfter = next.has(COMMIT_LOG_ID)
      if (hasAfter && !hadBefore) commitLogConsumerCount++
      else if (!hasAfter && hadBefore) commitLogConsumerCount--
    }
    // Forward record swap — the entry now reflects the latest
    // read-set.
    prev.deps = next
  }

  /**
   * Forward-edge DFS from `startId` along `entries.deps` looking for
   * a path back to `startId` (a cycle). Returns the cycle path —
   * `[startId, …, startId]` — or `null` if no cycle is reachable.
   *
   * @remarks
   * Used by Phase D's post-recompute back-edge probe (#705): when an
   * entry's compute records a new dep, we ask "does the new edge
   * close a cycle through the live dep graph?". The answer is
   * structurally the existence of a forward-reachable path from any
   * dep of the just-recomputed entry back to that entry's id. The
   * walk follows `e.deps` (the read-set the compute just established
   * via `setDeps`) and treats dep-of-input or dep-of-disposed as a
   * dead end.
   *
   * The traversal is iterative (explicit stack) so 10k-deep chains
   * with a tail-cycle do not consume V8 stack frames. The visited
   * set short-circuits diamond DAGs so the walk is O(|reachable|),
   * not O(2^depth).
   */
  function findCyclePathFrom(startId: NodeId): readonly NodeId[] | null {
    const startEntry = entries.get(startId)
    if (!startEntry || startEntry.kind !== 'derived') return null
    // DFS with a parent map so we can reconstruct the path on hit.
    const parent = new Map<NodeId, NodeId>()
    const visited = new Set<NodeId>()
    const stack: NodeId[] = []
    for (const d of startEntry.deps) {
      if (!parent.has(d) && d !== startId) {
        parent.set(d, startId)
        stack.push(d)
      } else if (d === startId) {
        // Self-edge — startId appears in its own deps. Cycle is
        // [startId, startId].
        return [startId, startId]
      }
    }
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (visited.has(cur)) continue
      visited.add(cur)
      const e = entries.get(cur)
      if (!e || e.kind !== 'derived') continue
      for (const d of e.deps) {
        if (d === startId) {
          // Reconstruct path: start → … → cur → start.
          const path: NodeId[] = [startId]
          // Walk back up parent pointers from `cur` to `startId`.
          const reverseChain: NodeId[] = [cur]
          let p = parent.get(cur)
          while (p !== undefined && p !== startId) {
            reverseChain.push(p)
            p = parent.get(p)
          }
          for (let i = reverseChain.length - 1; i >= 0; i--) {
            path.push(reverseChain[i]!)
          }
          path.push(startId)
          return path
        }
        if (!parent.has(d) && !visited.has(d)) {
          parent.set(d, cur)
          stack.push(d)
        }
      }
    }
    return null
  }

  /**
   * Recover a structured cycle path from the residue of a Phase D
   * Kahn drain that left some affected nodes unprocessed (#705). The
   * residue is exactly the union of strongly-connected components
   * Kahn could not topologically order; any node in the residue has
   * at least one dep also in the residue (otherwise Kahn would have
   * picked it up). Walk forward from any residue seed along its
   * deps, recording the first repeated id — that's the cycle's
   * closing edge.
   *
   * @param residue - The unprocessed nodes from the Phase D Kahn
   *   pass. Non-empty by the call-site precondition (`ordered.length
   *   < affected.size`).
   * @returns The cycle path — `[entry, …, entry]` — for the first
   *   cycle the walk closes.
   */
  function recoverCyclePath(residue: readonly NodeId[]): NodeId[] {
    const residueSet = new Set(residue)
    // Pick the first residue node and DFS along its deps within the
    // residue until we revisit an id (cycle closure).
    const seed = residue[0]!
    const visited = new Set<NodeId>()
    const path: NodeId[] = []
    const onPath = new Set<NodeId>()
    function dfs(cur: NodeId): NodeId[] | null {
      if (onPath.has(cur)) {
        // Found the cycle. Slice path from the earliest occurrence
        // and close it.
        const startIdx = path.indexOf(cur)
        return path.slice(startIdx).concat([cur])
      }
      if (visited.has(cur)) return null
      visited.add(cur)
      onPath.add(cur)
      path.push(cur)
      const e = entries.get(cur)
      if (e && e.kind === 'derived') {
        for (const d of e.deps) {
          if (!residueSet.has(d)) continue
          const found = dfs(d)
          if (found !== null) return found
        }
      }
      path.pop()
      onPath.delete(cur)
      return null
    }
    const found = dfs(seed)
    if (found !== null) return found
    // Fallback: degenerate residue with no closed cycle in the dep
    // graph (should be unreachable — Kahn only leaves residue when
    // there is at least one cycle). Return the residue itself so the
    // caller still gets a structured error rather than an opaque
    // throw.
    return [...residue, residue[0]!]
  }

  /**
   * #971 — Hoisted `get` recorder shared by {@link computeDerived} and
   * {@link computeDerivedIterative}. Replaces the per-call closure that
   * V8 had to re-allocate on every `compute(get)` invocation (one
   * Context + one JSFunction per call) with a bound-once function that
   * reads its frame state from {@link activeRecording}. The driver
   * pushes a fresh frame before calling `compute()`, calls
   * `e.compute(recordingGet)`, then pops the frame in `finally`. Nested
   * compute (a derived's body whose `get(upstream)` triggers
   * `computeDerived` for an uncomputed upstream) is supported by the
   * save/restore pattern — the inner call snapshots the parent
   * `activeRecording` slot and restores it on exit.
   *
   * The frame object itself is a fresh `RecordingFrame` per call, but
   * its hidden class is monomorphic (every site allocates the same
   * shape) so V8 keeps it in a fast-allocation arena. The closures we
   * eliminated each captured ~6 outer locals (`nextDepsArr`,
   * `nextDepsLen`, `nextStack`, `gate`, `captured`, `frame`,
   * `inFlight`, etc.) — replacing those Context allocations is the
   * structural source of the GC reduction that motivated this PR.
   *
   * Trade-off: each recordingGet call now reads `activeRecording`
   * through a single closed-over engine slot (the field initialised
   * below). That is one extra field load vs. the captured-by-closure
   * shape — but the closure was paying for the Context allocation up
   * front, so this is a win every call.
   *
   * The two driver shapes (recursive `computeDerived` vs. iterative
   * `computeDerivedIterative`) differ in cycle / missing-upstream
   * policy, so the frame carries a `kind` discriminator. The hot path
   * branches on `kind` once per `get` call; the branch is monomorphic
   * within a given driver invocation so V8 inlines it cleanly.
   */
  interface RecursiveFrame {
    readonly kind: 'recursive'
    readonly nextDepsArr: NodeId[]
    nextDepsLen: number
    readonly dirtyStack: NodeId[]
    captured: Map<NodeId, unknown> | null
  }

  interface IterativeFrame {
    readonly kind: 'iterative'
    readonly nextDepsArr: NodeId[]
    nextDepsLen: number
    readonly inFlight: Set<NodeId>
    readonly stackForCycle: { readonly entry: { readonly id: NodeId } }[]
    captured: Map<NodeId, unknown> | null
  }

  type RecordingFrame = RecursiveFrame | IterativeFrame

  let activeRecording: RecordingFrame | null = null

  /**
   * Bound-once tracking accessor for derived `compute()` bodies. Reads
   * the active frame from {@link activeRecording} (the driver swaps
   * this in before invoking `compute()`), records the dep edge, and
   * returns the resolved value. See {@link computeDerived} JSDoc for
   * the closure-allocation rationale.
   */
  function recordingGet<U>(n: Node<U>): U {
    const rec = activeRecording
    // The driver always sets activeRecording before invoking compute().
    // A null read here would indicate the recorder was called outside
    // a compute frame — unreachable on the hot path; throw to surface
    // the bug rather than silently miscounting.
    if (rec === null) {
      throw new Error(
        '[causl] recordingGet called outside a compute frame — internal invariant violated',
      )
    }
    const dep = getEntry(n.id)
    if (dep.kind === 'derived') {
      if (rec.kind === 'iterative') {
        if (rec.inFlight.has(n.id)) {
          // Cycle: the user's compute is reading a derivation whose
          // compute is already pending earlier on the stack. Build the
          // path from the cycle's entry-point through the current
          // stack down to the closing edge.
          const stack = rec.stackForCycle
          const ids: NodeId[] = []
          for (let i = 0; i < stack.length; i++) ids.push(stack[i]!.entry.id)
          const cycleStart = ids.indexOf(n.id)
          const path = ids.slice(cycleStart).concat([n.id])
          throw new CycleError(path)
        }
        if (!dep.computed) {
          throw new MissingUpstream(n.id)
        }
      } else {
        // recursive — match pre-#971 behaviour: forward to the
        // recursive walker for any uncomputed upstream. The walker
        // saves/restores `activeRecording` itself, so the parent's
        // dep buffer survives the nested call.
        if (!dep.computed) {
          computeDerived(dep, rec.dirtyStack)
        }
      }
    }
    // Dedup-on-push: the `setDepsFromArray` contract requires a
    // unique-element array. A linear scan is O(k) per add but k is
    // tiny in practice (1-3 deps for the canonical workloads); the
    // monomorphic integer-key loop V8 generates beats `Set#add` here
    // because there is no hash and no per-call closure allocation.
    const id = n.id
    const arr = rec.nextDepsArr
    const len = rec.nextDepsLen
    let already = false
    for (let i = 0; i < len; i++) {
      if (arr[i] === id) {
        already = true
        break
      }
    }
    if (!already) {
      arr[len] = id
      rec.nextDepsLen = len + 1
    }
    // #964 — single Map probe; thread the resolved `dep` entry through
    // `readEntryFromResolved` instead of re-probing `entries.get(n.id)`.
    const value = readEntryFromResolved(dep, n)
    if (rec.captured !== null) rec.captured.set(n.id, value)
    return value as U
  }

  /**
   * Evaluate a derivation and record the dependencies it actually read.
   *
   * The compute function receives a tracking `get` that both lazily evaluates
   * upstream derivations on demand and accumulates the live read-set into
   * `nextDeps`. After the compute returns, the engine commits the new value
   * and reconciles the reverse-dependency graph via {@link setDeps}.
   *
   * @param e - The derivation entry to (re)compute.
   * @param dirtyStack - Recursion stack used to detect upstream cycles.
   * @throws {@link CycleError} if a derivation transitively reads itself.
   *
   * @remarks
   * Cycle detection is first-commit-time, not static: a cycle in the
   * derivation graph is detected at the first commit that closes it, with a
   * structured error naming the cycle path. Static cycle detection across
   * conditional branches is an out-of-band concern handled by the bounded
   * model checker as a CI gate, not by this engine's runtime. The fresh
   * `nextDeps` set on every call is the structural basis for dynamic-
   * dependency cleanup: the recompute always rebuilds the read-set rather
   * than mutating it in place, so a derivation that switches branches drops
   * stale upstream edges atomically with the new compute.
   *
   * The denotational definition this loop evaluates is
   * `derived(t) = f(b₁(t), …, bₙ(t))` — a pure function of the dependencies
   * sampled at the same commit moment. Two implementations either agree on
   * that equation or one of them is wrong.
   */
  function computeDerived(
    e: DerivedEntry,
    dirtyStack: NodeId[] = [],
  ): void {
    // Cycle guard: revisiting our own id along the current evaluation path is a cycle.
    if (dirtyStack.includes(e.id)) {
      throw new CycleError([...dirtyStack, e.id])
    }
    // #880 Shape B — array-based read-set buffer. The historical
    // `new Set<NodeId>()` here showed up at ~3% of linear-chain trace
    // self-time inside `setDeps`'s caller path (most of which collapses
    // to no-op via the Win 2 short-circuit anyway). Collecting the
    // read-set into an array lets the post-compute reconciliation
    // (`setDepsFromArray`) keep `prev.deps` by reference when the
    // dep-set is unchanged, eliminating the per-recompute Set
    // allocation entirely on the steady-state path. The dedup
    // invariant required by `setDepsFromArray` is maintained by the
    // linear-scan check at every `get` call below; for the read-set
    // sizes the engine sees in practice (≤ a few unique deps per
    // derived) this is faster than `Set#add` because there is no
    // hash, no closure allocation, and no Set-internal slot growth.
    const nextDepsArr: NodeId[] = []
    const nextStack = [...dirtyStack, e.id]
    // SPEC §15.1 invariant gate (#750) — when on, capture every value
    // resolved through the tracking accessor on the first compute,
    // then re-run the compute against an accessor that replays the
    // captured values. A second-call result that disagrees with the
    // first under `Object.is` is the structural witness that the
    // compute is not a pure function of its declared dependencies
    // (the canonical case is a `Math.random()` / `Date.now()` /
    // external-mutable read inside the compute body). The flag is
    // off by default because the second call doubles compute work;
    // production pays zero overhead.
    const gate = flags.assertDeterministicCompute
    // #971 — Hoisted `get` recorder. The pre-#971 shape allocated a
    // fresh closure per `compute(get)` call, plus a second `verifyGet`
    // closure under the §15.1 gate. Both closures captured the same
    // outer locals (`nextDepsArr`, `nextDepsLen`, `nextStack`, `gate`,
    // `captured`) through Context allocations on every call — the GC
    // pressure at the root of the linear-chain × 1000 trace. The
    // hoisted recorder reads its frame from {@link activeRecording},
    // which we save/restore around the inner `e.compute(...)` call so
    // nested compute (an upstream-uncomputed `get(dep)` that recurses
    // into `computeDerived(dep, nextStack)`) preserves the parent
    // frame's dep buffer.
    const frame: RecursiveFrame = {
      kind: 'recursive',
      nextDepsArr,
      nextDepsLen: 0,
      dirtyStack: nextStack,
      captured: gate ? new Map<NodeId, unknown>() : null,
    }
    const prevRecording = activeRecording
    activeRecording = frame
    let next: unknown
    try {
      // Run the user-supplied compute. Any throw propagates out unchanged.
      next = e.compute(recordingGet)
    } finally {
      activeRecording = prevRecording
    }
    // Invariant gate — second call against the captured dep snapshot.
    // The verifyGet path replays the captured map first (a hit short-
    // circuits the live tracker); a miss is a dynamic-dep widen that
    // falls through to a real tracking read. Either way the read-set
    // captured matches the union of both passes (over-record rather
    // than under-record — the conservative choice).
    if (frame.captured !== null) {
      const captured = frame.captured
      // Replace the captured-map probe by clearing the slot for verify
      // — but the recorder still records into `frame.nextDepsArr`. We
      // want to short-circuit captured hits without a recordingGet
      // re-entry (a captured read is BY DEFINITION already in the
      // dep-set), so swap the captured pointer to null around the
      // hit-shortcut wrapper.
      const verifyGet = <U>(n: Node<U>): U => {
        if (captured.has(n.id)) return captured.get(n.id) as U
        // Dynamic-dep widen on the second pass — defer to the hoisted
        // recorder, which records the widened id into nextDepsArr.
        return recordingGet(n)
      }
      const prev2 = activeRecording
      activeRecording = frame
      let verify: unknown
      try {
        verify = e.compute(verifyGet)
      } finally {
        activeRecording = prev2
      }
      if (!Object.is(verify, next)) {
        throw new NonDeterministicComputeError(e.id, [...dirtyStack, e.id])
      }
    }
    // Commit the new value, reconcile dep edges, mark the entry as up to date.
    e.value = next
    setDepsFromArray(e.id, nextDepsArr, frame.nextDepsLen)
    e.computed = true
    e.lastTime = now
  }

  /**
   * Sentinel thrown by the iterative-compute `get` accessor when an
   * upstream derived has not yet been computed. The driver loop
   * ({@link computeDerivedIterative}) catches this and pushes the
   * missing entry onto the explicit stack, then restarts the current
   * top's compute on the next loop iteration. Carrying the missing id
   * on the sentinel lets the driver avoid a second `getEntry` lookup.
   *
   * @internal
   */
  class MissingUpstream {
    constructor(public readonly id: NodeId) {}
  }

  /**
   * Iterative driver for the registration-time eager evaluation of a
   * derived entry (#670). Replaces the recursive `computeDerived` walk
   * for the registration call site so a freshly-registered derivation
   * at the tail of an N-deep chain does not consume O(N) V8 stack
   * frames — the runtime ceiling that capped `linear-chain × 10000`
   * before this surgery (the bench harness reported a stack overflow).
   *
   * Algorithm: explicit stack of derived entries pending compute; the
   * top of the stack runs its `compute` against a sentinel-throwing
   * `get` accessor. A `get(n)` for an already-computed `n` records the
   * dep edge and returns the cached value (the common case for chain
   * tails). A `get(n)` for an uncomputed derived `n` throws
   * {@link MissingUpstream}; the driver catches it, pushes `n` onto
   * the stack, and restarts the loop. After each successful compute,
   * the entry's value, deps, and computed flag are committed and the
   * driver pops the stack.
   *
   * Cycle detection: the explicit stack carries an `inFlight` set of
   * entry ids currently on it. A `get(n)` whose `n` is in `inFlight`
   * is a cycle (the user's compute is reading a derivation whose own
   * compute is already pending earlier in the stack); the driver
   * throws {@link CycleError} naming the path from the cycle's tail
   * back to the closing edge.
   *
   * Compute-call invariant: each entry's `compute(get)` is called at
   * most twice — once with a partially-satisfied dep set (the call
   * that throws `MissingUpstream` on the first uncomputed dep), and
   * once with all upstreams computed (the call that succeeds). The
   * worst-case bound therefore stays O(N) for a chain of N entries
   * even though the restart-on-miss shape sounds quadratic in the
   * abstract; the structural reason is that each entry contributes
   * at most one missing-upstream restart per direct upstream (and a
   * chain has exactly one direct upstream per node).
   *
   * @param rootEntry - The entry to compute. Must be a registered
   *   derived; the function is a no-op (returns immediately) if the
   *   entry is already computed, mirroring `computeDerived`'s
   *   short-circuit behaviour at recursion entry.
   *
   * @throws {@link CycleError} when a `get(n)` would close a cycle.
   *
   * @internal
   */
  function computeDerivedIterative(rootEntry: DerivedEntry): void {
    if (rootEntry.computed) return

    // #880 Shape B — same allocation-elision motivation as
    // `computeDerived` (see comment there). Each frame carries a
    // dedup'd `NodeId[]` instead of a `Set<NodeId>`; on a successful
    // compute we hand it to {@link setDepsFromArray}, which keeps
    // `prev.deps` by reference when the dep-set is unchanged. The
    // restart-on-miss path resets the array length to 0 instead of
    // calling `Set#clear` (the array's reference is reused across
    // retry attempts).
    interface StackFrame {
      readonly entry: DerivedEntry
      readonly nextDepsArr: NodeId[]
      nextDepsLen: number
    }

    const stack: StackFrame[] = []
    const inFlight = new Set<NodeId>()
    // SPEC §15.1 invariant gate (#750) — when on, the iterative driver
    // re-runs each frame's compute against the captured dep snapshot
    // (the only point at which all upstreams are computed and the
    // tracker has populated `captured`) and throws
    // {@link NonDeterministicComputeError} if the second result
    // disagrees with the first under `Object.is`. Off by default;
    // production pays zero overhead.
    const gate = flags.assertDeterministicCompute

    const pushFrame = (entry: DerivedEntry): void => {
      stack.push({ entry, nextDepsArr: [], nextDepsLen: 0 })
      inFlight.add(entry.id)
    }
    pushFrame(rootEntry)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      // Reset nextDepsLen each attempt; restart-on-miss semantics
      // rebuild the read-set from scratch on the successful pass. The
      // backing array is reused — V8 keeps the slot storage allocated.
      frame.nextDepsLen = 0
      // Captured-value map for the invariant gate's verification pass.
      // Reset alongside `nextDepsLen` so a restart-on-miss does not
      // bleed values from a partially-completed earlier attempt.
      const captured = gate ? new Map<NodeId, unknown>() : null
      // #971 — Hoisted `get` recorder. The pre-#971 shape allocated a
      // fresh `get` closure (and a second `verifyGet` under the gate)
      // per while-loop iteration; on a 1000-deep linear chain that was
      // 1000 closure allocations per `computeDerivedIterative` call,
      // each with a Context capturing `frame`, `inFlight`, `captured`,
      // and `captureStackIds`. The hoisted recorder reads its frame
      // through {@link activeRecording}; the per-iteration cost
      // collapses to one `IterativeFrame` literal (monomorphic shape,
      // hot V8 fast-path) plus a save/restore of the slot.
      const recFrame: IterativeFrame = {
        kind: 'iterative',
        nextDepsArr: frame.nextDepsArr,
        nextDepsLen: 0,
        inFlight,
        stackForCycle: stack,
        captured,
      }

      let nextValue: unknown
      const prevRecording = activeRecording
      activeRecording = recFrame
      let computeErr: unknown = undefined
      let computeThrew = false
      try {
        nextValue = frame.entry.compute(recordingGet)
      } catch (err) {
        computeErr = err
        computeThrew = true
      } finally {
        activeRecording = prevRecording
      }
      // Sync the per-attempt dep-len back to the StackFrame so both
      // restart-on-miss (which discards) and the success path
      // (`setDepsFromArray` below) read the right length.
      frame.nextDepsLen = recFrame.nextDepsLen
      if (computeThrew) {
        if (computeErr instanceof MissingUpstream) {
          // Push the missing upstream and restart the loop. The
          // current frame's nextDepsLen will be reset on the next
          // attempt; we discard the partial set captured so far.
          const upstream = entries.get(computeErr.id)
          if (!upstream || upstream.kind !== 'derived') {
            // Defensive: should be unreachable — `get` only throws
            // MissingUpstream for derived entries it just looked up.
            throw computeErr
          }
          pushFrame(upstream)
          continue
        }
        // Any other throw (CycleError, user-thrown) escapes the
        // driver. Clear in-flight tracking so a partial registration
        // failure does not leak state into the next attempt.
        for (const f of stack) inFlight.delete(f.entry.id)
        stack.length = 0
        throw computeErr
      }

      // Invariant gate — second compute call against the captured
      // dep snapshot. By this point `MissingUpstream` cannot fire
      // (every upstream the first pass touched is computed), so the
      // verify accessor returns from `captured` directly. A widening
      // read on the second pass falls back through the hoisted
      // recorder, which records the widened id into `frame.nextDepsArr`.
      // This keeps the dep-set captured at the union of both passes
      // (over-record rather than under-record — the conservative
      // choice). The verifyGet wrapper itself is only allocated when
      // the §15.1 gate is on (off by default in production).
      if (captured !== null) {
        const verifyGet = <U>(n: Node<U>): U => {
          if (captured.has(n.id)) return captured.get(n.id) as U
          // Dynamic-dep widen — defer to the hoisted recorder.
          return recordingGet(n)
        }
        const prev2 = activeRecording
        activeRecording = recFrame
        let verifyErr: unknown = undefined
        let verifyThrew = false
        let verify: unknown
        try {
          verify = frame.entry.compute(verifyGet)
        } catch (err) {
          verifyErr = err
          verifyThrew = true
        } finally {
          activeRecording = prev2
        }
        frame.nextDepsLen = recFrame.nextDepsLen
        if (verifyThrew) {
          if (verifyErr instanceof MissingUpstream) {
            const upstream = entries.get(verifyErr.id)
            if (!upstream || upstream.kind !== 'derived') throw verifyErr
            pushFrame(upstream)
            continue
          }
          for (const f of stack) inFlight.delete(f.entry.id)
          stack.length = 0
          throw verifyErr
        }
        if (!Object.is(verify, nextValue)) {
          // Snapshot the path BEFORE we clear the driver state so
          // the error carries the full chain that led to the
          // offending node. The path ends with the entry id.
          const errPath: NodeId[] = []
          for (let i = 0; i < stack.length; i++) errPath.push(stack[i]!.entry.id)
          for (const f of stack) inFlight.delete(f.entry.id)
          stack.length = 0
          throw new NonDeterministicComputeError(frame.entry.id, errPath)
        }
      }

      // Compute succeeded — commit value, reconcile dep edges, mark
      // computed, pop the stack.
      frame.entry.value = nextValue
      setDepsFromArray(frame.entry.id, frame.nextDepsArr, frame.nextDepsLen)
      frame.entry.computed = true
      frame.entry.lastTime = now
      inFlight.delete(frame.entry.id)
      stack.pop()
    }
  }

  /**
   * Register a writable input Behavior at the current GraphTime, seeded with
   * `initial`. Realises `input(initial) : Behavior a where input(t₀) = initial`
   * from the engine's denotational definition: at registration time the value
   * is treated as `input` at the current moment, and every subsequent `tx.set`
   * advances that Behavior to the next discrete commit moment.
   *
   * @typeParam T - Value type carried by the input.
   * @param id - Stable, application-chosen identifier within the graph.
   * @param initial - Initial value at registration time (treated as `input(t₀)`).
   * @returns A frozen handle usable in `read`, `derived`, and `tx.set`.
   * @throws {@link DuplicateNodeError} if an entry already exists under `id`.
   */
  function input<T>(id: NodeId, initial: T): InputNode<T> {
    // Reject collisions: ids are the engine's identity contract.
    if (entries.has(id)) throw new DuplicateNodeError(id)
    const node = makeInputNode<T>(id)
    // Seed the entry with the initial value and the immutable public handle.
    // #1014 — InputEntry allocation moved to module-level
    // `makeInputEntry` so the literal's source position is shared
    // with the `pretenureInputAllocationSites` warmup loop. V8's
    // allocation-site feedback ledger keys on source position, so
    // factoring the literal into a single helper is what makes the
    // first-construction warmup pre-tenure the same site `input()`
    // hits per registration. The helper preserves the #915 / #994
    // / #995 hidden-class monomorphism contract (property order
    // matches the InputEntry interface declaration order).
    //
    // #1123 — V8 attributes the InputEntry allocation site to its
    // enclosing SFI (this `input` closure) in addition to the inner
    // `makeInputEntry` SFI. The post-#1036 audit surfaced a residual
    // `dependent allocation site tenuring changed` deopt pair on
    // `input` once the bench harness drove this site past the
    // young→old transition. The warmup loop in
    // `pretenureInputAllocationSites` now also calls
    // `warmupGraph.input(...)` directly (via a recursive
    // `createCausl()` re-entry, gated by the same latch), driving
    // the per-instance `input()` SFI through the retune so this
    // site is pre-tenured by the time the bench harness reaches it.
    entries.set(id, makeInputEntry<T>(id, initial, now, node as InputNode<unknown>))
    // #696 — `inputCount` running total surfaced via `graph.stats()`.
    // Increment after a successful `entries.set`; the matching
    // decrement lives in `_dispose` (see the entry-removal block).
    inputCount++
    // #915 — only populate the registeredAt map when the input was
    // registered after at least one commit advanced GraphTime. The
    // common case (all inputs registered at genesis, before any
    // `commit`) leaves the map empty; `readAt`'s domain check falls
    // back to 0 for those inputs which is structurally identical
    // (registeredAt === 0 means the Behavior is defined on [0, ∞)).
    if (now !== 0) inputRegisteredAtMap.set(id, now)
    // Record the seed value into the retained row whose time matches the
    // registration moment. Practically that's the genesis row when
    // registration happens before any commit, and a no-op afterwards
    // (later registrations are visible only on go-forward reads — the
    // retention buffer reflects what was in the input table at each
    // historical commit). Writing into `delta` (rather than the legacy
    // flat `inputs` record) is the structural-sharing invariant from
    // #235: only the rows that actually carried this input write own a
    // delta entry for it, every other row resolves it through the
    // chain.
    //
    // #915 — gate the retained-row stamp on `snapshotRetentionCap > 0`.
    // The default `createCausl({})` resolves the cap to 0 (#716 /
    // SPEC §5.1 Amendment 2), in which case every retained row is
    // evicted at the next Phase F.6 anyway and the `readAt` path
    // returns `evicted` unconditionally — writing into the genesis
    // delta is dead bookkeeping that the microbench `op-input-create-1k`
    // pays per input creation. Adopters who opt in
    // (`createCausl({ snapshotRetentionCap: N > 0 })`) keep the seed
    // stamp so a later `readAt(input, 0)` resolves the registration
    // value through the chain walk (the original #235 contract).
    if (snapshotRetentionCap > 0 && isSerializable(initial)) {
      for (const snap of retainedSnapshots) {
        if (snap.time === now) {
          // Cloning happens at read time (see `readAt`), not here —
          // commits that never trigger a time-travel read pay no
          // clone cost. The reference stored here is the live input
          // cell's reference; the consumer cannot mutate it without
          // also mutating their own local handle.
          snap.delta.set(id, initial)
        }
      }
    }
    return node
  }

  /**
   * Register a derived Behavior whose value is `compute(get)` evaluated
   * against the current snapshot. Dependencies are captured automatically
   * through ref-counted `get()` calls inside the compute body — there is no
   * explicit dep array. The denotational equation that this method registers
   * is `derived(f, b₁, …, bₙ)(t) = f(b₁(t), …, bₙ(t))`: a pure function of
   * its dependencies' values at the same time `t`, which is what makes
   * glitch-freedom a theorem rather than a hope.
   *
   * @typeParam T - Value type produced by the derivation.
   * @param id - Stable, application-chosen identifier within the graph.
   * @param compute - Pure function expressing the derivation's semantics.
   * @returns A frozen handle usable in `read`, downstream `derived`, and `subscribe`.
   * @throws {@link DuplicateNodeError} if an entry already exists under `id`.
   * @throws {@link CycleError} if the initial compute closes a cycle.
   *
   * @remarks
   * The derivation is evaluated eagerly on registration so that downstream
   * code can `read` it immediately without forcing a commit.
   */
  function derived<T>(
    id: NodeId,
    compute: Compute<T>,
    options?: { readonly tag?: 'live' | 'commit-metadata' },
  ): DerivedNode<T> {
    // Reject duplicate ids with the same contract as `input`.
    if (entries.has(id)) throw new DuplicateNodeError(id)
    const node = makeDerivedNode<T>(id)
    // Seed an uncomputed entry; `computeDerived` populates value, deps, and `computed`.
    const entry: DerivedEntry = {
      kind: 'derived',
      id,
      compute: compute as Compute<unknown>,
      value: undefined,
      computed: false,
      lastTime: now,
      deps: new Set(),
      // Anchor the Behavior's domain at the registration moment so
      // `readAt(derived, t < derivedRegisteredAt)` surfaces the
      // discriminated `evicted` arm rather than fabricating a value
      // by recomputing against a pre-existence input snapshot (#374).
      derivedRegisteredAt: now,
      // Always-set the optional `tag` field (#703 Win 5) so the
      // DerivedEntry hidden class is monomorphic across plain
      // `derived(...)` and `commitMetadataDerived(...)` callers.
      // The conditional spread previously produced two hidden
      // classes the moment any tagged node was registered, sending
      // every entries.get(id).kind === 'derived' branch megamorphic.
      tag: options?.tag,
    }
    entries.set(id, entry)
    // Register the id in the commit-metadata index so Phase F.5 can
    // re-recompute it after `commitLogEntry.value` is refreshed
    // (#452). Plain `derived(...)` callers leave `tag` undefined and
    // never enter this branch, preserving the §3 atomicity contract:
    // ordinary deriveds settle exactly once per commit, in Phase D.
    //
    // #715 follow-up — every commit-metadata derived semantically
    // depends on `commitLog` (Phase F.5 only fires meaningfully when
    // F.4 has refreshed `commitLogEntry.value`), so credit the
    // consumer counter unconditionally at registration. `setDeps`
    // skips the dep-set-driven counter update for this `tag` so the
    // common case of a metadata derived that reads `commitLog`
    // doesn't double-count. The decrement lives in `_dispose`.
    if (options?.tag === 'commit-metadata') {
      commitMetadataIds.add(id)
      commitLogConsumerCount++
    }
    // Eager first evaluation populates the value and the dependency
    // set via the **iterative** driver (#670). The recursive variant
    // consumed one V8 stack frame per chain edge during the eager
    // walk, capping `linear-chain × 10000` at a stack overflow before
    // the engine could finish registering the tail node; the iterative
    // driver retires that ceiling. The driver also detects cycles
    // structurally (a `get(n)` that reads a derivation whose own
    // compute is pending earlier on the explicit stack throws
    // {@link CycleError}), preserving the "atomic registration" half
    // of the pre-#705 strict-cycle contract for the case where the
    // cycle is visible at the registration moment.
    //
    // Latent cycles closed by outside-closure mutation (forward-ref
    // holder assigned after both endpoints are computed) are NOT
    // detected here — they are caught at the first commit that walks
    // into the SCC by Phase D's augmented Kahn pass (#705): see
    // {@link recomputeAffected}'s post-recompute back-edge probe. The
    // pre-#705 `strictCycles: true` registration-time DFS over every
    // transitive upstream is gone (it was O(N²) on chains and
    // overflowed the V8 stack on N > ~10000); SPEC §9.1 row 8's
    // "first commit that closes the cycle" contract is satisfied by
    // the commit-time path alone.
    try {
      computeDerivedIterative(entry)
    } catch (err) {
      // Atomicity: a failed registration must leave the engine
      // byte-identical to its pre-call state. Roll back the entry
      // insertion (`computeDerived` reaches `setDeps` only on a
      // successful compute, so reverse-dep edges to this id were
      // never written; entry removal alone is the correct undo).
      // The commit-metadata index is also rolled back so a failed
      // `commitMetadataDerived` registration does not leave a dangling
      // id in the Phase F.5 seed set (#452).
      entries.delete(id)
      commitMetadataIds.delete(id)
      // #715 follow-up — undo the registration-time consumer-counter
      // bump so a failed `commitMetadataDerived(...)` does not leak a
      // phantom subscriber that would gate F.4's per-commit rebuild
      // on for the rest of the engine's lifetime.
      if (options?.tag === 'commit-metadata') commitLogConsumerCount--
      // #936 / #956 — defense-in-depth conversion. After #956 the
      // registration walker is iterative end-to-end
      // (`computeDerivedIterative`) and the depth ceiling lifts past
      // 12k on Node 22+. This catch arm now exists as a residual-
      // recursion guard: a user `derived` body whose compute itself
      // recurses outside the tracker (e.g. a recursive helper closing
      // over a long dep-chain manually) can still overflow V8, and
      // stricter `--stack-size` configurations may surface stack
      // exhaustion at lower depths. Converting to the typed
      // `DerivedRegistrationStackOverflowError` preserves the
      // user-facing contract — "no public causl API ever crashes the
      // Node process with a raw V8 RangeError" — for those residual
      // paths. The bench's comparator-symmetric skip
      // (`RecursiveEvalStackOverflowError`) was retired post-#956
      // because the engine no longer overflows on the canonical
      // `linear-chain × 10000` workload.
      if (isStackOverflowRangeError(err)) {
        throw new DerivedRegistrationStackOverflowError(id)
      }
      throw err
    }
    // #696 — `derivedCount` running total surfaced via `graph.stats()`.
    // Increment only after the eager evaluation succeeds so a failed
    // registration (whose entry was rolled out of `entries` in the
    // catch arm above) does not leak a phantom count. The matching
    // decrement lives in `_dispose` (see the entry-removal block).
    // Engine-owned `commitLogEntry` is registered directly via
    // `entries.set(COMMIT_LOG_ID, …)` and intentionally bypasses this
    // counter: `derivedCount` advertises *user-registered* deriveds.
    derivedCount++
    return node
  }

  /**
   * Detect V8's `RangeError: Maximum call stack size exceeded` so the
   * registration / recompute paths can convert it to the typed
   * {@link DerivedRegistrationStackOverflowError} (#936). Matched by
   * `instanceof RangeError` plus message prefix because V8 does not
   * carry a discriminator on the throw — the message string is the
   * only stable surface, and the prefix `Maximum call stack size
   * exceeded` is locked-in across V8 versions back to Node 16.
   *
   * Falls open on non-V8 runtimes (no false-positive: a foreign
   * `RangeError` whose message happens to start with the same prefix
   * is structurally indistinguishable from V8's, and converting it is
   * still strictly safer than re-throwing as a raw `RangeError`).
   *
   * @internal
   */
  function isStackOverflowRangeError(err: unknown): boolean {
    if (!(err instanceof RangeError)) return false
    const msg = err.message
    return (
      typeof msg === 'string' &&
      msg.startsWith('Maximum call stack size exceeded')
    )
  }

  /**
   * Register a derived Behavior whose compute reads commit metadata —
   * `graph.commitLog`, the commit-time stamp, or values produced by
   * other commit-metadata-tagged deriveds — and whose value is
   * expected to reflect the *just-completed* commit, not the previous
   * one. Realises §11's "first-class derived for inspection" framing
   * for the commit-metadata-reading case (#452).
   *
   * Internally a `commitMetadataDerived` is a {@link DerivedNode} like
   * any other; it participates in `read`, `subscribe`, `explain`, and
   * `readAt` uniformly with plain {@link Graph.derived}. The seam this
   * factory adds is scheduling: the engine recomputes commit-metadata
   * deriveds in Phase F.5, *after* Phase D's regular fixpoint has
   * settled and Phase F.4 has refreshed `commitLogEntry.value`, but
   * *before* Phase G fires per-node subscribers. A derivation
   * registered through this factory therefore sees the new commit log
   * entry on the same commit that produced it; subscribers fire once,
   * with the post-commit value.
   *
   * @typeParam T - Value type produced by the derivation.
   * @param id - Stable, application-chosen identifier within the graph.
   * @param compute - Pure function expressing the derivation's
   *   semantics. Reads through `get(graph.commitLog)` see the bounded
   *   ring of recent commits including the in-flight one.
   * @returns A frozen handle usable in `read`, downstream `derived`,
   *   and `subscribe`.
   * @throws {@link DuplicateNodeError} if an entry already exists
   *   under `id`.
   * @throws {@link CycleError} if the initial compute closes a cycle.
   *
   * @remarks
   * PR #383 attempted to turn `whyUpdated` / `whyNotUpdated` /
   * `commitLog` into live derived nodes through plain `derived(...)`;
   * the attempt failed because Phase D's recompute saw the *previous*
   * commit's log array. This factory adds the typed seam #452 picks
   * up: tagged nodes are recomputed in Phase F.5 against the just-
   * refreshed `commitLogEntry.value`, so devtools surfaces can be
   * derived nodes rather than one-shot snapshots. Ordinary deriveds
   * are NOT affected by Phase F.5 — they settle exactly once per
   * commit in Phase D, preserving the §3 atomicity contract for code
   * that did not opt in.
   */
  function commitMetadataDerived<T>(
    id: NodeId,
    compute: Compute<T>,
  ): DerivedNode<T> {
    return derived(id, compute, { tag: 'commit-metadata' })
  }

  /**
   * Read the value of a node at the engine's current logical snapshot.
   * Outside a commit this is the most recent committed value; inside a
   * commit it transparently observes staged input writes — the same
   * commit-window read semantics that let a transaction body see its own
   * pending mutations without any other observer ever catching the engine
   * mid-flight.
   *
   * @typeParam T - Value type of the node.
   * @param node - The node handle.
   * @returns The current value of `node`.
   */
  function read<T>(node: Node<T>): T {
    const value = readEntry(node)
    // #1155 / #1241 — H1 hazard instrumentation. When the dev-only
    // warning is armed (opt-in via
    // `createCausl({ enableH1HazardWarning: true })`), record a
    // WeakRef to every non-null object/function returned to user
    // code so the commit-boundary walk can detect survivors carried
    // across a `now` tick. Four guards apply:
    //
    //   1. `h1HazardTrack === null` → instrumentation disabled
    //      (production default, or adopter did not opt in). Single
    //      null check, no work. The whole branch is wrapped in
    //      `process.env.NODE_ENV !== 'production'` so esbuild /
    //      terser DCE the body in prod (#1241 fix C).
    //   2. `activeReadTracker !== null` → we are inside a tracking
    //      projection (subscribeReads). Those reads are engine-
    //      internal and re-run on every commit by construction, so
    //      they never represent an adopter-cached reference.
    //   3. `adapterReadDepth > 0` → the read originates inside a
    //      canonical adapter's snapshot boundary (#1241 fix B). The
    //      adapter — e.g. `@causl/react`'s `useCauslNode` — wraps
    //      its `getSnapshot` callback in `__causlAdapterRead`, which
    //      enters this counter for the duration of the body. The
    //      retention is intrinsic to `useSyncExternalStore`'s
    //      tearing-detection contract, not an adopter bug.
    //   4. Value must be a non-null object or function for WeakRef
    //      to accept it. Primitives, `null`, and `undefined` cannot
    //      desynchronise from a backing cell because they ARE the
    //      cell value — H1 only bites when the engine's
    //      structurally-cloned object reference identity changes.
    if (process.env.NODE_ENV !== 'production') {
      if (
        h1HazardTrack !== null &&
        activeReadTracker === null &&
        adapterReadDepth === 0 &&
        value !== null &&
        (typeof value === 'object' || typeof value === 'function')
      ) {
        h1HazardTrack.push({
          ref: new WeakRef(value as object),
          nodeId: node.id,
          capturedAt: now,
        })
        // Bound worst-case walk cost by pruning aggressively when
        // the tracker grows past a soft cap. The prune is in-place
        // copy-survivors; dead refs (already-GC'd values) fall out.
        if (h1HazardTrack.length > H1_HAZARD_TRACK_CAP) {
          pruneH1HazardTrack()
        }
      }
    }
    return value
  }

  /**
   * #1155 — Soft cap on the H1 hazard tracking ring. Past this
   * length, `read()` triggers an in-place prune to drop dead refs
   * before appending more entries. Sized to absorb common burst-
   * read patterns (e.g. a viewport-render fan-out of ~1000 reads)
   * without growing unbounded between commits.
   *
   * #1241 — kept outside the tree-shake block because module-level
   * constant declarations cannot be conditionally declared in a TS
   * source. The `const` itself does not pull the WeakRef apparatus
   * into the prod bundle; it is dead-code-eliminated once the only
   * caller (`pruneH1HazardTrack`) is unreachable from the
   * tree-shaken `read()` body.
   */
  const H1_HAZARD_TRACK_CAP = 4096

  /**
   * #1155 — In-place prune of {@link h1HazardTrack}. Drops every
   * record whose WeakRef no longer has a live referent and rewrites
   * the array to compact the survivors. O(N) one-time cost amortised
   * across the cap; never grows the engine's retention beyond the
   * cap plus one commit's burst.
   */
  function pruneH1HazardTrack(): void {
    if (process.env.NODE_ENV === 'production') return
    if (h1HazardTrack === null) return
    let write = 0
    for (let read = 0; read < h1HazardTrack.length; read++) {
      const rec = h1HazardTrack[read]!
      if (rec.ref.deref() !== undefined) {
        h1HazardTrack[write++] = rec
      }
    }
    h1HazardTrack.length = write
  }

  /**
   * #1155 — Commit-boundary H1 hazard check. Walks
   * {@link h1HazardTrack}, emits one `console.warn` per survivor
   * whose `capturedAt < now` (recorded before the just-completed
   * commit's `now += 1`), and prunes dead refs in the same pass.
   * No-ops when the tracker is disabled. Safe to call from the
   * commit success arm only — the rollback path restores `now =
   * beforeNow`, which would re-arm prior-epoch entries as
   * "still-current" and produce no warnings.
   */
  function checkH1HazardOnCommit(): void {
    if (process.env.NODE_ENV === 'production') return
    if (h1HazardTrack === null || h1HazardTrack.length === 0) return
    let write = 0
    for (let read = 0; read < h1HazardTrack.length; read++) {
      const rec = h1HazardTrack[read]!
      const referent = rec.ref.deref()
      if (referent === undefined) continue
      if (rec.capturedAt < now) {
        // Survivor across a commit boundary — H1 hazard fired.
        // Single console.warn per offending nodeId-per-commit;
        // never throws.
        console.warn(
          `[causl] H1 hazard: graph.read(node '${rec.nodeId}') return value held across commit — reference identity not guaranteed (SPEC §15.1)`,
        )
        // Do NOT carry the record forward: the warning has been
        // delivered, and keeping the record would re-warn on every
        // subsequent commit even though the adopter has been told
        // exactly once. Drop the entry by skipping the write.
        continue
      }
      h1HazardTrack[write++] = rec
    }
    h1HazardTrack.length = write
  }

  /**
   * #1241 — Run `fn` with the H1 adapter-exemption seam engaged.
   *
   * Increments {@link adapterReadDepth} for the duration of `fn`'s
   * synchronous body; reads issued inside `fn` (or any function it
   * calls synchronously) bypass the H1 hazard tracker. Decrement is
   * unconditional via `finally`, so a throwing `fn` cannot leave
   * the counter sticky.
   *
   * Reachable only through `@causl/core/internal`'s
   * `__causlAdapterRead(graph, fn)` helper. Canonical adapters
   * (`@causl/react`'s `useCauslNode`, `useCausl`, `useCauslShallow`,
   * `useCauslTypedArrayNode`) wrap their `getSnapshot` body in
   * that helper so `useSyncExternalStore`'s snapshot-retention
   * contract does not produce a false-positive H1 warning.
   *
   * The seam is INTERNAL — adopter code MUST NOT import or rely on
   * it. The depth counter composes (a nested adapter call still
   * suppresses the outer one's tracking) but the public shape is
   * intentionally unconstrained.
   *
   * @internal
   */
  function runInAdapterReadMode<T>(fn: () => T): T {
    if (process.env.NODE_ENV === 'production') {
      // In production the H1 apparatus is tree-shaken away; the
      // depth counter is a no-op and the helper degenerates to
      // calling `fn()` directly. Keeping the function reachable
      // (rather than `undefined`) means adapter code does not need
      // a conditional on the import — every code path is uniform.
      return fn()
    }
    adapterReadDepth++
    try {
      return fn()
    } finally {
      adapterReadDepth--
    }
  }

  /**
   * O(|affected|) topological recompute seeded by `seedChanged`.
   *
   * Walks the reverse-dep graph (`dependents`) to enumerate the affected set,
   * Kahn-orders that set restricted to its internal edges, recomputes each
   * derivation once in topo order, and returns the ids whose values actually
   * changed (`Object.is` cutoff).
   *
   * @param seedChanged - Ids whose values changed at the start of the commit
   *  (the staged input writes). Treated as the BFS seed.
   * @returns The ids of derivations whose recomputed value differs from the
   *  previous one — used to populate `Commit.changedNodes` for downstream
   *  derivations.
   *
   * @remarks
   * Bounded work is a correctness criterion phrased as performance: a commit
   * producing `N` derived recomputations runs in O(N), not O(graph size).
   * Dirty marking and dependency walking are scoped to the affected subgraph;
   * unaffected nodes never get touched. The Kahn ordering across that
   * affected sub-graph is what makes glitch-freedom hold operationally — a
   * derivation evaluates after every transitively-affected upstream has
   * settled, so it cannot read a stale snapshot of one upstream alongside a
   * fresh snapshot of another. The diamond glitch ("D recomputes off
   * mismatched B and C versions") is a non-existent state because
   * `D(t) = f(B(t), C(t))` is a function: whatever the scheduler does,
   * the meaning is fixed.
   *
   * #941 — capture-by-reference audit (mirror of #882 / PR #907 Phase B
   * amortisation). Hypothesis: the per-row `entries.get(id)` Map probes
   * inside Phase 2 (indegree calc) and Phase 4 (recompute) could be
   * eliminated by capturing the resolved `DerivedEntry` once during the
   * Phase 1 BFS over `dependents` and walking the captured array thereafter.
   *
   * Negative finding — deferred. The `linear-chain × 1k` baseline
   * INTERPRETATION.md (#912 re-capture) ranks `getEntry` at 0.64%
   * engine-self-time (rank 25), which sits below the 100 µs `--cpu-prof`
   * sampler floor on the 160 ms main-thread trace. A capture-by-reference
   * refactor that fully eliminated the per-row probe could shave at most
   * ~0.6% of trace time — well below the 10% CoV-bound improvement floor
   * the perf-engine track requires for a shipping PR (#883 / #881 / #917 /
   * #931 negative-finding precedent). A FAIL-first catalogue invalidator
   * `self-time-pct-below: getEntry, threshold: 1` cannot be honestly
   * authored against the current trace because the symbol already passes
   * a 1% threshold; tightening past the noise floor would gate on
   * sampler jitter, not architecture.
   *
   * The seam is preserved as a future-work hook: if a future scenario
   * widens Phase D's affected set into the tens-of-thousands range and
   * `getEntry` self-time climbs above the sampler floor, the
   * capture-by-reference refactor — capture entries during Phase 1 BFS
   * into an `affectedEntries: Map<NodeId, DerivedEntry>` parallel
   * structure, walk `affectedEntries.values()` in Phase 2, and carry
   * `ordered: DerivedEntry[]` through Phase 3 / 4 — is the obvious next
   * step. The invariant a future implementer relies on is that every id
   * reachable through `dependents` is, by construction, a registered
   * derivation (`dependents` is populated exclusively by `setDeps` /
   * `setDepsFromArray`, and disposal is forbidden mid-commit by
   * {@link DisposalDuringCommitError}), so the captured reference is
   * always live for the duration of the walk.
   *
   * Property test pinning denotational equivalence regardless of the
   * walker's internal lookup-vs-capture shape:
   * `packages/core/test/properties/phase-d-entry-capture.property.test.ts`.
   * 1000+ random topologies × random commit storms verify every
   * `(input, derived)` post-commit value matches a forward-evaluation
   * oracle, so any future capture-by-reference rewrite has a regression
   * gate ready.
   */
  /**
   * Rollback record for a single derived node touched by a recompute
   * pass. Captures everything `computeDerived` mutates so the catch
   * arm in `commit()` can restore byte-identical state on a throw.
   *
   * @internal
   */
  interface DerivedRollback {
    readonly value: unknown
    readonly deps: ReadonlySet<NodeId>
    readonly computed: boolean
    readonly lastTime: GraphTime
  }

  /**
   * Lazy-allocation holder for the per-commit derived rollback map
   * (#1010). Phase D's fixpoint and Phase F.5's commit-metadata
   * recompute both record their pre-recompute byte-state into the
   * same map so the catch arm in `commitInternal` (and the
   * unconditional rollback arm in `simulate`) can restore it byte-
   * identically. Pre-#1010 the map was always allocated at commit
   * start; commits whose Phase D short-circuits (no input change, or
   * an empty downstream set) never populated it, so the allocation
   * (Map wrapper + internal hash table) was dead work. The holder
   * pattern moves the `new Map()` to the first derived rollback
   * write — the only call site that actually needs it. All
   * consumers walk `holder.map` (or guard on undefined). Mirrors the
   * #985 firedManyGroups lazy-mint precedent.
   *
   * @internal
   */
  interface DerivedRollbackHolder {
    map: Map<NodeId, DerivedRollback> | undefined
  }

  function recomputeAffected(
    seedChanged: ReadonlySet<NodeId>,
    rollback?: DerivedRollbackHolder,
  ): NodeId[] {
    // #963 — fused Phase 1 + Phase 2. The pre-#963 walker did a BFS
    // over `dependents` to collect `affected`, then re-iterated
    // `affected` to walk each derived's `e.deps` and count edges
    // internal to the affected set. The two passes touch the same node
    // set; the second pays a redundant `entries.get(id)` per affected
    // node and a full `e.deps` traversal whose information was already
    // implicit in the first pass.
    //
    // Fusion: the BFS expands frontiers along `dependents` (forward
    // edges from upstream to downstream). Each time we visit a node
    // `id` that is already in `affected` (i.e. a derived, not a seed
    // input) and walk its `dependents.get(id)`, every outgoing edge
    // `id → d` is an incoming edge to `d` from a node in `affected`.
    // Incrementing `indegree[d]` at that moment captures the same
    // count Phase 2 derived from `e.deps`.
    //
    // The seed-input edges DON'T count: the seed input is a settled
    // upstream not in `affected`, so its outgoing edges to derived
    // children represent "external upstream already settled" exactly
    // the way Phase 2 distinguished them.
    //
    // Algorithm:
    //   1. Seed the BFS frontier with each input's downstream
    //      derivations. These get `indegree[d] = 0` (no internal
    //      incoming edge — the seed input is external).
    //   2. While draining the queue, walk `dependents.get(id)`. For
    //      each downstream `d`:
    //      - Increment `indegree[d]` by 1 (edge from `id ∈ affected`).
    //      - If `d` is not yet in `affected`, add it + enqueue +
    //        initialise `indegree[d]` to 1 (the edge we just counted).
    //      - If `d` is already in `affected`, just bump the existing
    //        `indegree[d]`.
    //
    // The Phase 3 Kahn drain reads the same indegree map structure,
    // so its body is unchanged.
    const affected = new Set<NodeId>()
    const indegree = new Map<NodeId, number>()
    const queue: NodeId[] = []
    // Seed: each input's immediate downstream gets enqueued with
    // indegree 0 (the seed-input edge is external — settled upstream).
    for (const id of seedChanged) {
      const downstream = dependents.get(id)
      if (!downstream) continue
      for (const d of downstream) {
        if (!affected.has(d)) {
          affected.add(d)
          indegree.set(d, 0)
          queue.push(d)
        }
        // If `d` was already added by a previous seed input's walk,
        // the indegree is unchanged: both seed-input edges are
        // external. The seed loop never increments indegree.
      }
    }
    // Drain the queue. Each `id` here is a derived in `affected`;
    // every outgoing edge to a downstream `d` adds 1 to `indegree[d]`
    // because `id` is internal to the affected set.
    // Head-pointer iteration (#703 Win 4): Array.shift() is O(n) in V8;
    // for ~1k affected nodes the per-pop element copies dominate. The
    // queue is append-only here, so a monotonic head pointer reads the
    // next entry in O(1). The `queue` array is thrown away at the end
    // of the function.
    let qHead = 0
    while (qHead < queue.length) {
      const id = queue[qHead++]!
      const downstream = dependents.get(id)
      if (!downstream) continue
      for (const d of downstream) {
        if (affected.has(d)) {
          // `d` was already discovered by an earlier edge; bump its
          // internal-incoming count by 1 for this newly-walked edge.
          indegree.set(d, indegree.get(d)! + 1)
        } else {
          // First time we see `d`. The current edge counts as 1
          // internal incoming; later visits to `d`'s other parents
          // will bump the count further.
          affected.add(d)
          indegree.set(d, 1)
          queue.push(d)
        }
      }
    }
    // Kahn seed: nodes with no internal upstream are ready immediately.
    const ready: NodeId[] = []
    for (const [id, d] of indegree.entries()) {
      if (d === 0) ready.push(id)
    }
    // Phase 3: drain the ready queue, decrementing successors' indegree as we go.
    // Head-pointer iteration (#703 Win 4) — same reasoning as the BFS
    // queue above; `ready` is append-only.
    const ordered: NodeId[] = []
    let rHead = 0
    while (rHead < ready.length) {
      const id = ready[rHead++]!
      ordered.push(id)
      const downstream = dependents.get(id)
      if (!downstream) continue
      for (const d of downstream) {
        if (!affected.has(d)) continue
        const cur = indegree.get(d)
        if (cur === undefined) continue
        const next = cur - 1
        indegree.set(d, next)
        if (next === 0) ready.push(d)
      }
    }
    // Cycle promotion (#705): the pre-#705 fallback silently appended
    // any nodes the topo walk missed and then ran them in arbitrary
    // order, tolerating cycles. With the registration-time DFS gate
    // dropped, the only place a back-edge in the *current* dep graph
    // can fire is here — so promote the fallback to a typed
    // {@link CycleError} naming the residue path. The walk recovers
    // a cycle from the unprocessed set by chasing dep edges from any
    // residue node along nodes that remain in the residue (cycles
    // are exactly the strongly-connected components Kahn could not
    // drain).
    if (ordered.length < affected.size) {
      const orderedSet = new Set(ordered)
      const residue: NodeId[] = []
      for (const id of affected) {
        if (!orderedSet.has(id)) residue.push(id)
      }
      throw new CycleError(recoverCyclePath(residue))
    }

    // Phase 4: recompute in topo order, recording derivations whose value actually changed.
    // Maintain `processedThisPass` so the post-recompute back-edge
    // probe (the #705 latent-cycle catcher) can recognise a newly-
    // recorded dep that closes a cycle through a node already
    // recomputed earlier in this pass. The probe is the
    // commit-time replacement for the pre-#705 registration-time
    // strict-cycle gate: SPEC §9.1 row 8 commits to "Detected at the
    // first commit that closes the cycle, with a structured error
    // naming the cycle path", and the dropped registration gate
    // means that responsibility now falls entirely on Phase D.
    const processedThisPass = new Set<NodeId>()
    const changedThisCommit: NodeId[] = []
    for (const id of ordered) {
      const e = entries.get(id)
      if (!e || e.kind !== 'derived') continue
      const before = e.value
      const wasComputed = e.computed
      // #703 Win 3 — `setDeps` swaps `e.deps` by reference (it never
      // mutates the existing Set in place), so the pre-recompute
      // reference stays valid after the recompute as the snapshot of
      // the prior dep-set. No clone needed for the post-recompute
      // new-dep probe below; the captured reference is the prior set
      // and `e.deps` is the new one.
      const prevDeps = e.deps
      // Atomicity rollback (EPIC #280 / #265): a transaction creates
      // exactly one new GraphTime, so a partial recompute cannot be
      // observable. Record the pre-recompute state of every derived
      // we are about to touch so the commit() catch arm can restore
      // byte-identical state if any compute() call throws partway
      // through this loop.
      //
      // #703 Win 3 — `deps` is captured by reference (no `new Set(...)`
      // clone) for the same swap-not-mutate reason. The audit's
      // load-bearing invariant — `setDeps` NEVER mutates the
      // previously-captured deps Set — is property-tested in
      // `test/properties/setDeps-immutability.test.ts` (1000+ random
      // graphs).
      if (rollback !== undefined) {
        // #1010 — lazy-mint the rollback Map on the first derived
        // recompute that needs to record pre-state. Commits whose
        // Phase D short-circuits (e.g. `changedInputIds.length === 0`
        // gate at the call site) never enter this loop, so the
        // `new Map()` allocation is amortised away on the empty-
        // recompute fast path. Subsequent iterations within the same
        // pass re-use the same Map (no re-mint).
        let m = rollback.map
        if (m === undefined) {
          m = new Map<NodeId, DerivedRollback>()
          rollback.map = m
        }
        if (!m.has(id)) {
          m.set(id, {
            value: e.value,
            deps: e.deps,
            computed: e.computed,
            lastTime: e.lastTime,
          })
        }
      }
      computeDerived(e)
      processedThisPass.add(id)
      // Latent-cycle probe (#705): if the just-recomputed entry
      // gained a *new* dep edge (dynamic-dep tracking), walk forward
      // from each new dep along the live `entries.deps` graph to
      // see if the just-recomputed entry is reachable. A reachable
      // path is a cycle the user's compute just closed (the canonical
      // case is a forward-reference holder mutated post-registration
      // so two endpoints reference each other once both are
      // computed). The walk only follows edges among entries whose
      // deps may have shifted this commit (i.e. entries in
      // `processedThisPass` plus entries pinned by the dynamic-dep
      // graph). For unchanged dep sets the probe is a no-op.
      let hasNewDep = false
      for (const d of e.deps) {
        if (!prevDeps.has(d)) {
          hasNewDep = true
          break
        }
      }
      if (hasNewDep) {
        const cyclePath = findCyclePathFrom(e.id)
        if (cyclePath !== null) {
          throw new CycleError(cyclePath)
        }
      }
      // Equality cutoff: only propagate "changed" if the new value differs from the prior.
      if (!wasComputed || !Object.is(before, e.value)) {
        changedThisCommit.push(id)
      }
    }
    return changedThisCommit
  }

  /**
   * Phase F.5 — recompute every commit-metadata-tagged derived against
   * the just-refreshed `commitLogEntry.value` (#452).
   *
   * Phase D's recompute fixpoint walks the affected sub-graph against
   * the *previous* commit's `commitLog` array because Phase F.4 has
   * not yet run. A derivation registered through
   * {@link Graph.commitMetadataDerived} therefore holds a stale value
   * after Phase D — its compute saw the pre-F.4 log. This helper runs
   * a *second* recompute pass restricted to those tagged ids, by
   * which point Phase F.4 has refreshed `commitLogEntry.value` and
   * `now` stamps the just-completed commit.
   *
   * The pass is intentionally *not* allowed to widen onto ordinary
   * deriveds. Phase D's atomicity contract (§3) is the load-bearing
   * invariant for code that did not opt in: an ordinary derivation
   * settles exactly once per commit. Letting Phase F.5 propagate into
   * downstream ordinary deriveds would re-recompute them against a
   * mid-commit value and violate that contract. Application code that
   * needs an ordinary derived to track a commit-metadata derived's
   * output composes the commit-metadata derived as a leaf and reads
   * it on the next commit, when Phase D will have caught up.
   *
   * `rollback` is the same map Phase D writes to; the catch arm in
   * `commit()` restores byte-identical state regardless of which
   * phase the throw escaped from.
   *
   * @returns The ids of commit-metadata deriveds whose recomputed
   *   value differs from the post-Phase-D one — added to the commit's
   *   `changed` set so Phase G's per-node subscriber dispatch fires
   *   subscribers on the same commit that produced the new value.
   */
  function recomputeCommitMetadata(
    rollback: DerivedRollbackHolder,
  ): NodeId[] {
    if (commitMetadataIds.size === 0) return []
    const changedThisPhase: NodeId[] = []
    // Iterate in registration order. Commit-metadata deriveds may
    // depend on each other; topologically ordering would require
    // rebuilding the indegree map from scratch each phase, but since
    // §11 anchors the surface around the leaf-shaped use case (a
    // single derived that reads `graph.commitLog`), the registration
    // order is the cheapest correct order. If a future PR composes
    // commit-metadata deriveds into a deeper sub-DAG, this loop is
    // the seam to upgrade — the rollback bookkeeping is already
    // correct under any iteration order.
    for (const id of commitMetadataIds) {
      const e = entries.get(id)
      if (!e || e.kind !== 'derived') continue
      const before = e.value
      const wasComputed = e.computed
      // #1010 — lazy-mint the rollback Map on the first derived
      // recompute that needs to record pre-state. Phase F.5 is gated
      // on `commitMetadataIds.size > 0` at the call site, so adopters
      // who never opted into commit-metadata deriveds never enter
      // this helper at all. Adopters who did, but whose Phase D
      // already populated the holder, reuse the existing Map.
      let m = rollback.map
      if (m === undefined) {
        m = new Map<NodeId, DerivedRollback>()
        rollback.map = m
      }
      if (!m.has(id)) {
        m.set(id, {
          value: e.value,
          // #703 Win 3 — capture by reference; `setDeps` swaps the
          // reference rather than mutating in place, so the prior
          // set stays a valid pre-recompute snapshot for the
          // commit() catch-arm rollback. Same invariant as Phase D's
          // capture site above; same property-test gate
          // (`test/properties/setDeps-immutability.test.ts`).
          deps: e.deps,
          computed: e.computed,
          lastTime: e.lastTime,
        })
      }
      computeDerived(e)
      if (!wasComputed || !Object.is(before, e.value)) {
        changedThisPhase.push(id)
      }
    }
    return changedThisPhase
  }

  /**
   * Run a transaction. Stages input writes, then on success advances
   * GraphTime by one, recomputes the affected sub-graph, publishes a
   * {@link Commit} record, notifies subscribers, and finally invokes commit
   * observers.
   *
   * @param intent - Human-readable label describing the commit's purpose;
   *  recorded verbatim into the commit history.
   * @param run - Callback that receives the {@link Tx} handle and stages writes.
   * @returns The frozen {@link Commit} describing this transaction.
   * @throws {@link CommitInProgressError} if invoked re-entrantly.
   * @throws {@link StaleTxError} if `tx.set` is called after `run` returned.
   * @throws {@link NotAnInputNodeError} if `tx.set` targets a non-input.
   * @throws {@link CycleError} if a recompute closes a dependency cycle.
   *
   * @remarks
   * `commit` is the only API in the engine that advances GraphTime; this
   * is the contract that lets atomicity hold as a theorem. Outside a
   * commit the graph is read-only; inside, reads see staged writes; and
   * the captured `tx` cannot escape the synchronous `run` body, so there
   * is no concurrent-write API to misuse. Observer faults are isolated
   * through {@link reportObserverError} so a single bad subscriber cannot
   * abort downstream notification or corrupt engine state, and a
   * multi-write commit that converges to a single new value fires exactly
   * one notification per affected subscriber, not one per write.
   */
  function commit(intent: string, run: (tx: Tx) => void): Commit {
    return commitInternal(intent, run)
  }

  /**
   * Phase D — recompute fixpoint over the affected sub-graph
   * (SPEC §5.1, row D). Thin wrapper around {@link recomputeAffected}
   * so the cpuprofile trace shows a `phaseD_*` frame matching the
   * `^phase[A-H]` filter convention adopted alongside the F.4 / F.6 /
   * G / H hoists (#878). All commit-local state — the changed-id
   * accumulator and the derived rollback map — is passed explicitly
   * to keep the inner function out of `commitInternal`'s lexical
   * scope; closing over hot-loop variables risks V8 deopt.
   */
  function phaseD_recomputeAffected(
    changed: Set<NodeId>,
    derivedRollback: DerivedRollbackHolder,
  ): readonly NodeId[] {
    return recomputeAffected(changed, derivedRollback)
  }

  /**
   * Phase F.4 — refresh the engine-owned `commitLog` derived entry
   * (SPEC §5.1, row F.4). Hoisted out of `commitInternal` (#878) so
   * the trace shows the rebuild as a distinct frame separate from
   * the bounded-history append (Phase F) and the commit-metadata
   * recompute (Phase F.5). Caller is responsible for the
   * `commitHistoryCap > 0 && commitLogConsumerCount > 0` gate.
   */
  function phaseF4_refreshCommitLog(currentNow: GraphTime, changed: Set<NodeId>): void {
    commitLogEntry.value = buildCommitLogValue()
    commitLogEntry.lastTime = currentNow
    changed.add(COMMIT_LOG_ID)
  }

  /**
   * Phase F.6 — retain a per-commit input snapshot for `readAt(t)`
   * (SPEC §5.1, row F.6, #235). Hoisted out of `commitInternal`
   * (#878) so the delta-chain construction and FIFO eviction loop
   * appear as a single named frame in the cpuprofile trace.
   *
   * Caller is responsible for the `commitHistoryCap > 0` gate
   * (SPEC §5.1 amendment 1, #715). The function reads
   * `retainedSnapshots`, `snapshotRetentionCap`, and the input
   * entry table from `createCausl`-scope; no closure over
   * `commitInternal`-local state.
   */
  function phaseF6_retainInputSnapshot(
    currentNow: GraphTime,
    changedInputIds: readonly NodeId[],
  ): void {
    const delta = new Map<NodeId, unknown>()
    for (const id of changedInputIds) {
      const e = entries.get(id)
      // #703 Win 1 — `isInputValueSerializable` reads the cached
      // verdict on `InputEntry.serializableMemo` after the first
      // probe; the cache is invalidated to `undefined` only on
      // `tx.set`, so a stable structured input value pays the
      // `JSON.stringify` round-trip exactly once across the input's
      // lifetime instead of every commit. Phase F.6 is the hot
      // call site the audit (#703) flagged.
      if (
        e &&
        e.kind === 'input' &&
        isInputValueSerializable(e, inputSerializableMemo)
      ) {
        delta.set(id, e.value)
      }
    }
    const head =
      retainedSnapshots.length > 0
        ? retainedSnapshots[retainedSnapshots.length - 1]!
        : null
    retainedSnapshots.push({ time: currentNow, delta, prev: head })
    // FIFO eviction: when the buffer exceeds the cap, drop the chain
    // root and promote its surviving deltas into the new root for any
    // ids the new root doesn't already define. Without promotion an
    // input whose last write lived in the dropped row would orphan: a
    // chain walk from the (formerly second) row would fall through
    // into a detached chain or null pointer. Promotion is amortised
    // O(1) per commit because each cell is promoted to a chain root
    // at most once before being overwritten by a later delta.
    while (retainedSnapshots.length > snapshotRetentionCap) {
      const evicted = retainedSnapshots.shift()!
      const newRoot = retainedSnapshots[0]
      if (!newRoot) break
      // Resolve every cell reachable from the dropped row's chain
      // (its own delta plus any ancestors it still pointed at) and
      // fold them into the new root for ids the new root doesn't
      // already define. The new root's existing delta always wins
      // because it represents a more-recent (or equal-time) write.
      // After the first eviction the chain has already been severed
      // at the previous root, so `evicted.prev` is typically null —
      // but the walk handles deeper chains correctly during initial
      // fill (genesis + commits before any eviction happens).
      let cur: RetainedRow | null = evicted
      while (cur !== null) {
        for (const [id, v] of cur.delta) {
          if (!newRoot.delta.has(id)) {
            newRoot.delta.set(id, v)
          }
        }
        cur = cur.prev
      }
      // Sever the chain at the new root: it is now self-contained.
      newRoot.prev = null
    }
  }

  /**
   * Phase G — per-node subscriber dispatch (SPEC §5.1, row G).
   * Hoisted out of `commitInternal` (#878) so the per-node bucket
   * walk and the per-projection re-run live as a single named frame
   * in the cpuprofile trace. The `anyInputSubscriberIn` /
   * `anyProjectionDepIn` empty-derivation gates remain inlined in
   * the caller (already named, below the 100µs sampler floor).
   *
   * Caller is responsible for the `changed.size > 0` gate.
   * `pendingTransientDrops` is mutated for #766 transient
   * auto-dispose; the `finally` arm of `commitInternal` drains it.
   *
   * #881 closure-hoist audit (post-#878): the body intentionally
   * carries **no per-commit `(...) => {}` allocation**. Both per-call
   * `Set` instances (`firedManyGroups` for the #766 `subscribeMany`
   * dedupe and the gated `fired` set for the #701 projection
   * dispatch) are iteration-state containers, not closures over
   * outer state — they capture nothing across calls. All observer
   * invocations are direct method calls (`sub.observer(v, ...)`,
   * `reg.observer(c, ...)`); helpers (`runProjectionTracked`,
   * `reconcileProjectionDeps`, `reportObserverError`, `readEntry`)
   * close over the engine instance once at `createCausl` time. A
   * future PR introducing a per-commit arrow expression here would
   * regress the #881 baseline (`scrolling-viewport × 10000`:
   * `phaseG_dispatchPerNodeSubscribers` self-time below the 100 µs
   * sampler floor, frame absent from the trace at all ranks).
   */
  function phaseG_dispatchPerNodeSubscribers(
    changed: ReadonlySet<NodeId>,
    c: Commit,
    currentNow: GraphTime,
  ): void {
    // #671 per-node index dispatch: walk only the subscriptions
    // observing changed nodes, skipping the O(|subscriptions|)
    // sweep across nodes whose value provably can't have moved.
    // The flat `subscriptions` Set remains the source of truth
    // for snapshot/clear paths; this loop reads the per-node
    // index built at subscribe-time.
    // #766 per-commit dedupe set for `subscribeMany` groups.
    // When several of a group's nodes change in the same commit,
    // every entry's bucket walk would otherwise call the shared
    // observer once per changed member. The set stamps each
    // group's first-seen-this-commit fire so subsequent entries
    // belonging to the same group skip the dispatch.
    //
    // Allocated lazily — for plain single-node `subscribe`
    // registrations every `sub.manyGroup` is `null`, so the Set
    // is never minted (#980). Adopters using only the canonical
    // single-node `subscribe` API pay zero allocation here per
    // commit, mirroring the #915/#916 InputEntry/SubscriptionEntry
    // lazy-mint discipline. The dedupe Set materialises on the
    // first observed `subscribeMany` member during this dispatch.
    let firedManyGroups: Set<ManyGroup> | undefined
    for (const changedId of changed) {
      const bucket = subscriptionsByNode.get(changedId)
      if (bucket === undefined) continue
      for (const sub of bucket) {
        // Skip entries whose `subscribeMany` group already fired
        // earlier in this dispatch loop (a previous bucket walk
        // saw a different member of the same group). The latch
        // also covers the case where an earlier observer in the
        // same commit dropped the group (transient or manual
        // unsubscribe from inside another fire) — the group's
        // `disposed` flag is consulted defensively below.
        if (sub.manyGroup !== null) {
          if (sub.manyGroup.disposed) continue
          if (firedManyGroups !== undefined && firedManyGroups.has(sub.manyGroup)) continue
        }
        const v = readEntry(sub.node)
        if (!sub.hasFired || !Object.is(sub.lastValue, v)) {
          sub.lastValue = v
          sub.hasFired = true
          if (sub.manyGroup !== null) {
            if (firedManyGroups === undefined) firedManyGroups = new Set()
            firedManyGroups.add(sub.manyGroup)
          }
          // Isolate observer faults so the rest of the dispatch loop continues.
          try {
            sub.observer(v, currentNow)
          } catch (err) {
            reportObserverError(err, {
              source: 'node-subscriber',
              nodeId: sub.node.id,
              time: currentNow,
            })
          }
          // #766 transient auto-dispose. After the observer
          // returns (or throws and is caught above), schedule the
          // entry for end-of-commit drop. For a many-group, mark
          // every member of the group so the drain loop drops
          // them all atomically — the group's `disposed` latch
          // also flips so any later bucket walk in this same
          // commit skips the group entirely.
          if (sub.transient) {
            if (sub.manyGroup !== null) {
              for (const peer of sub.manyGroup.entries) {
                pendingTransientDrops.add(peer)
              }
            } else {
              pendingTransientDrops.add(sub)
            }
          }
        }
      }
    }
    // #701 per-projection dispatch (SPEC §11.1 amended). Same
    // per-node index shape as the per-node subscriber walk above:
    // for each `changedId` look up the registrations whose
    // `recordedDeps` cover that id, re-run each projection under
    // the tracking accessor (refreshing `recordedDeps` so
    // conditional reads follow the live branch), and fire the
    // observer with the fresh value. A registration whose
    // `recordedDeps` doesn't intersect `changed` is never
    // visited — the firehose acceptance for #701 is O(1) per
    // commit on a 1000-registrant single-node-changed cell.
    //
    // Dedupe: a single commit may move multiple deps on the
    // same registration (a projection that reads both A and B,
    // where the commit changes both). Use a per-commit `fired`
    // Set so the observer fires exactly once for the registration
    // — same "exactly one notification per commit" contract the
    // per-node subscriber dispatch enforces via the
    // `Object.is(lastValue, v)` cutoff.
    if (subscribeReadsRegistrations.size > 0) {
      const fired = new Set<SubscribeReadsRegistration>()
      for (const changedId of changed) {
        const bucket = subscribeReadsByNode.get(changedId)
        if (bucket === undefined) continue
        for (const reg of bucket) {
          if (fired.has(reg)) continue
          fired.add(reg)
          // Re-run the projection under the tracking accessor.
          // A throw escaping the projection is reported through
          // the observer-error channel; the registration's
          // `recordedDeps` is left intact so the next commit
          // retries against the same dep set. The Phase G
          // dispatch loop continues with the next bucket entry.
          let result: { value: unknown; deps: Set<NodeId> }
          try {
            result = runProjectionTracked(reg.projection)
          } catch (err) {
            reportObserverError(err, {
              source: 'subscribe-reads-projection',
              time: currentNow,
            })
            continue
          }
          reconcileProjectionDeps(reg, result.deps)
          try {
            reg.observer(c, result.value)
          } catch (err) {
            reportObserverError(err, {
              source: 'subscribe-reads',
              time: currentNow,
            })
          }
        }
      }
    }
  }

  /**
   * Phase H — commit-level subscriber dispatch (SPEC §5.1, row H).
   * Hoisted out of `commitInternal` (#878) so the
   * `commitObservers` fan appears as a distinct frame in the
   * cpuprofile trace, separate from Phase G's per-node dispatch.
   * Caller is responsible for the `commitObservers.size > 0`
   * gate (SPEC §5.1 amendment 1, #715).
   *
   * #881 closure-hoist audit (post-#878): the body is a single
   * `for…of` over `commitObservers` with one `try/catch`. **No
   * `(...) => {}` allocated per commit.** A future regression that
   * wraps `obs(c)` in a per-call lambda (e.g. for batching or
   * scheduling) would re-introduce the per-commit allocation #881
   * audited against; the post-#854 trace baseline has this frame
   * below the 100 µs sampler floor on
   * `scrolling-viewport × 10 000`.
   */
  function phaseH_dispatchCommitObservers(c: Commit, currentNow: GraphTime): void {
    for (const obs of commitObservers) {
      try {
        obs(c)
      } catch (err) {
        reportObserverError(err, { source: 'commit-subscriber', time: currentNow })
      }
    }
  }

  /**
   * Internal commit driver. Public `commit(intent, run)` and the privileged
   * mutation paths that route through the same Phase A–H pipeline (today:
   * `hydrate`) share this body; the `originatedAt` parameter lets `hydrate`
   * carry the snapshot's recorded GraphTime through to the published
   * {@link Commit} as `originatedAt`, while the engine clock still
   * advances by exactly one tick (the §3 monotonicity invariant). Public
   * commits leave `originatedAt` undefined.
   */
  function commitInternal(
    intent: string,
    run: (tx: Tx) => void,
    originatedAt?: GraphTime,
  ): Commit {
    // Re-entrancy guard: nested commits are forbidden.
    if (committing) throw new CommitInProgressError()
    committing = true
    // #995 — `stagedWriteEntries` / `stagedWriteValues` are the
    // engine-closure parallel arrays that replace the value half of
    // the pre-#995 `staged` Map; the read-shadow / dedup half is
    // served by the per-entry `lastStagedAt` / `lastStagedRow`
    // fields on InputEntry. The arrays are truncated (not re-
    // allocated) so backing storage is reused across commits.
    // `stagedActive` arms the read-shadow probe in `readEntry`. See
    // the declaration at the top of this closure for the full
    // design rationale.
    stagedWriteEntries.length = 0
    stagedWriteValues.length = 0
    stagedActive = true
    // #882 — rollback bookkeeping switched from twin
    // `Map<NodeId, ...>` to a parallel `InputEntry[] / unknown[] /
    // GraphTime[]` triple. The Map shape allocated 2× per changed
    // input; the parallel arrays push 1× per changed input. Phase B
    // already holds the `InputEntry` reference at the row site, so
    // the catch-arm rollback walks them directly (no `entries.get`
    // probe per row). Atomicity invariant unchanged: every byte
    // Phase B mutated is restored on throw.
    //
    // #994 — declared above the `tx` closure (was: declared just
    // below) so the `tx.set` `hasDependents` fast path can push
    // rollback rows for isolated-input writes during Phase A,
    // without going through `staged`. Slow-path rows are still
    // pushed by Phase B's stagedEntries walk; the two paths share
    // the same parallel-arrays shape so the catch-arm restore
    // walks them uniformly.
    const inputRollbackEntries: InputEntry[] = []
    const inputRollbackPriorValues: unknown[] = []
    const inputRollbackPriorLastWrite: GraphTime[] = []
    const beforeNow = now
    // `txAlive` enforces that `tx.set` cannot escape the synchronous `run` body.
    let txAlive = true
    const tx: Tx = {
      set<T>(node: InputNode<T>, value: T): void {
        // Reject post-`run` use of a captured `tx` reference.
        if (!txAlive) throw new StaleTxError()
        const id = (node as AnyNode).id
        // The public Node type carries no `kind` discriminator — that
        // would be class taxonomy masquerading as a domain model — so
        // the input/derived check routes through the engine's internal
        // entry table. `getEntry` raises {@link NodeDisposedError} for
        // tombstoned ids and {@link UnknownNodeError} for ids the
        // engine has never seen; only registered inputs pass.
        const e = getEntry(id)
        if (e.kind !== 'input') throw new NotAnInputNodeError(id)
        // #994 — `hasDependents` fast path. When the input has no
        // derived consumer, no Phase D recompute walk will ever
        // visit this id. The slow-path `staged` Map's only role
        // for such an input is to dedup re-writes (so the Phase B
        // publish loop sees one value per input) and to drive the
        // read-shadow semantics in `readEntry` (so an in-tx
        // `tx.set(X, v); tx.get(X)` pair sees `v`, not the
        // pre-commit cell). Both roles can be served more cheaply
        // by writing the cell directly: re-writes update `e.value`
        // in place (last-write-wins falls out of the assignment
        // order), and reads of `e.value` see the latest write
        // because the `staged.has` probe in `readEntry` falls
        // through to the cell when no slow-path stage exists.
        //
        // Atomicity is preserved because the fast path *still*
        // pushes to the rollback arrays (so a throw escaping a
        // *different* slow-path write's Phase D recompute walk
        // restores this isolated input byte-identically). Dedup
        // of in-tx re-writes uses `e.lastWriteTime > now` as a
        // sentinel: the first fast-path write to an input stamps
        // `now + 1` (the post-tick value Phase C.5 will
        // idempotently re-stamp on commit success); subsequent
        // writes detect the prior touch and skip the rollback push.
        //
        // The fast path does NOT add to `changedInputIds` here —
        // a `tx.set(X, v0); tx.set(X, v1); tx.set(X, v0)` sequence
        // ends with `e.value === priorValue` and SPEC's
        // "changedNodes is the set of nodes whose value changed"
        // contract (#987 / PR #990) demands the input be excluded
        // from `changedNodes` on revert. The Phase A.5
        // finalisation walk just below the `run(tx)` call filters
        // reverts before adding the survivors to `changedInputIds`.
        if (!e.hasDependents) {
          if (Object.is(e.value, value)) return
          if (e.lastWriteTime > now) {
            // Re-write within the same tx — the rollback row was
            // already captured on the first fast-path write to
            // this input. Update the cell directly so subsequent
            // reads see the latest value.
            e.value = value
            return
          }
          // First fast-path write to this input this tx. Capture
          // the rollback row, update the cell, stamp the sentinel.
          inputRollbackEntries.push(e)
          inputRollbackPriorValues.push(e.value)
          inputRollbackPriorLastWrite.push(e.lastWriteTime)
          e.value = value
          // Sentinel: `now + 1` is the post-tick value Phase C.5
          // will stamp on commit success (idempotent re-write).
          // On rollback, the catch-arm restores the prior value
          // captured above.
          e.lastWriteTime = now + 1
          return
        }
        // #972 / #995 — equal-value write fast path on the split-
        // staged shape. Pre-#995 the dedup path probed the single
        // `staged` Map: `staged.has(id)` then `staged.get(id)`; the
        // staging path then pushed to `stagedEntries` AND wrote
        // `staged.set(id, value)`. Post-#995 the dedup probe is one
        // monomorphic field comparison (`e.lastStagedAt === now`);
        // a re-write updates the existing `stagedWriteValues[idx]`
        // slot in place. The two-branch shape preserves the re-
        // write semantics — if the tx already staged a different
        // value to this input, the comparison must be against the
        // staged value, not the committed `e.value`, otherwise a
        // sequence `set(in, X) → set(in, currentValue)` would skip
        // the second call and leave the prior staged `X` on Phase B.
        if (e.lastStagedAt === now) {
          // Already staged this input in this commit — compare
          // against the staged value so a "revert to same value"
          // path is a no-op too.
          const idx = e.lastStagedRow
          if (Object.is(stagedWriteValues[idx], value)) return
          stagedWriteValues[idx] = value
          return
        }
        // First write to this input in this tx — fast path: if the
        // value matches the committed cell, the row would be
        // filtered by Phase B's `Object.is` gate anyway. Skip
        // staging.
        if (Object.is(e.value, value)) return
        // First slow-path write of this commit. Stamp the per-
        // entry sentinels (one field write each) and push entry +
        // value to the parallel commit-log arrays. No Map allocation
        // — the read-shadow probe in `readEntry` and the re-write
        // probe above both consult `lastStagedAt === now` directly.
        e.lastStagedAt = now
        e.lastStagedRow = stagedWriteEntries.length
        stagedWriteEntries.push(e)
        stagedWriteValues.push(value)
      },
    }

    const changedInputIds: NodeId[] = []
    // #1010 — lazy-allocate the derived rollback Map. The holder is
    // a single tiny object (`{ map: undefined }`) allocated per
    // commit; the Map itself is minted only on the first derived
    // recompute that actually needs to record pre-state (inside
    // `recomputeAffected` / `recomputeCommitMetadata`). Commits whose
    // Phase D short-circuits — the empty-derivation fast path (#704)
    // and the no-input-changed gate at the Phase D call site — never
    // allocate the inner Map. The Phase D / Phase F.5 fast paths do
    // not even call into the recompute helpers when their gates fail,
    // so the holder stays in its zero-allocation state and the catch
    // arm's `for` loop iterates an empty source. Mirrors #985's
    // firedManyGroups lazy-mint pattern.
    const derivedRollback: DerivedRollbackHolder = { map: undefined }
    // Phase F / F.4 rollback bookkeeping: with Phase F.5
    // (commit-metadata recompute) inserted *after* the bounded history
    // append and the commitLog refresh, a throw escaping F.5 must roll
    // back those mutations too. The previous draft only had to undo
    // Phases B–D because all post-D phases were either pure
    // bookkeeping (Phase E, frozen Commit assembly) or already-isolated
    // observer fans (Phases G, H). Adding a phase that runs user
    // compute after F.4 widens the rollback window by one phase
    // boundary; the captures here are the price of the §11 seam (#452).
    // The history snapshot is a one-shot shallow array copy because a
    // throw in F.5 may need to undo both the Phase F push *and* the
    // FIFO eviction the push triggered when it overflowed
    // `commitHistoryCap`; rebuilding from a length alone would lose
    // the evicted oldest row. The commitLog `value` reference is
    // captured directly — the value is already frozen, so the prior
    // reference is byte-identical to what observers read pre-commit.
    let commitHistorySnapshot: IRCommit[] | null = null
    const commitLogValueBeforeF4 = commitLogEntry.value
    const commitLogLastTimeBeforeF4 = commitLogEntry.lastTime
    try {
      // Phase A — staging: run the user callback, collecting writes into `staged`.
      run(tx)
      txAlive = false

      // Phase A.5 — finalise `hasDependents` fast-path writes (#994).
      // The fast path in `tx.set` pushed rollback rows for isolated-
      // input writes during Phase A but did NOT add to
      // `changedInputIds`, because the Commit.changedNodes contract
      // (#987 / PR #990) requires "value actually changed" — a
      // `tx.set(X, v0); tx.set(X, v1); tx.set(X, v0)` revert
      // sequence must NOT publish X in changedNodes. Walk the rollback
      // rows once: drop reverts (restore `lastWriteTime`, leave the
      // cell unchanged) and add survivors to `changedInputIds` /
      // invalidate the serializable cache. Compaction in place keeps
      // the rollback arrays length-aligned for the catch-arm walk.
      //
      // At this point `inputRollbackEntries` contains ONLY fast-path
      // entries (slow-path entries are pushed by the Phase B loop
      // below). Slow-path inputs land in `inputRollbackEntries`
      // strictly after this finalisation step, so the compaction
      // here cannot interfere with them.
      const fastPathLen = inputRollbackEntries.length
      if (fastPathLen > 0) {
        let writeIdx = 0
        for (let i = 0; i < fastPathLen; i++) {
          const e = inputRollbackEntries[i]!
          const priorValue = inputRollbackPriorValues[i]
          const priorLastWrite = inputRollbackPriorLastWrite[i]!
          if (Object.is(e.value, priorValue)) {
            // Reverted — restore lastWriteTime sentinel back to its
            // genuine pre-tx value; the cell value is already equal
            // to prior, no further restore needed. Drop the rollback
            // row (continue without compaction-write).
            e.lastWriteTime = priorLastWrite
            continue
          }
          if (writeIdx !== i) {
            inputRollbackEntries[writeIdx] = e
            inputRollbackPriorValues[writeIdx] = priorValue
            inputRollbackPriorLastWrite[writeIdx] = priorLastWrite
          }
          writeIdx++
          changedInputIds.push(e.id)
          // #703 Win 1 — invalidate the serializable cache. Mirrors
          // the slow-path Phase B loop's invalidation; deferring to
          // here (rather than tx.set) keeps the cache valid across
          // a revert sequence within the user lambda.
          inputSerializableMemo.delete(e.id)
        }
        if (writeIdx !== fastPathLen) {
          inputRollbackEntries.length = writeIdx
          inputRollbackPriorValues.length = writeIdx
          inputRollbackPriorLastWrite.length = writeIdx
        }
      }

      // Phase B — publish writes: merge staged values into the input table, gated by Object.is.
      // Capture the prior value of every cell we are about to mutate so a
      // later-phase throw can roll us back to the pre-commit world.
      //
      // #995 — walk the parallel `stagedWriteEntries` /
      // `stagedWriteValues` arrays (the linear commit log) directly.
      // Pre-#995 the row body resolved each row's value via
      // `stagedNow.get(e.id)` — one Map probe per row. Post-#995 the
      // value lives at `stagedWriteValues[i]`, removing the Map
      // probe entirely from the Phase B inner loop. The dedup
      // contract is preserved by `tx.set`: a re-write updates
      // `stagedWriteValues[idx]` in place rather than appending, so
      // each row still represents one distinct input and its final
      // staged value.
      //
      // #993 — lazy rollback materialisation in Phase B. Pre-#993, the
      // row body did three `.push()` calls per mutating row into the
      // parallel `inputRollback*` arrays. On adopter shapes like
      // `equality-cutoff × 10 000`, that is 30 000 `.push()` calls per
      // commit, generating two of the V8 deopt categories visible in
      // `engine-status.md` (the "wrong map" hidden-class flips as the
      // arrays' elements kind cycles, and the per-commit "dependent
      // allocation site tenuring changed" deopts as their backing
      // store retenures). The three arrays' worst-case size at this
      // point in Phase B is `inputRollbackEntries.length` (fast-path
      // survivors compacted by Phase A.5) plus `stagedWriteEntries.length`
      // (the count of distinct slow-path inputs `tx.set` resolved).
      // Pre-growing the arrays to that bound in a single allocation
      // site, then index-assigning in the row loop, replaces 3·N
      // `.push()` calls per row with 3·N indexed writes against
      // pre-sized backing storage. The row body's other side effects
      // — `inputSerializableMemo.delete`, `changedInputIds.push`,
      // and the `e.value = v` mutation — are unchanged because they
      // each have their own atomicity / observability contracts that
      // are independent of the rollback materialisation.
      //
      // Atomicity invariant unchanged: the catch arm below walks the
      // `inputRollbackEntries[0..rollbackLen)` slice and restores
      // `(e.value, e.lastWriteTime)` byte-identically to the pre-
      // commit world. The Phase C.5 stamp walk also iterates the
      // post-trim length so it sees only entries that actually
      // mutated this commit.
      const stagedLen = stagedWriteEntries.length
      let rollbackLen = inputRollbackEntries.length
      if (stagedLen > 0) {
        // Pre-size the rollback triple to its post-#993 worst case.
        // `Array.prototype.length =` extends with holes, but every
        // slot 0..rollbackLen-1 is already populated by Phase A.5
        // and slots rollbackLen..rollbackLen+writeCount-1 will be
        // assigned in tight order below — V8 retains a single
        // PACKED elements kind across the loop. Trimming after the
        // row walk to the actual `rollbackLen` keeps the array's
        // `.length` in sync with the populated prefix so the C.5
        // stamp walk and the catch-arm restore walk see no holes.
        const cap = rollbackLen + stagedLen
        inputRollbackEntries.length = cap
        inputRollbackPriorValues.length = cap
        inputRollbackPriorLastWrite.length = cap
        for (let i = 0; i < stagedLen; i++) {
          const e = stagedWriteEntries[i]!
          const v = stagedWriteValues[i]
          if (!Object.is(e.value, v)) {
            inputRollbackEntries[rollbackLen] = e
            inputRollbackPriorValues[rollbackLen] = e.value
            inputRollbackPriorLastWrite[rollbackLen] = e.lastWriteTime
            rollbackLen++
            e.value = v
            // #703 Win 1 — invalidate the serializable cache the
            // moment the cell mutates. Phase F.6 / `snapshot` /
            // `exportModel` will re-probe lazily on next use; the
            // engine never re-probes eagerly. #915 — sibling-map
            // `delete` is O(1) and ~free when the key isn't present
            // (the common case for inputs that have never serialized).
            inputSerializableMemo.delete(e.id)
            changedInputIds.push(e.id)
          }
        }
        // Trim to actual populated length — the Object.is filter may
        // have skipped some staged rows so the worst-case pre-grow
        // over-allocated. `length =` shrinkage frees the tail slots;
        // the prefix is contiguous and PACKED.
        if (rollbackLen !== cap) {
          inputRollbackEntries.length = rollbackLen
          inputRollbackPriorValues.length = rollbackLen
          inputRollbackPriorLastWrite.length = rollbackLen
        }
      }

      // Phase C — advance GraphTime by exactly one tick. A commit
      // produces exactly one new moment in the ordered sequence
      // t₀ < t₁ < t₂ < …; there is no fractional time, no "partway-
      // through" state, and no other API that touches `now`.
      now += 1

      // Phase C.5 — stamp `lastWriteTime` on every input that actually
      // changed value this commit. Powers `Explanation.computedAt` and
      // per-dep `contributedAt` for input frames (#298). Skipped for
      // staged writes that collapsed under Object.is in Phase B.
      // #882 — walks `inputRollbackEntries` (the same set as
      // `changedInputIds`, but holding the resolved InputEntry
      // reference) so the per-iteration `entries.get(id)` and
      // `kind === 'input'` recheck disappear.
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        inputRollbackEntries[i]!.lastWriteTime = now
      }

      // Phase D — recompute fixpoint over the affected sub-graph.
      // A throw here (e.g. a user-defined compute callback panicking)
      // must roll the engine back to its pre-commit state. The
      // `derivedRollback` map is populated in-place by recomputeAffected
      // as each derived is about to recompute; the catch arm below
      // restores from it before re-throwing.
      const changed = new Set<NodeId>(changedInputIds)
      let downstreamChanged: readonly NodeId[] = []
      if (changedInputIds.length > 0) {
        downstreamChanged = phaseD_recomputeAffected(changed, derivedRollback)
        for (const id of downstreamChanged) changed.add(id)
      }

      // #704 — empty-derivation fast path. When no derived value
      // moved AND no commit-level consumer is registered AND there's
      // no retention, the entire Phase E–H envelope (Commit
      // construction, history append, commitLog rebuild, retention
      // chain, subscriber dispatch, commit observers) is dead work
      // for an adopter who already opted into cap=0. Skip directly to
      // a minimal Commit return — the per-input bookkeeping (Phase E
      // changedNodes.slice() × 3, Phase F.6 delta map, Phase G
      // subscriber walk over changed inputs) all gets skipped.
      //
      // Audit-corrected gate (#704 revision): keys on
      // `downstreamChanged.length === 0` AND
      // `!anyChangedInputHasSubscriber(changedInputIds)` so the cell
      // where 10000 inputs change but no derivation re-fires (and
      // the only subscriber is on the unchanged downstream constant)
      // hits the fast path. The full headline acceptance ('≤ 1.5ms
      // on equality-cutoff × 10000 at default cap') needs
      // commitLogConsumerCount tracking gated on F.4 — deferred to
      // a #715 follow-up.
      //
      // #987 — additionally require `changedInputIds.length === 0`.
      // The fast-path returns `Commit.changedNodes: []`, which is
      // only correct when no node moved at all. The cancellation
      // case (inputs mutate but their downstream-derivative deltas
      // sum to zero) used to satisfy `downstreamChanged.length === 0`
      // and silently dropped the mutated inputs from the published
      // `Commit.changedNodes` — violating the contract documented
      // at types.ts:288. Tightening the gate to "truly-empty
      // commit" (Property 1's all-equal write storm) routes
      // cancellation cases through the slow path, where the full
      // `changedNodes` (= changedInputIds ∪ downstreamChanged) is
      // assembled. This is the original "empty-derivation" framing
      // of #704; #731's looser gate was unsound for any consumer
      // that reads `Commit.changedNodes`.
      if (
        changedInputIds.length === 0 &&
        downstreamChanged.length === 0 &&
        commitObservers.size === 0 &&
        commitMetadataIds.size === 0 &&
        commitHistoryCap === 0 &&
        !anyInputSubscriberIn(changedInputIds) &&
        !anyProjectionDepIn(changedInputIds)
      ) {
        // Always-set the optional `originatedAt` field (#703 Win 5 /
        // #760) so the fast-path Commit shares the same V8 hidden
        // class as the Phase E full-path Commit and the
        // buildCommitLogValue rows.
        return Object.freeze({
          time: now,
          intent,
          changedNodes: freezeIfDev([]) as readonly NodeId[],
          originatedAt,
        })
      }

      // Phase E — assemble the immutable Commit record exposed to observers.
      // `originatedAt` is `GraphTime` only on hydrate-issued commits and
      // `undefined` on every other commit (always-set per #703 Win 5 /
      // #760 — explicit `| undefined` typing avoids the megamorphic
      // hidden class the prior conditional spread produced).
      //
      // #703 Win 6 (#754): `frozenChangedNodes` is allocated once per
      // commit and shared by reference between `Commit.changedNodes`
      // (Phase E) and `IRCommit.changedNodes` (Phase F's history-append
      // shape). Sharing is safe because both surface the field as
      // `readonly` and no engine code path mutates either array — the
      // rollback arm restores from `commitHistorySnapshot`, never the
      // published Commit. Replaces the prior triple `Object.freeze(
      // changedNodes.slice())` per commit with a single freeze + share.
      const changedNodes = Array.from(changed)
      const frozenChangedNodes = freezeIfDev(changedNodes) as readonly NodeId[]
      const c: Commit = Object.freeze({
        time: now,
        intent,
        changedNodes: frozenChangedNodes,
        originatedAt,
      })

      // Capture the pre-F shape of `commitHistory` so a throw in
      // Phase F.5 (commit-metadata recompute) can roll back both the
      // Phase F push and any FIFO eviction the push triggered. Cheap
      // shallow copy: the array elements are already frozen IRCommit
      // records, the engine never mutates them in place. Skipped for
      // graphs with zero commit-metadata deriveds — Phase F.5 is a
      // no-op in that case and the rollback is unreachable (#452).
      if (commitMetadataIds.size > 0) {
        commitHistorySnapshot = commitHistory.slice()
      }

      // Phase F — append to bounded commit history. SPEC §5.1 amendment 1
      // (#715): runs iff `commitHistoryCap > 0`; with cap=0 no history is
      // observable and the work is dead. Re-frame, not relax — the
      // observable contract is unchanged because nothing observable
      // depends on `commitHistory` at cap=0.
      if (commitHistoryCap > 0) {
        // Schema 3 introduces `graphId` as a required field on every
        // IRCommit. The engine's in-memory commit history mirrors the
        // export shape so `exportModel` can project without re-stamping
        // the graph identity per commit. The `graphId` is constant for
        // the engine's lifetime — same value on every commit by design.
        //
        // #703 Win 5 / #760: always-set `originatedAt` so the in-memory
        // IRCommit row keeps a stable hidden class (the wire-format
        // exporter still omits the field on serialization when
        // undefined; the IR type keeps `originatedAt?: number`).
        //
        // #703 Win 6 (#754): IRCommit reuses `c.changedNodes` (the
        // shared `frozenChangedNodes` reference allocated above) rather
        // than allocating a fresh `c.changedNodes.slice()` per push.
        // The IR field types `changedNodes` as `readonly IRNodeId[]`,
        // so the frozen reference satisfies the contract.
        commitHistory.push({
          time: c.time,
          graphId,
          intent: c.intent,
          changedNodes: c.changedNodes,
          originatedAt: c.originatedAt,
        })
        if (commitHistory.length > commitHistoryCap) {
          commitHistory.splice(0, commitHistory.length - commitHistoryCap)
        }
      }

      // Phase F.4 — refresh the engine-owned `commitLog` derived
      // entry's value. SPEC §5.1 amendment 1 (#715): runs iff
      // `commitHistoryCap > 0`. With cap=0 the array stays at its
      // genesis empty value; consumers reading `commitLog` see [],
      // which is byte-identical to the eager empty rebuild.
      //
      // #715 follow-up — the audit's headline acceptance: gate
      // additionally on `commitLogConsumerCount > 0` so default
      // `commitHistoryCap=1000` adopters who never subscribe to
      // `commitLog` (and who never register a `commitMetadataDerived`,
      // and whose plain deriveds never read `commitLog`) skip this
      // rebuild on every commit. The bounded ring (Phase F above)
      // still appends so a future first subscriber sees recent
      // history without a cold-start gap; only the
      // `commitLogEntry.value` rebuild + `changed.add(COMMIT_LOG_ID)`
      // is conditional on consumer presence.
      //
      // The gate composes with `commitMetadataIds.size > 0` via the
      // counter: every `commitMetadataDerived(...)` registration
      // bumps the counter at registration time (see `derived(...)`
      // above), so F.5 always sees a freshly-refreshed
      // `commitLogEntry.value` when it has work to do.
      if (commitHistoryCap > 0 && commitLogConsumerCount > 0) {
        phaseF4_refreshCommitLog(now, changed)
      }

      // Phase F.5 — post-commit recompute pass over the commit-metadata
      // index (#452). A derivation registered through
      // `graph.commitMetadataDerived(id, compute)` reads commit metadata
      // (`graph.commitLog`, the just-completed commit's stamp, …) and
      // is expected to reflect the *just-completed* commit, not the
      // previous one. Phase D's recompute walks the affected sub-graph
      // *before* Phase F.4 has refreshed `commitLogEntry.value`, so
      // those tagged ids would otherwise hold a stale value through to
      // Phase G's subscriber dispatch. Rerunning them here, against
      // the freshly-refreshed log entry, closes the §11 "first-class
      // derived for inspection" promise for the commit-metadata-
      // reading case without touching the §3 atomicity contract for
      // ordinary deriveds — Phase D's invariant ("an ordinary
      // derivation settles exactly once per commit") is unchanged
      // because Phase F.5 walks only the explicit opt-in set.
      //
      // A throw here lands in the same catch arm as Phase D throws.
      // The rollback restores the Phase F history append and the
      // Phase F.4 commitLog refresh from the captures recorded at the
      // top of `try`, alongside the Phase D / Phase F.5 derived state
      // already tracked through `derivedRollback`. The §3 single-tick
      // invariant therefore holds across F.5 too: either the commit
      // observers fire on a fully-settled state or the engine is
      // byte-identical to its pre-commit moment.
      if (commitMetadataIds.size > 0) {
        const metadataChanged = recomputeCommitMetadata(derivedRollback)
        for (const id of metadataChanged) changed.add(id)
      }

      // Phase F.6 — retain a per-commit input snapshot for `readAt(t)`,
      // structurally shared as a delta-chain (#235). The new row owns a
      // `delta` of *only* the input ids that actually changed at this
      // commit, with `prev` pointing at the previous head. Memory grows
      // in `O(changed_cells × R)`, not `O(N_inputs × R)` — the §16.6
      // perf bound that keeps `readAt` cheap as a second-tier surface
      // (§12.2). Only serialisable input values are retained; non-
      // serialisable cells are excluded for the same reason `snapshot`
      // excludes them — replay through the snapshot has to be
      // deterministic. Cloning happens at *read* time
      // (`cloneForRetention` inside `readAt` / `snapshotAt`), not here,
      // so commits that never trigger a time-travel read pay no clone
      // cost. Mutating the live input cell after a commit could
      // otherwise leak through the shared reference into the retention
      // buffer — but commit pipeline owns the live cell write, so the
      // reference stored here is the post-commit value and can only be
      // mutated by the same caller that just published it.
      // Phase F.6 — retain a per-commit input snapshot for `readAt(t)`,
      // structurally shared as a delta-chain (#235). SPEC §5.1
      // amendment 1 (#715): runs iff `commitHistoryCap > 0`. With
      // cap=0 readAt/snapshotAt have no commits to look up; the
      // retention chain is dead state. Skipping the delta
      // construction + eviction loop is observable-equivalent at
      // cap=0.
      if (commitHistoryCap > 0) {
        phaseF6_retainInputSnapshot(now, changedInputIds)
      } // end Phase F.6 commitHistoryCap > 0 gate (#715)

      // Phase G — per-node subscriber dispatch. SPEC §5.1
      // amendment 1 (#715): runs iff `changed.size > 0`. With an
      // empty `changed` set, no subscriber's value can have changed
      // — the equality-cutoff guard would no-op every entry, but
      // skipping the iteration entirely avoids the per-subscriber
      // `readEntry` + `Object.is` work. Observable contract is
      // unchanged: a subscriber whose underlying value didn't move
      // does not fire either way.
      if (changed.size > 0) {
        phaseG_dispatchPerNodeSubscribers(changed, c, now)
      }

      // Phase H — commit-level subscriber dispatch. SPEC §5.1
      // amendment 1 (#715): runs iff `commitObservers.size > 0`.
      // With zero registrations the iteration is dead work.
      if (commitObservers.size > 0) {
        phaseH_dispatchCommitObservers(c, now)
      }

      // #1155 / #1241 — H1 hazard warning (SPEC §15.1). Walks the
      // WeakRef tracker populated by `read()` and emits one
      // `console.warn` per survivor whose `capturedAt < now`.
      // No-op when the tracker is disabled (production default
      // or `enableH1HazardWarning` omitted / set to `false`). Runs
      // after Phase H so the warning order is observable-stable:
      // subscribers fire, then dev diagnostics, then `commit`
      // returns. Placed inside the success arm (not the finally)
      // because the rollback path restores `now = beforeNow`,
      // which would silently re-arm prior-epoch reads as
      // "still-current" and produce no warnings on a throw —
      // the desired behaviour: H1 hazards are scoped to commits
      // that actually advanced the clock.
      //
      // #1241 — the dispatch is wrapped in
      // `process.env.NODE_ENV !== 'production'` so esbuild /
      // terser DCE both the call site AND the function body in
      // prod bundles; the H1 apparatus drops entirely.
      if (process.env.NODE_ENV !== 'production') {
        if (h1HazardTrack !== null) checkH1HazardOnCommit()
      }

      return c
    } catch (err) {
      // Atomicity rollback (EPIC #280 / #265, extended for #452): a
      // transaction creates exactly one new GraphTime, so any throw
      // escaping Phase A–F.6 must leave the engine state byte-
      // identical to its pre-commit moment — no half-tick is
      // observable. Restore staged input writes, derived state,
      // `now`, and (when commit-metadata deriveds participate) the
      // Phase F / F.4 mutations of `commitHistory` and
      // `commitLogEntry`. Phase F.6 retention rows are written only
      // after recompute succeeds, so they need no rollback. Phase
      // G / H observer fans are already isolated by their own
      // try/catch; they cannot escape into this arm.
      // #882 — walk the parallel rollback arrays directly. Each row
      // holds the resolved `InputEntry` reference, so the catch arm
      // restores `value` and `lastWriteTime` byte-identically to
      // their pre-commit state without re-resolving the entry. The
      // atomicity contract is unchanged: every byte Phase B mutated
      // is restored on throw.
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        const e = inputRollbackEntries[i]!
        e.value = inputRollbackPriorValues[i]
        // #703 Win 1 — value rolled back to the pre-commit
        // reference, so the cache must be invalidated again so a
        // post-rollback `snapshot` / `exportModel` re-probes
        // against the restored value rather than reusing the
        // staged-value verdict. #915 — sibling-map invalidation.
        inputSerializableMemo.delete(e.id)
        e.lastWriteTime = inputRollbackPriorLastWrite[i]!
      }
      // #995 — clear per-entry read-shadow stamps on the rollback
      // path. On the success path Phase C's `now += 1` makes every
      // stamp stale-but-harmless (`e.lastStagedAt === now` is false
      // because `now` advanced), so no walk is required there. On
      // throw, the `now = beforeNow` restore below would re-align
      // `now` with the in-flight stamps, so the next commit's
      // `tx.set` / `readEntry` would mistake those entries for
      // already-staged-this-tx unless we clear here. Walks
      // `stagedWriteEntries` (every distinct slow-path input);
      // re-writes never re-stamp the entry so each entry appears at
      // most once in the array.
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        stagedWriteEntries[i]!.lastStagedAt = -1
      }
      // Derived rollback: any node Phase D or Phase F.5 started
      // recomputing has its value, deps, computed flag, and lastTime
      // restored. `setDeps` keeps the reverse-dep adjacency map
      // (`dependents`) consistent. #1010 — the inner Map is lazy-
      // minted; if no derived ever entered recompute (Phase D
      // short-circuited on empty-input gate or the empty-derivation
      // fast path), `derivedRollback.map` is still `undefined` and
      // the walk is skipped entirely.
      if (derivedRollback.map !== undefined) {
        for (const [id, prior] of derivedRollback.map) {
          const e = entries.get(id)
          if (e && e.kind === 'derived') {
            e.value = prior.value
            // #703 Win 3 — pass the captured-by-reference prior set
            // directly. `setDeps` swap-not-mutate semantics mean the
            // captured reference is the structurally-correct
            // pre-recompute set; cloning it before passing back was
            // dead work the audit flagged.
            // Cast through ReadonlySet → Set: the rollback record holds
            // it as `ReadonlySet<NodeId>` for type discipline, but the
            // runtime value is the same Set instance the live entry
            // had pre-recompute, and `setDeps` will swap (not mutate)
            // it back into place.
            setDeps(id, prior.deps as Set<NodeId>)
            e.computed = prior.computed
            e.lastTime = prior.lastTime
          }
        }
      }
      // Phase F / F.4 rollback (#452): only meaningful when at least
      // one commit-metadata derived is registered, because that is
      // the only path through which a throw can escape *after* the
      // history append and the commitLog refresh. Without an opt-in
      // node, the snapshot was never taken (see capture site at the
      // top of `try`) and these branches no-op.
      if (commitHistorySnapshot !== null) {
        commitHistory.length = 0
        for (const row of commitHistorySnapshot) commitHistory.push(row)
        commitLogEntry.value = commitLogValueBeforeF4
        commitLogEntry.lastTime = commitLogLastTimeBeforeF4
      }
      now = beforeNow
      throw err
    } finally {
      // #766 — drain the transient auto-dispose set populated by Phase G.
      // Runs in the `finally` arm so a transient subscription that fired
      // and then registered an unrelated throw later in the same commit
      // is still cleaned up (Phase G's observer dispatch is itself
      // wrapped, so the throw path here covers atomicity-rollback failures
      // that propagate from earlier phases — in which case the set is
      // empty and the drain no-ops). Walks every entry once: drops it
      // from the flat `subscriptions` Set and the per-node bucket index,
      // and latches its `manyGroup.disposed` flag so a stale user-side
      // `unsubscribe()` is a no-op. The `pendingTransientDrops` set is
      // cleared at the end of every commit unconditionally.
      if (pendingTransientDrops.size > 0) {
        for (const sub of pendingTransientDrops) {
          // Group transient: route through `disposeManyGroup` once per
          // group. The latch on `group.disposed` makes repeated visits
          // (one per group member in `pendingTransientDrops`) idempotent.
          if (sub.manyGroup !== null) {
            disposeManyGroup(sub.manyGroup)
            continue
          }
          // Single-node transient: drop the entry from the flat
          // `subscriptions` Set and the per-node index. Mirror the
          // `subscribe` unsubscribe closure's commitLog-consumer-counter
          // decrement so a transient `subscribe(commitLog, …, { transient
          // : true })` is symmetric with the manual-unsubscribe path.
          const wasPresent = subscriptions.delete(sub)
          const b = subscriptionsByNode.get(sub.node.id)
          if (b !== undefined) {
            b.delete(sub)
            if (b.size === 0) subscriptionsByNode.delete(sub.node.id)
          }
          if (wasPresent && sub.node.id === COMMIT_LOG_ID) {
            commitLogConsumerCount--
          }
          // #696 — symmetric decrement of the `transientSubscriberCount`
          // running total. Gated on `wasPresent` so a stale entry that a
          // user-side unsubscribe already pulled is a no-op.
          if (wasPresent) transientSubscriberCount--
        }
        pendingTransientDrops.clear()
      }
      // Always-run cleanup: ensure no transactional state leaks into the next commit.
      txAlive = false
      committing = false
      // #995 — drop the split-staged structures. `stagedActive =
      // false` re-gates `readEntry`'s shadow probe to the cell
      // value; the parallel arrays are truncated while retaining
      // their backing storage for reuse by the next commit. The
      // per-entry `lastStagedAt` sentinels are NOT cleared here on
      // the success path — Phase C's `now += 1` advanced `now`
      // beyond every in-flight stamp, so the next commit's
      // `e.lastStagedAt === now` check is automatically false.
      // The rollback path's clear walk lives in the catch arm
      // above, where `now = beforeNow` could otherwise re-align
      // with the stamps. Atomicity (SPEC §3) is preserved without
      // an explicit walk in the success arm because the
      // bookkeeping lives on the `inputRollback*` arrays already
      // restored above.
      stagedActive = false
      stagedWriteEntries.length = 0
      stagedWriteValues.length = 0
    }
  }

  /**
   * Predict the result of `commit(intent, run)` *without* committing.
   *
   * Runs the same Phase A–E pipeline `commit` runs (staging, write
   * publish, time advance, recompute, Commit assembly), captures the
   * would-be {@link Commit} and the staged-input / derived-recompute
   * diffs, then unconditionally restores every byte the pipeline mutated.
   * After the call returns, the engine state is byte-identical to the
   * pre-call moment: `now` is unchanged, no entry was appended to
   * `commitHistory`, no subscriber fired, every input cell still holds
   * its pre-call value, and every derived cell still holds its pre-call
   * `value`/`deps`/`computed`/`lastTime`. The dry-run is observer-
   * invisible.
   *
   * §5 names exactly three commit-mode shapes — `strict`, `with-conflicts`,
   * and a separate `graph.simulate(...)` API for dry-run. This method
   * realises the third row. The §5 contract is the strong one — there is
   * no out-of-band rollback API exposed to consumers, because there is
   * no fractional time and no observer-visible mid-pipeline state. The
   * only way an application can answer "what *would* happen if I ran
   * this transaction?" without breaking the §5 commit-boundary discipline
   * is for the engine itself to run the pipeline and discard the effect.
   *
   * @param intent - Caller-supplied label that would have been recorded
   *   on the predicted `Commit`. Treated as opaque metadata; not appended
   *   to the commit log because no commit is published.
   * @param run - Callback receiving a transient `Tx`; staged writes drive
   *   the same recompute pipeline `commit` runs, then the entire effect
   *   is discarded before this method returns.
   * @returns A `SimulateResult`: `'clean'` carrying the would-be `Commit`,
   *   the staged-input diff, and the derived diff; `'failed'` carrying
   *   the typed error the simulated transaction would have thrown.
   * @throws {@link CommitInProgressError} if invoked re-entrantly from
   *   inside another `commit` callback or another `simulate`. Same
   *   contract as nested `commit` — `simulate` borrows the single
   *   mutation pipeline and that pipeline does not nest. Every other
   *   engine-emitted error ({@link CycleError}, {@link NotAnInputNodeError},
   *   {@link UnknownNodeError}, {@link NodeDisposedError},
   *   {@link StaleTxError}) is surfaced on the `'failed'` arm of the
   *   result rather than thrown.
   *
   * @remarks
   * Implementation reuses the existing atomicity-rollback machinery
   * (`inputRollbackEntries` / `inputRollbackPriorValues` /
   * `inputRollbackPriorLastWrite`, `derivedRollback`, `beforeNow`)
   * that the commit pipeline already maintains for the exception
   * path. `simulate` flips that rollback from "executed only
   * on throw" to "executed unconditionally" and skips Phases F (history
   * append), F.4 (`commitLog` refresh), F.5 (commit-metadata recompute),
   * F.6 (retention row), G (per-node subscriber dispatch), and H
   * (commit-level subscriber dispatch).
   * Phases A–E run unchanged, so the predicted `Commit.changedNodes` is
   * byte-equal to what `commit(intent, run)` would have published —
   * modulo the engine-owned `commitLog` node id, which `simulate` does
   * not refresh and therefore does not include. That node is engine-
   * owned bookkeeping, not part of the user-visible model.
   *
   * The "errors return as part of the result" arm is what makes
   * `simulate` useful as a precondition check: a UI can probe whether a
   * write would close a cycle, target a disposed node, or violate any
   * other typed engine invariant *without* actually triggering the
   * failure. Re-entrancy is the one exception — that throw is
   * structural, not transactional, and the engine refuses to nest
   * pipelines.
   */
  function simulate(intent: string, run: (tx: Tx) => void): SimulateResult {
    // Re-entrancy guard mirrors `commit`: there is exactly one mutation
    // pipeline, and `simulate` reuses it. A nested invocation from inside
    // another commit's callback (or another simulate's callback) is
    // refused with the same typed error as nested commits.
    if (committing) throw new CommitInProgressError()
    committing = true
    // #995 — see `commitInternal` for the split-staged design.
    // `simulate` shares the engine-closure `stagedWriteEntries` /
    // `stagedWriteValues` / `stagedActive` structures — the engine
    // refuses re-entrant pipelines, so reusing them across `commit`
    // and `simulate` invocations is safe. The per-entry sentinels
    // (`lastStagedAt` / `lastStagedRow` on InputEntry) handle the
    // read-shadow / dedup role without per-frame allocation.
    stagedWriteEntries.length = 0
    stagedWriteValues.length = 0
    stagedActive = true

    // `txAlive` enforces that `tx.set` cannot escape the synchronous `run`
    // body. Mirrors the `commit` contract — a captured `tx` reference
    // bypassing the simulate window would let staged writes leak into a
    // later real commit, which would silently break the dry-run promise.
    // Atomicity rollback bookkeeping — same shape as `commit`'s failure-
    // path bookkeeping, but `simulate` runs the rollback unconditionally
    // on the way out. The dry-run is therefore observer-invisible by
    // construction: every byte the pipeline mutated is restored before
    // this function returns.
    // #882 — twin Maps replaced with parallel arrays of resolved
    // `InputEntry` rows; mirrors the `commit` rollback shape.
    // #994 — declared above the `tx` closure so the `tx.set`
    // `hasDependents` fast path can push rollback rows for
    // isolated-input writes during Phase A, without going through
    // `staged`. Mirrors the `commit` body's restructure.
    const inputRollbackEntries: InputEntry[] = []
    const inputRollbackPriorValues: unknown[] = []
    const inputRollbackPriorLastWrite: GraphTime[] = []
    const beforeNow = now
    let txAlive = true
    const tx: Tx = {
      set<T>(node: InputNode<T>, value: T): void {
        if (!txAlive) throw new StaleTxError()
        const id = (node as AnyNode).id
        const e = getEntry(id)
        if (e.kind !== 'input') throw new NotAnInputNodeError(id)
        // #994 — `hasDependents` fast path. Mirrors the `commit`
        // body; see the longer rationale block there. The simulate
        // path runs an unconditional rollback so the fast-path
        // rollback rows are restored by the same finally arm
        // slow-path rollback rows are.
        if (!e.hasDependents) {
          if (Object.is(e.value, value)) return
          if (e.lastWriteTime > now) {
            // Re-write within the same simulate — rollback row
            // already captured. Update the cell directly.
            e.value = value
            return
          }
          inputRollbackEntries.push(e)
          inputRollbackPriorValues.push(e.value)
          inputRollbackPriorLastWrite.push(e.lastWriteTime)
          e.value = value
          e.lastWriteTime = now + 1
          return
        }
        // #972 / #995 — equal-value write fast path on the split-staged
        // shape. Mirrors the `commit` path; see the longer rationale
        // comment there. The simulate path runs an unconditional
        // rollback, so a no-op fast-path here also shrinks the
        // rollback's `inputRollbackEntries` walk.
        if (e.lastStagedAt === now) {
          const idx = e.lastStagedRow
          if (Object.is(stagedWriteValues[idx], value)) return
          stagedWriteValues[idx] = value
          return
        }
        if (Object.is(e.value, value)) return
        e.lastStagedAt = now
        e.lastStagedRow = stagedWriteEntries.length
        stagedWriteEntries.push(e)
        stagedWriteValues.push(value)
      },
    }

    const changedInputIds: NodeId[] = []
    // #1010 — lazy-allocate the derived rollback Map (mirrors the
    // commit() path; see the longer comment there). `simulate`
    // always unconditionally rolls back, so the finally arm walks
    // `derivedRollback.map` only when a Phase D recompute actually
    // populated it. A simulate that mutates only inputs (no derived
    // dependents) skips the Map allocation entirely.
    const derivedRollback: DerivedRollbackHolder = { map: undefined }

    let prediction: { c: Commit; derivedDiff: NodeId[] } | null = null
    let predictedError: unknown = null

    try {
      // Phase A — staging: run the user callback. A throw here lands in
      // the catch arm below and surfaces on the failed arm of the
      // result; it does not escape `simulate`.
      run(tx)
      txAlive = false

      // Phase A.5 — finalise `hasDependents` fast-path writes (#994).
      // Mirrors the `commit` body; see the longer comment there.
      // Filters reverted fast-path entries (write+revert in same
      // simulate) before the survivors are added to
      // `changedInputIds`, so the predicted Commit's `changedNodes`
      // matches the real-commit contract (#987 / PR #990).
      const fastPathLen = inputRollbackEntries.length
      if (fastPathLen > 0) {
        let writeIdx = 0
        for (let i = 0; i < fastPathLen; i++) {
          const e = inputRollbackEntries[i]!
          const priorValue = inputRollbackPriorValues[i]
          const priorLastWrite = inputRollbackPriorLastWrite[i]!
          if (Object.is(e.value, priorValue)) {
            e.lastWriteTime = priorLastWrite
            continue
          }
          if (writeIdx !== i) {
            inputRollbackEntries[writeIdx] = e
            inputRollbackPriorValues[writeIdx] = priorValue
            inputRollbackPriorLastWrite[writeIdx] = priorLastWrite
          }
          writeIdx++
          changedInputIds.push(e.id)
          inputSerializableMemo.delete(e.id)
        }
        if (writeIdx !== fastPathLen) {
          inputRollbackEntries.length = writeIdx
          inputRollbackPriorValues.length = writeIdx
          inputRollbackPriorLastWrite.length = writeIdx
        }
      }

      // Phase B — publish staged writes onto live input cells. The
      // pre-write values are captured into the parallel rollback
      // arrays so the unconditional rollback at the end of this
      // function restores them byte-identically. Object.is gating
      // mirrors `commit` — a write that lands on the same value as
      // the prior commit is a no-op.
      // #995 — walk parallel `stagedWriteEntries` /
      // `stagedWriteValues` (the linear commit log) directly; the
      // value lives at `stagedWriteValues[i]`, no Map probe per row.
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        const e = stagedWriteEntries[i]!
        const v = stagedWriteValues[i]
        if (!Object.is(e.value, v)) {
          inputRollbackEntries.push(e)
          inputRollbackPriorValues.push(e.value)
          inputRollbackPriorLastWrite.push(e.lastWriteTime)
          e.value = v
          // #703 Win 1 — invalidate the serializable cache during
          // a `simulate` mutation as well; the unconditional
          // rollback below restores both the value and the cache
          // slot, but lazy re-probing during the simulate window
          // (Phase D, Phase E assembly) needs the cache to reflect
          // the staged value, not the prior one. #915 — sibling-map
          // invalidation.
          inputSerializableMemo.delete(e.id)
          changedInputIds.push(e.id)
        }
      }

      // Phase C — advance the engine clock by exactly one tick so
      // derived recomputation sees the same `lastTime` stamp `commit`
      // would have produced. The unconditional rollback at the end of
      // this function restores `now` to `beforeNow`, so the advance is
      // observer-invisible.
      now += 1

      // Phase C.5 — stamp `lastWriteTime` on every input that actually
      // changed value this simulate. Captured into the parallel
      // rollback arrays above, restored by the unconditional rollback
      // below.
      // #882 — direct InputEntry walk; same amortisation as the
      // `commit` path.
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        inputRollbackEntries[i]!.lastWriteTime = now
      }

      // Phase D — recompute fixpoint over the affected sub-graph. The
      // `derivedRollback` map records the pre-recompute state of every
      // derived the walk visits, so the unconditional rollback can
      // restore their `value`/`deps`/`computed`/`lastTime`
      // bytes-identically.
      const changed = new Set<NodeId>(changedInputIds)
      const derivedDiff: NodeId[] = []
      if (changedInputIds.length > 0) {
        const downstreamChanged = recomputeAffected(changed, derivedRollback)
        for (const id of downstreamChanged) {
          changed.add(id)
          derivedDiff.push(id)
        }
      }

      // Phase E — assemble the would-be Commit record. Frozen identically
      // to `commit`'s output so the prediction has the same structural
      // shape any consumer would see from a real commit. We do NOT
      // proceed to Phase F (history append), F.4 (commitLog refresh),
      // F.5 (commit-metadata recompute), F.6 (retention), G (per-node
      // subscriber dispatch), or H (commit subscriber dispatch) — those
      // are the observer-visible side effects a dry-run must skip. The
      // §11 commit-metadata seam (#452) is therefore invisible in
      // `simulate`'s `derivedDiff` by construction; consumers that
      // want to predict the post-Phase-F.5 state pair `simulate` with
      // a `read(commitMetadataDerived)` after a real commit lands.
      const changedNodes = Array.from(changed)
      // Always-set the optional `originatedAt` field (#703 Win 5 /
      // #760). `simulate` never carries a hydrate label so the slot
      // is unconditionally `undefined` here, but assembling the
      // record with the same property layout as `commit`'s Phase E
      // output keeps the predicted Commit's hidden class identical
      // to the would-be real Commit.
      const c: Commit = Object.freeze({
        time: now,
        intent,
        changedNodes: freezeIfDev(changedNodes.slice()) as readonly NodeId[],
        originatedAt: undefined,
      })
      prediction = { c, derivedDiff }
    } catch (err) {
      // Capture the would-be throw for surfacing on the failed arm. The
      // unconditional rollback below restores engine state regardless of
      // which phase escaped.
      predictedError = err
    } finally {
      // Unconditional rollback — every byte Phases B–D may have touched
      // is restored to its pre-call value. This is the dry-run promise:
      // the engine state after `simulate` returns is byte-identical to
      // the pre-call moment, regardless of whether the simulated
      // transaction would have committed or thrown.
      // #882 — walk the parallel rollback arrays directly; mirrors
      // the `commit` catch-arm shape.
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        const e = inputRollbackEntries[i]!
        e.value = inputRollbackPriorValues[i]
        // #703 Win 1 — see commit() catch-arm comment: invalidate
        // the cache so post-`simulate` reads re-probe against the
        // restored value rather than the simulated one. #915 —
        // sibling-map invalidation.
        inputSerializableMemo.delete(e.id)
        e.lastWriteTime = inputRollbackPriorLastWrite[i]!
      }
      // #1010 — walk `derivedRollback.map` only when Phase D
      // populated it; a simulate with no derived recompute never
      // allocated the inner Map and this entire branch no-ops.
      if (derivedRollback.map !== undefined) {
        for (const [id, prior] of derivedRollback.map) {
          const e = entries.get(id)
          if (e && e.kind === 'derived') {
            e.value = prior.value
            // #703 Win 3 — pass the captured-by-reference prior set
            // directly; same swap-not-mutate semantics on `setDeps`
            // as the commit() catch arm above.
            setDeps(id, prior.deps as Set<NodeId>)
            e.computed = prior.computed
            e.lastTime = prior.lastTime
          }
        }
      }
      now = beforeNow
      txAlive = false
      committing = false
      // #995 — drop the split-staged structures (mirrors the
      // `commitInternal` finally arm). `simulate` always rolls
      // back, restoring `now = beforeNow`, so the per-entry
      // `lastStagedAt` stamps from this simulate WOULD match the
      // next commit's `now` if left in place — see the longer
      // rationale in `commitInternal`'s finally arm. Walk
      // `stagedWriteEntries` and clear the sentinel before
      // truncating the arrays.
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        stagedWriteEntries[i]!.lastStagedAt = -1
      }
      stagedActive = false
      stagedWriteEntries.length = 0
      stagedWriteValues.length = 0
    }

    if (prediction !== null) {
      return {
        status: 'clean',
        commit: prediction.c,
        stagedDiff: Object.freeze(changedInputIds.slice()) as readonly NodeId[],
        derivedDiff: Object.freeze(prediction.derivedDiff.slice()) as readonly NodeId[],
      }
    }
    return {
      status: 'failed',
      error: predictedError,
      stagedDiff: Object.freeze(changedInputIds.slice()) as readonly NodeId[],
    }
  }

  /**
   * Register a per-node observer. The observer is invoked once synchronously
   * with the current value, and afterwards once per commit in which the
   * node's value changes — a value-change-gated dispatch that mirrors the
   * "a React component subscribed to one node should re-render only when
   * that node's value changes" correctness criterion.
   *
   * @typeParam T - Value type of the observed node.
   * @param node - The node handle to observe.
   * @param observer - Callback receiving `(value, time)` on each notification.
   * @returns An {@link Unsubscribe} that removes the observer.
   * @throws {@link UnknownNodeError} if `node` is not registered.
   *
   * @remarks
   * The initial synchronous notification mirrors `read`. Subsequent
   * notifications are gated by the equality cutoff in the commit pipeline,
   * realising the worked-example invariant: a single commit with two writes
   * that converges on one new value fires exactly one notification, not two.
   */
  function subscribe<T>(
    node: Node<T>,
    observer: Observer<T>,
    options?: SubscribeOptions,
  ): Unsubscribe {
    // Validate the node exists before allocating subscription bookkeeping.
    getEntry(node.id)
    const initialValue = readEntry(node)
    // #916 — `subscriptionId`, `scopeId`, `callbackSite` are minted
    // lazily at `exportModel` time (see `SubscriptionEntry` doc). Only
    // load-bearing fields land on the entry, shaving observability
    // weight off the per-subscription retained footprint that the
    // 10k-subscriber scrolling-viewport scenario amplifies.
    const sub: SubscriptionEntry = {
      node: node as AnyNode,
      observer: observer as Observer<unknown>,
      lastValue: initialValue,
      hasFired: false,
      // PR-B1 stamps registration time as the current GraphTime;
      // the value flows through to `IRSubscribe.time` on export.
      subscribedAt: now,
      // #766 — `transient: true` registers the observer as a one-shot
      // that auto-disposes after the first Phase G fire. Default is
      // `false`, preserving the canonical `subscribe` retain-across-
      // commits contract for every existing call site.
      transient: options?.transient === true,
      // Plain `subscribe` is not part of a multi-node group; the
      // per-commit dedupe path in Phase G never visits this entry's
      // `manyGroup` slot when it's `null`.
      manyGroup: null,
    }
    subscriptions.add(sub)
    // #671: maintain the per-node index in lockstep. Fresh Set on
    // first subscriber for a node; subsequent subscribers append.
    let bucket = subscriptionsByNode.get(node.id)
    if (bucket === undefined) {
      bucket = new Set<SubscriptionEntry>()
      subscriptionsByNode.set(node.id, bucket)
    }
    bucket.add(sub)
    // #715 follow-up — bump the commitLog consumer counter when this
    // subscription targets the engine-owned commitLog node. Decrement
    // is in the unsubscribe closure below. Disposal of the commitLog
    // node is impossible (it's engine-owned and not exposed through
    // the public dispose surface), so the only paths that drop this
    // subscription are the explicit unsubscribe and a `_dispose` of
    // the *node*; the latter applies to any node and is handled in
    // `_dispose`.
    if (node.id === COMMIT_LOG_ID) commitLogConsumerCount++
    // #696 — bump the transient running counter when the registration
    // requested auto-dispose-after-first-fire. The matching decrement
    // lives in (a) the user-returned unsubscribe closure below, (b)
    // the Phase G transient drain (single-node arm), and (c)
    // `_dispose` (node-disposal teardown).
    if (sub.transient) transientSubscriberCount++
    // Synchronous initial notification — wrapped so a faulty observer cannot abort registration.
    try {
      observer(initialValue, now)
      sub.hasFired = true
    } catch (err) {
      reportObserverError(err, {
        source: 'subscribe-initial',
        nodeId: node.id,
        time: now,
      })
    }
    // Closure captures the entry; idempotent removal via Set.delete.
    // The closure must be idempotent: a second invocation of the
    // returned `unsubscribe` is a documented no-op, and must not
    // double-decrement the consumer counter. The `subscriptions.delete`
    // return value gates the decrement so a stale call after the
    // entry is gone is silent.
    return () => {
      const wasPresent = subscriptions.delete(sub)
      const b = subscriptionsByNode.get(node.id)
      if (b !== undefined) {
        b.delete(sub)
        if (b.size === 0) subscriptionsByNode.delete(node.id)
      }
      if (wasPresent && node.id === COMMIT_LOG_ID) commitLogConsumerCount--
      // #696 — gated on `wasPresent` so a duplicate user-side
      // unsubscribe (or one called after the Phase G drain has
      // already auto-dropped the entry) is a no-op.
      if (wasPresent && sub.transient) transientSubscriberCount--
    }
  }

  /**
   * Drop a {@link ManyGroup}'s entire entry set from {@link subscriptions}
   * and {@link subscriptionsByNode}, latching the group's `disposed`
   * flag so a re-entered fire (or a duplicate user-side
   * `unsubscribe()` call) is a no-op (#766).
   *
   * @remarks
   * Single source of truth for the multi-node teardown path: the
   * user-returned `unsubscribe` closure routes here, the transient
   * auto-dispose drain routes here, and the dispose-during-commit
   * gate (handled by `_dispose` for individual node disposal) does
   * not need to know about groups because it walks
   * {@link subscriptions} flatly. The latch is checked at the top of
   * Phase G's per-group fire so the same dispatch loop that drops a
   * group can keep running without firing the dropped observer
   * again.
   */
  function disposeManyGroup(group: ManyGroup): void {
    if (group.disposed) return
    group.disposed = true
    for (const entry of group.entries) {
      const wasPresent = subscriptions.delete(entry)
      const b = subscriptionsByNode.get(entry.node.id)
      if (b !== undefined) {
        b.delete(entry)
        if (b.size === 0) subscriptionsByNode.delete(entry.node.id)
      }
      if (entry.node.id === COMMIT_LOG_ID) commitLogConsumerCount--
      // #696 — symmetric decrement for `subscribeMany({ transient: true })`
      // groups. Every entry of a transient group contributes one count
      // at registration (mirroring the per-entry contribution to
      // `subscribersTotal`); every entry contributes one decrement here.
      // Gated on `wasPresent` so a group entry already removed by
      // `_dispose(nodeOfMember)` (a defensive no-op pre-#696, but the
      // counter must not double-decrement) is skipped. Plain
      // (non-transient) groups are a no-op for this branch.
      if (wasPresent && entry.transient) transientSubscriberCount--
    }
    group.entries.clear()
  }

  /**
   * Register a single observer against a tuple of nodes (#766). Each
   * node gets its own {@link SubscriptionEntry} sharing a single
   * {@link ManyGroup} record so Phase G can dedupe a multi-write
   * commit that moves several of the group's nodes to a single
   * observer fire, and the user-returned `unsubscribe` drops the
   * whole group atomically.
   *
   * The synchronous initial fire mirrors the per-node
   * {@link subscribe} contract: the observer fires once with the
   * tuple of current values at registration time. This initial fire
   * does NOT consume a `transient: true` slot — the auto-dispose
   * trigger is the next Phase G fire, identical to the single-node
   * `subscribe` path.
   *
   * @typeParam Ts - Tuple of {@link Node} handles being observed.
   * @param nodes - Tuple of node handles. Order is preserved in the
   *   value tuple passed to the observer.
   * @param observer - Callback receiving the freshly-read value
   *   tuple on each notification.
   * @param options - Optional {@link SubscribeOptions}: `{ transient:
   *   true }` registers the group as one-shot; the engine
   *   auto-disposes the entire group after its first commit-time
   *   fire.
   * @returns An idempotent {@link Unsubscribe} that drops the whole
   *   group as a single operation.
   * @throws {@link UnknownNodeError} when any of `nodes` is not
   *   registered.
   * @throws {@link NodeDisposedError} when any of `nodes` has been
   *   released through the adapter `dispose` hook.
   *
   * @remarks
   * Validation is up-front, mirroring `subscribe`: every member is
   * checked via {@link getEntry} before any bookkeeping is allocated,
   * so a partial group never exists in the engine's perspective.
   * Empty tuples are accepted as a degenerate registration: the
   * observer fires once synchronously with `[]` and then never
   * again, and the returned `unsubscribe` is a no-op (group has no
   * entries). The behaviour is consistent with "every member of `[]`
   * is in `changedNodes`" being vacuously false.
   */
  function subscribeMany<Ts extends readonly Node<unknown>[]>(
    nodes: Ts,
    observer: (values: ValueMap<Ts>) => void,
    options?: SubscribeOptions,
  ): Unsubscribe {
    // Validate every node's existence up front so a partial group is
    // structurally impossible. `getEntry` throws `UnknownNodeError` /
    // `NodeDisposedError` per the canonical read-side gate.
    for (const node of nodes) {
      getEntry(node.id)
    }

    const transient = options?.transient === true
    const observerErased = observer as (values: readonly unknown[]) => void
    const group: ManyGroup = {
      entries: new Set<SubscriptionEntry>(),
      nodes: nodes.slice() as readonly AnyNode[],
      observer: observerErased,
      transient,
      disposed: false,
    }

    /**
     * Per-entry observer adapter. The single-node Phase G dispatch
     * loop calls each entry's `observer(value, time)`; for a many
     * group, the per-entry observer is a thin shim that delegates to
     * the shared group dispatch — the actual dedupe across the
     * group's entries lives in Phase G via the per-commit
     * `firedManyGroups` set.
     *
     * The shim is needed because Phase G iterates per node-id bucket
     * and reads `sub.observer(value, time)`; routing the group fire
     * here keeps the bucket walk uniform with single-node entries
     * while still letting the group's observer receive the full
     * value tuple, not just the one node's value.
     */
    const fireGroupOnce = (_value: unknown, _time: GraphTime): void => {
      if (group.disposed) return
      // Read every member's current committed value into the value
      // tuple. `read` resolves through `getEntry`, which surfaces
      // `NodeDisposedError` if a member was disposed; that throw is
      // isolated by the surrounding Phase G `try/catch` and reported
      // via `node-subscriber`, mirroring single-node fault isolation.
      const values: unknown[] = new Array(group.nodes.length)
      for (let i = 0; i < group.nodes.length; i++) {
        values[i] = readEntry(group.nodes[i] as AnyNode)
      }
      observerErased(values)
    }

    // Allocate one entry per node sharing the shared `group` record.
    // The `manyGroup` field is the join key downstream consumers use;
    // observability fields (`subscriptionId`, `scopeId`, `callbackSite`)
    // are minted lazily at `exportModel` time per #916 — see
    // `SubscriptionEntry` doc-comment.
    for (const node of nodes) {
      const initialValue = readEntry(node as AnyNode)
      const sub: SubscriptionEntry = {
        node: node as AnyNode,
        observer: fireGroupOnce as Observer<unknown>,
        lastValue: initialValue,
        hasFired: false,
        subscribedAt: now,
        transient,
        manyGroup: group,
      }
      subscriptions.add(sub)
      let bucket = subscriptionsByNode.get(node.id)
      if (bucket === undefined) {
        bucket = new Set<SubscriptionEntry>()
        subscriptionsByNode.set(node.id, bucket)
      }
      bucket.add(sub)
      if (node.id === COMMIT_LOG_ID) commitLogConsumerCount++
      // #696 — per-entry contribution to the running transient counter.
      // `transient` is the shared group flag; every entry contributes
      // 1 (mirroring the per-entry contribution to `subscribersTotal`).
      if (transient) transientSubscriberCount++
      group.entries.add(sub)
    }

    // Synchronous initial fire — assemble the value tuple from the
    // per-entry `lastValue` slots populated above (avoids a second
    // `readEntry` pass) and forward to the user observer. A throw is
    // routed through the same `subscribe-initial` channel single-node
    // `subscribe` uses; per-node `nodeId` attribution is the first
    // member of the group as a best-effort breadcrumb.
    try {
      const initialValues: unknown[] = []
      for (const entry of group.entries) {
        initialValues.push(entry.lastValue)
      }
      observerErased(initialValues)
      for (const entry of group.entries) entry.hasFired = true
    } catch (err) {
      // `nodeId` is best-effort group attribution: when the group is
      // non-empty, point at the first member; otherwise omit the field
      // (the `ObserverErrorContext` shape allows that).
      const firstId = nodes[0]?.id
      reportObserverError(
        err,
        firstId !== undefined
          ? { source: 'subscribe-initial', nodeId: firstId, time: now }
          : { source: 'subscribe-initial', time: now },
      )
    }

    // The returned unsubscribe drops the whole group atomically and
    // is idempotent — a second call hits the `disposed` latch in
    // `disposeManyGroup` and does nothing.
    return () => {
      disposeManyGroup(group)
    }
  }

  /**
   * Register a commit-level observer. Invoked once per published commit with
   * the corresponding {@link Commit} record. The narrow capability — one
   * `Commit` per fire, no log read — is what makes this distinct from
   * subscribing to {@link Graph.commitLog}: callers that only need the
   * notification but not the full log get a smaller capability, useful for
   * devtools, persistence, and SSR-hydrate listeners.
   *
   * @param observer - Callback receiving the just-published commit.
   * @returns An {@link Unsubscribe} that removes the observer.
   *
   * @remarks
   * Unlike `subscribe`, this dispatch is not gated by value-change equality —
   * every commit fires, including ones whose `changedNodes` is empty.
   */
  function subscribeCommits(observer: (commit: Commit) => void): Unsubscribe {
    commitObservers.add(observer)
    return () => {
      commitObservers.delete(observer)
    }
  }

  /**
   * Run `projection` under {@link activeReadTracker}, capturing every
   * node id its `read`/`get` calls touch into a fresh Set. The Set is
   * returned alongside the projection's value so callers can both
   * record the dep set on the registration and forward the value to
   * the observer.
   *
   * The tracker is restored to the prior value (typically `null`) in
   * a `finally` arm so a throw escaping the projection cannot leak
   * the tracker into a later, unrelated read. The single-tracker
   * shape relies on the §5 invariant that no two pipeline phases
   * run concurrently — `subscribeReads` registration happens outside
   * a commit, and Phase G re-runs happen inside one, so re-entry is
   * structurally ruled out (an attempt to call `subscribeReads` from
   * inside a Phase G observer is rejected by the existing
   * {@link CommitInProgressError} guard on `commit`).
   */
  function runProjectionTracked<T>(projection: () => T): {
    value: T
    deps: Set<NodeId>
  } {
    const prior = activeReadTracker
    const deps = new Set<NodeId>()
    activeReadTracker = deps
    try {
      const value = projection()
      return { value, deps }
    } finally {
      activeReadTracker = prior
    }
  }

  /**
   * Reconcile the per-node index for a `subscribeReads` registration
   * across a projection re-run. Mirrors {@link setDeps}'s shape: walk
   * the symmetric difference of (previous deps, next deps) and
   * update the bucket map in place. The forward record on the
   * registration is then replaced with `nextDeps`.
   *
   * Conditional-read handling falls out of the symmetric-diff walk:
   * a projection that flips `() => flag ? get(b) : get(a)` from the
   * `a`-branch to the `b`-branch loses its `a` bucket entry and
   * gains a `b` bucket entry on this call, so subsequent commits
   * touching `a` no longer fire the observer.
   */
  function reconcileProjectionDeps(
    reg: SubscribeReadsRegistration,
    nextDeps: Set<NodeId>,
  ): void {
    for (const oldDep of reg.recordedDeps) {
      if (!nextDeps.has(oldDep)) {
        const b = subscribeReadsByNode.get(oldDep)
        if (b !== undefined) {
          b.delete(reg)
          if (b.size === 0) subscribeReadsByNode.delete(oldDep)
        }
      }
    }
    for (const newDep of nextDeps) {
      let b = subscribeReadsByNode.get(newDep)
      if (b === undefined) {
        b = new Set<SubscribeReadsRegistration>()
        subscribeReadsByNode.set(newDep, b)
      }
      b.add(reg)
    }
    reg.recordedDeps = nextDeps
  }

  /**
   * Register a projection-tracked observer (#701, SPEC §11.1
   * amended). The engine runs `projection` once at registration
   * under {@link activeReadTracker}, captures the read-set, and
   * fires `observer(commit, value)` on every commit whose
   * {@link Commit.changedNodes} intersects the captured set. The
   * projection re-runs on every fire so the observer receives the
   * fresh post-commit value — the recorded read-set is refreshed in
   * the same step, which is what makes conditional-read tracking
   * "follow the live branch" without the adopter managing dep
   * arrays by hand.
   *
   * The dispatch shape composes with the #671 per-node subscriber
   * index: each recorded dep also lives in {@link subscribeReadsByNode}
   * keyed by node id, so Phase G's `changed → bucket` walk visits
   * only the registrations whose deps actually moved this commit.
   * For a 1000-registrant single-node-changed commit this is O(1)
   * regardless of how many other registrations exist.
   *
   * @typeParam T - Value type produced by the projection closure.
   * @param observer - Callback receiving the just-published commit
   *   and the projection's freshly-evaluated value.
   * @param projection - Pure read closure; the engine tracks its
   *   `read`/`get` calls automatically.
   * @returns An {@link Unsubscribe} that idempotently removes the
   *   registration.
   */
  function subscribeReads<T>(
    observer: (commit: Commit, value: T) => void,
    projection: () => T,
  ): Unsubscribe {
    const { value: initialValue, deps: initialDeps } =
      runProjectionTracked(projection)
    const reg: SubscribeReadsRegistration = {
      observer: observer as (commit: Commit, value: unknown) => void,
      projection: projection as () => unknown,
      // Filled in by `reconcileProjectionDeps` immediately below.
      recordedDeps: new Set<NodeId>(),
    }
    subscribeReadsRegistrations.add(reg)
    reconcileProjectionDeps(reg, initialDeps)
    // Synchronous initial fire — mirrors `subscribe`'s contract that
    // a fresh registration sees the current value once before any
    // commit-driven notification. Routed through the same
    // observer-error reporter so a faulty observer cannot abort
    // registration.
    try {
      // Fabricate a Commit-shaped record at `now` for the initial
      // fire. The recorded shape matches the post-commit Commit the
      // observer would see on a regular fire, so adopters do not
      // need to special-case the initial notification. `intent` is
      // the engine-reserved sentinel `'subscribe-reads-initial'`;
      // `changedNodes` is the empty set because no commit produced
      // this initial value.
      // Always-set the optional `originatedAt` field (#703 Win 5 /
      // #760) so the fabricated initial-fire Commit shares the same
      // V8 hidden class as commit-pipeline-published Commits. The
      // initial fire never carries a hydrate label, so the slot is
      // unconditionally `undefined`.
      const initialCommit: Commit = Object.freeze({
        time: now,
        intent: 'subscribe-reads-initial',
        changedNodes: freezeIfDev([]) as readonly NodeId[],
        originatedAt: undefined,
      })
      observer(initialCommit, initialValue)
    } catch (err) {
      reportObserverError(err, {
        source: 'subscribe-reads-initial',
        time: now,
      })
    }
    return () => {
      if (!subscribeReadsRegistrations.has(reg)) return
      subscribeReadsRegistrations.delete(reg)
      // Drop every per-node index entry this registration occupied
      // — same symmetric-diff shape as `reconcileProjectionDeps`
      // with `nextDeps = ∅`.
      for (const dep of reg.recordedDeps) {
        const b = subscribeReadsByNode.get(dep)
        if (b !== undefined) {
          b.delete(reg)
          if (b.size === 0) subscribeReadsByNode.delete(dep)
        }
      }
      reg.recordedDeps = new Set()
    }
  }

  /**
   * Return a derived node carrying an {@link Explanation} of `node` — a
   * full transitive lineage with timestamps, cycle protection, and
   * stable identity (#298).
   *
   * @typeParam T - Value type of the node being explained.
   * @param node - The node to introspect.
   * @returns A derived handle whose value updates as `node` and the graph
   *  topology evolve. Two calls with the same target return the same
   *  handle (memoised) so devtools can compare references.
   * @throws {@link UnknownNodeError} if `node` is not registered.
   *
   * @remarks
   * Inspection happens *through* engine primitives, not alongside them: the
   * returned handle is itself subscribable, composable, and replayable —
   * devtools become ordinary consumers of the graph rather than a parallel
   * system. The same property is what lets a REPL connected to a running
   * graph mutate, replace, and replay derivations without restarting the
   * host process; the engine is inspectable in its own vocabulary.
   */
  function explain<T>(node: Node<T>): DerivedNode<Explanation> {
    // Force entry validation up front so the error surface mirrors `read`/`subscribe`.
    getEntry(node.id)
    const explainId = `__explain__:${node.id}`
    // Memoise the handle (#298 T6): identical reference per target.
    const cached = explainHandles.get(explainId)
    if (cached) return cached as DerivedNode<Explanation>
    // First call — register the explain derivation. The compute walks
    // the dep tree recursively, tracking every visited node as a dep
    // of the explain node itself so subscribers fire on any lineage
    // change.
    const handle = derived<Explanation>(explainId, (get) => {
      return buildExplanation(node.id, get, new Set<NodeId>())
    })
    explainHandles.set(explainId, handle)
    return handle
  }

  /**
   * Recursive lineage builder for {@link explain}. Tracks the
   * traversal stack so a re-entered node yields a `via: 'cycle'`
   * marker instead of overflowing (#298 T8). Every node visited is
   * read via `get(...)` so it joins the explain derivation's dep
   * set — any change in the transitive lineage fires subscribers.
   */
  function buildExplanation(
    id: NodeId,
    get: <U>(n: Node<U>) => U,
    stack: Set<NodeId>,
  ): Explanation {
    if (stack.has(id)) {
      return { via: 'cycle', node: id, cycleBackTo: id }
    }
    const entry = entries.get(id)
    // Defensive: an explain re-read on a node deleted out from under
    // us shouldn't crash; surface it as a cycle marker so the UI has
    // something to render.
    if (!entry) return { via: 'cycle', node: id, cycleBackTo: id }
    if (entry.kind === 'input') {
      const value = get(entry.node)
      return Object.freeze({
        via: 'input',
        node: id,
        value,
        computedAt: entry.lastWriteTime,
        deps: freezeIfDev([]) as readonly [],
      })
    }
    // Derived (possibly tagged 'live'). `get(node)` recomputes the
    // node if dirty and tracks it as a dep of the explain node. The
    // engine's `get` only reads `.id`, so a thin handle suffices —
    // DerivedEntry doesn't retain the public Node reference.
    const value = get<unknown>({ id } as Node<unknown>)
    stack.add(id)
    const deps: DepFrame[] = []
    for (const depId of Array.from(entry.deps).sort()) {
      const childEntry = entries.get(depId)
      if (!childEntry) continue
      const subExplanation = buildExplanation(depId, get, stack)
      const contributedAt =
        childEntry.kind === 'input' ? childEntry.lastWriteTime : childEntry.lastTime
      deps.push(freezeIfDev({ node: depId, contributedAt, explanation: subExplanation }))
    }
    stack.delete(id)
    const via: 'derived' | 'live' = entry.tag === 'live' ? 'live' : 'derived'
    return Object.freeze({
      via,
      node: id,
      value,
      computedAt: entry.lastTime,
      deps: freezeIfDev(deps) as readonly DepFrame[],
    })
  }

  /**
   * Direct (depth-1) dependencies of `node` at `now` — the engine's
   * forward-edge view, projected as a frozen `readonly NodeId[]`.
   *
   * Realises the third bullet of SPEC §11's liveness commitment: *"a
   * node's current dependents and current dependency are themselves
   * derived nodes."* The shipped shape is a one-shot snapshot rather
   * than a {@link DerivedNode}-valued handle — see the JSDoc on
   * {@link Graph.dependencies} for the §383 rationale (the commit
   * pipeline cannot host derived nodes whose value is metadata about
   * the commit pipeline itself without breaking the §5 single-tick
   * invariant). The snapshot still preserves the §11 semantics: the
   * engine is its own observer, not a side-channel devtools API.
   *
   * Inputs return `[]` because inputs have no upstream by construction;
   * derived nodes return the dep-set captured by the most recent
   * compute, sorted lexicographically for stable iteration. A
   * derivation that has never been evaluated returns `[]` — its
   * dep-set is rebuilt only by `computeDerived`, and the engine has
   * no honest answer until then.
   */
  function dependenciesOf<T>(node: Node<T>): readonly NodeId[] {
    // Same `getEntry` gate as `read`/`subscribe`/`explain`: surface
    // `UnknownNodeError` for fabricated ids and `NodeDisposedError`
    // for released ids so the read-side error catalogue is uniform.
    const entry = getEntry(node.id)
    if (entry.kind === 'input') return Object.freeze([]) as readonly []
    // Lex-sorted projection of the live dep set. Sorting is what makes
    // the snapshot diffable across calls — `entries.get(id).deps` is a
    // `Set` and JS `Set` iteration is insertion-ordered, which would
    // otherwise leak compute order into the public surface.
    return Object.freeze([...entry.deps].sort()) as readonly NodeId[]
  }

  /**
   * Direct (depth-1) dependents of `node` at `now` — the engine's
   * reverse-edge view, projected as a frozen `readonly NodeId[]`.
   *
   * Reads the same `dependents: Map<NodeId, Set<NodeId>>` adjacency
   * map the commit pipeline maintains for invalidation; the engine
   * already pays the bookkeeping cost on every recompute, so this
   * method is a near-zero-cost projection rather than a separate
   * traversal. See {@link Graph.dependents} for the snapshot-shape
   * rationale (#383).
   *
   * Returns `[]` for nodes with no live derivations consuming them,
   * including freshly-registered inputs and freshly-disposed
   * derivations whose downstream entries have already been removed
   * from the reverse-dep map by `_dispose`.
   */
  function dependentsOf<T>(node: Node<T>): readonly NodeId[] {
    getEntry(node.id)
    const set = dependents.get(node.id)
    if (!set || set.size === 0) return Object.freeze([]) as readonly []
    return Object.freeze([...set].sort()) as readonly NodeId[]
  }

  /**
   * Snapshot the engine's current model as a serialisable {@link CauslModel}
   * IR — the bridge between the TypeScript engine and the Rust-backed bounded
   * model checker (`causl-check`) that runs in CI as a green/red gate
   * alongside `tsc` and the property-based suite. The IR describes the
   * registered nodes, the dependency edges (static and conditional), recent
   * commits, and the schema version; the checker consumes it to enumerate
   * reachable states within configurable bounds and assert glitch-freedom,
   * dynamic-dep correctness, statechart conformance, cycle reachability,
   * and replay determinism.
   *
   * @param opts - Export options; currently controls `maxCommits` window.
   * @returns A frozen-by-convention IR document describing nodes, recent
   *  commits, and the schema version.
   *
   * @remarks
   * Non-serialisable values (functions, symbols, cycles) are replaced with
   * `null` and flagged via the `serializable` field. The latest `maxCommits`
   * commits are included, preserving recency over completeness. The IR is a
   * public contract — this method is its only producer.
   */
  function exportModel(opts?: ExportModelOptions): CauslModel {
    // Default to the most recent 100 commits when no window is supplied.
    const maxCommits = opts?.maxCommits ?? 100
    // Per `SPEC.md` §16.2.1.4, `captureCallGraph` defaults to `true`.
    // Hosts that cannot afford the stack-trace API cost in production
    // builds opt out via `captureCallGraph: false`. The default-on
    // choice matches "production bytes pay zero" — the call-graph
    // annotation is captured, not transmitted unless the IR is
    // exported.
    const captureCallGraph = opts?.captureCallGraph ?? true
    const nodes: IRNode[] = []
    // Translate each engine entry into its IR shape; preserve the input /
    // derived split. Engine-owned bookkeeping nodes (the commitLog derived)
    // are excluded — they're an implementation detail, not part of the
    // user-visible model the checker enumerates.
    //
    // The dispatch is exhaustive over the closed `Entry = InputEntry |
    // DerivedEntry` union: §4 commits the engine to two primitives, and
    // the IR mirrors that commitment. The previous draft of this loop
    // accepted `kind: 'resource'` and `kind: 'conflict'` arms via an
    // `as { readonly kind: string }` cast — a type-system override that
    // let adapter packages inject extra entry kinds straight into the
    // entries map and have them passthrough to the IR. That door is
    // closed (#368): `Entry` is the single source of truth for what
    // shape `entries` can hold; `assertNever` makes adding a third
    // variant a typecheck failure at this call site rather than a
    // silent passthrough. Adapter packages that need richer model
    // state register Inputs and Deriveds through the public `Graph`
    // API like any other consumer and ship a sibling document the
    // checker reads alongside the engine IR.
    for (const e of entries.values()) {
      if (e.id === COMMIT_LOG_ID) continue
      switch (e.kind) {
        case 'input':
          nodes.push({
            kind: 'input',
            id: e.id,
            graphId,
            // #703 Win 1 — route through the cached probe so a
            // repeated `exportModel` on a quiescent engine doesn't
            // re-stringify each input cell on every call.
            value: isInputValueSerializable(e, inputSerializableMemo)
              ? e.value
              : null,
            serializable: isInputValueSerializable(e, inputSerializableMemo),
          })
          break
        case 'derived':
          nodes.push({
            kind: 'derived',
            id: e.id,
            graphId,
            deps: Array.from(e.deps).sort(),
            conditionalDeps: [],
            value: serialiseSafely(e.value),
            serializable: isSerializable(e.value),
          })
          break
        default:
          // Exhaustiveness gate. If a future PR adds a third arm to
          // `Entry`, this line stops typechecking and the author has
          // to either narrow back to two primitives or land the §4
          // refactor that admits a third — never a silent passthrough.
          assertNever(e, 'exportModel: unknown entry kind')
      }
    }
    // Tail-slice the commit history to honour the max-commits window.
    // Each entry already carries `graphId` (the in-memory `commitHistory`
    // mirrors the schema-3 export shape — Phase F stamps it during
    // `commit`/`hydrate`). Schema-3 IR surfaces the `events`, `scopes`,
    // and `bridges` arrays. PR-B1 / TASK 1.B1.3 drains the subscriber
    // registry into `events` as `IRSubscribe` records — the first
    // event variant the engine actually emits. The other five
    // variants (`subscribe-callback`, `unsubscribe`, `dispose`,
    // `read`, `tx-set`) reserve the wire-format slot but are
    // populated by follow-on PRs once the EPIC-2 lint passes
    // co-design the tracking machinery in the engine. The brutal-
    // critical review's recommendation: prove the contract end-to-end
    // with one consumer before extending. `callGraph` is reserved on
    // `IRCommit` but PR-A does not yet emit it; the option resolves
    // through here so adopters can already opt in / out and downstream
    // tooling can audit its value.
    const commits = commitHistory.slice(-maxCommits)
    void captureCallGraph
    const events: IREvent[] = []
    // #916 — diagnostic fields (subscriptionId, scopeId, callbackSite)
    // are no longer retained per-entry. Mint them inline per export:
    // `subscriptionId` only needs uniqueness within a single export;
    // `scopeId` is the constant default scope; `callbackSite` is the
    // PR-B1 fallback. A future PR that lets `subscribe()` accept an
    // explicit scope or capture a real call site will reintroduce a
    // sibling WeakMap to retain per-entry overrides.
    const defaultScopeId = `${graphId}:default`
    let exportSubSeq = 0
    for (const sub of subscriptions) {
      events.push({
        kind: 'subscribe',
        graphId,
        id: `${graphId}:s.${++exportSubSeq}`,
        scopeId: defaultScopeId,
        target: sub.node.id,
        callbackSite: '<unknown>',
        time: sub.subscribedAt,
      })
    }
    // Default scope discipline: every export emits at least the
    // graph's `g.<graphId>:default` infinite scope. An `infinite`
    // scope absolves a subscription from needing a paired dispose;
    // EPIC-2's SubscribeWithoutDispose pass keys on this. Future PRs
    // add `subscribe()` options that introduce ephemeral scopes.
    const scopes: IRScope[] = [
      {
        id: `${graphId}:default`,
        kind: 'infinite',
        lifetime: { origin: 'graph-construct', terminator: 'process-exit' },
      },
    ]
    return {
      schema: CAUSL_MODEL_SCHEMA,
      time: now,
      nodes,
      commits,
      events,
      scopes,
      bridges: [],
    }
  }

  /**
   * Compute a deterministic digest over the registered node id-set.
   *
   * The digest is order-independent (ids are sorted before hashing) so two
   * graphs that registered the same nodes in different orders produce the
   * same hash. Used by {@link snapshot} as the capability claim on the
   * wire format, and by {@link hydrate} as the structural validation gate
   * that rejects snapshots whose id-set diverges from the live graph. The
   * check is the structural — not hopeful — defence against a server-side
   * snapshot whose node-set has drifted from the client; a mismatched
   * envelope is rejected with a typed {@link HydrationSchemaError} rather
   * than silently tearing engine state.
   *
   * @returns A hex digest covering every registered node id, qualified by
   *  the node `kind` so an `input`→`derived` rename is also caught.
   */
  function computeSchemaHash(): string {
    // Stable input to the digest: kind-qualified id, sorted lexicographically.
    const tokens: string[] = []
    for (const e of entries.values()) {
      tokens.push(`${e.kind}:${e.id}`)
    }
    tokens.sort()
    // Lightweight FNV-1a 32-bit; deterministic, dependency-free, and
    // sufficient for capability matching (this is not a cryptographic
    // boundary — schemaHash gates a structural mismatch, not authentication).
    let h = 0x811c9dc5
    const str = tokens.join('|')
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /**
   * Capture the engine's current input set + GraphTime as a serialisable
   * {@link GraphSnapshot}. SSR transfer, persistence, and DevTools time-
   * travel all need a single-call snapshot — without one, every adapter
   * rebuilds the equivalent and they drift. Derived nodes are intentionally
   * omitted because they are pure functions of inputs and recompute on
   * first read after {@link hydrate}; carrying them on the wire would
   * duplicate state that the engine can reconstruct deterministically.
   *
   * @returns A snapshot envelope keyed by `schema`, `time`, `inputs`, and
   *  `schemaHash`. Inputs whose value fails {@link isSerializable} are
   *  omitted, so the on-the-wire envelope round-trips through
   *  `JSON.stringify` cleanly.
   */
  function snapshot(): GraphSnapshot {
    // Walk the registered entries; only inputs with a JSON-safe value land in the envelope.
    const inputs: Record<NodeId, unknown> = {}
    for (const e of entries.values()) {
      if (e.kind !== 'input') continue
      // #703 Win 1 — cached probe: `serializableMemo` is reused
      // across every `snapshot()` call until the next `tx.set`
      // invalidates it.
      if (!isInputValueSerializable(e, inputSerializableMemo)) continue
      inputs[e.id] = e.value
    }
    return {
      schema: 1,
      time: now,
      inputs,
      schemaHash: computeSchemaHash(),
    }
  }

  /**
   * Project a {@link GraphSnapshot} at a historical GraphTime `t`,
   * sourced from the engine's bounded retention buffer. Returns
   * `{ status: 'evicted', oldestRetainedTime }` when `t` falls outside
   * the retention window — the discriminated arm is the structural
   * honesty about bounded retention, forcing callers to handle the
   * miss path rather than receive a fabricated value.
   *
   * @remarks
   * Devtools-bridge uses this on JUMP / IMPORT_STATE / ROLLBACK to
   * project historical state without mutating present state: time-
   * travel into a past `t` is a read of the retained inputs, not an
   * advance of `now` (#213). The shape mirrors `snapshot()` so
   * consumers can treat the result as drop-in panel state.
   *
   * @see #213 — devtools-bridge time travel via reads
   */
  function snapshotAt(time: GraphTime): RetentionResult<GraphSnapshot> {
    if (retainedSnapshots.length === 0) {
      return { status: 'evicted', oldestRetainedTime: now }
    }
    const oldest = retainedSnapshots[0]!.time
    if (time < oldest) {
      return { status: 'evicted', oldestRetainedTime: oldest }
    }
    let chosen: (typeof retainedSnapshots)[number] | undefined
    for (const snap of retainedSnapshots) {
      if (snap.time <= time) chosen = snap
      else break
    }
    if (!chosen) return { status: 'evicted', oldestRetainedTime: oldest }
    // Materialise the row's effective input set by walking the delta
    // chain. Filter to serialisable values and clone each (§12.2 deep-
    // immutability invariant): a non-serialisable cell (function,
    // symbol, cycle) is excluded for the same reason `snapshot()`
    // excludes it — replay through the snapshot has to be
    // deterministic. The clone isolates consumer mutations of the
    // returned envelope from the engine's retention table.
    const materialised = materialiseRetained(chosen)
    const inputs: Record<NodeId, unknown> = {}
    for (const [id, v] of Object.entries(materialised)) {
      if (!isSerializable(v)) continue
      inputs[id] = cloneForRetention(v)
    }
    return {
      status: 'retained',
      time: chosen.time,
      value: {
        schema: 1,
        time: chosen.time,
        inputs,
        schemaHash: computeSchemaHash(),
      },
    }
  }

  /**
   * Apply a {@link GraphSnapshot} to this graph by routing the snapshot's
   * input set through the same Phase A–H commit pipeline that
   * {@link Graph.commit} drives. Advances {@link now} by exactly one tick
   * (the §3 monotonicity invariant), recomputes the affected derivations,
   * publishes a single {@link Commit} with `intent: 'hydrate'` and
   * `originatedAt: snap.time`, fires per-node subscribers whose value
   * changed, and notifies `subscribeCommits` observers — uniformly with
   * any other commit. The §5 "one mutation pipeline" contract holds:
   * hydrate is no longer a parallel pipeline, just a privileged caller
   * of the same one (#366, #378).
   *
   * @param snap - The snapshot envelope to hydrate from.
   * @throws {@link CommitInProgressError} when invoked re-entrantly from
   *  inside another commit callback or hydrate. `commit` is the sole
   *  mutation entry-point in the engine and does not nest; hydrate
   *  shares that constraint because it is the same pipeline.
   * @throws {@link HydrationSchemaError} when `snap.schema` is not the
   *  supported version (`1`), or when `snap.schemaHash` is present and does
   *  not match the digest of the live graph's registered node id-set —
   *  the structural rejection that prevents server/client id-set drift
   *  from silently tearing engine state. Both arms throw before the
   *  commit pipeline is entered, so a rejected hydrate never appears in
   *  `commitLog` and never fires subscribers.
   *
   * @remarks
   * Inputs in `snap.inputs` whose id is not registered on this graph are
   * silently skipped; the schemaHash check is the structural guard that
   * rejects a snapshot whose id-set diverges materially. Inputs registered
   * on this graph but absent from `snap.inputs` retain their current
   * value. The snapshot's recorded `time` is preserved on the published
   * {@link Commit} as `originatedAt` so devtools and persistence
   * consumers can answer "this commit replays a server snapshot from
   * t=N" without inspecting `intent` strings; the engine clock advances
   * by exactly one tick regardless of `snap.time`.
   */
  function hydrate(snap: GraphSnapshot): void {
    // Schema-version gate. Only `1` is supported on the current wire format;
    // anything else is a HydrationSchemaError so callers can distinguish
    // "version skew" from "id-set drift" without parsing strings. The gate
    // runs BEFORE entering the commit pipeline so a rejected hydrate
    // never appears in `commitLog` and never fires subscribers — the
    // schema check is a structural capability check, not a Phase-A fault
    // that would need atomicity rollback.
    if (snap.schema !== 1) {
      throw new HydrationSchemaError(
        'schema-version',
        `unsupported schema version ${String(snap.schema)} (expected 1)`,
      )
    }

    // Schema-hash gate. When the caller supplied a hash, it must match the
    // live graph's id-set digest exactly — this is the structural capability
    // check (rather than a runtime hope) that prevents a stale or malicious
    // snapshot from silently tearing engine state by omitting required nodes.
    if (snap.schemaHash !== undefined) {
      const live = computeSchemaHash()
      if (snap.schemaHash !== live) {
        throw new HydrationSchemaError(
          'schema-hash',
          `snapshot schemaHash ${snap.schemaHash} does not match live graph ${live}`,
        )
      }
    }

    // Pre-filter the snapshot's input map down to ids the live graph
    // actually carries as inputs. Unknown ids are silently dropped (the
    // schemaHash gate above is the structural rejection path); derived
    // ids are never written through this surface (snapshots only carry
    // inputs). Filtering before entering the commit body keeps `tx.set`'s
    // throw-on-unknown contract intact for the public `commit` API.
    const writes: Array<readonly [NodeId, unknown]> = []
    for (const [id, value] of Object.entries(snap.inputs)) {
      const e = entries.get(id)
      if (!e || e.kind !== 'input') continue
      writes.push([id, value])
    }

    // Route through the shared commit pipeline. The intent label
    // `'hydrate'` distinguishes the record for commit-log consumers, and
    // `originatedAt: snap.time` carries the on-the-wire snapshot label
    // through to devtools and persistence. The engine clock advances by
    // exactly one tick — the §3 monotonicity invariant holds uniformly
    // across regular commits and hydrations (#366), and there is no
    // longer a parallel mutation pipeline (#378): hydrate is a
    // privileged caller of the same Phase A–H body that `commit` drives.
    commitInternal(
      'hydrate',
      (tx) => {
        for (const [id, value] of writes) {
          tx.set({ id } as InputNode<unknown>, value)
        }
      },
      snap.time,
    )
  }

  /**
   * Internal-API migration hydrate (issue #1090). Applies a
   * {@link GraphSnapshot} to a *fresh* graph (no commits yet) by
   * writing the snapshot's input set directly into engine state,
   * advancing {@link now} to `snap.time`, and recomputing derived
   * nodes against the new input cells — WITHOUT publishing the
   * synthetic `'hydrate'` commit record that {@link hydrate} appends
   * for SPEC §3 monotonicity.
   *
   * The §3 monotonicity invariant is preserved by the precondition:
   * the migration boundary itself isn't a commit. A fresh graph at
   * `now = 0` whose history is empty can adopt the snapshot's
   * recorded time as its own genesis without a synthetic record,
   * because there is no preceding `t` for `snap.time` to break
   * ordering against. After the migration `now === snap.time`, and
   * every subsequent {@link commit} call ticks forward from there
   * (`snap.time + 1`, `snap.time + 2`, …) — the same monotonic
   * sequence the (N+M)-commit pure-TS baseline produces.
   *
   * The deliberate contract differences vs. {@link hydrate}:
   *
   * - **No commit-log entry.** `commitHistory` stays empty; the
   *   `commitLog` derived stays at its genesis value. The (N+M)-commit
   *   pure-TS baseline that the cross-backend determinism matrix
   *   compares against has no `'hydrate'` entry either, so dropping
   *   the synthetic record lets the matrix compare literal IR
   *   byte-equality on the migration boundary cells (the gap that
   *   forced the value-channels-only oracle in #1089).
   *
   * - **No subscriber dispatch.** `subscribe`, `subscribeCommits`,
   *   `subscribeReads`, and `subscribeMany` observers do NOT fire for
   *   the migration. Observers are an adopter-facing notification
   *   surface for application-driven state advancement; a migration
   *   is engine-bootstrap state-loading, not a transaction. Adopters
   *   who want a one-shot post-migration notification subscribe after
   *   the migration boundary returns — the same shape SSR-hydrate
   *   adopters already use for `_migrateFrom`-style bulk loads.
   *
   * - **No `Commit` return.** The method returns `void`; there is no
   *   record to publish because no commit happened. Callers that
   *   need a synthesised receipt construct one inline.
   *
   * @param snap - The snapshot envelope to migrate from. Same wire
   *   shape as {@link Graph.hydrate} consumes.
   * @throws {@link HydrationSchemaError} when `snap.schema` is not the
   *   supported version (`1`), or when `snap.schemaHash` is present
   *   and does not match the digest of the live graph's registered
   *   node id-set. Same gates `hydrate` applies — the structural
   *   capability check is identical because the wire format is
   *   identical.
   * @throws {@link Error} when the graph is not in a fresh
   *   migration-boundary state. The precondition is `now === 0` and
   *   `commitHistory.length === 0`; calling `_migrateFrom` on a
   *   graph that has already advanced past its genesis is a misuse
   *   that would silently rewrite history and break the §3
   *   monotonicity invariant. Adopters who want SSR-restore semantics
   *   on a non-fresh graph use {@link hydrate} instead — the
   *   synthetic `'hydrate'` commit record is the right shape for
   *   that path.
   * @throws {@link CommitInProgressError} when invoked re-entrantly
   *   from inside another commit callback. The migration boundary is
   *   not a commit but it must not race with one; the re-entrancy
   *   guard fires the moment another commit is in flight on the
   *   same graph.
   *
   * @internal Not part of the public adopter surface. Reachable only
   *   through `@causl/core/internal`'s `_migrateFrom(graph, snap)`
   *   helper. Adopters use {@link Graph.hydrate}; the migration
   *   path exists for the auto-adapt wrapper (`@causl/core/wasm`'s
   *   `WasmBackend`) and the cross-backend determinism property test
   *   (#1090).
   */
  function _migrateFrom(snap: GraphSnapshot): void {
    // Schema-version gate. Mirrors `hydrate`'s gate exactly — wire
    // format is shared, so the structural rejection path is shared.
    if (snap.schema !== 1) {
      throw new HydrationSchemaError(
        'schema-version',
        `unsupported schema version ${String(snap.schema)} (expected 1)`,
      )
    }
    // Schema-hash gate — identical to `hydrate`'s.
    if (snap.schemaHash !== undefined) {
      const live = computeSchemaHash()
      if (snap.schemaHash !== live) {
        throw new HydrationSchemaError(
          'schema-hash',
          `snapshot schemaHash ${snap.schemaHash} does not match live graph ${live}`,
        )
      }
    }
    // Re-entrancy guard. The migration boundary is not a commit, but
    // it must not interleave with an in-flight `commit` / `simulate`
    // / `hydrate` — the same "one mutation pipeline" discipline
    // (§5) applies because the migration is bulk state-loading that
    // mutates input cells and forces a derived recompute.
    if (committing) throw new CommitInProgressError()
    // Migration-boundary precondition. The whole point of bypassing
    // the synthetic 'hydrate' commit is that the boundary itself is
    // NOT a transaction — it's engine bootstrap. That framing only
    // holds on a fresh graph: a graph that has already advanced past
    // genesis carries a commit history whose tail must remain the
    // most-recent moment, and overwriting `now` with `snap.time`
    // would either (a) move `now` backwards (§3 monotonicity break)
    // or (b) leave a gap that no commit record explains. Adopters
    // who want to hydrate a running graph use `Graph.hydrate` — the
    // synthetic record is the structural marker that says "the engine
    // clock advanced because state was bulk-loaded, not because of
    // a user commit." Reject the misuse with a typed-shape error so
    // a caller who reached the wrong primitive gets a structured
    // diagnostic rather than a silent history rewrite.
    if (now !== 0 || commitHistory.length !== 0) {
      throw new Error(
        `_migrateFrom: graph is not in a fresh migration-boundary state ` +
          `(now=${now}, commitHistory.length=${commitHistory.length}). ` +
          `_migrateFrom is only valid on a freshly-registered graph with no prior commits; ` +
          `use Graph.hydrate() to restore a snapshot onto a running graph.`,
      )
    }

    // Pre-filter the snapshot's input map down to ids the live graph
    // actually carries as inputs. Mirrors `hydrate`'s filter: unknown
    // ids are silently dropped (the schemaHash gate above is the
    // structural rejection path); derived ids are never written
    // through this surface.
    const writes: Array<readonly [NodeId, unknown, InputEntry]> = []
    for (const [id, value] of Object.entries(snap.inputs)) {
      const e = entries.get(id)
      if (!e || e.kind !== 'input') continue
      writes.push([id, value, e])
    }

    // Advance `now` to the snapshot's recorded time. From this moment
    // the engine clock is `snap.time`; subsequent commits tick to
    // `snap.time + 1`, `snap.time + 2`, …. The §3 monotonicity
    // invariant holds: the precondition above guarantees the graph
    // had no preceding `t > 0`, so adopting `snap.time` as genesis
    // doesn't move `now` backwards.
    now = snap.time

    // Write the snapshot's input values directly into the live
    // entries. Each touched input gets its `lastWriteTime` stamped at
    // `now` — the same byte-shape `Graph.commit` would have produced
    // for a write at this time — so `Explanation.computedAt` and the
    // per-dep `contributedAt` frames stay byte-identical to the
    // pure-TS baseline. The `Object.is` filter skips no-op writes for
    // inputs whose snapshot value equals the registered initial; the
    // pure-TS baseline's `commit` path applies the same filter (it
    // wouldn't have published a write for those inputs in the first
    // place), so skipping here preserves byte-equality.
    const changedInputIds: NodeId[] = []
    for (const [id, value, e] of writes) {
      if (Object.is(e.value, value)) continue
      e.value = value
      e.lastWriteTime = now
      // Invalidate the serializable-memo for the touched input — the
      // value changed, so the cached JSON-serialisable verdict no
      // longer applies. Same shape `tx.set` performs.
      inputSerializableMemo.delete(id)
      changedInputIds.push(id)
    }

    // Mirror Phase F.6's retention bookkeeping so post-migration
    // `readAt(t)` for `t <= snap.time` resolves through the same
    // delta-chain shape the pure-TS baseline produces. Gate on
    // `commitHistoryCap > 0` (Amendment 2, #715) — retention is
    // dead work when caps are zero.
    if (commitHistoryCap > 0 && snapshotRetentionCap > 0) {
      const delta = new Map<NodeId, unknown>()
      for (const id of changedInputIds) {
        const e = entries.get(id)
        if (
          e &&
          e.kind === 'input' &&
          isInputValueSerializable(e, inputSerializableMemo)
        ) {
          delta.set(id, e.value)
        }
      }
      const head =
        retainedSnapshots.length > 0
          ? retainedSnapshots[retainedSnapshots.length - 1]!
          : null
      retainedSnapshots.push({ time: now, delta, prev: head })
      // Same FIFO eviction loop Phase F.6 runs — keeps the buffer
      // bounded if the migration target is registered at a time
      // beyond `snapshotRetentionCap` (defensive; in practice
      // `_migrateFrom` runs on a fresh graph so the buffer holds at
      // most genesis + this row).
      while (retainedSnapshots.length > snapshotRetentionCap) {
        const evicted = retainedSnapshots.shift()!
        const newRoot = retainedSnapshots[0]
        if (!newRoot) break
        let cur: RetainedRow | null = evicted
        while (cur !== null) {
          for (const [id, v] of cur.delta) {
            if (!newRoot.delta.has(id)) {
              newRoot.delta.set(id, v)
            }
          }
          cur = cur.prev
        }
        newRoot.prev = null
      }
    }

    // Recompute derived nodes affected by the migrated input writes.
    // `recomputeAffected` walks the dependents graph in topo order,
    // calling `computeDerived` on each affected entry — `computeDerived`
    // stamps `e.lastTime = now`, which is `snap.time` here, byte-
    // identical to the pure-TS baseline's last-commit `lastTime`.
    //
    // No `rollback` holder is passed: the migration boundary is
    // documented as "bootstrap"; a throw escaping a user-supplied
    // `compute` propagates upward. There is no atomic-rollback story
    // because there is no commit to roll back to — the same framing
    // as a `compute` throw during `derived(...)` registration, which
    // also lets the error propagate without trying to restore an
    // intermediate state.
    if (changedInputIds.length > 0) {
      const seedSet = new Set<NodeId>(changedInputIds)
      recomputeAffected(seedSet)
    }
    // Subscribers, commit-log observers, and the commit-history ring
    // are all deliberately NOT touched. The migration boundary is
    // bulk state-loading, not a commit; adopters that want a
    // post-migration notification call `subscribe` after this method
    // returns.
  }

  /**
   * Read the value of a node at a past committed time. The result is a
   * discriminated `Retained | Evicted` union rather than a throw on
   * out-of-window history: the bound on the retention buffer is the
   * structural reason a past time may not be reachable, and the type
   * forces every caller to handle that miss path explicitly. Time-
   * travel devtools and replay-determinism testing both consume this
   * primitive — devtools to project a historical snapshot, the test
   * harness to verify that replaying a captured commit sequence on a
   * fresh graph produces a byte-identical state.
   *
   * @typeParam T - Value type of the node.
   * @param node - The node handle to read.
   * @param time - Past GraphTime; values < the oldest retained snapshot
   *  surface as `evicted` with the oldest still-retained time.
   * @returns Either `{ status: 'retained', value, time }` for a hit or
   *  `{ status: 'evicted', oldestRetainedTime }` for a miss.
   *
   * @remarks
   * **Behavior domain.** Every Behavior — input *and* derived — is
   * denotationally defined on `[registrationTime, ∞)` only (§3). The
   * engine has no value to return for `t < registrationTime` because
   * the entity did not exist as a node in the graph at that moment.
   * `readAt(node, t)` for `t < registrationTime` returns `{ status:
   * 'evicted', oldestRetainedTime: registrationTime }` so callers
   * handle "outside the domain" through the same discriminated arm as
   * "outside the retention window": the value isn't in the retention
   * buffer because it didn't exist yet, and the breadcrumb points at
   * the earliest reachable GraphTime. The input branch landed in #277;
   * the derived branch in #374 closed the symmetric gap (without it
   * `readAt(derived, t < derivedRegisteredAt)` recomputed against the
   * retained input snapshot and fabricated a value for a Behavior
   * that did not yet exist — a §3 domain violation).
   */
  function readAt<T>(node: Node<T>, time: GraphTime): RetentionResult<T> {
    // Domain check first: a writable Behavior registered at `t_r` is
    // denotationally defined on `[t_r, ∞)`. Reads at `t < t_r` surface
    // as `evicted` with `oldestRetainedTime: registeredAt` — not
    // because the row was evicted from the retention buffer, but
    // because the Behavior did not exist at that GraphTime in the
    // first place. The discriminated `evicted` arm is the right
    // semantic shape: the value isn't reachable, and the recovery
    // breadcrumb points the caller at the earliest GraphTime where
    // the read would succeed. This sits ahead of the retention-window
    // probe so the `oldestRetainedTime` reported is the registration
    // time itself, not the (typically older) chain root — the
    // breadcrumb is most useful when it names the boundary the caller
    // would have to advance past to get a hit (#277).
    const e = entries.get(node.id)
    if (e && e.kind === 'input') {
      // #915 — `inputRegisteredAt` lives on the sibling
      // `inputRegisteredAtMap` only for inputs registered after
      // `now > 0`. Inputs registered at genesis (the common case)
      // implicitly carry `registeredAt = 0`; the map miss falls
      // back to 0, structurally identical to the pre-#915
      // `e.inputRegisteredAt = 0` field on a genesis-registered
      // input.
      const registeredAt = inputRegisteredAtMap.get(node.id) ?? 0
      if (time < registeredAt) {
        return { status: 'evicted', oldestRetainedTime: registeredAt }
      }
    }
    // The derived branch of the same domain rule (#374). Without this
    // check the engine would happily run `recomputeFromSnapshot`
    // against the retained input row at `t < derivedRegisteredAt` and
    // fabricate a value for a Behavior that did not exist at that
    // GraphTime — breaking §3's `[registrationTime, ∞)` claim for
    // the derived half of the Behavior universe and undermining the
    // §15.1 replay-determinism property (the cached fabricated value
    // could drift from a fresh replay that registered the derivation
    // at the same time but never called `readAt` first). Mirroring
    // the input-domain branch keeps the recovery breadcrumb shape
    // identical: the earliest GraphTime where the read would succeed.
    if (e && e.kind === 'derived' && time < e.derivedRegisteredAt) {
      return { status: 'evicted', oldestRetainedTime: e.derivedRegisteredAt }
    }
    if (retainedSnapshots.length === 0) {
      // Defensive fallback — `createCausl` seeds a t₀ snapshot, but
      // a misuse path that empties the buffer should still surface a
      // typed `evicted` rather than throw.
      return { status: 'evicted', oldestRetainedTime: now }
    }
    const oldest = retainedSnapshots[0]!.time
    if (time < oldest) {
      return { status: 'evicted', oldestRetainedTime: oldest }
    }
    // Find the latest snapshot whose time <= requested. Linear scan is
    // bounded by `snapshotRetentionCap` and fits in cache; binary
    // search would be a premature optimisation.
    let chosen: (typeof retainedSnapshots)[number] | undefined
    for (const snap of retainedSnapshots) {
      if (snap.time <= time) chosen = snap
      else break
    }
    if (!chosen) {
      return { status: 'evicted', oldestRetainedTime: oldest }
    }
    if (e && e.kind === 'input') {
      // Inputs absent from the snapshot were registered after this
      // commit time — surface as `evicted` rather than fabricate. The
      // chain walk (`resolveRetained`) is the structural-sharing
      // replacement for the pre-#235 flat-record lookup `node.id in
      // chosen.inputs`: instead of every retained row holding a deep
      // copy of every input cell, only rows whose commit actually
      // wrote that input own a delta entry, and resolution falls
      // through to `prev` until a row owns it (or the chain runs out,
      // which is the registered-after case).
      const lookup = resolveRetained(chosen, node.id)
      if (!lookup.found) {
        return { status: 'evicted', oldestRetainedTime: oldest }
      }
      // Clone on read so consumer mutations of the returned value
      // cannot leak back into the engine's retention table (§12.2
      // deep-immutability invariant). Cloning at retention-write time
      // alone is insufficient — repeated `readAt(t)` calls would
      // otherwise share the same clone, letting one consumer's
      // mutation surface to the next.
      return {
        status: 'retained',
        value: cloneForRetention(lookup.value) as T,
        time: chosen.time,
      }
    }
    if (e && e.kind === 'derived') {
      // Recompute the derivation against the retained input snapshot
      // through a wavefront-memoising helper so a diamond DAG resolves
      // each join exactly once. The helper is passed the retained row
      // directly so each input read walks the delta chain rather than
      // materialising the full input table up front — that
      // materialisation would cancel #235's structural-sharing
      // savings on the read path.
      const value = recomputeFromSnapshot<T>(e.id, chosen)
      return { status: 'retained', value, time: chosen.time }
    }
    return { status: 'evicted', oldestRetainedTime: oldest }
  }

  /**
   * Pure recompute of a derivation against a fixed input snapshot, with
   * per-call memoisation so diamond DAGs evaluate each join once.
   *
   * @typeParam T - Value type produced by the requested node.
   * @param id - Id of the node whose value is being resolved.
   * @param snapshotInputs - Map of input id → retained value at the
   *  snapshot's commit time.
   * @returns The value of `id` evaluated against `snapshotInputs`.
   * @throws {@link UnknownNodeError} if `id` is not registered.
   * @throws {@link CycleError} if the recompute path closes a cycle.
   *
   * @remarks
   * The `memo` map is the wavefront-level visited set: on a join node
   * read by two paths from a diamond apex, the second visit returns
   * the cached value rather than recomputing. `inFlight` is the
   * cycle-detection stack — distinct from `memo`, because a previously-
   * computed result is not a cycle.
   */
  function recomputeFromSnapshot<T>(
    id: NodeId,
    snapshotRow: RetainedRow,
    memo: Map<NodeId, unknown> = new Map(),
    inFlight: Set<NodeId> = new Set(),
  ): T {
    if (memo.has(id)) return memo.get(id) as T
    const e = entries.get(id)
    if (!e) throw new UnknownNodeError(id)
    if (e.kind === 'input') {
      // Resolve the input via the delta chain (#235): rows whose commit
      // actually wrote this input own a delta entry; resolution falls
      // through `prev` until a row owns it. Inputs registered after the
      // snapshot's commit time will not be reachable through the chain,
      // and we fall back to their current value so derivations that
      // depend on them still produce a useful result (consistent with
      // the pre-#235 behaviour for the same case).
      const lookup = resolveRetained(snapshotRow, id)
      const v = lookup.found ? lookup.value : e.value
      memo.set(id, v)
      return v as T
    }
    if (inFlight.has(id)) {
      throw new CycleError([...inFlight, id])
    }
    inFlight.add(id)
    const get = <U>(n: Node<U>): U =>
      recomputeFromSnapshot<U>(n.id, snapshotRow, memo, inFlight)
    const value = e.compute(get) as T
    inFlight.delete(id)
    memo.set(id, value)
    return value
  }

  /**
   * Adapter-layer disposal: removes a node from the registry, drops every
   * dep / dependent edge it participated in, cancels any subscriptions
   * targeting it, and records the disposal time so subsequent access through
   * the public surface throws {@link NodeDisposedError}. Idempotent.
   *
   * @remarks
   * Reachable only via `dispose(graph, node)` from `@causl/core/internal`;
   * not part of the public {@link Graph} interface. Disposal is an adapter-
   * level concern — the React `useCauslFamily` hook owns the concept of
   * "this node's lifetime is bounded by a component's mount" — and no
   * application code should call it directly. Refuses to run while a commit
   * is in progress, and refuses to release a node that still has live
   * dependents; the calling adapter is expected to release downstream
   * consumers first.
   *
   * @param node - The node to dispose.
   * @throws {@link DisposalDuringCommitError} when invoked mid-commit.
   * @throws {@link NodeHasDependentsError} when the node still has live dependents.
   */
  function _dispose(node: Node<unknown>): void {
    const id = node.id
    // Idempotency: if no live entry exists for this id, dispose is a no-op
    // (covers both "never registered" and "already disposed in this
    // lifecycle"). The `disposed` map is NOT consulted here: an id may have
    // been disposed and then re-registered (e.g. useCauslFamily P7 — full
    // unmount + remount on the same id), in which case the new entry is
    // fully eligible for disposal even though a tombstone from the previous
    // lifecycle still lives in `disposed`. The tombstone is a read-side
    // signal only; the lifecycle check is `entries.has(id)`.
    const e = entries.get(id)
    if (!e) return

    // Refuse mid-commit edits — staged writes / recompute would race with
    // edge removal.
    if (committing) throw new DisposalDuringCommitError(id)

    // Refuse to leave dangling dependent edges. Adapter code must release
    // downstream consumers before their producer.
    const downstream = dependents.get(id)
    if (downstream && downstream.size > 0) {
      throw new NodeHasDependentsError(id, [...downstream])
    }

    // Drop forward edges if the node was a derivation: its dependencies'
    // reverse-dep sets must forget the now-dead consumer.
    if (e.kind === 'derived') {
      for (const dep of e.deps) {
        const bucket = dependents.get(dep)
        if (bucket !== undefined) {
          bucket.delete(id)
          // #994 — clear `hasDependents` on the upstream input
          // entry when the last consumer drops. Mirrors the
          // edge-remove path in `setDeps` / `setDepsFromArray`;
          // disposal is the third site at which `dependents`
          // mutates outside the recompute pipeline.
          if (bucket.size === 0) {
            const upstream = entries.get(dep)
            if (upstream !== undefined && upstream.kind === 'input') {
              upstream.hasDependents = false
            }
          }
        }
      }
      // #715 follow-up — reverse the consumer-counter contribution
      // recorded by `setDeps` for this id. Plain deriveds whose
      // recorded read-set still includes COMMIT_LOG_ID at dispose
      // time donated one count; commit-metadata-tagged deriveds
      // donated one count at registration (and `setDeps` skipped
      // them). Both arms decrement once. The `disposeNode` /
      // `_dispose` contract refuses dispose of a node with live
      // dependents, so a derived being disposed cannot still be
      // mid-recompute; the recorded `e.deps` is the authoritative
      // last-known dep set.
      if (e.tag === 'commit-metadata') {
        commitLogConsumerCount--
      } else if (e.deps.has(COMMIT_LOG_ID)) {
        commitLogConsumerCount--
      }
    }
    dependents.delete(id)

    // Cancel any subscriptions targeting this node so observer dispatch
    // never visits a dead entry. Drop the per-node-index bucket too
    // (#671): the index would otherwise pin disposed-node entries
    // and Phase G would attempt to readEntry through a dangling id.
    // #715 follow-up: when the disposed id is COMMIT_LOG_ID itself,
    // every subscription bucket targeting it represents one
    // consumer-counter contribution. Decrement once per cancelled
    // subscription. (In practice the commitLog node is engine-owned
    // and never disposed, but defending the contract here is cheap
    // and keeps the counter honest under any future internal
    // refactor that exposes engine-owned dispose paths.)
    for (const sub of subscriptions) {
      if (sub.node.id === id) {
        subscriptions.delete(sub)
        if (id === COMMIT_LOG_ID) commitLogConsumerCount--
        // #696 — keep `transientSubscriberCount` honest when a
        // transient subscription is cancelled by node disposal
        // before its first non-initial Phase G fire would have
        // auto-dropped it. Plain (non-transient) subscriptions are
        // a no-op for this counter.
        if (sub.transient) transientSubscriberCount--
      }
    }
    subscriptionsByNode.delete(id)
    // #701: drop the per-node `subscribeReads` bucket for the
    // disposed id and prune the recordedDeps of every registration
    // that referenced it. The projection itself is left registered
    // — a future commit that flips it onto a different read-set
    // will refresh `recordedDeps` automatically — but the dangling
    // dep must not pin the disposed id's bucket entry.
    const projBucket = subscribeReadsByNode.get(id)
    if (projBucket !== undefined) {
      for (const reg of projBucket) {
        reg.recordedDeps.delete(id)
      }
      subscribeReadsByNode.delete(id)
    }

    // Remove the entry and record the tombstone with the current GraphTime
    // so future `getEntry` calls surface NodeDisposedError, not Unknown.
    // Re-disposal of an id already in the ring updates the timestamp
    // *and* refreshes its position to the tail — `Map.delete` followed
    // by `Map.set` re-inserts at the end of the insertion order.
    if (disposed.has(id)) {
      disposed.delete(id)
    }
    entries.delete(id)
    // #696 — `inputCount` / `derivedCount` running totals surfaced via
    // `graph.stats()`. Decrement on the same kind branch the
    // `entries.set` site incremented in `input` / `derived`. The
    // engine-owned `commitLogEntry` is not reachable via `_dispose`
    // (no public surface returns it as a `Node<unknown>`), so the
    // engine-owned slot stays uncounted on both halves of the
    // lifetime.
    if (e.kind === 'input') inputCount--
    else derivedCount--
    // #915 — sibling maps for input observability state. Cheap
    // unconditional delete; missing-key delete is O(1) on Map.
    // Inputs that never registered after `now > 0` (most adopters)
    // and never serialized leave both maps empty; the deletes are
    // O(1) no-ops in that steady state.
    inputRegisteredAtMap.delete(id)
    inputSerializableMemo.delete(id)
    // Drop the id from the commit-metadata index so Phase F.5 does not
    // walk a tombstoned entry. Cheap unconditional `delete` — the Set
    // returns false for missing ids and the dispose pipeline already
    // owns this id's lifetime (#452).
    commitMetadataIds.delete(id)
    disposed.set(id, now)
    // FIFO-evict the oldest tombstone past the cap. JS Map iteration
    // is insertion-ordered, so the head of `keys()` is the oldest
    // entry — pop one per overflow rather than splicing in bulk so
    // a stuck-disposal pathology can never wedge the eviction loop
    // into super-linear work. Mirrors `commitHistory.splice(0, …)`
    // at the per-write evict-when-over-cap shape (#251).
    //
    // #917 audit: this is the *only* user-code `.next()` call site in
    // `packages/core/src/`. The `wrong map` deopt that engine-status
    // reports against `<JSFunction next>` on
    // `scrolling-viewport × 10000` is V8's internal Map.prototype
    // iterator builtin (opt id 2 / bytecode offset 3 / deopt exit 0,
    // i.e. the entry-map check on the first instruction of an
    // already-optimised iterator built during Node.js bootstrap), not
    // this site — `scrolling-viewport`'s harness never disposes nodes,
    // so this loop is not on its execution path. Documented as a
    // negative finding per the #883/#881 precedent in
    // `packages/bench/report/engine-status-deopts/SUMMARY.md`; if a
    // future PR adds a Map iteration in the per-commit hot path, the
    // V8 builtin's polymorphism budget changes and the audit may need
    // to be re-run.
    while (disposed.size > disposedTombstoneCap) {
      const oldest = disposed.keys().next().value
      if (oldest === undefined) break
      disposed.delete(oldest)
    }
  }

  /**
   * Snapshot the engine's retained-state telemetry counters as a single
   * frozen-shape {@link EngineTelemetry} record (#757 first cut, #696
   * cross-backend contract widening).
   *
   * @remarks
   * Pure read: every counter is the `.size` / `.length` / scalar value
   * of an engine-internal collection (or a closure-captured running
   * counter — `inputCount`, `derivedCount`, `transientSubscriberCount`,
   * `commitLogConsumerCount`) at the moment of the call, packed into
   * one freshly-allocated object. No collection is iterated and no
   * engine state is mutated. The stable contract is the field names
   * documented on {@link EngineTelemetry}; the implementation is the
   * closure-captured collections and counters declared near the top of
   * {@link createCausl}.
   *
   * The optional engine-status fields {@link EngineTelemetry.deopts}
   * and {@link EngineTelemetry.gcPauses} are intentionally **omitted**
   * from the returned object on this canonical TS engine — V8
   * deoptimisations and GC pauses are not wired into engine retained
   * state at runtime; the bench harness captures them externally (see
   * `packages/bench/report/engine-status-deopts/SUMMARY.md`). Reading
   * `s.deopts` on a TS-backend record returns `undefined`, which the
   * type guards via `number | undefined`. The future WASM backend may
   * populate these fields (linear-memory bump-pointer allocation has
   * no GC pauses, so a WASM `gcPauses: 0` is the structural minimum).
   *
   * Consumed by the `subscriber-churn-1k` bench scenario as its end-of-
   * run leak gate (#733/#738), by long-running devtools surfaces
   * (#695 / #696 wasm-cluster audit-required telemetry), and by the
   * cross-backend determinism gate flagged in #685 (the host-
   * independent fields — `inputs`, `deriveds`, `lastCommitTime`,
   * `subscribersTotal` — are required to be byte-equal across the TS
   * and WASM backends for the same workload trace).
   */
  function stats(): EngineTelemetry {
    return {
      inputs: inputCount,
      deriveds: derivedCount,
      subscribersTotal: subscriptions.size,
      subscribersByNodeKeys: subscriptionsByNode.size,
      transientSubscribers: transientSubscriberCount,
      commitObservers: commitObservers.size,
      commitMetadataDeriveds: commitMetadataIds.size,
      commitLogConsumerCount,
      entries: entries.size,
      lastCommitTime: now,
      retainedCommits: commitHistory.length,
    }
  }

  // Construct the {@link JsBackend} adapter — the TS-side reference
  // implementation of {@link BackendEngine} (#681). The backend holds a
  // bag of references into this closure's engine helpers and projects
  // them onto the narrow {@link BackendEngine} surface. The Graph
  // facade below routes its BackendEngine-listed methods through the
  // backend so the seam is exercised on every relevant call; the
  // higher-level affordances (`input`, `derived`, `simulate`,
  // `subscribeMany`, `subscribeReads`, `explain`, `dependencies`,
  // `dependents`, `commitMetadataDerived`, `commitLog`, `stats`) compose
  // on top and stay JS-side across both backends.
  //
  // The {@link BackendEngine.commit} shape accepts a precomputed
  // ReadonlyMap<NodeId, Json> of writes — the desugared form the WASM
  // backend will receive once #683/#684 land. The TS engine continues
  // to drive `Graph.commit(intent, run)` through `commitInternal`
  // directly to preserve the tx-callback validation path
  // (`StaleTxError`, in-tx reads via `tx.get`); the backend's
  // writes-map form below builds a transient tx callback that delegates
  // to that same path, so both surfaces share one publish pipeline.
  const backend: BackendEngine = new JsBackend({
    commit: (intent, writes) =>
      commit(intent, (tx) => {
        for (const [id, value] of writes) {
          // The InputNode handle carries only `id`; the engine's
          // internal `getEntry` validates the kind/disposal/registration
          // checks. Constructing a fresh handle here is byte-equivalent
          // to looking one up in `entries` for the `tx.set` call.
          tx.set({ id } as InputNode<unknown>, value)
        }
      }),
    read: <T,>(node: Node<T>) => read<T>(node),
    subscribe: <T,>(node: Node<T>, observer: Observer<T>) =>
      subscribe<T>(node, observer),
    subscribeCommits: (observer) => subscribeCommits(observer),
    snapshot: () => snapshot(),
    hydrate: (snap) => { hydrate(snap) },
    exportModel: () => exportModel(),
    readAt: <T,>(node: Node<T>, time: GraphTime) => readAt<T>(node, time),
    snapshotAt: (time) => snapshotAt(time),
    dispose: (node) => { _dispose(node) },
    // `evaluateStatechart` — SPEC §6 composite-statechart extension
    // point landed by issue #1068 as the deferred-from-#698 work. The
    // default implementation lives in `./statechart-evaluator.ts` and
    // mirrors the sync-side reducers (`reduceConflict` /
    // `reduceResource` in `@causl/sync/src/statechart-reducers.ts`)
    // structurally. A cross-backend determinism gate verifies the two
    // implementations stay byte-equivalent; the WASM backend's
    // `evaluateStatechart` (Sub-D of EPIC #680) replaces this with a
    // Rust-side implementation consuming the
    // `tools/engine-rs-core/src/statechart_reducers.rs` enums (gated
    // behind `feature = "future"`).
    evaluateStatechart: (input) => evaluateStatechartImpl(input),
    now: () => now,
  })

  // Assemble the public Graph surface — the canonical primitives `input`,
  // `derived`, `commit`, `read`, `subscribe`, `subscribeCommits`, and
  // `explain`, augmented with the second-tier extensions that each named an
  // unavoidable concept: `commitLog` (the transaction log as a Behavior),
  // `exportModel` (the IR consumed by `causl-check`), `simulate` (the §5
  // dry-run API — predict a commit's effect without committing),
  // `dependencies` / `dependents` (the §11 third-bullet inspection
  // primitives — the engine's forward and reverse dep adjacency, projected
  // as one-shot snapshots so devtools can answer "what does this read?" /
  // "what reads this?" through engine primitives instead of a side-channel
  // API; #363, snapshot shape per #383),
  // `snapshot` / `hydrate` (SSR transfer and persistence), `snapshotAt` /
  // `readAt` (time-travel reads), and the `now` accessor that exposes
  // GraphTime without granting write access. Memory hygiene for long-lived processes
  // is the `commitHistoryCap` knob (default 1000; pass `0` or `1` for zero
  // retention) — there is no runtime flush primitive, because firing
  // `commitLog` subscribers outside a commit boundary would violate §5.
  // Disposal is NOT on this public surface: it is an adapter-level concern
  // published to the internal-dispatch registry below and is reachable only
  // via `@causl/core/internal`'s `dispose(graph, node)`.
  //
  // The BackendEngine-listed methods (`read`, `subscribe`,
  // `subscribeCommits`, `snapshot`, `hydrate`, `exportModel`, `readAt`,
  // `snapshotAt`, `now`) route through the {@link JsBackend} above so
  // the seam introduced in #681 is exercised on every relevant adopter
  // call. `Graph.commit(intent, run)` keeps using the engine's internal
  // commit pipeline directly to preserve the tx-callback validation
  // path; the backend's writes-map `commit` shape exists for the
  // adapter side of the seam (the WASM bridge will call it).
  const graph: Graph = {
    input,
    derived,
    commitMetadataDerived,
    commit,
    simulate,
    read: <T,>(node: Node<T>) => backend.read<T>(node),
    subscribe: <T,>(
      node: Node<T>,
      observer: Observer<T>,
      options?: SubscribeOptions,
    ) =>
      // The Graph surface's `subscribe` accepts a `transient: true`
      // option (#766) that the BackendEngine seam does not carry —
      // transient observers are an adopter-facing convenience, not a
      // backend-storage concept. Route the no-options arity through
      // the backend; fall back to the closure's full surface when
      // options are present.
      options === undefined
        ? backend.subscribe<T>(node, observer)
        : subscribe<T>(node, observer, options),
    subscribeMany,
    subscribeCommits: (observer) => backend.subscribeCommits(observer),
    subscribeReads,
    explain,
    dependencies: dependenciesOf,
    dependents: dependentsOf,
    exportModel: (opts?: ExportModelOptions) =>
      // The Graph surface's `exportModel` accepts caller tuning
      // (commit-log cap); the BackendEngine seam takes no options.
      // Route the no-options arity through the backend; fall back to
      // the closure for the tuned form.
      opts === undefined ? backend.exportModel() : exportModel(opts),
    snapshot: () => backend.snapshot(),
    snapshotAt: (time) => backend.snapshotAt(time),
    hydrate: (snap) => backend.hydrate(snap),
    readAt: <T,>(node: Node<T>, time: GraphTime) =>
      backend.readAt<T>(node, time),
    get now() {
      return backend.now
    },
    commitLog: commitLogNode,
    stats,
  }

  // Publish the dispose closure to the private dispatch registry so
  // `@causl/core/internal`'s `dispose(graph, node)` can reach it without
  // widening the public Graph interface — disposal is an adapter-level
  // concern that no application code should call directly. The
  // dispatch routes through {@link BackendEngine.dispose} so the seam
  // owns the single source of truth for adapter-layer disposal across
  // both backends.
  registerInternalDispatch(graph, {
    dispose: (node) => backend.dispose(node),
    _migrateFrom: (snap) => _migrateFrom(snap),
    // #1241 — adapter-exemption seam. Routes through the
    // closure-scoped `runInAdapterReadMode` helper which manages the
    // H1 hazard tracker's depth counter. See
    // `InternalDispatch.__causlAdapterRead` for the contract.
    __causlAdapterRead: <T,>(fn: () => T) => runInAdapterReadMode(fn),
  })

  // Publish the disposed-tombstone size accessor to the parallel
  // testing-only dispatch registry so `@causl/core/testing`'s
  // `disposedTombstoneSize(graph)` can read engine state without
  // routing a test-only seam through the adapter-facing
  // `@causl/core/internal` surface (#376).
  registerTestingDispatch(graph, {
    disposedTombstoneSize: () => disposed.size,
    commitLogConsumerCount: () => commitLogConsumerCount,
    // #703 Win 3 — expose the live deps Set so the
    // setDeps-immutability property suite can capture a reference
    // and verify subsequent commits leave it byte-identical.
    derivedDeps: (id: NodeId) => {
      const e = entries.get(id)
      if (!e || e.kind !== 'derived') return null
      return e.deps
    },
  })

  return graph
}

/**
 * Conservative predicate identifying values that round-trip through JSON.
 *
 * Primitive `null`/`undefined`/number/string/boolean are accepted directly;
 * functions and symbols are rejected; everything else is probed with
 * `JSON.stringify` and accepted iff the call succeeds (catches cycles and
 * `BigInt`).
 *
 * @param value - Any value held by an input or derivation.
 * @returns `true` when `JSON.stringify(value)` would succeed.
 */
/**
 * Clone a value for retention storage so consumer mutations of values
 * returned by `readAt` are structurally isolated from the engine's
 * retention table (§12.2 deep-immutability invariant).
 *
 * @remarks
 * Primitives (number, string, boolean, null, undefined) are returned
 * as-is — they are immutable by JS semantics. Structured values are
 * cloned via `structuredClone` (Node 17+ / browsers — already required
 * by other engine paths). The cost is `O(structured_size)` per *changed*
 * cell per commit — paid once at retention-write time, not on every
 * `readAt` read. For the structural-sharing perf model from #235 this
 * is the right place: only changed cells incur the clone, so memory
 * cost remains `O(changed_cells × R)`.
 *
 * Falls back to the original reference if `structuredClone` throws
 * (e.g., on an exotic value the host's clone algorithm doesn't
 * recognise) — the contract degrades to "best-effort isolation" rather
 * than failing the commit.
 */
function cloneForRetention<T>(value: T): T {
  // Primitive fast path — immutable by JS semantics, no clone needed.
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'number' || t === 'string' || t === 'boolean') return value
  // Structured fall-through. structuredClone is a host built-in
  // available in every supported runtime; on the rare case it throws
  // (e.g., a value with Function-typed fields that slipped past
  // isSerializable at the call site), preserve the reference rather
  // than fail the commit.
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function isSerializable(value: unknown): boolean {
  // Primitive fast paths — these classes are JSON-safe by definition.
  if (value === null || value === undefined) return true
  const t = typeof value
  if (t === 'number' || t === 'string' || t === 'boolean') return true
  // Functions and symbols are never JSON-representable.
  if (t === 'function' || t === 'symbol') return false
  // Probe everything else with a JSON round-trip; cycles and BigInt fall here.
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

/**
 * Memoised equivalent of {@link isSerializable} keyed on a sibling
 * `Map<NodeId, boolean>` (the `inputSerializableMemo` map owned by
 * the `createCausl` closure). First call probes via `isSerializable`
 * and stores the verdict; every subsequent call until the next
 * `tx.set` write reuses the cached `true`/`false` and skips the
 * `JSON.stringify` round-trip entirely.
 *
 * @remarks
 * #703 Win 1 — Phase F.6 (and the `snapshot` / `exportModel` paths)
 * call `isSerializable` on every changed input every commit. For an
 * input whose value is a stable structured object (the canonical
 * scrolling-viewport workload reuses the same row record across
 * commits, swapping only a couple of fields), the round-trip cost is
 * paid every commit even though the verdict cannot have changed. The
 * single-tier cache collapses the repeat cost to a property read.
 *
 * Soundness: the cache is invalidated (Map.delete) exactly when
 * {@link InputEntry.value} is mutated — i.e. at the publish step of
 * {@link createCausl | commit} (Phases B + the failure-path rollback)
 * and the same place in `simulate`. Callers who mutate the cell
 * outside the engine (via a captured `unknown` reference) violate the
 * pre-existing soundness contract; the cache only assumes what the
 * engine already does.
 *
 * #915 — moved off `InputEntry.serializableMemo` (the slot was
 * removed) into a sibling map so the per-input allocation paid by
 * `g.input(name, value)` shrinks by one property write. The cache
 * key is the entry id; the map stays empty for inputs that never
 * serialize, which is the steady state for the
 * `op-input-create-1k` microbench and any adopter who never opts
 * into `commitHistoryCap > 0` / `exportModel` / `snapshot`.
 */
function isInputValueSerializable(
  e: InputEntry,
  memoMap: Map<NodeId, boolean>,
): boolean {
  const memo = memoMap.get(e.id)
  if (memo !== undefined) return memo
  const verdict = isSerializable(e.value)
  memoMap.set(e.id, verdict)
  return verdict
}

/**
 * Serialiser used by {@link exportModel}: returns the value unchanged when it
 * is JSON-safe, and `null` otherwise. Pairs with the `serializable` flag on
 * each IR node so consumers can distinguish "value was null" from "value was
 * elided because it was non-serialisable."
 *
 * @param value - The value to serialise.
 * @returns Either the original value or `null` for non-serialisable inputs.
 */
function serialiseSafely(value: unknown): unknown {
  if (isSerializable(value)) return value
  return null
}

/**
 * Re-export of the engine's structured error base class so consumers can
 * branch on `instanceof CauslError` without importing from `./errors.js`
 * directly.
 *
 * @see ./errors.js — the full error hierarchy.
 */
export { CauslError }
