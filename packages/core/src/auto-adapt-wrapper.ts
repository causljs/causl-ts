/**
 * @packageDocumentation
 *
 * Auto-adapt wrapper for `createCausl({ backend: 'auto' })` (#1072).
 *
 * @remarks
 * Wires the pure {@link shouldMigrate} predicate from `./auto-adapt.ts`
 * (the #686 / #1038 decision skeleton) and the `commitTimings`
 * surface from #1048 / PR #1054 into the runtime engine factory. The
 * wrapper is the load-bearing integration between three previously-
 * decoupled pieces:
 *
 *   1. The pure decision function — `shouldMigrate(stats, thresholds,
 *      history, commitTimings)` in `./auto-adapt.ts`.
 *   2. The `BackendEngine` seam (#681 / #1028) so a Phase-1 WASM-
 *      backend (`@causljs/core/wasm`'s {@link loadWasmBackend}) can be
 *      swapped in at runtime once the heuristic trips.
 *   3. The internal-API migration hydrate `_migrateFrom` (#1090)
 *      which bypasses the synthetic `'hydrate'` commit record so the
 *      JS → WASM migration boundary stays byte-identical to the
 *      (N+M)-commit pure-TS baseline the determinism gate (#685)
 *      uses.
 *
 * Behavioural contract:
 *
 * - **One-way migration.** Once `inner` points at a WASM-wrapped Graph
 *   the wrapper stops checking — a transient spike cannot ping-pong
 *   the engine selection.
 * - **Async load, sync swap.** `loadWasmBackend()` is async; the
 *   wrapper kicks off the load inside `commit()` when `shouldMigrate`
 *   first returns `true`, but the actual swap happens *inside the
 *   next commit boundary after the load resolves*. New commits that
 *   land between trigger and swap continue to flow through the JS
 *   engine — there is no torn-state window where some commits land on
 *   one engine and some on the other.
 * - **Registration replay.** Inputs, deriveds, and
 *   commit-metadata-deriveds registered on the wrapper are recorded
 *   in a registration log; on swap, the log replays onto the fresh
 *   WASM-side Graph before `_migrateFrom` transfers the input values.
 *   Without replay, the WASM-side Graph would have no derived nodes
 *   and downstream `read` / `subscribe` calls would throw
 *   `UnknownNodeError`.
 * - **Subscription forwarding.** Live subscriptions (per-node
 *   `subscribe`, per-commit `subscribeCommits`) are tracked in a
 *   wrapper-side registry. On swap, each is disposed on the JS engine
 *   and re-subscribed on the WASM-side Graph. The initial fire from
 *   re-subscription is suppressed when the new value is `Object.is`-
 *   equal to the most recent value delivered, so the observer is not
 *   called twice with the same value across the migration boundary.
 *
 * Phase-1 scope (this PR):
 *
 * - `subscribeMany`, `subscribeReads`, and `explain`-derived
 *   subscriptions are NOT migrated and remain attached to the
 *   pre-migration JS engine. Adopters who use those surfaces on a
 *   graph that migrates re-register after the migration boundary
 *   if they need post-migration notifications. The Phase-1 WASM
 *   backend itself wraps a TS engine, so this is functional today
 *   — the limitation only matters once the WASM bridge ships a
 *   distinct engine.
 *
 * @see #1072 — this issue.
 * @see #686 / PR #1038 — the pure decision skeleton this wrapper
 *   integrates.
 * @see #1048 / PR #1054 — the `commitTimings` parameter Option B that
 *   threads through the wrapper's commit-shape capture.
 * @see #1065 — the Phase-1 `loadWasmBackend()` that returns a real
 *   `BackendEngine` (wrapped TS engine today; bridge-driven later).
 * @see #1090 — `_migrateFrom` (no synthetic 'hydrate' commit).
 */

