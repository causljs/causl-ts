# EPIC: Four §16A.2 lint passes (PR-B + PR-C)

**Status (as of 2026-05-10):** SHIPPED / CLOSED via GH issue #464 (closed 2026-05-03). All four passes (`SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`) shipped against the schema-3 IR (EPIC-1 PR-A #462 + PR-B1 #463) with their positive/negative fixtures, SARIF rule metadata, false-positive suppression hooks, and `--passes` CLI integration (EPIC-5 #465 shipped in the same Phase-7 window). Row 1 (concurrent engine mutations) and row 11 (use-after-dispose on family nodes) graduated from RUNTIME-ONLY into STATIC under §16A.1 the day this EPIC merged.

**Spec anchors:** §16A.2 (narrative), §16A.2.1 (formal pass specs, IR pattern,
algorithm, fixtures, SARIF), §16A.1 (layer classification — rows 1, 11 lifted
out of RUNTIME-ONLY into STATIC), §17.1 commitment 9 (the §9.1 STATIC subset
is fully covered by `causl-check`).

**Risk:** LOW — additive, no schema break. The schema break is EPIC-1's
problem; this EPIC inherits the schema-3 IR types and walks them. The four
new passes register new `ViolationKind` and `PassName` variants on enums
already marked `#[non_exhaustive]` (`tools/checker/src/check.rs:92`,
`tools/checker/src/check.rs:115`), so existing SARIF consumers and
`Report` JSON consumers are not source-broken — they are merely not yet
aware of the new kinds, which is what `#[non_exhaustive]` exists for.

**Dependencies:** EPIC-1 (Schema 3 IR foundation) MUST land first; without
it, none of the four passes have IR fields to walk. Concretely: PR-A in
§16A.2 ships `IrEvent`, `IrScope`, `IrBridge`, `graphId` per node, and the
`originEvent: Option<EventId>` slot on `IrCommit`. This EPIC is PR-B + PR-C
in the §16A.2 "Implementation slicing" plan and reads those fields. We do
not ship until EPIC-1 has merged and the schema-3 fixtures are green on
the existing eight passes.

