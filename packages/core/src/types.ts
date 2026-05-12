/**
 * @packageDocumentation
 *
 * Public type vocabulary for `@causl/core`. Defines the branded
 * node descriptors, the commit/transaction shapes, and the
 * {@link Graph} interface that realises the canonical seven-method
 * primitive surface (`createCausl`, `input`, `derived`, `commit`,
 * `read`, `subscribe`, `explain`) plus the second-tier extensions
 * (`subscribeCommits`, `commitLog`, `exportModel`, `snapshot`,
 * `hydrate`, `readAt`, `snapshotAt`, `simulate`, `dependencies`,
 * `dependents`, `now`).
 *
 * The vocabulary is anchored in the denotational equations:
 *   - GraphTime  := an ordered sequence of commit moments t₀ < t₁ < t₂ < …
 *   - Behavior a := GraphTime → a
 *   - Event   a  := [(GraphTime, a)]
 *
 * From those four lines every guarantee the engine claims becomes a
 * theorem rather than a hope: glitch-freedom is "a derived value at
 * time `t` is a pure function of its inputs at the same time `t`,"
 * determinism is "two implementations of `derived(t) = f(b₁(t), …,
 * bₙ(t))` either agree or one of them is wrong," and atomicity is
 * "a transaction creates exactly one new `t`." The interface in this
 * file is the smallest TypeScript projection of that algebra, with
 * every additional public symbol justified individually against the
 * discipline that "every additional public option is a teaching cost
 * paid by every future user."
 */

// `EngineTelemetry` is the cross-backend `Graph.stats()` snapshot
// shape; defined in `./telemetry.ts` per the #696 / #680 contract
// split. Imported here so the {@link Graph.stats} return-type
// annotation lower in this file resolves; re-exported at the bottom
// of the file (`export type { EngineTelemetry }`) so the public
// import-from-types-barrel pattern continues to work.
import type { EngineTelemetry } from './telemetry.js'

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
export type NodeId = string

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
export type GraphTime = number

// Internal brand symbol — gives Node<T> its phantom type parameter
// without leaking a runtime value into the public API.
const _NODE_BRAND_TAG: unique symbol = Symbol('@causl/core/Node')
/**
 * Internal phantom-tag type used to brand {@link Node} descriptors.
 *
 * @internal
 */
