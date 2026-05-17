# Implementation Plan — SPEC gap closure

**Status (as of 2026-05-10, post-0.9.0):** All 13 EPICs below are CLOSED / SHIPPED. This document is retained as the historical umbrella plan that drove Phase-7 race-detection / async-spec closure; ongoing work is now tracked under the post-0.9.0 epic #1133 (Rust engine port, deferred — GO/NO-GO criteria documented in the epic body), the WASM substrate epic #680 (closed; 17 sub-issues merged), the perf umbrella #679 (closed; 22/22 sub-issues complete), and individual SPEC §17 commitment work (commitments 13 and 14 shipped via PRs #1024 and #1053 respectively).

## Source of truth
- `SPEC.md` — engine spec, §0–§18 + §16A.
- `SPEC.async.md` — adapter spec, §0–§18.
- Both shipped via PR #459 (engine + race detection) and PR #460 (async adapter), merged in the Phase-7 cycle that produced the EPICs below.

## What's already shipped (per surveys)
- `@causljs/core` — §3 theorems property-tested; §4 IR schema 2; §5 eight phases A–H + F.4/F.5/F.6 dotted suffixes; §6 three regions implemented (Engine + ResourceFleet + ConflictRegistry); §7 layering enforced via ESLint inversion gate + `narrowCapability`; §8 canonical pair + four extension hooks; §9 five DU examples + 17-row §9.1 catalogue; §10 worked-example required-green; §11 inspection primitives; §12 19 public surface items (7 canonical + 12 second-tier); §14 perf gates + bundle budget; §15 property suite + 1000-trial floor + conformance walker; §16 eight-pass static linter; §17 twelve commitments anchored.
- `@causljs/sync` — `resource()` + `createConflictRegistry()` + `singleConflictWhen` shipped per existing implementation.
- `@causljs/checker` — Rust binary with eight one-shot passes (`Schema`, `Bounds`, `UnknownDep`, `Cycle`, `Determinism`, `Monotonic`, `GlitchPropagation`, `OrphanDep`); per-platform npm wrappers; release-checker version-lockstep workflow.

## EPIC status roll-up (all shipped)

All 13 EPICs scoped from this plan are CLOSED. The closing GH issue is named on each row; the original "what's missing" framing is preserved below for historical context.

| EPIC | GH issue | Status | Notes |
| --- | --- | --- | --- |
| EPIC-1 — Schema 3 IR foundation | #463 (PR-B1); PR-A landed as #462 (commit `99f8369`) | CLOSED 2026-05-03 | Shipped in two slices: PR-A (`graphId`, optional `IRCallGraph`, schema bump, lockstep) merged in #462; PR-B1 (six-variant `IREvent` union + `IRScope` + `IRBridge` + `originEvent`) closed #463. Schema constant stays at `3`. |
| EPIC-2 — Four §16A.2 lint passes | #464 | CLOSED 2026-05-03 | All four passes (`SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`) shipped with positive/negative fixtures, SARIF rule metadata, and the `--passes` CLI flag. |
| EPIC-3 — Bounded enumerator | #467 | CLOSED 2026-05-03 | `tools/enumerator/` crate shipped; oracle predicates + worker pool + shrinker landed. |
| EPIC-4 — Hypothesis API | #469 | CLOSED 2026-05-03 | `packages/hypothesis/` shipped with the temporal-logic combinator surface. |
| EPIC-5 — SARIF + `--passes` CLI | #465 | CLOSED 2026-05-03 | Folded into the same release window as EPIC-2; rule metadata module and CLI flag shipped together. |
| EPIC-6 — Race-detection CI | #468 | CLOSED 2026-05-03 | Three-tier hierarchy (`.github/workflows/race-detection.yml`) shipped; Tier-1/2/3 all wired. |
| EPIC-7 — Apalache differential corpus | #472 | CLOSED 2026-05-03 | 10-model corpus + `apalache-diff` CI job shipped. |
| EPIC-8 — SPEC.async §10.5 fixtures | #474 | CLOSED 2026-05-03 | Four `vitest` files lifted from the spec into runnable form. |
| EPIC-9 — SPEC.async §15 property suite | #475 | CLOSED 2026-05-03 | 8 properties at 1000-trial floor; `@causljs/sync-testing-internal` shipped. |
| EPIC-10 — SPEC.async §3.1 theorem gates | #478 | CLOSED 2026-05-03 | Four theorem property tests + type-d fixtures shipped. |
| EPIC-11 — SPEC.async §14.2 bundle gates | #477 | CLOSED 2026-05-03 | Per-primitive sub-import bundle budget gates shipped. |
| EPIC-12 — SPEC.async race-row audit | (see Phase-7 race-detection meta) | CLOSED 2026-05-03 | Race-row inventory reconciled against §9.1 catalogue. |
| EPIC-13 — DESIGN-DISCIPLINE quarterly audit | #484 | CLOSED 2026-05-03 | Quarterly audit cron + first-audit-on-land-day task (#529) shipped. |

