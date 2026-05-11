<!--
First-person opening (SPEC §17 voice). State why this change exists in
your own words; reviewers anchor the §17.1 audit on this paragraph.

Example: "I am rewriting the four library harnesses because the
canonical scenario taxonomy added two cases the old harnesses never
exercised."
-->

## Summary

<!-- One paragraph in first person: why this change, who pushed back, what got dropped. -->

## Naming change

<!--
Required for any PR whose title starts with `feat:` / `feat(<scope>):`
and which touches `packages/*/src/index.ts`. Lists every public
binding added, renamed, or removed. The CI gate
`.github/workflows/pr-naming-rule.yml` enforces this — see
CONTRIBUTING.md#naming-change-rule. Use `_None_` only when this PR
genuinely does not change a public binding.
-->

_None_

## Race-class impact

<!--
SPEC §17 commitment 5 anchor: the §9.1 race-class catalogue stays
current as the engine grows. Required when this PR touches
`docs/race-class-audit.md`, `SPEC.async.md` §9.1, or `SPEC.md` §9.1.

For each row added or modified, name the detection layer from the
closed enumeration { STATIC | PROPERTY | MODEL | RUNTIME-ONLY } and
the witness that backs it:

  - STATIC      → static pass name in `tools/checker/src/check.rs`
  - PROPERTY    → property file path under `packages/*/test/properties/`
  - MODEL       → TLA+ model file path under `tools/enumerator/corpus/`
  - RUNTIME-ONLY → one-line justification (discouraged tier; this is
                   why §17 commitment 5 makes the discipline mechanical)

Skip-allowed when this PR does not touch the audit-table files or
SPEC §9.1 rows.

Example:

  Row S-1 (stale-async resolution race): PROPERTY
  Witness: packages/sync/test/properties/race-row-S-1.property.test.ts
-->

_None — this PR does not touch §9.1 rows._

## Perf delta

<!--
Required for any PR that touches `packages/{core,react,sync}/src/**`.
The CI gate `.github/workflows/perf-delta-template.yml` enforces this —
see `docs/contributing-perf.md` for how to fill it in, and PR #854 for
a worked example.

Fill every sub-field. Use `_None_` for an individual sub-field only
when it genuinely does not apply (e.g. no hypothesis was invalidated
yet). Leaving the whole section as `_None — no engine touch_` is
permitted only when this PR does not touch the engine source.

- **Hypothesis ID** — scenario name from `causl-hypotheses.ts` (or `_None_`)
- **Catalogue row before / after** — invalidator evidence string
  before vs. after this PR (status delta from `pnpm bench:check-hypotheses`)
- **Microbench median before / after / Δ% / CoV** — the four numbers
  from `pnpm bench:diff` for the touched cell
- **Threshold the Δ% must beat** — value from `SCENARIO_THRESHOLD_PCT`
  in `packages/bench/src/regression-gate.ts` (or `DEFAULT_THRESHOLD_PCT`)
- [ ] **Per-PR Perf-Evidence Protocol** (canonical: `docs/benchmark.md`
  §"Per-PR Perf-Evidence Protocol", per #679 / #1011) — committed
  `before.json` + `after.json`, `bench:diff` table inlined above,
  `bench:gate` green, per-cell threshold cited (vs panel-estimated),
  `.cpuprofile` for the headline-win cell attached, and — per the
  #1007 V8-inlining lesson — microbench A/B run BEFORE the engine
  PR when predicted gain is < 10× the V8 inlined-Map probe cost
  (~5–10 ns).
-->

_None — no engine touch_

## Test plan

<!--
- [ ] What scenarios you exercised (golden path + at least one
      failure-mode case)
- [ ] Property tests at the SPEC §15.2 floor of 1000 trials, where
      applicable
- [ ] CI gates this PR is expected to pass
-->

## What did the team push back on?

<!--
Optional but encouraged. Honest record of the §17.1 review pass —
which expert objected, which trade-off you took, what you cut.
-->
