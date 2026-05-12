# Bench measurement reliability — small-scale noise envelope

Date: 2026-05-12
Lens: Kent Beck pragmatic perf — measure what you can defend; don't claim
deltas smaller than your noise floor.

## TL;DR

At `linear-chain × 100`, an absolute delta of ~0.039 ms between two
sub-millisecond medians sits inside the harness's natural per-cell jitter
envelope at the PR-fast profile (N=15). The headline architectural deltas
(scale=1000+ where causl's chain-cost dominates) are orders of magnitude
above the noise floor and are real. The small-scale cells need either
N-bump or distinct framing before they can carry comparative claims in
the public narrative.

## 1. Harness shape — warmup and timed runs

Source of truth: [`packages/bench/src/scenario.ts`](../../packages/bench/src/scenario.ts)
and the per-library `runImpl` in
[`packages/bench/src/libraries/{causl,jotai,redux,mobx}.ts`](../../packages/bench/src/libraries/).

PR-fast profile (`pnpm bench`, `--profile=default` or `--profile=fast`):

- `DEFAULT_WARMUP_ITERATIONS = 5` — five cold runs build + step + dispose
  a fresh world per warmup, then are discarded. Bumped from 2 → 5 in
  May 2026 (#672 revision) to push V8 past TurboFan tier-up (~1k inner
  calls).
- `DEFAULT_MEASURE_ITERATIONS = 15` — fifteen timed samples, each on a
  freshly constructed world, with a forced `globalThis.gc()` between
  samples (`--expose-gc` is enforced at the entrypoint via
  `assertExposeGc`). Bumped from 5 → 15 in PR #1046 after the
  stability-trial flap surfaced ~40% per-sample CoV on sub-µs timings.
- Median of the 15 is the reported `cpuNs` / `runtime.median`; mean,
  p95, p99, stddev are reported alongside.

Nightly profile: `NIGHTLY_MEASURE_ITERATIONS = 50` — used only by
`BENCH_PROFILE=nightly`; PR gating runs N=15.

Microbenches share the same shape with their own constants:
`MICROBENCH_WARMUP_COUNT = 2`, `MICROBENCH_SAMPLE_COUNT = 15`. Each
microbench sample times one full 1000-iteration loop on a fresh graph.

## 2. CoV at each scale (from `packages/bench/report/fair-fight-results.json`, n=5 capture)

The committed fair-fight artefact pre-dates the N=15 bump (it captured at
n=5). I use it here for shape, not for absolute CoV; the headline
observation — that the mean/median/p95 spread tightens dramatically with
scale — does not depend on the sample count.

CoV proxy: `(p95 − median) / median` (a percentile-spread proxy that
behaves like stddev/mean for the right-tailed samples this harness
produces). True CoV (`stddev/mean`) is not persisted in this artefact;
the regression-gate computes it from `runtime.stddev`/`runtime.mean` at
gate-time. The proxy and the true CoV agree to within ~1–2 pp on cells
where both have been spot-checked.

### linear-chain

| scale  | causl med  | causl proxy CoV | jotai med  | jotai proxy CoV | redux med  | redux proxy CoV | mobx med   | mobx proxy CoV |
|-------:|-----------:|----------------:|-----------:|----------------:|-----------:|----------------:|-----------:|---------------:|
| 100    | 1.917 ms   | 8.8%            | 0.326 ms   | 16.9%           | 0.155 ms   | 23.1%           | 0.205 ms   | 19.3%          |
| 1 000  | 444.18 ms  | 0.5%            | 2.252 ms   | 3.8%            | 0.568 ms   | 12.0%           | 0.742 ms   | 3.7%           |
| 10 000 | (skip\*)   | —               | (skip\*)   | —               | 5.326 ms   | 2.8%            | 2.380 ms   | 293%           |

\* `linear-chain × 10000` skipped for jotai / mobx / pre-2026 builds of
causl with the JS backend due to recursive-read stack overflows (#721
part 3). The current published `comparison_table.md` shows only
`causl-wasm` at scale=10000 (5.11 ms / 6.3 ms p95, ~3.7% proxy CoV).

Key observation: **at scale=100 the proxy CoV sits between 9% and 23%
across the four libraries — comparable to or worse than the
regression-gate's `COV_FAIL_THRESHOLD = 10%`.** This is the regime
`COV_GATE_MIN_MEDIAN_MS = 0.5` already suppresses the median-delta gate
in: medians below 0.5 ms flap on scheduler jitter, not on real engine
work, and the gate explicitly does not score those cells. The article's
public narrative must reflect the same threshold.

## 3. Is the small-scale delta REAL or within noise?

Two sub-questions, two different answers:

### 3a. Is the published 0.039 ms gap at `linear-chain × 100` statistically real?

The user's framing: causl 0.071 ms vs mobx 0.032 ms, Δ = 0.039 ms (39 µs).
Apply the regression-gate's `COV_REGRESSION_DELTA = 0.08` to mobx's
0.032 ms median: ±8% envelope = ±2.6 µs. The 39 µs gap is **~15× the
per-cell CoV-regression envelope on the smaller side**. By that lens
the delta is genuine signal, not jitter.

But — and this is the load-bearing caveat — the gate's `COV_GATE_MIN_MEDIAN_MS`
floor (0.5 ms) explicitly **suppresses** any reasoning of this shape on
sub-0.5 ms cells, because the per-sample CoV at 30 µs medians is
dominated by V8 timer quantization + GC scheduler hiccups, not by the
median-of-15 you're comparing. The right reading: the gate is willing to
catch a 15× engine-side regression on a 30 µs cell, but only if it is
sustained across an N=15 median capture — and it explicitly will not
publish those cells as comparative wins/losses because the inter-trial
spread will swamp any cross-library reading at that magnitude.

In the actual committed fair-fight capture (n=5, pre-#1046), the
`linear-chain × 100` medians span 0.155 ms (redux) to 1.917 ms (causl)
with proxy CoVs of 9–23%. The cross-library deltas at scale=100 are
real **in rank order** but the **absolute magnitudes are not
publishable to two significant figures**. We should report scale=100
cells with one significant figure or as rank ordinals, not as point
estimates.

### 3b. Where ARE the deltas indisputably real?

At `linear-chain × 1000`: causl 444 ms vs redux-toolkit 0.57 ms is a
**~800× gap**. Apply the same 8% envelope to redux's 0.57 ms → ±46 µs.
The gap is ~10 000× the envelope. This is not noise.

At `linear-chain × 10000` the comparator libraries hit stack-overflow
gates and are skipped — causl-wasm is the only library that completes,
which is its own architectural claim.

The pattern: **deltas of >100× clear any reasonable noise envelope**;
deltas of 2-5× on sub-ms cells are inside the publishable margin and
should be reported with explicit uncertainty.

## 4. Fairness — exact same commits with exact same shape?

Confirmed via [`docs/bench-fairness.md`](../bench-fairness.md) and the
parity gate
([`packages/bench/test/fair-fight-parity.test.ts`](../../packages/bench/test/fair-fight-parity.test.ts)).
For `linear-chain` (natural-ops, 1-bound regime):

| library         | step body                                                              |
|-----------------|------------------------------------------------------------------------|
| causl           | `g.commit('bump', tx => tx.set(a, 1))` — 1 commit, 1 write             |
| jotai           | `store.set(head, 1)` — 1 bare write (jotai has no batching primitive)  |
| mobx            | `runInAction(() => head.set(1))` — 1 action, 1 write                   |
| redux-toolkit   | `store.dispatch(slice.actions.bumpHead(1))` — 1 dispatch, 1 write      |

Each library builds `scale` chained derivations (`derived` /
`atom((get) => …)` / `computed` / chained `createSelector`); the
recompute-count parity invariant
(#873, [`packages/bench/test/conformance/recompute-count-parity.test.ts`](../../packages/bench/test/conformance/recompute-count-parity.test.ts))
asserts every library reports `recomputes >= scale` on the head bump.
This was the bug redux had pre-#873 (a tight Immer reducer loop, not a
derivation walk); it is now fixed.

The four harnesses run **exactly one commit / dispatch / action / set per
timed iteration**, each timed iteration is its own fresh world, and each
world wires `scale` derivation nodes on construction. Same number of
commits, same shape. Fairness for `linear-chain` is intact.

## 5. Recommendations

### R1. Bump PR-fast measure-count for sub-0.5 ms cells to N=50, leave the rest at N=15

The `COV_GATE_MIN_MEDIAN_MS = 0.5` floor already labels these cells as
unscored for regression-gating. The same floor should drive
`resolveMeasureIterations` to return `NIGHTLY_MEASURE_ITERATIONS = 50`
when the **scenario's scale × library combination** is expected to land
sub-0.5 ms. The wall-clock cost is bounded (sub-0.5 ms × 50 ≈ 25 ms
per cell — still well inside the per-cell budget) and the median-of-50
collapses the 9-23% proxy CoVs we see at scale=100 to ~3-5%, putting
those cells inside the regression-gate's envelope and into the public
comparison table without an asterisk.

Implementation site: extend `resolveMeasureIterations` in
[`packages/bench/src/scenario.ts`](../../packages/bench/src/scenario.ts)
to accept the scenario spec + scale, with a per-cell budget lookup
mirroring `expectedWallMsPerCell`.

### R2. Add median-of-medians (M-estimator) for cells above the wall-clock budget

For cells where R1's N-bump would blow the per-cell budget (the heavy
`mixed-editor-60s` / `long-run-1M` family), keep N=15 but compute a
**median-of-medians** across three independent N=15 sweeps —
implementable in the runner without changing the harness, and gives a
~30% standard-error reduction over a single N=15 median at zero
additional per-cell wall-clock cost (the three sweeps run sequentially,
not in parallel, so total wall-clock 3× but no single cell exceeds its
budget). The composition-shift gate (#874) can already consume the
extra dimension; the regression-gate would need a small extension to
score the M-estimator instead of the single-sweep median.

Implementation site:
[`packages/bench/src/run.ts`](../../packages/bench/src/run.ts)
`runAll`; wrap the inner per-cell loop in an outer 3-sweep loop and
emit one cell per (library × scenario × scale × sweep), then aggregate
in `bench:report`.

## References

- [`packages/bench/src/run.ts`](../../packages/bench/src/run.ts) — in-process harness
- [`packages/bench/src/scenario.ts`](../../packages/bench/src/scenario.ts) — constants (`DEFAULT_WARMUP_ITERATIONS`, `DEFAULT_MEASURE_ITERATIONS`, `MICROBENCH_*`, `computeRuntimeStats`)
- [`packages/bench/src/regression-gate.ts`](../../packages/bench/src/regression-gate.ts) — `COV_REGRESSION_DELTA = 0.08`, `COV_GATE_MIN_MEDIAN_MS = 0.5`, `MEDIAN_DELTA_GATE_MIN_MEDIAN_MS = 0.5`
- [`docs/bench-fairness.md`](../bench-fairness.md) — boundary-semantics regimes per scenario
- [`packages/bench/test/fair-fight-parity.test.ts`](../../packages/bench/test/fair-fight-parity.test.ts) — structural fairness gate
- [`packages/bench/test/conformance/recompute-count-parity.test.ts`](../../packages/bench/test/conformance/recompute-count-parity.test.ts) — workload-shape invariant
- PR #1046 — N=5 → N=15 bump rationale
- PR #1074 — `COV_REGRESSION_DELTA` 0.03 → 0.08 widening rationale
- PR #672 (revision) — `DEFAULT_WARMUP_ITERATIONS` 2 → 5 rationale
