# EPIC: Race-detection CI workflow

**Status (as of v0.9.0): SHIPPED, currently dormant.** Tracking issue [#468](https://github.com/iasbuilt/causl/issues/468) closed 2026-05-03. All four primary sub-tasks merged: #506 (Tier-1 leg), #508 (Tier-2 leg), #509 (Tier-3 leg), #510 (diagnostic + SARIF integration), and #511 (`causl-exemptions.md` + delta workflow). The race-detection workflow and the exemptions-delta workflow now live under `.github/workflows-disabled/race-detection.yml` and `.github/workflows-disabled/exemptions-delta.yml` after the temporary CI freeze landed in PR #725 (`b4e57bd` — "chore(ci): temporarily disable all GitHub Actions workflows"). The disablement is mechanical, not semantic: the workflow files are intact and re-enable by moving the directory back to `.github/workflows/`. `causl-exemptions.md` itself ships at the repo root and remains active — the SARIF emitter (`tools/checker/src/sarif.rs`) still surfaces `causlExemptionCount` on every run, and `pnpm audit:commitments` still validates row shape on every PR.

> **Current state (as of v0.9.0).** Active CI gates that exercise this EPIC's surface today: `cross-backend-fuzz.yml`, `four-way-classifier.yml`, and `wasm.yml`. The three-tier race-detection workflow itself is held in `workflows-disabled/` pending the broader CI re-enablement; when it returns, Tier-1 will run against today's 12-pass binary surface (the four §16A.2 passes from EPIC-2 #464 are live), Tier-2 will run against the bounded enumerator landed by EPIC-3 #466, and Tier-3 will include the Apalache differential corpus shipped by EPIC-7 #469 (`tools/apalache-diff/`) and the cross-backend tier-budget system added in #1097 / #1073.

**Spec anchors:** §16A.3, §16A.5, §16A.6, §16A.7.

**Risk:** LOW — additive workflow file; doesn't change existing CI gates. The Tier-1 leg ships against today's binary surface (8 static passes + property suite + tsc + unit). Tier-2 / Tier-3 are wired but no-op gracefully when EPIC-3 / EPIC-4 dependencies haven't landed: `causl-check race` returns exit 0 with a `not-yet-implemented` SARIF stub.

**Dependencies:**
- Tier-1 leg ships TODAY (existing 8 passes + property suite at 1000-trial floor + tsc + unit tests). Zero new tooling required; the leg is composition over what `ci.yml` already runs.
- Tier-2 / Tier-3 legs depend on EPIC-3 (bounded enumerator) and EPIC-4 (hypothesis API). Until both land, the legs run with `--dry-run` and post a "would have run" SARIF so the wiring stays exercised. **(Resolved post-ship.)** EPIC-3 (bounded enumerator) and EPIC-4 (hypothesis API) both landed; the `--dry-run` fallback path is dead code. Tier-2 now runs the real BFS at K=10/D=5 and Tier-3 at K=20/D=8 when the workflow is re-enabled.

## What I'm shipping

Tanner's framing from §16A.3 is the design's spine: per-PR cost matters more than completeness. A 60-min check that catches 95% of races trains adopters to push the PR and walk away — they will not read a failure that arrives an hour after they've context-switched. A 2-min check that catches 80% trains them to read the failure while the change is still in their head. The three-tier hierarchy is the discipline: Tier-1 is the always-on cheap layer, Tier-2 is the pressure valve when an adopter *suspects* a race, Tier-3 is the nightly soak that lets us discover the rows the cheap tiers missed without burning every PR's budget on the discovery.

The ratio that disciplines the EPIC: ~3.5 min per PR, ~75 min nightly (§16A.7). The Tier-1 budget (≤2 min) is dominated by the property suite at the 1000-trial floor; the static passes and tsc add ~30s. The Tier-2 budget (≤15 min) is dominated by the property suite at 10,000 trials and the bounded enumerator at K=10/depth=5. The Tier-3 budget (≤2 hr) is the soak run at K=20/depth=8 plus the long property tail.

Markbåge's render-cost analogue applies directly: CI runtime is to mergers what render time is to users — the 50ms-vs-500ms gap is a *behavioural* gap, not a quantitative one. A 90s CI is "let me wait"; a 4-min CI is "let me context-switch and lose the thread." The Tier-1 budget is non-negotiable for that reason.

Abramov's signal-to-noise rule — mechanised in §16A.5's "no counterexample without a §9.1 row reference" — is the EPIC's other spine. The diagnostic-output and false-positive-economy tasks (TASK 6.4, TASK 6.5) exist because a race-detector that fires on rows the codebase has decided are acceptable is a race-detector adopters disable. The exemption-count SARIF metric (§16A.5) makes suppressions conspicuous; conspicuous suppressions are the only suppressions that get reviewed.

What this EPIC is *not*: it is not the bounded enumerator (EPIC-3), not the hypothesis API (EPIC-4), not the Apalache corpus (EPIC-7), not the Schema 3 IR (EPIC-1). This EPIC ships the *workflow file* that orchestrates those pieces — wiring, gating, budgets, diagnostics, exemption discipline. The actual race-finding logic lives in the EPICs this one depends on.

**Tier interaction matrix.** The three tiers are not independent — a counterexample found at Tier-3 should be reproducible at Tier-2 with the same seed, and a counterexample found at Tier-2 should be reproducible at Tier-1 *if* the bound at Tier-1 contains it. The matrix:

| Counterexample at | Reproducible at Tier-1? | Reproducible at Tier-2? | Reproducible at Tier-3? |
| --- | --- | --- | --- |
| Tier-1 (property@1k) | always (same seed) | always (10k contains 1k) | always |
| Tier-2 (property@10k or K=10) | only if the trial seed lands within Tier-1's 1k draws | always (same seed) | always (K=20 contains K=10) |
| Tier-3 (K=20 / soak) | only if within K=10 / 1k | only if within K=10 / 10k | always (same seed) |

The matrix is enforced by the deterministic-replay contract (TASK 6.4 concern 3): the seed and bound are recorded in SARIF metadata; a reviewer who sees a Tier-3 failure can run `MODEL_CHECK_TIER=labeled CAUSL_RACE_SEED=<seed> pnpm causl-check race --replay` to attempt reproduction at Tier-2's bound, and Tier-1's bound respectively. If the reproduction fails at the lower tier, the counterexample is genuinely outside that tier's bound — not a determinism bug.

## Brutal-critical review

Where the design is risky:

- **The `[model-check]` PR label as the Tier-2 trigger — adopters will forget to add it.** This is the hardest unresolved question. The §16A.3 design treats Tier-2 as opt-in; the danger is that an adopter who introduces a race without *suspecting* one ships the PR with Tier-1 only and the bug lands. Two mitigations: (a) auto-trigger Tier-2 on PRs that touch `tools/enumerator/`, `packages/checker/**`, or any file matching `*.hypothesis.ts` — i.e., the directories where a Tier-1-invisible race is most likely to be authored or to escape detection; (b) the nightly Tier-3 catches it within 24 hours and files an issue. We accept (b) as the safety net and ship (a) in TASK 6.2 as a path-filter alongside the label.

- **Nightly cost — 2 hr is a lot of GitHub Actions minutes per day.** At 2 hr/night × 30 nights = 60 hr/month for Tier-3 alone, plus per-PR Tier-1 (~2 min × ~30 PRs/day × 30 = ~30 hr/month) and labelled Tier-2 (~15 min × estimate ~20 labelled PRs/month = ~5 hr/month). Total ~95 hr/month. GitHub Free tier is 2000 min = ~33 hr; we're on a paid plan but the cost discipline matters. Mitigation: TASK 6.2 includes a per-day cost guardrail — if the rolling 7-day Tier-2 average exceeds 60 min/day, an alert fires and we revisit. Tier-3 is bounded by the cron schedule (one run per night, hard).

- **The exemption-count SARIF delta — false-noise risk.** §16A.5 specifies "the exemption count is a SARIF-reported metric"; a PR delta of +2 reads as a regression. But a PR that adds three justified exemptions and removes one un-justified one is also a delta of +2, and that PR is *better* than the baseline. Mitigation: the SARIF metric splits into two counters — `exemptions.added.justified` and `exemptions.added.unjustified` (where "unjustified" means missing or placeholder `because:` field). The PR comment template (TASK 6.4 concern 4) shows both. The CI gate fails on `unjustified > 0`, not on raw delta.

- **Tier-1 P95 drift.** The 2-min budget is a P95, not a hard ceiling, because a cold runner with no pnpm cache will routinely take 90-120s on install alone. We accept the P95 framing and add a CI-runtime ratchet (TASK 6.1 concern 1) that fails when the trailing-30-day P95 exceeds 150s — the buffer absorbs cold-cache outliers without letting Tier-1 drift to 4 min over a year.

- **The `MODEL_CHECK_TIER` env coupling.** TASK 6.2 concern 4 exports `MODEL_CHECK_TIER=2` so the enumerator's bound presets pick up the right values. The risk is that an adopter running `pnpm causl-check race` locally without that env gets a different result than CI — Linsley's "behaviour that depends on env vars adopters can't see" critique. Mitigation: `causl.config.ts` (§16A.4) is the source of truth; the env var only selects which preset block to read. A local run without the env defaults to `pr` tier, matching Tier-1 CI behaviour.

- **No-secrets discipline.** Tier-1 must not require Apalache, no API tokens, no external services. This is the price of the "every PR" trigger — a network outage or a vendor change cannot break PR merges. TASK 6.1 concern 3 enforces it; TASK 6.3 (Tier-3) is the only tier where we relax it (the Apalache corpus runs nightly per EPIC-7).

- **Wall-clock duplication with `ci.yml`.** Tier-1 re-runs the property suite that the existing `ci.yml`'s `ts` job *also* runs as part of `pnpm test:run`. The naive read is "duplication is waste"; the careful read (Markbåge's framing on render-cost analogues) is that the duplication is the *price of separation*. If we fold race-detection into `ci.yml`, the PR check list collapses one signal into another and a Tier-1 race-detection failure looks like a generic test failure. Mitigation: the property suite has a fast-mode (already wired at `CAUSL_PROPERTY_TRIALS=100`) used by `ci.yml`'s `ts` job; Tier-1 runs the full 1000-trial floor. The leg differentiation makes the PR check list show which gate caught the regression — race-detection-specific or generic — and that signal is worth the ~30s of overlap.

- **The `workflow_run` dependency between `ci.yml` and `race-detection.yml`.** GitHub Actions' `workflow_run` trigger fires *after* the upstream workflow completes — it does not block the merge until both have run. The risk is that a PR shows `ci.yml` as green and `race-detection.yml` as still-running, and a too-eager merger merges before the race-detection leg completes. Mitigation: the `tier-1` job in `race-detection.yml` is on the required-status-checks list (TASK 6.1 concern 2). Branch protection requires *all* required checks to be green, so a still-running check blocks merge regardless of its parent workflow's state.

- **Per-tier flakiness budgets.** The bounded enumerator at K=20/depth=8 is *deterministic* given a seed (TASK 6.3 concern 5). The property suite is *not* — even with 10,000 trials, a rare interleaving can shrink to a counterexample on one run and not the next. Mitigation: a flakiness ratchet — Tier-2 and Tier-3 record flake-rate (counterexamples that do not reproduce on rerun with the same seed) in the runtime metrics file. A flake rate above 1% on Tier-2 or 0.1% on Tier-3 fails the cost-guard step. This forces us to fix shrinker non-determinism rather than letting it accumulate.

## Sub-issues (TASKS)

### TASK 6.1 — `.github/workflows/race-detection.yml` Tier-1 leg (ships today)

**Files:** `.github/workflows/race-detection.yml` (new).

Per §16A.3 row "Tier 1, every PR, ≤2 min". Steps: `tsc`, lint, unit, property suite at the §15.2 1000-trial floor, `causl-check` static (8 passes today, 12 after EPIC-2 lands).

The leg duplicates *some* shape from `ci.yml` deliberately — `ci.yml` is the existing required-green workflow and we don't want to merge race-detection wiring into it (single-responsibility per workflow file makes the PR check list legible). The duplication is small: pnpm install + node-setup + cache. The expensive steps (build, typecheck) are *not* duplicated — the race-detection leg waits on `ci.yml`'s `ts` and `rust` jobs via `workflow_run` triggering, so we do not pay the build cost twice.

```yaml
# .github/workflows/race-detection.yml (Tier-1 leg)
name: Race detection
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * *'  # Tier-3 (TASK 6.3)

jobs:
  tier-1:
    name: Tier-1 — static + property + tsc (≤2 min P95)
    runs-on: ubuntu-latest
    timeout-minutes: 4  # hard ceiling 2× P95 budget
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24.x, cache: 'pnpm' }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: tools/checker }
      - run: pnpm install --frozen-lockfile
      - run: cargo build --release --manifest-path tools/checker/Cargo.toml
      - name: Tier-1 — property suite at 1000-trial floor
        env:
          CAUSL_PROPERTY_TRIALS: '1000'
          MODEL_CHECK_TIER: 'pr'
        run: pnpm -r --filter './packages/*' run test:property
      - name: Tier-1 — causl-check static (8 passes today)
        env:
          CAUSL_CHECK_BINARY: ${{ github.workspace }}/tools/checker/target/release/causl-check
        run: pnpm --filter @causl/checker test:run
      - name: Tier-1 — runtime ratchet
        run: node scripts/ci/ratchet-tier1-p95.mjs
```

The runtime-ratchet script (`scripts/ci/ratchet-tier1-p95.mjs`) reads the trailing-30-day Tier-1 wall-clock from a checked-in JSON file under `tmp/ci-metrics/` and fails if the P95 exceeds 150s. The file is updated nightly by Tier-3.

#### TDD test suite (≥5 tests)

1. **The workflow lints.** `actionlint .github/workflows/race-detection.yml` produces zero errors. Wired as a pre-commit hook in `lefthook.yml` (already configured for `ci.yml`).
2. **The workflow file is referenced from CODEOWNERS and the PR template.** `.github/CODEOWNERS` has a row `.github/workflows/race-detection.yml @causl-team`; `.github/PULL_REQUEST_TEMPLATE.md` has a checkbox `- [ ] Race-detection CI passed (Tier-1 required, Tier-2 if [model-check])`. A grep test in `packages/checker/test/ci-wiring.test.ts` asserts both rows exist.
3. **A test PR with a known-cycle fixture causes Tier-1 to fail.** The fixture lives in `tools/checker/test/fixtures/known-cycle/` and is identical to the §16.6 demo's negative case. The acceptance workflow (see "Acceptance gate" below) opens a synthetic PR against this fixture and asserts CI is red.
4. **A test PR with no faults passes Tier-1.** The fixture lives in `tools/checker/test/fixtures/clean/`. The acceptance workflow asserts CI is green.
5. **The `propertyTrials` floor of 1000 is enforced.** The conformance walker (`packages/checker/src/conformance.ts`) reads `causl.config.ts` and fails if `tiers.pr.propertyTrials < 1000`. Tier-1 runs the walker as part of the static-pass suite. A unit test in `packages/checker/test/conformance.test.ts` constructs a config with `propertyTrials: 999` and asserts the walker rejects it.
6. **The runtime ratchet fires on drift.** Unit test in `scripts/ci/ratchet-tier1-p95.test.mjs` constructs a synthetic 30-day metrics JSON with P95=180s and asserts the script exits 1.

#### 5 concerns

1. **Latency budget.** Tier-1 P95 ≤ 2 min on standard `ubuntu-latest`. The runtime ratchet enforces it with a 150s P95 ceiling (50% headroom over the 2-min target — Linsley's "the budget is the budget; the ceiling is the budget × 1.25 to absorb cold-cache outliers" framing). A drift past 150s fails the ratchet step and forces a remediation PR.
2. **Required-green.** The workflow's `tier-1` job is `required` for merge to `main`. Verified by a smoke test in `packages/checker/test/ci-wiring.test.ts` that calls the GitHub API on the `main` branch protection rules and asserts `"Race detection / Tier-1 — static + property + tsc (≤2 min P95)"` appears in the required-status-checks list. The test runs in the Tier-1 leg itself, so a misconfiguration self-detects.
3. **No-secrets.** Tier-1 doesn't need Apalache or external services; runs entirely with FOSS deps already in the lockfile. A smoke test asserts `secrets` is empty for the `tier-1` job — `actionlint` plus a custom YAML check in `scripts/ci/check-no-secrets.mjs`.
4. **Cache discipline.** pnpm + Rust target/ caches; cold-start fallback OK. The `Swatinem/rust-cache@v2` action is shared with `ci.yml`'s `rust` job — same cache key, so a cold Tier-1 leg gets a warm cache as soon as `ci.yml` has run once for the same SHA.
5. **No race condition in the workflow itself.** CI is single-purpose per run; we do not parallelise property-trial seeds across runners (deterministic seeding requires single-run accumulation). The leg is single-job, single-runner.

### TASK 6.2 — Tier-2 leg (label-gated and main-branch and path-filtered)

**Files:** same workflow (`.github/workflows/race-detection.yml`), additional jobs.

Per §16A.3 Tier-2. Triggers: PR label `[model-check]` OR push to `main` OR PR touches `tools/enumerator/**`, `packages/checker/**`, `tests/hypotheses/**`. Adds: property suite at 10,000 trials, `causl-check race --k 10 --depth 5` (when EPIC-3 + EPIC-4 land; until then runs `--dry-run`).

The path-filter is the brutal-critical-review mitigation: the `[model-check]` label as the only Tier-2 trigger lets a PR slip through if the author forgets to add the label. Auto-triggering on the directories where Tier-1-invisible races are most likely to be authored is the cheapest safety net. Linsley's framing on per-PR cost still applies — Tier-2 is *not* free, and we do not want it firing on every PR — but the 15-min budget is acceptable for the narrow set of paths that disproportionately introduce race-class regressions. The cost-vs-coverage tradeoff is calibrated against the §17 commitment 8 framing: the gate must catch the rows in §16A.7 within their declared budgets, and the per-PR budget for *enumerator-touching* PRs is 15 min, not 2.

The §16A.4 hypothesis-file shape is what Tier-2 consumes. A PR that adds a new `tests/hypotheses/no-X-during-Y.hypothesis.ts` triggers Tier-2 via the path filter, runs the hypothesis under K=10/depth=5, and either accepts the hypothesis (no counterexample within the bound) or files a SARIF result. The PR author sees the result rendered as a PR comment (TASK 6.4); a counterexample blocks merge until either the source is fixed or an exemption row is added (TASK 6.5).

```yaml
  tier-2:
    name: Tier-2 — property@10k + causl-check race K=10 (≤15 min P95)
    runs-on: ubuntu-latest
    timeout-minutes: 25  # hard ceiling 1.67× P95 budget
    if: |
      contains(github.event.pull_request.labels.*.name, 'model-check') ||
      github.ref == 'refs/heads/main' ||
      github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v4
      # ... (setup steps identical to tier-1) ...
      - name: Path-filter — auto-trigger on enumerator-adjacent files
        id: paths
        uses: dorny/paths-filter@v3
        with:
          filters: |
            enumerator:
              - 'tools/enumerator/**'
              - 'packages/checker/**'
              - 'tests/hypotheses/**'
      - name: Tier-2 — property suite at 10,000 trials
        if: steps.paths.outputs.enumerator == 'true' || ...
        env:
          CAUSL_PROPERTY_TRIALS: '10000'
          MODEL_CHECK_TIER: 'labeled'
        run: pnpm -r --filter './packages/*' run test:property
      - name: Tier-2 — causl-check race K=10 depth=5
        env:
          MODEL_CHECK_TIER: 'labeled'
        run: pnpm causl-check race --k 10 --depth 5 --sarif tmp/sarif/tier-2.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: tmp/sarif/tier-2.sarif
```

The `--dry-run` fallback while EPIC-3/EPIC-4 are unfinished: the `causl-check race` binary detects "the bounded enumerator has not been wired" and writes a SARIF file with a single `notification` entry — `"the Tier-2 leg is wired; the enumerator is deferred to EPIC-3"`. The PR-comment step (TASK 6.4) renders the notification so reviewers see the wiring is exercised.

#### TDD test suite (≥5 tests)

1. **The label trigger fires.** Acceptance workflow opens a PR with the `[model-check]` label and asserts the `tier-2` job runs.
2. **The label trigger does NOT fire on a label-less PR.** Same fixture without the label; assert `tier-2` is skipped.
3. **The path-filter triggers on `packages/checker/**` changes.** A PR that touches `packages/checker/src/index.ts` without the label runs Tier-2.
4. **The 10,000-trial property suite runs.** A unit test in `packages/core-testing-internal/test/tier-2-trials.test.ts` reads the resolved `propertyTrials` from `causl.config.ts` under `MODEL_CHECK_TIER=labeled` and asserts it equals 10,000.
5. **The `causl-check race --dry-run` mode emits valid SARIF when the enumerator is unwired.** Snapshot test in `packages/checker/test/sarif-dry-run.test.ts`.
6. **The cost guardrail fires when Tier-2 minutes exceed 60/day.** Unit test in `scripts/ci/cost-guard.test.mjs` constructs a synthetic 7-day usage report with day 7 at 75 min and asserts the script exits 1.

#### 5 concerns

1. **Label trigger.** `if: contains(github.event.pull_request.labels.*.name, 'model-check')`. Same condition for `push: main` (`github.ref == 'refs/heads/main'`). Path-filter via `dorny/paths-filter@v3` runs as a separate condition — any of the three triggers fires the leg.
2. **Latency budget.** ≤15 min P95. Hard timeout at 25 min (`timeout-minutes: 25`). The runtime ratchet (TASK 6.1 concern 1) tracks Tier-2 P95 separately and alerts the team via the `causl-team` GitHub team mention if the trailing-30-day P95 drifts past 18 min.
3. **Cost budget.** Track GitHub Actions minutes; alert if Tier-2 exceeds 60 min/day rolling 7-day average. The `scripts/ci/cost-guard.mjs` script runs in Tier-3 (nightly) and pulls usage via `gh api /repos/causl/causl/actions/usage`.
4. **`MODEL_CHECK_TIER=2` env exported.** Per Linsley's "no env-only behaviour" critique, the env var only *selects* a preset from `causl.config.ts`. A local `pnpm causl-check race` with no env defaults to `tiers.pr` (matching Tier-1). A documented `MODEL_CHECK_TIER=labeled pnpm causl-check race` reproduces Tier-2 locally — symmetric with CI.
5. **Race-condition test (the meta-test).** The enumerator itself is the test; the CI runs deterministic with a fixed seed when `--replay` is set. The Tier-2 leg uses a *fresh* seed per run (so it explores new interleavings) and exports the seed to the SARIF metadata so a reviewer can reproduce locally with `CAUSL_RACE_SEED=<seed> pnpm causl-check race --replay`.

### TASK 6.3 — Tier-3 nightly leg

**Files:** same workflow (`.github/workflows/race-detection.yml`), scheduled job.

Per §16A.3 Tier-3. Triggers: cron `0 0 * * *` (00:00 UTC). Adds: enumerator at K=20/depth=8, soak run, the cost-guard script, the runtime-metrics-update step.

Tier-3 is the safety net for the brutal-critical-review concern about adopters forgetting the `[model-check]` label. A race that escapes Tier-1 and is not caught by Tier-2's path filters lands on `main`; Tier-3 then runs the next night against `main` and surfaces the regression. The mean-time-to-detection is therefore bounded by 24 hours plus the nightly run time. Markbåge's framing: this is the equivalent of a long-running render-cost audit — you accept that some regressions slip past the per-PR gate, you compensate by running an exhaustive sweep on a slower cadence.

```yaml
  tier-3:
    name: Tier-3 — nightly soak + K=20 enumerator (≤2 hr P95)
    runs-on: ubuntu-latest
    timeout-minutes: 180  # hard ceiling 1.5× P95 budget
    if: github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v4
      # ... (setup steps) ...
      - name: Tier-3 — property suite at 10,000 trials (sustained)
        env:
          CAUSL_PROPERTY_TRIALS: '10000'
          MODEL_CHECK_TIER: 'nightly'
        run: pnpm -r --filter './packages/*' run test:property
      - name: Tier-3 — causl-check race K=20 depth=8
        env:
          MODEL_CHECK_TIER: 'nightly'
          CAUSL_RACE_SEED: ${{ github.run_id }}  # fresh per night, recorded
        run: pnpm causl-check race --k 20 --depth 8 --sarif tmp/sarif/tier-3.sarif
      - name: Tier-3 — soak (15-min sustained property burn)
        run: pnpm --filter @causl/core run test:soak
      - name: Update CI-runtime metrics
        run: node scripts/ci/update-metrics.mjs
      - name: Cost guard (alert if Tier-2 7d > 60 min/day)
        run: node scripts/ci/cost-guard.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: tier-3-sarif-${{ github.run_id }}
          path: tmp/sarif/tier-3.sarif
          retention-days: 90
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: tmp/sarif/tier-3.sarif
```

The `update-metrics.mjs` step writes Tier-1, Tier-2, Tier-3 wall-clock samples back into `tmp/ci-metrics/runtime.json` and commits them via a bot account on a `ci-metrics` branch. The Tier-1 ratchet (TASK 6.1) reads from `main`'s checked-in copy.

#### TDD test suite (≥5 tests)

1. **Tier-3 runs once per night.** Schema test in `packages/checker/test/ci-wiring.test.ts` parses `race-detection.yml` and asserts the `tier-3` job's `if` clause is `github.event_name == 'schedule'` and the cron is `0 0 * * *`.
2. **The seed is logged.** Snapshot test of the SARIF output asserts the `properties.seed` field is a non-empty string.
3. **The artifact upload retention is 90 days.** YAML schema test asserts `retention-days: 90`.
4. **The cost-guard step runs after the enumerator step.** Step-order assertion.
5. **Tier-3 does not run on PR or push events.** Acceptance workflow opens a PR and asserts `tier-3` is skipped.
6. **The hard timeout is 180 minutes.** Schema test.

#### 5 concerns

1. **Schedule discipline.** Runs once per night, not per PR. The `if: github.event_name == 'schedule'` ensures a manual `workflow_dispatch` does not accidentally trigger it (we add a separate `workflow_dispatch` entry with a confirmation input if we ever need to re-run a failed nightly).
2. **Latency budget.** ≤2 hr P95. Hard timeout at 3 hr (`timeout-minutes: 180`). The runtime metrics step records the wall-clock; the cost-guard alerts if the trailing-7-day P95 exceeds 2.5 hr.
3. **Cost budget.** Tier-3 fits in the per-day budget alongside Tier-1+Tier-2. Per the brutal-critical-review math: ~95 hr/month total across all tiers; we have a paid plan with ample headroom but the cost-guard script flags when any tier drifts.
4. **Nightly artifacts.** SARIF uploaded to `actions/upload-artifact@v4` with 90-day retention; surfaced on the dashboard. The dashboard is a separate deliverable (out of scope) — for now the artifact is downloadable from the Actions UI.
5. **Race-condition / determinism.** Soak run uses a fresh seed per night (`CAUSL_RACE_SEED: ${{ github.run_id }}`); logs include the seed for reproduction. A reviewer who sees a nightly red can run `CAUSL_RACE_SEED=<run_id> pnpm causl-check race --replay --k 20 --depth 8` locally and get the same trace.

### TASK 6.4 — Diagnostic output: hypothesis-file format + SARIF integration

**Files:** Documentation in `packages/checker/README.md` and `docs/race-detection.md`. PR-comment template in `.github/workflows/race-detection.yml` (the `actions/github-script` step). Schema fixture in `packages/checker/test/fixtures/sarif/`. SARIF renderer in `tools/checker/src/race/sarif.rs`.

Per §16A.5. The diagnostic output: minimal interleaving (≤5 steps), source-mapped frames, §9.1 row reference, the repro command (`CAUSL_RACE_SEED=0x9a3f pnpm causl-check race --replay`).

Linsley's framing applies sideways here: per-PR cost matters more than completeness, but per-PR *cognitive* cost matters too. A reviewer who has to scroll through a 200-line BFS dump to find the violation has been served a 60-min check disguised as a 2-min check — the wall-clock said it ran fast, but the human latency to action is high. The minimal-interleaving rule (≤5 steps) is the cognitive-cost analogue of the wall-clock budget. Markbåge's framing reinforces it: the diagnostic *is* the API for the gate. A failure mode the adopter cannot read is a failure mode that gets ignored.

The PR comment is the user-facing surface. A reviewer who sees a red Tier-2 must, within 10 seconds of opening the PR comment, know: which hypothesis failed, where in the source, which §9.1 row, and the repro command. The comment template:

```
× hypothesis: no commit during subscribe callback
  bound: K=10 depth=5  trials explored: 47  counterexample depth: 3

  minimal interleaving (3 steps):
    1. graph.commit({ counter: 1 })       at app/cart.ts:42:7
    2. enter subscribe callback for `counter` at app/cart.ts:58:11
    3. graph.commit({ counter: 2 })       at app/cart.ts:60:9   ← invariant violated

  race-class: §9.1 row 7 (commit-inside-subscribe reentry)
  suggested fix: defer the inner commit via queueMicrotask, or
                 hoist it out of the subscribe body.
  reproduce: CAUSL_RACE_SEED=0x9a3f pnpm causl-check race --replay
```

The `actions/github-script` step reads the SARIF output and renders one comment per hypothesis failure. A snapshot test in `packages/checker/test/sarif-render.test.ts` pins the comment format against the §16A.5 example.

The SARIF schema we emit conforms to OASIS SARIF 2.1.0; the GitHub code-scanning ingester is the consumer of record and the schema is what binds the renderer to its consumer. The fields that matter:

```jsonc
{
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "causl-check",
        "rules": [
          { "id": "race-9.1-row-7", "shortDescription": { "text": "commit-inside-subscribe reentry" } }
        ]
      }
    },
    "results": [{
      "ruleId": "race-9.1-row-7",
      "level": "error",
      "message": { "text": "no commit during subscribe callback" },
      "locations": [/* source-mapped frames */],
      "properties": {
        "seed": "0x9a3f",
        "trialsExplored": 47,
        "counterexampleDepth": 3,
        "minimalInterleaving": [/* 3 steps */]
      }
    }]
  }]
}
```

The `properties.seed` is what the repro command uses; the `properties.minimalInterleaving` is what the renderer flattens into the PR comment.

#### TDD test suite (≥5 tests)

1. **The PR comment renders the §9.1 row.** Snapshot test asserts the rendered comment contains `race-class: §9.1 row` for every failure.
2. **The comment includes the repro command with the actual seed.** Snapshot test.
3. **An unclassified violation files an internal bug, not a warning.** Unit test in `tools/checker/src/race/classifier.rs` asserts the binary exits 1 and writes to `tmp/internal-bugs/` rather than emitting a SARIF warning.
4. **Source-mapped frames resolve to the original `.ts` file.** Integration test against the §16.6 demo's IR output asserts the frames point at `.ts` source, not `.js` build output.
5. **The repro command is deterministic.** Run twice with the same seed; assert byte-identical SARIF output.
6. **Empty/placeholder `causl-ignore-race` reasons fail CI.** Unit test in `packages/checker/test/suppression.test.ts` constructs a fixture with `// causl-ignore-race:` (empty) and `// causl-ignore-race: TODO` (placeholder) and asserts the static pass rejects both.

#### 5 concerns

1. **No counterexample without §9.1 row reference.** If the enumerator finds an unclassified violation, it files an internal bug (writes to `tmp/internal-bugs/`, opens a GitHub issue via `gh issue create`), not a warning. Abramov's signal-to-noise rule mechanised — we never train adopters to ignore a row.
2. **Source maps.** The IR exporter (EPIC-1, Schema 3) preserves source maps end-to-end. This EPIC depends on EPIC-1 only for the source-map-preservation contract; the diagnostic format itself is independent.
3. **Repro determinism.** Same seed → same trace. Tested in TDD #5. The seed is logged in SARIF metadata and rendered in the PR comment.
4. **PR comment template.** The GitHub Actions step `actions/github-script` posts the SARIF summary as a PR comment. One comment per workflow run, edited in place on subsequent runs (so the PR doesn't accumulate stale comments). The edit-in-place uses `peter-evans/find-comment@v3` + `peter-evans/create-or-update-comment@v4`.
5. **Suppression discipline.** `// causl-ignore-race: <reason>` per-site, with non-empty reason; CI greps for empty/placeholder reasons (`<reason>` matching `^\s*$`, `^TODO`, `^FIXME`, `^XXX`) and fails. The grep runs in the Tier-1 leg's static-pass step — cheap, blocking, every PR.

### TASK 6.5 — False-positive economy: `causl-exemptions.md` + SARIF delta

**Files:** `causl-exemptions.md` (new, root). `.github/workflows/exemptions-delta.yml` (new). `scripts/ci/exemptions-delta.mjs` (new). `packages/checker/test/exemptions.test.ts` (new).

Per §16A.5. The exemption count is a SARIF-reported metric; PR delta surfaces in the standard scan upload.

Abramov's signal-to-noise rule is the load-bearing critique here. A race-detector that fires on rows the codebase has decided are acceptable is a race-detector adopters disable wholesale — and a wholesale-disabled detector is worse than no detector, because it provides false reassurance. The §16A.5 design's three-tier escape valve (per-site `// causl-ignore-race:` reason, per-hypothesis bound tightening, per-row exemption) is graduated by reversibility: the per-site comment is the cheapest to add and the easiest to remove on a future cleanup pass; the per-hypothesis bound is local but harder to spot; the per-row exemption is the loudest and the most reviewed.

The exemption file is *deliberately* loud — it lives at the repo root, every change shows up in `git log --stat`, every change requires CODEOWNERS approval. The §16A.5 framing — "if suppressions stop being conspicuous, the gate is dead" — is the design intent. The two-counter SARIF design (justified vs unjustified) preserves that conspicuousness through the noise of routine maintenance.

The file format is a markdown table — review-friendly, diffable, no custom parser:

```markdown
# Causl exemptions

Each row exempts a specific §9.1 race-class for a specific module path.
The `because:` field is required and must reference a §9.1 row.
A row without a non-empty `because:` fails CI.

| § | path | because | added |
| --- | --- | --- | --- |
| §9.1 row 4 | packages/react/src/useSyncExternalStore.ts | row 4 (subscribe-during-render) is intentionally caught by the React 18 reconciler; we suppress at the framework boundary. | 2025-11-14 |
| §9.1 row 11 | tools/checker/src/static/pass-08.rs | row 11 (test-only mutation) is acceptable in fixtures by convention. | 2025-12-02 |
```

The delta-calculation script (`scripts/ci/exemptions-delta.mjs`) runs in a separate workflow (`exemptions-delta.yml`) so the SARIF upload is one cohesive artifact rather than tangled into `race-detection.yml`. The split is also operational: a PR that only edits `causl-exemptions.md` should not retrigger the full race-detection run.

The two-counter SARIF design (from brutal-critical-review):

```json
{
  "properties": {
    "exemptions.added.justified": 3,
    "exemptions.added.unjustified": 0,
    "exemptions.removed": 1,
    "exemptions.total.head": 14,
    "exemptions.total.base": 12
  }
}
```

The CI gate fails on `exemptions.added.unjustified > 0`; the PR comment renders all five counters so a reviewer sees the full picture (added 3 justified, removed 1, net +2 — *good* PR shape).

#### TDD test suite (≥5 tests)

1. **Empty `because:` is rejected.** Unit test constructs a row with `because: ` (whitespace only) and asserts the validator fails.
2. **Placeholder `because:` is rejected.** Same with `TODO`, `FIXME`, `XXX`, `tbd`.
3. **A `because:` not referencing a §9.1 row is rejected.** The validator regex `/§9\.1 row \d+/` must match.
4. **The delta calculation handles concurrent add+remove correctly.** A PR that adds 3 rows and removes 1 reports `added.justified: 3, removed: 1, net: +2` — not `delta: +2`.
5. **A change to `causl-exemptions.md` requires CODEOWNERS approval.** Verified by an entry in `.github/CODEOWNERS`: `causl-exemptions.md @causl-team @causl-spec-owners`.
6. **The SARIF file uploads cleanly to GitHub code scanning.** Integration test using `actionlint` + a local `sarif-fmt` validator.

#### 5 concerns

1. **File format.** Markdown table with required `because:` field referencing a §9.1 row. Parser is `markdown-table` from npm (already a transitive dep); we do not roll our own.
2. **CI gate.** Empty/placeholder `because:` rejected. The validator runs in Tier-1 (so the gate is on every PR, not just labelled ones).
3. **Delta calc.** PR-vs-base diff in `causl-exemptions.md` row count is reported as a metric. The diff is computed by `git diff origin/main -- causl-exemptions.md` plus a markdown-table parser; a single-pass linear scan, no race condition possible.
4. **Audit trail.** Every change to `causl-exemptions.md` requires a CODEOWNERS approval — enforced by the CODEOWNERS file plus branch protection (the `causl-exemptions.md` path requires review from `@causl-spec-owners`).
5. **No race condition.** Single-threaded git diff. The script reads only the head and base refs; no shared mutable state. A unit test asserts the script is deterministic across 100 runs on the same PR.

The exemptions-delta workflow:

```yaml
# .github/workflows/exemptions-delta.yml
name: Exemptions delta
on:
  pull_request:
    paths:
      - 'causl-exemptions.md'
  push:
    branches: [main]
    paths:
      - 'causl-exemptions.md'

jobs:
  delta:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write  # required for SARIF upload
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # need base ref for diff
      - uses: actions/setup-node@v4
        with: { node-version: 24.x }
      - name: Compute delta and emit SARIF
        run: node scripts/ci/exemptions-delta.mjs --out tmp/sarif/exemptions.sarif
      - name: Fail on unjustified additions
        run: |
          unjustified=$(jq '.runs[0].properties["exemptions.added.unjustified"]' tmp/sarif/exemptions.sarif)
          if [ "$unjustified" -gt 0 ]; then
            echo "::error::$unjustified unjustified exemption(s) added; require non-empty 'because:' referencing §9.1 row"
            exit 1
          fi
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: tmp/sarif/exemptions.sarif
```

The `paths:` filter at the workflow level means a PR that does *not* edit `causl-exemptions.md` does not trigger this workflow at all — zero cost. A PR that does edit it pays ~30s for the delta computation and SARIF upload.

## Acceptance gate

`.github/workflows/race-detection-acceptance.yml` (separate workflow) — exercises every tier on a synthetic test PR with a known-bad and a known-good fixture; asserts each tier produces the expected SARIF.

The acceptance workflow runs on a schedule (weekly, Monday 06:00 UTC) and on manual dispatch. It does *not* run on every PR — the synthetic-PR scaffolding is heavyweight (creates a branch, opens a PR, waits for the race-detection workflow to complete, asserts SARIF, closes the PR). The weekly cadence is enough to catch wiring drift; per-PR runs would burn ~30 min/PR for no marginal value.

The acceptance gate is what closes the loop on the EPIC's "wiring stays exercised" claim from the Dependencies section. Without an acceptance run, a Tier-2 / Tier-3 leg that silently regresses to no-op (because a workflow YAML edit broke the `if:` clause, or because the `--dry-run` fallback never gets disabled when EPIC-3 lands) ships unnoticed. The acceptance workflow asserts that *each* tier produces *the SARIF the §16A.5 example specifies* — not just that the leg ran.

```yaml
# .github/workflows/race-detection-acceptance.yml
name: Race-detection acceptance
on:
  schedule:
    - cron: '0 6 * * 1'  # Monday 06:00 UTC
  workflow_dispatch:

jobs:
  acceptance-tier-1-clean:
    name: Acceptance — Tier-1 passes on clean fixture
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: tools/checker/test/fixtures/clean
      - run: ./scripts/ci/run-tier.sh 1
      - run: test "$(jq '.runs[0].results | length' tmp/sarif/tier-1.sarif)" = "0"

  acceptance-tier-1-known-bad:
    name: Acceptance — Tier-1 fails on known-cycle fixture
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: tools/checker/test/fixtures/known-cycle
      - run: ./scripts/ci/run-tier.sh 1 || true  # we expect failure
      - run: test "$(jq '.runs[0].results | length' tmp/sarif/tier-1.sarif)" -gt "0"

  # ... analogous jobs for tier-2 and tier-3 ...
```

The fixtures are immutable refs (`tools/checker/test/fixtures/clean` and `tools/checker/test/fixtures/known-cycle` — long-lived branches). Treating them as branches (rather than directories under `main`) means a PR that "fixes" the known-cycle fixture by mistake does not mask a regression in the gate.

### Operational notes

- **Rollout sequence.** Land TASK 6.1 first as a non-required check; let it bake for 5 working days against real PRs to calibrate the runtime ratchet. Promote to required once the trailing-7-day P95 is stable below 120s. Then ship TASK 6.4 (diagnostic + PR comment) so failure messages are usable. Then TASK 6.5 (exemptions). TASK 6.2 / TASK 6.3 follow EPIC-3 / EPIC-4 deliverables. **(Resolved post-ship.)** All five tasks merged in 2026-05; the as-shipped nightly cron is `30 2 * * *` (UTC), not the `0 0 * * *` sketched in TASK 6.3 above — the offset prevents collision with other midnight-UTC scheduled workflows. The workflow file was subsequently moved to `.github/workflows-disabled/` per PR #725 pending CI re-enablement.
- **Rollback plan.** Each task is reversible by reverting the workflow-file edits — no schema migration, no data dependency. The only exception is `causl-exemptions.md` (TASK 6.5): if the file is rolled back after rows have accumulated, the rows are lost. We treat `causl-exemptions.md` as part of the spec — a revert requires a corresponding spec update and CODEOWNERS sign-off.
- **Owner.** `@causl-team` GitHub team, with `@causl-spec-owners` as required reviewers on `causl-exemptions.md` changes per TASK 6.5 concern 4.
- **Telemetry.** Runtime metrics are pulled from GitHub Actions API (`gh api /repos/.../actions/workflows/race-detection.yml/runs`) and aggregated nightly into `tmp/ci-metrics/runtime.json`. The metrics file is a checked-in artifact — review-friendly, no external service required.

### Failure modes we will not paper over

- **A flaky Tier-2 failure that cannot be reproduced locally.** This is the worst diagnostic outcome — the gate fires, the adopter cannot reproduce, the team rationalises a `--rerun` and the gate's signal is lost. The deterministic-seed contract (TASK 6.4 concern 3) is the mitigation; the flakiness ratchet (brutal-critical-review final bullet) is the enforcement. If a Tier-2 counterexample does not reproduce on rerun with the same seed, the binary's seeding is broken — that is a *blocking* bug, not an inconvenience to retry around.
- **A Tier-1 leg that drifts from 90s to 4 min over a year.** The runtime ratchet (TASK 6.1 concern 1) prevents this by failing the leg when the trailing-30-day P95 exceeds 150s. We will not relax the ratchet — if Tier-1 needs to grow past 150s for a legitimate reason (new pass that catches a real row), the EPIC needs an amendment that updates the §16A.7 budget line and the ratchet ceiling together.
- **An exemption row that gets approved without a §9.1 reference.** TASK 6.5 concern 2 makes this a CI-blocking error, not a warning. A `because:` field that is non-empty but unrelated to a §9.1 row is rejected by the regex `/§9\.1 row \d+/`. CODEOWNERS approval is required *in addition to* the regex check — both must pass.
- **A Tier-3 nightly that silently fails to upload SARIF.** Tier-3's SARIF upload is what feeds the dashboard and the cost-guard. A silent failure (network blip, GitHub API throttling) leaves the metrics file stale and the ratchet effectively disabled. Mitigation: the upload step has `continue-on-error: false` and the `update-metrics.mjs` step asserts the SARIF file exists and is non-empty before recording the run.

## Out of scope

- **The bounded enumerator itself (EPIC-3).** This EPIC wires `causl-check race` into the workflow but does not implement the enumerator's BFS. EPIC-3 ships the search; this EPIC ships the gate.
- **The hypothesis API (EPIC-4).** This EPIC consumes `tests/hypotheses/*.hypothesis.ts` files but does not define the `hypothesis()` builder. EPIC-4 ships the API; this EPIC ships the runner.
- **The Apalache corpus (EPIC-7).** Tier-3 has a slot for the Apalache run but the corpus itself is EPIC-7's deliverable. Until EPIC-7 lands, the slot runs `--dry-run` and emits a SARIF stub.
- **Schema 3 IR (EPIC-1).** The diagnostic output (TASK 6.4) consumes source-mapped frames from the IR; this EPIC depends on EPIC-1's source-map-preservation contract but does not modify the IR.
- **The race-detection dashboard.** Tier-3 SARIF artifacts are uploaded to GitHub code scanning and to `actions/upload-artifact`; surfacing them on a project dashboard is a separate UX deliverable.
- **Local-dev parity tooling.** The `pnpm causl-check race` command works locally with `MODEL_CHECK_TIER=labeled` or `MODEL_CHECK_TIER=nightly`; a `pnpm causl-check race --tier=2` ergonomic wrapper is desirable but lives in EPIC-4's CLI work.
- **Cross-repo race detection.** A monorepo plugin or a federated mode where `causl-check race` runs across multiple repos sharing a graph is interesting and out of scope.
- **IDE integration.** Surfacing race-detection diagnostics in VS Code / Cursor via LSP is a separate UX deliverable; this EPIC ships the CLI and CI surface only.
- **Custom race classes beyond §9.1.** Adopters may want to declare project-specific race classes (e.g., "no commit during my-app-specific-lifecycle phase"). The §9.1 catalogue is closed by spec; adopter classes are out of scope for v1 and would require a §9.1 extension mechanism we have not yet designed.
- **Statistical false-positive-rate dashboard.** §16A.7 publishes target false-positive rates per layer (<2% static, <0.5% property, <1% enumerator-inside-bound). Tracking the actual rate against those targets over time is dashboard work that depends on a longer artifact retention than the 90 days we ship in TASK 6.3.
- **Self-hosted runners.** All tiers run on `ubuntu-latest` GitHub-hosted runners. A future cost-optimisation effort might move Tier-3 to self-hosted runners; the scheduling and cost-guard logic would need to account for runner availability and we have not done that work.
- **Notification channels beyond GitHub.** Tier-3 nightly failures surface as a GitHub Actions failure email and as a SARIF code-scanning alert. Slack / PagerDuty / email-list notifications are out of scope; teams that want them can add a downstream workflow that triggers on `workflow_run: race-detection.yml: completed: failure`.
- **Coverage metrics.** Asserting that "Tier-N covers M% of §9.1 rows" is a desirable telemetry but requires per-row instrumentation in the enumerator that does not exist in EPIC-3's scope. Coverage reporting is a follow-up that depends on EPIC-3's row-tagging contract being finalised.
- **Replay against historical SARIF.** A "rerun this counterexample against the current `main`" tool would let us verify a fix landed cleanly. The seed-replay contract supports it in principle; the tooling to drive it is out of scope.
- **Migration tooling for adopters.** A `causl init-race-detection` CLI that scaffolds `tests/hypotheses/`, `causl.config.ts` tier blocks, and a `[model-check]` label on the repo is desirable adopter onboarding but lives in EPIC-4's CLI surface, not here.
- **Cross-tier seed sharing.** If Tier-3 finds a counterexample, automatically opening a PR that adds it as a regression hypothesis under `tests/hypotheses/` would close the loop. That's a follow-up; for v1 we file the finding as a GitHub issue and a human writes the regression test.
