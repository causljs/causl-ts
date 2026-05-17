/**
 * @packageDocumentation
 *
 * `BackendEngine` — the narrow TS-side abstraction over the storage,
 * commit pipeline, and read path that any Causl engine implementation
 * must satisfy. The current TypeScript engine ({@link createCausl} in
 * `./graph.js`) supplies one implementation through the {@link JsBackend}
 * adapter declared at the bottom of this file; a future WASM-backed
 * engine (EPIC #680) will plug in a second implementation against the
 * same interface.
 *
 * @remarks
 * The contract every backend must satisfy:
 *
 * - **Pure functions of (state, action).** Each method is a deterministic
 *   transformation of engine state. There is no implicit clock, no
 *   ambient I/O, and no observer-visible state outside the method's
 *   return value and the registered subscriber callbacks.
 * - **Determinism.** Given the same construction options and the same
 *   ordered sequence of `commit` calls, two backends produce
 *   byte-identical commit logs. The cross-backend determinism gate
 *   (#685, post this PR) checks this property as a CI-blocking fuzz.
 * - **Phase-isolated commit pipeline.** A `commit` call atomically
 *   advances time by exactly one tick, recomputes affected derivations,
 *   publishes the resulting {@link Commit}, and fires subscribers. There
 *   is no fractional time and no nested-commit story.
 * - **Snapshot-able state.** {@link BackendEngine.snapshot} captures a
 *   serialisable view of the engine's input set; {@link BackendEngine.hydrate}
 *   restores it through the same commit pipeline. The wire format is the
 *   {@link GraphSnapshot} `schema: 1` envelope; future migrations bump
 *   the schema number and gate compatibility on it.
 * - **No behaviour change at the seam.** Adopters interact with the
 *   higher-level {@link Graph} surface from `./graph.js`; the BackendEngine
 *   is the lower-level primitive the Graph delegates to. Swapping the JS
 *   backend for the WASM backend is intended to be observably transparent
 *   except for the performance characteristics (and the explicit `backend:
 *   'wasm'` opt-in once #686 lands).
 *
 * Scope of this file (PR #681): only the interface declaration and the
 * thin {@link JsBackend} adapter that wires {@link createCausl}'s closure
 * into the seam. The TS engine's implementation logic stays in `./graph.ts`
 * for now; later sub-tasks of EPIC #680 may move concrete state into
 * {@link JsBackend} without changing the public surface.
 */

import type {
  Commit,
  GraphSnapshot,
  GraphTime,
  Node,
  NodeId,
  Observer,
  RetentionResult,
  Unsubscribe,
} from './types.js'
import type { CauslModel } from './ir.js'

/**
 * Stand-in for "any JSON-serialisable value the engine carries through
 * its input map." The TS engine accepts arbitrary JS values (the
 * `serialiseSafely` helper in `./graph.ts` filters at the snapshot
 * boundary, not at the storage boundary). The WASM backend will tighten
 * this to a Rust-side tagged union; for the TS implementation `unknown`
 * matches the engine's storage type without imposing a runtime check.
 */
export type Json = unknown

/**
 * Serialised state envelope produced by {@link BackendEngine.snapshot}
 * and consumed by {@link BackendEngine.hydrate}. Aliased to the public
 * {@link GraphSnapshot} so the wire format is shared with adopter-facing
 * SSR / persistence flows.
 */
export type SerializedState = GraphSnapshot

/**
 * Disposer returned by the subscribe surfaces. Aliased to the public
 * {@link Unsubscribe} so the seam shares one disposable shape with the
 * Graph surface.
 */
export type Disposable = Unsubscribe

/**
 * Per-commit observer callback shape — one notification per published
 * commit, no log read. Mirrors the public {@link Graph.subscribeCommits}
 * contract.
 */
export type CommitObserver = (commit: Commit) => void

// ---------------------------------------------------------------------------
// Statechart-reducer extension point (#1068 — deferred from #698 / PR #1056)
// ---------------------------------------------------------------------------

