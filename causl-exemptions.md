# causl-check exemptions

Per SPEC §16A.5 (false-positive economy), this file is the third
escape valve for `causl-check` findings: a per-row, file-glob-scoped
exemption recorded here so the count is visible and reviewable in
the SARIF output (the `causlExemptionCount` run-level property).

The other two valves rank higher in reversibility and should be
reached for first:

1. **Per-site `// @causl-allow:RuleId` comment** (wave-24) — local,
   adopter-owned, requires a non-empty `reason:` clause.
2. **Bound tightening per-hypothesis** (wave-25 + adopter
   `tests/causl/*.hypothesis.ts`) — local, reviewable.
3. **This file.** Loud and conspicuous by design — adding a row to
   the table here is reviewed alongside the production diff that
   needs it.

## Schema

A markdown table with four columns. Every column is required and
non-empty. The table is the primary audit surface: it is simpler to
grep, diff, and CODEOWNERS-route than a YAML block.

| column         | shape                                    | example                                |
| -------------- | ---------------------------------------- | -------------------------------------- |
| `rule_id`      | `^causl/[a-z0-9-]+$`                     | `causl/subscribe-without-dispose`      |
| `file_glob`    | path or glob, no leading `/`             | `packages/legacy-dashboard/**`         |
| `justification`| non-empty, `>` 10 characters             | `Pre-#220 callsites, removal in flight`|
| `owner`        | starts with `@`, github handle / team    | `@core-team`                           |

The audit at `tools/audit/check-exemptions.ts` validates the schema
on every PR via `pnpm audit:commitments`. The SARIF emitter
(`tools/checker/src/sarif.rs`) counts the rows and surfaces the
count as `runs[0].properties.causlExemptionCount` so adopters'
SARIF dashboards can flag a growing exemption set.

Adding or modifying rows is gated by
`.github/workflows-disabled/exemptions-delta.yml`: a PR that touches
this file requires a CODEOWNERS-listed reviewer (the loose check the
workflow runs is documented in its header). The workflow is parked
in `workflows-disabled/` per PR #725 (org-level Actions billing);
the CODEOWNERS routing in `.github/CODEOWNERS` continues to attach
reviewers on every PR that mutates this file.

## CI integration

- **`pnpm audit:commitments`** runs `check-exemptions.ts` (via
  `tools/audit/run-all.ts`) and fails the gate on any malformed row.
  This is the live PR-level gate while the GitHub Actions workflows
  in `.github/workflows-disabled/` remain parked.
- **`exemptions-delta.yml`** (currently in `workflows-disabled/` per
  PR #725) fails the workflow on PRs that mutate
  `causl-exemptions.md` without a CODEOWNERS-team reviewer. Re-enables
  by reversing the rename into `.github/workflows/`.
- **SARIF run-level property** — `causlExemptionCount: <n>` is
  emitted on every `causl-check` invocation, so adopter dashboards
  can graph the exemption budget over time.

## Active exemptions

<!-- table-begin -->

| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |

<!-- table-end -->

(The table above ships empty. Adopters add rows beneath the header
separator. The audit script accepts an empty table — the precondition
is "every present row is well-formed", not "at least one row exists".)
