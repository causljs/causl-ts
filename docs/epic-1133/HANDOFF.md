# Epic #1133 — Session handoff bookmark

> **Read after `PLAN.md`. This file is the next-ticket-to-claim pointer + a per-session changelog. Updated at end of every session.**

---

## Current state

**Last session**: 2026-05-13 (Phase 0 — preconditions land)

**dev branch HEAD**: `149d0817` (after PR #1324 merged) + this handoff-update PR.

**main HEAD at session open**: `117941ac1b7ff088247f2dae4fad84984cc0b864`

**Phase**: 0 (Preconditions) — **partially complete**. Planning + announcement artifacts shipped; 2 code PRs deferred to next session.

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
- [ ] failing_against_stub corpus PR on dev (deferred this session — design complete in `PLAN.md` §6)
- [ ] A.1 perf-floor probe PR on dev (deferred this session — design complete in `PLAN.md` §7)
- [x] Epic body amended with comment-link to `docs/epic-1133/PLAN.md` (comment 4438329762)
- [x] `#1147` body amended with A.0–A.12 micro-ticket table (comment 4438334059)
- [ ] SPEC §3 Theorem 2 uninterruptibility amendment drafted
- [ ] SPEC §5.1 IndexMap container pin amendment drafted

---

## Session changelog

### Session 2026-05-13 — Phase 0 kickoff

**Goal**: land Phase 0 preconditions. NO Rust engine code; only planning artifacts + the two probe PRs.

**Landed on `dev`**:
- `dev` branch created off `main@117941ac` (preserves main stability while the Rust port stabilises).
- PR **#1324** — `docs/epic-1133/PLAN.md` (canonical plan, folds all 17 team-review comments) + `docs/epic-1133/HANDOFF.md` (this file) merged to dev at commit **`149d0817`**.
- Status comment posted on **#1133** ([comment 4438329762](https://github.com/iasbuilt/causl/issues/1133#issuecomment-4438329762)) — supersedes-pointer with plan link + Phase 0 status + corrections list.
- Decomposition comment posted on **#1147** ([comment 4438334059](https://github.com/iasbuilt/causl/issues/1147#issuecomment-4438334059)) — full A.0–A.12 micro-ticket table with file:line anchors.

**Open work at session end (NEXT-SESSION QUEUE)**:

Phase 0 has 2 code PRs deferred (designs are complete and live in `PLAN.md`; implementation is mechanical):

1. **PR: `failing_against_stub` corpus extraction → `dev`** (~250 LoC TS + Rust integration test).
   - Files to create: `packages/core/test/properties/failing-against-stub.property.test.ts`, `packages/core/test/properties/failing-against-stub-fixtures.ts`, `tools/engine-rs-core/tests/stub_corpus_categories.rs`.
   - Acceptance: with `CAUSL_BACKEND=stub` (default), all 20 categories MUST FAIL today; CI parses `[stub] <id> FAIL` and asserts count == 20.
   - Spec source: `PLAN.md` §6 + parallel research agent output preserved in this session's task list (#23).

2. **PR: A.1 perf-floor probe scaffolding → `dev`** (~20 LoC Rust + scenario row + per-lib case + hypothesis row).
   - Files to modify: `tools/engine-rs-bridge-serde/Cargo.toml` (add `floor-only` feature), `tools/engine-rs-bridge-serde/src/lib.rs` (gated `floor_only_transition`), `tools/wasm-build/build.mjs` (second invocation), `packages/bench/src/wasm-stub-loader.ts` (sibling `floorBridgeCommit`), `packages/bench/src/scenario.ts` (new `op-rust-bridge-floor-1k` row), `packages/bench/src/libraries/causl.ts` (case branch), `packages/bench/src/hypotheses/causl-hypotheses.ts` (new row).
   - Acceptance: PR reports measured median ns/op × 10k and lands in GO (≤0.3 ms) / AMBER (0.3-0.5 ms, rerun against gc bridge) / STOP (≥0.5 ms, file STOP-verdict on #1133).
   - Spec source: `PLAN.md` §7 + parallel research agent output (#25).

After both ship, Phase 0 is complete and Phase 1 (preconditions: #1150, #1151, SPEC §3/§5.1 amendments, #1160 re-open with Criteria 6+7) becomes claimable.

**Quota status at session end**:
- Session productive throughout; no quota wall hit. Background-agent quota refreshed today (was hit earlier in prior session at 11:10pm America/Vancouver per task notifications).
- The two deferred PRs were sized as ~1-2 hours each. Sequencing for next session: claim the corpus PR first (it's the design-pressure surface — every Phase A micro-ticket gates on a corpus slice turning green).

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
