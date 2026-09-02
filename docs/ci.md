# CI

## Current state (as of v0.9.0)

Per PR #725, every workflow under `.github/workflows/` was moved into
`.github/workflows-disabled/` on 2025-09 when GitHub Actions runners
became unavailable for the org due to a billing issue (every PR was
failing with `runner_name: ""` and 0-step failures within 11 seconds —
masking real test results). Re-enabling is a `git mv` from
`workflows-disabled/` back into `workflows/`.

The wasm-substrate epic (#680) shipped after PR #725 with three of its
own workflows added directly under `.github/workflows/`, and the split-repo CI
lanes (`main-fast.yml`, `bundle-budget.yml`) were added on top. The older `ts` /
`rust` / `size` / `checker-gate` / `formula-e2e` jobs described below still live
in the disabled tree and do not gate PRs, so the tests they run are not on any
lane; `.husky/pre-commit` and `.husky/pre-push` remain the local safety net for
that half.

Active workflows (root of `.github/workflows/`), as of the 2026-09-02 CI repair
(issues #47, #48, #49):

| File | What it does | Trigger |
| --- | --- | --- |
| `main-fast.yml` | typecheck + build + lint, plus the #31 tarball-consumer regression | PR + push to main |
| `wasm.yml` | `vendored-wasm` (bytes, raw ceilings and target parity of the committed `.wasm`) plus a `bundler-interop` matrix over 3 fixture apps | PR + push to main/release + workflow_dispatch |
| `bundle-budget.yml` | `size-limit` gate over the 11 cells in the root `package.json`, plus the per-PR delta comment | PR + push to main/release + workflow_dispatch |
| `cross-backend-fuzz.yml` | Nightly 100k-trial cross-backend WASM-vs-TS determinism property (#1073 / shipped via PR #1097) | cron `0 4 * * *` + workflow_dispatch |
| `vendor-manifest.yml` | vendored-bytes MANIFEST freshness | paths-filtered PR |
| `release.yml` | npmjs publish via OIDC trusted publishing | `v*` tag |

### Parked 2026-09-02: `four-way-classifier.yml` (#47)

The classifier drives four legs and three of them live in Rust crates that are
not in this repository: `tools/enumerator/diff`,
`tools/engine-rs-bridge-serde` and `tools/engine-rs-bridge-gc`. Every scheduled
run died on the `cargo test` step, which sets `working-directory:
tools/enumerator/diff`:

```
##[error]An error occurred trying to start process '/usr/bin/bash' with working
directory '/home/runner/work/causl-ts/causl-ts/tools/enumerator/diff'.
No such file or directory
```

That is not a build that broke. `git log --all -- tools/enumerator` returns
nothing and there is no `Cargo.toml` anywhere in the tree or in its history, so
those paths have never existed here. The workflow came across with the rest of
`.github/` when this public TypeScript repo was split out of the monorepo and
the crates stayed behind; the Rust engine lives in `causljs/causl-wasm`. It now
sits in `.github/workflows-disabled/` next to `apalache-diff.yml`, which was
already parked for the same missing crate. Reviving it means landing the crates
first.

The rest of this page documents the disabled-but-checked-in CI design
so the workflows can be re-enabled without re-deriving the rationale.
Treat the tables below as the design contract, not the live status.

## Disabled-but-checked-in: PR-gating workflow (`ci.yml`)

Three jobs run on every PR and on every push to `main` when
`.github/workflows-disabled/ci.yml` is re-enabled:

| Job | What it does | Time budget |
| --- | --- | --- |
| `ts` | `pnpm install` + `typecheck` + `build` + `test:run` across all packages, plus the named §14 perf-invariant steps, lint, commitment audits, and the test-d compile-time gate. Runs on a React peer-dep matrix (18.3.1 and 19.0.0 per #261). | ~2 min |
| `rust` | `cargo fmt --check` + `cargo clippy -D warnings` + `cargo build --release` + `cargo test` for `tools/checker` | ~3 min (cold), ~30 s (warm) |
| `size` | `andresz1/size-limit-action@v1` runs the `size-limit` cells in root `package.json` against PR head and merge base, posts a delta-vs-base comment, and fails on overage. Replaces the in-line `pnpm size` step that the `ts` job used to carry. | <1 min |
| `formula-e2e` | Playwright dropped-frame gate for `@causlts/formula`'s 60fps spreadsheet demo (#226 / SPEC §14 perceptual perf). Depends on `ts`. | ~3 min |
| `checker-gate` | Adopter's CI runs the same binary our CI runs — `@causl/checker` resolves the matching `@causl/checker-<target>` `optionalDependency` and execs its prebuilt artefact, the same one we publish from `release-checker.yml`. Locally this job builds the binary in-tree and runs `@causl/checker`'s integration tests against the Phase 3 + Phase 4 demos. Depends on `ts` and `rust`. | <60 s warm (SPEC §16.6) |

## SPEC §14 perf-invariant gates

SPEC §14 lists two correctness-criteria-phrased-as-performance:

1. A commit producing N derived recomputations runs in O(N), not O(graph size).
2. A React component subscribed to one node re-renders only when that node's value changes.

Both are wired as named, PR-blocking steps inside the `ts` job so a
regression surfaces directly on the check list rather than buried
inside the generic `Run tests` step (see #247 for the visibility
argument):

| Step | Backs SPEC §14 bullet | Script |
| --- | --- | --- |
| `perf-invariant — SPEC §14 gate` | #1 (recompute count) | `pnpm --filter @causlts/core run test:perf-invariant` |
| `perf-invariant — SPEC §14 React subscription gate` | #2 (render scope) | `pnpm --filter @causlts/react run test:perf-invariant` |

The React-side step also runs the `family-grid.test.tsx` heap-delta
leg with `CAUSL_HEAP_GATE=1` and `NODE_OPTIONS=--expose-gc` so the
heap-retention assertion produces honest numbers rather than silently
skipping (#389). The env is scoped to this step rather than job-wide
to avoid GC pressure on unrelated specs.

## Required checks (target)

`checker-gate` is the row that pins SPEC §17.8: `causl-check` is a
required green check on every PR. The job depends on `ts` and `rust`,
so failures in either skip it.

## Failure modes

The Rust binary's stdout is JSON; the wrapper raises an error if the
JSON cannot be parsed. The most common operational failures are:

- **Schema mismatch.** The TS engine exported an IR at a schema the
  binary doesn't understand. Action: rebuild the binary or re-run
  `pnpm install` to get the matching version.
- **Bound exceeded.** A test produced a graph larger than the
  `--max-nodes` / `--max-commits` defaults. Action: shrink the test or
  pass higher bounds explicitly.
- **Cycle.** A registered derivation closes a cycle. Action: fix the
  formula / dependency chain.
- **Determinism mismatch.** A commit's `changedNodes` references a
  node id that is not registered. Action: this is a bug in
  `@causlts/core`'s commit log; file an issue.

## Active: vendored wasm + bundler interop (`wasm.yml`)

This repository does not build any wasm. The Rust engine and its build tooling
live in `causljs/causl-wasm`; what lands here is the built output, vendored
under `packages/core/wasm-pkg/<bridge>-<target>/`.

Until 2026-09-02 this file carried a `cargo check (workspace, defensive)` job
and a six-leg `wasm-pack build` matrix. Every step in both hung off a presence
guard for crates that have never existed here, so seven of the workflow's ten
jobs reported green having run checkout, install and a `::notice::`. The
`Size-limit cells (raw bytes)` step lived behind the same guard and had never
run once. The `driver sanity` step was worse: it called
`pnpm wasm:build:check || echo "::warning::..."` against a
`tools/wasm-build/build.mjs` that is not in this repo, so it crashed with
`Cannot find module` on every leg and swallowed it as a warning. See #49.

Two jobs run now:

1. **`vendored-wasm`** — `pnpm wasm:verify:test` then `pnpm wasm:verify`. The
   verifier opens all six committed artefacts and checks the 8-byte WASM
   preamble, a 64 KB non-trivial-size floor an 8-byte stub cannot clear, the
   RAW ceiling each `size-limit` cell declares, and byte-identity between the
   `-bundler` and `-nodejs` variants of each bridge. That last one matters
   because the size-limit cells gate the `-bundler` half only, on the stated
   grounds that wasm-pack emits identical bytes for both targets; if that stops
   being true the `-nodejs` artefacts are silently ungated.

   Note that the raw check is not what the cell itself does. `size-limit`
   compresses before comparing, so the cell named `@causlts/core wasm bridge —
   serde-json (raw)` actually measures ~68 kB against its 230 KB ceiling. The
   `//size-limit-wasm` comment beside the cells and SPEC §17.6 both talk about
   raw bytes, so the verifier enforces the documented reading and the cell
   stays as the compressed second opinion.

2. **`bundler-interop`** — matrix over **3 fixture apps** under
   `e2e/bundler-interop/` (`webpack5-app`, `vite5-app`, `esbuild-app`)
   per #689. Each fixture imports `@causlts/core` (main barrel) and
   dynamically imports `@causlts/core/wasm` (lazy-load entry); the
   per-fixture `verify.mjs` enforces the bundle-no-wasm-leak invariant
   — the main chunk must not contain `loadWasmBackend` /
   `WasmBackendUnavailableError` sentinels, and some other chunk MUST
   contain them (proves the dynamic import was preserved as a
   code-split rather than inlined). The `vite5` and `webpack5` legs were the
   red half of run 26002600499 on 2026-05-17; PR #37 fixed both by keeping
   `loadWasmBackend` out of the main chunk and correcting the vite5 fixture
   entry, and run 33647334864 on 2026-09-02 confirms all three legs green with
   real chunk readings.

### Stub-fallback for the bundler-interop job (#1108)

The `bundler-interop` job runs `node e2e/bundler-interop/stub-wasm-pkg.mjs`
between the `@causlts/core` build and the per-fixture install. The stubs are
minimal-valid 8-byte WASM modules and they go to `packages/core/dist/pkg/`, the
build output the loader resolves `new URL('./pkg/...', import.meta.url)`
against, so webpack 5 (with `experiments.asyncWebAssembly`) can resolve the
asset path at build time. They are never instantiated —
`loadWasmBackend()` throws before reaching the fetch path.

They never touch `packages/core/wasm-pkg/`. That tree holds the real vendored
artefacts, 214 to 249 KB each, and the `vendored-wasm` job asserts exactly that,
so a fixture run cannot write an 8-byte file over a real bridge. An earlier
version of this paragraph said the stubs were "committed under both
`<bridge>-bundler/` and `<bridge>-nodejs/` artefact trees", which described the
repo before the real bytes landed and is not true today.

The same stub mechanism gates the
`op-wasm-boundary-1k` microbench cell on developer machines (see
[`precommit.md`](./precommit.md) — `isWasmStubArtifactPresent()`
guards the cell so fresh clones without the Rust toolchain don't
trip the pre-commit hook). Tracking issues: #1098 (the bench-side
flake), #1108 (Option B / skip-with-clear-error fix that shipped).

## Active: bundle-budget (`bundle-budget.yml`)

`bundle-budget.yml` used to hand the whole job to
`andresz1/size-limit-action@v1`, whose `src/main.ts` opens with
`if (!pr) throw new Error("No PR found. Only pull_request workflows are
supported.")`. Every `push:` and `workflow_dispatch` run was therefore red
before a byte got measured, and since `wasm.yml`'s size step never ran either,
the 11 `size-limit` cells were gated by nothing at all. See #48.

The action is gone. `tools/bundle-budget/report.mjs` does the two halves
natively and keeps them apart:

- `gate` is blocking and runs on every event. It reads the `passed` flag
  size-limit computes per cell, and it refuses loudly on an empty or
  unparseable payload rather than reporting green off a measurement that never
  happened.
- `render` builds the delta table and `post` puts it on the pull request,
  updating its own previous comment in place so one PR carries one table. Only
  `post` needs a PR.

`pnpm budget:test` is the reporter's own unit cover and runs first in the
workflow, before the install, since it is `node:test` with no dependencies.

## Active: nightly cross-backend determinism (`cross-backend-fuzz.yml`)

Shipped via PR #1097 closing #1073. Runs the cross-backend
WASM-vs-TS determinism property at the `nightly` tier (100 000
trials, `maxCommands` 2000) on `0 4 * * *` UTC. The PR-lane gate
(5k trials) ships as a separate matrix leg once the main test
workflow lands; until then, every PR runs at the default
1000-trial floor and this workflow is the 100k canary. Tier knobs
honoured via `CAUSL_FUZZ_TIER` and `CAUSL_FUZZ_TRIALS`
(`resolveCrossBackendFuzzTier()` in seed.ts).

## Parked: 4-way differential classifier (`four-way-classifier.yml`)

Shipped via PR #1101 closing #1070 while this code still lived in the monorepo.
It walks the EPIC-7 corpus and the canonical-seed registry across four
implementations, three of which need Rust crates that are not in this
repository. Parked 2026-09-02 under `.github/workflows-disabled/`; the reasoning
is in the "Parked" note near the top of this page and in issue #47.

## Disabled-but-checked-in: release flow (`release-checker.yml`)

`release-checker.yml` is the publish path for `@causl/checker`.
Disabled along with the rest under PR #725. When re-enabled it fires
on a `checker-v*` git tag and on `workflow_dispatch` (the latter
runs build + checksum + artefact upload only — no Release, no npm
publish — so the matrix can be dry-run without minting a tag).

1. **`version-lockstep`** asserts the Cargo `version`, the
   `@causl/checker` npm `version`, and the `CAUSL_MODEL_SCHEMA`
   constant exported from `@causlts/core` (`packages/core/src/ir.ts`)
   all agree before any binary is built. The schema pin lives in
   `tools/checker/Cargo.toml` under `[package.metadata]
   causl_model_schema = "..."`. A bump in any of the three without
   the matching companion bump fails the job.
2. **`build`** cross-compiles `causl-check` for five targets via a
   matrix over `runs-on:`. Linux x64 builds natively on
   `ubuntu-latest`; Linux arm64 builds via `cross`; Darwin x64 and
   Darwin arm64 build natively on `macos-13` and `macos-14`
   respectively; Windows x64 builds natively on `windows-latest`. Each
   leg computes a SHA256 checksum and uploads the binary into the
   matching `packages/checker-<target>/bin/` directory as a workflow
   artefact.
3. **`github-release`** downloads all five artefacts and creates a
   GitHub Release for the tag, attaching every binary plus its
   `.sha256`.
4. **`publish-npm`** publishes each `@causl/checker-<target>` to
   the npm registry with `pnpm publish --no-git-checks --access public`,
   pinning the per-platform package version to match the tag.
   Authentication uses `${{ secrets.NPM_TOKEN }}`.
5. **`publish-wrapper`** publishes `@causl/checker` last, with its
   `optionalDependencies` rewritten from the `0.0.0` workspace
   placeholder to the just-published version.

Adopter installs (`pnpm add -D @causl/checker`) resolve to one of
the five per-platform packages by `os`/`cpu` filtering — no postinstall
network fetch, no corporate-proxy blast radius.

## Divergence: SPEC §17.6 serde-bundle ceiling (#1150)

The size-limit cell `@causlts/core wasm bridge — serde-json (raw)` in
root `package.json` sits at **230 KB**, not the SPEC §17.6
commitment-14 ceiling of **200 KB raw**. The current serde artefact
is 213 KB raw / 66 KB Brotli — Brotli is under the 80 KB target, raw
is over the 200 KB cap by 13 KB. The gate currently passes against
the relaxed cell but violates the SPEC commitment as written. Per
#1150 this is accepted as Option C divergence documented in §17.6's
current-state prose; the cell tightens back to ≤200 KB when the Rust
engine port (epic #1133, deferred post-0.9.0) lands and wasm-opt is
invoked directly per PR #1112's design discussion.

## Running locally

```bash
pnpm install
pnpm -r --filter './packages/*' run typecheck
pnpm -r --filter './packages/*' run test:run
cargo build --release --manifest-path tools/checker/Cargo.toml
pnpm --filter @causl/checker test:run
```

The wasm-side gates need no toolchain, because nothing is built here:

```bash
pnpm wasm:verify:test  # unit cover for the verifier, including the stub case
pnpm wasm:verify       # preamble + size floor + raw ceilings + target parity
pnpm budget:test       # unit cover for the bundle-budget reporter
pnpm size              # the 11 size-limit cells
```

`.husky/pre-commit` runs all four, so a local commit already carries the
`bundle-budget` and `vendored-wasm` verdicts.