**Dependency resolution (post-ship note):** EPIC-1 shipped in two slices — PR-A
(#462) which laid the foundation (`graphId`, optional `IRCallGraph`,
`events: never[]` forward-compat) and PR-B1 (#463) which widened `IREvent`
to the six-variant union and added the top-level `bridges` / `scopes` fields
this EPIC's passes consume. The deliberate slicing came out of the
brutal-critical review (#584 tracked the 12 unaddressed recommendations) and
let EPIC-2's pass algorithms drive the variant shapes in code review rather
than guessing.

## What I'm shipping

I — speaking for Wirfs-Brock, Hejlsberg, and Miller, with Beck riding the
TDD discipline — am shipping the four lint passes the §16A.2.1 formal
spec writes down: `SubscribeWithoutDispose`, `CommitFromSubscribe`,
`CrossGraphRead`, and `UseAfterDispose`. Each pass is a pure function of
shape `&CauslModel -> Vec<Violation>`, registered in `check()` after the
existing eight (`tools/checker/src/check.rs:181-249`), behind a fixed
order: leak detection (`SubscribeWithoutDispose`) before timing detection
(`CommitFromSubscribe`, `UseAfterDispose`), and topology (`CrossGraphRead`)
runs in between. Each pass adds one `ViolationKind` variant, one
`PassName` variant, one positive fixture, one negative fixture, one
expected SARIF document, and one block of false-positive suppression
hooks called out in §16A.2.1. The `--passes` CLI flag — `core`, `lifetime`,
`all`, the per-pass kebab-case names, and the `-pass-name` subtraction
form — ships in TASK 2.5, threaded through `check()` as
`enabled_passes: Option<HashSet<PassName>>` per the §16A.2.1
"Cross-pass interactions" sub-section.

**Miller's framing is the load-bearing one.** Each of the four passes
lifts a runtime-checked capability into a static rule. `CommitInProgressError`
and `NodeDisposedError` are runtime exceptions today: every program that
runs pays the cost on every run. After this EPIC merges, the cost is paid
once in CI per IR export. That is the entire point of the four passes —
not new diagnostic surface, but the same diagnostic surface moved from
runtime to compile-time-equivalent for the bounded prefix the IR captures.
Row 1 (concurrent engine mutations) and row 11 (use-after-dispose on
family nodes) graduate from RUNTIME-ONLY into STATIC under §16A.1 the day
this EPIC lands, which is precisely how §17.1 commitment 9 closes its
MECHANICAL anchor for the §9.1 STATIC subset.

**Wirfs-Brock's discipline is the wire-format-as-contract one.** Every IR
pattern in the four passes is expressed against the on-disk JSON shape —
`{"kind": "subscribe", "id": ..., "scopeId": ..., "target": ...,
"callbackSite": ...}` — not against the in-memory Rust types that may
drift. The Rust types `IrEvent`, `IrScope`, `IrBridge` are convenience;
the JSON is the contract. Adopters' SARIF consumers, version-locked
`@causl/checker` npm wrappers, and the release-checker workflow
(`.github/workflows/release-checker.yml`, pinned at the
schema-2-vs-schema-3 boundary by EPIC-1) all key off the wire shape, not
the Rust shape. Each fixture in `tools/checker/tests/fixtures/` is a JSON
file the spec already pasted (§16A.2.1 positive and negative blocks,
copied byte-for-byte) — that is the authoritative source, and our Rust
types must round-trip it.

**Hejlsberg's discipline is the exhaustiveness one.** Every match in the
four passes is exhaustive. The `IrEvent` enum is `#[non_exhaustive]`
externally (so the schema-3 spec can grow `IRTxSet`, `IRUnsubscribe`,
and the rest of the union without breaking adopters), but inside the
checker every variant is named in every match arm, with a default arm
that explicitly continues when the variant is irrelevant to that pass.
We do not write `_ => continue` as a catch-all and forget about it — we
write `IrEvent::Subscribe(_) | IrEvent::Dispose(_) | IrEvent::TxSet(_) =>
continue` in the use-after-dispose pass and accept that adding a new
variant will fail the build until somebody decides what the new variant
means in this pass. That is the cost of the discipline; it is the cost
that pays for soundness when schema 4 lands.

**Beck's discipline runs the test plan.** Every pass ships with a
positive fixture (the bug we're catching), a negative fixture (the
non-bug that adopters reading the spec will doubt the most — "but my
correct code looks like this and you'll false-positive me, won't you?"),
plus the SARIF byte-for-byte fixture, plus three suppression-mechanism
fixtures (per-site comment, scope annotation, exemption file) for each
pass that has suppression mechanisms. The negative fixture is
non-negotiable: it is the honest demonstration that the pass does not
fire on the most-doubted shape. Acceptance is binary: each pass has at
least one positive fixture that produces exactly one violation of the
expected `ruleId`, at least one negative fixture that produces zero
violations, and a SARIF document that matches `expected.sarif.json`
byte-for-byte. No flake budget, no "approximately matches" — byte-for-byte.

## Brutal-critical review

The §16A.2.1 spec is solid on the IR pattern and the algorithm. It is
honest about the false-positive surface (§16A.2.1 "False-positive
examples" blocks, three per pass), and the suppression hooks have been
designed against real adopter shapes — process-lifetime `main()`,
two-graph mirrors, optimistic UI rollback, replay/time-travel debuggers.
The risks I — speaking with Wirfs-Brock, Hejlsberg, Miller, and Beck —
flag are these:

**False-positive rates per pass, against the §16A.2 published
estimates.** The narrative §16A.2 says <2% under the React boundary,
~10% in raw-engine scripts (`SubscribeWithoutDispose`); <1%
(`CommitFromSubscribe`); 0% by construction (`CrossGraphRead`); ~5% on
family-keyed nodes (`UseAfterDispose`). The 0% claim for
`CrossGraphRead` is the load-bearing one and the one we have to defend
in code: it is 0% IFF the IR carries `graphId` per node AND every
cross-graph read goes through a declared `IRBridge`. EPIC-1 ships the
former; this EPIC ships the latter, and we will not merge it until the
100-fixture sweep in TASK 2.3 confirms zero false positives across the
adopters' published-graph corpus. If that sweep finds a single
false-positive shape we have not anticipated, the spec gets revised
before this EPIC merges — not after.

The ~5% rate on `UseAfterDispose` is the second-most-uncomfortable
number. Family-keyed nodes whose disposal happens in a sibling subtree
the IR doesn't model are genuinely outside the bounded prefix the IR
captures, and §16A.1 row 11 is honest that the PROPERTY layer is
still load-bearing for that 5%. We do not pretend STATIC catches what
PROPERTY catches; we add the static rule for the 95% it does catch and
keep `disposed-tombstone-bound.test.ts` running for the 5%.

The <1% rate on `CommitFromSubscribe` depends on the call-graph
annotation being present and correct on every `IRCommit`. EPIC-1 ships
the slot; the TypeScript exporter populates it from the engine's
existing dirty-walk frame stack. If the exporter ever fails to populate
the slot, the pass under-reports — silent false negatives, not noisy
false positives. We mitigate with a Schema-pass invariant in EPIC-1 that
fails the model on `originEvent: undefined` (vs `originEvent: null`,
which means "no origin event recorded"). That invariant is EPIC-1's
deliverable but we cite it here because if it slips, our pass goes
quiet.

**Order-dependence: the four passes run sequentially; `CrossGraphRead`
does NOT short-circuit `UseAfterDispose`. Why we made that call.** The
§16A.2.1 "Cross-pass interactions" sub-section is explicit: a
cross-graph read that is also a use-after-dispose is two findings, not
one, because adopters fix them with different code changes. The
short-circuit alternative — "if `CrossGraphRead` fires on this read,
skip `UseAfterDispose`" — would hide a use-after-dispose bug behind a
cross-graph-read fix. The adopter ships the bridge declaration, the
cross-graph-read goes silent, the use-after-dispose was always there
and is now invisible. We rejected that. Schema and bounds gates from
the existing 8-pass suite still short-circuit *all* downstream passes,
because those gates mean "the IR is unintelligible" and running passes
on an unintelligible IR is non-sense; that is preserved. Inside the
12-pass suite, no pass short-circuits any other pass.

**The `--passes` flag's named groups (`core` vs `lifetime`) — what about
adopters who want a bespoke combination?** The spec gives `all`, `core`,
`lifetime`, plus per-pass kebab-case names, plus the `-name` subtraction
form. That covers: "I want everything" (`--passes=all`), "I want the
v1.0 behaviour back" (`--passes=core`), "I only want the §16A
additions" (`--passes=lifetime`), and "I want everything except this one
pass that's noisy in my CI today" (`--passes=-cross-graph-read`). It
does not cover "I want a custom group called `audit-only` that's three
specific passes." We rejected user-defined groups. The reason is the
§17.2 MECHANICAL contract: the gate's behaviour must be reproducible by
inspection of the source repo, and per-team aliases drift. An adopter
who genuinely wants `subscribe-without-dispose,use-after-dispose` writes
that comma list in their `causl.config` once, commits it, and reviewers
can read it. We will revisit if three or more adopters ask; today, no.

## Sub-issues (TASKS)

### TASK 2.1 — `SubscribeWithoutDispose` pass + fixtures + SARIF

Per §16A.2.1's IR pattern. The IR pattern: for every `IRSubscribe { id,
scopeId, target, callbackSite }` in `model.events`, look up
`IRScope { id: scopeId, kind, lifetime }`; emit a violation iff there is
no matching `IRDispose { subscribeId: id }` in `model.events` AND the
scope's `kind` is not `"infinite"` AND the scope's lifetime terminator
is not `"process-exit"`.

Files:
- `tools/checker/src/check.rs` — new `subscribe_without_dispose_pass`
  function around line 250 (after the existing eight); new
  `ViolationKind::SubscribeWithoutDispose` variant on the enum at line
  92; new `PassName::SubscribeWithoutDispose` variant on the enum at
  line 115; registration in `check()` at line 240 (after `OrphanDep`).
- `tools/checker/src/sarif.rs` — new module (does not exist today;
  EPIC-1 may have created the file or this task creates it). Holds
  rule metadata: `causl/subscribe-leak`, `helpUri:
  https://causl.dev/checker/subscribe-without-dispose`, default level
  `warning`, escalated to `error` under React-boundary scopes (detected
  by `scope.lifetime.origin == "react-mount"`).
- `tools/checker/tests/fixtures/subscribe-without-dispose/positive.json`
  — copied byte-for-byte from §16A.2.1 "Positive fixture" block.
- `tools/checker/tests/fixtures/subscribe-without-dispose/negative.json`
  — copied from §16A.2.1 "Negative fixture" block (subscribe paired
  with matching dispose).
- `tools/checker/tests/fixtures/subscribe-without-dispose/expected.sarif.json`
  — copied from §16A.2.1 "Expected SARIF" block.
- `tools/checker/tests/fixtures/subscribe-without-dispose/infinite.json`
  — new edge-case fixture; subscribe in a scope marked `kind: "infinite"`.
- `tools/checker/tests/fixtures/subscribe-without-dispose/process-exit.json`
  — new edge-case fixture; subscribe in a scope whose lifetime terminator
  is `"process-exit"`.

#### TDD test suite (5 tests minimum)

1. **Positive fixture: ephemeral subscribe with no dispose.** Load
   `tests/fixtures/subscribe-without-dispose/positive.json`; assert
   `report.violations.len() == 1`; assert
   `violations[0].kind == ViolationKind::SubscribeWithoutDispose`;
   assert `violations[0].node == Some("count".into())`; assert the
   message contains `"sub.7"`, `"count"`, and `"scope.editor.row.42"`.
   This is the spec's published-fixture identity test; if it fails the
   pass implementation is not honoring the §16A.2.1 algorithm.
2. **Negative fixture: matched subscribe + dispose pair.** Load
   `tests/fixtures/subscribe-without-dispose/negative.json`; assert
   `report.violations.is_empty()`. This is the fixture adopters reading
   the spec doubt the most — the dispose is in the same scope, on the
   same `subscribeId`, and the pass MUST NOT fire. If it fires, every
   correctly-written subscribe site in adopter code lights up in CI on
   day one. Beck's discipline: the negative fixture earns its keep here.
3. **Edge case: scope `kind: "infinite"` suppresses violation.** Load
   `tests/fixtures/subscribe-without-dispose/infinite.json` (subscribe
   with no dispose, but the scope is `kind: "infinite"`); assert
   `report.violations.is_empty()`. This is the process-lifetime
   subscription case from §16A.2.1 false-positive example #1.
4. **Edge case: scope lifetime terminator `"process-exit"` suppresses
   violation.** Load `tests/fixtures/subscribe-without-dispose/process-exit.json`;
   assert `report.violations.is_empty()`. Same suppression logic; tested
   independently because the algorithm checks both conditions with `OR`
   and we want both arms exercised.
5. **SARIF schema validation: output matches the
   `expected.sarif.json` byte-for-byte.** Run the pass on
   `positive.json`, serialize the report through the SARIF adapter,
   assert the output equals
   `tests/fixtures/subscribe-without-dispose/expected.sarif.json`
   byte-for-byte. This is the wire-format contract; if the adapter
   rearranges keys, normalizes whitespace, or drops the
   `logicalLocations` array, the test fails. Adopters' SARIF consumers
   (GitHub code scanning, SonarQube, Veracode) key off these byte-level
   shapes.

#### 5 core concerns

1. **`HashSet<&str>` vs `BTreeSet<String>` — the lookup must be O(1);
   profile against a 10k-event fixture.** Per the existing pattern at
   `check.rs:223` (`let known: HashSet<&str> = model.nodes.iter().map(IrNode::id).collect()`),
   we build the disposed-set as `HashSet<&str>` borrowing from the
   model, no allocation per event. The §16A.2.1 published algorithm
   uses `HashSet<&str>` exactly. The performance budget is O(N) over
   events; profile against a synthetic 10k-event fixture before merge
   to confirm no accidental O(N²). Hejlsberg's call: if the borrow
   checker fights us on lifetimes here, we promote to
   `BTreeSet<String>` and pay the O(log N) — but we measure first.
2. **`scopeId` is required.** A subscribe without a `scopeId` fails the
   schema gate before this pass runs; this pass assumes `scopeId` is
   present. If `scopeId` is missing from a subscribe event, EPIC-1's
   schema-3 deserializer rejects the model (serde will fail on the
   missing required field), and the schema pass in `check()` short-
   circuits before this pass runs. We do NOT defensively handle
   `Option<&str>` on `scopeId` inside this pass; doing so would mask
   exporter bugs. Wirfs-Brock's call: the wire format requires
   `scopeId`; the deserializer enforces it; we assume it.
3. **False-positive economy. Three suppression mechanisms (per-site
   comment, scope annotation, exemption file). Each tested.**
   Per-site comment: `// causl-check: subscribe-without-dispose --
   <reason>` on the source line referenced by `callbackSite`; the
   exporter records the comment in a `suppressions` slot; the pass
   skips the violation iff a suppression with matching ruleId is on
   the same line. Scope annotation: `kind: "infinite"` or
   `lifetime.terminator: "process-exit"` (tested in tests 3 and 4
   above). Exemption file: `causl-exemptions.md` lists subscribe ids
   that are permanently ignored, with a `because:` field; per
   §16A.5's anti-rot mechanism the count is SARIF-reported. We ship
   tests for all three; the per-site comment test is the riskiest
   because the comment-locator path traverses
   `callbackSite -> source-file -> line-N -> regex` and we want to
   confirm the regex tolerates leading whitespace, trailing reason
   text with embedded `--`, and lowercase/uppercase rule names.
4. **SARIF rule metadata.** `ruleId: "causl/subscribe-leak"` (slash-
   separated namespace per the §16A.2 narrative; the §16A.2.1
   "Expected SARIF" block uses the bare `subscribe-without-dispose`
   form, but the §16A.2 narrative names the namespaced form; we ship
   namespaced and update the §16A.2.1 fixture before merge if the
   spec stays bare). `level: "warning"` outside React,
   `level: "error"` inside (detected by
   `scope.lifetime.origin == "react-mount"` per the schema-3 IR);
   `helpUri` is non-empty (`https://causl.dev/checker/subscribe-without-dispose`),
   tested for non-emptiness in the SARIF adapter unit tests so the
   docs site team gets a build break if the URL ever drops.
5. **No race condition — pure IR walk; pass is `&CauslModel ->
   Vec<Violation>`. No MIRI needed.** The pass holds no shared mutable
   state, takes the model by shared reference, and returns an owned
   `Vec`. There is no concurrency in `check()` and no plan to add it
   in this EPIC; if a future EPIC parallelizes the pass-runner, each
   pass remains independently safe because each is a pure function.
   We do not run MIRI on this pass; the existing CI lane covers it.

### TASK 2.2 — `CommitFromSubscribe` pass + fixtures + SARIF

Per §16A.2.1's IR pattern. The IR pattern: for every `IRCommit { time,
intent, originEvent }` in `model.commits`, resolve `originEvent` to an
event in `model.events`; emit a violation iff the resolved event's kind
is `"subscribe-callback"`. The `originEvent` slot is `Option<EventId>`;
`None` means "no origin event recorded" and is not a violation.

Files:
- `tools/checker/src/check.rs` — new `commit_from_subscribe_pass`
  function; new `ViolationKind::CommitFromSubscribe`; new
  `PassName::CommitFromSubscribe`; registration after
  `SubscribeWithoutDispose` in `check()`.
- `tools/checker/src/sarif.rs` — rule `causl/commit-in-subscribe`,
  `level: "error"`, `helpUri:
  https://causl.dev/checker/commit-in-subscribe`.
- `tools/checker/tests/fixtures/commit-from-subscribe/positive.json` —
  from §16A.2.1's "Positive fixture" block (mirror commit fired from
  callback).
- `tools/checker/tests/fixtures/commit-from-subscribe/negative.json` —
  mirror updates inside a `derived` node, no callback origin.
- `tools/checker/tests/fixtures/commit-from-subscribe/bridge-allowlist.json`
  — `intent: "bridge:A->B"` with the per-intent allowlist applied;
  pass MUST NOT fire.
- `tools/checker/tests/fixtures/commit-from-subscribe/expected.sarif.json`.

#### TDD test suite (5 tests minimum)

1. **Positive fixture: commit at t=4 with `originEvent: "cb.1"` where
   `cb.1` is a `subscribe-callback` event.** One violation; kind
   `CommitFromSubscribe`; `commit == Some(4)`; message references
   `"mirror-double"`, `"cb.1"`, and `"sub.1"`.
2. **Negative fixture: mirror update lives in a derived, no callback
   origin.** Zero violations. The doubt adopters have here is "but my
   derived node updates when its dep changes — won't your pass fire?"
   No: derived recomputation is not an `IRCommit` and the pass walks
   commits, not recomputations. The negative fixture demonstrates this
   in JSON.
3. **`originEvent: null` produces no violation.** A commit with no
   recorded origin event is the user's commit (`graph.commit({...})`
   from app code), which is the desired path. The pass MUST NOT fire
   on `originEvent == None`. Tested with a fixture whose `commits[0]`
   has `"originEvent": null`.
