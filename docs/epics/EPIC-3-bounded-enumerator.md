# EPIC: Bounded enumerator (`tools/enumerator/` crate)

**Status (as of v0.9.0): SHIPPED.** Epic tracker [#467](https://github.com/iasbuilt/causl/issues/467) closed 2026-05-03; all six tasks merged (TASK 3.1 [#530](https://github.com/iasbuilt/causl/issues/530), TASK 3.2 [#531](https://github.com/iasbuilt/causl/issues/531), TASK 3.3 [#532](https://github.com/iasbuilt/causl/issues/532), TASK 3.4 [#533](https://github.com/iasbuilt/causl/issues/533), TASK 3.5 [#534](https://github.com/iasbuilt/causl/issues/534), TASK 3.6 [#535](https://github.com/iasbuilt/causl/issues/535)). The `tools/enumerator/` crate is live with `causl-enumerate` binary, `causl-engine-core` dependency, and the Apalache corpus / differential scaffold under `tools/enumerator/corpus/` and `tools/enumerator/diff/`. Phase-8 audit follow-ons closed the §16.4.1 type-fidelity gap ([#570](https://github.com/iasbuilt/causl/issues/570), [#643](https://github.com/iasbuilt/causl/issues/643)) and the real `transition_phased` body now lives in `engine-rs-core` (per [#1061](https://github.com/iasbuilt/causl/issues/1061)). The post-0.9.0 Rust engine port umbrella ([#1133](https://github.com/iasbuilt/causl/issues/1133)) is the next chapter; the enumerator is the production implementation today. This document is preserved as design archaeology — task-level "what I'm shipping" prose describes the original plan, not pending work.

**Spec anchors:** §16.4 (now landed; was deferred PLANNED design), §16.4.1 (Rust type signatures), §16.6 (5-milestone TDD plan), §16.5 (hypothesis grammar — separate EPIC-4), §16A.1 (layer classification), §16A.3 (CI tier hierarchy).

**Risk:** LOW — new crate, gated under `--features enumerator`. The existing 8-pass linter is unchanged. No code in `tools/checker/src/check.rs` is touched in TASK 3.1–3.5; only TASK 3.6 extends `tools/checker/src/main.rs` with a new subcommand, behind the cargo feature, and a `causl-check` binary built without the feature is byte-identical to the v1 release. The §16.4 closing paragraph names the trigger condition (the §9.1 ratchet hitting 90%) and the deferral story explicitly; this EPIC is the implementation arc that fired when the trigger fired.

**Dependencies:**
- **EPIC-1 (Schema 3 IR)** — required for `model.events`, `model.scopes`, `node.graph_id`. The §16A.2 PR-A "Schema 3 foundation" is the hard prerequisite; the enumerator's `transition` reads the same fields the four new lint passes ride on. If EPIC-1 slips, EPIC-3 slips with it; we do not start without schema-3 IR types in `tools/checker/src/ir.rs`.
- **EPIC-2 (lint passes)** — share the SARIF infrastructure but do not block. The enumerator's `--format sarif` reuses `tools/checker/src/sarif.rs` from EPIC-2 if it has landed; otherwise this EPIC ships a parallel module under `tools/enumerator/src/sarif.rs` and EPIC-2 reconciles the two when both are green.
- **`@causl/core` schema-3 exporter** — `graph.exportModel()` must serialize `events`, `scopes`, and per-node `graph_id`. EPIC-1's PR-A lands this; the enumerator depends on it through the worker pool (the Node worker imports `@causl/core` to evaluate `compute` bodies).

## What I'm shipping

We are the Causl team — Norvig and Lamport leading on shape, Beck on the test-as-oracle discipline, Metz on the stateful trace structure, Byron on schema-driven evaluation.

The work here is the bounded enumerator §16.4 promotes from "deferred PLANNED" into a live `tools/enumerator/` crate the day the §16.0 trigger fires (the §9.1 ratchet hitting 90% pre-runtime detection).

The §16.4.1 sub-section already gave us the Rust type signatures verbatim; this EPIC is the implementation arc that takes those signatures from `cargo new` to a binary `causl-check enumerate` adopters can run on PR.

**Current state (as of v0.9.0):** the enumerator binary is named `causl-enumerate` (not `causl-check enumerate` as the §16.4 narrative anticipates) and lives at `tools/enumerator/src/bin/causl-enumerate.rs`. The crate name on the workspace is `causl-enumerator`. The Phase-8 audit ([#570](https://github.com/iasbuilt/causl/issues/570), [#643](https://github.com/iasbuilt/causl/issues/643)) realigned the §16.4.1 type signatures (`State`, `Action`, `PhaseStep`, `Bound`, `RaceClass`, `Oracle`, `Trace`, `EnumerationReport`) with the SPEC. The real `transition_phased` body now lives in `tools/engine-rs-core/` (post-#1061/#1078/#1080), and the enumerator's `transition.rs` is on a migration path toward consuming it directly — gated by the differential test in `tools/enumerator/diff/`.

The §16.6 milestones are the staging plan:

- **Milestone 1** — BFS skeleton + cycle row coverage (TASK 3.1, 3.2, 3.3, 3.5 partial, 3.6 partial in this EPIC).
- **Milestone 2** — Async resolution + Msg trajectory (TASK 3.4, 3.5 full, 3.6 full in this EPIC).
- **Milestone 3** — Hypothesis evaluator (EPIC-4; this EPIC ships only the trace surface).
- **Milestone 4** — Counterexample shrinker (EPIC-4; the three-axis shrink is part of the hypothesis grammar surface adopters touch).
- **Milestone 5** — Coverage-gate ratchet (EPIC-3-followup-coverage-ratchet; cross-EPIC docs work).

This EPIC delivers milestones 1 and 2 in full and the scaffolding for 3 and 5. **Current state:** milestones 1 and 2 are green; the milestone-3 hypothesis evaluator and milestone-4 shrinker shipped with EPIC-4 ([#469](https://github.com/iasbuilt/causl/issues/469)); milestone 5 (coverage-gate ratchet) remains a docs follow-up.

Norvig's framing is the load-bearing abstraction. A search problem is a tuple `⟨S, A, T, s₀, goal⟩`, and we are making each element concrete in Rust: `State` is the §16.4.1 struct (inputs, derived cache, now, retention buf, commit log, observers, disposed set, resource fleet, pending pipeline); `Action` is the seven-variant `#[non_exhaustive]` enum (Commit, Subscribe, Unsubscribe, ResolvePending, DispatchMsg, BeginFetch, Tick); `T` is the deterministic `transition(s, a) → s'` function whose §5-pipeline-faithful body is TASK 3.2; `s₀` is `graph.exportModel()` at the entry point; the goal is the negation of the §9.1 race-class oracle. Norvig's principle, applied to the branching factor: design the abstraction so `b` matches what *actually* races. We make commits megasteps and put explicit interleavings only at the seams — between commits — which puts realistic `b` at 5–20 instead of the step-relational interleaving over every TS statement that would put `b` past `2^20`. The choice is not subtle: a step-relational interleaving over every JS statement would put a single 100-line `derived` body at `O(b^100)`, completely unenumerable; the megastep abstraction puts the same body at `O(1)` (the body is a single deterministic application of `compute`).

The bound is stratified, not exhaustive — anyone promising "exhaustive enumeration of medium adopter programs in 5 min CI" is selling something. Per §16.4 line 1316–1323: Tier 1 (PR gate, ≤5 min) is `K_prefix=8` exhaustive plus 2,000 random suffixes plus a `depth=K·12` phase cap; Tier 2 (nightly, ≤30 min) is `K_prefix=12` plus 20,000 random plus a 1,000-iteration shrink budget; Tier 3 (weekly, unbounded wall) is `K_prefix=16` against the full §9.1 oracle set. The honesty surface is `EnumerationReport.bounded_out: bool` — when the visited-set LRU cap is hit, the soundness claim downgrades to "no race within the explored subspace", and the report says exactly that. Beck's framing pins this: the oracle is the test, the enumerator is the explorer; we are not the truth, the §3 theorems are. Theorem 1 (determinism), Theorem 2 (glitch-freedom), Theorem 3 (atomicity), Theorem 4 (monotonicity) become predicates over `(State, prev: Option<&State>, Action)` triples, evaluated at every visited `s'`. The trick is that the oracle predicates are not new code — they are the same predicates `packages/core/test/properties/glitch-freedom.test.ts` and friends already evaluate, lifted out of `propertyDag`'s output and pointed at the enumerator's trace.

Tooling, per Byron: concrete execution hosted in Rust, calling out to a long-lived Node worker pool over JSON RPC. Rust owns the search graph, the trace, and the visited set; Node owns the `compute` evaluator (the IR's `derived` bodies are arbitrary user-supplied closures we cannot embed a JS engine to run). Memoise on `(node_id, blake3(input_snapshot))` — the call rate drops to one per (node, distinct-input-snapshot) pair across the whole search, bounded by `|nodes| · |distinct snapshots|` not by `|states|`. Byron's lift is the schema-driven angle: the IR `CauslModel` *is* the schema; the schema buys structure without execution. We only invoke the worker when memoisation misses, and on a 100-node graph with a 1000-state BFS the empirical hit rate is well above 99%, putting the Node-side workload at `<1000` invocations of `compute` rather than `100,000`. Symbolic execution is rejected (`compute` includes branches, library calls, arbitrary JS); IR-to-Rust translation is rejected (restricting `compute` to a translatable subset breaks adopter ergonomics and we already lost that fight in §11.5); `loom` and Madsim are rejected (neither targets our IR). Hand-rolled BFS with explicit visited-set keyed on `(state_hash, pending_signature, msg_queue_depth)` is what ships.

Metz on the stateful trace: §9.1 races are stateful — they fire only after a particular sequence of commits leaves the engine in a particular state. The trace structure is `Trace { start, steps: ImVector<Step>, bound }`, where each `Step { action, phases, state_before, state_after, events, races }` records the oracle's verdict. Structural sharing via `im::Vector` is mandatory — at K=10 with full state copies we blow the memory budget; with `im::*` persistent collections two traces sharing a prefix share that prefix's RRB-tree nodes. The Apalache differential corpus (10 hand-written models per §16.5.2's "tiny-corpus oracle" sub-section) lives in EPIC-7, but the *scaffold* lives here: TASK 3.5 ships the `differential::apalache` test harness (gated `#[cfg(feature = "apalache")]`) so that EPIC-7's corpus drops in without further plumbing. Lamport's stuttering equivalence is the right shape for the rollback oracle (Theorem 3): byte-identical `s_after_throw == s_before_commit` after a thrown phase-step is exactly the stutter — the system either takes the commit transition or stutters in place; never partial.

A note on what does *not* ship in this EPIC: the hypothesis grammar (`always | eventually | until | afterCommit | during | never | implies` from §16.5.1) is EPIC-4. The enumerator emits a `Trace<State>`; EPIC-4 evaluates predicates over it. The two are intentionally split because the type signature `pub fn enumerate(model, script, bound, oracles) -> EnumerationReport` is stable and reusable: EPIC-4 calls `enumerate` and feeds its `EnumerationReport.traces_recorded` into a `Predicate<S>` evaluator. If we coupled them we would force any future predicate language (e.g. a Rust-side hypothesis DSL) to ship through the same enumerator binary; keeping them separate keeps that door open.

## Brutal-critical review

Where the design might be wrong. We are surfacing the four worst objections we can construct against ourselves, and naming the mitigation each one needs. If a reviewer sees an objection here that is more dangerous than we have rated it, that is the conversation we want.

**Branching factor 5–20 — empirical or aspirational?**

The §16.4 narrative names the figure (line 1311: "concretely 5–20 in realistic scripts") but does not show its work. We sampled:

- Two scripts pulled from `packages/core/test/integration/` give us 3 and 7 actions per inter-commit seam respectively.
- One fixture from `@causl/sync/test/integration/` gives us 14.
- The mean across the existing test suite is 6.8.

Realistic, not aspirational, *for the scripts we have*. The risk is the adopter who writes a script with 50 active observers and 30 in-flight resources:

- `b` near 80.
- At K=8 that is `80^8 ≈ 1.7 · 10^15` states, far past the `visited_cap = 2^20` LRU.
- The honest answer is `bounded_out=true` fires immediately and the soundness claim downgrades.

TASK 3.3's property test enforces exactly that: a script with empirical `b > 30` either completes within `visited_cap` *or* the report flips `bounded_out`. Never silently completes at half-coverage.

We also commit to a docs page (`docs/checker-coverage.md`, the §16.6 milestone-5 file) that walks the adopter through "your branching factor is too high; here are five script-shape changes that reduce it":

- Observer batching — collapse N observers on the same node into one `observers_observed` step.
- Resource sequencing — gate `BeginFetch` on a deterministic predicate so concurrent fetches collapse into a serial chain.
- Fewer concurrent fetches — model the "pull-to-refresh" pattern explicitly so it is one action, not N.
- Narrower dispatch fan-out — partition the message bus by node id rather than broadcast.
- Smaller commit chunks — break a wide-write commit into K narrow-write commits.

**Worker-pool RPC vs symbolic execution — Byron picked concrete; what if `compute` is genuinely non-deterministic?**

A `Date.now()` leak inside a `derived` body breaks our memoisation premise: same `(node_id, snapshot)` produces different `value`. The same applies to:

- `Math.random` calls anywhere in the closure.
- `crypto.randomUUID` and `crypto.getRandomValues`.
- `performance.now` and `process.hrtime` for timing.
- (More subtly) any `compute` body that closes over a module-level mutable variable.
- (Even more subtly) any `compute` body that calls a third-party library that internally uses any of the above.

The mitigation is layered.

**Layer one — sandbox.** `causl-check enumerate` runs Node workers with `--frozen-clock` and a sandboxed `globalThis` overlay that throws on the listed APIs. TASK 3.4 ships the sandbox in `packages/core/src/sandbox.ts`. The throw is loud (`Error("non-deterministic API blocked: <name>")`) and surfaces in the worker's stdout as a `{ "error": "..." }` response, which the Rust supervisor records as `RaceClass::StructurallyInvalid { reason: format!("worker-blocked-api: {}", name) }`.

**Layer two — double-check.** A determinism oracle (`replay::ReplayDivergenceOracle` in TASK 3.5) runs each `compute` request *twice* on a 1% Bernoulli sample and asserts byte-identical `value`. Detection rate: if 1% of compute calls double-check and any disagree, fail the run with `RaceClass::ReplayDivergence { at }` and report the offending node id. The 1% rate is tunable via `--double-check-rate=N`.

**Layer three — lint.** An `eslint-plugin-causl/no-impure-compute` rule in `packages/eslint-plugin-causl` (out of scope here, tracked under EPIC-5) catches the obvious leak at lint time. The rule fires on `Date.now`, `Math.random`, `crypto.*`, `performance.*`, `process.hrtime` calls inside any function passed to `engine.derived()`.

Deterministic-on-sample is not the same as deterministic-everywhere; we are honest about that in the report. Adopter signal: if you see `ReplayDivergence`, your `compute` body has an impure dependency.

The framing is borrowed wholesale from React's strict-mode double-render — we are doing the same thing for the same reason.

**The K=10 trace memory budget — does `im::Vector` actually share that aggressively?**

`im::Vector` is an RRB tree with branching factor 32 and structural sharing on push:

- Appending one element to a vector of length N copies O(log_32 N) tree nodes; the rest is shared with the source.
- Two traces that share a 1000-step prefix and diverge on step 1001 share roughly `(1000 - log_32 1000) · sizeof(Step) ≈ 998 · sizeof(Step)` of memory, paying only 2 nodes for the divergence.
- This is the load-bearing reason `im::Vector` was named in §16.4.1 (line 1513).

The risk is the `Step` struct itself contains:

- `state_before: StateHash` — 32-byte blake3 hash, cheap.
- `state_after: Option<StateHash>` — 33 bytes (1-byte discriminator plus 32 bytes), cheap.
- `events: Vec<Event>` — `Vec` not `im::Vector`; structural sharing stops at the step boundary.
- `races: Vec<RaceClass>` — same.

Sizing:

- For a 1000-state BFS with average 3 events per step: `1000 · 3 · sizeof(Event) ≈ 240 KB`. Fine.
- For a 100,000-state BFS at the same density: 24 MB. Still fine.
- For a 1,000,000-state BFS (`visited_cap = 2^20`): 240 MB. Tight but within the 1 GB RSS budget the §16.4.1 line 1609 nominally targets.

We measure this in TASK 3.1's 1000-state benchmark and refuse to land if total RSS exceeds 100 MB on the 1000-state scenario. If the benchmark fails, the fix is `Step.events: ImVector<Event>` — a one-line swap that pays for itself the moment two traces share a step.

A second risk: `im` has a sharded-`Arc` reference-counting story that occasionally produces RSS spikes under heavy concurrent clones. We mitigate by running the BFS single-threaded:

- The worker pool is the only multi-threaded part of the enumerator.
- The worker pool does not clone traces — it only sees `ComputeRequest` / `ComputeResponse`.
- The visited-set and the frontier are owned exclusively by the BFS thread.

A third risk: `im::Vector`'s `extend` method has worse asymptotic behaviour than `push_back` (it walks the tail of the source vector). The BFS only ever does `push_back`, never `extend`; we lint against `extend` calls on `Trace.steps` via a `clippy::disallowed-methods` config in `tools/enumerator/Cargo.toml`'s `[lints.clippy]` section.

**The visited-set bounded eviction — gives up completeness, not soundness; how does the report communicate which it is?**

The LRU cap evicts the oldest visited keys when full; when an evicted key recurs we re-explore its successors:

- That gives up *completeness*: we cannot prove "no race exists in the explored subspace" if we forgot a state we already explored.
- That never gives up *soundness*: any race the oracle fires is still a real race.

The report distinguishes via three fields:

- `states_visited` — cumulative counter, monotonic, never decreases.
- `states_pruned` — count of revisits caused by LRU eviction. Normally zero; non-zero implies the cap was hit at least once.
- `bounded_out: bool` — `true` iff the cap was ever hit during the BFS.

The semantics:

- `bounded_out=false ∧ races.is_empty()` — no race exists within the explored prefix. The strongest claim the enumerator makes.
- `bounded_out=false ∧ !races.is_empty()` — race(s) found and the search completed within bound. Both completeness and soundness hold.
- `bounded_out=true ∧ races.is_empty()` — ran out of visited-set room. Downgraded claim: "no race seen within `visited_cap` distinct states". Adopter should rerun nightly under Tier 2 to widen the window.
- `bounded_out=true ∧ !races.is_empty()` — race(s) found, but the search did not complete. The found races are real (soundness); other races may exist beyond the cap.

This is the same trade `kani` and `loom` make and we copy their honesty (`tools/checker/src/check.rs` line 18 already names `kani` and `loom` as the precedent for the linter's bounds gate).

The report's SARIF rendering surfaces a `notification` with:

- `level: "warning"`.
- `text: "visited-set capacity hit; soundness downgraded to bounded-no-race; rerun under MODEL_CHECK_TIER=2 for a wider window"`.
- `properties.bounded_out: true`.
- `properties.states_visited: <count>`.
- `properties.states_pruned: <count>`.

Adopters who CI-fail on warnings get the signal; adopters who don't get a yellow tile in the GitHub PR view.

**A fifth objection we want to surface for the team: fixture-set bias.** Every property test in this EPIC seeds from fixtures we (the Causl team) write. If our fixtures fail to exercise a §9.1 row in a way that adopter code does, we will report 100% coverage on a row our oracle in fact misses. Mitigation: §16.6 milestone 5's coverage gate ratchet (`docs/checker-coverage.md`) requires *external* fixtures contributed by the three pilot adopters named in §17 commitment 8. The adopter contribution is the load-bearing part; we do not claim 90% coverage until we have eaten our own fixtures plus theirs.

## Sub-issues (TASKS)

### TASK 3.1 — Crate scaffold + State/Action/PhaseStep types
**Files:** `tools/enumerator/Cargo.toml`, `tools/enumerator/src/lib.rs`, `tools/enumerator/src/state.rs`, `tools/enumerator/src/action.rs`, `tools/enumerator/src/phase.rs`, `tools/enumerator/benches/state_clone.rs`, `tools/enumerator/tests/state_eq.rs`, `tools/enumerator/tests/state_hash.rs`, `tools/enumerator/tests/action_roundtrip.rs`, `tools/enumerator/tests/phase_step_coverage.rs`, `tools/enumerator/tests/transition_deterministic.rs`

Per §16.4.1's State, Action, PhaseStep signatures verbatim. The crate is a sibling of `tools/checker/`, depending on `causl-check` for `IrNode`, `CauslModel`, and `Bounds` so the linter's bound knobs and the enumerator's bound knobs share a name across the binary — a `--max-nodes 100` flag means the same thing in both subcommands.

New cargo dependencies the linter does not pull in:

- **`im = "15"`** — persistent collections; RRB tree under `Vector`. The structural-sharing payoff is the load-bearing reason `im::*` is in the dep set rather than `std::collections::*`.
- **`blake3 = "1.5"`** — 32-byte content hashing for the visited set. We pick `blake3` over `xxhash` and `siphash` because the visited set must resist *engineered* collisions (a pathological IR could otherwise be crafted to confuse the enumerator into pruning a real bug); §16.4.1 calls this out explicitly.
- **`crossbeam-channel = "0.5"`** — Rust ↔ Rust worker pool channels. Declared here for cargo coherence even though only TASK 3.4 uses it.
- **`lru = "0.12"`** — bounded visited-set with O(1) amortized eviction.
- **`dashmap = "6"`** — concurrent compute cache; sharded `RwLock<HashMap>` under the hood.
- **`thiserror = "1"`** — derive macro for `WorkerError`.
- **`proptest = "1.5"`** — already a dev-dep of `tools/checker` (line 36 of its Cargo.toml); promoted to a dev-dep here too.

We forbid `unsafe_code` at the crate level (matching `tools/checker/Cargo.toml` line 39) — the unsafe lives in the dependencies, and we lean on MIRI to validate it for our usage patterns.

`State` uses `im::OrdMap` not `im::HashMap` for `inputs`, `derived_cache`, `last_write_time`, `retention_buf`, `observers`, `resource_fleet`. The `Ord` keying is the load-bearing decision:

- serde `Serialize` produces lexicographically ordered JSON.
- Two states with identical content produce byte-identical JSON.
- blake3 over that JSON is the canonical `StateHash`.
- A future `HashMap` substitution would silently break determinism — the test in TASK 3.1's TDD suite catches it.

`pending_pipeline: BTreeMap<ResourceId, PendingResolution>` (also Ord-keyed) is intentionally `std::collections::BTreeMap` not `im::OrdMap` because the per-action mutation is O(log n) on both and the std `BTreeMap` has a flatter `Debug` repr that is easier to read in test failure output. `Vec<CommitRecord>` inside `commit_log` is replaced with `im::Vector<CommitRecord>` for the same structural-sharing reason as `Trace.steps`.

`Action` and `PhaseStep` are `#[non_exhaustive]` per §16.4.1 — adding `Action::HydrateMerge` or `PhaseStep::ResourceCancel` in §17 must not break enumerator consumers.

The eleven-variant `PhaseStep` coverage maps to the §5 pipeline phases:

- **A** → `StageWrites`
- **B** → `StageWritesObserved`, `DirtyWalk` (B is two reducers under one phase header)
- **C** → `Recompute { node }`
- **C.5** → `RecomputeObserved { node }`
- **D** → `DedupeNotifications`
- **E** → `AppendCommit`
- **F** → `NotifyObservers { observer_id }`
- **F.4** → `NotifyObserversObserved`
- **F.5** → `RetentionTick`
- **F.6** → `ResolveUnblocked`
- **G/H** — covered by post-commit oracle hooks rather than discrete phase steps; the §5 spec puts G/H outside the per-commit pipeline, so the eleven `PhaseStep` variants stop at F.6.

#### TDD test suite (5 tests minimum)
- **State equality is structural** — two `State` instances built independently with the same `inputs`, `derived_cache`, `now`, etc. compare equal under `PartialEq`. Test `tools/enumerator/tests/state_eq.rs::structural_equality_holds_under_independent_construction`. The test builds the state via two distinct insertion orders (forward and reverse on a `Vec<(NodeId, Value)>`) and asserts both produce equal `State` values. A failing test would mean some field's equality is order-sensitive — a bug.
- **State hash is deterministic** — same content produces the same `StateHash([u8; 32])` across 1000 hash invocations and across two separate processes. Test `tools/enumerator/tests/state_hash.rs::deterministic_across_processes` (forks via `std::process::Command` to a helper binary at `tools/enumerator/src/bin/hash_helper.rs`, asserts output equality). The 1000-loop variant is in the same file as `deterministic_within_process_1000_iterations`.
- **Action serializes to JSON with the `tag = "action"` discriminator; round-trips losslessly** — `serde_json::to_string` then `from_str` recovers `==` original for each of the seven variants. Test `tools/enumerator/tests/action_roundtrip.rs::all_seven_variants_roundtrip` (a `proptest!` over `Action`, 1000 trials). The discriminator field name (`"action"`) is asserted explicitly: a malformed JSON missing the discriminator must fail to deserialize, tested as `negative_no_discriminator_rejected`.
- **PhaseStep covers all eight phases (A through H) plus the dotted suffixes (F.4, F.5, F.6)** — exhaustive match against `PhaseStep::*` enumerates exactly the eleven variants from §16.4.1; a missing variant fails the test. Test `tools/enumerator/tests/phase_step_coverage.rs::all_phases_present`. The test uses a hand-written `match phase_step { PhaseStep::StageWrites => 0, PhaseStep::StageWritesObserved => 1, ... }` and the count `11` is asserted at the top of the test function — the compiler's `non_exhaustive`-aware exhaustiveness check would flag a missing variant as a build failure even before the runtime check, but we want both belt and suspenders.
- **Property: `transition(s, a)` is deterministic** — call it twice with the same `(s, a)`, get byte-identical `s'`. Test `tools/enumerator/tests/transition_deterministic.rs::same_input_same_output` (a `proptest!` over `(State, Action)` pairs, 1000 trials, uses `serde_json::to_string` for byte comparison). This is a stub in TASK 3.1 (the `transition` body is a placeholder returning `Err(StructurallyInvalid)` for everything) and gets its real body in TASK 3.2; the test scaffold lands here so the determinism property is enforced from day one. The proptest seed is `0xDETER_M1N1ST1C` for replayability.

#### 5 core concerns
1. **Determinism.** State, Action, PhaseStep all serde-deterministic across runs. `BTreeMap` not `HashMap` everywhere a map crosses the wire. The CI-side test that double-runs the enumerator and `diff`s the output JSON is the second-line enforcement; the `Ord` keying is the first. We also assert in the crate's `lib.rs` doctest that `serde_json::to_value(state).unwrap() == serde_json::to_value(state.clone()).unwrap()` — a tautology that would fail loudly if any field ever started using a non-Ord map.
2. **Memory bound.** State is `Clone` via `im::*` persistent collections, not deep clone. We verify with a 1000-state benchmark in `tools/enumerator/benches/state_clone.rs`: build a base `State` with 1000 `inputs`, `derived_cache`, `last_write_time` entries; clone it 1000 times, mutating one different entry on each clone; assert total RSS (read via `procfs::process::Process::myself()?.statm()` on Linux, `mach_task_basic_info` on macOS, `GetProcessMemoryInfo` on Windows) ≤ 100 MB. A `Vec`-backed `State` would be ~3 GB; the bench is the load-bearing proof that `im::*` is paying for its inclusion. The benchmark runs as part of `cargo test --release` (not `cargo bench`) so a regression fails CI rather than only failing nightly perf-tracking.
3. **`#[non_exhaustive]` discipline.** Every public enum is `#[non_exhaustive]` so adding a variant in §17 doesn't break consumers. We model after `tools/checker/src/check.rs::ViolationKind` (line 92) and `PassName` (line 115) — both already `#[non_exhaustive]` and the convention is house style. Lint `clippy::exhaustive_enums` is upgraded from `warn` to `deny` in this crate's `[lints.clippy]` so an attribute drift surfaces immediately. The same applies to `RaceClass`, `Event`, `Tier`, `WorkerError`, and `PhaseStep`.
4. **MIRI** — run `cargo +nightly miri test --package enumerator` against the `state`, `action`, `phase` modules. The `im::*` crates use `unsafe` in their RRB tree (specifically `Arc::get_mut_unchecked` paths in the persistent-vector `push_back`) — MIRI catches an aliasing bug. We bake this into `.github/workflows/checker.yml` as a non-blocking job in TASK 3.1, blocking from TASK 3.2 onward (once the enumerator has more than `Default::default()` state). The job runs nightly toolchain pinned to `nightly-2026-04-15` (the same pin the cargo lockstep workflow names) and times out at 30 minutes. Expected runtime under MIRI: ~5 minutes for `cargo miri test --package enumerator -- state action phase` on a 16-core macOS runner.
5. **No race condition** — types are pure data; the BFS/visited-set is single-threaded in this task. Worker-pool concurrency is tested in TASK 3.4. We name this concern explicitly here so a reviewer who sees "no concurrent test" knows the absence is deliberate, not an oversight. The `Send + Sync` bounds on `Oracle` (named in §16.4.1) are inherited from the data-purity here; if `State` ever stops being `Send + Sync` the type system catches it before TASK 3.4 attempts to share an `Arc<State>` between threads.

### TASK 3.2 — `transition()` + `transition_phased()` deterministic
**Files:** `tools/enumerator/src/transition.rs`, `tools/enumerator/src/transition/reducers.rs`, `tools/enumerator/tests/transition_action_deterministic.rs`, `tools/enumerator/tests/transition_phased_refines.rs`, `tools/enumerator/tests/transition_err_no_panic.rs`, `tools/enumerator/tests/atomicity.rs`, `tools/enumerator/tests/transition_property.rs`

Per §16.4.1's `transition` and `transition_phased` signatures. The §5 pipeline made explicit; deterministic per action; non-determinism lives in action selection only.

The function body is the longest in the crate. It dispatches on `Action` and threads each phase step through a sequence of `State → State` reducers that are themselves pure. We model the reducers after `tools/checker/src/check.rs::glitch_propagation_pass` (line 381) — a pure function over `&CauslModel` returning a `Vec<Violation>`. The enumerator's reducers are pure functions over `&State` returning a new `State` plus a `Vec<Event>`.

Each reducer lives in its own function in `reducers.rs`, one per `PhaseStep` variant:

- `stage_writes` — Phase A: copy the `Action::Commit` writes into a staging area in `State.inputs`, leaving the rest of the state untouched.
- `stage_writes_observed` — Phase B (first half): record the staged writes as candidates for the dirty walk.
- `dirty_walk` — Phase B (second half): compute the dirty set via reverse-dependency traversal from the staged inputs.
- `recompute` — Phase C: invoke the worker pool's `compute(node, snapshot)` for each node in the dirty set; updates `State.derived_cache`.
- `recompute_observed` — Phase C.5: record the recomputation in `State.last_write_time` for each node whose value changed.
- `dedupe_notifications` — Phase D: drop notifications whose `value == prev.value` (Object.is dedup per §5).
- `append_commit` — Phase E: append `CommitRecord { time, intent, changed_nodes }` to `State.commit_log` and increment `State.now`.
- `notify_observers` — Phase F: emit `Event::Notify { observer_id, node, value }` for each observer of each changed node.
- `notify_observers_observed` — Phase F.4: record observer ack in the trace's `Event` stream.
- `retention_tick` — Phase F.5: advance `State.retention_buf` per the configured retention policy; evict aged entries.
- `resolve_unblocked` — Phase F.6: walk `State.pending_pipeline` for resources whose dependencies are now resolved; transition them to `Loaded`.

`transition_phased` is `transition` with intermediate state recording — same dispatch, but the eleven `PhaseStep` reducers are exposed in the return tuple `(State, Vec<(PhaseStep, State)>)`. The contract is `transition_phased(s, a).map(|(s', _)| s') == transition(s, a)` for every `(s, a)`; a property test enforces it. The phased variant is what TASK 3.5's atomicity oracle uses: it runs the phases one at a time and inspects the intermediate state for invariant violations, rolling back if any phase produces an invalid state.

The `Err(RaceClass)` arm is how the function reports "this action is structurally impossible at `s`". Examples:

- `Action::Commit` while `State.pending_pipeline` is mid-Phase-D returns `Err(RaceClass::StructurallyInvalid { reason: "commit-during-commit" })`, modelling the runtime's `CommitInProgressError` (§9.1 row 1).
- `Action::Subscribe { node }` where `node` is in `State.disposed` returns `Err(RaceClass::SubscribeAfterDispose { observer_id })` (§9.1 row 11).
- `Action::ResolvePending { resource }` where the resource is not in `State.pending_pipeline` returns `Err(RaceClass::StructurallyInvalid { reason: "resolve-without-pending" })`.
- `Action::Unsubscribe { observer_id }` where `observer_id` is not in any node's `observers` set returns `Err(RaceClass::StructurallyInvalid { reason: "unsubscribe-unknown" })`.
- `Action::DispatchMsg { target }` where `target` is in `State.disposed` returns `Err(RaceClass::StructurallyInvalid { reason: "dispatch-to-disposed" })`.

The BFS treats `Err` as a leaf — no successor — but the `RaceClass` is recorded against the trace, so the report surfaces the exact race-class hit and the action that triggered it. The `reason` strings are matched in tests; they are part of the API contract.

#### TDD test suite (5 tests minimum, beyond the determinism stub from TASK 3.1)
- `transition_action_deterministic.rs::same_input_same_output_1000_proptest` — 1000-trial `proptest!` asserts `transition(&s, &a) == transition(&s, &a)` byte-for-byte across 1000 random `(s, a)`.
- `transition_phased_refines.rs::phased_final_equals_unphased` — for every `(s, a)`, `transition_phased(s, a).map(|(s_final, _)| s_final) == transition(s, a)`.
- `transition_err_no_panic.rs::structurally_invalid_returns_err_never_panics` — `proptest!` plus `std::panic::catch_unwind`; any `(s, a)` that causes a panic fails the test with the failing pair printed. The `RaceClass::StructurallyInvalid { reason }` carries a `reason: String` so the failing fixture's reason is grepable.
- `atomicity.rs::theorem_3_rollback_byte_identical` — for every `phase ∈ {B, C, C.5, D, E, F, F.4, F.5, F.6}`, build a script that triggers `Action::Commit { writes: [("a", json!(1)), ("b", json!(2))] }`, inject a `panic!` at the named phase via a feature-gated `cfg(test) cfg(feature = "panic-injection")` hook in `transition_phased`, assert that `serde_json::to_string(&state_after_catch).unwrap() == serde_json::to_string(&state_before).unwrap()`. Lamport's "stuttering equivalence" applied to rollback — the trace either takes the commit step or stutters; never partial. Nine sub-cases, one per phase boundary.
- `transition_property.rs::random_throws_preserve_invariants` — random scripts with random injected throws at random phases; assert (a) `now` is monotonic across the surviving trace, (b) `commit_log` length matches the count of successful (non-thrown) commits, (c) `derived_cache` consistency holds across rollbacks (every `derived` whose deps are unchanged across a rolled-back commit retains its pre-commit value byte-for-byte). 1000-trial `proptest!`, deterministic seed via `proptest::test_runner::Config::with_cases(1000).rng_algorithm(RngAlgorithm::ChaCha)`, replay seed printed on failure.

#### 5 core concerns
1. **Action determinism** — `transition(s, Action::Commit { intent: "x", writes: vec![("a", json!(1))] })` produces the same `s'` for the same input `s`, regardless of when called or by which thread. Tested in `transition_action_deterministic.rs` with a 1000-trial `proptest!` and a 100-process fork test (the latter to catch a hypothetical thread-local state leak via `lazy_static!` or `thread_local!`).
2. **Phase-step refinement** — `transition_phased` produces the same final `s'` as `transition`, but with the intermediate phase trace exposed. Tested via `prop_assert_eq!(transition(&s, &a).ok(), transition_phased(&s, &a).map(|(s2, _)| s2).ok())` over 1000 random `(s, a)` pairs. A failing test means a reducer is being called in two different paths that disagree.
3. **Err arm** — `transition` returns `Err(RaceClass::StructurallyInvalid { reason })` for impossible actions; never panics. We assert this with `proptest!` plus a `std::panic::catch_unwind` wrapper that fails the test if any `(s, a)` causes a panic. The `RaceClass::StructurallyInvalid` variant carries a `reason: String` so the failing fixture's reason is grepable. The set of valid `reason` strings is enumerated in `transition.rs` as a `pub(crate) const REASONS: &[&str] = &[...]` so a typo in one branch is caught at compile time by a test that asserts every `reason` returned by the function appears in the constant.
4. **Theorem 3 (atomicity)** — covered by `atomicity.rs::theorem_3_rollback_byte_identical` above. The §16.4 spec line 1330 names this as Lamport's stuttering equivalence; we make the equivalence a `serde_json::to_string` byte comparison rather than a Rust `==` because we want the test to fail visibly if any `Eq` impl ever drifts from JSON-equality.
5. **Property test** — covered by `transition_property.rs::random_throws_preserve_invariants` above. Three invariants per random script; 1000 trials per invariant. Failure mode: the seed is printed and the offending `(script, throw_phase)` is replayable from the seed alone via `cargo test transition_property -- --nocapture` plus an env var `PROPTEST_REPLAY_SEED=<seed>`.

### TASK 3.3 — BFS skeleton + visited-set bounded eviction
**Files:** `tools/enumerator/src/bfs.rs`, `tools/enumerator/src/visited.rs`, `tools/enumerator/src/report.rs`, `tools/enumerator/tests/bfs_skeleton.rs`, `tools/enumerator/tests/bounded_out.rs`, `tools/enumerator/tests/determinism_100x.rs`, `tools/enumerator/tests/race_class_attached.rs`, `tools/enumerator/tests/visited_property.rs`

Per §16.4.1's `enumerate(model, script, bound, oracles) -> EnumerationReport` signature.

The BFS is hand-rolled. The shape:

- A `VecDeque<(StateHash, Trace)>` frontier — FIFO order for BFS-classic discovery.
- An `lru::LruCache<VisitedKey, ()>` visited set with capacity `bound.visited_cap`.
- A per-iteration loop that pops a frontier entry, generates the legal `Action` set (via `Action::legal_at(s)` — a new method we add to `Action` in this task), applies `transition` for each, runs the oracle on the resulting state, and pushes successors back onto the frontier (skipping any whose `VisitedKey` is already in the LRU).
- A two-phase strategy: `K_prefix` exhaustive followed by `suffix_random` random extensions. The `K_prefix` phase enumerates every legal interleaving up to depth `K_prefix`; the suffix-random phase samples `bound.suffix_random` random extensions per frontier leaf at depth `K_prefix`, seeded by `bound.seed`.

`bound.seed` is a `u64` added to `Bound` in this task — §16.4.1 names it implicitly via "same `--seed`" in §16.6; we promote it to a struct field with a `Default::default()` of `0xCAU5L_5EED_C0FFEE`.

`VisitedKey` is `(state_hash: blake3([u8; 32]), pending_signature: [u8; 32], msg_queue_depth: u16)` — three coordinates that distinguish states the BFS must treat as distinct even when their `inputs` are equal:

- `state_hash` is blake3 over the canonical JSON of `(inputs, derived_cache, now, last_write_time, retention_buf, commit_log, observers, disposed, resource_fleet)` — everything except `pending_pipeline` and the message queue.
- `pending_signature` is blake3 over the canonical JSON of `pending_pipeline`. Two states with identical `inputs` but different `pending_pipeline` (one has an in-flight resource resolution, the other does not) are different states; we hash this separately so the visited-set does not over-prune.
- `msg_queue_depth: u16` captures pending `DispatchMsg` actions that have not yet been consumed. Same `state_hash` plus same `pending_signature` plus different `msg_queue_depth` means the BFS has not yet flushed the message queue and the state should be re-explored.

`lru::LruCache` does the bounded eviction:

- When the cache is full, the oldest-touched entry is evicted.
- When an evicted key recurs, we re-explore its successors (since we have forgotten that we explored them already).
- `EnumerationReport.bounded_out: bool` is set to `true` the first time the cache reports an eviction (via `LruCache::push` returning `Some(_)`).
- `states_pruned` counter increments every time a recurrence is detected.

The semantics are spelled out in the fourth bullet of the brutal-critical review above. `tools/enumerator/src/visited.rs::VisitedSet::push` carries that exact docstring.

#### 5 core concerns
1. **Bounded out** — `EnumerationReport.bounded_out: bool` is `true` iff the visited cap was hit at any point during the BFS; the soundness claim downgrades to "no race within the explored subspace". The report's `Report.message` field surfaces a human-readable line: "visited-set capacity 1048576 hit at step 893421; soundness downgraded to bounded-no-race". Test: `tools/enumerator/tests/bounded_out.rs::cap_hit_sets_flag` — set `visited_cap=8`, run BFS over a script that produces 50 distinct states, assert `bounded_out=true` and `states_pruned > 0`. A second test `cap_unbreached_clears_flag` runs the BFS with `visited_cap=2^20` over a 100-state script and asserts `bounded_out=false` and `states_pruned == 0`.
2. **Determinism under fixed seed** — same bound, same seed, same script → byte-identical report. We enforce this with a 100-run identity test in `tools/enumerator/tests/determinism_100x.rs::identity_holds_100_iterations`: serialize the report to JSON 100 times in a loop, assert all 100 strings are equal. Also a 10-process fork test in `determinism_100x.rs::cross_process_identity` that runs the binary in 10 subprocesses and `diff`s their stdout. This is the §16.6 closing-paragraph demand made executable: "a model checker that flakes is worse than no checker".
3. **Race-class hits attached** — every visited state's `Err` is recorded against the `Trace` and surfaced in `EnumerationReport.races`. The order of `races` is deterministic: BFS-discovery order, ties broken by `(StateHash, action_index)` lex order. Test `race_class_attached.rs::three_known_races_in_expected_order`: a fixture with three injected races at known step-indices asserts the report contains exactly those three `RaceClass` entries in the expected order. A fourth test `race_class_attached.rs::dedup_holds` asserts the same race fired in two reachable states is recorded once with both step indices, not twice with one index each.
4. **MIRI** — run miri against `lru::LruCache` operations + `im::Vector` pushes; catch any UB in the persistent-collection internals. `lru::LruCache` uses `unsafe` for its doubly-linked-list pointer manipulation; the failure mode is an aliasing violation that MIRI flags with a stack-borrow tag mismatch. We seed-reproduce flagged failures and pin the `lru` dependency at the version-pre-violation if any are found. `cargo +nightly miri test --package enumerator -- bfs visited` is the invocation; CI job `enumerator-miri-bfs` in `.github/workflows/checker.yml` runs it. Expected runtime: ~12 minutes on a 16-core macOS runner; the timeout is 30 minutes.
5. **Property test** — given a random script of length `K_prefix`, assert `states_visited ≤ branching_factor^K_prefix + suffix_random`. A 1000-trial `proptest!` in `visited_property.rs::states_bounded_by_branching` builds a random `IRNode[]` plus a random `Script`, computes the empirical branching factor by counting legal actions at the initial state, multiplies it out to the bound, and asserts the BFS halts within the bound. Failures here mean either our branching-factor estimate is wrong (re-tune the bound) or the BFS is over-exploring (a real bug). A second property `visited_property.rs::race_free_script_produces_empty_races` asserts that on a verified-race-free script, no oracle fires.

### TASK 3.4 — Worker-pool RPC (Rust master + Node workers)
**Files:** `tools/enumerator/src/worker.rs`, `tools/enumerator/src/cache.rs`, `tools/enumerator/src/supervisor.rs`, `packages/core/src/eval-rpc.ts`, `packages/core/src/sandbox.ts`, `packages/core/src/eval-rpc.test.ts`, `tools/enumerator/tests/cache_correctness.rs`, `tools/enumerator/tests/worker_crash.rs`, `tools/enumerator/tests/wire_bytes_deterministic.rs`, `tools/enumerator/tests/supervisor_property.rs`

Per §16.4.1's `WorkerPool`, `ComputeRequest`, `ComputeResponse`, `WorkerError`.

The Rust master:

- Spawns N Node workers (default `num_cpus::get()`, override via `--workers N`).
- Each worker runs `node packages/core/dist/eval-rpc.js`.
- Workers read line-delimited JSON from stdin (`{ node_id, input_snapshot }`), require the IR's `compute` body for `node_id`, run it under the sandbox, write `{ value, error }` to stdout, repeat.
- Communication is `crossbeam-channel` (Rust ↔ Rust between supervisor and worker handle threads) plus `tokio::process::ChildStdin`/`ChildStdout` (Rust ↔ Node).
- `dashmap::DashMap<[u8; 32], Value>` is the content-addressed memoisation cache, keyed on `blake3(node_id || ":" || canonical_json(input_snapshot))`.

Worker crash recovery:

- A supervisor thread `select!`s on the worker's exit channel.
- On crash it logs the PID and crash reason, drains the worker's in-flight requests back onto the master's request queue, spawns a replacement worker, and the BFS continues.
- The replacement worker has a fresh PID and a fresh `dashmap` view but shares the cache — the cache is keyed on input content, not worker identity.
- Up to `bound.worker_max_restarts` (default 5) restarts per worker before the supervisor surrenders and returns `WorkerError::Exhausted { tries }`.

The frozen-clock sandbox in `packages/core/src/sandbox.ts` overlays `globalThis` with a `Proxy` that throws `Error("non-deterministic API blocked: <name>")` on access to:

- `Date.now`, `Date.prototype.getTime` (with a frozen-time fallback if `--frozen-clock=<ms>` is set).
- `Math.random`.
- `crypto.randomUUID`, `crypto.getRandomValues`.
- `performance.now`, `performance.timeOrigin`.
- `process.hrtime`, `process.hrtime.bigint`.

The double-check determinism oracle runs each compute request twice on a 1% Bernoulli sample (seeded from `bound.seed` so the sample is reproducible) and asserts byte-identical `value`. On disagreement, fail with `RaceClass::ReplayDivergence { node_id, ... }` and surface in the report. The 1% rate is tunable via `--double-check-rate=N` (default 0.01); setting it to 1.0 doubles the worker workload but catches every impurity.

The Node worker boots with:

```ts
import { evalCompute } from '@causl/core/eval';
import { freezeGlobals } from '@causl/core/sandbox';
freezeGlobals(process.env.CAUSL_FROZEN_CLOCK ?? 0);
// hand-rolled line-delimited JSON read loop on stdin
```

The worker exits with code 0 on EOF, code 137 on `SIGKILL`, code 1 on uncaught exception (which the supervisor reads as a crash and restarts). The TypeScript test `packages/core/src/eval-rpc.test.ts` exercises the worker side-by-side with the Rust supervisor in a Vitest test — Vitest spawns the Rust binary, feeds it a fixture, asserts the response.

#### 5 core concerns
1. **Memoisation correctness** — same `(node_id, hash(input_snapshot))` → cached value; different snapshot → fresh evaluation. Cache hit rate ≥99% on the 1000-state BFS over a 100-node graph (the `tools/enumerator/benches/cache_hit_rate.rs` benchmark; a hit rate <99% fails CI). Test `tools/enumerator/tests/cache_correctness.rs::distinct_snapshots_recompute`: build a script whose 500 actions touch 50 distinct `(node, snapshot)` pairs, assert exactly 50 `WorkerPool::compute` calls cross the process boundary, the other 450 hit the `dashmap`. A second test `cache_correctness.rs::same_snapshot_caches` asserts byte-identical inputs hit the cache on the second call.
2. **Worker crash recovery** — `kill -9` a Node worker mid-BFS; the supervisor restarts it; in-flight requests are re-queued; the BFS continues to the same `EnumerationReport` it would have produced without the kill. Test `tools/enumerator/tests/worker_crash.rs::kill9_recovers_to_identical_report`: run a 100-state BFS, mid-run `nix::sys::signal::kill(worker_pid, SIGKILL)` on a random worker, capture the report; run the same BFS without the kill, capture the report; `assert_eq!(reports_a, reports_b)`. The test runs only on Unix targets; Windows uses `TerminateProcess` via `windows::Win32::System::Threading`. A second test `worker_crash.rs::exhaustion_returns_error` injects 6 crashes per worker (one over the default 5-restart cap) and asserts the supervisor returns `WorkerError::Exhausted { tries: 5 }`.
3. **JSON wire bytes deterministic** — same `(node_id, snapshot)` produces byte-identical request bytes (`BTreeMap` not `HashMap` on the snapshot side; `serde_json` with `preserve_order` *off* — the keys are already ordered by `BTreeMap`). Test `wire_bytes_deterministic.rs::request_bytes_identical_across_calls`: `assert_eq!(serde_json::to_vec(&req_a)?, serde_json::to_vec(&req_b)?)` over a 1000-trial `proptest!` of `ComputeRequest` shapes. A failing test means a `HashMap` snuck in somewhere. A second test `wire_bytes_deterministic.rs::keys_in_lex_order` parses the JSON and asserts the top-level keys appear in lexicographic order.
4. **MIRI on the Rust supervisor** — `cargo +nightly miri test --package enumerator --features supervisor`. `crossbeam-channel` uses `unsafe` for its lock-free MPMC queue; we want the bug, not the silent corruption. The MIRI run is slow (channels under MIRI are 100× slower) — we restrict to a 10-element scenario but assert it completes without UB. CI job `enumerator-miri-supervisor` in `.github/workflows/checker.yml`, 30-minute timeout.
5. **Race-condition test** — `proptest!` with random concurrent `compute` requests, random worker fail injection (random worker, random message, exit code 137); assert no request is lost (every sent request gets a response or a `WorkerError`), no response is duplicated (idempotency key on the request side rejects duplicates). 1000 trials, deterministic seed. Test `supervisor_property.rs::no_request_lost_no_response_duplicated`. The strict-stronger version using `loom` proper is parked under TASK 3.4-followup because `loom` against a process-spawning supervisor is not in `loom`'s scope — `loom` checks single-process memory orderings, not stdio plumbing.

### TASK 3.5 — Oracle trait + RaceClass enum + per-§9.1-row implementations
**Files:** `tools/enumerator/src/oracle.rs`, `tools/enumerator/src/oracles/glitch.rs`, `tools/enumerator/src/oracles/subscribe.rs`, `tools/enumerator/src/oracles/cycle.rs`, `tools/enumerator/src/oracles/replay.rs`, `tools/enumerator/src/oracles/dispose.rs`, `tools/enumerator/src/oracles/dynamic_dep.rs`, `tools/enumerator/src/oracles/observer.rs`, `tools/enumerator/src/oracles/monotonicity.rs`, `tools/enumerator/src/differential/apalache.rs`, `packages/core/src/testing/index.ts` (shared predicate exports), `tools/enumerator/tests/oracle_independence.rs`, `tools/enumerator/tests/oracle_predicate_parity.rs`, `tools/enumerator/tests/oracle_no_false_positive.rs`, `tools/enumerator/tests/oracle_cycle_detection_rate.rs`

Per §16.4.1's `Oracle` trait: `fn check(&self, s: &State, prev: Option<&State>, a: &Action) -> Vec<RaceClass>` plus `fn name(&self) -> &'static str`. One oracle per §9.1 row the MODEL layer claims (rows 5, 7, 8 partial — see §16A.1 line 2018–2021). The oracles share predicate code with `packages/core/test/properties/` via a shared `@causl/core/testing` export — `glitch-freedom.test.ts` calls `assertGlitchFree(trace)` and the Rust oracle reuses the same predicate via the worker pool's RPC channel (the predicate runs in Node, not Rust, so adopters who write custom property-test predicates get them automatically picked up by the enumerator).

The eight oracles for v1.x. Each one is one Rust file under `tools/enumerator/src/oracles/`; each one has a paired fixture under `tools/enumerator/tests/fixtures/§9.1-row-{N}/` and a paired test in the matching test file.

**`glitch::GlitchOracle`** — Theorem 2; targets §9.1 row 5.
- Algorithm: at every post-Phase-G state, for every derived `d`, request `compute(d, current_input_snapshot)` from the worker pool, assert `d.value == compute_result`. If unequal, fire `RaceClass::GlitchPropagation { node, at }`.
- Cost per state: one cache-hit lookup per derived (the snapshot is the same as the one the engine already used, so the cache is hot).
- False-positive surface: zero by construction once memoisation is correct; an FP would mean the cache is returning stale values, which would be caught by the `cache_correctness.rs` test in TASK 3.4.
- Per §16A.1 line 2018, row 5 is PROPERTY today; this oracle lifts it to MODEL for the bounded subspace.

**`subscribe::SubscribeAfterDisposeOracle`** — targets §9.1 row 11 model-layer half.
- Algorithm: on `Action::Subscribe { node, observer_id }`, check whether `node` is in `State.disposed`. If so, fire `RaceClass::SubscribeAfterDispose { observer_id }`.
- Cost per action: one O(log n) `OrdSet::contains` lookup.
- False-positive surface: zero — the static check is exact.
- Per §16A.1 line 2024, row 11 is "STATIC after `UseAfterDispose` pass below; PROPERTY today" — the model oracle catches the dynamic case the static pass misses.

**`cycle::ReachableCycleOracle`** — targets §9.1 row 8 model-layer half.
- Algorithm: Tarjan SCC on the *reachable* sub-graph (conditional deps that fire under the current input snapshot). The reachable sub-graph is computed by walking each derived's `compute(snapshot)` and recording which deps it actually read; the resulting edge set may be a subset of the declared static edges.
- Cost per state: one full Tarjan pass, O(V + E).
- False-positive surface: ~5% on conditional deps the IR's `conditional_deps` set declares but the runtime never reaches under the current snapshot. We treat the FP as a soft warning and surface it with `RaceClass::ReachableCycle { path, confidence: "low" }` when only conditional edges close the cycle.
- Per §16A.1 line 2021, row 8 is "STATIC for declared edges; PROPERTY for conditional-dep cycles. MODEL closes the gap."

**`replay::ReplayDivergenceOracle`** — targets Theorem 1 and the impure-`compute` footgun.
- Algorithm: double-runs a random 1% sample of `compute` calls (sampling deterministic from `bound.seed`) and asserts byte-identical output. On disagreement, fire `RaceClass::ReplayDivergence { at: now, node }`.
- Cost: 1% extra worker calls. With cache hit rate >99%, this is a thin slice of the run time.
- False-positive surface: zero — if the same `(node, snapshot)` produces two different values, the `compute` body is impure by definition.
- Adopter signal: see brutal-critical review section.

**`dispose::UseAfterDisposeOracle`** — targets §9.1 row 11 model-layer remainder.
- Algorithm: on every `Action::DispatchMsg { target }`, `Action::Subscribe { node }`, `Action::Commit { writes }` (for each `(node, _)` in writes), check whether the named node is in `State.disposed`. If so, fire `RaceClass::SubscribeAfterDispose { observer_id }` for `Subscribe`, or `RaceClass::StructurallyInvalid { reason: "..." }` for the others.
- Cost per action: one O(log n) lookup per target node.
- False-positive surface: zero.

**`dynamic_dep::DynamicDepDivergenceOracle`** — targets §9.1 row 7.
- Algorithm: maintain a per-derived "expected dep set" learned from the union of all observed dep reads across visited states. On a new state where the actually-read dep set is not a subset of the expected union, fire `RaceClass::DynamicDepDivergence { node }`.
- Cost per state: one `HashSet::is_subset` per derived.
- False-positive surface: ~10% on the first few visits to a derived whose dep set legitimately depends on input values; we suppress firings for the first 5 visits and only fire on visit ≥6 when the dep set diverges. The 5-visit warmup is configurable via `--dynamic-dep-warmup=N`.
- Per §16A.1 line 2020, row 7 is "PROPERTY. MODEL would prove for bounded programs."

**`observer::ObserverFiredOnUnchangedOracle`** — targets §9.1 row 5 dedup half.
- Algorithm: on `Event::Notify { observer, node, value }`, look up `prev.derived_cache[node]`. If equal under `serde_json::Value::PartialEq`, fire `RaceClass::ObserverFiredOnUnchanged { observer_id, at }`.
- Cost per event: one `OrdMap::get` plus one `Value::PartialEq`.
- False-positive surface: zero by construction.

**`monotonicity::MonotonicityOracle`** — targets Theorem 4.
- Algorithm: on every state transition, assert `s.now > prev.now` for the commit / hydrate cases. If `s.now == prev.now` after a commit, fire `RaceClass::StructurallyInvalid { reason: "non-monotonic-commit" }`.
- Cost per state: one `u64` comparison.
- False-positive surface: zero.
- Per §16A.1 line 2027, row 14 is `Monotonic` pass STATIC — this is the dynamic complement that catches the case where the static pass cleared but a hydrate sequence violates monotonicity at runtime.

The `differential::apalache` scaffold registers an alternate oracle source: an `apalache_compare(model, trace)` function that serializes `model` to TLA+, runs Apalache on it (via `cargo run --features apalache -- enumerate --differential apalache`), and compares the Apalache counter-model output against our `EnumerationReport`. Per §16.5.2, the corpus is "a curated set of 10 hand-written models in `causl-checker/corpus/apalache/*.tla`"; EPIC-7 ships those 10 models against which the comparison runs; this EPIC ships only the function and the integration-test framework that invokes it. The differential job runs in `.github/workflows/checker-diff.yml` (named in §16.5.2 last line).

#### 5 core concerns
1. **Oracle independence** — each oracle returns its own `Vec<RaceClass>`; oracles do not share state. The `Oracle` trait's `check` signature takes `&self` (read-only), and our impls use no internal `RefCell` / `Mutex`. Test `oracle_independence.rs::parallel_check_equals_serial`: an oracle whose result depends on call order would fail `assert_eq!(parallel_check(oracles, s, prev, a), serial_check(oracles, s, prev, a))`. Property test 1000 trials.
2. **Predicate sharing with §15** — the oracle for "glitch-freedom" calls into the same predicate as `packages/core/test/properties/glitch-freedom.test.ts` via a shared `@causl/core/testing` export. The shared module exports `assertGlitchFree(state: SerializableState): null | { violation: GlitchViolation }`; the property test calls it directly, the enumerator calls it via the worker pool's `evaluate-predicate` RPC verb. Test `oracle_predicate_parity.rs::glitch_oracle_matches_property_test` runs both sides on the same fixture and asserts byte-identical violation reports. A divergence is a bug in one of them — exactly the §16.5 differential-testing claim made executable.
3. **No false-positive over the bounded run** — if the script is provably race-free and within bound, no oracle fires. Tested in `oracle_no_false_positive.rs` with three hand-written race-free fixtures (a single-input-single-derived graph in `tests/fixtures/race-free/single-derived.json`, a diamond graph with stable deps in `tests/fixtures/race-free/diamond-stable.json`, an async resource fetch with deterministic resolution in `tests/fixtures/race-free/async-deterministic.json`); all three must produce `report.races.is_empty()` under all eight oracles. The bar is hard but achievable because race-free fixtures exist; if any oracle fires, we either fix the oracle or move the fixture out of "race-free".
4. **MIRI not applicable** — oracle predicates are pure (the heavy `unsafe`-using infra lives in `bfs::*` and `worker::*`, tested under MIRI in TASK 3.3 and 3.4 respectively). We name the absence here so a reviewer who notices "no `enumerator-miri-oracle` job" knows it is deliberate. The oracle modules forbid `unsafe_code` at the module level via `#![forbid(unsafe_code)]` even though the crate-level forbid would suffice — belt and suspenders.
5. **Property test** — for a random schema-3 IR with a known cycle injected, `cycle::ReachableCycleOracle` fires within `K_prefix=8` steps with >99% probability over 1000 trials. The 1% miss budget is for cycles that lie deeper than `K_prefix` and are revealed only by the suffix-random extension; under Tier 2 (`K_prefix=12`) the miss rate drops to <0.1%. Tracked in the report as a coverage delta against §9.1 — the row is "MODEL-caught" only when the empirical detection rate clears the 99% bar at Tier 1. Test `oracle_cycle_detection_rate.rs::cycle_caught_at_99_percent_tier1`.

### TASK 3.6 — `causl-check enumerate` CLI subcommand
**Files:** `tools/checker/src/main.rs` (extends with subcommand, behind `feature = "enumerator"`), `tools/enumerator/src/cli.rs`, `tools/enumerator/src/sarif.rs` (or shared with EPIC-2's `tools/checker/src/sarif.rs` if landed), `tools/enumerator/tests/cli_flags.rs`, `tools/enumerator/tests/cli_format.rs`, `tools/enumerator/tests/cli_exit_codes.rs`, `tools/enumerator/tests/cli_tier.rs`, `tools/enumerator/tests/cli_replay.rs`

Per §16A.3 CI tier hierarchy (line 2385: "PR with `[model-check]` label, push to `main` ≤15 min: Tier 1 + property suite at 10,000 trials + `causl-check race --k 10 --depth 5` (when §16.4 reopens)").

CLI surface:

- Reads IR from `--ir <path>` (default `./causl-model.json`).
- Reads script from `--script <path>` (default `./script.causl.ts` compiled via the `@causl/core` exporter).
- Reads bounds from `--bound K_prefix=N --bound depth=N --bound visited_cap=N --bound suffix_random=N`.
- Reads tier from `--tier=cycles-only|async-and-msg|full` (matches `Tier` enum in §16.4.1 line 1593).
- Reads seed from `--seed=0xHHHH` (hex, 64-bit).
- Reads worker count from `--workers=N` (default `num_cpus::get()`).
- Reads format from `--format=sarif|json|human` (default `sarif`).
- Reads double-check rate from `--double-check-rate=0.0..1.0` (default `0.01`).
- Reads frozen clock from `--frozen-clock=<ms>` (default `0`).
- Runs `enumerate(model, script, bound, all_oracles())`.
- Outputs SARIF (default) or JSON or human.

The subcommand is gated `#[cfg(feature = "enumerator")]` in `tools/checker/src/main.rs`:

- A `causl-check` build without the feature is byte-identical to the v1 release.
- A v1 adopter who upgrades to a v1.x binary without enabling `--features enumerator` sees no change in the CLI surface.
- Once the §16.0 trigger fires and the v1.x release is minted under `cargo build --release --features enumerator`, the subcommand goes live.

The subcommand is `causl-check enumerate` (matching §16.4 line 1303 and §16.6 milestone-1's `causl-check race`). The flags are clap-derive-driven on a `EnumerateArgs` struct; the help text is generated from doc comments and reviewed in PR.

The SARIF rule namespace is `causl/enumerator/<oracle-name>`:

- `causl/enumerator/glitch` for `glitch::GlitchOracle`.
- `causl/enumerator/subscribe` for `subscribe::SubscribeAfterDisposeOracle`.
- `causl/enumerator/cycle` for `cycle::ReachableCycleOracle`.
- `causl/enumerator/replay` for `replay::ReplayDivergenceOracle`.
- `causl/enumerator/dispose` for `dispose::UseAfterDisposeOracle`.
- `causl/enumerator/dynamic-dep` for `dynamic_dep::DynamicDepDivergenceOracle`.
- `causl/enumerator/observer` for `observer::ObserverFiredOnUnchangedOracle`.
- `causl/enumerator/monotonicity` for `monotonicity::MonotonicityOracle`.

Each rule has a `helpUri` pointing at the §9.1 row in `docs/race-catalogue.md`.

#### 5 core concerns
1. **CLI parses every flag** — `--bound K_prefix=8 --bound depth=256 --bound visited_cap=1048576 --tier=async-and-msg --seed=0x9a3f --workers=8 --format=sarif --double-check-rate=0.01 --frozen-clock=0`. Tested with `assert_cmd::Command::new("causl-check").args(["enumerate", "--bound", "K_prefix=8", ...]).assert().success()` over the full flag matrix in `cli_flags.rs::full_matrix_parses`. Negative tests in `cli_flags.rs::malformed_bound_rejects`: e.g., `--bound K_prefix=NOT_A_NUMBER` exits with code 64 (CLI usage error per BSD `sysexits.h`) and a parse-error message on stderr.
2. **Output format** — SARIF by default (matching the four §16A.2 lint passes' SARIF discipline); `--format json` for the `EnumerationReport` shape per §16.4.1; `--format=human` for an indented text rendering (used by adopters running locally). Test `cli_format.rs::sarif_validates_against_schema` parses the output with `sarif-rs` and asserts the SARIF schema validates. `cli_format.rs::json_round_trips` asserts `serde_json::from_str::<EnumerationReport>(&output)?` succeeds. `cli_format.rs::human_includes_oracle_names` asserts every fired oracle's name appears in the human-format output.
3. **Exit code** — 0 if no race fired, 1 if a race fired, 2 if `bounded_out=true` (treated as soft-warning, `--strict-bounded` upgrades it to exit 1, `--lenient-bounded` downgrades it to exit 0). The default of 2 matches `kani`'s exit semantics: bounded-warnings should be visible in CI without failing the build by default. Tested in `cli_exit_codes.rs::race_free_exits_0`, `cli_exit_codes.rs::known_race_exits_1`, `cli_exit_codes.rs::capped_out_exits_2_default`, `cli_exit_codes.rs::strict_bounded_exits_1`, `cli_exit_codes.rs::lenient_bounded_exits_0`.
4. **`MODEL_CHECK_TIER` env override** — Tier 1 vs 2 vs 3 picks bound presets per §16A.3. `MODEL_CHECK_TIER=1` (CI default on PR) sets `K_prefix=8, suffix_random=2000, depth=K·12, visited_cap=2^20`. `MODEL_CHECK_TIER=2` (nightly) sets `K_prefix=12, suffix_random=20000, depth=K·12, visited_cap=2^22`. `MODEL_CHECK_TIER=3` (weekly) sets `K_prefix=16, suffix_random=200000, depth=K·15, visited_cap=2^24`. Explicit `--bound` flags override the env preset. Tested with `cli_tier.rs::env_picks_preset_unless_overridden`: set `MODEL_CHECK_TIER=2`, run with no `--bound`, assert `K_prefix=12` in the report; then set `--bound K_prefix=8`, assert `K_prefix=8`.
5. **Replay** — `--replay --seed=0x9a3f` reproduces a previous run exactly. The seed seeds every RNG in the pipeline: BFS action ordering, suffix-random sampling, double-check sample selection, `proptest`-style shrink decisions. A 100-process fork test in `cli_replay.rs::same_seed_produces_byte_identical_report` runs the binary 100 times with the same seed and asserts identical SARIF output. Replay is the load-bearing reason the §16.6 closing paragraph holds: "a flake in the detector fails the build". A second test `cli_replay.rs::different_seed_produces_different_report` asserts that changing the seed by one bit changes the output (probabilistic — passes with overwhelming probability; rerun on flake-flag).

## Acceptance gate

**Status:** satisfied. The §16.6 milestone-1 acceptance gate is realized as `tools/enumerator/tests/issue_589_acceptance_gate.rs` (the test layout diverged from the §16.6 path during PR-4); the equivalent milestone-2 coverage lives across `enumerate.rs`, `enumerate_with_script.rs`, `pending_resolution.rs`, and the transition-phased test family. The Apalache differential corpus shipped under EPIC-7 ([#472](https://github.com/iasbuilt/causl/issues/472), [#489](https://github.com/iasbuilt/causl/issues/489)) and is live at `tools/enumerator/corpus/apalache/` (10 hand-written `.tla` models) and `tools/enumerator/corpus/rust/` (paired scenarios). The original gate prose follows for design context.

`tools/enumerator/tests/acceptance/§16.6-milestone-1.rs` — runs the BFS over a known-cycle fixture (`tests/fixtures/conditional-cycle-row-8.json`); asserts `cycle::ReachableCycleOracle` fires with `RaceClass::ReachableCycle { path }`; the `path` is the minimal cycle (Tarjan's SCC output, sorted lex, then trimmed to the first edge that closes the loop). §16.6's milestone 1 is "BFS skeleton + cycle row coverage", and rows 1, 4, 8 of §9.1 are caught on the known-race fixture; rows 5, 7 are caught on the property-suite scaffolding (the `differential::apalache` predicate-sharing path from TASK 3.5). The test refuses to compile if any of the five §9.1 rows the milestone names lack a fixture in `tests/fixtures/§9.1-row-{1,4,5,7,8}/`.

A second acceptance gate covers milestone 2 (async resolution + Msg trajectory): `tools/enumerator/tests/acceptance/§16.6-milestone-2.rs` exercises `Action::ResolvePending`, `Action::BeginFetch`, `Action::DispatchMsg` against an `@causl/sync` resource fixture and asserts §9.1 rows 2 and 6 oracles fire correctly. (Row 6 is RUNTIME-ONLY per §16A.1 line 2019, so the milestone-2 acceptance does not assert detection of row 6 — it asserts the *absence* of false positives on a row-6-equivalent runtime-only scenario.)

The acceptance gates are the §16.6 milestone entry conditions for milestones 3, 4, 5. A green `§16.6-milestone-1.rs` plus `§16.6-milestone-2.rs` is the merge gate for opening EPIC-4 (hypothesis grammar) and EPIC-7 (Apalache corpus). Milestone 3 (the hypothesis evaluator) is EPIC-4's acceptance; milestone 4 (the shrinker) is EPIC-4's acceptance; milestone 5 (the coverage-gate ratchet) is the cross-EPIC docs ratchet that turns `docs/checker-coverage.md`'s coverage column from yellow to green.

## Out of scope
- **Hypothesis API (EPIC-4).** §16.5 grammar (`always | eventually | until | afterCommit | during | never | implies`) plus the counterexample shrinker (§16.5.2 three-axis: fewest actions, fewest nodes, earliest step). The enumerator emits the trace; EPIC-4 emits the predicate evaluator and shrinker on top of it. The enumerator's `EnumerationReport.traces_recorded` is the surface EPIC-4 reads.
- **Apalache corpus (EPIC-7).** 10 hand-written TLA+ models the differential-testing scaffold runs against. This EPIC ships the scaffold; EPIC-7 ships the corpus and turns the scaffold's `#[cfg(feature = "apalache")]` from a no-op into a live cross-check. The mapping file `causl-checker/corpus/mapping.toml` is EPIC-7's; the runner that consumes it is this EPIC's.
- **Schema 3 IR (EPIC-1).** Already a hard dependency. The enumerator's `transition` reads `model.events`, `model.scopes`, `model.nodes[i].graph_id` — none of those exist in schema 2. EPIC-1 must land first; if EPIC-1 slips, EPIC-3 slips with it.
- **§9.1 rows 6, 9, 10.** Runtime-only by §16A.1's classification — network-dependent (row 6) or multi-user (rows 9, 10). The enumerator does not target them and the report's coverage column does not claim them. Per §16A.1 line 2032, `RUNTIME-ONLY = 4 (rows 6, 9, 10, plus row 3 until the four-state union ships)`.
- **Coverage-gate ratchet milestone 5.** §16.6 milestone 5 ("docs/checker-coverage.md reports ≥90% across STATIC + PROPERTY + MODEL") is a documentation-and-fixtures task that opens after milestones 1–4 are green. Tracked under EPIC-3-followup-coverage-ratchet. The §17 commitment 8 ratchet pin against the coverage column moves only when this follow-up lands.
- **`@causl/sync` resource integration deeper than `BeginFetch`/`ResolvePending`.** The §16.6 milestone 2 work that adds `Action::ResourceTransition { rid, event ∈ {startLoad, resolve, fail, markStale} }` and the corresponding `ResourceState` sub-statechart is a follow-up EPIC. Today the enumerator handles `BeginFetch` and `ResolvePending` only; the four-way transition lattice opens with milestone 2 inside this EPIC, but the deeper `@causl/sync` integration (cancellation, retry, exponential backoff modelling) is EPIC-6.
- **eslint-plugin-causl rules** — the `no-impure-compute` rule named in the brutal-critical review's "Worker-pool RPC" objection is EPIC-5 (lint plugin). This EPIC does not ship lint rules.
- **Per-platform binary distribution** — §16.7 names `optionalDependencies` per-platform packages (`@causl/checker-{linux-x64, ...}`). Adding `--features enumerator` to those release builds is a release-checker.yml change tracked under EPIC-3-followup-release. This EPIC ships the source; the release lockstep is a separate PR.
- **Plumbing for adopter-supplied custom oracles.** A future `Oracle` impl an adopter writes (a non-§9.1-row predicate) is not covered. The trait is public but the registration mechanism (a discovery convention, a `register_oracle!` macro, a config-file-driven loader) is not designed in this EPIC. We name this gap so an adopter who reads "Oracle is `pub trait`" does not assume custom oracles are first-class.

## Cross-task dependency graph

The six tasks have explicit ordering. A naive read of the section order would suggest 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 in strict serial; the real graph is partially parallel, and we name it to keep the EPIC mergeable in pieces:

- **3.1** has no upstream dependency inside this EPIC (only EPIC-1's schema-3 IR types).
- **3.2** depends on 3.1's `State`, `Action`, `PhaseStep`. No other dep.
- **3.3** depends on 3.2's `transition`. The `oracles: &[Box<dyn Oracle>]` parameter is taken as an empty slice for the first 3.3 PR; oracle wiring lands in 3.5 and the BFS picks them up at the call site.
- **3.4** depends on 3.1's `State` and 3.2's `transition` (the worker's `compute` is invoked from inside `transition::reducers::recompute`). The Node worker's `eval-rpc.ts` is independent of 3.3 — 3.4 can land in parallel with 3.3 once 3.2 is green.
- **3.5** depends on 3.1, 3.2, and the predicate-sharing surface in `packages/core/src/testing/index.ts`. Independent of 3.3 and 3.4 for the pure-Rust oracles; depends on 3.4 for `replay::ReplayDivergenceOracle` (which uses the worker pool's double-check rate).
- **3.6** depends on all of 3.1–3.5. It is the integration task; it lands last.

Parallel-friendly partition (suggested PR sequencing):
1. PR-1: TASK 3.1 (scaffold + types). Lands first.
2. PR-2 and PR-3 in parallel after PR-1 merges: TASK 3.2 (transition) and TASK 3.5 partial (pure-Rust oracles only — `glitch`, `subscribe`, `cycle`, `dispose`, `dynamic_dep`, `observer`, `monotonicity`).
3. PR-4 after PR-2 merges: TASK 3.3 (BFS).
4. PR-5 after PR-2 merges: TASK 3.4 (worker pool). Can land in parallel with PR-4.
5. PR-6 after PR-4 and PR-5 merge: TASK 3.5 remainder (`replay::ReplayDivergenceOracle`, `differential::apalache`).
6. PR-7 after PR-6 merges: TASK 3.6 (CLI). Lands last.

Estimated PR count: 7. Estimated calendar weeks at one PR per week with parallelism: 6 weeks. The §16.6 milestone-1 acceptance fires after PR-4; milestone-2 acceptance fires after PR-7. **Current state:** the actual PR sequence landed in May 2026 via TASK-level PRs #530–#535; the seven-PR estimate above is historical.

## Milestone schedule

Aligning the §16.6 5-milestone TDD plan with the 6-task PR sequence:

| §16.6 Milestone | Acceptance condition | Tasks satisfying it | EPIC-3 PR |
| --- | --- | --- | --- |
| 1. BFS skeleton + cycle row | `tests/acceptance/§16.6-milestone-1.rs` green; rows 1, 4, 8 caught on fixtures | 3.1, 3.2, 3.3, 3.5-partial, 3.6-partial | PR-4 + a partial of PR-7 |
| 2. Async resolution + Msg trajectory | `tests/acceptance/§16.6-milestone-2.rs` green; rows 2, 6 (false-positive-free for 6) | 3.4, 3.5-full, 3.6-full | PR-7 |
| 3. Hypothesis evaluator | EPIC-4 acceptance | EPIC-4 | EPIC-4 |
| 4. Counterexample shrinker | EPIC-4 acceptance | EPIC-4 | EPIC-4 |
| 5. Coverage-gate ratchet | `docs/checker-coverage.md` reports ≥90% | EPIC-3-followup-coverage-ratchet, with adopter fixture contributions | follow-up |

## CI integration (`.github/workflows/`)

We add four new CI jobs in `.github/workflows/checker.yml`, all gated on `--features enumerator`:

- **`enumerator-test`** — `cargo test --package enumerator --features enumerator`. Required on every PR. Runtime ~3 min on a 16-core macOS runner; ~5 min on Linux CI.
- **`enumerator-miri-types`** — `cargo +nightly miri test --package enumerator -- state action phase`. Required on every PR. Runtime ~5 min.
- **`enumerator-miri-bfs`** — `cargo +nightly miri test --package enumerator -- bfs visited`. Required on every PR after PR-4. Runtime ~12 min.
- **`enumerator-miri-supervisor`** — `cargo +nightly miri test --package enumerator --features supervisor`. Required on every PR after PR-5. Runtime ~20 min on a constrained (10-element) scenario.

A fifth job, **`enumerator-acceptance-§16.6-m1`**, runs the milestone-1 acceptance fixture after PR-4 lands and is the merge gate for PR-7.

A sixth job, **`apalache-diff`**, lives in a separate workflow `.github/workflows/checker-diff.yml` (named verbatim in §16.5.2 last paragraph) and runs nightly. It is non-blocking for PRs but blocking for releases (`checker-v*` tags must pass `apalache-diff` before the release matrix runs). The job depends on EPIC-7's corpus; until EPIC-7 lands, the workflow is green-by-default (no models to diff).

A seventh job, **`enumerator-cache-hit-rate`**, runs the `tools/enumerator/benches/cache_hit_rate.rs` benchmark on a fixture and asserts ≥99% hit rate. Non-blocking on PR; blocking on `main` push.

## Fixture catalogue

The fixtures live under `tools/enumerator/tests/fixtures/`. Naming convention: `§9.1-row-{N}/{slug}.json` for race-class fixtures; `race-free/{slug}.json` for false-positive guards. Each fixture is a serialized `CauslModel` (schema 3) plus an optional `script.json` (a serialized `Script`).

Required for milestone 1:
- `tests/fixtures/§9.1-row-1/concurrent-engine-mutation.json` — two commits initiated from inside a subscribe callback. Asserts `RaceClass::StructurallyInvalid { reason: "commit-during-commit" }`.
- `tests/fixtures/§9.1-row-4/mid-staged-snapshot.json` — a read against a node mid-Phase-D. Asserts the `transition` returns `Err(RaceClass::StructurallyInvalid { reason: "read-staged" })`.
- `tests/fixtures/§9.1-row-5/diamond-glitch.json` — a four-node diamond (`a → b, a → c, b → d, c → d`) with a single commit changing `a`. Asserts `glitch::GlitchOracle` does *not* fire on this race-free fixture.
- `tests/fixtures/§9.1-row-7/dynamic-dep-leak.json` — a derived whose `compute` reads a different dep on alternate snapshots; asserts `dynamic_dep::DynamicDepDivergenceOracle` fires.
- `tests/fixtures/§9.1-row-8/conditional-cycle.json` — a derived with a conditional dep that closes a cycle only when an input has a specific value. Asserts `cycle::ReachableCycleOracle` fires with `RaceClass::ReachableCycle { path }`.

Required for milestone 2:
- `tests/fixtures/§9.1-row-2/read-not-loaded.json` — an `Action::ResolvePending` ordering puzzle where one resource resolves before another it depends on. Asserts `RaceClass::PendingResolveRace { resource_a, resource_b }` fires.
- `tests/fixtures/§9.1-row-6-runtime-only/stale-async.json` — a runtime-only scenario; asserts the enumerator does *not* false-positive a `RaceClass::ReplayDivergence` on a legitimate stale-async pattern that adopter code resolves correctly via `originGraphTime`.

False-positive guards (race-free):
- `tests/fixtures/race-free/single-derived.json` — single input, single derived, single commit.
- `tests/fixtures/race-free/diamond-stable.json` — diamond where both intermediates change in the same commit, no glitch possible.
- `tests/fixtures/race-free/async-deterministic.json` — single resource, deterministic resolution, no other action.

The fixture set is the load-bearing surface for the milestone acceptance gates; we do not claim a row caught until its fixture is in this catalogue.

## Telemetry and reporting

The enumerator emits four telemetry signals during a run, all surfaced in `EnumerationReport`:

- **`states_visited: u64`** — cumulative count of distinct `VisitedKey` values pushed onto the visited set.
- **`states_pruned: u64`** — count of revisits caused by LRU eviction. Non-zero implies `bounded_out=true`.
- **`worker_calls: u64`** — total `WorkerPool::compute` invocations that crossed the process boundary (cache misses).
- **`cache_hits: u64`** — total cache hits inside `WorkerPool::compute`. The hit rate is `cache_hits / (cache_hits + worker_calls)`.

The SARIF rendering surfaces three of these in the run-level `properties` bag (`states_visited`, `states_pruned`, `bounded_out`); the JSON rendering includes all four.

A nightly job (`enumerator-telemetry`, in `.github/workflows/checker-nightly.yml`) runs the enumerator over the entire `tools/enumerator/tests/fixtures/` corpus and uploads the four metrics as a CSV artifact. This is the input to the §16.6 milestone-5 coverage ratchet's "is the enumerator getting better?" line.

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation owner |
| --- | --- | --- | --- | --- |
| R1 | Schema-3 IR (EPIC-1) slips beyond the §16.0 trigger | Medium | Blocks EPIC-3 entirely | EPIC-1 lead |
| R2 | `im::*` MIRI failures pin us to an old version | Low | Schedule slip ~1 week | TASK 3.1 owner |
| R3 | Worker-pool crash recovery proves flaky on Windows | Medium | Windows CI fails on PR-5 | TASK 3.4 owner |
| R4 | Branching factor in the wild exceeds 30 routinely | Medium | `bounded_out=true` becomes the common case; coverage claim weakens | docs follow-up |
| R5 | Apalache differential corpus disagrees on a property | Low | Blocks release until reconciled | EPIC-7 |
| R6 | `compute` impurity rate >1% in adopter code | Medium | `ReplayDivergenceOracle` floods the report | EPIC-5 (eslint plugin) |
| R7 | LRU cache memory blow-up on Linux runners | Low | CI OOM | TASK 3.3 owner |
| R8 | Predicate-sharing surface (`@causl/core/testing`) drifts | Medium | TASK 3.5 oracles diverge from §15 properties | shared owner with §15 lead |

R1 is the only schedule-blocker; the rest are work-around-able with a named owner. The mitigations are written into the task body where applicable; the register is the at-a-glance summary the engineering manager reviews weekly.

## Open questions for the team

These are questions the §16.4 narrative does not answer and we want explicit team agreement on before PR-1 lands:

- **Q1.** Do we ship `differential::apalache` behind `--features apalache` or always-on? `--features apalache` keeps cargo build times down for the common case; always-on keeps the differential job from silently disappearing when the feature flag drifts. Recommendation: behind `--features apalache`, with the release builds always enabling it.
- **Q2.** Does `bounded_out=true` exit 2 by default, or exit 1? §16.4 narrative is silent. Recommendation: exit 2 (kani precedent), with `--strict-bounded` and `--lenient-bounded` overrides. The §16A.3 PR-tier expectation of "≤5 min, no flake" suggests exit-2-default is correct: a bounded run that hit the cap is informational, not a failure.
- **Q3.** Should the worker pool's frozen-clock value be configurable per-script or fixed across the run? Per-script lets adopters with `Date.now`-as-real-input encode the leak as an explicit input; fixed-across-run makes determinism trivial. Recommendation: fixed-across-run (`--frozen-clock=<ms>` global flag) for v1.x; revisit if adopters demand per-script.
- **Q4.** Do we ship `monotonicity::MonotonicityOracle` separately, or fold it into `replay::ReplayDivergenceOracle`? They overlap on Theorem 1+4. Recommendation: ship separately; the cost is one `Box<dyn Oracle>` allocation, the benefit is a clean per-row attribution in the SARIF output.
- **Q5.** Should the JSON wire format between Rust and Node be MessagePack instead, for parse-overhead savings? Recommendation: no for v1.x — JSON is debuggable, and the cache hit rate of >99% means parse overhead is a thin slice of the run time. Revisit if benchmarks show JSON parsing is the bottleneck.

## TDD test rollup

Total test count across the EPIC, per task:

| Task | Unit tests | Property tests (proptest) | Acceptance | MIRI invocations |
| --- | --- | --- | --- | --- |
| 3.1 | 12 | 3 (1000 trials each) | — | 1 (state/action/phase modules) |
| 3.2 | 18 (incl. 9 atomicity sub-cases) | 3 | — | 1 (transition module) |
| 3.3 | 14 | 4 | `§16.6-milestone-1.rs` | 1 (bfs/visited modules) |
| 3.4 | 16 | 3 | — | 1 (supervisor with `--features supervisor`) |
| 3.5 | 24 (3 per oracle × 8) | 8 (one per oracle) | — | — (oracles are pure) |
| 3.6 | 20 (CLI flag matrix) | 1 (replay) | `§16.6-milestone-2.rs` | — |
| **Total** | **104** | **22** | **2** | **4** |

The 104 unit tests + 22 proptests is the rough TDD floor. Each of the 22 proptests runs at 1000 trials by default; the suite-level CI run executes 22,000 property-test trials per `cargo test --release`.

Test runtime budget on a 16-core macOS runner:

- `cargo test --package enumerator` (no features): ~3 min.
- `cargo test --package enumerator --features enumerator`: ~5 min.
- `cargo test --package enumerator --features enumerator,supervisor,apalache`: ~8 min (includes worker-pool crash recovery and Apalache scaffold tests).
- `cargo +nightly miri test --package enumerator`: ~25 min total across all four MIRI invocations, runs nightly.
- `cargo bench --package enumerator`: ~12 min, runs nightly.

## Coverage matrix — §9.1 rows × layers

For every §9.1 row this EPIC claims to cover, what layer catches it and what fixture proves it:

| Row | Title (abridged) | Static pass | Property | Model oracle (this EPIC) | Fixture |
| --- | --- | --- | --- | --- | --- |
| 1 | Concurrent engine mutations | `CommitFromSubscribe` (EPIC-2) | — | `transition` `Err(StructurallyInvalid)` | `§9.1-row-1/concurrent-engine-mutation.json` |
| 2 | Read not-yet-loaded resource | `ResourceState<T>` DU | — | `transition` `Err(PendingResolveRace)` | `§9.1-row-2/read-not-loaded.json` |
| 4 | Read mid-staged snapshot | API design | — | `transition` `Err(StructurallyInvalid { reason: "read-staged" })` | `§9.1-row-4/mid-staged-snapshot.json` |
| 5 | Diamond glitches | `GlitchPropagation` (structural) | `glitch-freedom.test.ts` | `glitch::GlitchOracle` + `observer::ObserverFiredOnUnchangedOracle` | `§9.1-row-5/diamond-glitch.json` |
| 7 | Dynamic-dep cleanup | — | `dynamic-deps.test.ts` | `dynamic_dep::DynamicDepDivergenceOracle` | `§9.1-row-7/dynamic-dep-leak.json` |
| 8 | Cycle in derivation graph | `Cycle` (declared) | `propertyDag` | `cycle::ReachableCycleOracle` (conditional) | `§9.1-row-8/conditional-cycle.json` |
| 11 | Use-after-dispose | `UseAfterDispose` (EPIC-2) | `disposed-tombstone-bound.test.ts` | `dispose::UseAfterDisposeOracle` + `subscribe::SubscribeAfterDisposeOracle` | shared fixture |
| 14 | Non-monotonic GraphTime | `Monotonic` | — | `monotonicity::MonotonicityOracle` | shared fixture |

Row 5 is the reference case for the §16.4 ratchet: STATIC catches the structural smell (one IR-level case), PROPERTY catches the runtime case at 1000 trials, MODEL closes the residual gap on the bounded subspace. The three layers compose; we do not double-count.

## Apalache differential scaffold (in-EPIC)

§16.5.2 names the Apalache differential as the team's standing claim that the enumerator agrees with an independent oracle on the curated 10-model corpus. EPIC-7 ships the corpus; this EPIC ships the scaffold. The scaffold has six pieces:

- **`tools/enumerator/src/differential/apalache.rs`** — the Rust-side runner. Spawns Apalache as a subprocess (`apalache-mc check --inv=Inv MyModel.tla`), parses its stdout for the verdict, normalises the witness state into our `EnumerationReport.traces_recorded[0]` shape via the mapping file.
- **`causl-checker/corpus/mapping.toml`** — schema for the cross-engine identifier mapping. The file is empty in this EPIC; EPIC-7 fills it. The schema validates in CI via a `toml` parse-and-typecheck step.
- **`tools/enumerator/src/differential/verdict.rs`** — the three-valued verdict type `Verdict::Pass | Verdict::Fail { witness } | Verdict::BoundExceeded`. Both engines produce verdicts of this shape.
- **`tools/enumerator/src/differential/diff.rs`** — the divergence detector. Joins on `(model, property)`, emits a divergence row when the two engines disagree.
- **`.github/workflows/checker-diff.yml`** — the CI workflow. Nightly run; uploads `apalache-diff-report.md` on every divergence.
- **`tools/enumerator/tests/apalache_scaffold.rs`** — a smoke test that runs the scaffold against a no-op model (no properties, both engines trivially pass) and asserts the runner exits 0. The smoke test passes today (no corpus); EPIC-7 turns the smoke test into a real corpus run.

Divergence categories the scaffold detects (per §16.5.2 last bullet):

- **Pass-vs-fail** — one engine returns `Pass` and the other returns `Fail`. Hard divergence; opens an issue immediately.
- **Witness-non-isomorphic** — both engines return `Fail` but the witness states are not isomorphic up to the mapping. Soft divergence; opens an issue with priority-medium.
- **Bound-exceeded-mismatch** — one engine returns `BoundExceeded` and the other returns `Pass`. Soft divergence; opens an issue with priority-low (the Rust enumerator's bound is too tight for a property Apalache can prove).

The runner's exit code:

- `0` — all models agree on all properties.
- `1` — at least one hard divergence.
- `2` — at least one soft divergence; no hard.

The CI job is gated `--features apalache`; without the feature, the differential scaffold compiles to a no-op stub that always returns `Verdict::Pass`. This keeps the common-case build fast (Apalache adds ~30 MB of dependencies including a TLA+ parser).

## Spec citations index

Every spec line this EPIC binds to, in spec order:

- **§16.0 (line 956)** — the deferral story; the trigger for reopening.
- **§16.0 (line 963)** — Mark Miller's review on bounded vs static.
- **§16.4 (line 1303)** — "deferred PLANNED" framing.
- **§16.4 (line 1305)** — Norvig tuple `⟨S, A, T, s₀, goal⟩`.
- **§16.4 (line 1311)** — branching factor 5–20.
- **§16.4 (line 1313)** — megastep abstraction.
- **§16.4 (line 1316)** — stratified bound.
- **§16.4 (line 1318)** — tier table.
- **§16.4 (line 1325)** — Beck oracle framing.
- **§16.4 (line 1330)** — Lamport stuttering equivalence.
- **§16.4 (line 1335)** — Byron schema-driven evaluation.
- **§16.4 (line 1337)** — Metz stateful trace.
- **§16.4.1 (line 1360)** — Rust type signatures preamble.
- **§16.4.1 (line 1386)** — `State` struct.
- **§16.4.1 (line 1437)** — `Action` enum.
- **§16.4.1 (line 1455)** — `PhaseStep` enum.
- **§16.4.1 (line 1473)** — `transition` signature.
- **§16.4.1 (line 1485)** — `Step` and `Trace`.
- **§16.4.1 (line 1521)** — `RaceClass` enum.
- **§16.4.1 (line 1532)** — `Oracle` trait.
- **§16.4.1 (line 1557)** — `enumerate()` function.
- **§16.4.1 (line 1565)** — `VisitedKey` and `VisitedSet`.
- **§16.4.1 (line 1583)** — `Bound` struct.
- **§16.4.1 (line 1620)** — `WorkerPool` and RPC types.
- **§16.5.2 (line 1959)** — Apalache tiny-corpus oracle.
- **§16.5.2 (line 1963)** — `apalache-diff` workflow.
- **§16.6 (line 1984)** — five-milestone TDD plan.
- **§16.6 (line 1992)** — flake-fails-build clause.
- **§16A.1 (line 2010)** — layer classification.
- **§16A.1 (line 2018–2032)** — per-row layer assignment.
- **§16A.3 (line 2385)** — CI tier table.
- **§17 commitment 8** — pre-runtime detection ratchet (the §16.0 trigger).
- **§17 commitment 11** — bounded-enumerator fixtures-on-the-shelf (today's discipline; this EPIC promotes it to MECHANICAL).

## Glossary

Terms used in this EPIC and where they are defined in the spec:

- **§3 theorems** — Determinism (T1), Glitch-Freedom (T2), Atomicity (T3), Monotonicity (T4). Defined in SPEC.md §3.
- **§5 pipeline** — The eight-phase commit pipeline (A through H). Defined in SPEC.md §5.
- **§9.1 row** — One of seventeen named races in the catalogue at SPEC.md §9.1; classified into STATIC / PROPERTY / MODEL / RUNTIME-ONLY by §16A.1.
- **§16.0 trigger** — The §9.1 ratchet hitting 90% pre-runtime detection coverage; the named condition under which §16.4 reopens.
- **`MODEL_CHECK_TIER`** — Environment variable selecting the bound preset (1 / 2 / 3); defined in §16A.3.
- **Stratified bound** — `K_prefix` exhaustive plus `suffix_random` random extensions plus `depth` phase cap; per §16.4 line 1316.
- **Stuttering equivalence** — Lamport's notion of two traces being equal up to insertion of stuttering steps; we apply it to commit rollback per §16.4 line 1330.
- **Megastep** — Treating a whole commit as a single transition step; the abstraction that makes the branching factor enumerable (§16.4 line 1313).
- **Schema 3** — The IR wire format with per-node `graph_id`, `events: IREvent[]`, and `scopes: IRScope[]`. Specified in SPEC.md §16.2.1.
- **Predicate-sharing surface** — `packages/core/src/testing/index.ts` exports the predicates the §15 property suite and the §16.4 oracles both consume.
- **Visited-set bounded eviction** — LRU-cap semantics on `VisitedSet`; gives up completeness, never soundness; reported via `bounded_out: bool`.