export type NodeBrandTag = typeof _NODE_BRAND_TAG

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
export interface InputNode<T> {
  /** Stable identifier. */
  readonly id: NodeId
  /**
   * Phantom brand carrying the value type AND the input/derived
   * polarity for type-system narrowing. Never present at runtime —
   * `_phantom` is `undefined` on every value the engine produces.
   * Polarity is encoded in the `tag` field type so the public
   * `Node<T>` union remains structural while still type-discriminable
   * at the call sites that need it (e.g. `Tx.set`).
   */
  readonly _phantom?: { readonly value: T; readonly tag: NodeBrandTag; readonly polarity: 'input' }
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
export interface DerivedNode<T> {
  /** Stable identifier. */
  readonly id: NodeId
  /**
   * Phantom brand carrying the value type and derived polarity.
   * Never present at runtime; the polarity is type-system-only and
   * is not observable on a constructed handle (the engine constructs
   * handles via `Object.freeze({ id })` with no `_phantom` field).
   */
  readonly _phantom?: { readonly value: T; readonly tag: NodeBrandTag; readonly polarity: 'derived' }
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
export type Node<T> = InputNode<T> | DerivedNode<T>

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
export type Compute<T> = (get: <U>(node: Node<U>) => U) => T

/**
 * Disposer returned by subscription methods on {@link Graph}.
 *
 * @remarks
 * Calling it detaches the observer; idempotent — repeated invocations
 * are harmless.
 */
export type Unsubscribe = () => void

/**
 * Per-node observer callback.
 *
 * @typeParam T - Value type of the observed node.
 * @param value - The node's value at `time`.
 * @param time - GraphTime at which the value was emitted.
 */
export type Observer<T> = (value: T, time: GraphTime) => void

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
export interface SubscribeOptions {
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
  readonly transient?: boolean
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
export type ValueMap<Ts extends readonly Node<unknown>[]> = {
  readonly [K in keyof Ts]: Ts[K] extends Node<infer V> ? V : never
}

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
export type SubscribeReadsObserver<T> = (commit: Commit, value: T) => void

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
export interface Commit {
  /** GraphTime assigned to this commit. */
  readonly time: GraphTime
  /** Caller-supplied label passed to `graph.commit(intent, …)`. */
  readonly intent: string
  /** Identifiers of nodes whose value changed during the commit. */
  readonly changedNodes: readonly NodeId[]
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
  readonly originatedAt: GraphTime | undefined
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
export interface Tx {
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
  set<T>(node: InputNode<T>, value: T): void
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
export type SimulateResult = SimulateResultClean | SimulateResultFailed

/**
 * Successful arm of {@link SimulateResult}: the simulated transaction
 * would have committed cleanly.
 */
export interface SimulateResultClean {
  /** Discriminator tag. */
  readonly status: 'clean'
  /**
   * The {@link Commit} record the simulated transaction *would* have
   * published. Its `time` is the GraphTime the commit *would* have
   * landed at — exactly `graph.now + 1` at simulate-time — but
   * {@link Graph.now} is unchanged after `simulate` returns.
   */
  readonly commit: Commit
  /**
   * Input node ids whose value the staged writes would have changed,
   * in iteration order over the user callback's `tx.set` calls. A
   * staged write that lands on the same value as the prior commit
   * (Object.is equality) is omitted, mirroring `commit`'s Phase B.
   */
  readonly stagedDiff: readonly NodeId[]
  /**
   * Transitively-affected derived ids whose recomputed value would
   * have differed from the prior. In topological order over the
   * affected sub-graph, mirroring `commit`'s Phase D.
   */
  readonly derivedDiff: readonly NodeId[]
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
export interface SimulateResultFailed {
  /** Discriminator tag. */
  readonly status: 'failed'
  /**
   * The error that would have escaped `commit`. Typed `CauslError`
   * subclasses are surfaced as-is so callers can `instanceof` against
   * the canonical taxonomy; non-engine throws from inside the user
   * callback flow through unchanged.
   */
  readonly error: unknown
  /**
   * Input node ids whose value the staged writes had changed before
   * the throw — useful as a debugging breadcrumb naming the partial
   * write set that closed (for example) a derivation cycle.
   */
  readonly stagedDiff: readonly NodeId[]
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
export type Explanation =
  | InputExplanation
  | DerivedExplanation
  | LiveExplanation
  | CycleExplanation

/** Frame for one direct dependency, with the dep's own recursive lineage. */
export interface DepFrame {
  /** The dep node's id. */
  readonly node: NodeId
  /** GraphTime at which the dep last produced its current value. */
  readonly contributedAt: GraphTime
  /** Recursive lineage rooted at the dep. */
  readonly explanation: Explanation
}

/** Common fields on the value-bearing variants of {@link Explanation}. */
interface ExplanationCommon {
  /** Node whose lineage is being described. */
  readonly node: NodeId
  /** Current value of the node at {@link computedAt}. */
  readonly value: unknown
  /** GraphTime at which {@link value} was last produced. */
  readonly computedAt: GraphTime
  /** Direct dependencies, each with its own recursive lineage. */
  readonly deps: readonly DepFrame[]
}

/** Lineage of an `input` node — always a leaf with `deps: []`. */
export interface InputExplanation extends ExplanationCommon {
  readonly via: 'input'
  readonly deps: readonly []
}

/** Lineage of a vanilla `derived` node. */
export interface DerivedExplanation extends ExplanationCommon {
  readonly via: 'derived'
}

/**
 * Lineage of a `liveDerived` node — a derived registered through the
 * devtools hot-swap primitive. Same shape as {@link DerivedExplanation}
 * but tagged so a UI can render the "edit-live" affordance, which is
 * the engine's commitment that one can edit a derivation while it's
 * running and watch the change propagate.
 */
export interface LiveExplanation extends ExplanationCommon {
  readonly via: 'live'
}

/**
 * Cycle marker — emitted instead of recursing when explain re-enters
 * a node already on the traversal stack. The engine's structural
 * registration guard rejects cycles, so this is a defensive frame
 * that keeps the walker total under any future relaxation.
 */
export interface CycleExplanation {
  readonly via: 'cycle'
  readonly node: NodeId
  /** The ancestor node id whose subtree this frame would re-enter. */
  readonly cycleBackTo: NodeId
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
export interface ExportModelOptions {
  /** Cap on number of commits included; defaults to 100. */
  readonly maxCommits?: number
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
  readonly captureCallGraph?: boolean
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
export interface ObserverErrorContext {
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
  readonly source:
    | 'node-subscriber'
    | 'commit-subscriber'
    | 'subscribe-initial'
    | 'subscribe-reads-initial'
    | 'subscribe-reads'
    | 'subscribe-reads-projection'
  /** Node id when source is `node-subscriber` or `subscribe-initial`. */
  readonly nodeId?: NodeId
  /** GraphTime at which the observer was invoked. */
  readonly time: GraphTime
}

/**
 * Hook fired when a subscriber throws during observer dispatch.
 *
 * @param error - The thrown value, surfaced as `unknown` per
 *   TypeScript's catch-clause typing.
 * @param context - Attribution metadata for the failed dispatch.
 */
export type ObserverErrorHandler = (
  error: unknown,
  context: ObserverErrorContext,
) => void

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
export type RetentionResult<T> =
  | { readonly status: 'retained'; readonly value: T; readonly time: GraphTime }
  | { readonly status: 'evicted'; readonly oldestRetainedTime: GraphTime }

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
export interface CreateCauslOptions {
  /** Bound on internally-retained commit log; default 1000. */
  readonly commitHistoryCap?: number
  /**
   * Bound on retained per-commit snapshots used by `readAt(t)` and
   * the DevTools bridge. Default 50. Long-lived processes that don't
   * need history pass `commitHistoryCap: 0` (or `1`) at construction
   * — the bound is the engine's memory-hygiene knob.
   */
  readonly snapshotRetentionCap?: number
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
  readonly disposedTombstoneCap?: number
  /**
   * Hook fired when an observer (per-node or per-commit) throws.
   * Defaults to `console.error`. Pass a no-op to silence.
   */
  readonly onObserverError?: ObserverErrorHandler
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
  readonly strictCycles?: boolean
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
  readonly name?: string
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
  readonly experimentalFlags?: Partial<CauslFlags>

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
  readonly backend?: 'js' | 'auto'

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
  readonly adaptThresholds?: Partial<import('./auto-adapt.js').AdaptThresholds>

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
  readonly enableH1HazardWarning?: boolean
}

// Re-export the flag interface so consumers can pull `CauslFlags`
// out of the public `./types.js` barrel (and through `./index.js`)
// without a separate path import. Definition lives in `./flags.ts`.
import type { CauslFlags } from './flags.js'
export type { CauslFlags }

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
export interface Graph {
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
  input<T>(id: NodeId, initial: T): InputNode<T>

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
  derived<T>(
    id: NodeId,
    compute: Compute<T>,
    options?: { readonly tag?: 'live' | 'commit-metadata' },
  ): DerivedNode<T>

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
  commitMetadataDerived<T>(id: NodeId, compute: Compute<T>): DerivedNode<T>

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
  commit(intent: string, run: (tx: Tx) => void): Commit

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
  simulate(intent: string, run: (tx: Tx) => void): SimulateResult

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
  read<T>(node: Node<T>): T

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
  subscribe<T>(
    node: Node<T>,
    observer: Observer<T>,
    options?: SubscribeOptions,
  ): Unsubscribe

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
  subscribeMany<Ts extends readonly Node<unknown>[]>(
    nodes: Ts,
    observer: (values: ValueMap<Ts>) => void,
    options?: SubscribeOptions,
  ): Unsubscribe

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
  subscribeCommits(observer: (commit: Commit) => void): Unsubscribe

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
  subscribeReads<T>(
    observer: SubscribeReadsObserver<T>,
    projection: () => T,
  ): Unsubscribe

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
  explain<T>(node: Node<T>): DerivedNode<Explanation>

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
  dependencies<T>(node: Node<T>): readonly NodeId[]

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
  dependents<T>(node: Node<T>): readonly NodeId[]

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
  exportModel(options?: ExportModelOptions): import('./ir.js').CauslModel

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
  snapshot(): GraphSnapshot

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
  hydrate(snap: GraphSnapshot): void

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
  readAt<T>(node: Node<T>, t: GraphTime): RetentionResult<T>

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
  snapshotAt(t: GraphTime): RetentionResult<GraphSnapshot>