4. **Bridge-intent allowlist suppresses violation.** A commit with
   `intent: "bridge:A->B"` (or any intent matching the
   configured `bridge:` prefix allowlist) MUST NOT produce a violation
   even if its `originEvent` is a subscribe-callback. The §16A.2.1
   false-positive example #1 (two-graph mirror) ships exactly this
   suppression. Tested with `bridge-allowlist.json`.
5. **SARIF byte-for-byte match.** Same shape as TASK 2.1 test 5.

#### 5 core concerns

1. **Two-graph mirror false-positive (allowlist intent prefix
   `bridge:`).** Per §16A.2.1 false-positive example #1; tested in test
   4 above. The allowlist is configured in `causl.config` as a list of
   intent prefixes; the pass loads the config (or falls back to
   `["bridge:"]` as the spec default) and skips commits whose intent
   matches any prefix. We do NOT pattern-match arbitrary regexes; only
   prefixes. Wirfs-Brock's call: the configuration surface is small
   enough that adopters can reason about it without a regex evaluator.
2. **Optimistic-rollback false-positive (fix:
   `causl.bridgeCommit` records `kind: "bridge-commit"`).** Per
   §16A.2.1 false-positive example #2. The runtime helper
   `causl.bridgeCommit(...)` records the commit with
   `kind: "bridge-commit"` (vs `kind: "commit"`). The pass walks only
   the latter; the former is by-design exempt. EPIC-1 ships the
   `kind` field on `IRCommit`; this task's algorithm filters on
   `commit.kind == "commit"` before looking at `originEvent`.