/**
 * Structural description of a forbidden statechart transition.
 *
 * @remarks
 * Mirrors the `ForbiddenTransition` interface from
 * `@causl/sync/src/statechart-reducers.ts` exactly so the seam's
 * input/output types are structurally interchangeable with the TS
 * reducers' public shape. The tuple `(region, from, to, id)` is
 * enough for a wiring shell to construct a public typed error and
 * enough for a future Rust port (issue #1068's `engine-rs-core`
 * `statechart_reducers` enums, gated behind `feature = "future"`)
 * to map the rejection onto its own enum without rewriting the
 * decision logic.
 *
 * Kept structural (not a class, not a thrown value) so the reducer
 * stays a pure function. The shell decides whether to throw; the
 * reducer decides whether the chart permitted the edge.
 *
 * @see issue #698 — extract pure statechart reducers.
 * @see issue #1068 — Rust enums + this `BackendEngine.evaluateStatechart`
 *   extension point.
 * @see packages/sync/src/statechart-reducers.ts — TS reducer source of
 *   truth.
 */
export interface ForbiddenStatechartTransition {
  /** Which orthogonal region the rejection comes from. */
  readonly region: 'resource' | 'conflict'
  /**
   * Source state tag as the chart names it. For the conflict region
   * this includes the synthetic `'unknown'` tag (the registry has
   * never observed the id); the chart itself has no `Unknown` state.
   */
  readonly from: string
  /** Target state tag the rejected event would have moved to. */
  readonly to: string
  /** The node id the event targeted. */
  readonly id: NodeId
}

/**
 * Discriminated result returned by {@link BackendEngine.evaluateStatechart}.
 *
 * @remarks
 * Mirrors the TS reducers' `TransitionResult<S>` DU. The `ok` arm
 * carries the next state structurally (typed as `unknown` here
 * because the BackendEngine seam is region-agnostic; callers narrow
 * by region tag on `input`); the `forbidden` arm carries enough
 * metadata for the wiring shell to construct the appropriate typed
 * error. The method never throws — exception-based control flow
 * does not translate cleanly to a future Rust port where the
 * natural shape is `Result<State, ForbiddenTransition>`.
 */
export type StatechartResult =
  | { readonly kind: 'ok'; readonly next: unknown }
  | { readonly kind: 'forbidden'; readonly reason: ForbiddenStatechartTransition }

/**
 * Region-tagged input envelope for {@link BackendEngine.evaluateStatechart}.
 *
 * @remarks
 * Each variant pins the region's `(state, event, time, id)` quadruple
 * structurally. The state and event slots are typed as `unknown` here
 * because:
 *
 *   1. The canonical typed shapes for the regions
 *      (`ConflictReducerState` / `ConflictEvent` / `ResourceReducerState`
 *      / `ResourceEvent`) live in `@causl/sync`, not `@causl/core` —
 *      the BackendEngine seam cannot import them without inverting the
 *      package dependency direction (`sync → core`, not the reverse).
 *   2. Callers on the `@causl/sync` side already hold typed values
 *      and narrow `next` from the result. The structural `unknown`
 *      is a width-typing concession at the seam, not a type-erasure
 *      at the call site.
 *
 * The wire shape — `{ region: 'resource' | 'conflict', state, event,
 * time, id }` — is the same the cross-backend determinism gate
 * (#685) will JSON-roundtrip when comparing the JS and WASM
 * backends' outputs for byte-equality.
 */
export type StatechartInput =
  | {
      readonly region: 'conflict'
      readonly state: unknown
      readonly event: unknown
      readonly time: GraphTime
      readonly id: NodeId
    }
  | {
      readonly region: 'resource'
      readonly state: unknown
      readonly event: unknown
      readonly time: GraphTime
      readonly id: NodeId
    }

/**
 * The narrow TS-side abstraction over the engine's storage, commit
 * pipeline, and read path. Implementations:
 *
 * - {@link JsBackend} — thin wrapper around the {@link createCausl}
 *   closure in `./graph.js`. Ships in this PR.
 * - `WasmBackend` (future) — Rust-compiled-to-WASM implementation,
 *   pluggable JS↔WASM bridge, gated on {@link createCausl}'s `backend`
 *   option (EPIC #680).
 *
 * The interface intentionally omits the higher-level affordances
 * (`input`, `derived`, `simulate`, `explain`, `subscribeMany`,
 * `subscribeReads`, `dependencies`, `dependents`, `stats`,
 * `commitMetadataDerived`) that live on {@link Graph}. Those compose on
 * top of the BackendEngine surface and stay in the JS-side `Graph`
 * facade across both backends.
 */
