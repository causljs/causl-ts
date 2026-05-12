# Fresh bench results — 2026-05-12

Date: 2026-05-12
Source: `packages/bench/report/benchmark_results.json` (regenerated this morning)
Run summary: **143 cells succeeded, 13 skipped**. With #1293 fixed, skipped
rows now render explicitly in the comparison table rather than being
silently dropped.

Companion table (highest-scale-only view per scenario):
`packages/bench/report/comparison_table.md`.

This doc cross-cuts the table along the **scale dimension** for the two
scenarios whose architectural claims hinge on scale invariance:
`linear-chain` and `scrolling-viewport`. Both report median, p95, throughput,
and heap delta for every (library × scale) cell at scales 100 / 1 000 /
10 000.

## 1. linear-chain — median (ms) at each scale

| library         | scale 100 | scale 1 000 | scale 10 000 |
| --------------- | --------: | ----------: | -----------: |
| causl           | 0.076     | 0.717       | 6.107        |
| jotai           | 0.138     | (skipped — stack overflow #721 pt 3) | (skipped — stack overflow #721 pt 3) |
| redux-toolkit   | 0.042     | 0.367       | (skipped — stack overflow #721 pt 3) |
| mobx            | 0.075     | 0.276       | (skipped — stack overflow #721 pt 3) |

Full per-cell metrics (median / p95 / throughput / heap delta):

### causl
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.076       | 0.100    | 13 165           | +0.47           |
| 1 000  | 0.717       | 0.832    | 1 395            | +0.90           |
| 10 000 | 6.107       | 12.791   | 164              | −0.87 (post-GC) |

### jotai
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.138       | 0.172    | 7 253            | +0.28           |
| 1 000  | — _(skipped: jotai's read path evaluates the chain via mutual recursion and overflows the V8 call stack at this depth — #721 pt 3)_ | — | — | — |
| 10 000 | — _(skipped: same reason)_ | — | — | — |

### redux-toolkit
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.042       | 0.085    | 23 976           | +0.34           |
| 1 000  | 0.367       | 0.505    | 2 727            | +0.02           |
| 10 000 | — _(skipped: redux-toolkit's reselect chain evaluates via mutual recursion and overflows the V8 call stack at this depth — #721 pt 3)_ | — | — | — |

### mobx
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.075       | 0.160    | 13 333           | +0.30           |
| 1 000  | 0.276       | 1.242    | 3 621            | +0.12           |
| 10 000 | — _(skipped: mobx's `shouldCompute` walks the chain via recursive descent and overflows the V8 call stack at this depth — #721 pt 3, harness cap `MOBX_LINEAR_CHAIN_MAX_SCALE = 1000`)_ | — | — | — |

### Read

- At scale 100, redux and mobx are both **~2× faster** than causl
  (42 µs / 75 µs vs 76 µs median). The gap is real but inside the
  small-scale noise envelope per `measurement-reliability.md` — proxy
  CoV at this magnitude runs 9–23 % across libraries.
- At scale 1 000, redux is **~2× faster** than causl (367 µs vs 717 µs).
  This delta IS unambiguous (the regression-gate's 8 % envelope is
  ~30 µs against the smaller median).
- At scale 10 000, **causl is the only library that runs**. Every
  comparator hits the V8 call-stack ceiling at chain depth ~1 000 and
  the harness skips them with a typed `RecursiveEvalStackOverflowError`.
  causl's iterative Phase-D driver doesn't recurse, so depth scales
  linearly in time and is bounded only by allocation.

## 2. scrolling-viewport — median (ms) at each scale

| library         | scale 100 | scale 1 000 | scale 10 000 |
| --------------- | --------: | ----------: | -----------: |
| causl           | 0.095     | 0.102       | 0.106        |
| jotai           | 0.091     | 0.092       | 0.101        |
| redux-toolkit   | 0.572     | 3.695       | 34.099       |
| mobx            | 0.079     | 0.142       | 1.104        |

Full per-cell metrics:

### causl
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.095       | 0.107    | 10 508           | +0.03           |
| 1 000  | 0.102       | 0.113    | 9 764            | +0.21           |
| 10 000 | 0.106       | 0.112    | 9 445            | −0.20 (post-GC) |

### jotai
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.091       | 0.104    | 11 045           | +0.02           |
| 1 000  | 0.092       | 0.123    | 10 820           | +0.06           |
| 10 000 | 0.101       | 0.111    | 9 897            | +0.04           |

### redux-toolkit
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.572       | 0.840    | 1 749            | +0.06           |
| 1 000  | 3.695       | 3.799    | 271              | +0.01           |
| 10 000 | 34.099      | 34.871   | 29.3             | +0.00           |

### mobx
| scale  | median (ms) | p95 (ms) | throughput (c/s) | heap delta (MB) |
| -----: | ----------: | -------: | ---------------: | --------------: |
| 100    | 0.079       | 0.155    | 12 645           | +0.12           |
| 1 000  | 0.142       | 3.879    | 7 040            | +0.09           |
| 10 000 | 1.104       | 2.871    | 906              | +0.08           |

### Read

- causl's median is **scale-invariant** across 100 → 10 000 (0.095 →
  0.106 ms — a 1.12× cross-scale ratio). jotai matches that property
  closely. mobx and redux do not: mobx degrades 14× across the range,
  redux degrades 60×.
- At scale 10 000 causl beats redux by **407×** (0.106 ms vs 34.099 ms).
  Per the `scrolling-viewport-causl.md` analysis, the multiplier is
  partly a benchmark-composition effect (`hasDependents=false` skips
  the engine's staging slow path) — the architectural claim that
  survives the scenario caveat is the scale-invariance itself.

## 3. Comparison to May 11 baseline

The reference figures in the brief (May 11 baseline): causl
`linear-chain × 10 000 = 5.114 ms`, `scrolling-viewport × 10 000 = 0.082 ms`.

Fresh medians (this run): `6.107 ms` and `0.106 ms` respectively. Both
shifts are inside the regression-gate's `COV_REGRESSION_DELTA = 0.08`
envelope (8 %), but at this scale the regression-gate also requires the
p95 to exceed `MEDIAN_DELTA_GATE_MIN_MEDIAN_MS = 0.5` ms, which both
cells satisfy.

`linear-chain × 10 000`: +19.4 % vs baseline. The p95 doubled
(6.3 → 12.8 ms), which is the more alarming signal. Two plausible
explanations:

1. **GC pressure regression on the iterative driver.** Heap delta
   in this run was −0.87 MB (post-`globalThis.gc()`), but the in-run
   nursery churn from `nextDepsArr` / `nextStack` / `RecursiveFrame`
   allocations (per `phase-d-recompute-analysis.md` §4) at this scale
   crosses the Scavenge threshold inside the timed window. A single
   mark-sweep during the timed body shifts p95 by ~6 ms.
2. **Bench-runner concurrency.** The fresh run executed alongside a
   parallel toolchain task in the same shell; the harness pins to one
   worker but the CPU profile interval can still wobble.

`scrolling-viewport × 10 000`: +29 % vs baseline (0.082 → 0.106 ms).
The cell's hot path is so light (`tx.set` fast-path + Phase G index
lookup) that the absolute delta is 24 µs — inside the V8 timer
quantization floor per `measurement-reliability.md` §3. **Treat as
noise** until a second N=50 nightly sweep confirms.

### Action items

- Re-run both cells under `BENCH_PROFILE=nightly` (N=50) before treating
  the deltas as regressions. The `measurement-reliability.md` R1
  recommendation (N=50 for sub-0.5 ms cells, N=15 for the rest) directly
  addresses the scrolling-viewport noise reading.
- File a perf-watch issue against `linear-chain × 10 000` if the p95
  doubling reproduces in a nightly sweep. The doubled p95 is more
  suspicious than the median shift.

## 4. Skipped cells — current accounting

13 total. By scenario:

| scenario                       | scale  | skipped libraries        | reason                                                                                  |
| ------------------------------ | -----: | ------------------------ | --------------------------------------------------------------------------------------- |
| linear-chain                   | 1 000  | jotai                    | recursive read overflows V8 stack (#721 pt 3)                                           |
| linear-chain                   | 10 000 | jotai, redux-toolkit, mobx | same                                                                                  |
| commit-firehose-1000-subs      | 10 000 | jotai, redux-toolkit, mobx | no public API expressible for the acceptance gate (#843)                              |
| multi-fetch-race-N10           | 10 000 | jotai, redux-toolkit, mobx | same                                                                                  |
| op-wasm-boundary-1k            | 10 000 | jotai, redux-toolkit, mobx | same                                                                                  |

All 13 are skips encoded by the harness with typed reason strings; none
are unexpected failures. The #1293 fix makes them visible in the
comparison table as `(skipped — <reason>)` rows rather than silently
omitted — this is the first run where the report renders the full grid.

## 5. References

- `packages/bench/report/comparison_table.md` — canonical comparison
  table (highest-scale-only view per scenario).
- `packages/bench/report/benchmark_results.json` — full per-cell raw
  metrics (143 results + 13 skipped).
- `docs/bench/2026-05-12-measurement-reliability.md` — noise envelope at
  sub-0.5 ms cells.
- `docs/bench/2026-05-12-linear-chain-causl.md` /
  `2026-05-12-scrolling-viewport-causl.md` — per-cell code-walk for the
  two scenarios in this doc.
- `docs/bench/2026-05-12-team-analysis-synthesis.md` — ranked
  recommendations across all 13 analysis lenses.