3. **Logging adapter false-positive (suppression).** Per §16A.2.1
   false-positive example #3. The per-site suppression
   `// causl-check: commit-from-subscribe -- metrics-sink` on the
   commit's call-site line suppresses the violation. The exporter
   records the comment; the pass skips. Same mechanism as TASK 2.1
   concern 3.
4. **O(N) over events, not O(N²).** The published algorithm builds an
   index `events: HashMap<&str, &IrEvent>` once (O(N)), then walks
   commits once (O(M)), with O(1) lookup per commit — total O(N + M).
   We do NOT scan events linearly per commit; that is the O(N*M) trap
   the spec calls out. Profile on a 10k-events / 10k-commits fixture.
5. **Cross-pass interaction: `CommitFromSubscribe` runs second after
   `SubscribeWithoutDispose`; never short-circuited by it.** Per the
   §16A.2.1 "Cross-pass interactions" sub-section. A subscribe that
   is also missing its dispose AND fires a callback that commits
   produces TWO findings: the leak AND the commit-from-subscribe
   reentry. Adopters fix them differently. Tested in the acceptance
   gate fixture below.

### TASK 2.3 — `CrossGraphRead` pass + fixtures + SARIF

Per §16A.2.1's IR pattern. The IR pattern: for every `IRDerived { id,
graphId, deps, conditionalDeps }`, for every `dep` in
`deps ∪ conditionalDeps`, look up the target node by id; emit a
violation iff `target.graphId != self.graphId` AND there is no
`IRBridge { from: target.graphId, to: self.graphId, dep }` in
`model.bridges`. The `bridges: []` array is a top-level new field on
schema-3 (cross-reference EPIC-1's IR types).

Files:
- `tools/checker/src/check.rs` — `cross_graph_read_pass` function;
  enum variants; registration.
- `tools/checker/src/sarif.rs` — rule `causl/cross-graph-read`,
  `level: "error"`, `helpUri:
  https://causl.dev/checker/cross-graph-read`.
