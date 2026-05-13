# Epic #1133 — Revised plan (post team-review)

**Anchor**: this is the canonical plan artifact for the post-0.9.0 Rust engine port. Every implementation session reads this file FIRST and updates the [Resumption bookmark](#resumption-bookmark) at the end.

**Target branch**: `dev`. All Phase 0+ PRs merge to `dev`; `dev → main` happens once the full port lands + the regression-gate tests confirm.

**Anchor commit**: dev branched off `main@117941ac` (2026-05-13). All upstream main commits flow into dev via periodic merges.

---

## 1. Why this plan exists

The existing `#1133` epic body is dense and accurate but predates 17 lens-specific team-review comments posted across the epic + sub-issues. Those comments materially reshape the work — they elevate `#1150` to a NO-GO blocker, surface the FFI-arithmetic-doesn't-balance problem on `equality-cutoff × 10000`, mandate a `failing_against_stub` corpus that must fail first, and decompose Phase A from a 4-8 week single-ticket into 13 micro-tickets each turning a corpus slice green.

This plan folds those 17 comments into one execution surface. Every recommendation is cited; every action has a ticket owner; every kill-criterion is a literal PR-blocking checkbox.

## 2. Persona-team verdicts (the four cluster reviews)

Four lens reviews posted in the prior session — full text at `gh issue view 1133 --comments`:

| Cluster | Lens | Headline verdict | Critical findings |
|---|---|---|---|
| **V8 / spec internals** | Eich · Wirfs-Brock · Horwat · Guo | **CONDITIONAL GO** | FFI arithmetic doesn't balance: 4 µs/op × 10k = 40 ms boundary tax vs 0.7 ms projected savings (57× larger). IC-stability invisible to the existing bench. `#1150` must escalate to NO-GO. SPEC §17.6 amendment scope under-enumerated. |
| **Capabilities / adopter API** | Miller · Hejlsberg · Markbåge · Abramov · Linsley · Pocock | **conditional on RC track + tooling** | The port narrows three adopter-visible contracts (ref identity, `Node<T>` JSON-round-trippable value-type set, auto-flip caching shape). Without a 0.10.0-rc.N → 1.0.0 track shipping ESLint rule + codemod + `JsonRoundtrippable` deprecation BEFORE the wrapper swap, adopters break twice. `enableH1HazardWarning` defaults to `false` (`types.ts:823`) — the safety net the epic counts on is opt-in. |
| **Engine semantics / SPEC** | Harel · Elliott · Kay · Reenskaug · Czaplicki | **GO conditional on SPEC amendments** | SPEC §3 Theorem 2 needs uninterruptibility clause (no microtask between Rust Phase E publish and JS Phase G dispatch). `IndexMap` not `FxHashMap` for subscriber container (hashbrown iteration order non-portable). `Object.is` vs Rust `f64::eq` parity unspecified — `NaN`/`-0.0` divergence is a one-line bug waiting for the right seed. Panel S10 bisimulation trace misses dep-set deltas — extend to sextuple. |
| **TDD / migration discipline** | Beck · Fowler · Martin · Metz · Haines | **GO conditional on red-first discipline** | Cross-backend determinism corpus has NEVER been red — `WasmBackend` wraps a TS engine (`wasm/index.ts:491`), both branches resolve to the same engine. Test must FAIL FIRST. Decompose Phase A 4-8 weeks → 13 micro-tickets each turning a `failing_against_stub` slice green. Perf-floor probe at sub-A.1 as the earliest kill signal. Kill-criteria as per-sub-issue PR-blocking checkboxes (Martin's contract-locality). |

## 3. Revised phase decomposition

```
Phase 0 — Preconditions (THIS WORK)
├── dev branch created (✅ 117941ac)
├── docs/epic-1133/PLAN.md (THIS FILE)
├── docs/epic-1133/HANDOFF.md (next-ticket bookmark)
├── failing_against_stub corpus PR (20 categories, BACKEND env switch)
├── A.1 perf-floor probe PR (kill threshold 0.5 ms × 10k workload)
├── Epic #1133 body amended via comment-link to this plan
└── #1147 Phase A body amended with A.0–A.12 decomposition

Phase 1 — Pre-Phase-A blockers (must close before A.0)
├── #1150 — SPEC §17.6 serde bundle ceiling violation (NO-GO blocker per V8 cluster)
├── #1151 — Hardcoded trial counts → resolveCrossBackendFuzzTier (TDD cluster: re-classified from "parallel" to precondition)
├── #1160 — ABI A/B microbench Criterion 6 (IC stability) + Criterion 7 (per-call vs per-commit) re-open
└── SPEC §3 Theorem 2 uninterruptibility amendment (Engine-semantics cluster S9)
└── SPEC §5.1 IndexMap container pin amendment (Engine-semantics cluster S13)

Phase A — Engine port (13 micro-tickets, each 1-3 days)
├── A.0 ABI shape lock + walking skeleton FFI roundtrip
├── A.1 Precondition: re-entrancy + tx-aliveness guards [PERF-FLOOR PROBE FIRES HERE]
├── A.2 Precondition: node-resolution errors (folds #1151 generational NodeId)
├── A.3 GraphTime monotonicity + Phase C clock advance
├── A.4 Tx::set slow-path staging (no fast path, no rollback)
├── A.5 Phase B publish loop with Object.is filter + rollback arrays
├── A.6 Catch-arm rollback walk
├── A.7 Phase A Tx::set fast path (hasDependents=false)
├── A.8 Phase A.5 fast-path rollback-row compaction
├── A.9 Phase C.5 lastWriteTime stamp
├── A.10 Typestate phase walker (refactor)
├── A.11 File-split decision ticket (Metz: defend each file's reason-to-change)
└── A.12 BackendEngine trait decomposition

Phase B — Phase D Kahn topological recompute (#1134)
├── Mid-Phase-D read() atomicity property
├── Kahn dep-graph container pin (BTreeMap or IndexMap)
├── Object.is parity (SameValue, NOT IEEE-754 PartialEq)
└── Bisimulation sextuple gate

Phase C — Commit assembly + log + retention (#1144)
└── (Awaiting team-review comments — no diff yet)

Phase D — G/H subscriber dispatch + transient dispose drain (#1136)
└── IndexMap container pinned from Phase 1

Phase E — JS↔WASM subscriber bridge (#1135)
├── SPEC §5.1 Phase G subscriber-throw isolation
├── IndexMap container in bridge
├── Re-entrant commit typestate guard
└── Bridge-crossing count as SPEC §14 metric

Phase F — WasmBackend integration (#1142)
└── BLOCKED on Node<T extends JsonRoundtrippable> SemVer-major narrowing

Phase G — Validation
├── Cross-backend determinism (#1146) — failing_against_stub turns green
├── 2+1+1 differential (#1141)
├── Bridge-roundtrip Unicode (#1138)
├── Long-run-1M heap-leak (#1140)
└── Phase-1 perf measurement (#1145) — IC-stability gate fires here

Phase H — Adopter-facing
├── React zero-copy (#1148) — ESLint + codemod ship in rc.1
├── Auto-adapt validation (#1143) — default OFF in production
├── 0.10.0-rc.1 → rc.N → 1.0.0 (#1137) — RC track, not jump to release
└── Re-tighten COV gate (#1139) post-validation

Phase I — Post-release ledger
└── Document measured-vs-projected ratio in #1015 ledger
```

## 4. Kill-criteria — promoted to per-sub-issue PR-blocking checkboxes

Per TDD cluster, every numeric kill threshold below must appear as a literal `- [ ]` checkbox in the acceptance criteria of the sub-issue where the measurement happens. PRs are blocked from merging until the checkbox is checked OR a STOP-verdict comment is filed on `#1133`.

| Gate | Threshold | Where measured | Sub-issue carrying the checkbox |
|---|---|---|---|
| Bundle ceiling | serde ≤ 200 KB, gc-classic ≤ 120 KB, gc-builtins ≤ 110 KB | `tools/size-limit/...` | `#1150` (NO-GO blocker, blocks Phase A) [^1150-closed] |

[^1150-closed]: `#1150` was closed via SPEC amendment + divergence documentation — PR #1161 (MERGED 2026-05-11, Option C disposition) added the §17.6 current-state callout recording the 213 KB raw / 66 KB Brotli measurement against the 200 KB / 80 KB canonical ceiling, and the §19 amendment trail row was added in the post-STOP-VERDICT documentation pass on 2026-05-13. The divergence is now documented rather than silent. Phase A would have re-tightened to 200/80 via Option A (direct `wasm-opt` invocation per PR #1112's design discussion at #1085); with the 2026-05-13 STOP-VERDICT on this epic (A.1 perf-floor probe fired the kill gate by 35×), the re-tightening is deferred to whatever the post-STOP path delivers (DROP / PIVOT to a fundamentally different boundary / DEFER to the next 6-month cadence). The NO-GO-blocker designation in this row is preserved as historical record; it no longer blocks Phase A from claiming (the gate that did block — adopters reading the SPEC seeing a silent over-spec ship — is now closed).
| ABI shape | by-value or opaque-handle wins ≥ 3× on Criterion 1 | `tools/engine-rs-port-bench/` | `#1160` (Criterion 1) |
| IC stability | post-Rust IC megamorphic count ≤ baseline × 1.2 | `tools/engine-rs-port-bench/ic-stability.rs` | `#1160` (Criterion 6) + `#1145` |
| Perf-floor (A.1) | `op-rust-bridge-floor-1k × 10000` median ≤ 0.5 ms | `packages/bench/src/scenarios/op-rust-bridge-floor-1k.ts` | `#1145` (Acceptance 0) |
| Perf primary (Phase G) | `equality-cutoff × 10000` real-Rust median ≤ 1.16 ms | `packages/bench/...` | `#1145` |
| Byte-identity | 5×5×3 × `resolveCrossBackendFuzzTier()` trials × 5 seeds, 0 divergences | `packages/core/test/properties/cross-backend-determinism.property.test.ts` | `#1146` |
| failing_against_stub | All 20 corpus categories transition red → green by Phase A completion | `packages/core/test/properties/failing-against-stub.property.test.ts` | `#1146` (Acceptance 0) |
| H1 cohort | ≤ 5% of adopter `read()` call sites after codemod | `tools/check-h1-cohort.mjs` | `#1148` (AC5c) |
| #1015 ratio | measured savings ≥ 60% of pre-derived projection | `docs/wasm/phase-1-perf.md` | `#1145` |
| SPEC §17.6 callout audit | 0 residual "Phase-1" / "wrapper-not-Rust" strings | `tools/check-phase1-callouts.mjs` | `#1137` (M3) |

## 5. Phase A — full 13-ticket decomposition

Per the decomposition agent's research (full table also lives on `#1147` body after the Phase 0 edit). Each ticket: 1-3 days, red→green→refactor cycle, targets one or more `failing_against_stub` corpus categories.

| Ticket | Title | Touches | Corpus categories | Effort (days) | Predecessor |
|---|---|---|---|---|---|
| A.0 | ABI shape lock + walking-skeleton FFI roundtrip | engine-rs-core/lib.rs (re-export), bridge harness | `roundtrip: empty-tx returns empty-Commit shape`, `bundle: post-A0 size delta ≤ X KB` | 1 | #1160, #1150 |
| A.1 | Precondition — re-entrancy & tx-aliveness guards | transition/validate.rs (new) | `precondition: nested commit`, `precondition: stale tx` | 2 | A.0 |
| A.2 | Precondition — node-resolution errors (+ #1151 generational NodeId) | transition/validate.rs, state.rs | `precondition: dispose+reuse stale handle`, `precondition: tx.set on derived`, `precondition: unknown id` | 2 | A.1 |
| A.3 | GraphTime monotonicity + Phase C clock advance | transition/clock.rs | `clock: empty-tx advances time by 1`, `clock: error-tx does NOT advance` | 1 | A.1 |
| A.4 | Tx::set slow-path staging | transition/mutate.rs, cell.rs | `tx-set: single slow-path write`, `tx-set: re-write same input`, `tx-set: equal-value skip` | 2 | A.2 |
| A.5 | Phase B publish loop + Object.is filter + rollback arrays | transition/publish.rs, state.rs | `phase-b: changed value publishes`, `phase-b: Object.is skip`, `phase-b: rollback triple holds pre-image` | 2 | A.4 |
| A.6 | Catch-arm rollback walk | transition/rollback.rs | `rollback: throw mid-tx-fn restores byte-identical`, `rollback: throw mid-Phase-B`, `rollback: stale lastStagedAt cleared` | 3 | A.5 |
| A.7 | Phase A Tx::set fast path (hasDependents=false) | transition/mutate.rs, cell.rs | `tx-set-fast-path: isolated bypasses staging`, `tx-set-fast-path: sentinel hit`, `tx-set-fast-path: revert cancels` | 2 | A.6 |
| A.8 | Phase A.5 fast-path rollback-row compaction | transition/compact.rs | `phase-a5: revert sequence drops row`, `phase-a5: survivors in changedInputIds`, `phase-a5: compaction order` | 2 | A.7 |
| A.9 | Phase C.5 lastWriteTime stamp | transition/stamp.rs | `phase-c5: changed input gets new lwt`, `phase-c5: object-is-skip does NOT stamp`, `phase-c5: revert retains pre-tx lwt` | 1 | A.8, A.3 |
| A.10 | Typestate phase walker refactor | transition/typestate.rs | `typestate: skipped-phase compile_fail`, `typestate: post-refactor corpus byte-identical` | 2 | A.9 |
| A.11 | 7-file split DECISION ticket (not implementation) | transition/* | (refactor — table of reasons-to-change defended in PR description) | 2 | A.10 |
| A.12 | BackendEngine trait decomposition | tools/engine-rs-core/src/backend.rs | (refactor — Transitioner/Reader/Persister/Observable carve-out) | 1 | A.11 |

**Estimated Phase A total: 23 days single-developer, ~5 weeks calendar.** At one micro-ticket per 5-hour Claude session, **13 sessions of focused work**. With backpressure from validation re-runs and any defer-to-next-session boundaries, plan **15-18 sessions** for Phase A alone.

## 6. failing_against_stub corpus — 20 categories

Per the corpus-design agent. Lives at `packages/core/test/properties/failing-against-stub.property.test.ts` + `packages/core/test/properties/failing-against-stub-fixtures.ts` + `tools/engine-rs-core/tests/stub_corpus_categories.rs`. Switched by `CAUSL_BACKEND` env var (`stub` / `ts` / `rust`).

| # | Fixture id | Targeted by ticket |
|---|---|---|
| 1 | `tx-set-single-input-changed-nodes-nonempty` | A.4, A.5 |
| 2 | `tx-set-two-inputs-changed-nodes-stable-order` | A.5 |
| 3 | `tx-set-intent-roundtrip` | A.4, A.5 |
| 4 | `tx-set-time-advances-by-one-per-commit` | A.3 |
| 5 | `tx-set-equality-cutoff-changed-nodes-empty` | A.5 (Object.is filter) |
| 6 | `derived-chain-depth-2-publishes-all` | Phase B (#1134) |
| 7 | `commit-log-monotonic-append` | Phase C (#1144) |
| 8 | `retention-buf-most-recent-K` | Phase C (#1144) |
| 9 | `subscribe-fires-on-changing-commit` | Phase D (#1136) |
| 10 | `subscribe-fire-order-insertion-stable` | Phase D (#1136) IndexMap pin |
| 11 | `dispose-makes-node-stale` | A.2 (generational NodeId) |
| 12 | `unsubscribe-removes-from-all-buckets` | Phase E (#1135) |
| 13 | `begin-fetch-resource-loading` | (post-Phase-A) |
| 14 | `resolve-pending-resource-loaded` | (post-Phase-A) |
| 15 | `dispatch-msg-queues-into-pipeline` | (post-Phase-A) |
| 16 | `tick-advances-now-only` | A.3 |
| 17 | `transition-phased-return-shape-is-tuple` | A.0 (ABI shape) |
| 18 | `cycle-rejection-surfaces-race-class` | Phase B (#1134) |
| 19 | `state-hash-byte-stable-across-runs` | A.10 (typestate post-refactor) |
| 20 | `phase-walk-emits-canonical-step-sequence` | Phase B/C/D |

**Acceptance contract**:
- `CAUSL_BACKEND=stub`: all 20 must FAIL today. CI parses `[stub] <id> FAIL` lines; count MUST be exactly 20.
- `CAUSL_BACKEND=ts`: all 20 must PASS today. The TS engine is the oracle.
- `CAUSL_BACKEND=rust`: pass rate is the progress meter. CI dashboard tracks `X/20` over time; a regression (count decreased) blocks merge.

## 7. A.1 perf-floor probe — kill gate

Per the perf-floor-probe design agent. Probe name: `op-rust-bridge-floor-1k`. Strategy: extend `engine-rs-bridge-serde` with a `floor-only` cargo feature (default off) that exposes a `floor_only_transition(state, action)` entry point bypassing real Rust algorithm work — pure FFI roundtrip.

**Kill threshold**:
> If `median(op-rust-bridge-floor-1k @ scale=10_000) × 10_000 / 1e6` exceeds **0.5 ms**, file STOP-VERDICT comment on `#1133`, halt Phase A.2 dispatch, freeze the epic pending boundary-architecture reconsideration.

**Honest framing**: this probe is a **lower bound, not a forecast**. Real Phase A.2 will pay strictly more (full State deserialiser, populated Commit, etc.). The probe is a structural kill gate, not a GO signal — passing it does NOT prove real Rust will pass.

**AMBER band**: 0.3-0.5 ms triggers a rerun against `engine-rs-bridge-gc` before any STOP verdict.

## 8. Resumption bookmark

> Read first on every session. Updated at end of every session.

**Last session**: 2026-05-13 (this session)

**Branch state**: `dev` at … _(updated by handoff after PRs merge)_

**Last ticket landed**: _(updated by handoff)_

**Next ticket to claim**:
- **If Phase 0 is incomplete** → finish remaining Phase 0 PRs in order: (1) failing_against_stub corpus, (2) A.1 perf-floor probe, (3) update epic + #1147 issue bodies.
- **If Phase 0 is complete** → claim **Phase 1 blockers in this order**:
  1. `#1150` — bundle ceiling violation must close (NO-GO blocker)
  2. `#1151` — hardcoded trial counts codemod + lint rule
  3. SPEC §3 Theorem 2 uninterruptibility amendment (file as PR against `SPEC.md`) — **SHIPPED** via issue #1333 (2026-05-13)
  4. SPEC §5.1 IndexMap pin amendment — **SHIPPED** via issue #1333 (2026-05-13)
  5. `#1160` Criterion 6 + 7 re-open (the closed issue gets amended sub-issues)
- **If Phase 1 is complete** → claim **A.0** (walking-skeleton FFI roundtrip).
- **If Phase A is mid-flight** → check `git log origin/dev --oneline -20` for the last `A.N` commit; claim `A.(N+1)`.

**Kill-criteria status (as of session end)**:
- [ ] Bundle ceiling (#1150) closed
- [ ] ABI shape decision (#1160) re-opened with Criteria 6+7
- [ ] failing_against_stub corpus running red on stub
- [ ] A.1 perf-floor probe scaffolding in place
- [x] SPEC §3 + §5.1 amendments drafted — landed via issue #1333 (2026-05-13)

**Handoff details**: see `docs/epic-1133/HANDOFF.md` (per-session bookmark, in addition to this canonical plan).

---

## 9. Cross-session continuity protocol

Each session:
1. **Open**: read this `PLAN.md`, then `HANDOFF.md`. Find the next-ticket-to-claim.
2. **Execute**: complete that ticket via red→green→refactor; PR to `dev`; merge.
3. **Close**: update `HANDOFF.md` with: dev HEAD SHA after merge, ticket landed, next ticket, any blockers discovered.
4. **Out of usage**: write a final `HANDOFF.md` entry naming the partial state of the in-flight ticket (which file you were editing, which test you were trying to turn green) so the next session restarts mechanically.

This is the discipline that makes the multi-month arc tractable across 5-hour budgets.

---

## 10. References

Source comments (verbatim quotes used in this plan):
- `gh issue view 1133 --comments` (4 cluster reviews + earlier panel S1-S22)
- `gh issue view 1160 --comments` (V8 cluster Criterion 6 + 7)
- `gh issue view 1147 --comments` (TDD cluster decomposition)
- `gh issue view 1146 --comments` (TDD + Engine-semantics on byte-identity)
- `gh issue view 1145 --comments` (V8 + TDD on perf methodology)
- `gh issue view 1148 --comments` (Capabilities on React zero-copy)
- `gh issue view 1143 --comments` (Capabilities on auto-adapt)
- `gh issue view 1137 --comments` (Capabilities on RC track)
- `gh issue view 1135 --comments` (Engine-semantics on subscriber bridge)
- `gh issue view 1151 --comments` (TDD on hardcoded trial counts)
- `gh issue view 1134 --comments` (Engine-semantics on Phase D)

Code references:
- `tools/engine-rs-core/src/lib.rs:209-214` — `transition_phased_stub`
- `tools/engine-rs-core/src/transition.rs:53-143` — oracle behaviour
- `tools/engine-rs-core/src/phase_step.rs:109` — real `transition_phased` shape
- `packages/core/src/graph.ts:4128-4870` — `commitInternal` (Phase A entry 4311, A.5 4315, B 4367, C 4455, C.5 4461, catch arm 4782)
- `packages/core/wasm/index.ts:439-492` — `WasmBackend` (TS-engine wrapper)
- `packages/core/test/properties/cross-backend-determinism.property.test.ts` — existing gate (provably unfailable today)
- `tools/engine-rs-bridge-serde/src/lib.rs:60-78` — current bridge cost source

SPEC sections to amend (drafted in Phase 1):
- `SPEC.md` §3 (Theorem 2 uninterruptibility) — **SHIPPED** via issue #1333 (2026-05-13)
- `SPEC.md` §5.1 (IndexMap container pin) — **SHIPPED** via issue #1333 (2026-05-13); subscriber throw isolation + Phase G ordering remain deferred
- `SPEC.md` §5.2 (rollback pre-image structure)
- `SPEC.md` §15.1 (value-type compatibility / `JsonRoundtrippable`)
- `SPEC.md` §17.5 (perf residual band post-Rust)
- `SPEC.md` §17.6 (bundle ceilings, Phase-1 callout retirement)
