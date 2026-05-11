# EPIC: SARIF output + `--passes` CLI flag

**Status (as of v0.9.0): SHIPPED.** Tracking issue [#465](https://github.com/iasbuilt/causl/issues/465) closed 2026-05-03; sub-tasks #470 (`sarif.rs` module), #473 (`--format sarif` flag), #483 (docs + man page) all merged. Follow-on hardening landed in #572 (suppression machinery + SARIF `physicalLocation`, PR #598), #599 (`--suppress` CLI flag), and #605 (`--passes race` group alias). The four §16A.2 lint passes from EPIC-2 (#464) shipped against the rule table this EPIC stood up, so SARIF output today exposes 12 rule rows, not 8 — see "Current state" callout under TASK 5.1 below.

**Spec anchors:** §16A.2 (SARIF rules per pass), §16A.2.1 (--passes flag).

**Risk:** LOW — additive CLI surface; existing JSON / JSON-compact / text output unchanged.

**Dependencies:** none upstream. Compatible with EPIC-1 (Schema 3) once it lands; SARIF rule metadata adds rows for the four new passes at that point. **(Resolved post-ship.)** EPIC-1 (Schema 3 IR) and EPIC-2 (four §16A.2 lint passes) both landed; the rule table now carries 12 rows. EPIC-1 wired `physicalLocation` end-to-end via PR #598 / issue #572.

## What I'm shipping

We are landing a `tools/checker/src/sarif.rs` module that takes the existing `causl_check::Report` value — the one already serialized today by `--format json` — and converts it to a SARIF 2.1.0 document. The conversion is a pure function: `Report::to_sarif(&self) -> SarifReport`. No new state, no new threads, no new IR. The eight SARIF rule rows (`causl/schema-mismatch`, `causl/bound-exceeded`, `causl/unknown-dep`, `causl/cycle`, `causl/determinism-mismatch`, `causl/non-monotonic-commit`, `causl/glitch-propagation`, `causl/orphan-dep`) are baked into a static rule table that the `tool.driver.rules` array reads from, gated on the `passes_run` set so we never advertise rules we did not actually run. Wirfs-Brock's reminder is the load-bearing one for this module: **the SARIF wire format is the contract**, and we owe adopters a flat, predictable shape that GitHub Code Scanning, VS Code's `sarif-viewer`, and `sarif-validator` can all consume without surprise. We picked SARIF 2.1.0 because it is the version GitHub Code Scanning ingests directly with no transform; SARIF 2.2 (still in OASIS draft as of this writing) buys us nothing.

The CLI surface grows by exactly one variant: today's `Format` enum is `Json | JsonCompact | Text`, and we extend it to `Json | JsonCompact | Text | Sarif`. `--format sarif` writes a pretty-printed SARIF document to stdout; informational chatter (e.g., `bounded_out=true`, `passes_run=[…]`) goes to stderr where it always has. The exit-code semantics are unchanged: 0 if `report.violations.is_empty()`, 1 otherwise, 2 on internal error. We do **not** invent SARIF-specific exit codes — adopters scripting `causl-check --format sarif | github-upload` get the same 0/1 contract they get from `--format json`. The `--format sarif --compact` combination outputs single-line SARIF for log scrapers; bare `--format sarif` is pretty-printed for human review.

The `--passes` flag accepts a comma-separated list of named groups and per-pass kebab-case identifiers, with `-name` for exclusion. The accepted vocabulary is: `core` (the original 8), `lifetime` (the four §16A.2 passes once EPIC-2 lands), `all` (literal default), and the kebab-case names of every `PassName` variant in scope. Hejlsberg's framing is the load-bearing one for the parser: **`core`, `lifetime`, and `all` are the only literal-string groups**, and the `clap` value-parser closes over them as a `Group` enum — anything else is rejected at CLI-parse time with a structured error that lists the legal names. This is the same closure discipline `tsc`'s `--target` flag enforces (`es5 | es2015 | … | esnext`, no free strings); the parser is a discriminated union, not a string-bag. The `--passes=core,-glitch-propagation` form means "expand `core` to its 8 members, then subtract `glitch-propagation`" — set algebra over a closed alphabet, which is exactly the shape Hejlsberg asks for so the help text can enumerate the legal universe.

This EPIC ships **today**, ahead of EPIC-1 (Schema 3) and EPIC-2 (the four lifetime passes). Nothing in the SARIF adapter or the `--passes` parser depends on schema-3 IR, on the lifetime passes, or on the bounded enumerator. The SARIF rule table starts with the 8 rows we have. The `lifetime` group exists in the vocabulary today but expands to the empty set in this build — `--passes=lifetime` runs nothing and emits a structured warning to stderr saying "no lifetime passes are compiled into this build; rerun after EPIC-2 lands". The same warning fires on `--passes=all` once EPIC-2 ships, except that `all` will then expand to the full 12. We are paying the parser cost once, not twice.

> **Current state (as of v0.9.0).** EPIC-2 (#464) shipped: the `lifetime` group now expands to the four §16A.2 passes, `all` expands to the full 12, and the empty-set warning code path is dormant. The `--passes=race` alias added in #605 is a convenience grouping over the lifetime + glitch-propagation subset. The implementation lives in `tools/checker/src/sarif.rs` and the parser in `causl_check::parse_passes_spec` (consumed by `tools/checker/src/main.rs`).

## Brutal-critical review

**SARIF 2.1.0 is verbose, and a careless port produces a six-deep object that nobody can grep.** SARIF's spec lets us nest `runs[0].invocations[0].toolExecutionNotifications[0].locations[0].physicalLocation.artifactLocation.uri` and we will refuse. Our shape is flat: every result has `ruleId`, `level`, `message.text`, and at most one `locations[0]` entry with `physicalLocation` (when source-mapped) or `logicalLocations` (when not). No `runs` array longer than 1 — we are a single-tool, single-invocation linter, not a multi-tool aggregator. No `taxonomies`, no `graphs`, no `webRequests`, no `webResponses`. The SARIF spec permits sparse use; we use it sparsely. The `sarif-validator` test in the TDD suite is the gate: anything we add that breaks 2.1.0 conformance fails CI before merge.

**The `--passes=core,lifetime` aggregation question — what does it mean? Today: the union of the two groups.** We considered three semantics. (a) Intersection — meaningless since the groups are disjoint. (b) Sequence — "run core, then run lifetime" — also meaningless because passes do not have side effects on each other beyond the Schema/Bounds short-circuit, which is unaffected. (c) Union — the legal interpretation. We settled on union: `--passes=core,lifetime` is identical to `--passes=all` once EPIC-2 lands, and identical to `--passes=core` until then. The exclusion form `--passes=core,-glitch-propagation` is read left-to-right as "build the union, then remove the named items"; since groups appear before exclusions in canonical CLI examples, we do **not** require lexical ordering — the parser sorts additions and subtractions internally. Documented in the README and the man page; tested with the order-flip fixture in TASK 5.3.

**Exit-code parity with `--format json`.** Adopters wire `causl-check --format json` into CI today and read exit code 1 as "violations found." We owe them the same contract for SARIF — anything else is a footgun. The trigger is `report.violations.is_empty()`, full stop. Not "the SARIF document has zero results entries" (which is the same thing, but stated against the wire format) and not "any rule had `level: error`" (which would lose `warning`-level findings). The integration test in TASK 5.2 asserts exit code 1 on a known-cycle fixture under `--format sarif` and exit code 0 on a clean fixture; same fixtures, same assertions, two formats.

**The `--passes` flag widens the testable surface by one combinatorial axis.** Today, `causl-check`'s behavior is parameterized by `Bounds` (four numeric knobs) and the model itself. After this EPIC, it is also parameterized by the pass-filter set. We are not testing the full power-set (`2^8 = 256` combinations today, `2^12 = 4096` after EPIC-2). We are testing the canonical groups (`all`, `core`, `lifetime`), one inclusion-only invocation, one exclusion-only invocation, and one mixed inclusion+exclusion invocation — six tests total, listed in TASK 5.3. Anything beyond that is yak-shaving the parser, not the linter.

**One thing we explicitly are NOT shipping: `--passes` as a config-file knob.** Adopters who want a fixed pass set in CI write a wrapper shell script or a `make` target. We refused to add a `causl-check.toml` for one flag; the flag itself is the config surface. If three more flags accumulate, we revisit. Today, no.

**A second thing we considered and refused: per-violation suppression via SARIF `suppressions[]`.** SARIF 2.1.0 supports a `suppressions` array on each result, with `kind: inSource | external` and a `justification` string. Adopters could in principle use this to suppress known false positives at the source level. We refused for two reasons. First, the existing in-tree suppression mechanism is `// causl-check: <rule> -- <reason>` comments per §16A.5, and we are not introducing a second mechanism that competes with the first. Second, suppression-via-SARIF requires the IR exporter to know about source comments, which is a §16A.5 responsibility, not a §16A.2 responsibility. When the IR exporter learns to extract suppression comments and emit them as `IRSuppress` records, the SARIF adapter grows a `suppressions[]` slot — that is EPIC-6 or later, not this EPIC. **(Resolved post-ship.)** The suppression machinery and SARIF `suppressions[]` mapping landed in #572 (PR #598) plus the `--suppress` CLI flag in #599 (PR #599). `tools/checker/src/suppressions.rs` is the module; `SuppressionStatus` is the variant the SARIF emitter consumes.

## Sub-issues (TASKS)

### TASK 5.1 — `tools/checker/src/sarif.rs` module + `Report::to_sarif()`

**Files:** `tools/checker/src/sarif.rs` (new), `tools/checker/src/lib.rs` (re-export `SarifReport`), `tools/checker/src/check.rs` (add `impl Report { pub fn to_sarif(&self) -> sarif::SarifReport }`).

**Cargo deps:** none new. We hand-write the SARIF struct tree against `serde_json` rather than pulling in `serde_sarif` — the latter is a 2k-line transitive that we do not need for an 8-rule output. Hejlsberg's exhaustive-match discipline applies: every `ViolationKind` arm in `to_sarif` is named, no wildcard, so adding `SubscribeWithoutDispose` later is a compile error until we add the SARIF row.

**Sketch of the module shape.** The struct tree we are committing to is small enough to fit in one screenful — that is the point. SARIF allows deep nesting; we take the floor.

```rust
#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct SarifReport {
    #[serde(rename = "$schema")]
    pub schema: &'static str,        // "https://…/sarif-2.1.0.json"
    pub version: &'static str,        // "2.1.0"
    pub runs: Vec<SarifRun>,          // always len == 1
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct SarifRun {
    pub tool: SarifTool,
    pub results: Vec<SarifResult>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct SarifResult {
    #[serde(rename = "ruleId")]
    pub rule_id: String,             // "causl/cycle"
    pub level: SarifLevel,           // Error | Warning | Note
    pub message: SarifMessage,
    pub locations: Vec<SarifLocation>,
}
```

The `SarifLevel` enum closes over three values — `Error | Warning | Note` — exactly the SARIF 2.1.0 alphabet. `ViolationKind::SchemaMismatch | BoundExceeded | UnknownDep | Cycle | DeterminismMismatch | NonMonotonicCommit | OrphanDep` map to `Error`; `GlitchPropagation` maps to `Warning` (it is a diagnostic, not a hard violation). When EPIC-2's lifetime passes land, `SubscribeWithoutDispose` is `Warning` outside React, `Error` inside (per §16A.2 row 1); the React-context check lives in the lifetime pass itself and is reflected in the `Violation`'s already-present `severity` slot once we add it (out of scope for this EPIC; today every lifetime violation will be `Error` until the slot lands).

#### TDD test suite (≥5 tests)

1. **`sarif_empty_report_has_no_results_but_full_rule_table`.**
   `Report { violations: vec![], passes_run: <full 8> }` → `runs[0].results == []` AND `runs[0].tool.driver.rules.len() == 8`. The rule table is keyed off `passes_run`, not off violations, so a clean run still advertises the rules we ran.
2. **`sarif_single_violation_round_trips_message_and_rule_id`.**
   `Report { violations: vec![cycle_violation_on("a")], … }` → `runs[0].results[0].ruleId == "causl/cycle"` AND `runs[0].results[0].level == "error"` AND `runs[0].results[0].message.text == "<the original message>"` AND `runs[0].results[0].locations[0].logicalLocations[0].name == "a"`.
3. **`sarif_two_violations_same_pass_share_rule_id`.**
   `Report { violations: vec![cycle_on("a"), cycle_on("b")], … }` → `runs[0].results.len() == 2`, both `ruleId == "causl/cycle"`, distinct `logicalLocations[0].name`. Rule table still has exactly one entry for `causl/cycle`.
4. **`sarif_output_passes_official_2_1_0_validator`.**
   Spawns `sarif-validator` (Microsoft's reference validator, pinned via `tools/checker/tests/bin/sarif-validator`) as a subprocess. Test fails if the validator reports any error against the SARIF 2.1.0 JSON Schema. We pin the validator binary into the repo so CI does not depend on a network fetch.
5. **`sarif_round_trip_via_serde_json_is_lossless`.**
   `let s1 = serde_json::to_string(&report.to_sarif())?; let v: SarifReport = serde_json::from_str(&s1)?; let s2 = serde_json::to_string(&v)?;` → `s1 == s2`. Catches accidental `#[serde(skip)]` or non-canonical field ordering.
6. **`sarif_property_test_random_reports_round_trip`.** (proptest) Generate random `Report` values via `proptest`'s `Arbitrary` impl; assert each one round-trips losslessly via the same shape as test 5. 1000-trial floor per §15.2 commitment 10. We constrain the strategy to `violations.len() <= 50` to keep the proptest budget within the per-PR window.

#### 5 concerns

1. **SARIF schema 2.1.0 conformance.** Validated against the official JSON Schema in test 4. We do **not** invent fields. If the SARIF 2.1.0 spec does not name a field, we do not emit it. Forward-compat to 2.2 lands as a separate PR when GitHub Code Scanning ingests it.
2. **`ruleId` namespacing.** `causl/<kebab-case-pass-name>` for engine passes (e.g. `causl/cycle`, `causl/glitch-propagation`). Once EPIC-2 lands, the four new rules use the same `causl/` prefix (`causl/subscribe-without-dispose`, etc.). The `causl/` prefix is non-negotiable — without it, GitHub Code Scanning cannot disambiguate our findings from another tool's `cycle` rule.
3. **Source-mapped locations.** Per §16A.5, every violation references `physicalLocation.artifactLocation.uri` + `region.startLine` when the source map is available. The current schema-2 IR has no source-map slot, so today every `Violation { node: Some(id) }` produces `logicalLocations: [{ name: id, kind: "node" }]` and **omits** `physicalLocation`. Once schema 3 lands with `callbackSite`/`callSite` strings, we add `physicalLocation` extraction; the spec example in §16A.2.1 (subscribe-without-dispose) is the target shape. SARIF allows either form. **(Resolved post-ship.)** Schema 3 landed via EPIC-1; `physicalLocation` extraction wired via PR #598 (issue #572). The `Violation` struct now carries an optional `PhysicalLocation { artifactLocation, region }` slot and the SARIF adapter serializes it whenever the IR carries a source map.
4. **No race condition.** Pure conversion, single-threaded, no shared mutable state, no I/O. `to_sarif()` takes `&self` and returns an owned `SarifReport`.
5. **Property test budget.** Proptest at 1000 trials runs in <2s on the workstation profile. We refuse to gate the per-PR budget on a slower fuzzer; if the SARIF adapter ever needs a 10k-trial run, it lives behind the `[model-check]` label per §16A.3.

**Worked output, single-cycle violation.** Given a model with a two-node cycle (`a -> b -> a`), the SARIF document we emit is:

```json
{
  "$schema": "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "causl-check",
        "version": "0.5.0",
        "informationUri": "https://causl.dev/checker",
        "rules": [
          { "id": "causl/schema-mismatch", "name": "schema-mismatch",
            "helpUri": "https://causl.dev/checker/schema-mismatch" },
          { "id": "causl/bound-exceeded", "name": "bound-exceeded",
            "helpUri": "https://causl.dev/checker/bound-exceeded" },
          { "id": "causl/unknown-dep", "name": "unknown-dep",
            "helpUri": "https://causl.dev/checker/unknown-dep" },
          { "id": "causl/cycle", "name": "cycle",
            "helpUri": "https://causl.dev/checker/cycle" },
          { "id": "causl/determinism-mismatch", "name": "determinism-mismatch",
            "helpUri": "https://causl.dev/checker/determinism-mismatch" },
          { "id": "causl/non-monotonic-commit", "name": "non-monotonic-commit",
            "helpUri": "https://causl.dev/checker/non-monotonic-commit" },
          { "id": "causl/glitch-propagation", "name": "glitch-propagation",
            "helpUri": "https://causl.dev/checker/glitch-propagation" },
          { "id": "causl/orphan-dep", "name": "orphan-dep",
            "helpUri": "https://causl.dev/checker/orphan-dep" }
        ]
      }
    },
    "results": [{
      "ruleId": "causl/cycle",
      "level": "error",
      "message": { "text": "Cycle in derived sub-graph: a -> b -> a" },
      "locations": [{
        "logicalLocations": [{ "name": "a", "kind": "node" }]
      }]
    }]
  }]
}
```

This is the shape every test in the TDD suite asserts against. It is also the shape the man page (TASK 5.4) reproduces verbatim so adopters can copy-paste a known-good output to compare against their own runs.

---

### TASK 5.2 — `--format sarif` CLI flag

**Files:** `tools/checker/src/main.rs`.

The change is a one-variant extension of the `Format` enum and one `match` arm:

```rust
#[derive(Copy, Clone, Debug, ValueEnum)]
enum Format { Json, JsonCompact, Text, Sarif }

// in run():
Format::Sarif => {
    let sarif = report.to_sarif();
    let json = if args.compact {
        serde_json::to_string(&sarif)
    } else {
        serde_json::to_string_pretty(&sarif)
    }.context("failed to serialise SARIF")?;
    writeln!(stdout, "{json}")
}
```

The `--compact` flag is added as a top-level boolean and applies to `Sarif` only (today; we may extend it to `Json` if adopters ask, but `JsonCompact` already covers that case via the existing variant — we picked `--compact` rather than collapsing `JsonCompact` into `Json --compact` because it would break adopters' existing CI invocations).

#### 5 concerns

1. **Backward compat.** `--format json` (the default) is unchanged in shape and exit-code behavior. `--format json-compact` and `--format text` are unchanged. Existing CI scripts that pipe `causl-check --format json` to `jq` continue to work without modification. The `Format` enum is `#[non_exhaustive]` so a future `Format::SarifGzip` does not break match sites in the binary.
2. **Pretty-printing default.** `--format sarif` is pretty-printed (multi-line, 2-space indent) because the canonical SARIF consumer is a human reading the file in VS Code's `sarif-viewer`. `--format sarif --compact` is single-line for log scrapers and CI artifact storage.
3. **stderr vs stdout.** SARIF goes to stdout. The existing stderr stream — `causl-check: <error>` on parse failure, `bounded_out=true` informational notes — is unchanged. Adopters running `causl-check --format sarif > findings.sarif 2> diagnostic.log` get exactly what they expect.
4. **Exit code.** 0 if `report.violations.is_empty()`, 1 if any violations, 2 on internal error (parse failure, I/O failure, etc.). Identical to `--format json`. Documented in the man page (TASK 5.4).
5. **CLI integration test.** `tools/checker/tests/cli/format-sarif.rs` invokes `causl-check --input fixtures/positive/cycle.json --format sarif`, captures stdout, pipes to `jq -e '.runs[0].results[0].ruleId == "causl/cycle"'`, asserts exit code 1 from the `causl-check` invocation and exit code 0 from `jq`. We use `assert_cmd` for the subprocess wrapper, which is already in `dev-dependencies`.

**One thing we considered and refused.** A `--format sarif-gzip` variant that emits gzipped SARIF for log-storage adopters. SARIF documents on a real codebase compress 10x — the storage saving is real. We refused because GitHub Code Scanning ingests plain SARIF and rejects gzipped uploads at the gateway. Adopters who need compressed storage gzip the file themselves (`causl-check --format sarif | gzip > findings.sarif.gz`); the cost is one shell pipe character. Not worth a CLI variant.

---

### TASK 5.3 — `--passes` flag + named groups

**Files:** `tools/checker/src/main.rs` (CLI parsing), `tools/checker/src/check.rs` (extend `check()` signature with `enabled_passes: Option<&HashSet<PassName>>`), `tools/checker/src/lib.rs` (re-export `PassFilter`).

The `Bounds` struct stays put — pass-filter state is not a bound, it is a routing decision, and Wirfs-Brock's separate-vocabulary rule applies. The new type is `pub struct PassFilter { enabled: HashSet<PassName> }` with two constructors: `PassFilter::all()` and `PassFilter::from_cli(&str) -> Result<PassFilter, PassFilterError>`.

The CLI parser is a `clap` value-parser closing over the closed alphabet `{core, lifetime, all}` ∪ `{kebab-case PassName variants}` ∪ `{-<same>}`. Anything else is a structured error before any pass runs. Hejlsberg's enum-closure discipline: the parser cannot accept a free-form string.

#### TDD test suite (≥6 tests)

1. **`passes_all_runs_every_compiled_pass`.**
   `--passes=all` → `report.passes_run == [Schema, Bounds, UnknownDep, Cycle, Determinism, Monotonic, GlitchPropagation, OrphanDep]` (today; 12 entries after EPIC-2).
2. **`passes_core_runs_only_the_original_eight`.**
   `--passes=core` → `report.passes_run` equals the same 8 today; after EPIC-2 lands, `core` is still these 8 and excludes the four lifetime passes.
3. **`passes_lifetime_today_runs_empty_set_with_warning`.**
   `--passes=lifetime` on this build → `report.passes_run == [Schema, Bounds]` (the always-on gates) and stderr contains `"warning: no lifetime passes are compiled into this build"`. After EPIC-2 lands, this test flips to assert `passes_run` contains the four lifetime passes; the test name stays so the diff is reviewable.
4. **`passes_explicit_list_runs_named_subset`.**
   `--passes=cycle,glitch-propagation` → `report.passes_run` contains `Cycle` and `GlitchPropagation` (plus the always-on `Schema` and `Bounds` gates), no other engine passes ran.
5. **`passes_exclusion_runs_complement`.**
   `--passes=-cycle` → `report.passes_run` is the full default set minus `Cycle`. Schema and Bounds always run; Cycle does not; everything else does.
6. **`passes_group_minus_named_pass_subtracts_correctly`.**
   `--passes=core,-glitch-propagation` → `report.passes_run` is the 8-element `core` set minus `GlitchPropagation`, i.e. 7 passes (plus Schema and Bounds, which are inside `core`).
7. **`passes_invalid_name_rejected_at_parse_time`.** (negative test)
   `--passes=cy-cle` (typo) → CLI exits with code 2 and stderr lists the legal pass names. No passes run, no SARIF emitted.

#### 5 concerns

1. **CLI parsing.** Invalid pass names produce a structured error before any pass runs. The error message lists the legal names (`core`, `lifetime`, `all`, plus the eight kebab-case variants today). Hejlsberg's framing: the parser is the closure boundary, not the runtime. `clap`'s `value_parser!(PassFilterArg)` does the work; we own a `FromStr for PassFilterArg` that owns the alphabet.
2. **Order stability.** Passes run in canonical order regardless of CLI order. `--passes=cycle,unknown-dep` and `--passes=unknown-dep,cycle` produce identical `passes_run` sequences (`[Schema, Bounds, UnknownDep, Cycle]`). The canonical order is the order declared on `PassName` in `check.rs`. Test 4 above is parameterized over both orderings to lock this in.
3. **Group expansion.** `core` and `lifetime` expand to their member sets at parse time, not at runtime. Subtraction (`-name`) applies after expansion. This means `--passes=core,-cycle` is meaningful (excludes `Cycle` from the core set), and `--passes=-cycle` alone means "everything except `Cycle`" (i.e., implicit `all` minus `Cycle`).
4. **`passes_run` truthful.** The `Report.passes_run: Vec<PassName>` records exactly what ran on this invocation, not what the user asked for. If `--passes=all` is given but the `Bounds` pass short-circuits, `passes_run` is `[Schema, Bounds]` and nothing else — same contract as today. The test in §16.1 (`bound_exceeded_short_circuits_other_passes`) still passes unchanged.
5. **No race condition.** Single-threaded CLI. The `PassFilter` is built once at CLI-parse time, threaded through `check()` by reference, and consulted by each pass's gate. No shared mutable state.

**The `PassFilter` parser, sketched.** Hejlsberg's enum-closure rule materialized:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PassToken {
    Group(PassGroup),                // core | lifetime | all
    Single(PassName),                // cycle | unknown-dep | …
    ExcludeGroup(PassGroup),         // -core | -lifetime | -all (rare; legal)
    ExcludeSingle(PassName),         // -cycle | -unknown-dep | …
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PassGroup { Core, Lifetime, All }

impl FromStr for PassToken {
    type Err = PassFilterError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (excl, name) = match s.strip_prefix('-') {
            Some(rest) => (true, rest),
            None       => (false, s),
        };
        // Closed alphabet: try group first, then per-pass kebab-case.
        if let Some(g) = PassGroup::from_kebab(name) {
            return Ok(if excl { PassToken::ExcludeGroup(g) }
                      else     { PassToken::Group(g) });
        }
        if let Some(p) = PassName::from_kebab(name) {
            return Ok(if excl { PassToken::ExcludeSingle(p) }
                      else     { PassToken::Single(p) });
        }
        Err(PassFilterError::Unknown {
            got: name.to_owned(),
            legal: legal_names_help_text(),
        })
    }
}
```

`legal_names_help_text()` returns the same string the `--help` output prints, so the parse-error and the help text never drift — Wirfs-Brock's contract-discipline rule applied to error messages. The `PassGroup::from_kebab` and `PassName::from_kebab` functions exhaustively match every variant; adding a `PassName` variant is a compile error in `from_kebab` until the kebab-case mapping is registered.

---

### TASK 5.4 — Documentation + man page

**Files:** `packages/checker/README.md`, `tools/checker/man/causl-check.1` (new), `docs/checker-coverage.md` (one new row in the existing table for the `--passes` flag's effect on coverage reporting).

Update the README's CLI section to document `--format sarif` and `--passes`, with worked examples for the canonical invocation patterns:

```bash
# Default JSON (unchanged from today)
causl-check --input model.json

# SARIF for GitHub Code Scanning
causl-check --input model.json --format sarif > findings.sarif

# Run only the original 8 (useful when EPIC-2 lands and you want
# to hold lifetime passes back during a migration window)
causl-check --input model.json --passes=core

# Run everything except the cycle pass (an adopter with a known
# false-positive on a meta-circular fixture)
causl-check --input model.json --passes=all,-cycle

# Run only the lifetime passes (post-EPIC-2)
causl-check --input model.json --passes=lifetime --format sarif
```

Add a man page generated via `clap_mangen` from the `Args` struct so `man causl-check` works after `cargo install --path tools/checker`. The man page is checked into the repo at `tools/checker/man/causl-check.1`, not generated at install time, so adopters on systems without `clap_mangen` still get it. The README links to §16A.2.1 of the spec for the pass catalogue and to the SARIF 2.1.0 spec for the output shape. The `docs/checker-coverage.md` table grows one row noting that `--passes=core` produces the same coverage profile the v1 build advertises today; `--passes=all` is the post-EPIC-2 target.

No new prose-policy commitments. The §17 commitment table is unchanged — commitment 8 (`causl-check ships as a required CI gate`) is held by the existing JSON output; adopters who want SARIF for GitHub Code Scanning opt in at their own CI workflow level.

---

## Acceptance gate

The fixture for the integration test is the already-existing two-node cycle model — we are reusing existing fixture material so the gate is anchored on the same wire shape the in-tree tests cover today. The fixture file at `tools/checker/tests/fixtures/positive/cycle.json` is:

```json
{
  "schema": 2,
  "time": 0,
  "nodes": [
    { "kind": "derived", "id": "a", "deps": ["b"], "conditionalDeps": [],
      "value": null, "serializable": true },
    { "kind": "derived", "id": "b", "deps": ["a"], "conditionalDeps": [],
      "value": null, "serializable": true }
  ],
  "commits": []
}
```

`tools/checker/tests/integration/sarif-and-passes.rs` — runs `causl-check --input known-cycle.json --format sarif --passes=core` against a fixture under `tools/checker/tests/fixtures/positive/cycle.json` and asserts:

1. Exit code is 1.
2. Stdout is valid SARIF 2.1.0 (validated by spawning `sarif-validator`).
3. `runs[0].results.len() == 1`.
4. `runs[0].results[0].ruleId == "causl/cycle"`.
5. `runs[0].results[0].level == "error"`.
6. `runs[0].tool.driver.rules` includes a row with `id: "causl/cycle"` and a `helpUri` pointing at `https://causl.dev/checker/cycle`.
7. The same invocation with `--passes=all,-cycle` produces exit code 0 and `runs[0].results == []`.

The two assertions together pin the contract: SARIF output shape, `--passes` filtering, and exit-code parity all in one fixture run.

## What the per-task tests buy

The TDD suites across the four tasks cover three orthogonal axes: SARIF wire-format conformance (TASK 5.1), CLI surface stability (TASK 5.2), and pass-filter set algebra (TASK 5.3). We considered consolidating into a single mega-fixture that exercises all three at once and rejected it — Wirfs-Brock's "small failures lead to small fixes" rule applies. Each task's test suite fails for a single, locally-diagnosable reason. The cross-task integration is the acceptance gate, which is a single test, not a pile.

The test counts:

- TASK 5.1: 6 tests (5 named + 1 proptest). Catches SARIF shape regressions per round-trip.
- TASK 5.2: 1 CLI integration test. Catches `--format sarif` exit-code drift.
- TASK 5.3: 7 tests (6 named + 1 negative-parse). Catches `--passes` set-algebra drift.
- Acceptance gate: 1 cross-cutting integration test. Catches the joint-contract drift.

Total new tests added by this EPIC: 15. The existing 12 tests in `tools/checker/src/lib.rs` and the existing fixtures under `tools/checker/tests/fixtures/` are unchanged. We are growing the test count by ~125% to ship two new CLI surfaces — the right ratio for additive, contract-bearing CLI work.

## Risk register

| Risk | Likelihood | Severity | Mitigation |
| --- | --- | --- | --- |
| SARIF 2.1.0 schema-validator binary is unavailable in CI | LOW | MEDIUM | Pin `sarif-validator` into `tools/checker/tests/bin/` so it ships with the repo; no network fetch at test time. |
| GitHub Code Scanning rejects our SARIF as malformed despite local validation | LOW | MEDIUM | Manual smoke test against a real GitHub repo before tagging the release; if it fails, hold the release and treat as a bug-fix sprint. |
| `--passes=lifetime` warning text drifts as EPIC-2 lands four passes piecewise | MEDIUM | LOW | Test 3 in TASK 5.3 asserts the warning text exactly; updating the text requires updating the test, which keeps the contract visible in code review. |
| Adopters wire `--passes=core` into CI and never update after EPIC-2 lands | MEDIUM | LOW | Coverage table in `docs/checker-coverage.md` calls out the gap; commitment 9 in §17.1 is held by the `race-detection-acceptance.rs` gate, which fails if any STATIC row in §9.1 has no fixture, regardless of CLI defaults. |
| `clap_mangen` man-page output drifts from the `Args` struct | LOW | LOW | Regenerate the man page locally and check in the diff; CI does not regenerate at install time. |
| Property test (concern 5 of TASK 5.1) introduces flakiness | LOW | MEDIUM | 1000-trial floor with a fixed seed for the proptest; non-flaky by construction. |

## Out of scope

- The four §16A.2 lifetime passes themselves (`SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`). Those land in EPIC-2, against the schema-3 IR from EPIC-1.
- The schema-3 IR bump (EPIC-1) — no changes to `tools/checker/src/ir.rs` in this EPIC.
- The `causl-check enumerate` subcommand and the bounded enumerator (EPIC-3 / §16.4 reopen).
- Source-map extraction from schema-2 IR — schema 2 carries no source-map slot, so today's SARIF output uses `logicalLocations` only. This is acknowledged in TASK 5.1 concern 3.
- A `causl-check.toml` config file. Discussed and refused above.
- Forward-compat to SARIF 2.2 — that is a separate PR when GitHub Code Scanning ingests it.

---

We three sign for this EPIC. Wirfs-Brock owns the SARIF wire-format contract and the `runs[0]` shape. Hejlsberg owns the `--passes` enum closure and the `clap` value-parser. The four passes from §16A.2 are not in this EPIC by design — we are paying for the SARIF and `--passes` infrastructure once, today, against the surface we have, so that EPIC-2 can land its four passes as pure additions to a rule table that already exists.

## Why this lands today, not after EPIC-1/EPIC-2

The temptation is to bundle: wait for Schema 3, then ship SARIF + `--passes` + four lifetime passes in one big PR. We refused that bundle for three reasons.

First, **adopters need SARIF today, not in three EPICs**. GitHub Code Scanning consumes SARIF; without it, our findings cannot surface in PR-review UI alongside `clippy`, `eslint`, and the rest. Holding SARIF until EPIC-1 lands means three more sprints where adopters integrating `causl-check` paste raw JSON into their CI summaries. That is a degraded experience we can fix today with a 200-line adapter.

Second, **the `--passes` flag is the migration valve EPIC-2 needs**. When the four lifetime passes land, adopters mid-migration will need to disable individual passes against legacy code while they fix it. If `--passes` is not in the binary by then, the EPIC-2 PR has to ship it as a co-dependency, which doubles its review surface. Landing `--passes` today means EPIC-2 ships against an already-stable filter contract.

Third, **the SARIF rule-metadata table is a pure addition**. The eight rows we register today are static; the four rows EPIC-2 adds are static; nothing about the existing eight changes. Adopters who upload SARIF to GitHub Code Scanning today see eight rule rows; after EPIC-2, they see twelve. Their CI workflows do not change. Their consuming SARIF viewers do not change. The only diff is more findings.

Wirfs-Brock's framing is the load-bearing one for the bundle question: **the wire format is the contract**, and the contract is forward-compatible. Locking the eight-row contract today and growing it to twelve later is exactly the discipline SARIF 2.1.0 was designed for. Hejlsberg's framing is the load-bearing one for the parser-closure question: **the alphabet is closed today, and adding to the alphabet is a recompilation, not a re-design**. `core`, `lifetime`, and `all` are the only group-literal strings we will ever accept; the per-pass kebab-case set grows mechanically from `PassName`. There is no semantic surface to redesign when EPIC-2 lands.

## Rollout plan

The PR sequence inside this EPIC is:

1. **PR 5.1** — `tools/checker/src/sarif.rs` module + `Report::to_sarif()` + tests. No CLI surface change yet; the new method is reachable only from tests. Lands first because it is the largest single change and the most reviewable in isolation.
2. **PR 5.2** — `--format sarif` flag wired into `main.rs`. Tiny diff against `Format` enum, one match arm, one CLI integration test. Lands second because it depends on PR 5.1.
3. **PR 5.3** — `--passes` flag + `PassFilter` + threading through `check()`. The largest CLI-facing change; lands third because it touches `main.rs`, `lib.rs`, and `check.rs`. Adds the six tests above.
4. **PR 5.4** — README + man page + `docs/checker-coverage.md` row. Pure documentation, no code change. Lands last so the documentation reflects the final shipped surface.

Each PR is independently revertible. PR 5.2 reverting does not break PR 5.1 (the SARIF module is still there, just unreachable from CLI). PR 5.3 reverting leaves PR 5.1 and 5.2 intact; we lose `--passes`, we keep `--format sarif`. The `--passes` flag does not depend on the SARIF format, and `--format sarif` does not depend on `--passes` — they are orthogonal CLI extensions that happen to ship in the same EPIC because they share a release cycle and a review surface.

## What we explicitly verified before signing

We checked that `tools/checker/Cargo.toml` already pulls in `serde`, `serde_json`, `clap` — the three crates the new code reaches for. No new dependencies. We checked that `tools/checker/src/check.rs` exposes `PassName` as `pub`, `#[non_exhaustive]`, with `#[serde(rename_all = "kebab-case")]` — meaning the kebab-case mapping the `--passes` parser needs is already canonicalized by `serde`. We checked that `Report` is already `Serialize` — meaning the SARIF adapter consumes it via owned read-only access, no refactor needed. We checked that the existing tests in `tools/checker/src/lib.rs` exercise the `passes_run: Vec<PassName>` invariant we are extending; the `passes_run_records_full_suite_on_clean_model` test is the canary that catches accidental short-circuits.

The pre-existing test discipline is the foundation. We are extending it, not rewriting it.

## Open questions deferred to implementation

These are calls we did not lock down at spec-time because the right answer falls out of the implementation, not the design:

1. **`tool.driver.version`** — do we read from `env!("CARGO_PKG_VERSION")` or from a `causl_check::VERSION` constant? Neither breaks the contract; the implementer picks. Today's version-lockstep workflow per §16A.2 PR-A keeps Cargo and npm versions aligned, so either source is correct. If `cargo` decides, the constant lives in one fewer place.
2. **`tool.driver.semanticVersion`** — SARIF 2.1.0 has both `version` and `semanticVersion`. We emit both and they are identical. If a future SARIF consumer cares about the distinction, we revisit.
3. **`runs[0].invocations[0]`** — SARIF allows recording the invocation arguments, working directory, and start/end timestamps. We do not emit `invocations` today because the data is not load-bearing for adopters; if a CI system asks for it, we add the slot. The wire format permits the omission.
4. **Help URLs for the eight existing rules.** The acceptance gate names `https://causl.dev/checker/cycle` etc. as the `helpUri`. If the docs site is not yet at that path, the implementer points the URLs at the temporary docs path and files a follow-up to redirect. The `helpUri` is a discoverability nicety, not a contract surface.
5. **Whether to emit `level: "warning"` for `GlitchPropagation` versus `level: "note"`.** Today we say `Warning` because the existing JSON output does not distinguish; SARIF gives us a third level. If adopters report noise from `glitch-propagation` warnings, we downgrade to `note`. The mapping is one line in `sarif.rs`.

These five questions are the implementer's discretion, not the team's. We name them so the PR review knows where to expect plausible variation.

## Team vote

We held a working session on the SARIF + `--passes` shape and called the vote at the end:

- **Wirfs-Brock (lead, SARIF wire format).** YES. The contract is forward-compatible, the eight rule rows are stable, the `runs[0]` shape is flat. SARIF 2.1.0 is the version GitHub Code Scanning ingests; SARIF 2.2 is a future PR. The `helpUri` discipline catches discoverability gaps in review. We are paying the wire-format cost once, today, against the surface we have, and the four lifetime rules land as additions to a stable rule table when EPIC-2 ships.
- **Hejlsberg (lead, `--passes` enum closure).** YES. The alphabet is closed: `core`, `lifetime`, `all`, plus the kebab-case `PassName` set. The `clap` value-parser closes over the alphabet at parse time. Anything outside the alphabet is a structured error before any pass runs, with the legal vocabulary in the help text. The set-algebra discipline (group expansion, then exclusion) is the same shape `tsc`'s `--lib` flag enforces. Adding a `PassName` variant is a compile error in `from_kebab` until the kebab-case mapping is registered — exhaustive, no drift.
- **Miller (advisory, runtime-vs-static framing).** YES with the framing reminder noted: every pass we land here is a check the runtime would otherwise have to make every time the program runs. The `--passes` flag is the migration valve that lets adopters disable individual static rules while leaving the runtime checks intact. The two layers are not interchangeable; the static layer is the cheap version of the runtime layer. The flag does not weaken the contract — it lets adopters move pass-by-pass.

Three YES votes. The EPIC ships.

## Closing

Wirfs-Brock's framing closes this EPIC. The wire format is the contract, and the contract is what adopters integrate against. Today's eight rule rows are stable; tomorrow's twelve rule rows are an addition, not a rewrite. Hejlsberg's framing closes the parser. The alphabet is closed; the parser is a discriminated union; anything outside the alphabet is rejected before any pass runs. Miller's framing closes the loop. Every check we lift forward from runtime to static is a check we make once per CI run, not once per program execution. The four lifetime passes pay that price in EPIC-2; the SARIF + `--passes` infrastructure pays it today. The infrastructure is the cheap part. We ship it now.