- `tools/checker/tests/fixtures/cross-graph-read/positive.json` —
  from §16A.2.1 "Positive fixture" block.
- `tools/checker/tests/fixtures/cross-graph-read/negative.json` —
  same nodes plus a declared `IRBridge`.
- `tools/checker/tests/fixtures/cross-graph-read/wildcard.json` —
  singleton constants graph; bridge is
  `{ from: "g.flags", to: "*", dep: "*", policy: "read-only" }`.
- `tools/checker/tests/fixtures/cross-graph-read/legacy-allow.json` —
  migration `policy: "legacy-allow"`; pass produces `level: "note"`,
  not `"error"`.
- `tools/checker/tests/fixtures/cross-graph-read/test-only.json` —
  test-fixture suppression with `policy: "test-only"`.
- `tools/checker/tests/fixtures/cross-graph-read/expected.sarif.json`.

#### TDD test suite (5 tests minimum)

1. **Positive fixture: derived in `g.app` reads input from `g.session`,
   no bridge.** One violation; kind `CrossGraphRead`; node
   `Some("greeting".into())`; message references `"greeting"`,
   `"g.app"`, `"userId"`, `"g.session"`.
2. **Negative fixture: declared bridge suppresses violation.** Zero
   violations. The doubt: "I declared the bridge — please don't yell
   at me." Beck's discipline: the negative fixture is the proof.
3. **Wildcard bridge `to: "*"`, `dep: "*"` for a singleton constants
   graph.** Zero violations across N derived readers. §16A.2.1
   false-positive example #2.
4. **Migration `policy: "legacy-allow"` reduces level to `note`.** One
   "violation" produced but with SARIF `level: "note"`, not `"error"`,
   reflecting the migration-in-progress shape. Tested by inspecting
   the SARIF result's `level` field. §16A.2.1 false-positive example
   #1.
5. **SARIF byte-for-byte match.**

