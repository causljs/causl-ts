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

import type { GraphTime, Node } from './types.js'

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
export interface EngineTelemetry {
  /**
   * Count of user-registered input nodes — excludes the engine-owned
   * `commitLog` derived. Maintained as a running counter; bumps on
   * `graph.input(...)` and decrements on `dispose(graph, inputNode)`
   * via `@causl/core/internal`.
   */
  readonly inputs: number
  /**
   * Count of user-registered derived nodes — plain `derived(...)`,
   * `liveDerived(...)` (devtools), and `commitMetadataDerived(...)`.
   * Excludes the engine-owned `commitLog` derived (whose presence is
   * an engine-implementation detail; counting it would tear the
   * "user-registered nodes" semantics this counter advertises).
   */
  readonly deriveds: number
  /** Total count of live `subscribe(node, observer)` registrations. */
  readonly subscribersTotal: number
  /** Number of distinct nodes with at least one live subscriber. */
  readonly subscribersByNodeKeys: number
  /**
   * Count of live `subscribe(...)` / `subscribeMany(...)` registrations
   * with `options.transient === true` (#766 transient auto-dispose).
   * A non-zero value between commit boundaries indicates transient
   * observers waiting for their first non-initial Phase G fire.
   */
  readonly transientSubscribers: number
  /** Count of live `subscribeCommits(observer)` registrations. */
  readonly commitObservers: number
  /** Count of registered `commitMetadataDerived` nodes. */
  readonly commitMetadataDeriveds: number
  /** Count of consumers gating Phase F.4 commit-log refresh. */
  readonly commitLogConsumerCount: number
  /**
   * Size of the engine's id → entry registry. Includes the
   * engine-owned `commitLog` derived; for user-only node counts use
   * `inputs + deriveds`.
   */
  readonly entries: number
  /**
   * GraphTime of the most recently published commit (0 at engine
   * genesis; advances by exactly 1 per successful `commit(...)`).
   * Failed commits leave this byte-identical to its pre-commit value.
   */
  readonly lastCommitTime: GraphTime
  /** Current length of the bounded commit-history ring. */
  readonly retainedCommits: number
  /**
   * Count of V8 deoptimisations attributed to the engine since
   * construction, when the host backend can surface it; `undefined`
   * otherwise. The canonical TS engine does not wire `--trace-deopt`
   * into runtime state and reports `undefined`. See
   * `packages/bench/report/engine-status-deopts/SUMMARY.md` for the
   * external-capture path.
   */
  readonly deopts?: number | undefined
  /**
   * Count of GC pause events attributed to the engine since
   * construction, when the host backend can surface it; `undefined`
   * otherwise. The canonical TS engine reports `undefined` for the
   * same host-dependence reason as {@link EngineTelemetry.deopts}.
   * The WASM backend SHOULD report `0` (linear-memory bump-pointer
   * allocation has no GC pauses).
   */
  readonly gcPauses?: number | undefined
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
  readonly migrationPaybackCommits?: number | undefined
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
  nodeVersion(node: Node<unknown>): number
}
