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

// EngineTelemetry is referenced only via {@link} in JSDoc; the type-only
// import would trigger no-unused-vars otherwise.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { EngineTelemetry } from './telemetry.js'

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
export interface GraphStats {
  /** User-registered input nodes; mirrors {@link EngineTelemetry.inputs}. */
  readonly inputs: number
  /** User-registered derived nodes; mirrors {@link EngineTelemetry.deriveds}. */
  readonly deriveds: number
  /** Total live subscribers; mirrors {@link EngineTelemetry.subscribersTotal}. */
  readonly subscribersTotal: number
  /** GraphTime of the most recent commit; mirrors {@link EngineTelemetry.lastCommitTime}. */
  readonly lastCommitTime: number
  /**
   * Longest derivation chain depth in the registered graph, when the
   * backend can surface it. `undefined` on the canonical TS engine
   * (see module-level @remarks); a backend that does not measure
   * chain depth skips the chain-depth axis of the predicate.
   */
  readonly maxChainDepth?: number | undefined
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
  readonly medianCommitMs?: number | undefined
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
export interface AdaptThresholds {
  /**
   * Per-node-cost axis trigger — node count above which the per-node
   * commit cost on linear-chain shape is measurably above the V8
   * floor. Default `50_000` per the #694 / PR #1033 crossover-curve
   * sweep.
   */
  readonly nodeCount: number
  /**
   * Chain-shape axis trigger — max derivation-chain depth above which
   * derivation walking dominates per-commit cost. Default `500`,
   * unchanged from the original issue-body design.
   */
  readonly maxChainDepth: number
  /**
   * Per-commit-cost axis trigger — median commit time (ms) above
   * which the per-commit envelope cost (commitLog + changedNodes +
   * replay-determinism contracts) is large enough that the WASM
   * backend's projected ~0.7 ms/commit savings amortizes against the
   * one-time migration cost within ~640 commits. Default `1.0`,
   * anchored to the `equality-cutoff × 10000` macro cell (see
   * module-level @remarks for the caveat).
   */
  readonly medianCommitMsThreshold: number
  /**
   * Window length (in commits) over which {@link medianCommitMsThreshold}
   * is evaluated. Default `100` — long enough to wash out single-
   * commit spikes, short enough to detect a genuine shift in commit
   * shape within a few seconds of UI activity.
   */
  readonly rollingCommitWindow: number
  /**
   * Activity-gate trigger — minimum commit count for the
   * commit-shape axis to count as a stable workload signal. Default
   * `500`, derived from the cheap-bridge break-even math (~450 ms
   * migration cost / ~0.7 ms-per-commit savings ≈ 640 commits;
   * rounded down so the gate fires earlier on commit-heavy shapes).
   */
  readonly commitCount: number
  /**
   * Activity-gate trigger — minimum total subscriber count for the
   * commit-shape axis to count as a real reactive workload. Default
   * `1_000`, unchanged from the issue body.
   */
  readonly totalSubscribers: number
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
export const DEFAULT_THRESHOLDS: AdaptThresholds = Object.freeze({
  nodeCount: 50_000,
  maxChainDepth: 500,
  medianCommitMsThreshold: 1.0,
  rollingCommitWindow: 100,
  commitCount: 500,
  totalSubscribers: 1_000,
})

/**
 * Number of consecutive commits the multi-axis OR must trip before
 * {@link shouldMigrate} returns `true`.
 *
 * @remarks
 * Hysteresis constant — see module-level @remarks. Three consecutive
 * trips eliminates spike-triggered migration; a single 60k-node
 * commit followed by a 30k-node steady state should NOT migrate.
 *
 * Internal — not exported from the package barrel; the value is part
 * of the predicate's behaviour, not its public configuration surface.
 */
const HYSTERESIS_TRIP_COUNT = 3

/**
 * EWMA decay constant for the node-count gate inside
 * {@link shouldMigrate}.
 *
 * @remarks
 * Matches the issue-body design (`alpha=0.1`). Low alpha gives a long
 * effective window (~10 commits half-life) so a single spike does not
 * push the EWMA past the threshold even if the consecutive-trip count
 * is satisfied.
 *
 * Internal — see {@link HYSTERESIS_TRIP_COUNT}.
 */
const NODE_COUNT_EWMA_ALPHA = 0.1

/**
 * Compute an exponentially-weighted moving average over a non-empty
 * sequence of numbers.
 *
 * @param values - Sequence of observations; oldest first, newest last.
 * @param alpha - Decay constant in `[0, 1]`. `alpha === 0` returns the
 *   first value (no learning); `alpha === 1` returns the last value
 *   (no smoothing); intermediate values blend.
 * @returns The EWMA after consuming every element of `values`. Returns
 *   `0` for an empty input — the predicate uses this as the
 *   "insufficient history" sentinel and reads it as "the EWMA gate
 *   does not block migration".
 *
 * @remarks
 * Two design rules pinned by the unit tests:
 *
 * - **Empty input → 0.** The predicate calls `ewmaOver([], …)` only on
 *   a brand-new graph, where the hysteresis check already short-
 *   circuits to `false` because `recent.length < 3`. Returning 0
 *   keeps the helper total — no `NaN`, no thrown — without changing
 *   the predicate's behaviour at the empty-input boundary.
 *
 * - **`alpha === 0`** returns `values[0]` exactly. The recurrence is
 *   `ewma_t = alpha * x_t + (1 - alpha) * ewma_{t-1}` with
 *   `ewma_0 = x_0`, so alpha=0 leaves the EWMA pinned at `x_0`
 *   regardless of subsequent observations. Useful as the
 *   "no-learning" boundary case for the property-test machinery.
 *
 * Internal helper — re-exported only for the unit tests in
 * `auto-adapt.test.ts`. NOT part of the package barrel.
 */
export function ewmaOver(values: ReadonlyArray<number>, alpha: number): number {
  if (values.length === 0) return 0
  let ewma = values[0]!
  for (let i = 1; i < values.length; i += 1) {
    ewma = alpha * values[i]! + (1 - alpha) * ewma
  }
  return ewma
}

/**
 * Compute the median of a non-empty numeric sequence by sort.
 *
 * @param values - A rolling-window slice of recent commit wall-times
 *   (ms), oldest first. The caller (the auto-adapt wrapper's `commit()`
 *   shim, per #1048 / Option B) is responsible for bounding the window
 *   length — typically `rollingCommitWindow` on {@link AdaptThresholds},
 *   default 100 — so the per-call sort is O(n log n) on a small n.
 * @returns The median wall-time. For an even-length input, the average
 *   of the two middle values; for an odd-length input, the middle
 *   value. Returns `0` for an empty input — the predicate uses this
 *   as the "wrapper has not measured anything yet" sentinel which
 *   matches the `stats.medianCommitMs ?? 0` fallback already in place
 *   for backends that pre-compute the median internally.
 *
 * @remarks
 * Two design rules pinned by the unit tests:
 *
 * - **Empty input → 0.** The wrapper is expected to call
 *   `shouldMigrate(...)` from the first commit onward, but the rolling
 *   window may be empty on the very first call before any timing has
 *   been pushed. Returning 0 keeps the helper total and forces the
 *   predicate to fall back to `stats.medianCommitMs` (also defaulted
 *   to 0 on the canonical TS engine), which is the correct
 *   "insufficient data" behaviour — the commit-shape axis simply does
 *   not trip until real measurements arrive.
 *
 * - **Sort, not select.** Quickselect would be O(n) average but the
 *   default `rollingCommitWindow` is 100; Array.prototype.sort over
 *   100 doubles is ~5 µs in V8, well under the ~0.7 ms per-commit
 *   savings the WASM backend is projected to deliver. Choosing the
 *   simpler implementation keeps the audit surface small and the
 *   hot-path cost negligible. If profiling ever surfaces this as a
 *   regression we can swap in Quickselect without changing the
 *   contract.
 *
 * Internal helper — re-exported only for the unit tests in
 * `auto-adapt.test.ts`. NOT part of the package barrel.
 */
export function medianOf(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0
  // Defensive copy: do not mutate the caller's array (sort is in-place).
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if ((sorted.length & 1) === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Per-snapshot trigger — `true` iff the multi-axis OR fires on the
 * given stats / thresholds pair.
 *
 * @param medianCommitMs - The effective per-commit median (ms) to
 *   evaluate the commit-shape axis against. The {@link shouldMigrate}
 *   caller computes this once per invocation by preferring the median
 *   of the wrapper-supplied `commitTimings` window (Option B) and
 *   falling back to `stats.medianCommitMs` only when no wrapper-side
 *   timings are available. Decoupling the per-snapshot trigger from the
 *   `stats` field source keeps the commit-shape axis testable in
 *   isolation regardless of which path supplied the median.
 *
 * @remarks
 * Inlined into {@link shouldMigrate}'s hot loop; factored out for
 * unit-test isolation only.
 */
function tripped(stats: GraphStats, t: AdaptThresholds, medianCommitMs: number): boolean {
  // Per-node-cost axis: total user-registered nodes, with the chain-
  // depth axis as an OR'd inflection trigger. `maxChainDepth` is
  // optional on GraphStats; treat undefined as 0 so a backend that
  // does not measure it simply skips this branch.
  const nodes = stats.inputs + stats.deriveds
  if (nodes > t.nodeCount) return true
  const chainDepth = stats.maxChainDepth ?? 0
  if (chainDepth > t.maxChainDepth) return true

  // Per-commit-cost axis (NEW per comment-4416013410): the activity
  // gate AND the commit-shape gate must both fire. The median is
  // wrapper-supplied per #1048 / Option B; on a backend without
  // wrapper-side measurement it falls back to 0 and this branch
  // simply does not trip.
  if (
    stats.lastCommitTime > t.commitCount &&
    stats.subscribersTotal > t.totalSubscribers &&
    medianCommitMs > t.medianCommitMsThreshold
  ) {
    return true
  }

  return false
}

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
export function shouldMigrate(
  stats: GraphStats,
  thresholds: AdaptThresholds,
  history: ReadonlyArray<GraphStats>,
  commitTimings: ReadonlyArray<number> = [],
): boolean {
  // Resolve the effective per-commit median for this call. Per #1048
  // / Option B: when the wrapper has supplied a non-empty rolling
  // window of timings we use that; otherwise we fall back to the
  // optional `stats.medianCommitMs` field (still surfaced by backends
  // that pre-compute the median internally). When neither source has
  // data the median is 0 and the commit-shape axis simply cannot trip.
  const medianCommitMs =
    commitTimings.length > 0 ? medianOf(commitTimings) : stats.medianCommitMs ?? 0

  // Consecutive-trip gate: the current snapshot plus the last
  // (HYSTERESIS_TRIP_COUNT - 1) historical snapshots must all trip.
  // History shorter than (HYSTERESIS_TRIP_COUNT - 1) is the
  // "insufficient history" boundary and short-circuits to false —
  // the predicate cannot prove a sustained signal yet.
  if (history.length < HYSTERESIS_TRIP_COUNT - 1) return false
  const tail = history.slice(-(HYSTERESIS_TRIP_COUNT - 1))
  if (!tripped(stats, thresholds, medianCommitMs)) return false
  // Historical snapshots use their own stats.medianCommitMs (when
  // backends pre-compute it); the wrapper-supplied `commitTimings`
  // window represents the CURRENT commit's rolling state, not a
  // per-historical-snapshot replay. This is correct: the
  // consecutive-trip gate is about whether the per-snapshot OR fires
  // on prior commits, and historical commit-shape can only have been
  // tripped if the backend itself was surfacing the median at that
  // commit. Wrapper-side per-historical-commit-shape replay is out of
  // scope for this PR and is naturally captured by the rolling window
  // moving forward through real commits.
  for (let i = 0; i < tail.length; i += 1) {
    if (!tripped(tail[i]!, thresholds, tail[i]!.medianCommitMs ?? 0)) return false
  }

  // EWMA gate: average node count across the entire history (plus
  // the current snapshot, appended as the newest observation) must
  // exceed the node-count threshold. The slice + map allocates one
  // small array per call; this is the predicate's only allocation
  // on the success path.
  const allNodeCounts = new Array<number>(history.length + 1)
  for (let i = 0; i < history.length; i += 1) {
    const s = history[i]!
    allNodeCounts[i] = s.inputs + s.deriveds
  }
  allNodeCounts[history.length] = stats.inputs + stats.deriveds
  const ewma = ewmaOver(allNodeCounts, NODE_COUNT_EWMA_ALPHA)
  return ewma > thresholds.nodeCount
}

/**
 * Read every `CAUSL_WASM_*` env var the auto-adapt heuristic
 * recognises and return the partial-overrides object.
 *
 * @remarks
 * Mirrors the {@link loadFlagsFromEnv} precedent in `flags.ts`:
 *
 * - Read once at module load (the consumer-side wiring captures the
 *   result in a frozen merged thresholds object at engine
 *   construction; the commit hot path NEVER touches `process.env`).
 * - Defensive against a missing `process` (browser hosts), a `null`
 *   `process.env`, and a Proxy-backed `process.env` that throws on
 *   access. Each branch falls back to "no override".
 * - Refuses NaN, Infinity, and negative values — the predicate's
 *   threshold semantics require finite non-negative numbers, so a
 *   malformed env var is dropped silently rather than corrupting the
 *   threshold object. (A noisier failure mode — throwing — would
 *   block engine construction in production hosts where the env is
 *   only loosely typed.)
 *
 * Recognised env vars (each maps to one
 * {@link AdaptThresholds} field):
 *
 * - `CAUSL_WASM_NODE_THRESHOLD` → `nodeCount`
 * - `CAUSL_WASM_CHAIN_THRESHOLD` → `maxChainDepth`
 * - `CAUSL_WASM_SUBSCRIBER_THRESHOLD` → `totalSubscribers`
 * - `CAUSL_WASM_COMMIT_THRESHOLD` → `commitCount`
 * - `CAUSL_WASM_COMMIT_MS_THRESHOLD` → `medianCommitMsThreshold`
 *   (NEW per comment-4416013410)
 *
 * Internal — re-exported only for the unit tests; the public surface
 * is `createCausl({ adaptThresholds })` (when the wiring lands).
 */
export function loadThresholdsFromEnv(): Partial<AdaptThresholds> {
  const overrides: { -readonly [K in keyof AdaptThresholds]?: AdaptThresholds[K] } = {}
  try {
    const proc = (
      globalThis as { process?: { env?: Record<string, string | undefined> } }
    ).process
    const env = proc?.env
    if (env === undefined || env === null) return overrides

    const tryParse = (key: string): number | undefined => {
      const raw = env[key]
      if (raw === undefined || raw === '') return undefined
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) return undefined
      return parsed
    }

    const nodeCount = tryParse('CAUSL_WASM_NODE_THRESHOLD')
    if (nodeCount !== undefined) overrides.nodeCount = nodeCount
    const chain = tryParse('CAUSL_WASM_CHAIN_THRESHOLD')
    if (chain !== undefined) overrides.maxChainDepth = chain
    const subs = tryParse('CAUSL_WASM_SUBSCRIBER_THRESHOLD')
    if (subs !== undefined) overrides.totalSubscribers = subs
    const commits = tryParse('CAUSL_WASM_COMMIT_THRESHOLD')
    if (commits !== undefined) overrides.commitCount = commits
    const commitMs = tryParse('CAUSL_WASM_COMMIT_MS_THRESHOLD')
    if (commitMs !== undefined) overrides.medianCommitMsThreshold = commitMs
  } catch {
    // Defensive: a Proxy on `process.env` could throw on access.
    // Conservative fallback is to apply no overrides.
  }
  return overrides
}

/**
 * Merge a `Partial<AdaptThresholds>` override on top of
 * {@link DEFAULT_THRESHOLDS} and return a frozen result.
 *
 * @remarks
 * Internal helper exposed for the wiring layer (#687) to compose the
 * env-var overrides with per-engine `createCausl({ adaptThresholds })`
 * overrides at construction time. NOT exported from the package
 * barrel; the wiring layer that needs it imports this module
 * directly.
 *
 * Type assertion `unknown as ...` shields the call site from
 * `Object.freeze`'s erased-readonly return; the merged object satisfies
 * `AdaptThresholds`'s readonly contract by virtue of the freeze.
 */
export function mergeThresholds(
  overrides: Partial<AdaptThresholds> | undefined,
): AdaptThresholds {
  if (overrides === undefined) return DEFAULT_THRESHOLDS
  return Object.freeze({ ...DEFAULT_THRESHOLDS, ...overrides }) as AdaptThresholds
}

/**
 * Module-load snapshot of {@link loadThresholdsFromEnv}.
 *
 * @remarks
 * Read once at module load and reused for the lifetime of the
 * process. The wiring layer (#687) merges this with the per-engine
 * `adaptThresholds` argument once at engine construction; the
 * resulting frozen object is captured by the commit-loop closure so
 * the hot path never touches `process.env` again. Mirrors the
 * {@link MODULE_FLAGS} precedent in `flags.ts`.
 *
 * Internal — see {@link loadThresholdsFromEnv}.
 */
export const MODULE_THRESHOLD_OVERRIDES: Partial<AdaptThresholds> =
  Object.freeze(loadThresholdsFromEnv())