Plus a sixth, non-negotiable test:

6. **100-fixture sweep asserts 0% false-positive rate.** Per §16A.2's
   "false positives: 0% by construction" claim, we generate 100
   schema-3-shaped IR fixtures via property-based generation
   (`proptest` is already a dev dep — see
   `tools/checker/tests/proptest_invariants.rs`), each with 1-20
   nodes, 0-10 graphs, 0-30 deps per derived, and a randomized but
   well-formed bridge set. For each fixture, the property holds: the
   pass fires iff the IR contains a derived whose dep targets a node
   in a different graphId AND no matching bridge exists. Any failure
   of this property is a 0%-claim violation and blocks the merge.

#### 5 core concerns

1. **Wildcard bridge `to: "*"` and `dep: "*"` for singleton constants
   graph.** Per §16A.2.1 false-positive example #2. The pass treats
   `"*"` as "matches any value" in those fields; we do NOT treat `"*"`
   as a literal node id. (Adopters are forbidden from naming a node
   `"*"`; the schema gate in EPIC-1 rejects it.) The bridge-lookup
   index is built with three lookup tiers: exact match
   `(from, to, dep)`, then `(from, "*", dep)`, then `(from, to, "*")`,
   then `(from, "*", "*")`. The order is the natural specificity
   order; tests cover all four tiers.
2. **Migration `policy: "legacy-allow"` reduces level to `note`.** The
   pass still produces a `Violation` (so the count appears in
   `Report.violations.len()`), but the SARIF adapter inspects
   `policy` and emits `level: "note"` instead of `"error"`. This is a
   SARIF-layer transformation, not a pass-layer suppression — the
   distinction matters because `causl-check`'s exit code in TASK 2.5
   keys off `violations.len() > 0`, and a migration adopter does NOT
   want a non-zero exit on legacy-allow paths. We will add a SARIF-
   adapter rule: legacy-allow violations do not contribute to the
   exit-code count. Tested.
3. **Test fixture suppression via `policy: "test-only"`.** Per
   §16A.2.1 false-positive example #3. The exporter strips
   `policy: "test-only"` bridges from production exports
   (`packages/core/src/ir.ts` change in EPIC-1); test exports keep
   them. The pass treats test-only bridges identically to read-only
   bridges. No special pass-layer logic; the fixture is the test.
