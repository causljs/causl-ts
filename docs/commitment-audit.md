# DESIGN-DISCIPLINE commitment audit

Per SPEC §17.1 / §17.2: the project ships against a closed list of
design commitments. Each commitment has a mechanization tier:

- **MECHANICAL** — a CI gate or compile-time check that fails if the
  commitment is violated. The gate is the witness; no human review
  is required to confirm it holds today.
- **PROPERTY** — a property test at the 1000-trial floor. The test
  is the witness; a regression is caught on the first failing
  trial.
- **REVIEW** — human review against the spec section. The witness
  is the merge-request approval; no automation enforces it.
- **DEFERRED** — out of scope for v1; tracked for follow-on work.

A commitment can move only towards MECHANICAL (PROPERTY → MECHANICAL,
REVIEW → PROPERTY → MECHANICAL). Moving back is a §17.2 amendment.

## Numbering note (as of v0.9.0)

**SPEC §17.1 today lists fourteen commitments** — the original twelve
plus commitment 13 (capability-cost residual `mobx × 3.0…8.0` band,
#1005 amendment landed by PR #1024) and commitment 14 (three-tier
host compatibility matrix `wasmgc-builtins` / `wasmgc-classic` /
`serde-json` with TS-engine fallback, #690 amendment landed by
PR #1053). The table below uses the legacy combined audit-script
numbering scheme introduced by EPIC-13 (engine rows 1–11, adapter
rows 12–20), which does **not** map 1:1 to SPEC §17.1's row
numbers; the audit scripts in `tools/audit/check-commitment-<n>.ts`
correspond to the rows in this table, not to SPEC §17.1 rows of
the same number. SPEC §17.1 commitments 13 and 14 are gated outside
this ledger — commitment 13 by `pnpm bench:check-hypotheses` plus
`packages/core/test/properties/spec-17-capability-cost.property.test.ts`,
commitment 14 by the host-tier table in `packages/core/wasm/README.md`
and the size-limit cells per artefact (currently with a documented
divergence on the Tier 3 raw-byte ceiling tracked by #1150 per
SPEC §17.6 "Current state" callout).

## Audit cadence

Quarterly. The `quarterly-audit.yml` GitHub Actions workflow opens
an issue at the start of each quarter listing every commitment, its
current tier, and any pending mechanization upgrades. The issue is
the audit ledger; closing it requires a written team consensus on
each tier change.

**Current state (as of v0.9.0).** PR #725 moved all GitHub Actions
workflows into `.github/workflows-disabled/` while org-level billing
is unresolved, so `quarterly-audit.yml` does not currently run on
schedule. The PR-level gate `pnpm audit:commitments` (driven by
`tools/audit/run-all.ts`) continues to run locally and as part of
the merge-readiness checks PR authors paste into descriptions; the
cron will reactivate when the workflows are restored by reversing
the rename in `.github/workflows-disabled/` → `.github/workflows/`.

## Per-commitment status (v1)

| # | Commitment | Tier | Witness |
|---|---|---|---|
| 1 | Two-primitive runtime universe (`Input \| Derived`) | MECHANICAL | `causl-check`'s schema gate refuses non-two-arm `IrNode` enums (#359) |
| 2 | GraphTime monotonicity (Theorem 4) | PROPERTY | `packages/core/test/properties/atomicity.test.ts` |
| 3 | Glitch-freedom (Theorem 2) | PROPERTY | `packages/core/test/properties/recompute-count-fuzz.property.test.ts` |
| 4 | Single-pipeline mutation (Theorem 2) | PROPERTY | `packages/sync/test/theorems/theorem-2-single-pipeline-mutation.test.ts` |
| 5 | Origin pinning (Theorem 1) | PROPERTY | `packages/sync/test/properties/origin-bound-resolution.property.test.ts` |
| 6 | §10 worked example as acceptance gate | MECHANICAL | `packages/sync/test/spec-async-10-{1,2,3,4}*.test.ts` (EPIC-8) |
| 7 | Forbidden transitions throw structured errors | MECHANICAL | `packages/sync/test/conflictTransitions.test.ts` + `ForbiddenResourceTransitionError` runtime gate |
| 8 | 1000-trial floor on every property suite | MECHANICAL | `packages/core/test/spec-15.2-conformance.test.ts` walker |
| 9 | §9.1 STATIC subset fully covered by `causl-check` | MECHANICAL | EPIC-2's four lint passes (rows 1, 11, 13, 14 lifted to STATIC) |
| 10 | Schema discipline (lockstep workflow) | MECHANICAL | `.github/workflows-disabled/release-checker.yml` `version-lockstep` job (parked per PR #725; runs locally via the same script the job invokes) |
| 11 | Race-class audit cadence | REVIEW | `docs/race-class-audit.md` + this file's quarterly cron |
| 12 | (Adapter) Semantic-foundation page lands first | REVIEW | SPEC.async §3 + `docs/semantics-async.md` (#583) |
| 13 | (Adapter) Two-primitive surface stays at two (Resource + Conflict) | REVIEW | `packages/sync/src/index.ts` exports — quarterly review |
| 14 | (Adapter) Capability narrowing on ConflictRegistry per §7 | MECHANICAL | `packages/sync/test/conflictRegistry.narrowCapability.test.ts` (compile-time) + `narrowCapability` runtime proxy + `tools/audit/check-commitment-14.ts` (structural floor) |
| 15 | (Adapter) DU + assertNever exhaustiveness on ResourceState, Conflict | MECHANICAL | `packages/sync/test-d/resource-state.exhaustiveness.test-d.ts` + `conflict-kind.exhaustiveness.test-d.ts` (#581) |
| 16 | (Adapter) §9.1 race-class catalogue current for adapter rows | REVIEW | `docs/race-class-audit.md` S-row sections + S-row witness files |
| 17 | (Adapter) §10 worked example as adapter acceptance gate | MECHANICAL | `packages/sync/test/spec-async-10-{1,2,3,4}-*.test.ts` + spec-async-10-fixture-corrections (#576) |
| 18 | (Adapter) No enum tags whose transitions aren't specified by §6 chart | REVIEW | `docs/lifecycle.md` §1 (ResourceFleet) + §2 (ConflictRegistry) |
| 19 | (Adapter) §15 properties hold at 1000-trial floor | MECHANICAL | `packages/core/test/spec-15.2-conformance.test.ts` walker enrolls adapter property tests |
| 20 | (Adapter) §16A static layer adapter rules cover S-rows | MECHANICAL | `tools/checker/tests/subscribe_without_dispose.rs` + `use_after_dispose.rs` |

## Pending mechanizations

- **Commitment 11** (race-class audit) — currently REVIEW. The
  quarterly cron in `quarterly-audit.yml` makes the cadence
  MECHANICAL but the per-row "is the witness present?" check is
  still REVIEW. The `tools/audit/check-commitment-11.ts` script
  (#565, post-rename from `check-commitment-12.ts`) scans
  `docs/race-class-audit.md`'s table and verifies every named
  property witness file exists. Adding a 1000-trial-floor scan to
  the same script lifts commitment 11 to MECHANICAL.
- **Commitment 5** (origin pinning) — currently PROPERTY. The
  bounded enumerator (EPIC-3) will lift this to MECHANICAL once
  its oracle predicates and the §16.5.1 hypothesis grammar (EPIC-4)
  compose end-to-end. Tracked as the §16.0 reopen-trigger.

## Audit-script directory

`tools/audit/` houses per-row predicate scripts that mechanize
commitment checks. Each script exits 0 if the commitment holds today
and exits non-zero with a diagnostic if it doesn't. The directory
also ships two non-numbered predicate scripts that belong in the
same PR-level gate and are appended explicitly by `run-all.ts`:
`check-apalache-mapping.ts` (verifies the Apalache differential
mapping doc) and `check-exemptions.ts` (validates the
`causl-exemptions.md` table schema).

The `quarterly-audit.yml` workflow runs `run-all.ts` and renders the
results into the issue body it opens. While the workflow is parked
in `.github/workflows-disabled/` per PR #725, the same orchestrator
runs locally via `pnpm audit:commitments` on every PR.