export interface BackendEngine {
  /**
   * Apply a precomputed map of input writes atomically.
   *
   * @param intent - Caller-supplied label retained on the {@link Commit}
   *   record and the commit log.
   * @param writes - Map of input id → new value. Every id MUST refer to
   *   a previously-registered input on this backend; the implementation
   *   throws the same typed errors a `tx.set` would (`UnknownNodeError`,
   *   `NotAnInputNodeError`, `NodeDisposedError`).
   * @returns The published {@link Commit} record.
   *
   * @remarks
   * This is the desugared form of the higher-level
   * `Graph.commit(intent, run)` callback shape. The Graph facade collects
   * `tx.set` calls into a writes map and calls through to this method;
   * the WASM backend, which cannot host JS callbacks across the FFI
   * boundary, will receive the precomputed map directly.
   */
  commit(intent: string, writes: ReadonlyMap<NodeId, Json>): Commit

  /**
   * Read a node's current committed value. Same contract as
   * {@link Graph.read}.
   */
  read<T>(node: Node<T>): T

  /**
   * Subscribe to per-node value changes. Same contract as
   * {@link Graph.subscribe}'s minimal arity (no options, no multi-node
   * group, no read-tracking projection — those compose on top in the
   * Graph facade).
   */
  subscribe<T>(node: Node<T>, observer: Observer<T>): Disposable

  /**
   * Subscribe to every published commit. Same contract as
   * {@link Graph.subscribeCommits}.
   */
  subscribeCommits(observer: CommitObserver): Disposable

  /**
   * Capture a serialisable snapshot of the engine's input set. Same
   * contract as {@link Graph.snapshot}.
   */
  snapshot(): SerializedState

  /**
   * Bulk-apply a {@link SerializedState} through the commit pipeline.
   * Same contract as {@link Graph.hydrate}.
   */
  hydrate(s: SerializedState): void

  /**
   * Export a {@link CauslModel} IR snapshot — the bridge to
   * `causl-check`. Same contract as {@link Graph.exportModel} with no
   * options.
   */
  exportModel(): CauslModel

  /**
   * Read a node's value at a past committed time. Same contract as
   * {@link Graph.readAt}; gated on `commitHistoryCap > 0`.
   */
  readAt<T>(node: Node<T>, time: GraphTime): RetentionResult<T>

  /**
   * Project a whole-graph snapshot at a past committed time. Same
   * contract as {@link Graph.snapshotAt}; gated on `commitHistoryCap > 0`.
   */
  snapshotAt(time: GraphTime): RetentionResult<GraphSnapshot>

  /**
   * Adapter-layer disposal hook. Same contract as the dispose surface
   * exposed through `@causl/core/internal`. Lives on the BackendEngine
   * because both backends (JS and WASM) own the underlying registry and
   * neither can satisfy disposal through the public Graph surface alone.
   */
  dispose(node: Node<unknown>): void

  /**
   * Evaluate one transition of a SPEC §6 composite-statechart sub-region
   * (`'conflict'` or `'resource'`). Pure function — no graph reads, no
   * commits, no closure-captured engine state, no clock access beyond the
   * `time` field on `input`. Issue #1068's extension point, deferred from
   * #698 / PR #1056.
   *
   * @remarks
   * The seam exists so the WASM backend can route SPEC §6 reducer
   * evaluation through its Rust-side `engine-rs-core::statechart_reducers`
   * enums (gated behind `feature = "future"`; landed structurally by
   * #1068, wired by Sub-D of EPIC #680). Callers in `@causl/sync`'s
   * `applyEvent` shells route through this method instead of calling
   * `reduceConflict` / `reduceResource` directly, so the cross-backend
   * determinism gate (#685) verifies the two implementations produce
   * byte-identical results.
   *
   * The structural `unknown` typing on `input.state` / `input.event` /
   * the result's `next` is the seam's width-typing concession: the
   * canonical region-typed shapes (`ConflictReducerState`,
   * `ConflictEvent`, `ResourceReducerState<T>`, `ResourceEvent`) live
   * in `@causl/sync` and the BackendEngine seam in `@causl/core`
   * cannot import them without inverting the package dependency
   * direction. Adopters on the `@causl/sync` side hold typed values
   * and narrow `next` from the result.
   *
   * ## Determinism
   *
   * Same `(region, state, event, time, id)` always returns a
   * structurally-equal result. This is the byte-identity property
   * #698 names for the future Rust port — same contract as
   * `transition_phased`.
   *
   * @param input - Region-tagged envelope carrying the reducer
   *   inputs `(state, event, time, id)`.
   * @returns A {@link StatechartResult} discriminated union — `ok`
   *   with the next state on the success path, or `forbidden` with
   *   `(region, from, to, id)` metadata when the chart rejects the
   *   transition.
   *
   * @see issue #698 — extract pure statechart reducers.
   * @see issue #1068 — this extension point + Rust enums.
   * @see PR #1056 — TS reducer carve-out
   *   (`packages/sync/src/statechart-reducers.ts`).
   */
  evaluateStatechart(input: StatechartInput): StatechartResult

