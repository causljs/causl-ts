# Contributing — Perf delta section

Every PR that touches `packages/{core,react,sync}/src/**` must attach
a structured Perf delta artifact in its body. The CI gate
`.github/workflows/perf-delta-template.yml` (#867) enforces this
shape; the PR template provides the headings.

The contract survived the #679 perf-experiment umbrella closing
(22/22 sub-issues complete) and remains mandatory in the
post-Rust-engine (#1133) work that picks up from #679. The canonical
narrative — required artefacts, V8-inlining discipline, quiescent-
machine precondition, two-baseline-systems table — lives at
[`docs/benchmark.md`](./benchmark.md) §"Per-PR Perf-Evidence
Protocol". This file is the contributor cheat-sheet for the
structured PR-body block only.

## How to fill it

1. **Hypothesis ID** — the `scenario` name from
   `packages/bench/src/hypotheses/causl-hypotheses.ts`
   (e.g. `scrolling-viewport`, `diamond`, `linear-chain`). Use
   `_None_` only if no scenario row was invalidated.
2. **Catalogue row before / after** — the invalidator evidence
   string from `pnpm bench:check-hypotheses`, before vs. after.
3. **Microbench median before / after / Δ% / CoV** — the four
   numbers `pnpm bench:diff` prints for the touched cell.
4. **Threshold the Δ% must beat** — the value from
   `SCENARIO_THRESHOLD_PCT` in
   `packages/bench/src/regression-gate.ts` (or
   `DEFAULT_THRESHOLD_PCT = 10`).

## Worked example — PR #854

PR #854 collapsed `anyInputSubscriberIn` to O(1) using the
`subscriptionsByNode` index. Its Perf delta would read:

- **Hypothesis ID:** `scrolling-viewport`
- **Catalogue row before:** `INVALIDATED — anyInputSubscriberIn at
  26.92% (>=5%)`
- **Catalogue row after:** `PASS — no match exceeds 5% threshold for
  "anyInputSubscriberIn"`
- **Microbench median before / after / Δ% / CoV:** `26.92% / <0.7%
  (out of top-15) / -97% / n/a (CPU-profile self-time, not
  bench:diff)`
- **Threshold the Δ% must beat:** `5%` (per #841 hypothesis row)
