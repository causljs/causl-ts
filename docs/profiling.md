# Profiling causl benchmarks

An adopter-facing guide to flame-graphing and heap-profiling the
`@causl/bench` cells. If `pnpm bench` tells you *which* library wins on
wall time, profiling tells you *why* — where the cycles go, which call
edges dominate, which symbols allocate.

## Why profile

`pnpm bench` reports wall-clock medians over a tinybench warm-up
window. That number answers "is this scenario slower than last week?"
but it does not say where the time went. A flame graph reports
**attribution**: it bins sampled stack frames so that wide bars are hot
functions and deep stacks are call chains the optimiser refused to
inline. Reach for `bench` to gate regressions; reach for a flame graph
when a cell has regressed (or when you are designing a new cell and
want to know whether the engine is doing work or the harness is) and
you need to read the cost back into source lines.

## Tools

A quick reference. Full install + flag matrix lives in
[`docs/profiling-tools.md`](./profiling-tools.md).

| Tool | Output | Viewer | Use for |
| --- | --- | --- | --- |
| **0x** | `flamegraph.html` (interactive SVG) | Browser | Ad-hoc flame graphs with merged JIT/C++ frames. |
| **`--cpu-prof`** | V8 `.cpuprofile` (JSON) | [speedscope.app](https://speedscope.app) (drag-drop) | Reproducible CI artefacts; checked into `.cpuprofile/`. |
| **`--heap-prof`** | V8 `.heapprofile` (JSON) | Chrome DevTools → Memory → Load | Allocation-attributed sampling for GC-heavy scenarios. |

0x is shipped as a root `devDependency` (`0x@^6.0.0`); `--cpu-prof`
and `--heap-prof` are V8 built-ins, no install needed.

## One-command repro

The bench package wires every profiler to the cell harness:

```sh
pnpm bench:profile causl linear-chain 1000
pnpm bench:profile:cpu causl scrolling-viewport 10000
pnpm --filter @causl/bench profile:heap
```

The first form opens 0x and writes an SVG flame graph; `:cpu` drops a
`.cpuprofile` under `packages/bench/report/profiles/` so it round-trips
through git review. `profile:heap` is a bench-package-local script
(not a top-level `bench:*` alias) that drops a `.heapprofile` next to
the cell file via V8's built-in heap sampler. Re-run any competing
library by swapping the first argument of `bench:profile` /
`bench:profile:cpu`: `jotai`, `redux-toolkit`, `mobx`.

> **Resolved finding (as of v0.9.0).** Earlier revisions of this guide
> flagged a wide `Commit.from*` bar on `causl × scrolling-viewport` as
> a Phase-A optimisation target. The perf-experiment umbrella (#679,
> 22/22 sub-issues complete) closed the 654× regression on that cell;
> the envelope-attribution work and the three deopt findings tracked
> under #917 / PR #927 are now resolved. Adopters profiling that cell
> today should not see envelope construction dominate; if they do, it
> is a regression worth filing.

## Reading a flame

Wide bars are where the program *spent* time; deep stacks are where the
optimiser *could not* flatten work into a hot leaf. A wide-shallow
graph means one function dominates and is a deopt or megamorphic-IC
candidate; a narrow-deep graph means the cost is spread across a long
call chain and inlining or batching is the lever. Library-specific
patterns to recognise:

- **jotai** — recursive `read*Atom` frames; depth tracks dependency
  fan-in.
- **redux-toolkit** — `combineReducers` walking every slice on every
  dispatch.
- **mobx** — `derivation_` / `trackDerivedFunction` walks; width tracks
  observed-atom count.
- **causl** — the Phase A→H pipeline (`enqueue`, `recompute`,
  `notify`, `commit`) appears as a stable left-to-right banner per
  commit. Deviations from that banner are the signal.

## Adding a new cell

1. Copy any
   [`packages/bench/src/profile/cells/<lib>-<scenario>-<scale>.ts`](../packages/bench/src/profile/cells/)
   shipped under #809 (umbrella closed; cells live alongside
   `causl-canonical-7`, `jotai-canonical-7`, `mobx-canonical-7`,
   `redux-canonical-7`).
2. Change the `lib`, `scenario`, and `scale` constants at the top of
   the file.
3. Run `pnpm bench:profile:cpu <lib> <scenario> <scale>`.
4. Commit the resulting `.cpuprofile` alongside the new cell — review
   diffs the JSON like any other source artefact.

## Aggregation

After committing one or more `.cpuprofile`s, refresh the cross-cell
attribution table:

```sh
pnpm bench:profile:aggregate
```

This regenerates [`packages/bench/report/profile_summary.md`](../packages/bench/report/profile_summary.md)
with a per-library / per-scenario breakdown of the top-N hot frames. PR
reviewers read the regenerated summary the same way they read
`bench-fairness.md` — as the headline that the underlying artefacts
back up.

## Reading engine-status reports

`pnpm bench:profile:cpu` answers **where** time goes; the V8-tier
trace surfaces (`profile:deopt`, `profile:ic-via-prof`, `profile:gc`)
answer **why** the engine left it there. `engine-status` (#875) joins
all three into one PR-readable report:

```sh
pnpm bench:profile:engine-status causl scrolling-viewport 10000
# → packages/bench/report/engine-status.md
```

The driver spawns three child Node processes serially — one per trace
flag — captures each output stream, and writes a single markdown file
with three sections:

| Section | Source | What to look for |
| --- | --- | --- |
| **Deopt reasons (top 10)** | `--trace-deopt` | `(reason, function)` histogram. `wrong map` deopts on the same `JSFunction` are the post-#793 megamorphism signal — the IC feedback the optimiser baked in stopped matching the live shapes. `Insufficient type feedback for X` deopts mean the call site never saw enough samples to specialise; usually a cold edge that the warm-up pass missed. The two historical `dependent allocation site tenuring changed` deopts on `makeInputNode` (closed by PR #1036) and the per-instance `input()` callsite (closed by PR #1132) are baselined to zero by the `tenuring-deopt-invariant` hypothesis gate; a non-zero count on either function is treated as a regression. |
| **IC-flavoured symbols (top 10 by tick count)** | `--prof` + `--prof-process` | Symbols matching `KeyedLoadIC*`, `LoadIC*`, `LdaGlobal*`, `Sta*Property`, `*Megamorphic`, `*Polymorphic` and the `--prof-process` tick weight per symbol. Empty or near-empty section means no IC-flavoured stub crossed the sampler floor — i.e. the cell stayed monomorphic enough that V8 inlined the property access into optimised code. |
| **GC pause distribution** | `--trace-gc-verbose` | Per-phase (`Scavenge`, `Mark-Compact`, …) count + p50/p95/p99 of pause durations + total ms spent in GC. Short cells should be dominated by `Scavenge` with sub-ms p95; persistent `Mark-Compact` weight on a non-allocating scenario points at promotion pressure. |

All three sections degrade to a "no events" placeholder when the
underlying trace surface emitted nothing — a clean run still produces
a non-empty report documenting that fact, so you can diff the
`engine-status.md` between two engine versions and see additions /
disappearances explicitly.

When investigating a regression, run engine-status against `main`,
stash the report, switch to the candidate branch, re-run, and read
the two markdown files side-by-side. The top of each section is
sorted by frequency / tick count, so a regression typically shows up
as either a brand-new top-line entry or an existing entry's count
rising by a step.