  /**
   * Current committed time. A getter, not a method, so external observers
   * can ask "what time is it?" without firing a commit.
   */
  readonly now: GraphTime
}

/**
 * Bag of engine-internal closures handed in by {@link createCausl} to
 * construct a {@link JsBackend}. The fields mirror the
 * {@link BackendEngine} method shapes one-to-one. Kept package-private:
 * the only construction site is `graph.ts`.
 *
 * @internal
 */
export interface JsBackendOps {
  readonly commit: (intent: string, writes: ReadonlyMap<NodeId, Json>) => Commit
  readonly read: <T>(node: Node<T>) => T
  readonly subscribe: <T>(node: Node<T>, observer: Observer<T>) => Unsubscribe
  readonly subscribeCommits: (observer: CommitObserver) => Unsubscribe
  readonly snapshot: () => GraphSnapshot
  readonly hydrate: (snap: GraphSnapshot) => void
  readonly exportModel: () => CauslModel
  readonly readAt: <T>(node: Node<T>, time: GraphTime) => RetentionResult<T>
  readonly snapshotAt: (time: GraphTime) => RetentionResult<GraphSnapshot>
  readonly dispose: (node: Node<unknown>) => void
  readonly evaluateStatechart: (input: StatechartInput) => StatechartResult
  readonly now: () => GraphTime
}

/**
 * Reference TS-side implementation of {@link BackendEngine}. Wraps the
 * closure-private engine surface produced by {@link createCausl}; every
 * method delegates to the corresponding closure helper.
 *
 * @remarks
 * The seam is the public-shape commitment, not the implementation
 * topology. For PR #681 the engine state and helpers stay inside the
 * `createCausl` closure; this class is a thin projection so the Graph
 * facade in `./graph.ts` can route its BackendEngine-listed methods
 * through the seam. Subsequent EPIC #680 sub-tasks may pull engine
 * state into the class without affecting the public surface.
 *
 * The class also documents — by being the simplest possible
 * BackendEngine implementation — what a future WASM-side adapter must
 * supply: the twelve {@link JsBackendOps} fields and nothing else
 * (the twelfth, `evaluateStatechart`, landed with issue #1068 as the
 * SPEC §6 composite-statechart extension point deferred from #698).
 */
export class JsBackend implements BackendEngine {
  readonly #ops: JsBackendOps

  constructor(ops: JsBackendOps) {
    this.#ops = ops
  }

  commit(intent: string, writes: ReadonlyMap<NodeId, Json>): Commit {
    return this.#ops.commit(intent, writes)
  }

  read<T>(node: Node<T>): T {
    return this.#ops.read(node)
  }

  subscribe<T>(node: Node<T>, observer: Observer<T>): Disposable {
    return this.#ops.subscribe(node, observer)
  }

  subscribeCommits(observer: CommitObserver): Disposable {
    return this.#ops.subscribeCommits(observer)
  }

  snapshot(): SerializedState {
    return this.#ops.snapshot()
  }

  hydrate(s: SerializedState): void {
    this.#ops.hydrate(s)
  }

  exportModel(): CauslModel {
    return this.#ops.exportModel()
  }

  readAt<T>(node: Node<T>, time: GraphTime): RetentionResult<T> {
    return this.#ops.readAt(node, time)
  }

  snapshotAt(time: GraphTime): RetentionResult<GraphSnapshot> {
    return this.#ops.snapshotAt(time)
  }

  dispose(node: Node<unknown>): void {
    this.#ops.dispose(node)
  }

  evaluateStatechart(input: StatechartInput): StatechartResult {
    return this.#ops.evaluateStatechart(input)
  }

  get now(): GraphTime {
    return this.#ops.now()
  }
}
