# Epic #1133 — Session handoff bookmark

> **Read after `PLAN.md`. This file is the next-ticket-to-claim pointer + a per-session changelog. Updated at end of every session.**

---

## Current state

**Last session**: 2026-05-13 (Phase 0 complete — **A.1 perf-floor probe STOP-VERDICT fired**)

**dev branch HEAD**: `b2332d68` (after PR #1329 merged) + this handoff-update PR.

**main HEAD at session open**: `117941ac1b7ff088247f2dae4fad84984cc0b864`

**Phase**: 0 (Preconditions) — **COMPLETE**.

**EPIC STATUS**: 🛑 **STOP-VERDICT fired on A.1 perf-floor probe**. Phase A.0–A.12 is **frozen pending boundary-architecture pivot decision**.

Measurement: serde-wasm-bindgen + `floor_only_transition` (zero engine work) takes ~17.5 ms / 10k workload — **35× over the 0.5 ms kill threshold**. The boundary tax ALONE is 25× the 0.7 ms projected savings ceiling. Real Phase A.2 work pays strictly more. STOP-verdict canonical record: [#1133 comment 4442925169](https://github.com/iasbuilt/causl/issues/1133#issuecomment-4442925169).

---

## Next session — decision point + Phase 1 work that has standalone value

**The kill gate fired exactly as the V8/spec cluster + TDD cluster designed it to**. Phase A engine work is frozen until a GO/NO-GO/PIVOT decision lands on `#1133`. Three paths:

1. **DROP** — document the measurement in the #1015 ledger as canonical; TS engine continues to satisfy production workload distribution per the existing GO/NO-GO criteria. The kill gate is the protocol working.

2. **PIVOT** — try a different boundary architecture:
   - 2(a) Opaque-handle ABI (`#1160` Harness B) — defer Commit materialisation to property-access time.
   - 2(b) Batched commits at the wasm boundary — N commits per crossing.
   - 2(c) Direct `wasm-bindgen` raw types (no serde JSON) — structured ABI.
   - 2(d) GC bridge (`engine-rs-bridge-gc`) tiebreaker — AMBER protocol formality; the perf-floor agent estimates this needs ≥10× improvement over serde to clear the kill gate.

3. **DEFER** — re-evaluate at the next 6-month review per the existing #1133 GO/NO-GO cadence.

**Recommendation in the STOP comment**: path 1 (DROP) + 1-week investigation into path 2(d) GC-bridge tiebreaker for due diligence.

### Standalone-value work — claimable next session regardless of GO/NO-GO/PIVOT verdict

These items have positive value even if the engine port drops:

1. **`#1150` — SPEC §17.6 bundle ceiling violation (213 KB > 200 KB)** — SPEC violation on record; close it via Option A (`wasm-opt` direct invocation) regardless of engine-port verdict.
2. **`#1151` — Hardcoded trial counts** — test-discipline win; tier-system codemod + lint rule.
3. **SPEC §3 Theorem 2 uninterruptibility amendment** — captures the contract for ANY future native backend (Rust or otherwise). Future-proofing documentation.
4. **SPEC §5.1 IndexMap container pin amendment** — same: documents the invariant any future backend must honour.

**Recommended next-session claim order**: #1150 → #1151 → SPEC amendments → only THEN revisit the GO/NO-GO/PIVOT decision once Phase 1 prep is complete.

---

## Kill-criteria status

- [ ] `#1150` bundle ceiling closed — **next-session claim**, standalone value even if engine port drops
- [ ] `#1151` hardcoded trial counts codemod + lint rule — **next-session claim**, standalone value
- [ ] `#1160` Criteria 6 + 7 re-opened — gated on PIVOT decision (only useful if path 2(a) opaque-handle pursued)
- [x] **failing_against_stub corpus PR on dev** (PR #1327, commit `ae99a093`; 20/20 stub failures verified red)
- [x] **A.1 perf-floor probe PR on dev** (PR #1329, commit `b2332d68`; **STOP-VERDICT fired at 35× over threshold**)
- [x] Epic body amended with comment-link to `docs/epic-1133/PLAN.md` (comment 4438329762)
- [x] `#1147` body amended with A.0–A.12 micro-ticket table (comment 4438334059)
- [x] STOP-VERDICT comment posted on epic (comment 4442925169)
- [x] BLOCKED comment posted on `#1147` Phase A parent (comment 4442925471)
- [ ] SPEC §3 Theorem 2 uninterruptibility amendment drafted — **next-session claim**, standalone value
- [ ] SPEC §5.1 IndexMap container pin amendment drafted — **next-session claim**, standalone value

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


### Session 2026-05-13 — Phase 0 COMPLETE + STOP-VERDICT fired (continuation)

**Goal**: ship the two deferred Phase 0 code PRs (failing_against_stub corpus + A.1 perf-floor probe). **Both shipped. Probe fired the STOP gate.**

**Landed on `dev`**:
- PR **#1327** (corpus, commit `ae99a093`) — 20-category corpus, `CAUSL_BACKEND=stub` shows 20/20 failures (red as required), `CAUSL_BACKEND=ts` shows 20/20 passes, 8/8 Rust mirror tests pass. Files: `packages/core/test/properties/failing-against-stub-{fixtures,property.test}.ts`, `tools/engine-rs-core/tests/stub_corpus_categories.rs`, `scripts/corpus-report.mjs`.
- PR **#1329** (probe, commit `b2332d68`) — `op-rust-bridge-floor-1k` scenario + `floor-only` cargo feature on `engine-rs-bridge-serde` + `floorBridgeCommit` loader + hypothesis row with `hot-fn-must-not-be: "transition_phased"` invalidator. 599 insertions across 14 files. Local wasm32 build + 4 runs at `--profile=default` × 15 samples.

**STOP-VERDICT measurement** (PR #1329):
- Cell: `op-rust-bridge-floor-1k × 10000`
- Median-of-medians: **~1.75 µs/op × 10k = ~17.5 ms / 10k workload**
- Kill threshold: **0.5 ms / 10k workload**
- **Ratio: ~35× over** — far past AMBER band (0.3-0.5 ms), unambiguous STOP.
- Comment 4442925169 on `#1133` is the canonical STOP record.

**What the V8/spec cluster's prediction was**: 4 µs/op × 10k = 40 ms vs 0.7 ms projected savings. Measured: 1.75 µs/op × 10k = 17.5 ms — lower than the panel's pessimistic estimate but **still 25× the savings ceiling, with ZERO real engine work done**. Real Phase A.2 would pay strictly more.

**Issues closed this continuation**:
- #1326 (corpus) — closed manually after PR #1327 merged (auto-close indexing-lag, caught per user instruction).
- #1328 (probe) — closed manually after PR #1329 merged.

**Decisions remaining for next session** (per the STOP-VERDICT comment on #1133):
1. DROP (recommended) — document in #1015 ledger.
2. PIVOT — opaque-handle ABI / batched commits / raw wasm-bindgen / GC-bridge tiebreaker.
3. DEFER — re-evaluate at next 6-month GO/NO-GO review.

**Standalone-value Phase 1 work** (claimable regardless of GO/NO-GO/PIVOT verdict):
- `#1150` close (bundle ceiling violation — SPEC §17.6 on record)
- `#1151` close (hardcoded trial counts → `resolveCrossBackendFuzzTier()`)
- SPEC §3 Theorem 2 uninterruptibility amendment draft
- SPEC §5.1 IndexMap container pin amendment draft

**Quota status**: still within budget at session continuation point. Will continue Phase 1 standalone-value work next; pause only on user instruction or quota wall.

**Honest framing**: the kill gate worked. The protocol surfaced a structurally negative outcome BEFORE 4-8 weeks of Phase A engine work were burnt. That IS the success of the discipline the entire plan was designed to enforce.

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