import {
  mergeThresholds,
  shouldMigrate,
  MODULE_THRESHOLD_OVERRIDES,
  type AdaptThresholds,
  type GraphStats as AutoAdaptGraphStats,
} from './auto-adapt.js'
import type {
  Commit,
  Compute,
  CreateCauslOptions,
  DerivedNode,
  EngineTelemetry,
  ExportModelOptions,
  Graph,
  GraphSnapshot,
  GraphTime,
  InputNode,
  Node,
  NodeId,
  Observer,
  RetentionResult,
  SubscribeOptions,
  Tx,
  Unsubscribe,
} from './types.js'
/**
 * Public marker on a wrapper's `stats()` snapshot reporting the
 * commits-until-payback counter. Defined here instead of in
 * `./telemetry.ts` because the field is wrapper-specific and is
 * `undefined` on the canonical TS engine and on the synchronous
 * Phase-1 WASM backend (both of which do not migrate).
 *
 * @remarks
 * The numeric value is the `commitCount` activity-gate threshold
 * captured at migration time; subsequent successful commits decrement
 * it by 1 down to (but not below) 0. The "payback" telemetry event
 * (issue body item 4) is observable as the transition from `1 → 0`
 * on this counter.
 *
 * @internal — exported so the wrapper file can re-attach the field
 * onto the underlying engine's `EngineTelemetry` record without
 * duplicating the field name string.
 */
const MIGRATION_PAYBACK_FIELD = 'migrationPaybackCommits' as const

/**
 * Cap on the bounded history-of-stats ring the wrapper retains for
 * the hysteresis gate and the EWMA gate inside {@link shouldMigrate}.
 *
 * @remarks
 * The predicate inspects only the tail (the last
 * `HYSTERESIS_TRIP_COUNT - 1` entries plus the full sequence for
 * EWMA) — neither path needs more than ~100 entries to be load-
 * bearing. Capping at 128 keeps the wrapper's per-commit cost O(1)
 * (no growth-unbounded array) while leaving comfortable headroom
 * over the default `rollingCommitWindow` of 100.
 */
const STATS_HISTORY_CAP = 128

/**
 * Sentinel for "never observed" in the
 * {@link LiveNodeSubscription.lastValue} slot.
 *
 * @remarks
 * A fresh `subscribe(...)` registration receives one initial fire
 * with the current value before any user-driven commit lands. We
 * record `lastValue` from that fire so the migration-boundary re-
 * subscription's initial fire can be suppressed when the value has
 * not changed across the boundary. The `UNSEEN` sentinel handles the
 * narrow window between registration and the first fire; in practice
 * it is only reachable if migration happens synchronously between
 * `subscribe()` returning and the engine's initial-fire path, which
 * the JS engine does not do (initial fire is synchronous inside
 * `subscribe`).
 */
const UNSEEN: unique symbol = Symbol('@causljs/core/auto-adapt-wrapper/unseen')

/**
 * Live `subscribe(node, observer)` registration tracked by the
 * wrapper for migration-boundary forwarding.
 *
 * @internal
 */
interface LiveNodeSubscription {
  readonly node: Node<unknown>
  readonly userObserver: Observer<unknown>
  readonly options: SubscribeOptions | undefined
  lastValue: unknown | typeof UNSEEN
  dispose: Unsubscribe
}

/**
 * Live `subscribeCommits(observer)` registration tracked by the
 * wrapper for migration-boundary forwarding.
 *
 * @internal
 */
interface LiveCommitSubscription {
  readonly userObserver: (commit: Commit) => void
  dispose: Unsubscribe
}

/**
 * Recorded registration step. Replayed on the WASM-side Graph at
 * migration time so the post-migration engine carries the same node
 * topology as the pre-migration engine.
 *
 * @internal
 */
type Registration =
  | {
      readonly kind: 'input'
      readonly id: NodeId
      readonly initial: unknown
    }
  | {
      readonly kind: 'derived'
      readonly id: NodeId
      readonly compute: Compute<unknown>
      readonly tag: 'live' | 'commit-metadata' | undefined
    }
  | {
      readonly kind: 'commitMetadataDerived'
      readonly id: NodeId
      readonly compute: Compute<unknown>
    }

/**
 * Construct an auto-adapt-wrapping `Graph` whose commit pipeline is
 * gated on the pure {@link shouldMigrate} predicate.
 *
 * @param baseFactory - The unwrapped TS-engine constructor. Captured
 *   as a parameter (not imported) so this module avoids a circular
 *   import with `./graph.ts` (which dispatches into this factory when
 *   `options.backend === 'auto'`).
 * @param options - The full {@link CreateCauslOptions} the user
 *   supplied to `createCausl`. `backend` is stripped before forwarding
 *   to the underlying constructor to avoid recursion.
 * @returns A `Graph` whose commit boundary may (asynchronously)
 *   trigger a one-way migration to the WASM backend.
 *
 * @internal — adopters call `createCausl({ backend: 'auto' })`; this
 * factory is the dispatch target.
 */
