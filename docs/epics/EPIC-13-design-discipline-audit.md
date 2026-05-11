# EPIC: DESIGN-DISCIPLINE commitment audit

**Spec anchors:** SPEC.md §17.3, SPEC.async §17.3.

**Risk:** LOW — review-policy artifact + a quarterly checklist; no code change touches the engine, the adapter, or the checker. The cron workflow opens issues; it does not gate merges. The optional predicate scripts in TASK 13.3 are read-only over git history and the working tree.

**Dependencies:** none. Ships today. The artifact is markdown plus YAML; nothing in the EPIC-1 through EPIC-12 chain blocks it, and nothing in this EPIC blocks them. The only soft dependency is on the existing CODEOWNERS file at `.github/CODEOWNERS`, which already exists.

> **Current state (as of v0.9.0, 2026-05).** Shipped via Phase 8 wave-1
> (#565, #566, #567, #568, #569, #581 — commit `9664f53`), with the
> per-commitment predicate scripts extended through #1153 (the
> 20-commitment current set is the post-0.9.0 catalogue). The
> implementation diverged meaningfully from this EPIC draft;
> divergences below:
>
> - **The tier taxonomy was rewritten.** The draft framed everything
>   around a binary MECHANICAL / DESIGN-DISCIPLINE split with "ten
>   DESIGN-DISCIPLINE rows" as the audit's scope. The shipped
>   `docs/commitment-audit.md` uses four tiers — MECHANICAL,
>   PROPERTY, REVIEW, DEFERRED — over **twenty** commitments (twelve
>   engine, eight adapter under one renumbered table; see #581).
>   Today the live distribution is roughly 11 MECHANICAL + 5
>   PROPERTY + 4 REVIEW (which is what this EPIC called
>   DESIGN-DISCIPLINE). The audit-doc preamble owns the canonical
>   tier definitions; this EPIC's wording is preserved here for
>   historical context.
> - **The per-commitment predicate scripts ship for all twenty rows,
>   not only the six engine + four adapter rows the draft anticipated.**
>   `tools/audit/check-commitment-{1..20}.ts` all exist;
>   `tools/audit/run-all.ts` is the orchestrator
>   (`pnpm audit:commitments` script in root `package.json`).
>   `tools/audit/check-apalache-mapping.ts`, `check-exemptions.ts`,
>   and `check-sarif-schema.ts` are sibling predicates that audit
>   adjacent artefacts. The TASK 13.3 file list (`check-commitment-1.ts`
>   through `check-commitment-12.ts` plus a parenthetical rename note)
>   is a subset of what landed.
> - **The quarterly cron is currently disabled.**
>   `.github/workflows/quarterly-audit.yml` is not present in `main`;
>   the workflow file ships under
>   `.github/workflows-disabled/quarterly-audit.yml` and is not
>   firing. The PR-level `pnpm audit:commitments` gate (and
>   `pnpm audit:test` for the predicates' own unit tests) is the
>   active enforcement; the quarterly cron's auto-open-issue
>   behaviour is deferred until the workflow is moved back into
>   `.github/workflows/`. The "first quarterly audit closes within
>   30 days" acceptance gate at the bottom of this EPIC is therefore
>   not yet active.
> - **Commitment 11's identity shifted.** This EPIC's draft named
>   commitment 11 the "bounded-enumerator fixtures" row (engine).
>   In the shipped catalogue, commitment 11 is "Race-class audit
>   cadence" (REVIEW tier; witness is `docs/race-class-audit.md` plus
>   the quarterly cron). The bounded-enumerator concern is tracked
>   under the EPIC-3 chain rather than as a single audit row. The
>   `check-commitment-11.ts` orchestrator note in TASK 13.3 (the
>   `#565` rename mention) reflects the renumber.
> - **The acceptance gate's "first quarterly audit" has not run.**
>   The audit doc was populated on land day per the spirit of
>   TASK 13.5 — every row carries a Witness column entry. A formal
>   30-day "audit closes with notes" cycle has not run because the
>   cron workflow is disabled (see above). Anyone reactivating the
>   quarterly cadence inherits the responsibility to perform the
>   first audit and write the per-row notes; the doc structure
>   supports it but the ritual has not been exercised against the
>   shipped artefacts.
>
> The EPIC's load-bearing claim — design commitments are visible,
> witnessed, and auditable — holds via the 20-row catalogue and the
> `pnpm audit:commitments` gate. The cadence enforcement and the
> first-audit ritual remain on the backlog.

## What I'm shipping

Beck's framing of commitments-as-contract is the load-bearing line: a commitment without an audit is not a commitment, it is an aspiration the team has talked itself into believing. The §17 tables in both SPEC.md and SPEC.async list twelve plus nine rows; six of the twelve and four of the nine are marked DESIGN-DISCIPLINE, meaning the discipline is enforced by review policy alone. Review policy works on the day the spec is signed. It rots silently between the signing and the next time someone goes looking. That gap is what this EPIC closes.

Martin's TDD-as-professionalism framing reinforces the same line from a different angle: the discipline is the discipline, and the team's signature on a row is worth what the team will hold itself to over time. The MECHANICAL rows hold themselves — `tsc` runs every PR, `assertNever` fires on every missing arm, the `checker-gate` job is a required green. The DESIGN-DISCIPLINE rows hold only when the team walks the table. Six engine rows (1, 2, 5, 7, 11, 12) plus four adapter rows (1, 2, 5, 7) is ten rows the team has signed for and ten rows that today have no recurring touch.

Fowler's interpretation-for-working-teams framing kept the design-discipline rows from being struck during the §17 rewrite. The argument was: not every commitment can be mechanized without producing false positives at every refactor. The §17.4 paragraph in SPEC.md spells out the rejected alternatives — mechanize-all-twelve produces a CI rule that flags "this PR did not update §3" on every typo fix; mechanize-or-strike hands the discipline back to "it's in the back of someone's head." The team picked **mark explicitly**, with the mark itself being the discipline. This EPIC is the second half of that decision: the mark is the discipline, and the audit is what makes the mark visible at a quarterly cadence rather than an annual surprise.

The shape: a `docs/commitment-audit.md` template that mirrors the ten DESIGN-DISCIPLINE rows from both specs as a checklist, plus a `.github/workflows/quarterly-audit.yml` cron that opens a GitHub issue every 90 days reminding the team to walk the table. Optional per-row predicate scripts under `tools/audit/` produce an automated first-pass verdict that the auditor reviews and overrides at will. CODEOWNERS extends to cover the audit doc so updates require team review. The first quarterly audit closes within 30 days of the cron firing, with notes on every DESIGN-DISCIPLINE row.

What this EPIC is *not*: it is not a new CI gate, it is not a substitute for the §17.4 design choice that left the rows DESIGN-DISCIPLINE on purpose, it is not a graduation path for any row to MECHANICAL (commitment 11's graduation on §16.4 reopen is a separate EPIC), and it is not a tool that fails PRs. It is the recurring touch that turns "the team holds these commitments because the team holds them" from a sentence in §17.4 into a visible quarterly artifact.

## Brutal-critical review

Where the spec is right, and where this EPIC sits inside that rightness:

- **Not every commitment can be mechanized.** Commitment 1 ("the semantic-foundation page in §3 lands first") is a *habit of authorship*; a CI rule that asserted "every SPEC-touching PR also touches §3" would fire on every typo fix and train the team to disable it. The §17.4 rejection of mechanize-all-twelve is correct; the audit's job is to confirm at quarterly cadence that the habit is still being practised, not to enforce it on every PR.

- **Some rows require human judgment by construction.** Commitment 7 ("no enum tags whose transitions are not specified by the §6 chart") is enforced at the type level for the `assertNever` arm, but the *upstream* discipline — the new tag should not exist at all unless §6 grew the chart first — is a review-policy thing. The auditor walks `docs/lifecycle.md` against the §6 statechart and asks: did any tag ship between audits whose transition story was added after the fact?

- **The team's stated discipline is real.** §17.4's argument that the team's habit on §3 going first, on §12.2 audits, on the §9.1 catalogue, on §6 transitions, on §16.4 enumerator fixtures-on-the-shelf, and on the §9.1 row layer-assignment habit is real even when no test runs against it — the audit confirms that the spec's claim about the team is still true. The audit does not replace the discipline; it is the recurring confirmation that the discipline is still being held.

Where the spec might be wrong, or at least where the EPIC should hedge:

- **A quarterly cadence might be too slow for some rows.** Commitment 5 (the §9.1 race-class catalogue is current as the engine grows) is the highest-velocity row — every PR that adds a race class needs to update the catalogue *in the same PR*, not three months later. The PR template anchor at `.github/PULL_REQUEST_TEMPLATE.md` (#399 / #430) is the per-PR enforcement; the quarterly audit's job for commitment 5 is the *retrospective* — was the per-PR enforcement actually applied, or did some PRs slip through? Quarterly is right for the retrospective; the per-PR anchor is the live enforcement.

- **A quarterly cadence might be too fast for some rows.** Commitment 1 (the semantic-foundation page lands first) is a once-per-major-spec-revision concern; quarterly is overkill if no SPEC.md revision has shipped since the last audit. Mitigation: the audit-notes line for commitment 1 on a no-SPEC-changes quarter reads "no SPEC.md changes since last audit; commitment 1 not exercised; green by inactivity." This is honest, takes ten seconds, and avoids the trap of inventing review work to fill a checkbox.

- **One cadence might be wrong for the whole table.** The TASK 13.1 design defaults to 90 days but allows per-row override. Commitment 5 might want 30-day cadence (catalogue currency is high-velocity); commitment 11 might want 180-day cadence (enumerator fixtures change rarely until §16.4 reopens). The cron fires every 90 days regardless; per-row cadence is a *gate on whether the row gets serious review this quarter or a sentence-long acknowledgement*. The audit's job is to record both.

- **The audit-as-checkbox-ritual failure mode.** A quarterly issue that gets closed with ten "green" checkboxes and no notes is worse than no audit, because it manufactures false confidence. TASK 13.1 concern 4 ("audit-notes — each audit produces 1-3 sentences of notes; not a checkbox-only ritual") is the spine of the design. The CODEOWNERS-approved closing criterion (TASK 13.4 concern 4) makes the lack of notes a blocking comment, not a green merge. The acceptance gate at the bottom reinforces it: "with notes on every DESIGN-DISCIPLINE row," not "with all rows checked."

- **Predicate false positives.** TASK 13.3 ships heuristic predicates that flag rows for human review; the heuristics will be wrong sometimes. Commitment 1's predicate ("inspect the last 100 PRs touching SPEC.md and count the ones that touched §3 last vs first") will flag a PR that fixed a typo in §5 without touching §3, and the auditor needs to mark that row green with a "typo-fix PRs are not §3 violations" note. The 5-concerns-per-predicate consolidated set in TASK 13.3 makes the heuristic's false-positive economy explicit: predicates flag, auditors override, the audit-notes line records the override.

- **The cron not firing.** GitHub Actions cron jobs are best-effort; a busy runner can delay a `0 0 1 */3 *` schedule by hours, and a misconfigured cron can silently miss a quarter. Mitigation: TASK 13.2 concern 1 includes a self-check that the previous quarter's audit issue exists and was closed; if the previous issue is missing or unclosed, the new run posts an alert in the new issue's body so the discrepancy is visible. The audit checking on itself is the same shape as the §17 commitment table checking on itself — the artifact's existence is part of the audit.

- **CODEOWNERS drift.** The audit doc is owned by the core team via TASK 13.4. If CODEOWNERS is restructured between audits and the audit doc's owner becomes a stale reference, the cron-opened issue's auto-assignment fails silently. Mitigation: TASK 13.2 concern 3 reads CODEOWNERS at issue-open time and falls back to assigning the repo's last three committers if the named owner is unresolvable. The fallback is logged in the issue body so the failure is visible.

- **Migration of a row from DESIGN-DISCIPLINE to MECHANICAL.** Commitment 11 is the example: §17.1 marks it "DESIGN-DISCIPLINE today; MECHANICAL on §16.4 reopen." When EPIC-3 lands and the bounded enumerator binary ships in `checker-gate`, commitment 11 graduates and the audit row should drop. The audit doc's row format includes a "graduation criterion" field; on graduation, the row gets archived rather than deleted, and the audit-notes line on the graduating quarter records the EPIC reference and the date.

- **The auditor-as-single-point-of-failure.** A quarterly audit performed by one person produces one person's reading of ten rows. If that person reads commitment 5 ("race-class catalogue currency") narrowly — only checking that the §9.1 row count matches the fixture count — they miss the deeper question of whether the catalogue's *prose descriptions* still match the engine's behaviour. Mitigation: TASK 13.4 concern 4 names CODEOWNERS as the reviewer of the closing PR, which means at least two team members read the audit before it lands. The reviewer's job is not to re-perform the audit but to confirm the auditor's notes are substantive (not "looks good") and that any yellow rows have follow-up actions on file.

- **Audit fatigue.** Ten rows reviewed every 90 days for many quarters runs the risk of becoming a paperwork exercise. The mitigation is structural: the per-row cadence override (commitment 1 at 90-day default but acknowledged in seconds when no SPEC changes shipped; commitment 5 at 30-day cadence because catalogue currency is high-velocity) means the auditor's effort scales with the actual risk, not with a fixed quarterly drumbeat. A quarter where seven rows are "no changes since last audit; green" and three rows get serious review is exactly the right shape; a quarter where all ten get a one-sentence rubber-stamp is the failure mode the CODEOWNERS reviewer catches.

- **Spec evolution outpacing the audit.** If the team adds a thirteenth commitment to SPEC.md §17 between audits and the audit doc isn't updated in the same PR, the new row escapes audit coverage for up to a quarter. Mitigation: TASK 13.1's TDD test suite asserts row-count parity between the two specs and `docs/commitment-audit.md`; a PR that adds a §17 row without updating the audit doc fails the test. The CODEOWNERS entry on `docs/commitment-audit.md` plus the test together are the structural defence — the test fails the PR's CI, the reviewer enforces the doc update, and the new row enters the audit with the same care as the existing ten.

- **Audit notes as confidential.** Some audit findings might describe internal team friction — e.g., "commitment 12 yellow because the PR template anchor was bypassed twice this quarter on PRs from contributor X." Recording that in a public audit doc is uncomfortable. Mitigation: the audit notes record the *commitment*-level finding ("anchor bypassed twice this quarter") not the personal attribution; follow-up actions go through the team's normal channels. The audit doc is for the rows, not for the people. This convention is documented in the audit-doc preamble in TASK 13.1.

- **What about commitments not in §17.** SPEC.md and SPEC.async carry many commitments outside the explicit §17 tables — §3 theorems, §6 transitions, §13 deferred-capability rules, §16A layer assignments. Are any of those "DESIGN-DISCIPLINE in spirit but not in the table"? The §17 design choice is that the table is the contract; anything not in the table is *implementation strategy*, not a *signed commitment*. The audit covers exactly the §17 DESIGN-DISCIPLINE rows; any creep into auditing implementation strategy is rejected by the CODEOWNERS reviewer on the audit-doc PR. The line between commitment and strategy is the §17 table; the audit respects that line.

## Sub-issues (TASKS)

### TASK 13.1 — `docs/commitment-audit.md` template + first audit

**Files:** `docs/commitment-audit.md` (new).

The template is a markdown checklist mirroring §17.1's table from both SPEC.md and SPEC.async.md. For each DESIGN-DISCIPLINE row, the template carries: a checkbox, the spec anchor, the commitment text verbatim, a "last audited at" date field, a "next audit due at" date field, a per-row cadence (defaulting to 90 days), an audit-notes block of 1-3 sentences, and a graduation-criterion field (used for commitment 11 today, blank for the rest).

The ten rows the template covers:

- SPEC.md §17.1 commitment 1 — semantic-foundation page lands first.
- SPEC.md §17.1 commitment 2 — public surface §12.2 quarterly audit.
- SPEC.md §17.1 commitment 5 — race-class catalogue currency.
- SPEC.md §17.1 commitment 7 — no off-chart enum tags.
- SPEC.md §17.1 commitment 11 — bounded-enumerator fixtures (graduation pending §16.4).
- SPEC.md §17.1 commitment 12 — every new §9.1 row ships with a detection-layer assignment in the same PR.
- SPEC.async §17.1 commitment 1 — adapter semantic-foundation page lands first.
- SPEC.async §17.1 commitment 2 — two-primitive surface stays at two.
- SPEC.async §17.1 commitment 5 — adapter race-class catalogue currency for rows 2, 6, 17.
- SPEC.async §17.1 commitment 7 — no off-chart enum tags on the adapter side.

The first audit ships in the same PR as the template, with audit-notes for every row. This is the spine of the EPIC: the audit doc is created in the green state, with the team's signature on every row, on the date the EPIC lands.

The first audit's notes are not perfunctory. For each row, the auditor walks the spec anchor, confirms the predicate's verdict (or runs the manual check the predicate doesn't cover), and writes a 1-3 sentence summary that establishes the baseline. Subsequent audits compare against this baseline; "no changes since last audit" only carries weight if the last audit's findings are on file. Some examples of what land-day notes might read:

- *Commitment 1 (SPEC.md):* "§3 of SPEC.md last revised on 2026-04-18; the last 30 SPEC-touching PRs all touched §3 first or did not touch the section graph. Predicate green; manual check confirms."
- *Commitment 5 (SPEC.md):* "§9.1 currently lists 28 race-class rows; `tools/checker/tests/fixtures/` carries 28 fixtures; `tools/checker/tests/race-detection-acceptance.rs` enumerates all 28. Per-row anchors line up. Predicate green."
- *Commitment 11 (SPEC.md):* "Shelf fixtures under `tools/checker/tests/enumerator/soundness/` total 14 entries against §16.4's 14 model-class rows. §16.4 remains closed pending EPIC-3; graduation criterion documented but not pending. Predicate green."
- *Commitment 1 (SPEC.async):* "§3 of `tmp/spec-async-drafts/section-3-1-theorems.md` is the source of record for the adapter's semantic foundation; the four theorems track. No SPEC.async revisions since draft consolidation. Predicate green by inactivity."
- *Commitment 7 (SPEC.async):* "Adapter source carries `kind: 'idle' | 'loading' | 'loaded' | 'stale' | 'errored'` for `Resource` and `kind: 'open' | 'resolved' | 'ignored' | 'superseded'` for `Conflict`; both sets fully mapped in `docs/lifecycle.md` §1 and §2. Predicate green."

The point of the verbose first audit is to leave a thick footprint so a future auditor — possibly a new team member who joined after the EPIC landed — can read the baseline and understand what "current" looks like for each row.

#### TDD test suite

- The file exists at `docs/commitment-audit.md`.
- It includes every DESIGN-DISCIPLINE row from SPEC.md §17.1 and SPEC.async §17.1.
- Each row has a checkbox.
- Each row references the SPEC anchor (section number plus file).
- A PR that adds a DESIGN-DISCIPLINE row to either spec but does not update this file is rejected by the CODEOWNERS review under TASK 13.4.
- The "last audited at" date on the initial commit equals the EPIC's land date; the "next audit due at" date is land-date + per-row cadence.

#### 5 concerns

1. **Coverage** — every DESIGN-DISCIPLINE row from both SPECs is in the audit list. The TDD test suite asserts the count (six engine rows plus four adapter rows = ten rows on land day) and asserts each row by section number. A row added to either spec without a corresponding entry in `docs/commitment-audit.md` is caught by the CODEOWNERS reviewer; the test fixture under `tools/audit/tests/coverage.test.ts` cross-references the spec headers and fails on a missing row.
2. **Anchor** — each row references the spec section plus the issue or PR that established it. Commitment 5 references #399 and #430 (the PR template anchor); commitment 11 references the §16.0 reopen note; commitment 12 references the §16A.1 layer table. The anchors are not editorial — they are the row's evidence-on-file, and the auditor uses them to navigate to what the row is actually claiming.
3. **Cadence** — quarterly default (90 days); per-row override allowed. Commitment 5's row in the template defaults to 30 days because the catalogue currency is high-velocity; commitment 11 defaults to 180 days because the row is in graduation-pending status and rarely changes. The cron in TASK 13.2 fires every 90 days regardless; the per-row cadence determines whether the row gets serious review this quarter or a one-line acknowledgement.
4. **Audit-notes** — each audit produces 1-3 sentences of notes; not a checkbox-only ritual. The notes record what the auditor looked at, what they found, and any follow-up action. A row whose notes read "green; no SPEC changes since last audit; commitment not exercised this quarter" is honest and accepted; a row whose notes are blank is rejected by the CODEOWNERS reviewer.
5. **No race condition** — markdown. The audit doc is a single file edited under a single PR per quarter. There is no concurrent-edit hazard, no time-of-check-vs-time-of-use, and no gating on a separate system. The simplicity is load-bearing — the audit's value is its legibility, not its mechanism.

#### Row format

Every row in the doc carries a fixed schema so the cron-opened issue can render it deterministically:

```markdown
### SPEC.md §17.1 commitment 5 — race-class catalogue currency

- **Spec anchor:** SPEC.md §9.1; PR template at `.github/PULL_REQUEST_TEMPLATE.md` (#399 / #430).
- **Type:** DESIGN-DISCIPLINE.
- **Cadence:** 30 days (override of 90-day default; high-velocity row).
- **Last audited at:** 2026-05-02.
- **Next audit due at:** 2026-06-01.
- **Graduation criterion:** none.
- **Predicate evidence:** `tools/audit/check-commitment-5.ts` output table.
- **Auditor verdict:** [ ] green / [ ] yellow / [ ] red.
- **Audit notes:** Catalogue and fixtures agree on row count (28 rows, 28 fixtures). One PR (#NNN) added a §9.1 row this quarter without a same-PR fixture; fixture landed two days later in #MMM. Reviewed and accepted; per-PR enforcement was effective in the immediate follow-up. No follow-up action required.
```

The schema's eight fields are not negotiable — the cron-opened issue parses the row by field name, and a row that ships without one of the eight fields fails the TDD test in `tools/audit/tests/schema.test.ts`. Adding a ninth field is allowed but requires the parser update in TASK 13.2 to land in the same PR.

### TASK 13.2 — `.github/workflows/quarterly-audit.yml` cron

**Files:** `.github/workflows/quarterly-audit.yml` (new).

A scheduled GitHub Actions workflow at `cron: '0 0 1 */3 *'` (every three months on the 1st, midnight UTC). The job opens a GitHub issue with the audit checklist pre-populated from `docs/commitment-audit.md`, assigns it to CODEOWNERS, sets a 30-day milestone aligned with the acceptance gate, and posts a comment if the previous quarter's issue is still open or was never opened.

The issue body contains: the ten DESIGN-DISCIPLINE rows as checkboxes, links to the spec anchors, the previous audit's notes for context, the per-row cadence, the predicate output from TASK 13.3 (when those land), and a closing-checklist that mirrors TASK 13.4 concern 4 ("all rows reviewed and either green or with notes").

#### 5 concerns

1. **Schedule discipline** — cron runs once per quarter, not more. The cron expression `0 0 1 */3 *` fires on the 1st of January, April, July, and October at midnight UTC. The job's first step checks GitHub Actions' workflow run history for the same workflow; if a run completed within the last 60 days, the job exits early to defend against the rare double-fire that GitHub Actions cron jobs occasionally produce. The 60-day floor is half the quarterly cadence — a real quarterly fire is 90 days apart, so the floor cannot suppress a legitimate run.
2. **Issue template** — pre-populated with the latest commitment-audit checklist. The job reads `docs/commitment-audit.md` at run time, parses the row table, renders an issue body with one checkbox per row plus the spec anchor and the previous audit's notes, and posts the issue via `gh issue create`. The template is not a static file under `.github/ISSUE_TEMPLATE/` because the source of truth is the audit doc itself; the issue rendered from the doc is always current with the doc.
3. **CODEOWNERS assignment** — the issue is auto-assigned. The job reads `.github/CODEOWNERS` at run time, finds the entry covering `docs/commitment-audit.md`, resolves the owners (team handle or list of users), and assigns them on the new issue. If the resolution fails (CODEOWNERS file missing the entry, team handle unresolvable, named user no longer in the org), the job falls back to assigning the repo's last three committers from `git log -3 --pretty=format:'%ae'`. The fallback is logged as a comment on the issue so the discrepancy is visible to whoever picks it up.
4. **Idempotency** — re-running the cron does not open a duplicate issue if one is open. Before posting, the job queries `gh issue list --label commitment-audit --state open` and exits early if any open issue carries the `commitment-audit` label. The `commitment-audit` label is created on first run if absent. A manually-triggered re-run via `workflow_dispatch` (allowed for testing) carries a `force: true` input that bypasses the idempotency check; the bypass is logged in the issue title (`[manual]` prefix) so a manually-opened issue is distinguishable from a cron-opened one.
5. **No race condition** — runs single-purpose. The workflow has one job with one step that takes lock-free actions: read the audit doc, parse rows, render markdown, query open issues, post a new one if appropriate. There is no concurrent run hazard because GitHub Actions cron jobs do not parallel-fire from the same `cron:` expression; the `workflow_dispatch` path is a manual override that requires explicit input.

#### Workflow shape

```yaml
# .github/workflows/quarterly-audit.yml
name: Quarterly DESIGN-DISCIPLINE audit
on:
  schedule:
    - cron: '0 0 1 */3 *'  # 1st of Jan/Apr/Jul/Oct, midnight UTC
  workflow_dispatch:
    inputs:
      force:
        description: 'Bypass idempotency check (for testing)'
        required: false
        type: boolean
        default: false

permissions:
  issues: write
  contents: read

jobs:
  open-audit-issue:
    name: Open quarterly audit issue
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24.x }
      - name: Idempotency — skip if previous run within 60 days
        if: ${{ !inputs.force }}
        run: node tools/audit/check-idempotency.ts
      - name: Skip if open audit issue already exists
        if: ${{ !inputs.force }}
        run: |
          if gh issue list --label commitment-audit --state open --json number | jq -e 'length > 0'; then
            echo "::notice::Open audit issue exists; skipping."
            exit 0
          fi
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Render issue body from audit doc
        run: node tools/audit/render-issue.ts > /tmp/issue-body.md
      - name: Resolve CODEOWNERS for assignment
        id: owners
        run: node tools/audit/resolve-owners.ts >> $GITHUB_OUTPUT
      - name: Post audit issue
        run: |
          gh issue create \
            --title "$(date +%Y-Q%q) DESIGN-DISCIPLINE commitment audit" \
            --body-file /tmp/issue-body.md \
            --label commitment-audit \
            --assignee "${{ steps.owners.outputs.assignees }}" \
            --milestone "Audit due $(date -d '+30 days' +%Y-%m-%d)"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The workflow's `permissions:` block is minimal — `issues: write` for the issue creation, `contents: read` for the audit-doc parsing. No `pull-requests: write`, no `actions: write`, no broader scope. The token's surface is no larger than the job needs.

### TASK 13.3 — Per-row audit predicates (where mechanizable)

**Files:**

- `tools/audit/check-commitment-1.ts` (new) — semantic-foundation page lands first.
- `tools/audit/check-commitment-2.ts` (new) — public surface quarterly audit.
- `tools/audit/check-commitment-5.ts` (new) — race-class catalogue currency.
- `tools/audit/check-commitment-7.ts` (new) — no off-chart enum tags.
- `tools/audit/check-commitment-11.ts` (new) — race-class audit-of-the-audit (every named row in `docs/race-class-audit.md` has a property witness file). Originally shipped as `check-commitment-12.ts` but renamed in #565 once the misnumbering was caught — the file audits Commitment 11, not 12.
- `tools/audit/run-all.ts` (new in #565) — orchestrator that invokes every `check-commitment-*.ts` and reports a per-script PASS/FAIL summary; powers both the quarterly cron and the PR-level `pnpm audit:commitments` gate.

For each DESIGN-DISCIPLINE row that admits a heuristic check, a predicate the audit script runs and the auditor reviews. The predicates are explicitly heuristic — false positives are expected and recorded as audit-notes overrides. The point is to give the auditor a starting place, not to ship a CI gate.

The six engine-side predicates (commitments 1, 2, 5, 7, 11, 12) ship in this TASK; the four adapter-side rows (SPEC.async §17.1 commitments 1, 2, 5, 7) reuse the corresponding predicates with adapter-side path filters and a different doc anchor (SPEC.async vs SPEC.md). Per-row description:

- **Commitment 1** (semantic foundation §3 lands first). The predicate inspects the last 100 PRs touching `SPEC.md` via `git log --follow --pretty=format:%H -- SPEC.md`, parses the diff for each PR, and counts the order in which sections were touched. The verdict is green if every PR that touched §4–§18 also touched §3 *or* if §3 has not been touched since the last audit. The verdict is yellow (review needed) if a PR touched §4–§18 without touching §3 since the prior §3 revision. The adapter-side analogue runs the same logic over `SPEC.async.md` against §3 of the adapter spec.

- **Commitment 2** (public surface §12.2 quarterly audit). The predicate inspects `git log --since='3 months ago' -- packages/core/src/**` and lists the public-surface additions (new exports, new type members) by parsing `package.json` exports and `*.d.ts` files at the head of the audit window vs the head of the previous window. The verdict is yellow if any public surface added without a corresponding §12.2 PR comment; the auditor confirms or overrides. The adapter-side runs over `packages/sync/src/**` against SPEC.async §12.1.

- **Commitment 5** (race-class catalogue currency). The predicate diffs `SPEC.md` §9.1 row count against the test fixture count under `tools/checker/tests/fixtures/` and `tools/checker/tests/race-detection-acceptance.rs`. The verdict is green if the catalogue and fixtures agree on row count and per-row anchor; yellow if a fixture exists with no §9.1 row or a §9.1 row exists with no fixture. The adapter-side analogue runs over the adapter's race-class subset (rows 2, 6, 17) and the adapter test fixtures under `packages/sync/test/`.

- **Commitment 7** (no off-chart enum tags). The predicate greps for `kind:` and `state:` literal type tags across `packages/*/src/**/*.ts` (`rg "kind:\s*'[a-z-]+'"` and `rg "state:\s*'[a-z-]+'"`), extracts the set of tags in use, and cross-references them against the §6 statechart anchors named in `docs/lifecycle.md`. The verdict is green if every tag in source has a transition story in `docs/lifecycle.md`; yellow if a tag is in source without a corresponding lifecycle entry. The adapter-side analogue runs over `packages/sync/src/**/*.ts` against `docs/lifecycle.md` §1 (ResourceFleet) and §2 (ConflictRegistry).

- **Commitment 11** (bounded-enumerator fixtures). The predicate inspects `tools/checker/tests/enumerator/soundness/` and asserts the fixture set is non-empty, that each fixture references the §16.4 row it corresponds to, and that no fixture has been deleted since the last audit (deletions are expected when a row graduates; the audit-notes record the graduation). The verdict is green if the shelf is intact; yellow on any deletion without a corresponding §16.4 graduation note.

- **Commitment 12** (PR template race-class anchor). The predicate inspects the last 50 PRs via `gh pr list --limit 50 --state merged --json body,number,title` and checks each body for the race-class anchor pattern from `.github/PULL_REQUEST_TEMPLATE.md` (#399 / #430). The verdict is green if every PR that touched `packages/core/src/` or `packages/sync/src/` filled the anchor; yellow if any such PR shipped with the anchor blank or removed.

#### 5 concerns (consolidated across predicates)

1. **Heuristic, not strict** — false-positive rate target <10%. The predicates are explicitly heuristic; commitment 1's predicate will flag a §5-only typo-fix PR as a false positive, and commitment 12's predicate will miss a PR that filled the anchor with placeholder text. The 10% target is enforced post-hoc — after the first four quarterly audits, if the auditor's override rate on any predicate exceeds 10%, the predicate gets reworked or retired in the next EPIC iteration. The override rate is recorded in the audit-notes line so the data is on file.
2. **Audit notes capture exceptions** — the auditor records the exception in the audit-notes line when overriding a predicate. The override format is "predicate flagged X; reviewed and accepted because Y." The format is not enforced syntactically; the CODEOWNERS reviewer enforces it via the closing-checklist criterion in TASK 13.4 concern 4.
3. **Manual override** — the auditor can mark a row green even if the predicate would flag it, and conversely can mark a row yellow even if the predicate is green. The predicate output is advisory; the auditor's verdict is the audit's verdict. This is the §17.4 design choice carried through: mechanization is help, not gospel.
4. **Output format** — markdown table with the predicate's verdict per row, included as a fenced code block in the cron-opened issue body. The table columns: row, predicate verdict (green/yellow), evidence (a path or a PR number), auditor verdict (filled in by the human), audit notes (filled in by the human). The orchestrator at `tools/audit/run.ts` produces the table; the TASK 13.2 workflow embeds the table in the issue body.
5. **No race condition** — predicates are read-only over git and the filesystem. They do not write to the working tree, do not create branches, do not push, and do not call any GitHub mutation API. The orchestrator's only output is stdout (the markdown table) which the TASK 13.2 workflow captures and posts. A predicate that needs to call `gh` for PR data uses `gh api` reads only.

#### Predicate shape

Each predicate exports a single `check()` function that returns a `PredicateResult`:

```typescript
// tools/audit/types.ts
export type Verdict = 'green' | 'yellow' | 'red';

export interface PredicateResult {
  readonly commitment: string;       // e.g., "SPEC.md §17.1 commitment 5"
  readonly verdict: Verdict;
  readonly evidence: ReadonlyArray<string>;  // paths, PR numbers, commit SHAs
  readonly summary: string;          // 1-2 sentences
}

export type Predicate = () => Promise<PredicateResult>;
```

The orchestrator at `tools/audit/run.ts` imports each predicate, runs them in parallel (no shared state, all read-only), and renders a markdown table:

```markdown
| Commitment | Verdict | Evidence | Summary |
| --- | --- | --- | --- |
| SPEC.md §17.1.1 | green | last 100 PRs touching SPEC.md, 0 §3-late | §3 was touched first or not touched on every SPEC-modifying PR this quarter. |
| SPEC.md §17.1.2 | yellow | packages/core/src/index.ts +3 exports | Three new exports landed since last audit; auditor to confirm §12.2 review. |
| SPEC.md §17.1.5 | green | tools/checker/tests/fixtures/, 28 vs 28 | Catalogue rows and fixtures agree on count and per-row anchor. |
| SPEC.md §17.1.7 | green | docs/lifecycle.md, all tags mapped | Every kind:/state: literal in source has a transition story in lifecycle.md. |
| SPEC.md §17.1.11 | green | tools/checker/tests/enumerator/soundness/, intact | Shelf fixtures unchanged; no graduation pending. |
| SPEC.md §17.1.12 | yellow | last 50 merged PRs, 1 missing anchor | One adapter-touching PR shipped with the race-class anchor blank. |
| SPEC.async §17.1.1 | green | last 100 PRs touching SPEC.async.md, 0 §3-late | Adapter §3 discipline held this quarter. |
| SPEC.async §17.1.2 | green | packages/sync/src/index.ts, 2 primitives | Surface remains at Resource + Conflict. |
| SPEC.async §17.1.5 | green | adapter rows 2/6/17 fixtures intact | Adapter race-class subset current. |
| SPEC.async §17.1.7 | green | docs/lifecycle.md §1-§2, all tags mapped | Every adapter-side tag has a transition story. |
```

The table is the cron-opened issue's primary content; the auditor walks the table, fills in the auditor-verdict and audit-notes for each row, and submits the closing PR.

### TASK 13.4 — `CODEOWNERS` extension

**Files:** `.github/CODEOWNERS` (existing; one line added).

The audit doc and the audit tooling are owned by the core team. The line added covers `docs/commitment-audit.md`, `.github/workflows/quarterly-audit.yml`, and `tools/audit/`. PRs touching any of these paths require core-team review. The TASK 13.2 issue auto-assignment uses this entry to resolve the assignees; the closing-the-issue criterion is the team's review of the closed-out audit doc PR.

The closing-the-issue criterion is "all rows reviewed and either green or with notes." A PR that closes the issue without notes on every row is rejected by the CODEOWNERS reviewer. The criterion is documented in the issue body (rendered from `docs/commitment-audit.md` by the workflow); the CODEOWNERS reviewer enforces it at review time.

#### 5 concerns

1. **The audit doc is owned by the core team.** The CODEOWNERS line is `docs/commitment-audit.md @causl-team/core` (or the equivalent team handle). The team handle is the existing one used for the `SPEC.md` and `SPEC.async.md` entries; no new team is created for this EPIC.
2. **Updates to it require CODEOWNERS approval.** GitHub branch protection on `main` already requires CODEOWNERS review for any path with an entry. The audit doc gains the same protection automatically by virtue of the CODEOWNERS entry; no branch-protection change is needed.
3. **The cron-opened issue is auto-assigned.** TASK 13.2 concern 3 reads CODEOWNERS at run time and assigns the entry's owners on the new issue. The fallback path (assign the last three committers if owner resolution fails) is the failsafe for CODEOWNERS drift.
4. **The closing-the-issue criterion is "all rows reviewed and either green or with notes."** Recorded in the issue body's closing checklist. The CODEOWNERS reviewer on the audit-doc PR confirms each row carries notes; a row with a green checkbox and an empty notes block is a rejection. The reviewer's enforcement is the spine of the design — a checkbox-only ritual is worse than no audit, per the brutal-critical review's audit-as-checkbox-ritual concern.
5. **No race condition.** A one-line addition to a markdown file under `.github/`; no concurrent-edit hazard. The CODEOWNERS file is rarely contested; the line lands in the same PR as the rest of the EPIC.

#### CODEOWNERS line

The exact line added to `.github/CODEOWNERS`:

```
# Quarterly DESIGN-DISCIPLINE commitment audit
docs/commitment-audit.md @causl-team/core
.github/workflows/quarterly-audit.yml @causl-team/core
tools/audit/ @causl-team/core
```

The team handle `@causl-team/core` is the existing handle used for `SPEC.md` and `SPEC.async.md` ownership; no new team is created. The three paths are scoped narrowly — no glob over `docs/**` or `tools/**` that would over-claim ownership of unrelated files.

### TASK 13.5 — First audit on land day

**Files:** `docs/commitment-audit.md` (extended in the same PR as TASK 13.1).

The first audit is performed in the same PR that introduces the template, by the EPIC author plus one CODEOWNERS reviewer. The land PR therefore ships:

1. The template structure (TASK 13.1).
2. The cron workflow (TASK 13.2).
3. The six engine-side and four adapter-side predicate scripts (TASK 13.3).
4. The CODEOWNERS line (TASK 13.4).
5. The first quarterly audit's findings populated into the template, with notes on every row.

The acceptance gate for the first audit is the same as for subsequent audits: every row carries 1-3 sentences of notes, the auditor's verdict is recorded, and any yellow row has a follow-up action on file. The only difference is that the first audit has no "previous quarter" to compare against; the first-audit notes establish the baseline.

#### TDD test suite

- The land PR ships with `docs/commitment-audit.md` populated for all ten rows.
- Each row has a non-empty audit-notes block.
- The "last audited at" field equals the land date; the "next audit due at" field equals the land date plus the per-row cadence.
- The CODEOWNERS reviewer on the land PR confirms (in PR review) that they walked the audit notes and did not rubber-stamp.

#### 5 concerns

1. **Bootstrap confidence.** The first audit is the most important one because it establishes what "green" means for each row. A first audit with sloppy notes anchors the project at a low bar; a first audit with careful notes anchors it at a high one. The EPIC author and the CODEOWNERS reviewer share responsibility for the calibration.
2. **Anchoring on the wrong baseline.** If the first audit declares commitment 5 green when the catalogue is actually one row behind a recent §9.1 addition, every subsequent audit inherits the wrong baseline and the discrepancy may go unnoticed for quarters. Mitigation: the first audit's predicate output is preserved verbatim in the audit doc, so a later auditor can re-run the predicate and compare.
3. **Time-zone of the cadence dates.** "Last audited at: 2026-05-02" needs a timezone or it is ambiguous. Convention: all dates are UTC, formatted as ISO-8601 dates without time, and the implicit time is "by end of UTC day." The convention is documented in the audit-doc preamble.
4. **Predicate output as reproducible evidence.** The first audit captures `tools/audit/run.ts`'s stdout in an appendix to the audit doc. Subsequent audits do the same. The appendix grows quarter over quarter and acts as a longitudinal record of how each predicate's verdict changed; a row that has been green for eight quarters and turns yellow in the ninth is conspicuous.
5. **No race condition.** All five EPIC tasks land in a single PR. The PR's CI runs the predicate scripts, captures their output for the appendix, and the reviewer confirms the captured output matches what the predicates produced when re-run locally.

## Cadence rationale per row

The 90-day default and per-row overrides are not arbitrary. The rationale per row:

- **Commitment 1 (engine, semantic foundation lands first):** 90-day default. SPEC.md revisions are infrequent; quarterly is the right cadence to confirm that any revision in the window followed the §3-first habit. A quarter with no SPEC.md revisions resolves in seconds.
- **Commitment 2 (engine, public surface §12.2 audit):** 90-day default, deliberately matched to §12.2's named "quarterly review" cadence. The audit confirms the §12.2 audit happened; it does not re-perform it.
- **Commitment 5 (engine, race-class catalogue currency):** 30-day override. Catalogue currency is the highest-velocity row; new race classes can land any sprint, and a 90-day window risks accumulating three months of catalogue drift before review. The PR template anchor at #399 / #430 is the live enforcement; the 30-day audit is the retrospective.
- **Commitment 7 (engine, no off-chart enum tags):** 90-day default. New enum tags are infrequent; quarterly is sufficient to cross-reference `docs/lifecycle.md` against the source.
- **Commitment 11 (engine, bounded-enumerator fixtures):** 180-day override. The shelf fixtures are stable until §16.4 reopens; once a quarter is overkill until graduation begins. On the quarter §16.4 reopens, the cadence reverts to 90 days for the duration of EPIC-3, then the row archives on graduation.
- **Commitment 12 (engine, PR template race-class anchor):** 90-day default. PR template usage tracks PR volume, which is steady; quarterly cadence is right-sized.
- **Commitment 1 (adapter):** 90-day default. SPEC.async revisions are infrequent.
- **Commitment 2 (adapter, two-primitive surface):** 90-day default, matched to SPEC.async §12.1's quarterly review.
- **Commitment 5 (adapter, race-class catalogue currency for rows 2/6/17):** 30-day override, mirroring the engine commitment 5 reasoning. Adapter race-class additions are rarer than engine ones, but when they happen they need fresh review.
- **Commitment 7 (adapter, no off-chart enum tags):** 90-day default.

The cadence override field on each row is plain text; an auditor can change a row's cadence between audits with a one-PR change to `docs/commitment-audit.md`. Cadence changes are themselves CODEOWNERS-reviewed under TASK 13.4; a tightening (90 → 30) is auto-accepted, a loosening (30 → 180) requires the auditor to record the rationale in the row's notes.

## Longitudinal evolution

The EPIC ships v1 of the audit. Three classes of evolution are anticipated, none of which require a new EPIC:

- **Row addition.** A new §17 commitment in either spec triggers a corresponding row addition in `docs/commitment-audit.md`, gated by the TDD test in TASK 13.1 and the CODEOWNERS review. The new row enters at 90-day cadence by default; the auditor can override.
- **Row graduation.** Commitment 11's graduation is the named example; if EPIC-3 lands and §16.4 reopens with the bounded enumerator binary in `checker-gate`, the row's MECHANICAL anchor is satisfied and the row archives. Archival means the row moves to a "graduated commitments" section at the bottom of the audit doc with the graduation date and EPIC reference, rather than being deleted; the historical record is preserved.
- **Predicate revision.** A predicate whose false-positive rate exceeds 10% over four quarters gets reworked or retired. Rework lands as a follow-up EPIC under the same `tools/audit/` directory; retirement removes the predicate file and the orchestrator entry, with the row reverting to manual-only audit. Retirement is the explicit acknowledgement that some rows are not mechanizable even at the heuristic level, which is consistent with §17.4's design choice.

A class of evolution that the EPIC does *not* anticipate: the audit becoming a *gate* rather than a *check*. The §17.4 design choice is that DESIGN-DISCIPLINE rows are not gated; the audit confirms they are held, but does not block PRs. If a future team decides to graduate the audit itself to a CI gate (e.g., "fail the PR if the audit issue is open and overdue"), that is a decision that requires a SPEC §17 revision, not a quiet workflow change. The EPIC's CODEOWNERS coverage on `.github/workflows/quarterly-audit.yml` is the structural defence — a workflow change that turns the audit into a gate cannot land without team review.

## Acceptance gate

The first quarterly audit closes within 30 days of the cron firing, with notes on every DESIGN-DISCIPLINE row in `docs/commitment-audit.md`. The audit-doc PR is reviewed by CODEOWNERS, every row has a 1-3 sentence audit-notes block, and the predicate output (TASK 13.3) is included in the closed issue's final comment as the audit's evidence-on-file.

The acceptance gate is *not* "the audit found everything green" — a quarterly audit that finds a yellow row and records the follow-up action in the audit-notes is exactly what the EPIC is for. The gate is "the team walked the table, recorded what they saw, and the artifact is visible to anyone who looks."

A second-order acceptance gate fires after four quarters: if the predicate false-positive rate (TASK 13.3 concern 1) exceeds 10% on any predicate, that predicate gets reworked or retired in a follow-up EPIC. The four-quarter horizon is the minimum data window to characterize the heuristic's behaviour; the rework-or-retire framing avoids the trap of letting a bad heuristic accumulate technical debt under the audit's name.

A third-order acceptance gate fires on row graduation: if commitment 11 graduates to MECHANICAL on §16.4 reopen, the audit doc's graduation section records the date and EPIC reference, and the predicate `tools/audit/check-commitment-11.ts` is retired in the same PR. The audit's coverage drops from ten DESIGN-DISCIPLINE rows to nine, and the §17.1 table in SPEC.md flips commitment 11's marker. The audit confirms its own scope evolution.

## Anticipated objections

We expect the following objections during EPIC review and want them on the record:

- *"Why not just trust the team?"* The team is trusted; that is precisely why §17.4 left these rows DESIGN-DISCIPLINE rather than striking them. But trust is durable only with confirmation. Beck's commitments-as-contract framing is explicit on this point: a contract is what survives team turnover, schedule pressure, and the slow accumulation of "we'll get to it." The audit is the confirmation; without it, the trust is unverified, and unverified trust is the failure mode §17.4 already named.

- *"Quarterly audits will become a paperwork ritual."* This is the central risk and is addressed by three structural choices: per-row cadence overrides so effort scales with risk; the CODEOWNERS reviewer's responsibility to reject rubber-stamp notes; and the four-quarter retrospective on predicate false-positive rates. None of these guarantees ritual avoidance, but together they mean ritualization is *visible* — a quarter of one-line green checkmarks across all ten rows is a signal the EPIC's structure is failing, and the failure is on the record for follow-up.

- *"Ten rows is too many for a quarterly audit."* Six engine plus four adapter is the count the §17 tables produce; reducing it would mean dropping rows from the audit while leaving them in the spec, which is exactly the gap the EPIC is closing. The per-row cadence and the predicate-driven first-pass mitigate the volume; an auditor walking ten rows where seven resolve in seconds (predicate green plus "no changes since last audit") and three get serious review is a reasonable quarterly investment.

- *"Why GitHub Issues rather than a doc-only workflow?"* The cron-opened issue is the *trigger*; the audit-doc PR is the *artifact*. Both exist for separate reasons: the issue is the timer that fires every 90 days and assigns work; the doc is the persistent record. A doc-only workflow with no issue would rely on someone remembering to walk the table; we have surveys of teams that did exactly this for similar review workflows and the workflow rotted within a year. The issue's auto-assignment and 30-day milestone are the structural defence against that rot.

- *"Why not let the predicates be CI gates?"* Three reasons. First, §17.4's design choice on these rows is explicit: mechanization-without-false-positives was already considered and rejected for these specific rows. Second, the predicates are heuristics with a stated >0% false-positive rate; turning them into gates would train the team to disable them. Third, the audit's value is the auditor walking the table, not the predicate firing — a gate that flags commitment 1 violations on every typo-fix PR teaches the team to ignore the gate, which is worse than no gate at all.

- *"Why six concerns per task instead of five?"* They are five per task; the row format and predicate-shape subsections under TASK 13.1 and TASK 13.3 are illustrative content, not numbered concerns. The numbered-five-concerns convention is preserved per the project's EPIC template.

## Voices on file

The three thinkers cited in the EPIC body are cited because their framings are load-bearing on the §17 design choice this EPIC operationalizes.

Beck's commitments-as-contract framing comes from the XP literature on team practices: the practices are the team's contract with the work, and the practices either get walked or they get forgotten. The commitment table in §17 is the project's signed contract; the audit is the structural reminder that the contract is still in force. Without the reminder, the contract reduces to a list of past intentions.

Martin's TDD-as-professionalism framing carries the same line into the engineering specifically: the discipline of writing the test first is the discipline of taking the work seriously. Translated into the §17 context: the discipline of marking a row DESIGN-DISCIPLINE rather than mechanizing it is the discipline of accepting that some commitments require a person paying attention. The audit is the structure that pays attention on schedule.

Fowler's interpretation-for-working-teams framing is the line that kept the DESIGN-DISCIPLINE rows in the §17 table during the rewrite. The argument: a spec that pretends every commitment can be mechanized produces false positives that train the team to ignore the spec; a spec that strikes everything that cannot be mechanized produces a contract too narrow to describe what the team actually holds itself to. The middle path — mark explicitly, audit on cadence — is the path this EPIC implements.

The three framings converge on the same operational claim: the audit is the structural acknowledgement that some things only stay true because someone is checking. The EPIC ships the someone, the schedule, and the place to write down what they checked.

## Out of scope

- **MECHANICAL commitments.** The six MECHANICAL rows in SPEC.md §17.1 (3, 4, 6, 8, 9, 10) and the five MECHANICAL rows in SPEC.async §17.1 (3, 4, 6, 8, 9) are already CI-gated; this EPIC does not duplicate or audit them. The MECHANICAL rows hold themselves on every PR; the audit is for the rows that don't.
- **The bounded enumerator.** Commitment 11's graduation from DESIGN-DISCIPLINE to MECHANICAL is gated on §16.4 reopening and EPIC-3 (bounded enumerator) shipping. When that lands, commitment 11's row in `docs/commitment-audit.md` gets archived rather than deleted, and the audit-notes line on the graduating quarter records the EPIC reference and the graduation date. The graduation itself is EPIC-3's concern, not this one.
- **A new CI gate.** This EPIC ships a cron-opened issue and a review-policy artifact; it does not ship any check that fails a PR. The §17.4 design choice that left these rows DESIGN-DISCIPLINE is preserved deliberately — mechanization-without-false-positives is what the §17 rewrite already considered and rejected for these rows.
- **Spec authoring.** The audit reviews whether the team's signed commitments are still being held; it does not draft new commitments, retire existing ones, or alter the §17 tables. Any change to the commitment table is a SPEC-touching PR with its own review; the audit's job is to confirm the table is still true, not to rewrite it.
- **Tooling for the §12.2 / §12.1 public-surface audits themselves.** Commitments 2 (engine) and 2 (adapter) reference quarterly public-surface audits whose mechanism lives in the §12.2 and §12.1 sections of their respective specs. This EPIC's audit confirms those audits *happened*; it does not implement them. Implementing the public-surface audit tooling is a separate concern.
- **Migration of any other DESIGN-DISCIPLINE row to MECHANICAL.** Commitment 11's graduation is named in the spec; no other row has a graduation criterion on file. If a future EPIC proposes graduating, say, commitment 5 to MECHANICAL by shipping a `causl-check` pass that asserts §9.1 catalogue currency, that is a separate EPIC and a separate spec revision. This EPIC does not anticipate or scaffold for those graduations.