Also closed in the same window: EPIC-1 critical-review follow-ons (#584) which addressed 12 unaddressed recommendations from `tmp/epics/EPIC-1-CRITICAL-REVIEW.md`, and the Phase-8 SPEC compliance audit meta tracker (#564).

## Post-0.9.0 work (after this plan's EPICs closed)

The 13 EPICs above closed the Phase-7 race-detection / async-spec gaps. Subsequent work that is **not** tracked under this plan:

- **WASM substrate** — epic #680 (closed); 17 sub-issues merged covering Phase-0 + Phase-1 scaffolding. Includes #1061 (`transition_phased` real-engine implementation), #1077 (named-struct cell reshape), and the rest of the engine-rs-core foundation.
- **Perf experiment umbrella** — epic #679 (closed); 22/22 sub-issues complete. Notable: the scrolling-viewport 654× regression was resolved in this window; `commitInternal` in `packages/core/src/graph.ts` now starts at line 3507 with Phase markers at lines 3690 (A), 3746 (B), 3834 (C), 3840 (C.5).
- **SPEC §17 commitment 13** — capability-cost residual band 3.0×-8.0× shipped via PR #1024.
- **SPEC §17 commitment 14** — three-tier host matrix (wasmgc-builtins / wasmgc-classic / serde-json) shipped via PR #1053.
- **SPEC §15.1 amendment** — `graph.read(node)` reference identity is not contractually guaranteed (H1 hazard); shipped via PR #1129.
- **Coverage-regression noise floor** — PR #1149 widened `COV_REGRESSION_DELTA` from 0.03 to 0.08 to absorb V8 Scavenge noise on flapping cells.
- **Quiescent-machine enforcement** — PR #1120 fixed `enforceQuiescentMachine()` with a basename-anchored regex and ancestor-PID exclusion.
- **Cross-backend fuzz tier budget** — PR #1097 (closing #1073) shipped `resolveCrossBackendFuzzTier()`.
- **Rust engine port** — epic #1133 (DEFERRED post-0.9.0); GO/NO-GO criteria documented in the epic body. 15 sub-issues #1134-#1148 + 7 panel-review sub-issues #1154-#1160 + 4 current-code defect issues #1150-#1153 are all merged via PRs #1161-#1164 (bundle ceiling amendment, NodeId generational disposal, JsonValue object representation bench, property-test tier sweep).
- **`tools/engine-rs-core/` current state** — post-#1078/#1080/#1077 the crate has real types: `NodeId` is generational `{ slot: u32, gen: u32 }` (post-#1151); `JsonValue::Object(BTreeMap<SmolStr, JsonValue>)` (post-#1078, awaiting decision on IndexMap swap per #1152's investigation); 7-named-struct cell shape.

---

## Historical: what was NOT yet implemented at plan-authoring time

The list below is preserved for context. Every item is now shipped per the roll-up above.

### Engine + checker side (SPEC.md)
1. **§16.2.1 Schema 3 IR foundation** — bump `CAUSL_MODEL_SCHEMA: 2 → 3`, add `graphId` per node, add `IREvent` union (`IRSubscribe | IRUnsubscribe | IRDispose | IRRead | IRTxSet`), add bounded `IRCallGraph` annotation on `IRCommit`. Updates the TS exporter, the Rust IR types, the lockstep workflow, every fixture in `tools/checker/tests/fixtures/`. **Blocking dependency for EPIC-2.** (Shipped: PR #462 + issue #463.)
2. **§16A.2 Four new lint passes** — `SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`. Each ships with positive/negative IR fixtures, expected SARIF output, false-positive examples, `ViolationKind` and `PassName` enum variants. **Depends on EPIC-1.** (Shipped: issue #464.)
3. **§16.4 Bounded enumerator** (`tools/enumerator/`) — Norvig-shaped BFS over the IR's reachable state space; oracle predicates implementing the §3 theorems + §9.1 row firings; concrete-execution worker pool; counterexample shrinker. **Depends on EPIC-1.** (Shipped: issue #467.)
4. **§16.5 Hypothesis API** (`packages/hypothesis/`) — TypeScript combinators for adopter-written temporal-logic hypotheses (`always`, `eventually`, `until`, `afterCommit`, `during`, `never`, `implies`, `and`, `or`); three-axis shrinker; verdict types. **Depends on EPIC-3.** (Shipped: issue #469.)
5. **SARIF output + `--passes` CLI** — extend `tools/checker/src/lib.rs` with a `to_sarif()` adapter and a `tools/checker/src/sarif.rs` module; add `--passes` clap enum with `core`, `lifetime`, `all` named groups. **Independent; can ship today.** (Shipped: issue #465.)
6. **Race-detection CI workflow** (`.github/workflows/race-detection.yml`) — three-tier hierarchy: PR (≤2 min) static + property; labelled-or-main (≤15 min) + enumerator at K=10/D=5; nightly (≤2 hr) + enumerator at K=20/D=8. **Depends on EPIC-3 and EPIC-4 for the Tier-2/Tier-3 legs; Tier-1 can ship now.** (Shipped: issue #468.)
7. **Apalache differential corpus** (`tools/enumerator/corpus/apalache/*.tla` + `tools/enumerator/corpus/rust/*.scenario.rs`) — 10 hand-written models per the §16.5 narrative; `apalache-diff` CI job. **Depends on EPIC-3.** (Shipped: issue #472.)

### Adapter side (SPEC.async.md)
8. **SPEC.async §10.5 Full executable test fixtures** — four `vitest` files (`spec-async-10-1-direct-commit.test.ts`, `-10-2-mvu-front-door.test.ts`, `-10-3-conflict-registry.test.ts`, `-10-4-disposed-mid-load.test.ts`). The TypeScript code blocks already exist in the spec; this EPIC lifts them out of the spec into runnable test files plus their CI integration. **Independent.** (Shipped: issue #474.)
9. **SPEC.async §15 Property suite + `@causljs/sync-testing-internal`** — 8 properties (4 Resource, 4 Conflict) at the §15.2 1000-trial floor; the `@causljs/sync-testing-internal` package with generators + harness factories + shrinking-aware shape helpers; conformance-walker enrolment. **Independent.** (Shipped: issue #475.)
10. **SPEC.async §3.1 Theorem CI gates** — four property tests (one per Theorem 1–4) plus the type-d fixtures. Each theorem's predicate, generator, and CI anchor are written down in the spec; this EPIC ships them as the runnable form. **Independent.** (Shipped: issue #478.)

### Items the team has decided to keep DEFERRED or NOT-PLANNED
- §13.1 Background refetch on focus/interval — DEFERRED.
- §13.2 Edit-mode time travel — DEFERRED.
- §13.3 Multi-graph composition — NOT-PLANNED (per the §13.3 deep-flesh PR).
- §13.4 Public `Disposed` arm on `Node` — NOT-PLANNED (KILL verdict from the §13.4 review).
- SPEC.async §13.1–§13.5 (revalidate, dedup, optimistic mutations, resourceFamily, subscriptions/SSE) — DEFERRED.
- SPEC.async §13.6 Conflict resolution UI primitives — NOT-PLANNED.
- SPEC.async §13.7 Cross-graph conflict registry — NOT-PLANNED.

These do **not** appear as EPICs below. They are recorded in the spec with reopen triggers; a future PR that satisfies a trigger reopens the row.

## Files affected per EPIC

| EPIC | Files (estimate) | Risk |
| --- | --- | --- |
| 1 — Schema 3 IR | `packages/core/src/ir.ts`, `packages/core/src/graph.ts` (exportModel), `tools/checker/src/ir.rs`, `tools/checker/src/check.rs` (Schema pass gate), `tools/checker/Cargo.toml` (metadata pin), `.github/workflows/release-checker.yml`, every `tools/checker/tests/fixtures/*.json`, plus the migration codemod `tools/migrate-ir-2-to-3.ts`. ~30 files. | LOW |
| 2 — Four lint passes | `tools/checker/src/check.rs` (4 new pass functions), `tools/checker/src/sarif.rs` (new), `tools/checker/tests/fixtures/{subscribe-without-dispose,commit-from-subscribe,cross-graph-read,use-after-dispose}/{positive,negative}.json`, `tools/checker/tests/fixtures/*/expected.sarif.json`. ~25 files. | LOW |
| 3 — Bounded enumerator | New crate `tools/enumerator/` with `src/{state,action,transition,trace,oracle,bound,worker_pool}.rs`, `src/lib.rs`, `src/main.rs`, `Cargo.toml`, `tests/`. ~15 files. | LOW |
| 4 — Hypothesis API | New package `packages/hypothesis/` with `src/{index,types,combinators,shrink,evaluate}.ts`, `package.json`, `tsconfig.json`, `test/`. ~12 files. | LOW |
| 5 — SARIF + `--passes` | `tools/checker/src/lib.rs`, `tools/checker/src/main.rs`, `tools/checker/src/sarif.rs` (new), `tools/checker/tests/sarif.rs` (new). ~5 files. | LOW |
| 6 — Race-detection CI | `.github/workflows/race-detection.yml` (new), `causl.config.ts` (root, optional). 2 files. | LOW |
| 7 — Apalache corpus | `tools/enumerator/corpus/apalache/*.tla` (10 files), `tools/enumerator/corpus/rust/*.scenario.rs` (10 files), `tools/enumerator/corpus/mapping.toml`, `.github/workflows/checker-diff.yml`. ~22 files. | LOW |
| 8 — SPEC.async §10.5 fixtures | `packages/sync/test/spec-async-10-{1,2,3,4}*.test.ts` (4 files). | LOW |
| 9 — SPEC.async §15 property suite | New package `packages/sync-testing-internal/`, plus `packages/sync/test/properties/*.property.test.ts` (8 files), `packages/sync/test/spec-15.2-conformance.test.ts` enrolment update. ~12 files. | LOW |
| 10 — SPEC.async §3.1 theorem gates | `packages/sync/test/theorems/{origin-bound-resolution,single-pipeline,promise-identity,behavior-domain}.spec.ts` (4 property tests), `packages/sync/test/theorems/{no-tx-escape,loading-arm-shape}.types.ts` (2 type-d fixtures). 6 files. | LOW |

## Dependencies (topological)

```
EPIC-1 (Schema 3)
  ├── EPIC-2 (4 lint passes) → required for Schema 3 events
  ├── EPIC-3 (Bounded enumerator) → consumes Schema 3 IR
  │     ├── EPIC-4 (Hypothesis API)
  │     └── EPIC-7 (Apalache corpus)
  └── (EPIC-5 SARIF — does not block, but ships alongside EPIC-2 cleanly)

EPIC-6 (Race-detection CI)
  └── Tier-1 leg ships independently; Tier-2/Tier-3 wait on EPIC-3/4

EPIC-8 (§10.5 fixtures)            — independent, ship today
EPIC-9 (§15 property suite)        — independent, ship today
EPIC-10 (§3.1 theorem gates)       — independent, ship today
```

## Execution order (recommended)

**Wave 1 — independent, ship now**
- EPIC-8 (SPEC.async §10.5 test fixtures)
- EPIC-9 (SPEC.async §15 property suite + sync-testing-internal)
- EPIC-10 (SPEC.async §3.1 theorem CI gates)
- EPIC-5 (SARIF output + `--passes` CLI flag) — extends current checker without schema bump
- EPIC-6 (Race-detection CI workflow Tier-1 leg)

**Wave 2 — schema-3 prerequisite**
- EPIC-1 (Schema 3 IR foundation) — single-PR, mechanical, exporter + Rust IR + lockstep workflow

**Wave 3 — depends on Wave 2**
- EPIC-2 (Four §16A.2 lint passes)
- EPIC-3 (Bounded enumerator scaffold + first tier coverage)

**Wave 4 — depends on Wave 3**
- EPIC-4 (Hypothesis API)
- EPIC-7 (Apalache differential corpus)
- EPIC-6 (Race-detection CI workflow Tier-2/Tier-3 legs)

## Risk (historical)

At plan-authoring time the user stated this was **LOW risk** — nothing had been committed to ship. The EPICs above were the team's audit list of "what would we build if we built it tomorrow," not a v1 commitment. All 13 EPICs subsequently shipped in the Phase-7 cycle (2026-05-03) and the schema bump (EPIC-1) landed atomically per the lockstep workflow without any retroactive divergence against schema-2 consumers.

The only risk classes worth naming:
- **Schema bump (EPIC-1):** wire-format break against schema-2 consumers. Mitigated by the lockstep workflow + the `tools/migrate-ir-2-to-3.ts` codemod + structural failure of the `Schema` pass on mismatch.
- **Bounded enumerator (EPIC-3):** correctness — a bug in `transition()` produces a false-pass on a real race. Mitigated by the Apalache differential corpus (EPIC-7) before the enumerator's verdict is allowed to count toward §17 commitment 11.
- **Property-suite trial-floor regression (EPIC-9, EPIC-10):** a contributor lowering `numRuns` below 1000 silently. Mitigated by the §15.2 conformance walker (`packages/core/test/spec-15.2-conformance.test.ts`, #437) which already enforces the floor.

All other EPICs are documentation-shaped (CI YAML, fixtures, type-d files) and present negligible risk to existing consumers.

## Each EPIC ships with

- **First-person active-voice team-rep prose**, matching the SPEC.md voice.
- **Brutal-critical review** of the spec section — what we accept, what we'd rewrite if we were starting today.
- **Sub-issues** as TASK-shaped items, each with its own TDD suite.
- **5 core concerns per sub-issue** the test must cover.
- **Race-condition or MIRI testing** named explicitly where the sub-issue touches concurrency, FFI, or unsafe Rust. (MIRI applies to EPIC-3's enumerator and EPIC-7's worker-pool RPC; everywhere else it's `propertyTrials` at the 1000-trial floor.)
- **SPEC section references** anchored on every claim.
