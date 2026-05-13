# Epic #1133 — Session handoff bookmark

> **Read after `PLAN.md`. This file is the next-ticket-to-claim pointer + a per-session changelog. Updated at end of every session.**

---

## Current state

**Last session**: 2026-05-13 (Phase 0 — preconditions land)

**dev branch HEAD**: _(updated by the final commit of the session)_

**main HEAD at session open**: `117941ac1b7ff088247f2dae4fad84984cc0b864`

**Phase**: 0 (Preconditions)

---

## Next ticket to claim (next session)

**Read PLAN.md §8 "Resumption bookmark" first.** Then:

1. **If Phase 0 is incomplete** (check Kill-criteria section below):
   - `[ ]` `failing_against_stub` corpus PR not yet on dev → resume corpus PR (see Phase 0 bookmarks below).
   - `[ ]` A.1 perf-floor probe PR not yet on dev → resume probe PR.
   - `[ ]` Epic #1133 body not yet amended → post the consolidated comment + `gh issue edit 1133 --body-file ...`.
   - `[ ]` #1147 body not yet amended → post the A.0–A.12 decomposition.

2. **If Phase 0 IS complete** → claim **Phase 1 blockers** in order: `#1150` (bundle), `#1151` (trial counts), then SPEC §3/§5.1 amendment PRs.

3. **If Phase 1 IS complete** → claim **A.0** (walking-skeleton FFI roundtrip).

---

## Kill-criteria status

- [ ] `#1150` bundle ceiling closed
- [ ] `#1151` hardcoded trial counts codemod + lint rule
- [ ] `#1160` Criteria 6 + 7 re-opened (IC stability + per-call decomposition)
- [ ] failing_against_stub corpus PR on dev
- [ ] A.1 perf-floor probe PR on dev
- [ ] Epic body amended with comment-link to `docs/epic-1133/PLAN.md`
- [ ] `#1147` body amended with A.0–A.12 micro-ticket table
- [ ] SPEC §3 Theorem 2 uninterruptibility amendment drafted
- [ ] SPEC §5.1 IndexMap container pin amendment drafted

---

## Session changelog

### Session 2026-05-13 — Phase 0 kickoff

**Goal**: land Phase 0 preconditions. NO Rust engine code; only planning artifacts + the two probe PRs.

**Landed on `dev`**:
- _(filled in as PRs merge)_

**Open work at session end**:
- _(filled in by closing handoff)_

**Quota status at session end**:
- _(filled in if usage cap hits before session goal complete)_

**Surprises / honest findings**:
- Comment synthesis surfaced **49 distinct diff entries across 11 issues** — 16 sub-issues have ZERO team-review comments and stay as-is unless they receive a folded upstream change.
- The epic body cites `#1153` for hardcoded-trial-counts but the actual issue is `#1151` — corrected throughout PLAN.md.
- `#1160` is `CLOSED` per the source-file metadata but Phase A hasn't started; the V8 cluster's Criterion 6 + 7 require re-opening it (new sub-issue likely).
- Phase A decomposition agent found that "schema-hash check" is NOT in `commitInternal` — it's on the `hydrate()` path. The user-brief originally listed it as a Phase A scope item; corrected in PLAN.md (Phase A is precondition + writes + rollback + clock + Phase A.5 only).
- `WasmBackend.constructor` at `wasm/index.ts:491` constructs a TS engine via `createCausl({name})`. The cross-backend determinism test (`packages/core/test/properties/cross-backend-determinism.property.test.ts`, 1902 lines) is provably unfailable today — both branches resolve to the same engine. This is the design pressure that motivates the failing_against_stub corpus.

---

## Cross-session protocol

**Before starting**: read `PLAN.md` (canonical), then this `HANDOFF.md` (bookmark). Find next ticket. Confirm dev branch is up to date with origin.

**During**: one red→green→refactor cycle per micro-ticket. Each ticket = its own PR to `dev`. Merge immediately after local validate passes (CI bypassed for this cascade per the broader epic; SPEC says explicitly: "merge to dev; dev→main happens after regression-gate tests confirm").

**Out of usage** (quota cap hit mid-ticket):
1. Commit current WIP to the ticket's branch (don't merge incomplete work).
2. Write this `HANDOFF.md`'s "Open work at session end" section:
   - Branch name + last commit SHA.
   - File you were editing + line you stopped at.
   - Test you were trying to turn green + which assertion failed.
   - Next concrete action to take on resume.
3. Push the branch (don't merge).
4. Resume on next session = `git checkout <branch> && cd <file> && read line + test`.

**End of completed session**: update this file's "Last session", "dev HEAD", "Landed on dev", "Next ticket". Commit + push the updated handoff.

---

## Quick links

- Plan: [`PLAN.md`](./PLAN.md)
- Epic: [`#1133`](https://github.com/iasbuilt/causl/issues/1133)
- Phase A parent: [`#1147`](https://github.com/iasbuilt/causl/issues/1147)
- dev branch: [`dev`](https://github.com/iasbuilt/causl/tree/dev)
- Persona team review comments: `gh issue view 1133 --comments`