  /** Current committed time. A getter, not a method — the
   * denotational vocabulary needs an external observer to ask "what
   * time is it?" without firing a commit. */
  readonly now: GraphTime

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
  readonly commitLog: DerivedNode<readonly Commit[]>

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
  stats(): EngineTelemetry
}

// `EngineTelemetry` — the cross-backend `Graph.stats()` snapshot shape —
// is defined in `./telemetry.ts` (the dedicated cross-backend contract
// module flagged by the #680 WASM epic and #696). Re-exported here so
// the public type-vocabulary import in `./index.ts` continues to source
// it from this barrel without churn for adopters; the in-file
// `import type` line above (added at the top of the import block) puts
// the symbol in scope for the {@link Graph.stats} return-type
// annotation.
export type { EngineTelemetry } from './telemetry.js'

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
export interface GraphSnapshot {
  /** Wire-format schema version; pinned at `1` for the current epic. */
  readonly schema: 1
  /** GraphTime at which the snapshot was captured. */
  readonly time: GraphTime
  /** Map of input id → JSON-serialisable value. */
  readonly inputs: Readonly<Record<NodeId, unknown>>
  /**
   * Deterministic digest over the registered node id-set at capture
   * time. Optional on the wire so hand-authored snapshots and
   * pre-hash test fixtures stay valid; when present, validated by
   * {@link Graph.hydrate}.
   */
  readonly schemaHash?: string
}