export function createAutoAdaptGraph(
  baseFactory: (options: CreateCauslOptions) => Graph,
  options: CreateCauslOptions,
): Graph {
  // Resolve thresholds at construction: defaults ← env overrides ←
  // per-engine overrides. Frozen for the wrapper's lifetime so the
  // hot-path call site never re-reads `process.env`.
  const thresholds: AdaptThresholds = mergeThresholds({
    ...MODULE_THRESHOLD_OVERRIDES,
    ...options.adaptThresholds,
  })
  // Forward every option EXCEPT `backend` (we would recurse) and
  // `adaptThresholds` (wrapper-local, not consumed by the underlying
  // TS engine).
  const { backend: _backend, adaptThresholds: _adaptThresholds, ...jsOptions } =
    options
  void _backend
  void _adaptThresholds

  // Initial inner engine — always the TS engine. The wrapper swaps
  // `inner` to a WASM-wrapped Graph on migration.
  let inner: Graph = baseFactory(jsOptions)
  let migrated = false
  let migrating = false
  // Resolved BackendEngine handle once `loadWasmBackend()` settles.
  // Typed `unknown` so the wrapper does not pull `@causljs/core/wasm`
  // into its static import graph (the dynamic import below keeps the
  // WASM entry point out of the main bundle).
  let wasmBackendReady: unknown = null
  // Commits-until-payback counter. `undefined` while pre-migration;
  // initialised to `thresholds.commitCount` at migration time per the
  // break-even math docstring on `EngineTelemetry.migrationPaybackCommits`.
  let migrationPaybackCommits: number | undefined = undefined

  // Rolling commit-wall-times window (oldest first, bounded to
  // `thresholds.rollingCommitWindow`). Threaded into `shouldMigrate`
  // as the `commitTimings` parameter per #1048 / Option B.
  const commitTimings: number[] = []
  // Bounded stats history for the hysteresis gate.
  const statsHistory: AutoAdaptGraphStats[] = []
  // Registration log replayed on the WASM-side Graph at migration.
  const registrationLog: Registration[] = []
  // Live subscription registries — re-subscribed across the
  // migration boundary.
  const liveNodeSubs = new Set<LiveNodeSubscription>()
  const liveCommitSubs = new Set<LiveCommitSubscription>()

  /**
   * Capture a wall-time-bounded `commit()` round-trip. The host's
   * `performance.now()` is used when available; the fallback to
   * `Date.now()` is for hosts without `performance` (older sandboxes
   * that ship neither browser nor Node's globals). Both return ms.
   */
  function nowMs(): number {
    const perf = (globalThis as { performance?: { now: () => number } }).performance
    if (perf && typeof perf.now === 'function') return perf.now()
    return Date.now()
  }

  /**
   * Snapshot the wrapper's view of engine stats from the underlying
   * `inner.stats()` record. The {@link AutoAdaptGraphStats} surface
   * is a strict subset of {@link EngineTelemetry}, so the projection
   * is a direct field copy — no recomputation, no allocation beyond
   * the freshly-returned literal.
   */
  function captureStats(inner: Graph): AutoAdaptGraphStats {
    const t = inner.stats()
    return {
      inputs: t.inputs,
      deriveds: t.deriveds,
      subscribersTotal: t.subscribersTotal,
      lastCommitTime: t.lastCommitTime,
    }
  }

  /**
   * Bound a ring buffer at `cap` entries via FIFO eviction. Cheaper
   * than re-allocating a fresh array on every commit — `Array.shift`
   * is O(n) but `n` is at most the cap (typically 100), and the
   * eviction only happens after the buffer is full.
   */
  function pushBounded<T>(buf: T[], value: T, cap: number): void {
    buf.push(value)
    while (buf.length > cap) buf.shift()
  }

  /**
   * Kick off the async WASM-backend load. Fire-and-forget — the next
   * `commit()` after the promise resolves performs the synchronous
   * swap. If the load fails (e.g. unsupported host), the wrapper
   * resets `migrating` so a subsequent commit's `shouldMigrate` can
   * retry; but to keep the migration one-way we do NOT reset
   * `migrated`, so a successful migration remains terminal.
   */
  function triggerMigration(): void {
    migrating = true
    // Dynamic import keeps `@causljs/core/wasm` out of the main bundle.
    // The import path is the subpath the consumer wires through their
    // bundler — bundlers that do not understand the dynamic-import
    // form will tree-shake it as unreachable, leaving adopters who
    // never set `backend: 'auto'` with a zero-byte cost from this
    // module.
    void (async () => {
      try {
        const wasmMod = (await import('../wasm/index.js')) as {
          readonly loadWasmBackend: (opts?: {
            readonly graphName?: string
            readonly batchedFlush?: {
              readonly afterN?: number
              readonly intervalMs?: number
            }
            readonly engine?: 'js-ssot' | 'rust-ssot'
          }) => Promise<unknown>
        }
        // Pass the user-supplied graph name through so the WASM-side
        // engine shares the same `graphId` — required for the migration
        // boundary determinism gate (#685) to compare byte-equal IR
        // across the JS → WASM transition. The TS engine mints a UUID
        // v4 when `options.name` is absent; we do NOT forward that
        // synthesised id because the WASM-side engine's IR `graphId`
        // would then be byte-different from a pure-TS baseline run that
        // also uses a synthesised id. Adopters who care about the
        // determinism gate must pass `createCausl({ name })` explicitly.
        //
        // C.4 (#1505) — forward the per-graph batchedFlush opt-in to
        // the WASM backend. Omitted ⇒ undefined ⇒ no queue ⇒
        // byte-identical to dev b15069fa (load-bearing C.4 property);
        // per-graph, not global (option-c doc §2.3).
        //
        // V2.1 (#1519) — forward the per-graph `engine` canonicality
        // opt-in (V2-DESIGN §2). Omitted ⇒ undefined ⇒ loadWasmBackend
        // resolves it to `'js-ssot'` ⇒ byte-identical to dev
        // `97da8420` (the load-bearing V2.1 acceptance property —
        // V2-DESIGN §2.2); per-graph, not global.
        const graphName = options.name
        const batchedFlush = options.batchedFlush
        const engine = options.engine
        wasmBackendReady = await wasmMod.loadWasmBackend({
          ...(graphName !== undefined ? { graphName } : {}),
          ...(batchedFlush !== undefined ? { batchedFlush } : {}),
          ...(engine !== undefined ? { engine } : {}),
        })
      } catch {
        // The wasm load failed (unsupported host, missing artifact,
        // etc). Reset `migrating` so subsequent commits can retry the
        // heuristic; the migration is best-effort and the wrapper
        // gracefully stays on the TS engine when WASM is unavailable.
        migrating = false
        wasmBackendReady = null
      }
    })()
  }

  /**
   * Re-attach a per-node subscription onto the post-migration Graph.
   * Suppresses the re-subscribe's initial fire when its value is
   * `Object.is`-equal to the value most recently delivered to the
   * user observer through the pre-migration engine — so the user
   * never sees a duplicate notification across the migration
   * boundary.
   */
  function rebindNodeSubscription(
    target: Graph,
    sub: LiveNodeSubscription,
  ): Unsubscribe {
    // The wrapping observer also keeps `sub.lastValue` in sync so
    // subsequent migrations (none, in Phase 1 — but the bookkeeping
    // is stable forward) see the latest delivered value.
    let firstFire = true
    const wrapped: Observer<unknown> = (value, time) => {
      if (firstFire) {
        firstFire = false
        if (sub.lastValue !== UNSEEN && Object.is(sub.lastValue, value)) {
          // Suppress the duplicate initial fire across the boundary.
          return
        }
      }
      sub.lastValue = value
      sub.userObserver(value, time)
    }
    return sub.options === undefined
      ? target.subscribe(sub.node, wrapped)
      : target.subscribe(sub.node, wrapped, sub.options)
  }

  /**
   * Perform the JS → WASM swap synchronously inside a commit
   * boundary. Pre-conditions: the WASM-side `BackendEngine` is loaded
   * (`wasmBackendReady !== null`) and we are not already migrated.
   */
  function performSwap(): void {
    // Defensive: a torn-state migration would silently lose state, so
    // re-check the invariants on the swap path even though the caller
    // already gated on them.
    if (migrated) return
    if (wasmBackendReady === null) return
    const wasmBackend = wasmBackendReady as {
      readonly __graph?: () => Graph
      readonly __migrateFrom?: (snap: GraphSnapshot) => void
    }
    const wasmGraphFn = wasmBackend.__graph
    const wasmMigrateFn = wasmBackend.__migrateFrom
    if (typeof wasmGraphFn !== 'function' || typeof wasmMigrateFn !== 'function') {
      // The loaded backend does not expose the Phase-1 helpers.
      // Stay on the TS engine and clear the migrating flag so the
      // heuristic can retry later.
      migrating = false
      return
    }
    const wasmGraph = wasmGraphFn.call(wasmBackend)
    // Replay registrations onto the fresh WASM-side Graph. Order
    // matters: the replay log records `input` / `derived` /
    // `commitMetadataDerived` in user-registration order, and a
    // derived's compute may reference inputs/deriveds registered
    // earlier. Following the original order preserves the
    // dependency-resolution shape; the engine's first-commit-time
    // Kahn pass catches any drift the SAME way the JS engine would.
    for (const reg of registrationLog) {
      switch (reg.kind) {
        case 'input':
          wasmGraph.input(reg.id, reg.initial)
          break
        case 'derived':
          wasmGraph.derived(
            reg.id,
            reg.compute as Compute<unknown>,
            reg.tag !== undefined ? { tag: reg.tag } : undefined,
          )
          break
        case 'commitMetadataDerived':
          wasmGraph.commitMetadataDerived(reg.id, reg.compute as Compute<unknown>)
          break
      }
    }
    // Migrate input state via the internal-API hydrate — no synthetic
    // 'hydrate' commit so the migration boundary stays byte-identical
    // to the (N+M)-commit pure-TS baseline that the #685 determinism
    // gate compares against.
    const snap = inner.snapshot()
    wasmMigrateFn.call(wasmBackend, snap)
    // Re-subscribe every live observer onto the WASM-side Graph.
    // Dispose the JS-side disposers first so the JS engine stops
    // delivering notifications, then re-attach the wrapping observer
    // that suppresses the duplicate initial fire.
    for (const sub of liveNodeSubs) {
      sub.dispose()
      sub.dispose = rebindNodeSubscription(wasmGraph, sub)
    }
    for (const cs of liveCommitSubs) {
      cs.dispose()
      cs.dispose = wasmGraph.subscribeCommits(cs.userObserver)
    }
    // Atomic swap. From this point forward every wrapper method
    // routes through the WASM-side Graph. The pre-migration JS
    // engine becomes orphaned and is eligible for GC once its
    // subscriber registry is empty (which the disposal loop above
    // emptied).
    inner = wasmGraph
    migrated = true
    migrating = false
    migrationPaybackCommits = thresholds.commitCount
  }

  /**
   * Wrapper-side `commit` shim. Captures wall-time, advances the
   * rolling buffers, calls `shouldMigrate(...)`, and (when the
   * heuristic trips and the wasm load has resolved) performs the
   * one-way swap.
   */
  function commitWrapped(intent: string, run: (tx: Tx) => void): Commit {
    const start = nowMs()
    const result = inner.commit(intent, run)
    const elapsed = nowMs() - start
    pushBounded(commitTimings, elapsed, thresholds.rollingCommitWindow)
    const stats = captureStats(inner)
    pushBounded(statsHistory, stats, STATS_HISTORY_CAP)
    // Post-migration: decrement payback counter (clamped to 0).
    if (migrationPaybackCommits !== undefined && migrationPaybackCommits > 0) {
      migrationPaybackCommits -= 1
    }
    // Pre-migration: evaluate the heuristic.
    if (!migrated) {
      if (migrating && wasmBackendReady !== null) {
        // The async load resolved between this commit and the last;
        // perform the swap synchronously now, against the just-
        // committed inner state.
        performSwap()
      } else if (!migrating) {
        // History passed to `shouldMigrate` is the prefix BEFORE the
        // current snapshot; `stats` is the most recent observation
        // and is supplied separately per the predicate's contract.
        const historyPrefix = statsHistory.slice(0, -1)
        if (shouldMigrate(stats, thresholds, historyPrefix, commitTimings)) {
          triggerMigration()
        }
      }
    }
    return result
  }

  /**
   * The wrapper Graph. Every method delegates to `inner`; the
   * BackendEngine-listed registration sites (`input`, `derived`,
   * `commitMetadataDerived`, `subscribe`, `subscribeCommits`) also
   * record into the wrapper-side replay log / subscription registry
   * so the migration boundary can rebuild the post-migration
   * topology.
   */
  const graph: Graph = {
    input<T>(id: NodeId, initial: T): InputNode<T> {
      const handle = inner.input(id, initial)
      registrationLog.push({ kind: 'input', id, initial })
      return handle
    },
    derived<T>(
      id: NodeId,
      compute: Compute<T>,
      opts?: { readonly tag?: 'live' | 'commit-metadata' },
    ): DerivedNode<T> {
      const handle = inner.derived<T>(id, compute, opts)
      registrationLog.push({
        kind: 'derived',
        id,
        compute: compute as Compute<unknown>,
        tag: opts?.tag,
      })
      return handle
    },
    commitMetadataDerived<T>(id: NodeId, compute: Compute<T>): DerivedNode<T> {
      const handle = inner.commitMetadataDerived<T>(id, compute)
      registrationLog.push({
        kind: 'commitMetadataDerived',
        id,
        compute: compute as Compute<unknown>,
      })
      return handle
    },
    commit: commitWrapped,
    simulate: (intent, run) => inner.simulate(intent, run),
    read: <T,>(node: Node<T>) => inner.read<T>(node),
    subscribe: <T,>(
      node: Node<T>,
      observer: Observer<T>,
      options?: SubscribeOptions,
    ) => {
      // Wrap the user observer in a value-tracking shim that
      // mirrors the post-migration `rebindNodeSubscription` shape.
      // The first subscribe-time fire sets `lastValue`; subsequent
      // fires update it; the migration-boundary re-subscribe
      // compares against it to suppress duplicate notifications.
      const sub: LiveNodeSubscription = {
        node: node as Node<unknown>,
        userObserver: observer as Observer<unknown>,
        options,
        lastValue: UNSEEN,
        // The disposer is replaced below once we have it.
        dispose: () => undefined,
      }
      const wrapped: Observer<unknown> = (value, time) => {
        sub.lastValue = value
        sub.userObserver(value, time)
      }
      sub.dispose =
        options === undefined
          ? inner.subscribe(node as Node<unknown>, wrapped)
          : inner.subscribe(node as Node<unknown>, wrapped, options)
      liveNodeSubs.add(sub)
      return () => {
        if (liveNodeSubs.has(sub)) {
          sub.dispose()
          liveNodeSubs.delete(sub)
        }
      }
    },
    subscribeMany: (nodes, observer, options) =>
      inner.subscribeMany(nodes, observer, options),
    subscribeCommits: (observer) => {
      const cs: LiveCommitSubscription = {
        userObserver: observer,
        dispose: () => undefined,
      }
      cs.dispose = inner.subscribeCommits(observer)
      liveCommitSubs.add(cs)
      return () => {
        if (liveCommitSubs.has(cs)) {
          cs.dispose()
          liveCommitSubs.delete(cs)
        }
      }
    },
    subscribeReads: (observer, projection) =>
      inner.subscribeReads(observer, projection),
    explain: <T,>(node: Node<T>) => inner.explain<T>(node),
    dependencies: (node) => inner.dependencies(node),
    dependents: (node) => inner.dependents(node),
    exportModel: (opts?: ExportModelOptions) =>
      opts === undefined ? inner.exportModel() : inner.exportModel(opts),
    snapshot: () => inner.snapshot(),
    snapshotAt: (time: GraphTime) => inner.snapshotAt(time),
    hydrate: (snap: GraphSnapshot) => inner.hydrate(snap),
    readAt: <T,>(node: Node<T>, time: GraphTime): RetentionResult<T> =>
      inner.readAt<T>(node, time),
    get now(): GraphTime {
      return inner.now
    },
    get commitLog(): DerivedNode<readonly Commit[]> {
      return inner.commitLog
    },
    stats: (): EngineTelemetry => {
      const inner_stats = inner.stats()
      if (migrationPaybackCommits === undefined) return inner_stats
      // Append the migration-payback field. Preserves the cross-
      // backend telemetry contract's append-only field-evolution
      // discipline (the underlying engine's record shape is
      // unchanged; the wrapper-only field is overlaid on top).
      return {
        ...inner_stats,
        [MIGRATION_PAYBACK_FIELD]: migrationPaybackCommits,
      }
    },
  }

  return graph
}
