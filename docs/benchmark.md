# Causl vs Jotai, Redux Toolkit, MobX

> **Status: methodology contract — results pending.** This article ships as the design of the benchmark, not yet the report. Every `[TBD]` marker is a slot a real benchmark run will fill. The team's TDD commitment forbids fabricated numbers; the libviprs benchmark article that this one models works because every number in it is real, and we plan to earn the same posture before we publish anything that competes for attention against Jotai's 5 KB story or Redux DevTools' install base.

---

A pure-TypeScript transactional dependency-graph engine is taking on three of the most-installed React state libraries in the ecosystem. In head-to-head benchmarks across seven canonical workloads — diamond cascades, 1000-cell scrolling viewports, dynamic-dependency flips, async-resource races, batch commits, equality-cutoff propagation, and large-fanout subscriber notification — Causl's results land at `[TBD]`× to `[TBD]`× the speed of the closest competitor on the workloads that match its design center, while staying within `[TBD]` MB of the closest minimum-bundle competitor. Those won't be typos either. And this isn't a rigged comparison: every library receives the same scenario set, every measurement is taken in the same Node.js process or the same Playwright-driven Chromium, and every chart axis labels what it is honestly. The difference is architectural — and the architectural difference is the only reason a fifth state library can exist in 2026 and be worth installing.

## How We Test

Fair benchmarking between state libraries with different mutation semantics is harder than it looks. Run a microbenchmark and you measure the engine in isolation, missing the React reconciliation cost that dominates real apps. Run a Playwright harness and you measure the browser, hiding the engine's own cost behind paint and layout. Mount components and you measure mount; update them and you measure scheduler decisions you didn't make. To eliminate every variable except the engine itself on the relevant workloads, we run every benchmark in two layers:

- **In-process microbenchmarks** measure the cost of state operations themselves: a commit, a derived recompute, a subscriber notification, an equality cutoff. Every library is loaded into the same Node.js process via dynamic import; every benchmark is run with [`tinybench`](https://github.com/tinylibs/tinybench) using a 200ms warm-up and a 1000-iteration sample, with the median reported and the noise floor recorded. No DOM, no React, no scheduler interference — just the engine doing what it claims to do.
- **DOM-rendering benchmarks** measure end-to-end React mount and update cost using Playwright against a production build. Each library renders the same scenario component tree; the harness counts dropped frames at 60 Hz, measures wall time from `commit` (or equivalent mutation) to `requestIdleCallback` settling, and reports per-frame paint cost from the Chrome DevTools Protocol's `Performance.metrics`.

Both layers run under the same Node version, the same `react@^18.3` (and a separate sweep on `react@19.0` once stable), the same machine class (Apple Silicon M-series for the `[TBD]` headline numbers; x64 Linux for the `[TBD]` reproduction in CI). Every library is loaded from npm at its latest stable release on the day the run was made, and the resolved versions are recorded in the JSON output. Source code for all benchmarks lives in [`packages/bench/`](https://github.com/iasbuilt/causl/tree/main/packages/bench), and the full 4-library + `causl-wasm` benchmark pipeline can be reproduced via `python tools/bench/run-bench.py` (the 4-library sweep runs in a pinned Docker image; see [Reproducer pipeline](#reproducer-pipeline--the-default-1552)).

## The Workloads

We picked seven workloads. Each one isolates a behavior the architectural difference between Causl and its competitors makes load-bearing.

| # | Workload | What it measures |
|---|---|---|
| 1 | **Linear chain (`A → B → C → D → E`)** | Cost of forwarding a single change through five linear derivations. |
| 2 | **Diamond cascade (`A → B; A → C; B + C → D`)** | Cost of glitch-free recomputation when two paths converge. Only Causl guarantees `D(t) = f(B(t), C(t))` as a denotational property; the others provide it as a scheduler artifact. |
| 3 | **1000-cell scrolling viewport** | Real-world DX: virtualized grid where each row needs parameterized inputs, mounting and unmounting under user scroll. Measures: GC pressure, leak rate, dropped frames at 60 Hz. |
| 4 | **Dynamic-dependency flip** | A derivation conditionally reads input A *or* input B based on a third input. After the flip, writes to the abandoned input must not trigger recomputation. Measures: dynamic-dep cleanup cost, false-recompute count. |
| 5 | **Async-resource race** | Component dispatches a fetch keyed by input X; X changes while fetch is in flight; late result must not overwrite the newer state. Measures: stale-result detection cost, observable wrong-data window. |
| 6 | **Batch commit** | One user action writes 50 inputs simultaneously. Subscribers should fire once per batch, not 50 times. Measures: notification coalescing, recompute count for unchanged downstream values. |
| 7 | **Equality-cutoff propagation** | A derivation recomputes to the same value (`Object.is` equal). Downstream subscribers should not fire. Measures: false-positive notifications, propagation depth. |

Each workload runs at four scales: 100, 1k, 10k, and 100k nodes. Memory is measured via [`process.memoryUsage().heapUsed`](https://nodejs.org/api/process.html#processmemoryusage) deltas around forced GC cycles in the in-process layer, and via Chromium's `--enable-precise-memory-info` heap totals in the DOM layer. The methodology section at the bottom of this article documents every knob.

## The Numbers

[Headline charts and tables go here once the bench has run. The structure they will follow:]

### Wall time per commit (single mutation, 1k nodes)

| Library | Linear chain | Diamond | Dynamic-dep flip | Batch (50 writes) | Equality cutoff |
|---|--:|--:|--:|--:|--:|
| Jotai | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms |
| Redux Toolkit | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms |
| MobX | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms |
| **Causl** | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms | `[TBD]` ms |

[At the diamond row we will show that Causl's recompute count is exactly `|affected|` — measured directly via the `whyUpdated` instrumentation — while the others either over-fire (Jotai diamond glitches above N=100 in some configurations) or relink under the hood with measurable bookkeeping cost. We expect Causl to lead on the diamond and on equality cutoff, and to be competitive (within a small constant) on the rest.]

### Memory at 10k nodes

| Library | Initial heap | After 1k commits | After 10k commits |
|---|--:|--:|--:|
| Jotai | `[TBD]` MB | `[TBD]` MB | `[TBD]` MB |
| Redux Toolkit | `[TBD]` MB | `[TBD]` MB | `[TBD]` MB |
| MobX | `[TBD]` MB | `[TBD]` MB | `[TBD]` MB |
| **Causl** | `[TBD]` MB | `[TBD]` MB | `[TBD]` MB |

[We expect Causl to be heavier at the initial-heap row — the engine carries a statechart and a commit log the others don't — and to be flatter under load because the dependency graph is built once and reused. The libviprs comparison teaches us that an architectural floor that doesn't go to zero is sometimes the right floor.]

### Dropped frames during 1000-cell scroll (Playwright, 60 Hz target, 30s scroll)

| Library | Dropped frames | Worst-case frame time |
|---|--:|--:|
| Jotai | `[TBD]` / 1800 | `[TBD]` ms |
| Redux Toolkit | `[TBD]` / 1800 | `[TBD]` ms |
| MobX | `[TBD]` / 1800 | `[TBD]` ms |
| **Causl** | `[TBD]` / 1800 | `[TBD]` ms |

### Bundle size (brotli-compressed, full import)

The cells below are derived from the latest `size-limit --json` run
in CI. The renderer (`tools/bench/render-bundle-table.ts`) splices a
fresh table between the markers below on every nightly bench run, so
the numbers in this article cannot drift from the
size-limit gate (PR #203 review).

<!-- bundle-table:start -->
| Library | Full | Tree-shaken minimal |
|---|--:|--:|
| Jotai (core) | 6.1 KB | 0.2 KB |
| Redux Toolkit | 13.3 KB | 3.0 KB |
| MobX | 16.0 KB | 13.8 KB |
| **Causl** (`@causljs/core`) | 7.7 KB | 6.8 KB |
<!-- bundle-table:end -->

[We have committed a per-import `size-limit` budget for `@causljs/core` of 4 KB on minimal import (`createCausl`, `input`, `derived`, `commit`) and 6 KB on full import. That is 1 KB above Jotai's core and well below Redux Toolkit and MobX. The budget is enforced as a CI gate, not folklore (Adoption Epic E). We will not publish a bundle number that drifts from the budget without re-baselining the budget in writing.]

## The Memory Wall

This is where the architectural difference will hit hardest. Causl is the only library on the list that pays for a transactional commit boundary on every write. Jotai mutates per-atom; Redux dispatches an action that produces a new immutable state; MobX wraps every observable in a proxy and tracks reads via a global derivation context. None of those three has a per-commit "stage everything, validate, publish atomically" lifecycle. The cost of that lifecycle is a non-zero floor at small N, and the design bets that the floor is worth paying because it lets us guarantee glitch-freedom as a *theorem* rather than a *scheduler artifact*. The benchmark will quantify that bet at every scale we test.

## Efficiency Under Constraint

The efficiency chart we will publish — `commits per second per MB of peak heap` — is the metric that matters for deployment, the same way it does for libviprs in container-billing economics. A frontend isn't billed by memory-second the way a backend is, but the analogous constraint exists on the user's machine: a Chrome tab competing with twelve other tabs for system memory has a finite budget, and a state library that uses a fraction of the resources to do the same work means the rest of the page (a chart, a video, a 3D scene) gets the headroom. We expect Causl to lead on this metric on the workloads where its dependency graph stays warm — diamonds, dynamic deps, batch commits — and to be competitive (within a small constant) where the workload doesn't exercise the graph (linear chains).

## Raw Speed Still Matters

If the comparison is reduced to "single mutation, single subscriber, no diamond, no async, no batch" — the smallest possible workload — Jotai will win on every machine we test. Its core is 5 KB of essentially zero-overhead atom assignment. We do not expect to beat that, and we will not pretend to. Causl's value proposition is what happens *between* the smallest workload and the workload your real app actually has. The benchmark will show that crossover honestly: at workload `[TBD]` the lines cross.

## How Jotai Works (And Why It's Architectural Not Personal)

Jotai's core is roughly 600 lines of TypeScript built around a single primitive: an atom is a `{ read: (get) => T, write?: (get, set, ...) => void }` pair. Atoms register with a `Store`; reads track dependencies via a context-scoped `get`; writes invalidate dependents and re-render observing components. The architecture is brilliant for two reasons: it composes (every derived atom is just another atom), and it tree-shakes (an unused utility doesn't bring its dependencies). The cost is that Jotai has no transaction boundary — `setX(); setY();` is two distinct mutations, two distinct re-render passes, two distinct opportunities for an observer to read inconsistent state. For most apps this is fine; for spreadsheets, dependency-heavy editors, and the long tail of "live graph of facts" applications Causl targets, it is the foot-gun the user reaches us looking to escape.

Jotai also has no story for stale-async by version — its `loadable()` aborts the in-flight promise, but cannot detect that the dependency it was loading against has changed and therefore the result is wrong even if it arrives. Causl's resource statechart (per `SPEC.md` §6) makes that distinction first-class: a `Loaded` value's freshness is computed against the `GraphTime` at which the fetch began, and a stale arrival is either silently discarded or recorded as a typed conflict. The benchmark workload #5 will measure this difference directly: under random fetch ordering and random dependency mutation, how many wrong-data renders does each library produce?

## How Redux Toolkit Works

Redux's reducer-and-action model is the most explicit of the four. Every state change is a typed action; the reducer is a pure function from `(state, action)` to a new state. Time-travel debugging falls out for free, the action log is auditable by construction, and the model is teachable in fifteen minutes. The overhead is also the most explicit: every dispatch produces a new state object via `Immer` (in RTK), every subscriber re-renders unless it `useSelector`-s a stable slice, and every derivation is a memoized selector the user has to compose by hand. Selectors don't track dependencies; the user must remember to memoize against the correct inputs.

For workloads where the dependency graph is small and the action vocabulary is rich (form state, wizard state, undo-redo of distinct user intents), Redux is excellent. For workloads where the dependency graph is the whole app and the user mostly wants `cell.value = 42` to recompute the world, Redux makes the user write the dependency tracker by hand. The benchmark will not measure "does Redux make the user write more code" — that's a DX claim, not a perf claim — but it will measure the cost of the per-dispatch immutable state copy at scale, where Immer's structural-sharing cost grows with state shape.

## How MobX Works

MobX's proxy-based reactivity is the closest competitor to Causl's design center. `makeAutoObservable(thing)` wraps every property in a proxy that tracks reads through a global derivation context; `computed()` properties memoize and invalidate via the same dependency graph; `reaction()` subscribes to a closure and fires on every relevant change. This is the smallest, most ergonomic dependency-graph state library on the JavaScript side of the table — and the one most likely to be the right answer for many apps Causl is *not* the right answer for.

The architectural differences MobX cannot match are the ones the team picked deliberately:

- **No transaction boundary.** `runInAction` batches notifications, but does not atomically stage writes; an observer reading mid-action sees partial state. Causl's `commit` either lands wholesale or not at all.
- **No glitch-freedom as a theorem.** MobX uses topological recomputation to avoid most glitches in practice, but cannot derive the property from a denotational definition the way Causl does (`SPEC.md` §3). The benchmark workload #2 (diamond) will quantify whether this matters at scale.
- **No discriminated-union state.** MobX's value types are nominally `T`; Causl's are `Resource = Loading | Loaded | Stale | Errored`. The type system carries the lifecycle.
- **No statechart-modeled lifecycle.** MobX's `keepAlive`/`requestObservation` story for derived values is not formalized; Causl's per-node sub-statechart is.

We expect MobX to be the closest competitor on workloads 1, 6, and 7 (linear, batch, equality cutoff), and Causl to lead on workloads 2, 3, 4, and 5 (diamond, scrolling viewport, dynamic-dep, async race) where the architectural differences pay for themselves.

## What Each of Them Does Better

**Jotai** does small global state with the smallest install footprint. If your app has fifteen pieces of UI state and no dependency graph worth talking about, Jotai is the right answer and we will not pretend otherwise. The migration guide in this repo (`docs/migration/from-jotai.md`, Adoption Epic F) exists precisely for the case where you started with Jotai and grew into the complexity Causl is designed for.

**Redux Toolkit** does explicit auditable mutations with industry-standard DevTools and the largest hiring pool of developers who already know it. Time-travel debugging in Redux DevTools is the single best debugging experience in the React state-management ecosystem, which is exactly why we built `@causljs/devtools-bridge` (Adoption Epic D) to plug into the same protocol.

**MobX** does ergonomic reactive objects in the smallest amount of user code. `makeAutoObservable(thing)` is one line; the equivalent Causl code defines inputs and derived selectors explicitly. If terse object-oriented mutation is the goal, MobX is the right answer and we will not pretend otherwise.

**TanStack Query** (not on the chart but worth naming) is the gold standard for server-state cache. It is not a general state engine, and Causl's `@causljs/sync` adapter is intentionally narrower: it owns the *integration* of async resources with the dependency graph, not the cache, dedupe, refetch, and focus-revalidation story that TanStack Query owns end-to-end. The two compose; one does not replace the other.

## Methodology Notes

All in-process benchmarks run on Node.js `[TBD]` with `--expose-gc` to enable forced GC cycles between samples. tinybench is configured for 200ms warm-up, 1000 iterations, and median reporting; the noise floor is computed from 30 runs of a no-op benchmark and reported alongside every result. DOM benchmarks run in Playwright `[TBD]` against Chromium `[TBD]` with `--enable-precise-memory-info`, `--js-flags="--expose-gc"`, and a fresh user data directory per run. Every library's bundle is the latest stable as of the run date, captured in `report/run-metadata.json` along with the resolved version numbers, the OS and CPU model, the Node version, the React version, and the git SHA of `packages/bench/`.

We do not measure code-splitting, lazy-loading, or service-worker assets. We do not measure SSR (the SSR sub-issue in Adoption Epic B will produce a separate result table once `<Hydrate>` ships). We do not measure RSC. We do not measure the React Compiler — every library is benchmarked under the same compilation pipeline, with and without the compiler, and both numbers are reported.

The DOM-rendering benchmarks count dropped frames using the [`requestAnimationFrame` delta technique](https://web.dev/articles/rendering-performance) — a frame is "dropped" when the delta between consecutive `rAF` callbacks exceeds 16.67ms × 1.5 (so transient ~1-frame stalls are tolerated; sustained jank is counted). We use the 1.5× multiplier instead of 2× because we want to measure perceptible jank conservatively, not just paint failures.

### Determinism + baseline regression

Two test invariants in `packages/bench/test/runAll.test.ts` defend the bench's headline claims at the unit-test layer:

1. **Replay determinism (SPEC §15.2).** Running every (library × canonical scenario) cell twice at scale=100 must produce identical integer counters (`glitches`, `notifications`, `recomputes`). Wall-clock fields are excluded — they are noisy by definition. This catches accidental nondeterminism inside any harness before it ships.
2. **Counter baseline.** A committed `packages/bench/fixtures/baseline.json` pins the three integer counters per cell exactly. A regression that silently flips a comparator from per-dispatch to per-frame notifications is a test failure, not a silent chart drift. Runtime is checked as a soft 3× ceiling against the baseline median (only for cells whose baseline median exceeds 1ms — sub-millisecond noise has no signal); the integer counters are exact.

**Refresh procedure** when an intentional engine change moves the counters: regenerate the baseline and commit it in the same PR as the change.

```sh
pnpm --filter @causljs/bench exec tsx test/regen-baseline.ts
git add packages/bench/fixtures/baseline.json
```

Larger scales (1k / 10k / 100k) are not enforced at the unit-test layer — running the full 4 libs × 7 scenarios × 100k matrix on every PR is a denial-of-service attack on CI. Larger-scale regressions are caught by the comparative bench job (`tools/bench/run-bench.py`), whose dashboard refresh is committed to `causl-org/pages/benchmarks/history.json`.

### Reproducer pipeline — the default (#1552)

`tools/bench/run-bench.py` is a **multi-step pipeline orchestrator**. A bare invocation

```
python3 tools/bench/run-bench.py
```

runs, by default, ALL benchmarks for ALL libraries AND engines — **including `causl-wasm`** — and then refreshes the dashboard so a reload shows the latest data. The steps, in order:

1. **`bench:report`** — the 4-library full default sweep (`causl-ts` / `jotai` / `redux-toolkit` / `mobx` × all SCENARIOS × scales ≤ 10k, `enforceQuiescentMachine()`). Writes `packages/bench/report/*` and self-appends one run to `packages/bench/report/benchmark_history.json`. This step runs inside the pinned Docker image (below) unless `--no-docker`.
2. **`bench:cross-library-all`** — the REAL serde-wasm `causl-wasm` all-scenarios sweep (#1538 part-3). It is detached-capable, checkpointed, resumable and **honest-DNF**: a GC-livelocked / timed-out cell is recorded as a DNF in `packages/bench/report/cross-library-all-scenarios.checkpoint.json` and the sweep **continues** — it is **never fabricated, estimated, or extrapolated**. A DNF is therefore **not** a launcher failure (it is the correct #1525-demonstrating outcome); the pipeline proceeds. A re-run resumes from the checkpoint. This step runs on the host even in Docker mode so its OS-level SIGTERM→SIGKILL wall-clock kill (the #1525-honest DNF mechanism) is not swallowed by the container.
3. **publish converters** — `bench:publish-all-scenarios` (the #1538 part-3 `causl-wasm` converter: OK cells AS-IS, DNF honestly excluded — **no fake bar**) followed by `bench:publish-cross-library` (the #1536 5-cell `causl-wasm`/`causl-ts` converter). Both append to the git-tracked `causl-org/pages/benchmarks/history.json`, which the dashboard fetches with `cache:'no-cache'` on every page load.

Net: after a default run the local dashboard history.json is refreshed, so a **local** dashboard reload renders the latest 4-library + `causl-wasm` data. The runner does **not** auto-commit/push (side-effecting; out of a benchmark runner's remit) — it prints the explicit next step: commit `causl-org/pages/benchmarks/history.json` to `dev` to surface the refreshed data on the deployed dashboard.

**Honest scope (non-negotiable).** `causl-wasm` is ~720 ms/op, GC-livelock-prone (#1525) and its full sweep is multi-hour. That cost is the deliberate trade — the launcher does **not** fabricate, shortcut, or fake `causl-wasm` results to make it fast. `causl-wasm` medians are emitted **AS-IS** (~85–390× slower than `causl-ts` by design — see the #1133/#1525 dashboard callout). The #1133 median-falsification framing **stands**.

### Opt-out: skipping the `causl-wasm` engine sweep

The default includes `causl-wasm` (the explicit ask). For contributors who do not want the multi-hour DNF-prone sweep, the escape hatch — mirroring the `--no-docker` philosophy — is:

```
python3 tools/bench/run-bench.py --no-wasm      # JS engines only
python3 tools/bench/run-bench.py --engines js   # alias of --no-wasm
```

`--no-wasm` / `--engines js` skips step 2 (the `bench:cross-library-all` sweep) **and** the part-3 `causl-wasm` publish; the 4-library sweep + the #1536 publish still run, so the dashboard still carries the 4-library data plus any previously published `causl-wasm` run.

### Reproducer Docker image

The `bench:report` step (step 1) runs inside a pinned Docker image (`tools/bench/Dockerfile`) by default. The image pins the Node major version (selected via `--node`, currently 20 / 22 / 24), pins pnpm via corepack, and defaults `NODE_OPTIONS=--expose-gc` so the bench's typed `MissingExposeGcError` never fires inside the official image. The launcher builds the image on first invocation; subsequent runs reuse the cached tag (`causl-bench:node<major>`). The repo is bind-mounted at `/work` and the lockfile is the source of truth — `node_modules` is not baked into the image. The `causl-wasm` sweep and the publish converters always run on the host (step 2's wall-clock kill must not be swallowed by the container; step 3 is pure JSON I/O).

The host-mode path (`--no-docker`) is preserved for contributors without Docker, but host-mode numbers do **not** carry the reproducibility guarantee. Published numbers in this article are produced by the Docker path; PR-time bench reruns should match it.

Other flags: `--seed <n>` is forwarded as `CAUSL_FUZZ_SEED` to every pnpm step (and via `-e` into the Docker step) for deterministic fast-check. `--out <path>` ALSO copies the refreshed dashboard history.json to `<path>` for snapshotting (the canonical `causl-org/pages/benchmarks/history.json` is always refreshed in place regardless of `--out`).

### Reproducer exit codes

`tools/bench/run-bench.py` returns a typed exit code so CI scripts can branch on the failure class instead of pattern-matching log lines. The contract is pinned in code and exercised by `tools/bench/test_run_bench.py`.

| Code | Meaning |
|---:|---|
| `0` | Success — the dashboard `causl-org/pages/benchmarks/history.json` is refreshed (and copied to `--out` if given) |
| `10` | Config / usage error (unsupported `--node`, negative `--seed`, unknown `--engines` value, etc.) |
| `11` | The 4-library `bench:report` step failed (`pnpm --filter @causljs/bench bench:report` exited non-zero). The child's actual returncode is logged on stderr; the launcher always returns `11` so the typed boundary stays unambiguous. |
| `12` | The refreshed dashboard `history.json` is unreadable / not a non-empty JSON array |
| `13` | `--out` snapshot write failed (disk full, permission denied) |
| `14` | Docker invocation failed (`docker` not on `PATH`, daemon unreachable, image build failed) |
| `15` | A publish converter step failed (could not refresh `causl-org/pages/benchmarks/history.json`) |
| `20` | Environment guard failed (CPU governor wrong, host probe failed, etc. — slot reserved for forthcoming guards) |

The `bench:cross-library-all` step is honest-DNF **by contract**: a non-zero / partial state (a GC-livelocked or SIGKILL'd cell) is **not** mapped to a hard exit — the pipeline logs it and proceeds to publish whatever OK + already-checkpointed cells exist (DNF cells stay honestly absent — **never** a fabricated bar). This is the correct #1525-demonstrating outcome, not a failure.

The launcher deliberately does not propagate the child's raw returncode — a child's `1` would collide with launcher-level failures and CI could not branch reliably. The original code is always written to stderr for operator forensics.

Source code for all benchmarks lives in [`packages/bench/`](https://github.com/iasbuilt/causl/tree/main/packages/bench). The benchmark can be reproduced via `python tools/bench/run-bench.py` (default: full 4-library + `causl-wasm` pipeline). Result history is committed to `packages/bench/report/benchmark_history.json` per release and the dashboard feed to `causl-org/pages/benchmarks/history.json`; SVG charts are regenerated on every nightly CI run and stored at `packages/bench/report/chart_*.svg`.

## Per-PR Perf-Evidence Protocol (#679 / #997 / #1011)

Every PR that touches a perf-sensitive code path in
`packages/{core,react,sync}/src/**` must attach the evidence described
below. This protocol is **mandatory**, not advisory: the #679 perf
experiment umbrella (closed with 22/22 sub-issues complete, including
the scrolling-viewport 654× regression resolution — see "Current
state" callout below) pinned it as a closing condition for every
child issue, and the CI gate
`.github/workflows/perf-delta-template.yml` (#867) enforces the
structured Perf-delta block in the PR body. The narrative protocol
below is the canonical version; the PR template's checklist line (per
`.github/PULL_REQUEST_TEMPLATE.md`) cross-links back here so authors
do not have to reverse-engineer it.

**Current state (as of v0.9.0).** The #679 umbrella has closed; the
canonical-7 cells that motivated it have all returned to healthy
medians. `scrolling-viewport × 10000` regressed to 5.43 ms × 654×
during the perf-experiment wave and has since been restored to its
post-fix steady state (the freeze-impact run in the §freezeIfDev
section captured the default-on cell at 3.00 ms median).
`equality-cutoff × 10000` sits at 1.36 ms post-PRs #1000-#1002, a
~6.4× gap to mobx — down from the pre-#1000 ~9× ratio. Despite the
umbrella closing, the per-PR protocol below remains mandatory for
every PR touching a perf-sensitive path; the post-Rust-epic #1133
plan re-tightens the regression gate (see §"CoV-regression delta
widening" below) but does not relax this evidence contract.

The bench package ships three CLIs that produce the artefacts the
protocol names: `bench:report` (full sweep + JSON), `bench:diff`
(per-cell median Δ% + CoV table) and `bench:gate` (regression gate
keyed off `packages/bench/fixtures/regression-baseline.json`).
`bench:baseline:refresh` regenerates the composition-shift baselines
that `bench:check-hypotheses` consumes. See `packages/bench/README.md`
for the per-CLI surface; this section is the umbrella protocol that
tells you _when_ to run them and _what_ to attach.

### Two baseline systems (composition-shift vs regression-gate) (#1041)

The bench package maintains **two distinct baseline systems** with
confusingly-overlapping names. They live in different files, are
refreshed by different commands, and gate against different
properties of the bench output. Picking the wrong one will silently
no-op — refreshing the regression-gate baseline does **not** update
the composition-shift baseline, and vice versa.

| System | File path | Refresh command | Gates against |
|---|---|---|---|
| Composition-shift | `packages/bench/report/baselines/<scenario>-<scale>.top-n.json` | `pnpm --filter @causljs/bench bench:baseline:refresh` | Top-N hot-symbol distribution per `causl-hypotheses.ts` invariants |
| Regression-gate | `packages/bench/fixtures/regression-baseline.json` | (capture `pnpm bench:report` output, see workflow) | Whole-cell median/p95/stddev/CoV per `regression-gate.ts` |

**When each fires.** The composition-shift baseline is consulted by
`pnpm --filter @causljs/bench bench:check-hypotheses` — it compares the
current run's top-N self-time symbols against the committed top-N and
flags previously-cold symbols that have entered the hot set. The
regression-gate baseline is consulted by `pnpm --filter @causljs/bench
bench:gate` (invoked from `.github/workflows-disabled/bench-gate.yml`)
— it compares the current run's whole-cell median / p95 / stddev /
CoV against the committed `regression-baseline.json` and fails when a
cell regresses beyond its per-cell threshold.

**Refresh procedure** for each:

- **Composition-shift:** run `pnpm --filter @causljs/bench
  bench:baseline:refresh [<scenario> <scale>]`. The CLI captures
  N=5 trials, takes the median top-N, and writes
  `report/baselines/<scenario>-<scale>.top-n.json`. Source:
  `packages/bench/src/hypotheses/baseline-cli.ts`.
- **Regression-gate:** run `pnpm --filter @causljs/bench bench:report`,
  then commit the produced `benchmark_results.json` over the existing
  `packages/bench/fixtures/regression-baseline.json` (the workflow at
  `.github/workflows-disabled/bench-gate.yml` shows the gate
  invocation that consumes this file).

#### CoV-regression delta widening (#1149)

PR #1149 widened `COV_REGRESSION_DELTA` from 0.03 to 0.08 to absorb
V8 Scavenge noise on flapping cells; the constant is exported from
`packages/bench/src/regression-gate.ts`. The widening pairs with a
per-scenario CoV-ceiling override map
(`SCENARIO_COV_FAIL_THRESHOLD_OVERRIDE`) that elevates the absolute
ceiling for five cells whose inherent jitter at the bench's current
sample count sits above the default 10%:

| Scenario | Per-scenario CoV ceiling |
|---|---:|
| `op-derived-create-1k-fresh` | 0.25 |
| `op-tx-set-isolated-1k` | 0.25 |
| `equality-cutoff-fanout-10k` | 0.30 |
| `equality-cutoff` | 0.30 |
| `scrolling-viewport` | 0.25 |

The regression-delta gate (CoV growth vs baseline) still fires on
real regressions — a doubling (8% → 20%) or sustained drift (20%
baseline → 30% current) both exceed the widened 8pp delta. The
override map only widens the *absolute* ceiling; the
regression-delta gate keys off baseline-relative growth.

**Current state (as of v0.9.0).** The widening is intended as a
post-0.9.0 stopgap. The post-Rust-epic #1133 plan re-tightens
`COV_REGRESSION_DELTA` back to 0.03 once the Rust engine ships and
the per-iteration noise envelope drops out from under V8's
Scavenge-class jitter; the GO/NO-GO criteria for that re-tightening
are documented in the epic body. Per-scenario overrides will be
re-evaluated cell-by-cell against the post-Rust noise floor.

### Required artefacts (every perf-touching PR)

1. **`before.json`** — `pnpm --filter @causljs/bench bench:report` JSON
   captured against the merge base (or another pre-fix commit on
   `main`), committed alongside the PR's source changes. The file
   path must be referenced in the PR body so reviewers can re-diff
   without re-running the sweep.
2. **`after.json`** — the same JSON captured after the engine change
   is applied, also committed. The two artefacts together are the
   load-bearing evidence; one without the other is not acceptable.
3. **`bench:diff` table in PR body** —
   `pnpm --filter @causljs/bench bench:diff before.json after.json`
   emits a Markdown table with median Δ%, p95 Δ%, CoV, and a
   significance flag per affected cell. Paste it verbatim into the PR
   body; reviewers anchor the §17.1 audit on this table.
4. **`bench:gate` green** —
   `pnpm --filter @causljs/bench bench:gate
    packages/bench/fixtures/regression-baseline.json after.json`
   must exit zero. CI runs this against the committed baseline; an
   intentional engine change that moves a cell beyond gate threshold
   refreshes that baseline _in the same PR_.
5. **Per-cell acceptance threshold cited (vs panel-estimated)** — the
   PR body must quote the per-cell threshold the change is held to,
   sourced from `SCENARIO_THRESHOLD_PCT` in
   `packages/bench/src/regression-gate.ts` (or
   `DEFAULT_THRESHOLD_PCT = 10` for cells without a per-scenario
   row), and tick whether the measured Δ% beat it. Adjective-only
   commitments ("fast", "much better") do not satisfy this row;
   panel-estimated thresholds without a single-number per-cell
   citation do not satisfy it either. Issues that do not define a
   threshold cannot merge under #679's exit-criteria contract.
6. **Profile artifact (`.cpuprofile`) for the headline-win cell** —
   the cell the PR claims as its headline win must ship a CPU
   profile (`.cpuprofile`, `prof.txt`, or 0x flame) attached to the
   PR or committed under `packages/bench/report/profiles/<pr>/`. The
   profiling layer is documented at `docs/profiling.md`; the
   driving env contract is `LIB=…` `SCN=…` `N=…`. A "headline win"
   without a profile artefact is unfalsifiable — reviewers cannot
   distinguish a real architectural drop from a measurement artefact.
7. **`bench:check-hypotheses` post-PR run** — refresh the
   composition-shift baselines via
   `pnpm --filter @causljs/bench bench:baseline:refresh
    [<scenario> <scale>]` after any PR that intentionally reshapes
   the engine's hot path; commit the new top-N baseline alongside
   the PR. See `packages/bench/README.md` §"Per-PR perf evidence" for
   the per-CLI surface.
8. **Quiescent-machine capture (NEW per #1040; enforced per #1050;
   extended per #1082)** — every contention-sensitive bench capture
   must run on a quiescent machine — no parallel `bench`,
   `bench:report`, no `cargo build`, no `wasm-pack build`, no
   `vitest run`, no concurrent agent bench invocations. The
   regression-gate (#706a) anchors on per-cell median / p95 / stddev
   / CoV; the composition-shift gate (#874) anchors on top-N
   self-time distributions sampled at 100 µs intervals; CPU
   contention shifts both 10–40% off real, flipping PASS cells to
   regressions and INVALIDATING the catalogue for environmental
   reasons. **As of #1050 / #1082 this is no longer operator
   discipline alone** — the precondition is enforced at script entry
   on every contention-sensitive bench CLI:

   | CLI | Driver | Gate landed in |
   |---|---|---|
   | `bench:profile:cpu` | `src/profile/run-cpu-prof.ts` | #1050 / PR #1057 |
   | `pnpm bench`        | `src/run.ts`                  | #1082 |
   | `bench:report`      | `src/report.ts`               | #1082 |
   | `bench:gate`        | `src/regression-gate-cli.ts`  | #1082 |

   Each driver runs `ps -e -o pid,command` at startup, greps for
   `pnpm|tsx|cargo|wasm-pack|vitest|node` (excluding its own
   PID/PPID and any cpu-prof / cell-worker inner re-spawn), and
   `process.exit(1)`s with a clear error naming the conflicting
   processes before doing any contention-sensitive work. Inner-mode
   children (`BENCH_PROFILE_CPU_INNER=1`, `BENCH_CHILD_HARNESS=…`)
   skip the gate — the outer parent has already enforced it, and
   the child's own `ps` row would self-match.

   **#1120 hardening.** The original implementation used a
   `\bnode\b` regex against the full command line, which
   false-positived on Electron app command lines that embed `node`
   as a substring in flags like `--enable-node-leakage-in-renderers`
   (Discord, Slack, VS Code), and used a single-step (pid + ppid)
   exclusion that missed grandparent shells / pnpm wrappers on
   macOS dev hosts. PR #1120 anchored the regex to the executable
   basename (`/(?:^|\/)(pnpm|tsx|cargo|wasm-pack|vitest|node)(?=\s|$)/`,
   exported as `CONTENTION_PROCESS_REGEX` from
   `packages/bench/src/profile/contention.ts`) and walks the full
   ancestor PID chain via repeated `ps -o ppid= -p <pid>` so the
   gate self-excludes the entire launcher tree (`zsh → pnpm → pnpm
   child → tsx`).

   The `bench:gate` CLI is included in the gated set even though
   it is a pure file comparison (`baseline.json` vs `current.json`)
   because invoking it during a contention window almost always
   indicates the operator is in the middle of a stability trial
   whose `current.json` was just captured under contention — the
   #1074 failure mode where three sibling agents (#1064 cargo,
   #1065 vitest, #1075 lint) ran concurrently while the gate fired
   and silently validated distorted numbers. The CI workflow that
   compares two static JSON files on a contended CI runner (with
   parallel jobs) opts in via `BENCH_PROFILE_ALLOW_CONTENTION=1` —
   the same diagnostic-only escape hatch as the other gates
   (mirrors PR #1029's `LONG_RUN_NO_GATE=1` precedent for the
   heap-slope gate). CI and nightly captures must leave the
   bypass unset so a contended host fails loudly instead of
   silently producing distorted artefacts.

   #1040 records the post-wave 20-agent merge contention that
   drove `linear-chain × 1000`, `diamond × 1000`, and
   `scrolling-viewport × 10000` to INVALIDATE on main; the
   recapture under quiescent conditions restored 19/19 PASS
   without any engine change. #1050 made the precondition
   enforceable for `bench:profile:cpu`; #1082 extends the same
   guard to `bench:report` and `bench:gate` so the broader
   per-PR perf-evidence chain cannot silently capture under
   contention either.

### V8-inlining discipline (NEW per #1007)

PRs #1000 / #1001 / #1002 each landed architectural cleanup whose
panel-estimated gains were ~7× too optimistic. The post-wave audit
(#1007) traced the gap to a measurement-discipline failure, not a
modelling failure: V8 inlines hot Map probes to ~5–10 ns and
amortizes geometric `.push()` growth far below what hand-rolled cost
models predict. **The lesson is mechanical**: when a panel's
predicted per-op gain is _less than 10× the V8 inlined-Map probe
cost_ (~5–10 ns — i.e. predicted gain < ~50–100 ns/op), the
hand-rolled cost model is unreliable on its face.

The discipline that closes the pattern:

- **Microbench A/B BEFORE the engine PR, not after.** The microbench
  layer (`microbench: true` scenarios in `scenario.ts` —
  `op-tx-set-equal-1k`, `op-tx-set-isolated-1k`,
  `op-commit-rollback-1k`, `op-derived-rollback-1k`,
  `op-tx-shadow-read-1k`, …) measures the
  fast-path under V8's actual inlining behaviour, not the panel's
  arithmetic. If the predicted gain is < 10× the V8 inlined-Map
  probe cost, run the microbench A/B against a draft engine change
  (or a trivially-shaped harness fixture) and confirm the predicted
  drop _measures_ before opening the engine PR. Authors who skip
  this step and merge on panel-arithmetic alone are systematically
  shipping cleanup that does not produce the headline win they
  cited.
- **Inline-Map probes are the dominant constant.** When the change
  trades one Map probe for another shape — a pair of probes, an
  array push, a `Set.has`, a closure allocation — the cost
  difference per op is dominated by the V8 inlining state, not by
  the algorithmic shape. The microbench A/B is the only honest way
  to measure this on the host runtime; CPU-profile self-time at
  scale-1k bench cells is dominated by harness wiring, not the
  mutated code path.
- **The ledger is durable.** The negative-findings ledger in
  `packages/bench/src/hypotheses/causl-hypotheses.ts` (near the top
  of the file) records #1000 / #1001 / #1002 as the load-bearing
  precedent. Future panels proposing perf cleanup at predicted
  gains under the inline-probe cost are expected to cite the ledger
  and run the microbench A/B before merging the engine PR.

The discipline is keyed to the predicted-gain threshold deliberately:
changes whose predicted per-op gain is well above ~50–100 ns (e.g. a
quadratic→linear collapse on a hot scenario) are not subject to the
A/B-first rule because the inlining-probe cost is no longer the
dominant constant. The rule fires for the cleanup-class changes that
trade one shape for another at constant-factor magnitudes — exactly
where #1000 / #1001 / #1002 each missed.

### Where each artefact lives

| artefact | typical path |
| --- | --- |
| `before.json` / `after.json` | `packages/bench/report/<pr>/{before,after}.json` |
| `bench:diff` table | inline in PR body (verbatim Markdown) |
| `bench:gate` invocation | `packages/bench/fixtures/regression-baseline.json` vs `after.json` |
| Per-cell threshold | quoted from `SCENARIO_THRESHOLD_PCT` (`packages/bench/src/regression-gate.ts`) |
| Profile artefact | `packages/bench/report/profiles/<pr>/<cell>.cpuprofile` (or attached) |
| Composition-shift baselines | `packages/bench/report/baselines/<scenario>-<scale>.top-n.json` |
| Microbench A/B (V8-inlining gate) | `op-*` cell entry in `bench:diff` table; pre-engine-PR run |

### Cross-links

- PR template — `.github/PULL_REQUEST_TEMPLATE.md` carries the
  Perf-delta block and a checklist entry pointing back to this
  section.
- Contributor walkthrough — `docs/contributing-perf.md` shows how
  to fill the structured Perf-delta block field by field, with PR
  #854 as a worked example.
- Profiling drivers — `docs/profiling.md` covers the three profiling
  layers (`prof:sampler`, `profile:flame`, `profile:heap`) plus the
  IC / deopt surfaces from #763.
- Bench package surface — `packages/bench/README.md` carries the
  per-CLI table (`bench:report`, `bench:diff`, `bench:gate`,
  `bench:baseline:refresh`, `bench:check-hypotheses`) and points
  back to this canonical protocol.

## Mixed-editor op-mix sourcing (#744)

The `mixed-editor-60s-seed42` scenario (#710) drives a 5k-node graph with a deterministic seed-42 PRNG op stream over five op classes — read, input-write, subscribe, derived-create, dispose — at the proportions 40 / 30 / 15 / 10 / 5 %. Those proportions are characteristic of UI editor workloads in the literature (read-dominant, with write traffic the next largest class and lifecycle ops trailing), but they are **provisional** until pinned to a real adopter action-trace.

This section documents the sourcing search performed under #744 so the provisional label is auditable rather than folk wisdom.

### What we looked for

A public, reproducible op-trace from a non-trivial UI adopter that projects onto the five reactive-graph op classes the scenario exercises. The audit suggested three avenues:

- **(a)** Redux DevTools action-trace export from a real adopter (Excalidraw, tldraw, Figma's Liveblocks demo).
- **(b)** MobX-state-tree telemetry from an adopter willing to share.
- **(c)** Existing source — React Profiler datasets, rxmarbles workload corpus.

### Searches performed

- **Excalidraw.** Repository search and issue tracker scan for committed Redux/state action-trace exports. The performance-relevant issues — [#7943](https://github.com/excalidraw/excalidraw/issues/7943) (introduce performance tests), [#7280](https://github.com/excalidraw/excalidraw/issues/7280) (degradation with large drawings), [#8136](https://github.com/excalidraw/excalidraw/issues/8136) (poor performance at high element counts), [#8625](https://github.com/excalidraw/excalidraw/issues/8625) (eraser perf) — discuss benchmarking infrastructure but do not publish op-stream traces. No checked-in traces were found.
- **tldraw.** Repository scan for benchmark / trace artifacts. The [`tldraw/tldraw#5759`](https://github.com/tldraw/tldraw/issues/5759) "Add benchmark feature in debug menu" issue is open and proposes a benchmark API; the [`tldraw/tldraw#8082`](https://github.com/tldraw/tldraw/issues/8082) "Move tests to closed source repo" issue indicates the benchmark/test workload is not public. No published op-mix trace.
- **Figma / Liveblocks.** [Liveblocks blog "Understanding sync engines"](https://liveblocks.io/blog/understanding-sync-engines-how-figma-linear-and-google-docs-work) and [Figma's "Keeping Figma Fast"](https://www.figma.com/blog/keeping-figma-fast/) describe sync architecture and benchmarking methodology, but neither publishes a downloadable action-trace at op-class granularity. The "Benchmark Canvas" Figma community files are scene fixtures, not action logs.
- **MobX-state-tree.** No published telemetry corpus from an MST adopter was found in repository or issue-tracker scans, and we have not yet onboarded an MST adopter willing to share.
- **React Profiler datasets.** [`reduxjs/react-redux-benchmarks`](https://github.com/reduxjs/react-redux-benchmarks) and [`krausest/js-framework-benchmark`](https://github.com/krausest/js-framework-benchmark) define synthetic table-mutation workloads (create / update / swap / select / remove rows) — they exercise framework throughput, not the read / write / subscribe / derive / dispose op space, and they do not publish empirical op-class proportions.
- **rxmarbles workload corpus.** [rxmarbles](https://rxmarbles.com/) ([staltz/rxmarbles](https://github.com/staltz/rxmarbles)) is an interactive marble-diagram explorer, not a workload corpus. No empirical operation distribution is published.
- **Reactivity benchmarks.** [`milomg/js-reactivity-benchmark`](https://github.com/milomg/js-reactivity-benchmark) configures synthetic dependency graphs with adjustable graph shape, density, and read rate; the percentages in its scenario names (`lazy80%`, `dyn5%`, etc.) are configuration knobs, not measurements from real adopters.
- **CRDT / collaborative-editor traces.** [`automerge/automerge-perf`](https://github.com/automerge/automerge-perf) and [`dmonad/crdt-benchmarks`](https://github.com/dmonad/crdt-benchmarks) publish character-level edit traces (insert / delete / move-cursor — Kleppmann's automerge-perf trace contains 182,315 insertions, 77,463 deletions, 102,049 cursor moves over a single LaTeX paper). These are well-curated and reproducible, but the operation alphabet is a 3-class character-edit space, not the 5-class reactive-graph op space (`read` / `write` / `subscribe` / `derived-create` / `dispose`) the scenario tests. They cannot be projected onto our op classes without an arbitrary mapping that would manufacture a false empirical anchor.
- **Academic / industry literature.** Searches for empirical workload characterisations of state-management read/write/subscribe ratios in front-end applications (ACM / IEEE / arXiv via web search) returned no quantitative paper. The closest relevant work is on storage-system read/write ratios (different domain, different op alphabet) and on CRDT convergence benchmarks (text-edit alphabet).

### Outcome

**No public adopter trace exists in the 5-class op space the scenario tests.** The 40 / 30 / 15 / 10 / 5 split is retained as a literature-typical read-heavy editor profile, with the **provisional** label preserved in code (`packages/bench/src/expansion/mixed-editor.ts`), in the scenario description (`packages/bench/src/scenario.ts`), and in the test that gates the proportions (`packages/bench/test/expansion/mixed-editor.test.ts`, `±3pp` tolerance at N=50,000).

Refresh procedure when an adopter trace lands:

1. Compute empirical op-class proportions from the trace (must total 100%, must cover all five classes; treat any unmapped op as `read` and document the mapping in the trace's commit).
2. Update `OP_MIX_CUMULATIVE` in `packages/bench/src/expansion/mixed-editor.ts` and the scenario description in `packages/bench/src/scenario.ts`.
3. Update the test bounds in `packages/bench/test/expansion/mixed-editor.test.ts` (preserve the `±3pp` tolerance unless the trace warrants tighter gating).
4. Cite the trace source (URL + git SHA + date) in this section, replacing the "no public corpus" finding with the new anchor.
5. Bump the seed only if the op alphabet itself changes; a proportion shift inside the existing alphabet is the same scenario at new weights.

The seed-42 suffix in the scenario name is load-bearing: it pins the PRNG seed at the contract layer so cross-run comparison is deterministic. A weight refresh under the same op alphabet keeps the scenario name; an alphabet expansion (e.g., adding a `commit-batch` class) is a new scenario, not a re-roll.

## Cold-start (#713a)

A separate measurement run via `pnpm --filter @causljs/bench cold-start` spawns 50 fresh Node child processes per library; each spawn imports the library, builds 10 inputs + 5 derivations, commits once, and waits for the subscriber callback to fire. Wall is measured from the spawned process's first line through to the callback.

**This is documentation, not a SPEC gate.** SPEC §14.1 explicitly rejects percentile-ms thresholds without a stable shared runner — cold-start is published as adopter-visible information so teams choosing a library can see the bare-import-to-first-callback cost on a representative dev machine.

Cold-start numbers depend heavily on hardware (M1/M2 ≪ x86 CI runner) and Node version; the fresh-process spawn is the only honest way to exclude warm code-cache effects. Re-run `pnpm --filter @causljs/bench cold-start` on your own hardware to compare against your target deployment environment. The harness lives at `packages/bench/src/cold-start/`; per-library mini-scripts for causl, jotai, redux, and mobx are committed alongside the driver.

### Headline (50 spawns × 4 libraries)

Captured via `pnpm --filter @causljs/bench cold-start --spawns 50` on:

- **Hardware:** Apple Silicon M-series (Apple M5, arm64), macOS 25.4.
- **Runtime:** Node.js v25.9.0 (Node 25.x), pnpm 10.33.2.
- **Date:** 2026-05-07.

| library | n | median (ms) | p95 (ms) | p99 (ms) | min | max |
| --- | --- | --- | --- | --- | --- | --- |
| causl | 50 | 9.92 | 17.10 | 24.13 | 7.03 | 24.13 |
| jotai | 50 | 17.90 | 39.25 | 87.75 | 10.40 | 87.75 |
| redux | 50 | 17.46 | 35.49 | 45.01 | 12.48 | 45.01 |
| mobx  | 50 | 18.12 | 23.45 | 25.97 | 13.95 | 25.97 |

These are dev-machine numbers, not CI numbers; reproduce on your own hardware before quoting them. The mini-scripts that produce each row are intentionally tiny (10 cells + 5 derivations + one mutation + first subscriber tick) so the import-and-first-update path dominates and harness cost is minimised. Causl's lead at the median row reflects the fact that its `subscribe()` callback fires synchronously on registration with the initial value — Jotai's `store.sub`, Redux's `store.subscribe`, and MobX's `autorun` all gate their first useful tick on a dispatched write or post-prime fire, which is the comparable shape captured here. The tail rows (p95 / p99) are the more honest signal for adopter machines under load: causl's p99 sits at 24.13 ms while the others' tails extend to 26 / 45 / 88 ms.

## Long-run heap-slope reference (#710 / #748)

The `long-run-1M` scenario drives 1,000,000 sequential commits against a 1k-node diamond fan, sampling `process.memoryUsage()` every 10,000 commits. The acceptance gate is the linear-regression slope of `heapUsed` versus commit index, fitted over post-saturation samples only (`commit ≥ 1000`) — the first ~1000 commits include retention-chain pre-eviction growth which would otherwise contaminate the steady-state estimate. The audit-tightened gate is `≤ 256 B/commit`, down from the original `1 KB/commit` target.

The full 1M-commit run is ~10 min wall (causl-only) and is excluded from the `bench:report` sweep so PR CI stays under budget; jotai / redux / mobx land their long-run cells at the 100k scale per #775 / #781 / #782. The 1M reference run is reproduced by an operator when something changes the long-run retention path (commit-history cap default, retention-chain layout, subscriber dispatch index) via:

```sh
pnpm --filter @causljs/bench bench:long-run-1M
```

The driver lives at `packages/bench/scripts/long-run-1M.ts`; the captured envelope is committed at `packages/bench/report/long-run-1M-causl.json`.

**Reference numbers** (causl, 1M commits, 1k-node diamond fan, captured 2026-05-07; node v25.9.0 on Apple Silicon, `--expose-gc` forced GC at every heap sample):

| Metric | Value |
|---|---:|
| Heap-slope, post-saturation (B/commit) | **10.33** |
| Acceptance gate (B/commit) | ≤ 256 |
| Per-commit median (ms) | 0.572 |
| Per-commit p95 (ms) | 1.455 |
| Per-commit p99 (ms) | 3.656 |
| Total commits | 1,000,000 |
| Wall (ms) | 907,566 |

The **10.33 B/commit** post-saturation slope is comfortably under the 256-byte gate — the long-run retention path is not leaking. The wall-clock figure is shared-machine load-dependent (the captured run shared cores with several other tsx processes); a clean-host run lands closer to the ~10-minute estimate from #748. The per-commit median is the load-bearing number for SPEC §5.1 amendment evidence (#715 / #716): a 1k-node fan in ~0.6 ms median means causl absorbs 1M commits without per-commit envelope blow-up at the default `commitHistoryCap = 0` (#778).

**Driver-side gate enforcement.** As of #710, the driver does not just *report* the slope — it *enforces* the 256 B/commit gate. The captured slope is fed through `evaluateHeapSlopeGate` in `scripts/long-run-1M.ts`; any verdict of `red` (slope > gate, or undefined slope from an unexpected sampling shape) causes the script to exit non-zero so a nightly job fails loudly instead of silently writing a red envelope. The diagnostic-only escape hatch is `LONG_RUN_NO_GATE=1`, which keeps the slope captured and logged but suppresses the non-zero exit; CI must leave it unset. This closes the loop between the unit-tested measurement (`long-run.test.ts`), the leak-injection acceptance test (`long-run.leak-injection.test.ts`), and the operator-driven 1M-commit smoke — a controlled leak now trips the gate at every layer, including the runnable driver.

## freezeIfDev measurement (#755)

PR #732 + #740 landed `freezeIfDev` as an opt-in via the `CAUSL_FREEZE_OFF_IN_PROD=1` env var (or per-instance `experimentalFlags: { freezeOffInProd: true }`). The flag elides the engine's defensive `Object.freeze` calls on inner arrays nested inside frozen Commit / Explanation payloads — public-surface Commit / Explanation objects stay frozen at the outer boundary unconditionally; the flag controls only the inner `changedNodes` and `deps` arrays.

The audit verdict on #702 deferred the default-flip pending measurement: **flip the default only if the measured drop on `scrolling-viewport × 10000` AND `batch-commit × 10000` is ≥ 10%.** This issue (#755) ran the measurement; the numbers below settle the gate.

### Measurement protocol

The two head-to-head runs were executed via `packages/bench/src/freeze-impact-cli.ts` — a focused driver that calls the same `causlHarness.run(scenario, scale)` entry point as `bench:report`, runs only the three audit-named cells (`scrolling-viewport × 10000`, `batch-commit × 10000`, `equality-cutoff × 10000`), and persists results in the same JSON shape as `benchmark_results.json` plus one entry per run in `benchmark_history.json`. The focused driver was chosen because the full `bench:report` sweep takes >30 minutes per run on the audit hardware, dominated by expansion-scenario cells (`spreadsheet-100x100`, `adversarial-fanin-100`) the audit gate does not measure against; running only the three audit-named cells produces the same numbers in seconds.

Each run aggregates the per-cell measurement across 5 trials of n=50 samples each (`BENCH_PROFILE=nightly FREEZE_IMPACT_TRIALS=5`). Aggregate median / p95 / stddev are taken as the trial-medians; CoV = stddev / median. Aggregating 5 trials drops the trial-median's standard error far below the 10% threshold the gate names — a single n=50 stripe's CoV on these cells is 20–30%, not tight enough to detect a 10% effect.

| Run | Mode | Env | Profile | Hardware |
|---|---|---|---|---|
| 1 | freeze on (default) | `CAUSL_FREEZE_OFF_IN_PROD=unset` | `nightly`, n=50 × 5 trials | Apple Silicon M-series, Node 25.9 |
| 2 | freeze off (opt-in) | `CAUSL_FREEZE_OFF_IN_PROD=1` | `nightly`, n=50 × 5 trials | Apple Silicon M-series, Node 25.9 |

### Numbers

| Cell | Metric | Default (freeze on) | Freeze off | Drop % |
|---|---|--:|--:|--:|
| `causl × scrolling-viewport × 10000` | median (ms) | 3.0022 | 3.0435 | **−1.38%** |
| | p95 (ms) | 3.9079 | 3.9780 | −1.79% |
| | CoV | 0.1065 | 0.1374 | — |
| `causl × batch-commit × 10000` | median (ms) | 3.5362 | 3.4081 | **+3.62%** |
| | p95 (ms) | 5.3016 | 4.9962 | +5.76% |
| | CoV | 0.1832 | 0.1985 | — |
| `causl × equality-cutoff × 10000` | median (ms) | 3.0713 | 2.8954 | **+5.73%** |
| | p95 (ms) | 5.2255 | 5.0049 | +4.22% |
| | CoV | 0.2323 | 0.2445 | — |

A positive drop % means freeze-off is faster; negative means freeze-off is slower. Each cell's underlying sample is 5 trials × 50 samples = 250 measured commits at the `step()` boundary, with the graph + subscribers + counter wiring constructed outside the timed region (#721 split). Forced GC fires between samples (`--expose-gc`) so the timed region does not absorb a young-gen pause from the previous iteration.

### Verdict

The audit gate requires **both** `scrolling-viewport × 10000` and `batch-commit × 10000` to drop ≥ 10% to justify the default-flip. The measured drops are −1.38% and +3.62% respectively — both well below the threshold. `equality-cutoff` (the third audit-named cell) is +5.73%, also below.

Per the audit protocol, this measurement **demotes #702 to a small DX-cost cleanup**: the `freezeIfDev` opt-in stays available for adopters running with their own immutability discipline (the per-instance `experimentalFlags: { freezeOffInProd: true }` and process-wide `CAUSL_FREEZE_OFF_IN_PROD=1` continue to work), but the default does not flip in this PR. Flipping the default would trade a small, sub-noise-floor perf win for the loss of a runtime invariant (`changedNodes` / `deps` arrays inside frozen public Commits become silently mutable) — the trade is not justified at the measured magnitude.

The decision to ship the opt-in *and* keep the safe default mirrors the same-shape calls in #715/#716 (commit-history cap default, where the perf measurement justified the change because the measured drop crossed the gate).

### Reproducing

```sh
# Run 1: default (freeze on).
BENCH_PROFILE=nightly FREEZE_IMPACT_TRIALS=5 \
  pnpm --filter @causljs/bench exec tsx --expose-gc \
    src/freeze-impact-cli.ts \
    packages/bench/report/benchmark_results.default.json

# Run 2: freeze off (opt-in).
BENCH_PROFILE=nightly FREEZE_IMPACT_TRIALS=5 CAUSL_FREEZE_OFF_IN_PROD=1 \
  pnpm --filter @causljs/bench exec tsx --expose-gc \
    src/freeze-impact-cli.ts \
    packages/bench/report/benchmark_results.freezeoff.json
```

Both runs append one entry to `packages/bench/report/benchmark_history.json` so the audit trail is preserved alongside the rest of the bench history. The full `bench:report` sweep is still the canonical artefact for regression gating; the focused `freeze-impact-cli.ts` driver exists specifically to measure #755's named cells without paying the expansion-scenario cost.

## What This Benchmark Is Not

This benchmark measures the cost and behavior of state operations under seven specific workloads. It does not measure:

- **Whether you should migrate.** A 2× perf win on workload 4 means nothing if your app never exercises workload 4. Use the workload table to find the workloads you actually have, and read those rows.
- **Developer experience.** Jotai's atom syntax, MobX's proxy ergonomics, Redux's action vocabulary, and Causl's MVU surface are all defensible DX choices, and the benchmark cannot adjudicate between them. Read the migration guides and try the libraries.
- **Production stability.** Jotai, MobX, and Redux Toolkit have shipped to billions of users. Causl is `0.x.y`. The benchmark says nothing about how many production bugs each library has shipped this year.
- **Ecosystem fit.** Redux Toolkit's middleware story, Jotai's ecosystem, and MobX's extensions are not measured here. They are real and they matter.

## Conclusion

Causl is not a replacement for Jotai, Redux Toolkit, or MobX in the apps those libraries already serve well. It is a specialised tool that does one job — transactional state for tangled dependency graphs — and aims to do it `[TBD]`× more efficiently per MB than the closest competitor on the workloads that match its design center, while staying within a `[TBD]` MB envelope of the smallest competitor's bundle. For applications building spreadsheets, asset hierarchies, configuration editors, and operational dashboards where state corruption is data corruption, the numbers in this benchmark — once it runs — translate directly to faster interactions, fewer wrong-data renders, and a system the team can reason about.

The benchmark we promise here is the benchmark we will publish. Until then, the only number on this page that is not `[TBD]` is the one that says we will not publish a number we cannot defend.

---

*Causl is `[TBD-license]`. View on [GitHub](https://github.com/iasbuilt/causl). Benchmark source: [packages/bench](https://github.com/iasbuilt/causl/tree/main/packages/bench).*