4. **The `bridges: []` array is a top-level new field on schema-3
   (cross-reference EPIC-1's IR types).** This task does not define
   `IrBridge`; EPIC-1 does. We consume it. If EPIC-1 ships the field
   as `Vec<IrBridge>` on `CauslModel` with `#[serde(default)]`, then
   a model lacking the field deserializes with an empty `bridges`
   vector and this pass fires on every cross-graph read — which is
   the strict behaviour. If EPIC-1 ships without `#[serde(default)]`,
   then a missing field rejects the model at the schema gate, which
   is the loud behaviour. We document our preference for
   `#[serde(default)]` here so EPIC-1's reviewer sees it.
5. **0% false-positive by construction — verify with a 100-fixture
   sweep.** Tested in test 6 above.

### TASK 2.4 — `UseAfterDispose` pass + fixtures + SARIF

Per §16A.2.1's IR pattern. The IR pattern: for every `IRSubscribe { id }`
paired with an `IRDispose { subscribeId: id, time: t_d }`, emit a
violation iff there exists an `IRSubscribeCallback { subscribeId: id,
firedAt: t_f }` with `t_f > t_d`, OR an `IRRead { subscribeId: id, at:
t_r }` with `t_r > t_d`.

Files:
- `tools/checker/src/check.rs` — `use_after_dispose_pass` function;
  enum variants; registration last in the four (per the §16A.2.1 fixed
  order).
- `tools/checker/src/sarif.rs` — rule `causl/use-after-dispose`,
  `level: "error"`, `helpUri:
  https://causl.dev/checker/use-after-dispose`.
- `tools/checker/tests/fixtures/use-after-dispose/positive.json` —
  from §16A.2.1 "Positive fixture" block.
- `tools/checker/tests/fixtures/use-after-dispose/negative.json` —
  callback fires *before* dispose (firedAt 4 < dispose time 6).
- `tools/checker/tests/fixtures/use-after-dispose/no-op-callback.json`
  — post-dispose firing recorded with `kind: "no-op-callback"`; pass
  ignores.
- `tools/checker/tests/fixtures/use-after-dispose/replay-mode.json` —
  `model.replay = true`; pass gates off entirely.
- `tools/checker/tests/fixtures/use-after-dispose/expected.sarif.json`.

#### TDD test suite (5 tests minimum, plus 1 property test)

1. **Positive fixture: subscribe at t=ε, dispose at t=6, callback at
   t=9.** One violation; kind `UseAfterDispose`; `commit == Some(9)`;
   message references `"sub.42"`, the dispose time, the firing time,
   and the kind label `"fired"`.
2. **Negative fixture: callback fires before dispose.** Zero
   violations. This is the doubt: "but my callback ran while my
   subscription was alive — that's the whole point of subscriptions."
   Yes, and the negative fixture proves it.
3. **`kind: "no-op-callback"` ignored.** Zero violations even with a
   post-dispose firing, because the firing is explicitly tagged as a
   no-op (the runtime emits this for already-cancelled microtasks per
   §16A.2.1 false-positive example #2).
4. **`model.replay = true` gates the pass off entirely.** Zero
   violations regardless of fixture content. The replay flag
   indicates a time-travel debugger context where post-dispose
   firings are intentional re-emissions of historical events.
5. **SARIF byte-for-byte match.**
6. **Property test: random schema-3 IR with random
   dispose+read interleavings asserts the pass fires iff a read at
   t > disposeAt exists.** Generated via `proptest`: a model with N
   subscribes, M disposes (each pairing with one of the subscribes,
   each with a random `time`), and K events of kind `subscribe-
   callback` or `read` (each pairing with one of the subscribes,
   each with a random `firedAt`/`at`). The property: pass produces
   exactly one violation per `(callback-or-read, dispose)` pair where
   the callback/read's time strictly exceeds the dispose's time. Run
   1000 trials. Any property failure is a soundness bug.

#### 5 core concerns

1. **Race in the recorder — `disposeAt` is half-open interval.** Per
   §16A.2.1 false-positive example #1. The exporter widens
   `disposeAt` to `[enqueueAt, appliedAt]`; the pass uses `appliedAt`
   as the comparison point. EPIC-1's `IRDispose` schema records both
   timestamps. If EPIC-1 ships only one timestamp, this pass false-
   positives during the in-flight window. We document the
   requirement here so EPIC-1's reviewer sees it.
2. **No-op callback variant (`kind: "no-op-callback"`) ignored.**
   Tested in test 3 above. The pass walks only callback events whose
   `kind` is `"subscribe-callback"`; `"no-op-callback"` is a sibling
   variant of the `IrEvent` discriminated union. Hejlsberg's
   exhaustiveness rule applies: when schema 4 adds another callback-
   like variant, this pass's match arm fails to compile, and a human
   decides whether the new variant is a use-after-dispose target.
3. **Replay/time-travel debugger sets `model.replay = true` to gate
   the pass off entirely.** Tested in test 4. The flag is on the
   top-level model (EPIC-1 ships it as `Option<bool>` with
   `#[serde(default)]`); when `Some(true)`, this pass returns the
   empty vector immediately. We do NOT skip the other three passes;
   the leak detection and topology checks remain valuable in
   replay mode. Only `UseAfterDispose` is replay-aware because only
   it is timing-dependent.
4. **Family-keyed nodes — disposal in a sibling subtree the IR
   doesn't model. ~5% FP rate.** Per §16A.2 narrative and §16A.1 row
   11. The IR captures the bounded prefix of family-keyed disposals;
   anything outside that prefix is not visible. We accept the 5% and
   keep `disposed-tombstone-bound.test.ts` running at PROPERTY for
   the residual. We do NOT add a heuristic to suppress family-keyed-
   sibling shapes inside this pass; that would either over-suppress
   (silent false negatives) or under-suppress (silent false positives
   on the family edge cases). The honest engineering is: 95%
   coverage with the rate published, and PROPERTY layer for the
   residual.
5. **Property test: random schema-3 IR with random dispose+read
   interleavings asserts the pass fires iff a read at t > disposeAt
   exists.** Tested in test 6 above. Beck's discipline: the property
   test is the spec, the unit tests are illustrative.

### TASK 2.5 — `--passes` CLI flag + group aliases

Per §16A.2.1 cross-pass interactions ("Selective enabling — the
`--passes` flag" sub-section). The flag accepts a comma-separated list,
with named groups `core` (the original 8) and `lifetime` (the 4 added
in §16A), plus the literal `all` and per-pass kebab-case names, plus
the `-name` subtraction form.

Files:
- `tools/checker/src/main.rs` — new `--passes` CLI argument; parse it
  into a `HashSet<PassName>`; pass through to `check()`.
- `tools/checker/src/lib.rs` — extend `check()` signature to accept
  `enabled_passes: Option<HashSet<PassName>>`; add a parsing helper
  `parse_passes_spec(&str) -> Result<HashSet<PassName>, String>` that
  understands the grammar.
- `tools/checker/tests/passes_flag.rs` — new integration test file.

#### TDD test suite

1. **`--passes=all` includes the four new + the existing eight = 12
   passes.** Run on a clean fixture; assert
   `report.passes_run.len() == 12`; assert the order is the canonical
   fixed order (the 8 existing passes then the 4 new, per
   `check.rs:181-249` plus the §16A.2.1 fixed order).
2. **`--passes=core` is the original 8 only.** Run on a clean
   fixture; assert `report.passes_run.len() == 8`; assert the four
   §16A passes are absent.
3. **`--passes=lifetime` is the four new only.** Run; assert
   `report.passes_run.len() == 4`; assert the eight existing passes
   are absent. Note: this leaves the schema and bounds gates not
   enforced, which is a reasonable choice when the fixture is known-
   good and we're just running the new passes — but we document the
   risk.
4. **`--passes=subscribe-without-dispose,use-after-dispose` runs only
   the named two.** Plus the schema and bounds gates? We decided NO:
   per the §16A.2.1 spec, the `--passes` flag is the literal list,
   without implicit gates. Adopters who want gates list them
   explicitly: `--passes=schema,bounds,subscribe-without-dispose`.
   Tested.
5. **`--passes=-cross-graph-read` (subtraction) runs everything
   except.** The leading `-` on a name removes that pass from the
   default `all` set. Combinable: `--passes=lifetime,-use-after-dispose`
   means "the lifetime group minus use-after-dispose" = three passes.
   Tested.
6. **The `passes_run` field of `Report` records the actual list.**
   Per the existing `Report.passes_run` shape at
   `check.rs:147`. The truth of what was checked on this invocation.
   Tested by comparing against the requested flag.
7. **Unknown pass name produces a structured error.** A
   `--passes=bogus-name` invocation exits with code 2 (the existing
   parse-error code at `main.rs:48`) and writes a clear message to
   stderr. Tested by capturing stderr.

#### 5 core concerns

1. **CLI parsing — invalid pass name produces a structured error
   before passes run.** The parse helper validates every name in the
   list against the known set (the `PassName` enum values plus the
   group aliases `core`, `lifetime`, `all`); any unknown name fails
   the parse, exit code 2, no passes run. We do NOT silently ignore
   unknown names; the §17.2 MECHANICAL contract requires that the
   gate's behaviour be reproducible by inspection, and silent name
   drops break that.
2. **Order-stability — `--passes=use-after-dispose,subscribe-
   without-dispose` runs in the canonical fixed order, not the user's
   listed order.** The list is a SET, not a SEQUENCE. The execution
   order is the canonical order at `check.rs:225-241` (the existing
   eight) plus the §16A.2.1 fixed order (the four new). Adopters who
   list passes in a different order should see the same result —
   deterministic, reproducible. Tested by comparing
   `report.passes_run` against the fixed order regardless of CLI
   list order.
3. **The exit code is non-zero iff any violation fires (not just on
   parse errors).** The existing semantics at `main.rs:98-102`
   already implements this: exit 0 on no violations, exit 1 on any
   violation, exit 2 on parse errors. The `--passes` flag does NOT
   change those semantics; it only filters which passes contribute.
   A `--passes=core` run that finds zero violations exits 0 even if
   the four §16A passes WOULD have found violations had they run.
   That is the adopter's call: they asked for `core`, they got
   `core`, the gate respects their request.
4. **SARIF output respects the filtered set; suppressed passes do
   not contribute rules.** The SARIF adapter walks
   `report.passes_run` (not the static `PassName` variant set) when
   building the `tool.driver.rules` array, so a SARIF document
   produced under `--passes=core` does not advertise the four §16A
   rules. Adopters' SARIF consumers see exactly the rules that were
   active. Tested in `tests/passes_flag.rs` against a SARIF fixture.
5. **No race condition — CLI is single-threaded.** The CLI calls
   `check()` once with the parsed enabled-passes set; `check()`
   walks passes sequentially. There is no parallelism. If a future
   EPIC parallelizes the pass-runner, the enabled-passes set is an
   immutable input to each pass-task and remains race-free.

## Acceptance gate

`tools/checker/tests/integration/lint-passes-all-four.rs` — fed a
known-race adopter project's IR (a synthesized schema-3 model that
exhibits all four bug shapes simultaneously: a subscribe with no
dispose, that subscribes' callback fires a commit, the commit reads
across graphs without a bridge, and a separate subscribe is read
after dispose). Asserts each of the four passes fires with the
correct ruleId at the correct source line. Concretely:

- Exactly four violations.
- One `causl/subscribe-leak` at `src/RowView.tsx:48`.
- One `causl/commit-in-subscribe` at the commit site.
- One `causl/cross-graph-read` on the offending derived.
- One `causl/use-after-dispose` at the post-dispose firing site.
- All four found in the same `check()` call (no short-circuit).
- `report.passes_run` lists all 12 passes in the canonical order.

Per-pass fixtures kept under
`tools/checker/tests/fixtures/{subscribe-without-dispose,
commit-from-subscribe,cross-graph-read,use-after-dispose}/`.

The acceptance fixture is the proof that the four passes compose. The
per-pass fixtures are the proof that each pass works in isolation. We
ship both. Beck's discipline: integration tests prove composition;
unit tests prove correctness; ship the union.

## Out of scope

- Schema 3 IR (EPIC-1). EPIC-1 ships the wire format; this EPIC
  consumes it. If EPIC-1 slips, this EPIC slips.
- Bounded enumerator (EPIC-3). The four passes here are static
  one-shot walks; the enumerator is a separate concern that lives
  in `tools/enumerator/`.
- The `causl-check race` enumerate subcommand (EPIC-3). The CLI
  subcommand surface is enumerator-only; this EPIC adds a `--passes`
  flag to the existing top-level `causl-check` invocation, not a
  new subcommand.
- The `to_sarif()` adapter at the `Report` level. EPIC-5 ships the
  general-purpose SARIF adapter; this EPIC ships only the rule
  metadata for the four new rules in `tools/checker/src/sarif.rs`.
  If EPIC-5 has not landed by the time this EPIC merges, the rule
  metadata still ships (in `sarif.rs`) but the report-level
  serializer is deferred; the per-pass fixtures still validate
  rule metadata via direct unit tests on the metadata module.
- The hypothesis API (EPIC-4) and the race-detection CI workflow
  (EPIC-6). Both are enumerator-adjacent and depend on EPIC-3.
- §9.1 rows 5, 7, and the conditional-dep half of 8. Those stay
  PROPERTY (rows 5, 7) and PROPERTY-or-MODEL (row 8 conditional half)
  per §16A.1; the four passes here lift only rows 1 and 11.
- Adopter-side tooling: ESLint plugin integration, IDE LSP surface,
  pre-commit hooks. The §16A architecture commits to `causl-check`
  as the single binary that all surfaces ride on; the surfaces are
  separate EPICs not yet planned.
