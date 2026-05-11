# Pre-commit checks

> Same checks the CI `ts` job runs, gated locally before each commit so
> green local ≡ green CI.

## What runs

On every `git commit`, the `.husky/pre-commit` hook executes:

1. **`pnpm exec lint-staged`** — ESLint `--fix` on the TS files staged for
   commit. The `lint-staged` config in root `package.json` covers both
   `packages/*/src/**/*.{ts,tsx}` and `packages/*/test/**/*.{ts,tsx}`.
2. **`pnpm typecheck`** — `tsc --noEmit` across every workspace package.
3. **`pnpm test:run`** — `vitest run` across every workspace package
   (includes the property-based suites — default 1000 random cases each;
   tier knobs `CAUSL_FUZZ_TIER` / `CAUSL_FUZZ_TRIALS` per #1073 raise
   that ceiling for the nightly cross-backend lane).

These mirror the three core checks the `ts` CI job runs (see
[`.github/workflows-disabled/ci.yml`](../.github/workflows-disabled/ci.yml)
— note: per PR #725 the main CI workflows currently live in the
`workflows-disabled/` tree; see [`ci.md`](./ci.md) for the current-state
caveat). The intent was adopted from webapp's `validate` script
(`tsc --noEmit && vite build && jest`), adapted for our pnpm + vitest
world; the only difference is the build step runs in CI rather than
per-commit, because building all packages each commit is too slow for
an interactive flow. The root `validate` script (`pnpm typecheck && pnpm
build && pnpm test:run`) reproduces the full sweep when needed.

## First-time setup

The hook installs automatically when you run `pnpm install` — Husky's
`prepare` script wires it into `.git/hooks/pre-commit` for you.

```bash
pnpm install
git commit -m "feat: hello" # hook runs
```

## Bypassing the hook

For genuinely emergency commits (rebasing, fixing CI, dependency tweaks),
add `--no-verify`:

```bash
git commit --no-verify -m "wip: skip hook"
```

Don't make this routine — the hook exists to catch problems before they
hit CI.

## WASM toolchain artefact gate (#1108)

The `packages/bench/test/microbench.test.ts > op-wasm-boundary-1k`
cell consumes a `wasm-pack`-built artefact at
`packages/bench/wasm-stub-pkg/`, which is **gitignored** (correctly —
it's a generated artefact). Producing it requires the Rust toolchain
(`cargo`, `wasm-pack`, `wasm32-unknown-unknown` target). Across the
post-0.9.0 wave (#1073, #1075, #1068, #1064, #1090, #1078, others)
this caused recurring `--no-verify` workarounds on fresh clones.

PR #1108 closed #1098 by shipping Option B (skip-with-clear-error):
`isWasmStubArtifactPresent()` in `packages/bench/src/wasm-stub-loader.ts`
is a non-throwing `require.resolve` probe; `op-wasm-boundary-1k` is
wrapped with `it.skipIf(!available)` and emits a one-line warning with
the build incantation when the artefact is absent. Comparator
throw-tests (jotai/mobx/redux) don't depend on the artefact and run
unconditionally. CI is unaffected — `wasm.yml` builds the artefact as
a setup step before tests run, so the cell still gates in CI when
present.

To enable the cell locally:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
pnpm --filter @causl/bench wasm:build
```

## Speeding it up

The `lint-staged` step only lints staged files. The typecheck and test
steps run full-tree because TS errors and vitest failures often cross
file boundaries. If those become slow, the next steps (in order):

1. **Affected-graph detection.** A `pnpm --filter ...[origin/main]` query
   limits work to packages whose source changed. Cheap; can land first.
2. **Worker-process pooling.** vitest already pools; this matters more
   when packages multiply.
3. **Skip flag for docs-only commits.** `git diff --staged --name-only`
   then short-circuit if every file is `*.md`.

We have not implemented these because the current full sweep finishes in
under 60 s on a warm cache.

## Why `test:run` runs sequentially

The root `test:run` script is wired with
`pnpm -r --workspace-concurrency=1 --reporter=append-only --aggregate-output`
on purpose (see #727). Running every package's vitest pool concurrently
through pnpm `-r` reliably deadlocks one vitest worker on a stdout pipe
when the host is under load (multiple worktrees, low free CPU): the
worker peaks at ~120% CPU and pnpm waits 10–15 minutes before
SIGKILLing the orchestrator. Sequential workspace iteration with
aggregated per-package output makes the wall-clock cost roughly equal
to the concurrent path on a warm cache while removing the cross-sibling
pipe-contention class entirely. Per-package runs
(`pnpm --filter @causl/<pkg> test:run`) remain unaffected and finish in
under a second each.

## Why the bench fork pool is capped at `maxForks: 4` (#1049)

A separate contention class shows up *inside* the bench package's own
vitest pool. The bench suite is the heaviest workspace by a wide
margin — microbench cells drive real 4-library × 1000-iteration sweeps,
the report-streaming observer test walks every non-opt-in scenario,
and the subprocess-runner suite spawns real Node children for
wall-clock kill-grace timing. Pre-#1049 the bench pool ran with
vitest's default `forks` worker count (~ncpu/2; effectively `os.cpus()`
on macOS for unscoped fork pools), so on a 10-logical-CPU dev box
*all eleven test files* would dispatch concurrently. Each fork pegs
~120% CPU on a hot microbench cell, so the scheduler is over-
subscribed by ~2× and individual tests' per-cell wall-clock can
inflate by 4–8× while waiting to be re-scheduled — which is what
exhausted the (former) 5s vitest default and prompted the workaround
PRs (#1029 globally and #1033 per-test).

`packages/bench/vitest.config.ts` now pins
`pool: 'forks', poolOptions.forks.maxForks: 4`. This bounds bench
parallelism below CPU-saturation on every host we run on (CI = 4
logical cores, dev boxes = 8-12), keeps per-test wall-clock close to
the actual work cost, and is *still* faster than `singleFork: true`
(which we measured at 4-5× slower wall-clock on warm cache and is
unnecessary now that the contention floor is gone).

The companion retighten is `testTimeout`/`hookTimeout` back down to
15s in the same config — formerly 30s under #1029, which was a coarse
side-fix that masked any test growing 5s → 25s. Individual tests
whose *actual* work is over 15s (the slowest microbench × redux cell
sits around 12-20s; the report-streaming observer sweep is similar)
carry their own per-test `{ timeout: N }` override and remain
unaffected. The global ceiling exists to catch unintentional cost
inflation in the rest of the suite, not to absorb scheduler jitter
the new pool cap already eliminates.
