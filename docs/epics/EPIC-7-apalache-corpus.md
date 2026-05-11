# EPIC: Apalache differential corpus

**Spec anchors:** §16.5.1 (closing section — "Apalache as the tiny-corpus oracle"), §9.1 (race-class catalogue, 17 rows).

**Risk:** LOW — corpus is read-only data; the differential test runs in a separate CI job (`four-way-classifier` in `.github/workflows/four-way-classifier.yml`, plus the `#574` nightly `apalache-diff` job); no production code path imports it; the Rust enumerator from EPIC-3 is unaffected by anything that lives under `tools/enumerator/corpus/`.

## Current state (as of v0.9.0)

This EPIC has shipped, plus a follow-on 4-way classifier (#1070 closed via PR #1101). The implementation diverges from the design narrative below in several deliberate ways; readers reviewing the corpus should consult the actual artefacts rather than the literal task descriptions:

- **Mapping schema lives at `tools/apalache-diff/mapping.toml`**, not under `tools/enumerator/corpus/`. The rows use `[[scenarios]]` with fields `name`, `tla_path`, `rust_path`, `invariant`, `expected_apalache`, `expected_rust`, `rust_violation`, `spec_section`, `notes` (no `identifier_translation` table — the runner asserts verdict equality, not witness isomorphism, per the §3 corpus-as-oracle doctrine the team converged on during wave-28 / #574).
- **Files are named by scenario, not by `r1`..`r10`.** The ten shipped models are `single_input_commit`, `cycle_two_deriveds`, `glitch_propagation_minimal`, `dispose_then_read`, `cross_graph_read_uncovered`, `subscribe_callback_cascade`, `monotonic_commit_violation`, `replay_divergence`, `legacy_allow_bridge`, `process_exit_scope_subscribe`. The `r{n}.tla` naming convention discussed below was rejected during scaffold; descriptive basenames matched against the `name` join key proved more legible in review.
- **Verdict surface is `ApalacheVerdict` / `EnumeratorVerdict`**, not `Pass | Fail{witness} | BoundExceeded`. Both enums have four arms — `Held`, `Violated`, `BinaryUnavailable` (Apalache only), `Skipped { reason }`. `BinaryUnavailable` is the graceful-degradation path when `apalache-mc` is not on `PATH` (the public CI runner intentionally omits Apalache; see `four-way-classifier.yml`'s "Apalache binary is intentionally NOT installed" comment). The `BoundExceeded` arm was rolled into `Skipped { reason }` because Apalache's bound-exhaustion output is one of several "ran but did not match held/violated" cases the runner treats uniformly.
- **`tools/enumerator/diff/`** is the shipping crate (binary: `causl-corpus-diff`). The crate name in `Cargo.toml` is `apalache-diff`. Tests live as integration tests under `tools/enumerator/diff/tests/` (not per-model `r{n}_test.rs` files); the suite covers verdict parsing, four-way classification, render-report, seed-parity, and mapping-invariant resolution.
- **CI runs under `.github/workflows/four-way-classifier.yml`**. The `checker-diff.yml` filename in TASK 7.4 below is the historical placeholder. Path filter, JVM caching, single-threaded run, and `if: always()` artifact upload all match the design here; the JVM is currently *not* installed in CI (Apalache is exercised only on the nightly Tier-3 lane plus local developer runs), so the on-PR job exercises the four-way JS+Rust legs and treats the Apalache leg as `BinaryUnavailable`.
- **4-way classifier extension (#1070 / PR #1101).** The shipped runner now classifies disagreement across four implementations — TS engine (`commitInternal`), WASM serde bridge, WASM gc-builtins bridge, and the Rust bounded enumerator — into a seven-arm `FourWayAgreement` enum (`Unanimous`, `TsOnlyDiffers`, `WasmDiffersFromCanonical`, `RustDiffersFromJs`, `SplitDecision`, `UnanimousShapeDivergentHash`, `Unknown`). A full run on the corpus + canonical-seed registry produces 14 unanimous rows and one `RustDiffersFromJs` row (`cycle_two_deriveds`, excused via a `four-way-architectural` exception in `mapping.toml` — the JS legs parse the static IR while the Rust enumerator's BFS detects the embedded cycle, both correct on complementary angles).
- **`[[exceptions]]` table format** is `scenario` / `kind` / `reason` / `tracking_issue`, with the same "non-empty reason + non-empty tracking issue" gate the design specifies. `kind` is one of `encoding-asymmetric`, `apalache-bug`, `enumerator-bug`, `four-way-architectural`. Two exceptions ship today: `glitch_propagation_minimal` (encoding-asymmetric, #574) and `cycle_two_deriveds` (four-way-architectural, #1070).

The design narrative below is preserved verbatim from the EPIC-7 draft because every load-bearing claim (Lamport's oracle framing, Beck's two-oracles-one-truth, Norvig's ten-models budget, the brutal-critical review's three risks, the named-exception escape hatch) still holds. Only the surface-level artefact names, schema field names, and the verdict enum arms changed during implementation. Where a TASK description below names a file or a struct that does not exist in tree, the section above is authoritative.

**Dependencies:** EPIC-3 (bounded enumerator). Without the enumerator, there is nothing to differential-test. EPIC-3's public verdict surface — `Verdict = Pass | Fail { witness } | BoundExceeded` — is the join target this EPIC consumes; if EPIC-3 changes that surface, the runner here changes with it on the same PR.

## What I'm shipping

Lamport's framing is the one we open with, because the corpus is for him: TLA+ is the oracle, and the corpus is the team's standing claim that the Rust enumerator's verdicts agree with an independent oracle on a curated set of scenarios. Lamport spent a career arguing that a specification is a contract you can argue against on paper before you argue against it in production. The TLA+ side of this corpus *is* the paper. Ten hand-written `.tla` files; each one a §9.1 race-class scenario reduced to its smallest faithful encoding; each one checkable by `apalache check` in under sixty seconds. If the team cannot defend the encoding to a stranger reading the `.tla` file, the encoding is not faithful and the row is rejected before merge.

Beck's framing sits underneath every line of the runner: two oracles, one truth. Neither Apalache nor the Rust enumerator is the truth. The truth is their agreement, plus the named exceptions in `mapping.toml`. When both engines verdict `pass` on the same `(model, property)` join key, the team has earned the right to ship. When both verdict `fail` and the witness states are isomorphic up to `mapping.toml`'s identifier translation, the team has earned the right to ship the negative claim too. When they disagree, the corpus has caught a bug — in Apalache, in the enumerator, in the encoding, or (most often) in the team's understanding of the §9.1 row. Every divergence is a learning event. The runner's only job is to make the divergence loud, structured, and reproducible.

Norvig's framing is the corpus-breadth claim: ten models is the budget because ten is what one reviewer can read in one sitting. Norvig's review on the original §16.5.1 draft was that a corpus large enough to hide a bad encoding is a corpus that lies to its readers. Ten is small enough that every PR touching `tools/enumerator/corpus/apalache/` triggers a re-read of the whole corpus. If a reviewer cannot in good conscience attest "I have read all ten `.tla` files and they encode the §9.1 rows they claim to encode," the corpus is broken. The mapping.toml row count, the file count under `apalache/`, and the file count under `rust/` are pinned at ten by the structural test in TASK 7.1; growing the corpus is itself an EPIC, not a patch.

What is in the box on merge:

- `tools/enumerator/corpus/apalache/r1.tla` through `r10.tla` — ten hand-written TLA+ models, each in Apalache's restricted subset (no `RECURSIVE`, no `CHOOSE` over infinite sets, all variables bounded), each encoding one row of §9.1 (or one row of SPEC.async §9.1 / `S-1`/`S-2`/`S-3`).
- `tools/enumerator/corpus/rust/r1.scenario.rs` through `r10.scenario.rs` — ten Rust scenarios that drive EPIC-3's enumerator with a hand-written IR fixture and an oracle predicate matching the TLA+ property.
- `tools/enumerator/corpus/mapping.toml` — the join schema. One `[[entry]]` per row, each with `id`, `apalache_file`, `rust_file`, `spec_section`, `spec_row`, `properties` (named property identifiers, present on both sides), and `identifier_translation` (TLA+ identifier → Rust IR identifier).
- `tools/enumerator/diff/` — a Rust crate whose binary is the differential runner: subprocess-launches Apalache, subprocess-runs each Rust scenario via the EPIC-3 enumerator, joins on `(model, property)`, emits divergence rows, writes `apalache-diff-report.md`.
- `.github/workflows/checker-diff.yml` — the `apalache-diff` job: path-filtered, Apalache-pinned, JVM-batched, artifact-uploading, single-threaded.
- `tools/enumerator/diff/tests/acceptance/full-corpus.rs` — the acceptance gate: runs the full ten-model corpus through both engines, asserts 100% agreement (or named exception in `mapping.toml`).

What is not in the box:

- New §9.1 rows. The corpus encodes the rows the MODEL layer claims today; new rows are out of scope per the "Out of scope" section below.
- Adopter hypothesis support. Apalache cannot run on adopter-written hypotheses (per §16.5.1 explicitly). The corpus is hand-written; the adopter trusts the Rust enumerator without reading its source because the corpus exists.
- The enumerator itself. EPIC-3 ships that. This EPIC consumes EPIC-3's public verdict surface and nothing else.

## Brutal-critical review

This is the review the team owes itself before merging. Three real risks; the team is taking each one on the chin and pinning a mitigation.

**Risk 1: ten models is small.** Every gap in the corpus is a gap in our trust. If row 5 (glitch propagation) is in the corpus but row 5's *replay-divergence variant* is not, an enumerator bug that fires only on replay-divergence inputs ships green through `apalache-diff` and red into production. The team is mitigating this in three ways. First, the corpus is *picked* against §9.1's MODEL-layer column — every row that the MODEL layer claims gets at least one model, and a few rows that the team finds especially load-bearing get two (r1 and r6 both touch row 5; r7 is a row-5 variant). Second, the corpus is documented as a *floor*, not a ceiling: the §9.1 coverage table in `docs/checker-coverage.md` lists every row the corpus covers and every row it does not, and the not-covered rows are themselves a backlog the team works against. Third, the EPIC commits explicitly to "growing the corpus is itself an EPIC" — there is no slow drip of `r11.tla`, `r12.tla` added in unrelated PRs; if the team grows the corpus, it does so under a named follow-up EPIC with a named reviewer.

**Risk 2: maintenance burden — every TLA+ file must stay in sync with the corresponding Rust scenario.** The `.tla` and `.scenario.rs` files are written by hand, in two different formalisms, and the relationship between them is "encodes the same race scenario." That relationship cannot be statically checked; the runner can check that they agree on `pass`/`fail`/`bound-exceeded` per property, but it cannot check that they encode the *same* scenario. A drift bug — where the TLA+ side gets edited to model a different race than the Rust side — could hide under the agreement check if both engines happen to verdict `pass` on the new-but-wrong scenarios. The team is mitigating this with the witness-isomorphism gate: when both engines verdict `fail`, the runner compares witnesses up to `mapping.toml`'s identifier translation, and any non-isomorphic witness pair is a divergence. This catches drift in the most common case (the race actually fires). For the case where neither engine fires the race anymore — the most insidious drift — the team is mitigating with the `mapping.toml` row reference: every row points at a §9.1 row, and the §9.1 row is the human-readable scenario; reviewers compare the TLA+ encoding to the §9.1 prose, not to the Rust scenario, and a drift PR has to convince the reviewer the §9.1 encoding is still the encoding the row prose describes. Imperfect; we accept it as the cost of having the corpus at all.

**Risk 3: Apalache itself has bugs.** What if Apalache disagrees but the Rust enumerator is right? The team has thought about this and the answer is: that is a divergence, and divergences are loud. The runner does not pick a winner. The runner emits a divergence row, the CI job fails red, and the team investigates. Sometimes the investigation will conclude "Apalache is wrong; we have a reproducer; we file it upstream and add a named exception to `mapping.toml` until upstream fixes it." Sometimes it will conclude "the Rust enumerator is wrong; we fix it." Sometimes it will conclude "the encoding is wrong on one side." The named-exception path is the escape hatch and it has a cost — every named exception is a row in `mapping.toml` that future reviewers will see and ask "why is this still here?" — which is the cost we want it to have. The corpus is not a mechanism for ignoring Apalache bugs; it is a mechanism for documenting them in the same artifact as the corpus itself.

A fourth risk the team considered and rejected as not-load-bearing: Apalache's JVM startup cost. Sixty seconds per invocation times ten models is ten minutes; the team mitigates by batching all ten models into one JVM (per TASK 7.4 concern 3). If the batching breaks — if Apalache's batch mode does not support what we need — the fallback is parallel JVMs, accepting the wall-clock cost. Either way it is not a correctness risk.

## Sub-issues (TASKS)

### TASK 7.1 — Corpus directory structure + `mapping.toml` join schema

**Files:**

- `tools/enumerator/corpus/apalache/r1.tla`, `r2.tla`, `r3.tla`, `r4.tla`, `r5.tla`, `r6.tla`, `r7.tla`, `r8.tla`, `r9.tla`, `r10.tla` — placeholder skeletons created in this task; full contents in TASK 7.2.
- `tools/enumerator/corpus/rust/r1.scenario.rs`, `r2.scenario.rs`, `r3.scenario.rs`, `r4.scenario.rs`, `r5.scenario.rs`, `r6.scenario.rs`, `r7.scenario.rs`, `r8.scenario.rs`, `r9.scenario.rs`, `r10.scenario.rs` — placeholder skeletons; full contents in TASK 7.2.
- `tools/enumerator/corpus/mapping.toml` — the join schema, ten `[[entry]]` blocks.
- `tools/enumerator/corpus/Cargo.toml` — workspace crate that exposes the scenarios behind the `differential-corpus` feature flag so they only compile when the runner asks for them.
- `tools/enumerator/corpus/src/lib.rs` — re-exports the scenario modules.
- `tools/enumerator/corpus/tests/structure.rs` — the structural test suite for this task.

The ten models map to ten rows of §9.1 (engine spec) and SPEC.async §9.1. The `mapping.toml` schema is the contract every downstream task reads:

```toml
schema_version = 1

[[entry]]
id = "r1"
apalache_file = "apalache/r1.tla"
rust_file = "rust/r1.scenario.rs"
spec_section = "SPEC.md §9.1"
spec_row = 5
spec_row_name = "Diamond glitches"
properties = ["glitch_free", "monotone_clock"]

[entry.identifier_translation]
"D"     = "node_d"
"B"     = "node_b"
"C"     = "node_c"
"clock" = "graph_time"
```

`spec_section` is `"SPEC.md §9.1"` or `"SPEC.async.md §9.1"`. `spec_row` is the integer row number; `spec_row_name` is the row title (denormalised on purpose so a reviewer reading `mapping.toml` does not have to flip back to the spec). `properties` is the set of named property identifiers that both engines verdict on; the runner joins on `(id, property)`. `identifier_translation` is the TLA+-to-Rust-IR translation table that the witness-isomorphism check consults.

#### TDD test suite

`tools/enumerator/corpus/tests/structure.rs` ships these tests; each must be green at merge.

1. **`test_apalache_files_well_formed`** — for each `r{1..10}.tla`, invokes `apalache check --no-deadlocks --length=0 <file>` as a subprocess and asserts exit code is zero (parse-only succeeds). Captures stderr on failure and prints it in the assertion message.
2. **`test_rust_scenarios_compile`** — invokes `cargo build --features differential-corpus -p causl-corpus` as a subprocess at the workspace root and asserts exit code is zero. Builds in `target/corpus-build/` so it does not pollute the main build.
3. **`test_mapping_toml_well_formed`** — `toml::from_str::<MappingFile>(...)` on the file contents; asserts deserialisation into the typed `MappingFile` succeeds. The `MappingFile` struct lives in `tools/enumerator/corpus/src/mapping.rs` and is the canonical schema.
4. **`test_cardinality_match`** — counts files matching `apalache/r*.tla`, files matching `rust/r*.scenario.rs`, and `[[entry]]` blocks in `mapping.toml`. Asserts all three counts equal exactly ten and that the `id` set across the three sources is identical (`{r1, r2, r3, r4, r5, r6, r7, r8, r9, r10}`).
5. **`test_spec_row_references_resolve`** — for each `[[entry]]`, parses `SPEC.md` (or `SPEC.async.md`) and asserts that §9.1's table contains the referenced `spec_row`. Implementation: read the spec, find the `### 9.1` heading, parse the markdown table that follows, assert the row number is in the parsed row set. Catches a `mapping.toml` referencing a row that has been renumbered or deleted.
6. **`test_property_set_disjoint_per_entry`** — within each `[[entry]]`, asserts the `properties` array has no duplicates.
7. **`test_id_uniqueness`** — across all entries, asserts `id` is unique.
8. **`test_naming_discipline`** — for each entry, asserts `apalache_file == format!("apalache/{}.tla", id)` and `rust_file == format!("rust/{}.scenario.rs", id)`. Pins the convention.
9. **`test_identifier_translation_total`** — for each entry, asserts every TLA+ identifier appearing in the `.tla` file's `VARIABLES` declaration is a key in `identifier_translation`. Catches a missing translation row that would silently break the witness-isomorphism check downstream.

#### Five concerns

1. **Naming discipline** — `r1.tla` ↔ `r1.scenario.rs` ↔ `mapping.toml` row with `id = "r1"`. Violation is caught by `test_naming_discipline` and `test_cardinality_match`. The runner depends on the convention; we pin it in the structural test rather than the runner.
2. **TLA+ syntax restriction** — every model uses Apalache's restricted subset: no `RECURSIVE` operators, no `CHOOSE` over infinite sets, every `VARIABLES` slot has a `TypeOK` invariant pinning a finite range. Violation is caught by `test_apalache_files_well_formed` (parse failure) and by manual review against the `.tla` file's header comment, which states the restriction explicitly.
3. **Rust syntax** — every scenario uses `tools/enumerator`'s public API: `Scenario` trait with `name(&self) -> &str`, `ir(&self) -> Ir`, `properties(&self) -> Vec<Property>`. Violation is caught by `test_rust_scenarios_compile`.
4. **Coverage discipline** — at minimum one model per §9.1 row that the MODEL layer claims (per §9.1 row 7, row 5 variants, row 8, row 11, plus SPEC.async §9.1 rows 6, S-1, S-2, S-3). Violation is caught by manual review of `mapping.toml`'s `spec_row` distribution against the MODEL-layer column in `docs/checker-coverage.md`. We do *not* mechanise this check at the corpus layer because the §9.1 layer assignment is itself a spec-level claim that lives in `docs/checker-coverage.md`; that file's CI job (EPIC-6, race-detection) already gates the assignment.
5. **No race condition** — the corpus is static data. No mutexes, no atomics, no shared state. The Rust scenarios are pure-data IR fixtures plus oracle predicates; no scenario constructs an actual `Graph` or runs `commit`. Violation is caught by review (and by the absence of `std::sync` imports in `tools/enumerator/corpus/src/`).

### TASK 7.2 — Ten hand-written TLA+ models

This task is decomposed into ten sub-tasks, one per model. The five-test suite and five concerns below the model list are *shared* across all ten sub-tasks; the per-model entries below specify the unique encoding, properties, and bound.

#### TASK 7.2.r1 — glitch-propagation (§9.1 row 5)

**Files:** `tools/enumerator/corpus/apalache/r1.tla`, `tools/enumerator/corpus/rust/r1.scenario.rs`, `tools/enumerator/corpus/tests/r1_test.rs`.

Three nodes — `B`, `C`, `D = f(B, C)` — share a parent input `A`. The race: an interleaved evaluator could observe `D(B@t1, C@t0)` mid-propagation. The TLA+ model encodes the diamond as four `VARIABLES` (`A`, `B`, `C`, `D`), with `Next` step actions `BumpA(v)` (one tick of input change). `TypeOK` pins each variable to a finite range `0..MAX_VAL`. `Init` sets all four to zero. `Inv == D = f(B, C) /\ B = g(A) /\ C = h(A)` is the glitch-free invariant; `apalache check --inv Inv --length=K` is the verdict path.

Properties (joined per `mapping.toml`):

- `glitch_free` — `\A t \in Ticks: D[t] = f(B[t], C[t])`. Expected verdict: `Pass`.
- `monotone_clock` — `\A t1, t2 \in Ticks: t1 < t2 => clock[t1] < clock[t2]`. Expected: `Pass`.

Bound: `K = 6`.

The Rust scenario in `r1.scenario.rs` builds the IR for the same diamond — `IRInput("A")`, `IRDerived("B", reads=["A"])`, `IRDerived("C", reads=["A"])`, `IRDerived("D", reads=["B", "C"])` — and the oracle predicate `glitch_free` reads §3's Theorem 1 directly.

#### TASK 7.2.r2 — subscribe-after-dispose (§9.1 row 11 + SPEC.async S-3)

**Files:** `tools/enumerator/corpus/apalache/r2.tla`, `tools/enumerator/corpus/rust/r2.scenario.rs`, `tools/enumerator/corpus/tests/r2_test.rs`.

A subscriber subscribes to a family-keyed node *after* that node has been disposed. The race: a subscriber callback fires with a value from a disposed node, or the subscribe call silently no-ops without the engine throwing `NodeDisposedError`. The TLA+ model has `VARIABLES` = `{disposed, subscribed, fired}`, each a function from `Subscriber × Node → BOOLEAN` plus a per-node `disposed_at` timestamp. `Next` allows `Subscribe(s, n)`, `Dispose(n)`, `FireCallback(s, n)`.

Properties:

- `no_post_dispose_fire` — `\A s, n: fired[s, n] => ~disposed[n] \/ subscribed_at[s, n] < disposed_at[n]`. Expected: `Pass` on the encoding where the engine throws `NodeDisposedError` on subscribe-after-dispose; `Fail` on the deliberately-injected variant where the throw is missing.
- `dispose_throws_loud` — `\A s, n: (Subscribe(s, n) /\ disposed[n]) => NodeDisposedError \in fired_errors`. Expected: `Pass`.

Bound: `K = 8`.

The Rust scenario uses `IRSubscribe` and `IRDispose` from EPIC-1's schema 3 IR; the oracle is `assert!(every IRSubscribe after IRDispose on same node id throws NodeDisposedError)`.

#### TASK 7.2.r3 — dynamic-dep cleanup (§9.1 row 7)

**Files:** `tools/enumerator/corpus/apalache/r3.tla`, `tools/enumerator/corpus/rust/r3.scenario.rs`, `tools/enumerator/corpus/tests/r3_test.rs`.

A derived node `chosen` reads `flag ? a : b`. The race: after `flag` flips, the derivation must (1) drop the stale dep AND (2) wire up the fresh dep — a two-sided invariant. The TLA+ model encodes the dep set per derivation as `deps[chosen] \in SUBSET {a, b, flag}` and the property is two-sided.

Properties:

- `stale_dep_dropped` — `\A t: ~flag[t] => a \notin deps[chosen, t]`. Expected: `Pass`.
- `fresh_dep_wired` — `\A t: ~flag[t] => b \in deps[chosen, t]`. Expected: `Pass`.
- `recompute_on_dep_change` — `\A t: (b[t] /= b[t-1]) /\ (b \in deps[chosen, t]) => chosen[t] /= chosen[t-1]`. Expected: `Pass`.

Bound: `K = 7`.

#### TASK 7.2.r4 — cycle reachable from action sequence (§9.1 row 8)

**Files:** `tools/enumerator/corpus/apalache/r4.tla`, `tools/enumerator/corpus/rust/r4.scenario.rs`, `tools/enumerator/corpus/tests/r4_test.rs`.

A graph that is acyclic in its initial state but becomes cyclic after a sequence of `tx.set` calls reroutes a derivation through a back-edge. The TLA+ model encodes the dep graph as a `[Node -> SUBSET Node]` function plus an action `RerouteDep(n, new_deps)` that updates one node's dep set; the property is that the engine throws `CycleError` at the first commit that closes the cycle.

Properties:

- `cycle_caught_at_first_close` — `\A t: cyclic_at(deps, t) /\ ~cyclic_at(deps, t-1) => CycleError \in fired_errors[t]`. Expected: `Pass`.
- `no_false_cycle` — `\A t: ~cyclic_at(deps, t) => CycleError \notin fired_errors[t]`. Expected: `Pass`.

Bound: `K = 12` (longer action sequences needed to construct a non-trivial reroute).

#### TASK 7.2.r5 — pending-resolve race (SPEC.async §9.1 row 6)

**Files:** `tools/enumerator/corpus/apalache/r5.tla`, `tools/enumerator/corpus/rust/r5.scenario.rs`, `tools/enumerator/corpus/tests/r5_test.rs`.

A `Resource` is in `Loading` state; an input it depends on changes mid-resolution. The TLA+ model encodes the per-resource statechart `Loading → [stale-detected] → Stale | Errored` with `originating_time` recorded at the start of `Loading`.

Properties:

- `stale_transition` — `\A r: state[r] = "Loading" /\ deps_changed_since(r, originating_time[r]) => <>(state[r] = "Stale")`. Expected: `Pass`.
- `no_stale_value_published` — `\A r: state[r] = "Stale" => ~published[r]`. Expected: `Pass`.

Bound: `K = 8`.

#### TASK 7.2.r6 — replay-divergence (§9.1 row 5, replay variant)

**Files:** `tools/enumerator/corpus/apalache/r6.tla`, `tools/enumerator/corpus/rust/r6.scenario.rs`, `tools/enumerator/corpus/tests/r6_test.rs`.

Same diamond as r1, but observed through `subscribeCommits` replay against the live observer. The race: the replay observer reconstructs a sequence that does not match the live observer's sequence (which would mean §3 Theorem 4's monotonicity is implementation-leaky).

Properties:

- `replay_matches_live` — `\A i: replay_observed[i] = live_observed[i]`. Expected: `Pass`.
- `replay_count_matches` — `Cardinality(replay_observed) = Cardinality(live_observed)`. Expected: `Pass`.

Bound: `K = 8`.

This is *not* a duplicate of r1: r1 fires the diamond against direct subscribers; r6 fires against `subscribeCommits` replay. Both are §9.1 row 5 because the row-5 invariant is engine-wide, not subscriber-specific.

#### TASK 7.2.r7 — observer-fired-on-unchanged (§9.1 row 5 variant)

**Files:** `tools/enumerator/corpus/apalache/r7.tla`, `tools/enumerator/corpus/rust/r7.scenario.rs`, `tools/enumerator/corpus/tests/r7_test.rs`.

A derived node's value is unchanged across a commit (e.g. `D = abs(A)`, `A` flips sign with same magnitude). The race: a subscriber fires on a commit that did not change its observed value, which would break the §3 Theorem 3 contract that subscribers fire on observed-value change, not on dependency change.

Properties:

- `subscriber_fires_only_on_change` — `\A s, t: fired[s, t] => observed_value[s, t] /= observed_value[s, t-1]`. Expected: `Pass`.
- `no_spurious_fire_count` — `Cardinality({t: fired[s, t]}) <= Cardinality({t: observed_value[s, t] /= observed_value[s, t-1]})`. Expected: `Pass`.

Bound: `K = 6`.

#### TASK 7.2.r8 — stale-async resolution (SPEC.async §9.1 row 6, value-arrival variant)

**Files:** `tools/enumerator/corpus/apalache/r8.tla`, `tools/enumerator/corpus/rust/r8.scenario.rs`, `tools/enumerator/corpus/tests/r8_test.rs`.

A `Resource` resolves with a value that was already invalidated by a downstream input change. Distinct from r5: r5 fires the *transition* into `Stale`; r8 fires the *value-arrival check* on a pending resolution. The TLA+ model encodes both `originating_time[r]` and `latest_dep_change_time[r]` and the resolver compares them at value arrival.

Properties:

- `originating_time_check` — `\A r: ResolveArrival(r) /\ originating_time[r] < latest_dep_change_time[r] => state'[r] = "Stale"`. Expected: `Pass`.
- `value_drop_when_stale` — `\A r: state[r] = "Stale" => arrived_value[r] = NotPublished`. Expected: `Pass`.

Bound: `K = 9`.

#### TASK 7.2.r9 — abandon-then-resume (SPEC.async §9.1 S-1)

**Files:** `tools/enumerator/corpus/apalache/r9.tla`, `tools/enumerator/corpus/rust/r9.scenario.rs`, `tools/enumerator/corpus/tests/r9_test.rs`.

A `Loading` resource is abandoned (semantically, `AbortController.abort`), then a new resolution is requested. The race: the abandoned resolution arrives after the new one and overwrites the fresh value. The TLA+ model encodes an `abandoned` flag per resolution attempt and an `attempt_id` so concurrent resolutions are distinguishable.

Properties:

- `abandoned_does_not_overwrite` — `\A a: abandoned[a] => ResolveArrival(a) does not update Resource.value`. Expected: `Pass`.
- `latest_attempt_wins` — `\A r: published_value[r] = latest_non_abandoned_arrival_value[r]`. Expected: `Pass`.

Bound: `K = 9`.

#### TASK 7.2.r10 — open-set drift mid-resolution (SPEC.async §9.1 S-2)

**Files:** `tools/enumerator/corpus/apalache/r10.tla`, `tools/enumerator/corpus/rust/r10.scenario.rs`, `tools/enumerator/corpus/tests/r10_test.rs`.

The set of in-flight resources changes while a particular resource is resolving. The race: the resolver consults a stale view of the open-set when deciding whether to fire `onAllSettled`. The TLA+ model encodes the open-set as a TLA+ set with `Resolve(r)` removing `r` and `Start(r)` adding `r`, plus the `onAllSettled` firing condition consulting the live open-set.

Properties:

- `open_set_consistency` — `\A t: open_set_view_at_resolve[r, t] = open_set[t]`. Expected: `Pass`.
- `all_settled_fires_iff_empty` — `\A t: AllSettledFired[t] <=> open_set[t] = {}`. Expected: `Pass`.

Bound: `K = 10`.

#### Shared TDD test suite per model (five tests minimum)

Each per-model test file (`r{n}_test.rs`) ships these five tests; they parameterise on the model id and call shared helpers from `tools/enumerator/corpus/tests/common.rs`.

1. **`test_apalache_check_passes`** — `apalache check --length=K <file>` succeeds for the model's declared bound `K` (read from the `.tla` file's header comment, parsed by a small regex helper in `tools/enumerator/corpus/tests/common.rs`). Asserts no deadlock, no invariant violation on the encoding's *expected-pass* path. The model is constructed so `Pass` is the expected verdict on the race-free encoding; a separately-named "negative" `.tla` file (e.g. `r1_negative.tla`) deliberately injects the race and is asserted to verdict `Fail` with a witness. Both directions are tested; this catches the encoding-degenerates-to-trivially-pass failure mode.
2. **`test_rust_scenario_matches_tla_verdict`** — runs the Rust scenario through EPIC-3's enumerator and asserts the same `(property, verdict)` pairs as Apalache. This is the per-model differential test, run locally as a unit test without the full TASK 7.3 runner (so a developer can iterate on one model without spinning up the full corpus).
3. **`test_mapping_toml_row_is_correct`** — reads `mapping.toml`, looks up the entry by the model's id, asserts `spec_row` and `spec_row_name` match the expected values declared at the top of the test file as `const EXPECTED_SPEC_ROW: u32 = 5;` and `const EXPECTED_SPEC_ROW_NAME: &str = "Diamond glitches";`. Catches a typo in `mapping.toml` that points the model at the wrong §9.1 row.
4. **`test_witness_isomorphism_on_fail`** — runs the *negative* encoding (which both engines should verdict `Fail` on), asserts the witness states are isomorphic up to the entry's `identifier_translation`. The isomorphism predicate is implemented in `tools/enumerator/diff/src/witness.rs`; this test imports it as a library function and calls it directly. Catches a translation table that is technically total but does not actually translate.
5. **`test_property_test_non_divergence`** — a property-based test (using `proptest`) that runs both engines on each of 100 randomly-bounded variants of the model (varying initial-value seed within `TypeOK`'s range, action count up to the bound, action ordering) and asserts non-divergence on every variant. The 100-trial floor matches §15.2's property-suite floor. Catches a model whose encoding agrees on the canonical bound but disagrees on adjacent variants — the most common drift mode.

#### Shared five concerns per model

1. **Faithful encoding** — the TLA+ model captures the same race scenario the Rust scenario captures and the same race scenario the §9.1 row prose names. The §9.1 row prose is the human-readable specification; both encodings answer to it. Mitigation: the model file's header comment quotes the §9.1 row prose verbatim (or the SPEC.async §9.1 prose for the async-side rows) and explains how the TLA+ form encodes it; reviewers compare the TLA+ form to the prose, not to the Rust scenario. The header is mechanically extracted by `test_mapping_toml_row_is_correct` and asserted to be non-empty; a model with an empty header does not pass review.
2. **Bounded state space** — Apalache can `check` it within sixty seconds at the declared bound. Mitigation: the file header declares the bound as `\* @apalache_bound: K = 8`; the bound is small (≤12 for every model in this corpus); `test_apalache_check_passes` runs with a 60-second wall-clock timeout and fails if exceeded. If a future model wants a larger bound, that is an EPIC-7-follow-up with explicit review of the CI wall-clock impact.
3. **Witness comparability** — the witness state is structurally isomorphic (per `mapping.toml`'s `identifier_translation`) to the Rust enumerator's witness. Mitigation: `test_witness_isomorphism_on_fail` per model plus the runner's witness check; the `identifier_translation` table is total per `test_identifier_translation_total` from TASK 7.1.
4. **Race-class assignment** — `mapping.toml` references the exact §9.1 row (or SPEC.async §9.1 row, or `S-N` async-row identifier) this model proves. Mitigation: `test_mapping_toml_row_is_correct` per model plus `test_spec_row_references_resolve` from TASK 7.1.
5. **No race condition** — TLA+ and Rust are both deterministic given the same model and the same bound. Mitigation: TLA+ is by construction (TLA+'s semantics are sequential exploration); the Rust scenario has `#![forbid(unsafe_code)]` at module level and uses no `std::sync::Mutex`, no `std::thread::spawn`, no `tokio` runtime, no `crossbeam`. Determinism is checked by a 10-run identity test in the `proptest` harness: same seed, same bound, byte-identical verdict on both engines, byte-identical witness on the negative encoding.

### TASK 7.3 — Differential-test runner

**Files:**

- `tools/enumerator/diff/Cargo.toml` — new crate `causl-corpus-diff`. Dependencies: `causl-enumerator` (path), `causl-corpus` (path, `features = ["differential-corpus"]`), `serde`, `serde_json`, `toml` (read-only), `tempfile` (for Apalache stdout capture), `clap` (for CLI flags), `anyhow`. No `tokio`, no `rayon` — single-threaded by design.
- `tools/enumerator/diff/src/main.rs` — CLI entry point.
- `tools/enumerator/diff/src/runner.rs` — the orchestration: load `mapping.toml`, fan out to Apalache and the Rust enumerator, join verdicts, emit divergence rows.
- `tools/enumerator/diff/src/apalache.rs` — Apalache subprocess wrapper. `fn run_apalache(file: &Path, properties: &[String]) -> Result<HashMap<String, Verdict>>`. Spawns `apalache-mc check --length=K <file>` and parses stdout into the verdict map.
- `tools/enumerator/diff/src/rust_engine.rs` — Rust enumerator wrapper. `fn run_rust(scenario: &dyn Scenario, properties: &[String]) -> Result<HashMap<String, Verdict>>`. Calls EPIC-3's enumerator's public API.
- `tools/enumerator/diff/src/witness.rs` — the witness-isomorphism check. `fn isomorphic(apalache: &ApalacheWitness, rust: &RustWitness, translation: &HashMap<String, String>) -> bool`.
- `tools/enumerator/diff/src/report.rs` — `apalache-diff-report.md` writer.
- `tools/enumerator/diff/tests/runner_unit.rs` — unit tests for the runner.
- `tools/enumerator/diff/tests/acceptance/full-corpus.rs` — the acceptance gate (also see "Acceptance gate" below).

The runner's verdict types in `tools/enumerator/diff/src/verdict.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Verdict {
    Pass,
    Fail { witness: Witness },
    BoundExceeded { reached_bound: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Witness {
    pub steps: Vec<WitnessStep>,
    pub final_state: BTreeMap<String, WitnessValue>,
}
```

The witness shape is small on purpose — the runner does not embed a full TLA+ trace, only the identifier-to-value bindings at each step plus the final state. That is enough to diff against the Rust enumerator's witness, and it is small enough to render readably in the markdown report.

The runner's CLI surface in `tools/enumerator/diff/src/main.rs`:

```
USAGE: causl-corpus-diff [--mapping PATH] [--report PATH] [--filter MODEL_ID]

  --mapping PATH    Path to mapping.toml (default: tools/enumerator/corpus/mapping.toml)
  --report PATH     Path to write the markdown report (default: apalache-diff-report.md)
  --filter MODEL_ID Run only the model with this id (for local iteration; CI omits)
  --json            Emit machine-readable JSON instead of markdown
  --strict          Treat soft divergences (BoundExceeded vs Pass) as hard failures
```

The runner reads both verdict streams, joins on `(model, property)`, and emits a divergence row when:

- one engine returns `Pass` and the other returns `Fail` — hard divergence, exit code 1;
- both return `Fail` but the witnesses are not isomorphic — hard divergence, exit code 1;
- one returns `BoundExceeded` and the other returns `Pass` — soft divergence, exit code 2 (CI annotates as a soft warning, opens an issue, does not red-flag the PR);
- one returns `BoundExceeded` and the other returns `Fail` — hard divergence, exit code 1 (the bound-exceeded engine is hiding a known failure).

#### TDD test suite (`tools/enumerator/diff/tests/runner_unit.rs`)

1. **`test_apalache_subprocess_invocation`** — asserts the runner spawns Apalache with the exact argv `["apalache-mc", "check", "--length=K", "--out-dir=...", "<file>"]` for declared `K`. Implementation: a fake `Command` builder with a recording shim. Catches a regression where someone removes `--length`.
2. **`test_apalache_stdout_parsed_to_verdict`** — feeds the runner three canned Apalache stdout transcripts (from `tests/fixtures/apalache_pass.txt`, `apalache_fail.txt`, `apalache_bound_exceeded.txt`), asserts the parser yields `Pass`, `Fail { witness }`, and `BoundExceeded` respectively. Witness parsing is its own unit test (below).
3. **`test_rust_engine_invocation`** — feeds the runner a stub `Scenario` with a known property set, asserts the runner calls `Scenario::ir()` and `Scenario::properties()` and passes the IR to EPIC-3's enumerator entry point.
4. **`test_verdict_join_on_model_property`** — feeds the runner two synthetic verdict maps (Apalache side: `r1.glitch_free → Pass`, `r1.monotone_clock → Pass`; Rust side: `r1.glitch_free → Pass`, `r1.monotone_clock → Pass`), asserts the joined output has zero divergence rows.
5. **`test_verdict_join_missing_property_fails_loud`** — feeds the runner an Apalache map missing `r1.monotone_clock` while the Rust map has it. Asserts the runner returns `Err` with a message containing the missing key. The runner does *not* silently treat missing as `Pass`.
6. **`test_pass_vs_fail_is_hard_divergence`** — synthetic divergence; asserts exit code 1, asserts the divergence row in `apalache-diff-report.md` is named correctly.
7. **`test_fail_vs_fail_isomorphic_witnesses_passes`** — both engines verdict `Fail`, witnesses are isomorphic per the translation table. Asserts no divergence row.
8. **`test_fail_vs_fail_non_isomorphic_is_hard_divergence`** — same as above but with a translation table that does not map. Asserts exit code 1.
9. **`test_bound_exceeded_vs_pass_is_soft_divergence`** — Rust verdicts `BoundExceeded`, Apalache verdicts `Pass`. Asserts exit code 2 and an "issue-open recommendation" line in the report.
10. **`test_bound_exceeded_vs_fail_is_hard_divergence`** — Rust verdicts `BoundExceeded`, Apalache verdicts `Fail`. Asserts exit code 1 — the Rust enumerator is hiding a known failure.
11. **`test_witness_isomorphism_total_translation`** — feeds the witness check a translation table that covers every TLA+ identifier in the witness; asserts isomorphism resolves cleanly.
12. **`test_witness_isomorphism_partial_translation_errors`** — feeds the check a translation that omits an identifier present in the witness; asserts an `Err` with the missing identifier in the message. Catches an under-specified `identifier_translation` table that would otherwise return false-positive isomorphism.
13. **`test_named_exceptions_suppress_hard_divergence`** — adds a `[[exception]]` row to a synthetic `mapping.toml` for `(r3, glitch_free)`; the runner observes a hard divergence on that key and asserts it is downgraded to a logged-but-non-failing exception. Exit code 0 with a warning line in the report.

#### Five concerns

1. **Subprocess invocation** — Apalache runs as a child process; stdout is the verdict stream. Mitigation: `std::process::Command::new("apalache-mc")` with explicit args; stderr captured separately and surfaced on parse failure; subprocess wall-clock timeout (90 seconds, ten seconds of headroom over the per-model 60-second budget). No `unsafe`, no `Command::output()` without timeout (we use `wait_timeout` from the `wait-timeout` crate).
2. **Verdict join** — `(model, property)` is the join key; missing entries fail loud per `test_verdict_join_missing_property_fails_loud`. There is no "default to pass" path. If Apalache's stdout is missing a property the runner expected, that is a parse bug or an Apalache CLI surface change, and we want it loud at the runner, not silent in the report.
3. **Witness isomorphism** — `(apalache_witness, rust_witness)` are compared up to `mapping.toml`'s `identifier_translation`. The check is structural: same set of identifiers (after translation), same assigned values per identifier, same step indices. No fuzzy matching, no canonicalisation beyond what the translation table specifies. Catches `test_fail_vs_fail_non_isomorphic_is_hard_divergence`.
4. **Bound-exceeded handling** — Rust `BoundExceeded` + Apalache `Pass` is soft-failure; opens an issue (the runner emits a `gh issue create` shell line in the report; CI does not auto-execute it, the on-call engineer reviews the report and runs the command if appropriate). Rust `BoundExceeded` + Apalache `Fail` is hard-failure: the enumerator is hiding a known failure, which is exactly the regression mode the bound-exceeded soft-fail path was *not* designed to cover.
5. **MIRI** — the runner's subprocess management uses `std::process::Child`; no `unsafe` in `tools/enumerator/diff/`. MIRI is not applicable to a subprocess-shelling binary (MIRI cannot interpret `execve`). However, the underlying enumerator from EPIC-3 IS MIRI-tested in EPIC-3's own test suite. The runner's `cargo test` runs without MIRI; the enumerator's `cargo miri test` runs in EPIC-3.

### TASK 7.4 — `apalache-diff` CI job

**Files:** `.github/workflows/checker-diff.yml` (new).

The job runs the differential test on every PR that touches `tools/enumerator/` or the corpus. It does not run on every PR (the JVM startup cost is ten minutes and the corpus rarely changes); it runs when the corpus or the enumerator changes, plus on a nightly schedule as a regression watchdog.

The workflow shape:

```yaml
name: apalache-diff

on:
  pull_request:
    paths:
      - 'tools/enumerator/**'
      - 'tools/enumerator/corpus/**'
  schedule:
    - cron: '0 7 * * *'  # 07:00 UTC nightly
  workflow_dispatch:

concurrency:
  group: apalache-diff-${{ github.ref }}
  cancel-in-progress: true

jobs:
  diff:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'
      - name: Cache Apalache
        uses: actions/cache@v4
        with:
          path: ~/.local/share/apalache
          key: apalache-mc-0.45.0-${{ runner.os }}
      - name: Install Apalache (pinned)
        run: |
          if [ ! -d ~/.local/share/apalache ]; then
            mkdir -p ~/.local/share/apalache
            curl -L https://github.com/apalache-mc/apalache/releases/download/v0.45.0/apalache.tgz \
              | tar xz -C ~/.local/share/apalache --strip-components=1
          fi
          echo "$HOME/.local/share/apalache/bin" >> "$GITHUB_PATH"
      - uses: dtolnay/rust-toolchain@stable
      - name: Run differential corpus
        run: |
          cargo run --release -p causl-corpus-diff -- \
            --mapping tools/enumerator/corpus/mapping.toml \
            --report apalache-diff-report.md
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: apalache-diff-report
          path: apalache-diff-report.md
```

#### Five concerns

1. **Path filter** — only triggered on changes to `tools/enumerator/` or `tools/enumerator/corpus/` (the latter is included in the former, but we list both for clarity in the workflow file's `paths:` section). Plus the nightly schedule and `workflow_dispatch`. Not triggered on every `packages/core/**` change, which would otherwise burn an Apalache JVM startup on every engine PR.
2. **Apalache install** — pinned version `apalache-mc-0.45.0`, cached in CI under `~/.local/share/apalache` keyed on the version + OS. Cache miss on a version bump triggers a fresh download; the cache key change is the signal that the pin moved. The pin lives in *two* places: the workflow YAML and a `tools/enumerator/diff/.apalache-version` file consulted by the local test runner; a CI test asserts the two agree.
3. **JVM startup cost** — thirty to sixty seconds per Apalache invocation. The runner batches all ten models into one JVM by spawning `apalache-mc` once with a driver script that iterates the ten files internally, *or* (if Apalache's CLI does not support a driver script) by running `apalache-mc check --foreground` once per file but reusing the JVM via `--server` mode. The fallback (which we accept and document if the batching does not work) is ten serial JVM starts at sixty seconds each, ten minutes total, well under the twenty-minute job timeout.
4. **Report upload** — `apalache-diff-report.md` is uploaded as an artifact on every run, including pass runs (per `if: always()`). The report on pass is "10/10 agreement on 47/47 properties," one line; the report on divergence is one section per divergence row with the model id, the property, the two verdicts, the witnesses (if applicable), and the soft-vs-hard classification. PR reviewers click the artifact link in the workflow run summary.
5. **No race condition** — the job runs single-threaded. `cargo run --release -p causl-corpus-diff` does not use `tokio` or `rayon`; the runner iterates models sequentially. The `concurrency:` group cancels in-flight runs of the same ref, so a PR that pushes twice in a minute does not double-spend the JVM startup.

## Acceptance gate

`tools/enumerator/diff/tests/acceptance/full-corpus.rs` — runs the full ten-model corpus through both engines in the same way the CI job does, asserts 100% agreement (or a named exception listed in `mapping.toml` under `[[exception]]`). The exception schema:

```toml
[[exception]]
model_id = "r3"
property = "stale_dep_dropped"
classification = "soft"  # "soft" or "hard"
reason = "Apalache 0.45.0 reports BoundExceeded at K=7 due to upstream issue apalache-mc/apalache#1234; Rust enumerator verdicts Pass."
tracking_issue = "https://github.com/apalache-mc/apalache/issues/1234"
expires_at_version = "0.46.0"
```

Both `reason` and `tracking_issue` are required-non-empty per `test_mapping_toml_well_formed`; an exception without a tracking issue is a permanent excuse, which is what we want to make hard to ship.

The acceptance gate is run by `cargo test -p causl-corpus-diff --test full-corpus --release` and is the single test that gates merging this EPIC. It must:

1. Discover all ten models via `mapping.toml`.
2. Run Apalache on each (60-second timeout per model).
3. Run the Rust enumerator on each.
4. Join verdicts on `(model, property)`.
5. Assert every join key has matching verdicts, OR is listed in `mapping.toml`'s `[[exception]]` table with a non-empty `reason` and a non-empty `tracking_issue` URL.
6. Assert the total number of `(model, property)` pairs is the expected count (declared in the test as a constant; bumped explicitly on PR if the corpus property set changes).
7. Run for each model a 10-trial determinism identity check: same seed, same bound, byte-identical verdict.

The gate is required-green on the `apalache-diff` CI job and is the gate the merge bot consults.

## What "agreement" means at the property level

A subtle point the team owes itself a paragraph on, because it shows up in every divergence-investigation conversation.

When the runner reports "10/10 agreement on 47/47 properties," what is the 47? The total property count is the sum, across all ten models, of the entries in each `[[entry]]`'s `properties` array. r1 has two properties (`glitch_free`, `monotone_clock`). r2 has two (`no_post_dispose_fire`, `dispose_throws_loud`). r3 has three (`stale_dep_dropped`, `fresh_dep_wired`, `recompute_on_dep_change`). And so on. The sum across the ten per-model TASKS is in the high forties; the exact number is pinned in the acceptance gate as a constant and bumped explicitly when the corpus property set changes.

What does "agreement on a property" mean? It is verdict equality up to the named soft-failure path. Both engines `Pass` is agreement. Both engines `Fail` with isomorphic witnesses is agreement. Both engines `BoundExceeded` is agreement (and is a signal that the corpus may have outgrown its bound, but is not a divergence). One engine `Pass` and the other `Fail` is hard divergence. Mixed `BoundExceeded` is the soft-failure path documented above.

A point Lamport made on draft review: it is *not* agreement on the witness *trace* — Apalache and the enumerator may construct different counterexamples for the same property failure, and that is fine, because both counterexamples are valid witnesses to the same negation. The runner only checks witness *isomorphism* on the *final state* and the identifier bindings, not the path through state space. If we ever want stricter trace-level agreement, that is an enrichment of `Witness`, but it would also be a substantial broadening of the corpus's claim, and the team is not yet ready to pin to it.

A second point: properties are *named* identifiers, not anonymous indexes. The TLA+ side declares `glitch_free == ...` by name; the Rust scenario declares `Property { name: "glitch_free", check: |trace| ... }` with the same string. The join is `HashMap<(model_id, property_name), Verdict>`. A property named differently on the two sides is a join failure caught by `test_verdict_join_missing_property_fails_loud`; this is the most common drift the team has seen on similar corpora and the runner is loud about it on purpose.

## Post-acceptance health checks

Three checks the team runs after the acceptance gate goes green, to catch the failure modes the gate cannot.

**Check 1: corpus-prose drift audit (manual, every six months).** A reviewer reads each `.tla` file's header comment, the §9.1 row prose it quotes, and the corresponding Rust scenario, and writes one paragraph in `tools/enumerator/corpus/AUDIT.md` confirming they all encode the same scenario. The audit lives in the repo; a stale audit (older than six months by file mtime) trips a soft warning in the `apalache-diff` CI job. The point of the audit is to catch the case where §9.1 prose drifted (because of an unrelated PR) and the corpus did not follow.

**Check 2: Apalache version-bump dry run (manual, on every Apalache release the team considers).** The on-call engineer pulls the new Apalache version locally, runs the corpus, diffs the verdict set and the witness set against the current pinned version. If the diff is empty, the team bumps the pin. If the diff is non-empty on the verdict set, that is an Apalache regression or improvement and the team investigates before bumping. If the diff is non-empty on the witness set only (same verdicts, different witnesses), that is benign — Apalache may have shifted to a different counterexample in `Fail` cases — and the team bumps after updating any tests that pinned a specific witness shape.

**Check 3: enumerator-side regression watch (automated, nightly).** The nightly schedule in `checker-diff.yml` runs the corpus against `main`. A nightly red flags either (a) a non-deterministic Rust enumerator (which violates EPIC-3's determinism contract and is itself a hard bug to fix) or (b) an Apalache-side flake (rare but observed in the field — a JVM GC pause crossing the 60-second timeout). The nightly's job is to make either failure visible the morning after, not the week before a release.

## Risk register

Beyond the three risks in the brutal-critical review, the team is tracking these residual risks explicitly so they live in the merge-time review surface and not just in this paragraph.

- **R-1 (probability: low; impact: medium): Apalache CLI surface change.** A future Apalache major version changes the `--length` flag name or the stdout verdict format. Detection: `test_apalache_subprocess_invocation` and `test_apalache_stdout_parsed_to_verdict` both go red. Mitigation: the version pin is the firewall; we do not auto-bump.
- **R-2 (probability: medium; impact: low): JVM startup variance breaks the 60-second per-model timeout in CI.** Detection: nightly red. Mitigation: bump the per-model timeout to 90 seconds (already the runner's subprocess timeout); if 90 is not enough, the per-model bound is too high and we revisit the model.
- **R-3 (probability: low; impact: high): a Rust enumerator regression that happens to verdict `Pass` on every corpus property even though the enumerator is broken.** Detection: only the negative encodings catch this; if the team forgets to ship a negative encoding for a model, that model's corpus seat is wasted. Mitigation: every per-model TASK in TASK 7.2 ships *two* `.tla` files (the canonical pass-encoding and the negative fail-encoding); `test_apalache_check_passes` asserts both directions; the absence of a negative encoding is itself a test failure.
- **R-4 (probability: medium; impact: low): the witness-isomorphism check is too strict and false-positive-divergences on benign witness shape differences.** Detection: a divergence row in `apalache-diff-report.md` with the witnesses printed, and a reviewer reading them concluding "these are the same scenario, our isomorphism check is wrong." Mitigation: the named-exception path in `mapping.toml`; the reviewer files an issue against the witness check, adds a temporary exception, fixes the check, removes the exception. Every exception's lifetime is bounded by its `tracking_issue` URL, which is required-non-empty.
- **R-5 (probability: low; impact: medium): the corpus's `.tla` files use Apalache features that are deprecated in a future Apalache version.** Detection: `apalache check` warns or errors. Mitigation: the corpus uses a deliberately small subset of TLA+ documented in `tools/enumerator/corpus/apalache/CONVENTIONS.md`; that subset is reviewed against Apalache's documentation on every version-pin bump.

## Acceptance order and merge sequencing

This EPIC's four tasks merge in this order:

1. **TASK 7.1 first.** Directory structure, `mapping.toml` schema, structural tests. Ten placeholder `.tla` and `.scenario.rs` files (each containing only a header comment with the §9.1 row reference and a no-op body that satisfies the structural tests). On merge, the structural tests are green; the runner does not exist yet.
2. **TASK 7.3 second.** The runner crate. With TASK 7.1's placeholders in place, the runner can be unit-tested against synthetic verdict streams without needing the actual TLA+ models to be filled in. The unit tests in `tests/runner_unit.rs` are all synthetic-input; they pass at this point. The acceptance gate `tests/acceptance/full-corpus.rs` does *not* pass yet because the placeholders verdict trivially.
3. **TASK 7.2 third (ten sub-tasks, parallelisable).** Each model's `.tla` and `.scenario.rs` and per-model test file. As each lands, the per-model unit tests (`r{n}_test.rs`) go green. The acceptance gate goes green only when all ten land.
4. **TASK 7.4 fourth.** The CI workflow. Adding the workflow before TASK 7.2 is complete would red-flag every PR; we add it after the corpus is whole, then it stays green by construction.

If the team is short on review bandwidth, TASK 7.2's ten sub-tasks are the natural unit of parallelism; one reviewer per model is feasible because each model is small.

## Out of scope

- **The bounded enumerator (EPIC-3).** This EPIC consumes EPIC-3's public verdict surface and adds nothing to the enumerator itself. If EPIC-3 changes its public surface, this EPIC follows in the same PR.
- **Adding new §9.1 rows that need new corpus models.** Each new row is a separate EPIC. The team explicitly does not slow-drip `r11.tla`, `r12.tla` into this EPIC's directory; growing the corpus is a named follow-up with a named reviewer.
- **Adopter-written hypotheses.** Apalache cannot run on adopter-written hypotheses. The corpus is hand-written and stays small by design (per §16.5.1 explicitly).
- **Cross-graph corpus.** Multi-graph composition is §13.3 NOT-PLANNED; if it ever reopens, a cross-graph corpus is its own EPIC, not an extension of this one.
- **Performance budgets on the runner.** The CI job has a twenty-minute timeout; the per-model timeout is sixty seconds; that is the budget. There is no nanosecond-level perf gate on the runner because the corpus is read-only data and the runner is shelled subprocesses.
- **Apalache version-bump automation.** When Apalache ships a new version, the team bumps the pin manually, re-runs the corpus, files any new divergences as bugs, and merges. There is no Renovate/Dependabot rule on the Apalache pin; the bump is a deliberate human decision.
- **Translation of the TLA+ form into the Rust scenario form (or vice versa).** Both forms are hand-written; auto-translation was rejected on the §16.5.1 review (Apalache wants restricted-syntax models, not arbitrary TypeScript `compute`; the IR is not a TLA+ subset). If a future tool generates one form from the other, that tool is its own EPIC.
