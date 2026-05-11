# CI

## Current state (as of v0.9.0)

Per PR #725, every workflow under `.github/workflows/` was moved into
`.github/workflows-disabled/` on 2025-09 when GitHub Actions runners
became unavailable for the org due to a billing issue (every PR was
failing with `runner_name: ""` and 0-step failures within 11 seconds —
masking real test results). Re-enabling is a `git mv` from
`workflows-disabled/` back into `workflows/`.

The wasm-substrate epic (#680) shipped after PR #725 with three of its
own workflows added directly under `.github/workflows/`. So as of
today the **only** active CI lanes are those wasm-side workflows; the
older `ts` / `rust` / `size` / `checker-gate` / `formula-e2e` jobs
described below live in the disabled tree and do not gate PRs.

Active workflows (root of `.github/workflows/`):

| File | What it does | Trigger |
| --- | --- | --- |
| `wasm.yml` | `cargo check --workspace`, `wasm-pack build` matrix over 6 (bridge × target) cells, plus a `bundler-interop` matrix over 3 fixture apps | PR + push to main + workflow_dispatch |
| `cross-backend-fuzz.yml` | Nightly 100k-trial cross-backend WASM-vs-TS determinism property (#1073 / shipped via PR #1097) | cron `0 4 * * *` + workflow_dispatch |
| `four-way-classifier.yml` | 4-way differential classifier across TS / WASM-serde / WASM-gc-builtins / Rust enumerator (#1070 / shipped via PR #1101) | PR (paths-filtered) + cron `15 7 * * *` + workflow_dispatch |

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
| `formula-e2e` | Playwright dropped-frame gate for `@causl/formula`'s 60fps spreadsheet demo (#226 / SPEC §14 perceptual perf). Depends on `ts`. | ~3 min |
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
| `perf-invariant — SPEC §14 gate` | #1 (recompute count) | `pnpm --filter @causl/core run test:perf-invariant` |
| `perf-invariant — SPEC §14 React subscription gate` | #2 (render scope) | `pnpm --filter @causl/react run test:perf-invariant` |

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
  `@causl/core`'s commit log; file an issue.

## Active: WASM build pipeline (`wasm.yml`)

`wasm.yml` is one of the three workflows that survived the PR #725
disable sweep (it was added afterwards by the wasm-substrate epic
#680, which closed with 17 sub-issues merged). It runs on every PR
and push to main and consists of two jobs:

1. **`cargo-check`** — workspace-wide `cargo check --workspace
   --all-targets`. Defensively skips if no root `Cargo.toml` workspace
   exists. Also enforces the architectural invariant from #682: the
   `causl-enumerator` dep tree MUST NOT pull `wasm-bindgen`, `js-sys`,
   or `serde-wasm-bindgen` transitively (`cargo tree` grep gate).
2. **`wasm-pack`** — matrix over **6 cells** = 3 bridges (`serde`,
   `gc-builtins`, `gc-classic`) × 2 wasm-pack targets (`bundler`,
   `nodejs`). Per #1103 the driver `tools/wasm-build/build.mjs` emits
   both target variants per bridge so the bridge-roundtrip property
   gate can run under vitest (consumes `nodejs`) while the runtime
   loader + bundler-interop fixtures consume `bundler`. Each leg
   installs binaryen 119 for the #1085 size gate (wasm-pack 0.14.0's
   bundled wasm-opt predates stable WasmGC), runs `pnpm wasm:build`
   (wasm-pack → wasm-opt -Oz → raw + Brotli q11 budget check), uploads
   `wasm-pkg-<bridge>-<target>` as an artefact, and runs `pnpm size`
   as an independent second-layer raw-byte gate.
3. **`bundler-interop`** — matrix over **3 fixture apps** under
   `e2e/bundler-interop/` (`webpack5-app`, `vite5-app`, `esbuild-app`)
   per #689. Each fixture imports `@causl/core` (main barrel) and
   dynamically imports `@causl/core/wasm` (lazy-load entry); the
   per-fixture `verify.mjs` enforces the bundle-no-wasm-leak invariant
   — the main chunk must not contain `loadWasmBackend` /
   `WasmBackendUnavailableError` sentinels, and some other chunk MUST
   contain them (proves the dynamic import was preserved as a
   code-split rather than inlined).

### Stub-fallback for the bundler-interop job (#1108)

The `bundler-interop` job runs `node e2e/bundler-interop/stub-wasm-pkg.mjs`
between the `@causl/core` build and the per-fixture install. The stubs
are minimal-valid 8-byte WASM modules committed under both
`<bridge>-bundler/` and `<bridge>-nodejs/` artefact trees; they let
webpack 5 (with `experiments.asyncWebAssembly`) statically resolve
`new URL('./pkg/...', import.meta.url)` asset paths even when the real
wasm-pack pipeline has not produced artefacts on the runner yet. The
stubs are never instantiated — `loadWasmBackend()` throws before
reaching the fetch path. The same stub mechanism gates the
`op-wasm-boundary-1k` microbench cell on developer machines (see
[`precommit.md`](./precommit.md) — `isWasmStubArtifactPresent()`
guards the cell so fresh clones without the Rust toolchain don't
trip the pre-commit hook). Tracking issues: #1098 (the bench-side
flake), #1108 (Option B / skip-with-clear-error fix that shipped).

## Active: nightly cross-backend determinism (`cross-backend-fuzz.yml`)

Shipped via PR #1097 closing #1073. Runs the cross-backend
WASM-vs-TS determinism property at the `nightly` tier (100 000
trials, `maxCommands` 2000) on `0 4 * * *` UTC. The PR-lane gate
(5k trials) ships as a separate matrix leg once the main test
workflow lands; until then, every PR runs at the default
1000-trial floor and this workflow is the 100k canary. Tier knobs
honoured via `CAUSL_FUZZ_TIER` and `CAUSL_FUZZ_TRIALS`
(`resolveCrossBackendFuzzTier()` in seed.ts).

## Active: 4-way differential classifier (`four-way-classifier.yml`)

Shipped via PR #1101 closing #1070. Walks the EPIC-7 corpus and the
canonical-seed registry across four implementations:

1. TS engine (`commitInternal` from `packages/core/src/graph.ts`,
   currently starting at line 3507 with Phase markers at 3690 (A),
   3746 (B), 3834 (C), 3840 (C.5))
2. WASM serde bridge (`tools/engine-rs-bridge-serde`)
3. WASM gc-builtins bridge (`tools/engine-rs-bridge-gc` with
   `js-string-builtins`)
4. Rust enumerator (`tools/enumerator` bounded BFS — the existing
   `apalache-diff` half)

Disagreement is classified by which subset of implementations agrees
(see `tools/enumerator/diff/src/four_way.rs` for the seven arms).
Rows excused by the `[[exceptions]]` table in
`tools/apalache-diff/mapping.toml` do not strict-fail. Trigger: PR
when any of the classifier-input paths change, plus a daily cron at
`15 7 * * *` UTC (ten minutes after the #574 apalache-diff job).

## Disabled-but-checked-in: release flow (`release-checker.yml`)

`release-checker.yml` is the publish path for `@causl/checker`.
Disabled along with the rest under PR #725. When re-enabled it fires
on a `checker-v*` git tag and on `workflow_dispatch` (the latter
runs build + checksum + artefact upload only — no Release, no npm
publish — so the matrix can be dry-run without minting a tag).

1. **`version-lockstep`** asserts the Cargo `version`, the
   `@causl/checker` npm `version`, and the `CAUSL_MODEL_SCHEMA`
   constant exported from `@causl/core` (`packages/core/src/ir.ts`)
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

The size-limit cell `@causl/core wasm bridge — serde-json (raw)` in
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

For the WASM-side gates (requires Rust toolchain +
`rustup target add wasm32-unknown-unknown` + `cargo install wasm-pack`):

```bash
pnpm wasm:build       # build + #1085 raw + Brotli budget gate
pnpm size             # second-layer size-limit cells
```
