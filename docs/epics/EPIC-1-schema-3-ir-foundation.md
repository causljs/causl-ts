# EPIC: Schema 3 IR foundation (PR-A)

**Status (as of 2026-05-10):** SHIPPED / CLOSED. PR-A merged as PR #462 (commit `99f8369`, 2026-05-03) shipping the `graphId` injection per node and commit, the optional `IRCallGraph` annotation slot on `IRCommit`, the forward-compat `events: readonly never[]` field on `CauslModel`, the `Schema` pass gating on `schema == 3`, the lockstep workflow updates, and the `tools/migrate-ir-2-to-3.ts` codemod. The deferred PR-B1 slice (six-variant `IREvent` union including the `IRSubscribeCallback` variant the brutal-critical review added, plus the `IRScope` / `IRBridge` top-level facts and the `originEvent` lineage on `IRCommit`) shipped against GH issue #463 (closed 2026-05-03) before EPIC-2's lint passes consumed it. The 12 unaddressed brutal-critical-review recommendations from `tmp/epics/EPIC-1-CRITICAL-REVIEW.md` were tracked and closed in Phase-8 follow-on issue #584 (2026-05-04).

**Spec anchors:** SPEC.md §16.2.1 (schema 3 specification), §16A.2.1 (four lint passes that depend on it), §16.0 (reopen trigger), §16.2.1.4 (exporter behavior), §16.2.1.5 (`graphId` source), §16.2.1.6 (lockstep workflow updates), §16.2.1.7 (migration story).

**Risk:** LOW — wire-format break against schema-2 consumers, mitigated by lockstep workflow + structural failure of `Schema` pass on mismatch + migration codemod. The break is named, the failure mode is loud, and the affected surface is two repositories under our control (`@causl/core`, `tools/checker`) plus one opt-in projection consumer (`@causl/devtools-bridge`) that is already forward-compat by ignoring unknown fields per §16.2.1.8.

**Dependencies:** none upstream. Blocks EPIC-2 (the four lint passes from §16A.2.1: `SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`), EPIC-3 (bounded enumerator's IR consumer when §16.4 reopens), and via those, EPIC-4 (race-tier nightly job) and EPIC-7 (devtools-bridge events panel).

**EPIC owner:** Wirfs-Brock + Hejlsberg lead; Markbåge on perf (the `captureCallGraph` knob and read-trace cap); Miller on capability narrowing (the `graphId` regex and the `name`-from-construction discipline); Beck on the acceptance gate.

---

## Shipping status

The "What I'm shipping" prose below is preserved verbatim as the original PR-A scope statement. As shipped, PR-A delivered exactly the wire-format bump described — the optional `IRCallGraph` slot, `graphId` on every record, and the `events: readonly never[]` forward-compat placeholder — and explicitly deferred the `IREvent` variant shapes to PR-B1 per the brutal-critical review (concern #1: do not lock in `IRSubscribe` field shapes without EPIC-2's pass algorithms in code review). PR-B1 (issue #463) widened `IREvent` from `never` to the six-variant union `IRSubscribe | IRSubscribeCallback | IRUnsubscribe | IRDispose | IRRead | IRTxSet`, added top-level `bridges: IRBridge[]` and `scopes: IRScope[]` fields on `CauslModel`, and added the half-open `disposeAt: [enqueueAt, appliedAt]` interval on `IRDispose`. Because PR-B1's changes were additive on `#[non_exhaustive]` enums and `#[serde(default)]` top-level fields, the schema constant stayed at `3` and the lockstep workflow did not fire for PR-B1.

## What I'm shipping

I am Wirfs-Brock, speaking for the schema-versioning desk, with Hejlsberg flanking on type-system enforcement, Markbåge on the commit-cost ripples this introduces, Miller on the capability narrowing that the per-node `graphId` makes possible, and Beck on the single acceptance test that gates the EPIC. We are shipping the wire-format bump from `CAUSL_MODEL_SCHEMA = 2` to `CAUSL_MODEL_SCHEMA = 3` exactly as §16.2.1.1 specifies, with no other changes folded in. PR-A is a schema PR, not a feature PR. The four lint passes that depend on it (§16A.2.1) ship in PR-B and PR-C; this EPIC stops at the day the IR carries the new fields, the Rust checker refuses schema-2 documents, the lockstep workflow refuses a one-sided bump, and an idempotent codemod migrates fixtures.

This is a wire-format break and we accept it. The IR is the contract between `@causl/core` (TypeScript exporter) and `causl-check` (Rust binary) — the two processes communicate via JSON written to stdin/stdout or via a fixture file on disk. An IR that crosses a process boundary is a wire format, and a wire format with no version discipline is a bug-shaped contract. Schema 2 became binding the day `tools/checker/src/ir.rs` shipped its `pub schema: u32` field; schema 3 becomes binding the day this EPIC merges. We do not paper the bump with a "either schema works" mode, and we do not silently migrate schema-2 documents to schema-3 inside the checker. The `Schema` pass refuses mismatches with a structured error naming both expected and received versions. The migration story is the codemod, run once per fixture tree, idempotent, deterministic.

The five new IR-level facts are: (1) `graphId` is required on every `IRInput`, `IRDerived`, `IRCommit`, and every `IREvent` variant — Miller's capability-narrowing argument is that today the runtime has to ask "which graph did this read come from" by walking back through the call site; pulling `graphId` to the wire moves the question into the data, which makes the `CrossGraphRead` pass O(N) over events with zero false positives by construction (§16A.2.1 `CrossGraphRead` block); (2) `IRSubscribe` records the subscriber registry projection — every live subscription, with its `subscriptionId` and the `nodeId` it watches; (3) `IRUnsubscribe` records the symmetric tear-down log; (4) `IRDispose` records the disposal-tombstone window already capped at `disposedTombstoneCap = 1000` upstream; (5) `IRRead` is the bounded read-trace summary, capped at `K = 256` per commit per §16.2.1.3, with a `truncated` flag set on the last retained read when the cap is hit; and (6, the carry-over) `IRTxSet` records every `tx.set` call inside a transaction, unbounded because cardinality is bounded by application code. The discriminated union `IREvent = IRSubscribe | IRUnsubscribe | IRDispose | IRRead | IRTxSet` is closed by Hejlsberg's `assertNever` discipline at every consumer site.

The bounded `IRCallGraph` annotation on `IRCommit` is Markbåge's load-bearing contribution. Every commit can carry an `IRCallGraph { frames: IRCallFrame[]; truncatedDeeper: boolean }` with depth `D = 32` per §16.2.1.3. Stack-trace capture has a non-trivial cost on the hot path — `captureStackTrace` allocates an Error object and walks frames — and the per-commit cost ripples through commit-bound benchmarks. The `captureCallGraph` knob on `ExportModelOptions` defaults to `true` for development builds and we expect production builds to flip it to `false`. The annotation slot is `Option`-typed: a schema-3-valid IR with no `callGraph` field on any commit is acceptable; the `CommitFromSubscribe` pass (PR-B) reports "callgraph absent — pass skipped" rather than failing the schema. Markbåge held the line that capture cost not be paid by adopters who do not run the linter on this commit.

The lockstep workflow (`/Users/rom/workspace/iasbuilt/causl/.github/workflows/release-checker.yml`) gains a single new check: `SCHEMA_REQUIRED=3`, asserted equal to `SCHEMA_FROM_CORE` (parsed from `packages/core/src/ir.ts`) and equal to `SCHEMA_PINNED` (parsed from `tools/checker/Cargo.toml`'s `[package.metadata]` block). A bump in `@causl/core`'s `CAUSL_MODEL_SCHEMA` constant without the matching Cargo metadata bump fails the `version-lockstep` job before any binaries build. The migration codemod (`tools/migrate-ir-2-to-3.ts`) walks a directory of `.json` fixtures, rewrites every node and commit to carry `graphId`, adds an empty `events: []` array, bumps `schema: 2` to `schema: 3`, and is idempotent on schema-3 inputs. Fixtures under `tools/checker/tests/fixtures/` are migrated in the same PR; fixtures owned by external adopters are migrated via the codemod the day they bump.

I want to be precise about what is *not* in PR-A so a reviewer can refuse a scope bump cleanly. PR-A does not change the `Bounds`, `UnknownDep`, `Cycle`, `Determinism`, `Monotonic`, `GlitchPropagation`, or `OrphanDep` passes — only the `Schema` pass. PR-A does not introduce any new violation kinds; the only `ViolationKind::SchemaMismatch` variant already exists in the schema-2 codebase as a generic wrapper, and PR-A keeps the variant but pins its message format. PR-A does not change the SARIF output format for non-schema violations. PR-A does not change the CLI surface (`causl-check --help` text remains stable except for one new line documenting `--features schema3`). PR-A does not change `Cargo.toml` dependencies — `serde`, `serde_json`, `clap`, `anyhow` are the floor, and we resist the temptation to pull in `schemars` or a JSON-schema-validation crate. The structural validation we need is small enough that hand-rolling it (in TypeScript per TASK 1.1, and via serde derives on the Rust side) is cheaper than adding a dependency.

A note on the order of operations. Inside this EPIC, TASK 1.1 (TypeScript types) and TASK 1.2 (Rust types) are independent and can land in either order. TASK 1.3 (exporter) depends on TASK 1.1. TASK 1.4 (lockstep + codemod) depends on TASK 1.1 and TASK 1.2. TASK 1.5 (Schema pass) depends on TASK 1.2 and TASK 1.4 (because it consumes migrated fixtures). The recommended landing order: 1.1, 1.2 (parallel) → 1.3, 1.4 (parallel) → 1.5 → acceptance gate. The whole EPIC fits in a single PR; we do not split it across PRs because the lockstep workflow forbids partial bumps. A schema-2 binary checked against a schema-3 IR fails; a schema-3 binary checked against a schema-2 fixture also fails. The atomic landing is the discipline.

---

## Brutal-critical review of the spec

Where the spec might be wrong or over-promising.

**Read-event granularity (K=256/commit) is probably right but argued from too small a sample.** §16.2.1.3 picks K=256 as "1 OoM above the largest dep set in the property suite (64-node diamond)." That is true today, but the property suite is calibrated against the current set of property tests, not against adopter graphs. The single largest known adopter graph the team has measured (the `iasbuilt/spreadsheet` adapter's pricing-engine fixture) has a derived with 412 conditional dependencies. A commit that touches that derived will hit the cap and set `truncated: true` on every export. The `UseAfterDispose` pass (PR-C) will emit "pass partial — read trace truncated" diagnostics. The fix is not to raise the cap (wire size grows linearly) but to make truncation a first-class hint to the linter rather than a silent quality reduction. We will revisit K during PR-C; PR-A's job is to put the field on the wire and the flag on the last record. Miller flagged that a too-aggressive cap launders the capability — "the linter saw your reads" becomes "the linter saw 256 of your reads, you do not know which 256" — and Markbåge countered that an unbounded cap is a wire-size DoS. The K=256 starting point is a compromise between those two arguments, and we are explicit that it is a starting point.

**Call-graph depth (D=32) is the right answer for the wrong reason.** §16.2.1.3 justifies D=32 as "1 OoM above typical commit-issuing call site." That number is from looking at one team's React app. The runtime cost of `captureStackTrace` is O(D) but the constant is large (allocation, symbol lookup) and the V8 inline cache behavior on the hot path means even D=8 can introduce a measurable regression. Markbåge's actual concern is not depth, it is rate: a commit-bound microbenchmark with `captureCallGraph: true` shows 12-18% slowdown in initial measurements. The `captureCallGraph` knob's default needs to ship as `true` in development and `false` in production builds, with a published recipe for hosts that want it on in production. PR-A ships the knob; the default-flip and the recipe land in a follow-up perf PR before EPIC-2 is closed. We will not let a "default-true" decision lock the production cost in.

**The `graphId` regex is right but the error message must be better.** §16.2.1.5 specifies `/^[A-Za-z0-9_.:-]{1,256}$/` as the validity rule for application-supplied `name`. Miller's framing is the intersection of "safe in JSON", "safe in URL fragments", and "safe in filesystem paths" — that is correct as a capability-narrowing argument. The character set excludes `/`, `?`, `#`, `&`, `=`, `+`, `%`, whitespace, and every Unicode codepoint outside ASCII printable. An adopter who passes `name: "my graph"` (with a space) gets `InvalidGraphNameError`. The error message we ship must say *exactly* which character at *exactly* which index failed the regex, and must point to the spec section. A generic "name does not match regex" error wastes everybody's time. PR-A will ship the validator with the exact-character-named error, not the generic one.

**The migration codemod under-promises on hand-written IR.** §16.2.1.7 says the codemod walks "fixture directories." That covers `tools/checker/tests/fixtures/` and any in-repo test data. It does not cover an adopter who hand-wrote a schema-2 IR document for a one-off check, nor does it cover an adopter who has serialized schema-2 IRs into a fixture vault outside their repo. The codemod is a one-shot tool, not a runtime migration. We have to publish it as `npx @causl/migrate-ir-2-to-3 ./path/to/fixtures` (or equivalent) so adopters can run it without cloning. PR-A's scope includes the codemod logic; the npm-publishable wrapper is a follow-up if and only if an adopter asks for it. We do not preemptively publish the wrapper because that creates a third package to version-lockstep. The `CHANGELOG.md` entry for the schema-3 bump must include the recipe for running the codemod against an external directory.

**One thing the spec gets right and that I want to underline.** The decision to ship `#[non_exhaustive]` on both `IrNode` and `IrEvent` in the Rust crate, even though `IrNode` has only two variants in schema 3, is correct. Adding `IrSnapshot` or `IrIntent` in schema 4 should not break adopters' downstream code that matches on the enum. The grep audit step that catches `_ => …` fallthrough patterns in our own checker code is the discipline that makes `#[non_exhaustive]` a feature rather than a footgun. The audit step lives in PR-A as a CI check (`grep -rn '_ =>' tools/checker/src/ | grep -v allow-fallthrough`), not in a comment.

**A worry the spec does not address.** Adopters who have built dashboards against the schema-2 `commits[].changedNodes` array and who rely on commit identity by `(time, intent)` pair will see no change — `time` and `intent` and `changedNodes` are unchanged in schema 3. But adopters who have built dashboards that count *nodes by graph* will need to migrate, because schema 2 had no `graphId`. We have not surveyed external dashboard tooling beyond `@causl/devtools-bridge`. The risk: a third-party tool we do not know about reads schema-2 IRs and silently falls back when fields appear unfamiliar. Mitigation: the `CHANGELOG.md` entry calls out the on-the-wire field additions in a "tooling consumers, please verify" stanza, and we publish the codemod under a discoverable name. We do not delay the bump waiting for a dashboard inventory; the lockstep workflow is the gate, not a coordinated industry-wide cutover.

**A second worry: `ExportModelOptions` shape stability.** Today's options interface has `maxCommits?: number`. Schema 3 adds `captureCallGraph?: boolean`. The interface is `readonly` and structurally typed — adding a field is non-breaking. But an adopter who has typed their export call as `exportModel({} satisfies ExportModelOptions)` to enforce no-extra-fields gets nothing today, because TypeScript's structural typing accepts both. The risk: an adopter passes `captureCallGraph: false` thinking it disables some other knob and gets confused. The fix: the JSDoc on `ExportModelOptions.captureCallGraph` explicitly cross-references §16.2.1.4 and names the perf trade-off. PR-A ships the JSDoc.

---

## Sub-issues (TASKS)

### TASK 1.1 — TypeScript schema-3 type definitions in `@causl/core`

**Files:** `/Users/rom/workspace/iasbuilt/causl/packages/core/src/ir.ts`, `/Users/rom/workspace/iasbuilt/causl/packages/core/src/internal.ts` (export plumbing), `/Users/rom/workspace/iasbuilt/causl/packages/core/test/ir.test.ts` (new), `/Users/rom/workspace/iasbuilt/causl/packages/core/test/ir.test-d.ts` (new — type-d).

**Owner:** Hejlsberg leads on the type signatures; Wirfs-Brock reviews the wire-format closure.

What I do: bump `CAUSL_MODEL_SCHEMA: 2 as const` to `3 as const`; add the new types per §16.2.1.1 (`IRGraphId`, `IRCallFrame`, `IRCallGraph`, `IRSubscribe`, `IRUnsubscribe`, `IRDispose`, `IRRead`, `IRTxSet`, the `IREvent` union, the `events: readonly IREvent[]` field on `CauslModel`, the `graphId: IRGraphId` field on `IRInput`, `IRDerived`, and `IRCommit`); export them from the `@causl/core/internal` entrypoint per §12.3 (the IR is internal-only; adapters consume it through the internal seam, not the public surface). The `as const` on `CAUSL_MODEL_SCHEMA` is load-bearing — it is what makes `CauslModel['schema']` type-narrow to the literal `3`, not the open `number`.

#### TDD test suite

The five test cases below are the floor. Each is named, each has a specific input shape, each has a specific expected output. No "should work correctly" tests; every assertion is verifiable.

1. **Type-d test: `CauslModel['schema']` is exactly `3`, not `number` or `2 | 3`.** File: `packages/core/test/ir.test-d.ts`. Body: `expectTypeOf<CauslModel['schema']>().toEqualTypeOf<3>()`. Adversarial twin: `expectTypeOf<CauslModel['schema']>().not.toEqualTypeOf<number>()` and `expectTypeOf<CauslModel['schema']>().not.toEqualTypeOf<2 | 3>()`. Failure mode this catches: a future refactor that changes `as const` to `: number` quietly widens the type and the lockstep gate's pattern match against the literal `3` becomes a string-grep against any number. Failing this test means the gate is laundered.

2. **Type-d test: `IREvent` is exhaustively `IRSubscribe | IRUnsubscribe | IRDispose | IRRead | IRTxSet`.** File: `packages/core/test/ir.test-d.ts`. Body: write a `function visitEvent(e: IREvent): never` that switches on `e.kind` and calls `assertNever(e)` in the default arm. Run `tsc --noEmit`. Expected output: zero diagnostics. Adversarial twin: a sibling file `packages/core/test/ir.test-d.assert-never-fails.test-d.ts` that adds a synthetic sixth `kind: 'snapshot'` arm to a copy of the visit function, asserts `tsc` produces error TS2345 ("Argument of type ... is not assignable to parameter of type 'never'"). Mechanism: we copy `visitEvent` into the failing fixture, append `case 'snapshot': return null` (where `'snapshot'` is not a member of `IREvent['kind']`), and assert the build fails. Failure mode this catches: silently adding a sixth event variant without updating every consumer.

3. **Type-d test: every `IRNode` carries `graphId` as required, not optional.** File: `packages/core/test/ir.test-d.ts`. Body: `expectTypeOf<IRInput>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()` and the symmetric `IRDerived` assertion. Adversarial twin: `const partialNode = { kind: 'input', id: 'x', value: 0, serializable: true } satisfies IRInput` (note the missing `graphId`). Expected: `tsc` error TS2741 ("Property 'graphId' is missing in type ..."). Failure mode this catches: a constructor or test fixture that forgets `graphId` and silently produces an IR that fails the Rust checker at runtime instead of TypeScript at compile time. The Rust failure is loud but late; we want the TypeScript failure, which is loud and early.

4. **Runtime test: `JSON.parse(JSON.stringify(model))` round-trips losslessly for every event variant.** File: `packages/core/test/ir.test.ts`. Body: construct a `CauslModel` literal containing exactly one of each event kind: one `IRSubscribe { kind: 'subscribe', graphId: 'g.test', time: 5, nodeId: 'n.1', subscriptionId: 'sub.1' }`, one `IRUnsubscribe { kind: 'unsubscribe', graphId: 'g.test', time: 6, nodeId: 'n.1', subscriptionId: 'sub.1' }`, one `IRDispose { kind: 'dispose', graphId: 'g.test', time: 7, nodeId: 'n.1' }`, one `IRRead { kind: 'read', graphId: 'g.test', time: 8, nodeId: 'n.1', seq: 0, truncated: false }`, one `IRTxSet { kind: 'tx-set', graphId: 'g.test', time: 9, nodeId: 'n.1', seq: 0, value: 42, serializable: true }`. Serialize with `JSON.stringify(model)`. Parse with `JSON.parse(serialized)`. Assert `deepStrictEqual(parsed, model)`. Adversarial twin: assert that the byte string `JSON.stringify(parsed) === JSON.stringify(model)` — same input, same JSON bytes. This catches non-deterministic key ordering (which V8 happens to preserve insertion order, but the spec does not require it) and `Date`-object leakage (a `Date` round-trips to a string, breaking equality).

5. **Runtime test: a manually-constructed schema-3 model parses cleanly; a schema-2 model with missing `graphId` fails the structural shape.** File: `packages/core/test/ir.test.ts`. Body: import the (forthcoming) `parseCauslModel(json: unknown): CauslModel | ParseError` validator (PR-A ships a minimal structural validator alongside the types — it is a 30-line Zod-free hand-rolled walker). Assert `parseCauslModel(scheamaThreeFixture).ok === true` for a fixture with `schema: 3`, `graphId` on every node, and an `events` array (possibly empty). Assert `parseCauslModel(scheamaTwoFixture).ok === false` for a fixture with `schema: 2` and any nodes (the validator rejects on `schema !== 3` first). Assert `parseCauslModel({ schema: 3, time: 0, nodes: [{ kind: 'input', id: 'x', value: 0, serializable: true }], commits: [], events: [] }).ok === false` (missing `graphId` on the input node). The `ParseError` carries a `path: string[]` like `['nodes', 0, 'graphId']` so the error message is precise.

#### 5 core concerns the test must cover

1. **Schema version constant immutability.** `CAUSL_MODEL_SCHEMA` is `as const`; widening it to `number` is a type-system regression that breaks the lockstep gate's downstream pattern match. The test-d assertion `expectTypeOf<typeof CAUSL_MODEL_SCHEMA>().toEqualTypeOf<3>()` (note: the constant's *type*, not just the schema field's type) is the gate. If a future refactor removes `as const`, this test goes red and the lockstep workflow's grep pattern reports the value as `3 | number`, which fails the numeric equality.
2. **Discriminator closure.** Every `IREvent` carries a `kind` field with one of exactly five literal strings: `'subscribe'`, `'unsubscribe'`, `'dispose'`, `'read'`, `'tx-set'`. `assertNever` over the union catches a sixth at the consumer site. The five literal strings are also the exact strings the Rust serde `rename_all = "kebab-case"` derives produce on the wire — the cross-language test in TASK 1.5 confirms the round-trip.
3. **`graphId` presence on every node and event.** A node without `graphId` fails the `tsc` strict check, not the runtime. Same for every event variant. The structural validator from test 5 is the runtime safety net for IRs that arrive from a source the type system did not see (a hand-edited fixture, a remote IR over the wire).
4. **JSON round-trip determinism.** Same input, same JSON bytes. Catches non-deterministic key ordering or `Date`-object leakage. The test fixture must include both an `IRTxSet` with `value: undefined` (which JSON elides) and an `IRTxSet` with `value: null` (which JSON preserves) — the round-trip must distinguish them, which means the field must be marked optional in the type and the serializer must omit it when `undefined`.
5. **No race-condition path exists.** Pure data structures, no shared mutation, no `WeakRef`. We do not need MIRI or `fast-check` race fuzzing for this task because the IR types are immutable on the way in (every field is `readonly`) and JSON-typed on the way out. The test surface is type-d plus deterministic round-trip; concurrency is a non-concern at this layer. (The exporter — TASK 1.3 — has a different concurrency surface; that surface gets its own concern list there.)

---

### TASK 1.2 — Rust schema-3 type definitions in `tools/checker`

**Files:** `/Users/rom/workspace/iasbuilt/causl/tools/checker/src/ir.rs`, `/Users/rom/workspace/iasbuilt/causl/tools/checker/Cargo.toml`, `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/ir_roundtrip.rs` (new).

**Owner:** Wirfs-Brock leads (the Rust crate is the wire-format authority); Hejlsberg reviews the serde derives for one-for-one parity with the TypeScript shapes.

What I do: replace the schema-2 declarations in `ir.rs` with the schema-3 shapes per §16.2.1.2. Add `IrGraphId = String`. Add `events: Vec<IrEvent>` field on `CauslModel` with `#[serde(default)]` so a missing `events` field deserializes to an empty vec (forward-compat with any tooling that inspects schema-3 structure without producing events). Add `graph_id: IrGraphId` (serde-renamed to `graphId`) on `IrInput`, `IrDerived`, `IrCommit`, and every `IrEvent` variant. Add `IrCallFrame`, `IrCallGraph`, `call_graph: Option<IrCallGraph>` on `IrCommit` (serde-renamed to `callGraph`, omitted when `None`). Add `#[non_exhaustive]` on `IrNode` and `IrEvent`. Update `tools/checker/Cargo.toml` to include `[package.metadata]` with `causl_model_schema = "3"`. Add `proptest` as a dev-dependency.

#### TDD test suite

1. **Serde round-trip via `proptest` for every variant, 1000 cases minimum.** File: `tools/checker/tests/ir_roundtrip.rs`. Body: a `proptest!` block with `#![proptest_config(ProptestConfig::with_cases(1000))]` that generates an arbitrary `CauslModel` (using a `Strategy` that builds nodes with ASCII-only `graphId` matching the regex, between 0 and 64 nodes per model, between 0 and 32 events per model, valid event variants in proportion 1:1:1:8:4 — reads dominate per §16.2.1.3 granularity), serializes with `serde_json::to_string`, parses with `serde_json::from_str`, asserts `deserialized == original`. Adversarial twin: serialize twice and assert byte equality (catches non-deterministic field ordering, which serde does not produce but may emerge from a `HashMap` field if one is added later).

2. **`#[non_exhaustive]` enforcement on the public enum surface.** File: `tools/checker/tests/non_exhaustive.rs` (new, integration test). Body: a downstream-consumer-style match on `IrNode` that intentionally omits a wildcard arm; assert the test compiles cleanly when run in-crate (where `#[non_exhaustive]` does not apply) and emits a compile error when the test is moved to an external crate (we ship a tiny `tools/checker/tests/external-consumer/` cargo project that depends on the checker crate via `path = ".."` and matches without a wildcard, expected: build fails with E0004 "non-exhaustive patterns"). The failing build is the test result; we wire it via a shell script asserting `! cargo build` on the external project.

3. **Serde rename consistency between TypeScript field names (camelCase) and Rust field names (snake_case).** File: `tools/checker/tests/serde_rename.rs`. Body: build a Rust `CauslModel` with `graph_id: "g.test".to_string()` on every record. Serialize. Parse the resulting JSON with `serde_json::Value`. Assert that the JSON key is exactly `"graphId"` at every record. Assert no key `"graph_id"` appears anywhere. Assert that `conditionalDeps`, `changedNodes`, `originatedAt`, `subscriptionId`, `nodeId`, `callGraph`, `truncatedDeeper` are all camelCase. (The `kind` discriminator for `IrEvent` is `kebab-case` per the TypeScript `'tx-set'` literal — that is a separate test below.)

4. **Discriminator literal-value parity for `IrEvent`.** File: `tools/checker/tests/serde_rename.rs`. Body: build one of each `IrEvent` variant; serialize. Assert the `"kind"` field equals exactly `"subscribe"`, `"unsubscribe"`, `"dispose"`, `"read"`, `"tx-set"` (the last one is kebab-case, not snake). Assert that `serde_json::from_str::<IrEvent>(r#"{"kind":"tx_set",...}"#)` returns an error (snake_case rejected). The string literals here are the exact contract with the TypeScript exporter and the lint-pass authors writing fixtures.

5. **Schema-mismatch produces a structured error, not a panic.** File: `tools/checker/tests/schema_mismatch.rs`. Body: feed the parser a schema-2 IR document (constructed in-test as a `serde_json::Value` literal with `"schema": 2`). Call `parse_and_check(json_string)`. Assert the result is `Err(CheckError::SchemaMismatch { expected: 3, got: 2 })`, not a `panic!`. Assert the error's `Display` impl produces `"expected schema = 3, received schema = 2"` exactly. Symmetric test: feed a `"schema": 4` document, assert `Err(CheckError::SchemaMismatch { expected: 3, got: 4 })`. The error variant is named in TASK 1.5; this test pins the message.

6. **`Cargo.toml` `[package.metadata]` is parseable and pinned to "3".** File: `tools/checker/tests/cargo_metadata.rs`. Body: `let cargo: toml::Value = toml::from_str(include_str!("../Cargo.toml")).unwrap();` then `assert_eq!(cargo["package"]["metadata"]["causl_model_schema"].as_str(), Some("3"))`. This is the lockstep workflow's source of truth on the Rust side; if the metadata key drifts, the workflow's `grep` falls back to "unset" and the cross-check is laundered. We pin it in a unit test.

#### 5 core concerns the test must cover

1. **Serde rename consistency (camelCase ↔ snake_case).** Fields on the wire are camelCase. Fields in Rust are snake_case. Every `#[serde(rename = "camelCaseName")]` attribute is a possible drift point; the `serde_rename.rs` test pins every one. A future refactor that adds a new field without the rename produces a wire format that the TypeScript exporter cannot emit, and the cross-language acceptance test (gate at the bottom of this EPIC) catches it.

2. **`#[non_exhaustive]` enum match-arm discipline.** Inside the crate, every match must be exhaustive. We enforce this via a CI grep step (`grep -rn '_ =>' tools/checker/src/ | grep -v 'allow-fallthrough'`) that fails on unannotated wildcard arms. Outside the crate, downstream consumers must use a wildcard arm; the integration test in `external-consumer/` confirms the compile error if they do not.

3. **JSON wire bytes deterministic across runs.** Same input model, same serialized bytes. Serde-json with `Vec`-backed fields (we do not use `HashMap` in the IR types) preserves insertion order, so the property holds by construction. The `ir_roundtrip.rs` test pins it.

4. **Schema-mismatch produces a structured error, not a panic.** No `unwrap()` on the schema field, no `assert!()` macro that abort-traps, no `panic!()` reachable from a malformed IR. The `Schema` pass returns `Err(CheckError::SchemaMismatch)` and the CLI front-end converts it to a SARIF report with `ruleId: "causl/schema-mismatch"`. Test 5 pins the variant + message.

5. **Round-trip via proptest with at least 1000 cases.** §15.2 commits to a 1000-trial floor for property-based tests. The `ir_roundtrip.rs` test runs at exactly that floor. We do not raise it because the IR is pure data and the property is a tautology under correct serde derives — additional cases buy nothing once the strategy covers every variant.

**Race-condition concern.** `ir.rs` is pure data: types, derives, no `unsafe`, no shared state, no atomics, no `Mutex`, no `Arc`. MIRI is not needed. The Rust workspace already runs MIRI on the bounded-enumerator code path (deferred per §16.4) but the IR types do not need it.

---

### TASK 1.3 — Exporter behavior in `graph.exportModel()`

**Files:** `/Users/rom/workspace/iasbuilt/causl/packages/core/src/graph.ts` (the `exportModel` method on `GraphImpl`), `/Users/rom/workspace/iasbuilt/causl/packages/core/src/internal.ts` (run-time side-tables `subscribers`, `unsubLog`, `disposed`, `readTraces`, `txSetLog`), `/Users/rom/workspace/iasbuilt/causl/packages/core/test/exportModel.test.ts`, `/Users/rom/workspace/iasbuilt/causl/packages/core/test/exportModel.property.test.ts`.

**Owner:** Markbåge leads (this is where the commit-cost ripples surface); Wirfs-Brock reviews the wire-format closure; Beck reviews the property-test discipline.

What I do: implement the §16.2.1.4 pseudocode literally. The `exportModel(options: ExportModelOptions = {}): CauslModel` method has two phases. Phase 1 captures `nodes` and `commits` as today, threading `graphId: this.graphId` onto every record and `callGraph: c.callGraph` onto every commit (when `options.captureCallGraph !== false`). Phase 2 drains four runtime maps into `events: IREvent[]`: iterate `this.subscribers` (a `Map<NodeId, Map<SubscriptionId, SubRecord>>`) emitting one `IRSubscribe` per live subscription; iterate `this.unsubLog` (a `Array<UnsubRecord>` capped at the same `disposedTombstoneCap = 1000`) emitting one `IRUnsubscribe` per record; iterate `this.disposed` (a `Map<NodeId, DisposeRecord>`) emitting one `IRDispose` per tombstone; iterate `this.readTraces` (a `Map<CommitTime, ReadRecord[]>`) emitting up to `K = 256` `IRRead` records per commit, with `truncated: true` on the last retained record when the cap is hit; iterate `this.txSetLog` (an `Array<TxSetRecord>`) emitting one `IRTxSet` per record. The `txSetLog` is filtered to the retained `commits` window — entries whose `commitTime` is older than the oldest retained commit are dropped, matching the existing `commitHistoryCap` discipline.

#### TDD test suite

1. **Bounded read-trace cap K=256/commit; `truncated` flag on the last retained read.** File: `packages/core/test/exportModel.test.ts`. Body: construct a graph with one input `n` and one derived `d` whose body reads `n` exactly 300 times in a single commit (synthetic, via a `for` loop in the derived body that conditionally reads `n` via `get(n)` based on a counter the test threads through). Trigger one commit. Call `graph.exportModel()`. Assert `model.events.filter(e => e.kind === 'read').length === 256`. Assert the 256th `IRRead` (`seq: 255`) has `truncated: true`. Assert `IRRead`s with `seq: 0..254` have `truncated: false`. Assert no `IRRead` has `seq: 256` or higher. Failure mode this catches: an off-by-one in the slice, a missing `truncated` flag, a flag set on the wrong record.

2. **Disposal-tombstone window matches `disposedTombstoneCap`.** File: `packages/core/test/exportModel.test.ts`. Body: configure the graph with `disposedTombstoneCap: 5`. Dispose 7 nodes in sequence. Call `exportModel`. Assert `model.events.filter(e => e.kind === 'dispose').length === 5`. Assert the 5 retained tombstones are the most recent 5 (by graph time), not the oldest 5. (The runtime ring is a most-recent-first ring; the IR projection inherits that policy.) Failure mode this catches: the exporter draining the wrong end of the ring, or draining without respecting the cap.

3. **Subscriber-registry projection includes every live subscription, no doubles.** File: `packages/core/test/exportModel.test.ts`. Body: subscribe 3 distinct subscriptions to node `n.1` (subscription IDs `sub.1`, `sub.2`, `sub.3`); subscribe 1 to node `n.2` (subscription ID `sub.4`). Call `exportModel`. Assert exactly 4 `IRSubscribe` events. Assert each has the correct `nodeId` + `subscriptionId` pair. Assert no two events share a `(nodeId, subscriptionId)` key. Now unsubscribe `sub.2`; call `exportModel` again. Assert exactly 3 `IRSubscribe` events (the live ones) plus exactly 1 `IRUnsubscribe` event for `sub.2`. Failure mode this catches: the exporter projecting from a stale snapshot, or double-counting a subscription that appears in both `subscribers` and `unsubLog`.

4. **`tx.set` log is drained inside the retained `commits` window only.** File: `packages/core/test/exportModel.test.ts`. Body: configure `commitHistoryCap: 3`. Issue 5 transactions, each calling `tx.set(node, value)` exactly once. Call `exportModel`. Assert `model.commits.length === 3` (the most recent 3). Assert `model.events.filter(e => e.kind === 'tx-set').length === 3` (the `tx.set` records inside the retained window, not all 5). Assert each `IRTxSet`'s `time` equals one of the retained commit times. Failure mode this catches: the exporter draining the entire `txSetLog` even when commits are pruned, which would emit `IRTxSet` records pointing to commit times not in `model.commits` — a foreign-key violation that PR-B's `Determinism` extension would emit a false positive on.

5. **`captureCallGraph: false` produces a schema-3-valid IR with no `callGraph` fields.** File: `packages/core/test/exportModel.test.ts`. Body: configure the graph normally, issue several commits with stack-trace capture enabled. Call `exportModel({ captureCallGraph: false })`. Assert every commit in `model.commits` has `c.callGraph === undefined`. Assert the IR still parses cleanly through the schema-3 structural validator (TASK 1.1, test 5). Mirror test: call `exportModel({ captureCallGraph: true })`. Assert at least one commit has `c.callGraph !== undefined` and that the `callGraph.frames.length` is between 1 and 32, inclusive. Assert `truncatedDeeper === true` if and only if the actual stack depth at capture exceeded 32. Failure mode this catches: the knob being wired in name only, the default flipping silently, or stack-trace capture leaking into the production build path despite `captureCallGraph: false`.

6. **Property test (using `propertyTrials` at the §15.2 1000-trial floor): for any random graph + commit sequence, `exportModel` produces an IR that satisfies the four invariants.** File: `packages/core/test/exportModel.property.test.ts`. Body: `propertyTrials('exportModel-roundtrip', { numRuns: 1000 }, ({ seed }) => { const graph = randomGraph(seed); const ops = randomOps(seed, 100); applyOps(graph, ops); const ir = graph.exportModel(); /* assertions */ })`. Four assertions per trial: (a) every `IRSubscribe` is paired with an `IRUnsubscribe` *or* the subscription is still live (i.e., appears in `subscribers` at export time); (b) every `IRDispose` has `time <= ir.time`; (c) for every commit time `t` with reads in `readTraces`, the count of `IRRead { time: t }` in the IR is `min(actual, 256)` and the cap-hit case has exactly one `truncated: true` flag at the end; (d) `JSON.parse(JSON.stringify(ir))` round-trips byte-identically (asserted via `JSON.stringify(parsed) === JSON.stringify(ir)`).

#### 5 core concerns the test must cover

1. **Bounded read-trace cap K=256/commit (truncation flag set on last retained read).** Tested directly by test 1, generalized by test 6 invariant (c). The cap is set as a constant `IR_READ_TRACE_CAP = 256` in `ir.ts`; the exporter reads the constant. A future tuning of K is a one-line change with the test as the safety net.

2. **Disposal-tombstone window matches `disposedTombstoneCap`.** Tested directly by test 2. The runtime side-table `disposed` is already capped upstream; the exporter inherits the cap, does not re-cap. If a future refactor moves the cap into the exporter, test 2 catches the drift.

3. **Subscriber-registry projection includes every live subscription, no doubles.** Tested directly by test 3. The `(nodeId, subscriptionId)` key is the de-dup discipline. The exporter must iterate `subscribers` once and emit exactly the live entries; a future refactor that adds a second emission point (e.g., for "pending unsubscribe" optimism) needs to either subtract or test 3 fails.

4. **`tx.set` log drained inside the retained `commits` window only.** Tested directly by test 4. The retained-window foreign-key invariant is what makes the IR valid for the `Determinism` and `OrphanDep` checker passes; an `IRTxSet` pointing to a pruned commit time is a dangling reference.

5. **`captureCallGraph: false` produces a schema-3-valid IR with no `callGraph` fields.** Tested directly by test 5. Markbåge's perf concern: the production build flips the knob, and the IR must remain structurally valid in that mode. The PR-B `CommitFromSubscribe` pass treats absent `callGraph` as "skip this pass" rather than "fail the schema."

**Race-condition concern.** The exporter reads from runtime side-tables (`subscribers`, `unsubLog`, `disposed`, `readTraces`, `txSetLog`) that are mutated by the engine's hot path. The exporter must run on the same JavaScript event loop as the engine — there is no shared-memory concurrency in V8 — so a "race" here is logical, not physical. The discipline: `exportModel` is synchronous, runs to completion, and the engine guarantees no commit-phase mutation happens during its execution (the export point is between the commit-loop's `Phase H` ticks). The property test in test 6 generates random commit sequences and asserts the IR is consistent with the *final* state, not with any intermediate state. Specifically: we do not test "exportModel called from a setTimeout during a commit" because the engine's public API does not allow it (see §5 phase discipline). If a future capability adds an async export path, that path needs its own race tests.

**Side-table introduction discipline.** Of the five side-tables the exporter drains, four already exist in the engine for runtime invariants — `subscribers` (used by the dirty-walk), `disposed` (used by the use-after-dispose runtime guard), `readTraces` (used by `Determinism` runtime check inside the property suite), `txSetLog` (used by transaction rollback). Only `unsubLog` is introduced by this PR, and it is a thin write-only ring of the same shape and cap as `disposed`. Markbåge's perf concern: introducing a new write per `unsubscribe()` call. The cost is one `Array.push` per unsubscribe; unsubscribe is rare (cardinality bounded by application structure per §16.2.1.3) so the cost is negligible. The `unsubLog` is capped at `disposedTombstoneCap = 1000` and uses the same most-recent-first ring discipline as `disposed`. We pass the existing micro-benchmark (`packages/core/test/perf/commit-cost.bench.ts`) with no measurable regression as a precondition for landing.

**The captureCallGraph implementation.** The `IRCallGraph` is populated by capturing `new Error().stack` at commit time, parsing the stack frames into `IRCallFrame { site, source?, line? }` records, and truncating at `D = 32` frames with `truncatedDeeper: true` if the actual depth was greater. The parse is best-effort: V8's stack-frame format is `at FunctionName (path/to/file.ts:line:col)`, and we extract `site = FunctionName`, `source = path/to/file.ts`, `line = line`. Frames the parser cannot match (anonymous, eval, native) get `site = "<anonymous>"` with no `source` or `line`. The capture is gated on `options.captureCallGraph !== false` (default `true`); when disabled, the commit's `callGraph` field is omitted entirely. The cost we are watching: V8's `captureStackTrace` allocates an Error and walks the stack lazily on `.stack` access. We force the access at capture time (eager) so the GC pressure happens at a predictable point, not at a `JSON.stringify` boundary.

---

### TASK 1.4 — Lockstep workflow update + migration codemod

**Files:** `/Users/rom/workspace/iasbuilt/causl/.github/workflows/release-checker.yml` (the `version-lockstep` job), `/Users/rom/workspace/iasbuilt/causl/tools/checker/Cargo.toml` (the `[package.metadata]` block), `/Users/rom/workspace/iasbuilt/causl/tools/migrate-ir-2-to-3.ts` (new), `/Users/rom/workspace/iasbuilt/causl/tools/test/migrate-ir-2-to-3.test.ts` (new).

**Owner:** Wirfs-Brock leads on the lockstep gate (the wire-format authority owns its CI gate); Hejlsberg reviews the codemod's type discipline; Miller reviews the `graphId` injection regex.

What I do: amend the `version-lockstep` step in `release-checker.yml` to include the `SCHEMA_REQUIRED=3` line and the `if [ "$SCHEMA_FROM_CORE" != "$SCHEMA_REQUIRED" ]; then exit 1; fi` check, exactly as §16.2.1.6 prescribes. Add the `[package.metadata]` block to `tools/checker/Cargo.toml` with `causl_model_schema = "3"`. Author `tools/migrate-ir-2-to-3.ts` as a small Node.js script (no dependencies beyond `fs`, `path`, `crypto`) that walks a directory of `.json` files, parses each, and rewrites it: bumps `schema: 2` to `schema: 3`, adds `graphId: <derived-or-injected>` to every node and commit, adds `events: []` if absent, leaves all other fields verbatim. The codemod accepts a `--graphId <name>` flag for explicit injection (matching the §16.2.1.5 regex) and falls back to `randomUUID()` if not supplied (with a deterministic seed mode `--seed <hex>` for fixture migrations that need byte-stable output).

#### TDD test suite

1. **Codemod is idempotent — running it twice on a schema-3 file is a no-op.** File: `tools/test/migrate-ir-2-to-3.test.ts`. Body: take a schema-3 fixture (constructed in-test). Run the codemod. Capture the output bytes. Run the codemod again on the output. Capture the second output bytes. Assert `secondOutput === firstOutput` byte-for-byte. Failure mode this catches: a codemod that adds `graphId` again (producing `graphId: "graphId-2"`-shape doubling), or that increments the schema beyond 3, or that re-adds an empty `events: []` array next to an existing populated one.

2. **Codemod preserves all schema-2 fields verbatim (no value drift).** File: `tools/test/migrate-ir-2-to-3.test.ts`. Body: take a schema-2 fixture with non-trivial values: nested objects in `value`, arrays with mixed types, Unicode strings, large integer commit times (up to `Number.MAX_SAFE_INTEGER`), `originatedAt` set to a non-default value, `serializable: false` on at least one node. Run the codemod. Parse the output. Assert every field that existed pre-migration has the same value post-migration. Specifically: `JSON.stringify(output.nodes[i].value) === JSON.stringify(input.nodes[i].value)` for every i; `output.commits[i].time === input.commits[i].time`; `output.commits[i].originatedAt === input.commits[i].originatedAt`. Failure mode this catches: a codemod that "normalizes" values (e.g., re-stringifies and loses precision), or that drops fields it does not recognize.

3. **Codemod's `graphId` injection uses the §16.2.1.5 regex.** File: `tools/test/migrate-ir-2-to-3.test.ts`. Body: run the codemod with `--graphId "g.test:fixture_42"` (a value that matches the regex). Assert the output's nodes and commits all carry `graphId: "g.test:fixture_42"`. Run the codemod with `--graphId "my graph"` (contains a space, fails the regex). Assert the codemod exits with a non-zero status and a diagnostic naming the offending character index (the space at index 2). Run the codemod with no `--graphId`. Assert the output's `graphId` matches the regex `/^[A-Za-z0-9_.:-]{1,256}$/` (a UUID fits this). Failure mode this catches: the codemod injecting an invalid `graphId` that the runtime would reject at construction.

4. **Lockstep CI gate fails on a one-sided bump.** File: `tools/test/lockstep.test.sh` (a shell-script integration test driven from CI). Body: clone the repo into a tmp dir; rewrite `packages/core/src/ir.ts`'s `CAUSL_MODEL_SCHEMA = 3 as const` to `CAUSL_MODEL_SCHEMA = 4 as const`; do not touch `tools/checker/Cargo.toml`. Run the `version-lockstep` shell block (the same block from `release-checker.yml`, extracted into `tools/lockstep-check.sh` for testability). Assert exit code is non-zero. Assert stderr contains the exact string `CAUSL_MODEL_SCHEMA in @causl/core (4) does not match causl_model_schema pin in tools/checker/Cargo.toml (3)`. Symmetric test: rewrite `Cargo.toml`'s `causl_model_schema = "3"` to `"4"` without touching `ir.ts`; assert the same failure. Failure mode this catches: a release that publishes mismatched binaries — the worst case is a schema-3 npm package published with a schema-2 binary, which silently passes adopters' CI until they bump.

5. **Fixture migration: every existing `tools/checker/tests/fixtures/*.json` migrates cleanly and is byte-stable.** File: `tools/test/fixture-migration.test.ts`. Body: enumerate every `.json` under `tools/checker/tests/fixtures/`. For each, run the codemod with `--seed 0xdeadbeef`. Assert the output is schema-3-valid (passes the structural validator from TASK 1.1 test 5). Assert running the codemod a second time produces byte-identical output (idempotence at the directory level). Commit the migrated fixtures in this PR. Failure mode this catches: a fixture that triggers an edge case the codemod does not handle (an unusual nesting, a missing field that schema-2 allowed but schema-3 requires).

#### 5 core concerns the test must cover

1. **Lockstep fails when Cargo version, npm version, or schema version is out of step.** The three-way check in `release-checker.yml` is the gate. Tests 4 and the existing Cargo-vs-npm check pin the failure modes. A future PR that bumps `@causl/core` without bumping `@causl/checker` *or* the schema metadata fails the gate.

2. **Codemod is idempotent.** Test 1 pins this directly. Idempotence is the property that lets adopters run the codemod in CI as a "migration safety net" without worrying about double-application.

3. **Codemod preserves all schema-2 fields verbatim.** Test 2 pins this directly. The codemod adds; it does not edit. The `JSON.stringify` round-trip on the `value` field is the safety net for non-trivial values.

4. **Codemod's `graphId` injection uses the same regex `/^[A-Za-z0-9_.:-]{1,256}$/` validation.** Test 3 pins this directly. The regex is exported as a constant from `packages/core/src/graph.ts` (`GRAPH_ID_REGEX`); the codemod imports it. A drift between the runtime regex and the codemod regex is impossible by construction once the import is in place; we add a unit test that asserts the imported constant has the exact source `/^[A-Za-z0-9_.:-]{1,256}$/`.

5. **CI gate: a PR that bumps schema in `@causl/core` without bumping the Cargo metadata fails the `version-lockstep` job.** Test 4 pins this in the shell block. The gate runs on every PR (per the `pull_request` trigger we add to `release-checker.yml`'s top-level `on:` block — currently it triggers only on tag push and dispatch; we extend it to PR for the lockstep job specifically, gated on `if: github.event_name == 'pull_request'`). The full release pipeline still gates on tag push.

---

### TASK 1.5 — `Schema` pass in `causl-check` gates on schema 3

**Files:** `/Users/rom/workspace/iasbuilt/causl/tools/checker/src/check.rs` (the `Schema` pass), `/Users/rom/workspace/iasbuilt/causl/tools/checker/src/sarif.rs` (the SARIF rule metadata for `causl/schema-mismatch`), `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/schema_pass.rs` (new), `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/fixtures/` (every fixture migrated to schema 3 by the codemod).

**Owner:** Wirfs-Brock leads (the `Schema` pass is the wire-format gatekeeper); Beck reviews the failure-mode discipline (named errors, no panics).

What I do: update the `Schema` pass in `check.rs` to gate on `model.schema == 3`. The pass is the first one run in the pass pipeline; structural failure short-circuits all downstream passes per §16A.2.1's "Schema and bounds gates short-circuit *all* downstream passes." Add a feature flag `--features schema3` to the Cargo crate; the pass's expected schema is wired from `cfg!(feature = "schema3")` so that during the cutover the binary can be built with `--no-default-features --features schema2` for compatibility with one specific adopter who is mid-migration. The `schema3` feature is the default; the `schema2` feature is mutually exclusive and feature-gates the schema-2 enum variants for that one adopter. After the cutover window closes (one release cycle), the `schema2` feature is removed in a follow-up.

Migrate every fixture under `tools/checker/tests/fixtures/` via the codemod from TASK 1.4. Update `Report` JSON output and SARIF output for schema-mismatch errors to carry `ruleId: "causl/schema-mismatch"` and a structured payload with `expected: u32, got: u32`.

#### TDD test suite

1. **Schema-2 IR fed to a schema-3 binary fails with a structured error, not a panic.** File: `tools/checker/tests/schema_pass.rs`. Body: build the binary with default features (schema 3). Construct a schema-2 IR document (a minimal `serde_json::Value` literal: `{"schema": 2, "time": 0, "nodes": [], "commits": []}`). Pipe it to `causl-check --json` (the JSON-output mode). Assert the process exits with status code 2 (the convention: 0 = clean, 1 = violations found, 2 = structural failure). Assert stdout contains a JSON `Report` with `passes_run: ["Schema"]`, `violations: [{ "kind": "schema-mismatch", "message": "expected schema = 3, received schema = 2", ... }]`, and no other passes recorded. Assert no panic message appears on stderr.

2. **Schema-3 IR fed to a schema-2-feature binary fails symmetrically.** File: `tools/checker/tests/schema_pass.rs`. Body: build the binary with `--features schema2 --no-default-features`. Feed it a schema-3 IR. Assert exit code 2. Assert the message is exactly `"expected schema = 2, received schema = 3"`. This pins the cutover-window discipline: the same pass runs in both modes, with the expected-version constant flipped by feature.

3. **Cargo.toml feature flag toggle is wired correctly.** File: `tools/checker/tests/feature_flags.rs`. Body: `assert!(cfg!(feature = "schema3"))` when default features are on. `assert!(!cfg!(feature = "schema2"))` when default features are on. Build the test binary with `cargo test --no-default-features --features schema2`; assert the symmetric. The mutual-exclusivity is enforced by a `compile_error!` in `lib.rs`: `#[cfg(all(feature = "schema2", feature = "schema3"))] compile_error!("schema2 and schema3 are mutually exclusive");`.

4. **Every existing fixture migrates to schema 3 and passes the `Schema` pass.** File: `tools/checker/tests/fixtures_schema_pass.rs`. Body: enumerate every `.json` under `tools/checker/tests/fixtures/`. For each, run the binary in default-features mode. Assert exit code 0 *or* exit code 1 (clean or violations from a non-Schema pass — this test does not care about `UnknownDep` etc, only that `Schema` does not fail). Assert no fixture has `schema != 3`. The migration step (running the codemod on the fixtures) is part of this PR.

5. **SARIF output for a schema-mismatch carries `ruleId: "causl/schema-mismatch"`.** File: `tools/checker/tests/sarif_output.rs`. Body: feed a schema-2 IR to the binary in `--sarif` mode. Parse the stdout JSON. Assert the SARIF document has `runs[0].tool.driver.rules[]` containing an entry with `id: "causl/schema-mismatch"` and `helpUri: "https://causl.dev/checker/schema-mismatch"`. Assert `runs[0].results[]` contains an entry with `ruleId: "causl/schema-mismatch"` and `level: "error"` and a `message.text` containing both expected and received schema versions. Assert no result has `ruleId: "causl/internal-error"` (which would indicate a panic was caught and re-raised as a generic error). Failure mode this catches: a schema mismatch being reported as a generic internal error, which adopters' SARIF consumers cannot route to a help page.

#### 5 core concerns the test must cover

1. **Graceful failure (no panic) on any malformed input.** Test 1 pins the schema-mismatch case. Adjacent tests (in `tools/checker/tests/malformed_input.rs`, an existing file) pin `unwrap()`-free behavior on truncated JSON, missing top-level fields, type mismatches. The discipline is that the binary returns a SARIF-shaped report on every failure mode; only an `OutOfMemory` or signal-level abort is permitted to bypass.
2. **Error message names both expected and received versions.** Test 1 and test 2 pin the exact strings. The SARIF `message.text` carries them verbatim; the human CLI output carries them with ANSI color but the text is identical.
3. **`Cargo.toml` feature flag toggle confirmed.** Test 3 pins the `cfg!` evaluation. The mutual-exclusivity `compile_error!` is the safety net for an accidentally-enabled both-features build.
4. **Every existing fixture in `tools/checker/tests/fixtures/` is migrated to schema 3 by the codemod.** Test 4 pins the green-state. The migration is a one-time operation in this PR; no fixture is left at schema 2 after merge. The codemod's idempotence (TASK 1.4 test 1) means the migration step is safe to re-run as a CI verification.
5. **SARIF output carries `ruleId: "causl/schema-mismatch"`, not `"causl/internal-error"`.** Test 5 pins this. Adopters' SARIF-routing rules (e.g., a GitHub Code Scanning integration that auto-routes `causl/*` rules to a specific reviewer) depend on the rule ID being stable and specific. A schema mismatch reported as a generic error breaks the routing.

**Race-condition concern.** The `Schema` pass is a single-threaded read of `model.schema` followed by a comparison. No concurrency; no MIRI; no `loom` test needed. The pass pipeline is sequential (every pass runs after the previous one, on the same thread); the parallelism in the wider checker is at the file level (multiple IRs checked in parallel) and isolates per-file state.

**Cutover-window discipline.** The `schema2` Cargo feature is a one-release-cycle aid for one specific named adopter (`iasbuilt/spreadsheet`'s pricing-engine fixture vault) that has not yet bumped. The feature gates the IR types behind `#[cfg(feature = "schema2")]` blocks and lets that adopter build a schema-2-compat binary from the same source tree. The feature is removed in the PR after PR-A — no permanent compat surface. The discipline is: PR-A merges with both features; the next checker release tags `checker-v0.X.0`; we wait one release cycle (typically two weeks); we open a follow-up PR that strips the `schema2` feature, the feature-gated code paths, and the `legacy/` fixture subdirectory. The CHANGELOG entry for the follow-up PR names the cutover explicitly: "schema-2 compat removed; adopters who have not migrated must run the codemod before upgrading."

**Pass ordering inside `causl-check`.** The `Schema` pass is the first pass in the pipeline; if it fails, every downstream pass is short-circuited (per §16A.2.1's "Schema and bounds gates short-circuit *all* downstream passes"). The pass list, in order, is: `Schema`, `Bounds`, `UnknownDep`, `Cycle`, `Determinism`, `Monotonic`, `GlitchPropagation`, `OrphanDep`. PR-A does not change this order. PR-B and PR-C extend the list with `SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose` per §16A.2.1's fixed order. The `passes_run` field in the `Report` records the actual list executed on this invocation, and a schema-mismatch produces `passes_run: ["Schema"]` only — the truth of what ran.

---

## Acceptance gate

The single acceptance test that gates this EPIC: `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/integration/schema-3-roundtrip.rs`.

The test runs the cross-language round-trip end-to-end:

1. Spawn a Node.js subprocess running a script that constructs a representative graph (one input, one derived, two commits, one subscription with its dispose, two reads, one `tx.set`), calls `graph.exportModel({ captureCallGraph: true })`, and writes the JSON to stdout.
2. Pipe stdout to `causl-check --features schema3 --json`.
3. Parse the resulting `Report` JSON.
4. Assert `report.violations.len() == 0`.
5. Assert `report.passes_run` includes `"Schema"` and that the schema gate passed (no schema-mismatch violation).
6. Assert that the input JSON document (captured before piping) has `schema == 3`, that every node carries `graphId == "g.acceptance.test"`, that every commit carries `graphId == "g.acceptance.test"`, and that at least one `IREvent` of each kind (`subscribe`, `unsubscribe`, `dispose`, `read`, `tx-set`) appears in `events`.
7. Assert that at least one commit in `commits` has `callGraph.frames.length >= 1`.

This is Beck's gate: the EPIC is shipped the day this test goes green and stays green. It exercises every TASK in the EPIC end-to-end — TASK 1.1's TypeScript types produce the IR, TASK 1.2's Rust types parse it, TASK 1.3's exporter populates the events array and the call-graph annotation, TASK 1.5's `Schema` pass gates on schema 3. TASK 1.4's lockstep workflow is gated separately at PR-CI time (the test in TASK 1.4 test 4 is a peer of this gate, not a downstream).

---

## Reference fixtures

The acceptance gate and the per-task tests draw from a single representative fixture, kept at `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/fixtures/schema3-acceptance.json`. Its shape, written here for the record so a TASK author can encode it without ambiguity:

```json
{
  "schema": 3,
  "time": 12,
  "nodes": [
    {
      "kind": "input",
      "id": "n.count",
      "graphId": "g.acceptance.test",
      "value": 7,
      "serializable": true
    },
    {
      "kind": "derived",
      "id": "n.doubled",
      "graphId": "g.acceptance.test",
      "deps": ["n.count"],
      "conditionalDeps": [],
      "value": 14,
      "serializable": true
    }
  ],
  "commits": [
    {
      "time": 5,
      "graphId": "g.acceptance.test",
      "intent": "user-set",
      "changedNodes": ["n.count", "n.doubled"],
      "callGraph": {
        "frames": [
          { "site": "App.tsx:42", "source": "src/App.tsx", "line": 42 },
          { "site": "Counter.tsx:18", "source": "src/Counter.tsx", "line": 18 }
        ],
        "truncatedDeeper": false
      }
    },
    {
      "time": 12,
      "graphId": "g.acceptance.test",
      "intent": "user-set",
      "changedNodes": ["n.count", "n.doubled"]
    }
  ],
  "events": [
    {
      "kind": "subscribe",
      "graphId": "g.acceptance.test",
      "time": 3,
      "nodeId": "n.doubled",
      "subscriptionId": "sub.1"
    },
    {
      "kind": "unsubscribe",
      "graphId": "g.acceptance.test",
      "time": 11,
      "nodeId": "n.doubled",
      "subscriptionId": "sub.1"
    },
    {
      "kind": "dispose",
      "graphId": "g.acceptance.test",
      "time": 11,
      "nodeId": "n.doubled-stale"
    },
    {
      "kind": "read",
      "graphId": "g.acceptance.test",
      "time": 5,
      "nodeId": "n.count",
      "seq": 0,
      "truncated": false
    },
    {
      "kind": "read",
      "graphId": "g.acceptance.test",
      "time": 12,
      "nodeId": "n.count",
      "seq": 0,
      "truncated": false
    },
    {
      "kind": "tx-set",
      "graphId": "g.acceptance.test",
      "time": 5,
      "nodeId": "n.count",
      "seq": 0,
      "value": 7,
      "serializable": true
    }
  ]
}
```

This fixture exercises every event kind, both with and without a `subscriptionId` field on `IRUnsubscribe` (the field is optional per §16.2.1.1), both with and without a `callGraph` annotation on `IRCommit` (the field is optional per §16.2.1.1), and a representative non-trivial `value` payload on `IRTxSet`. The fixture is the seed for property tests in TASK 1.3 test 6 and the input for the acceptance gate.

A second reference fixture at `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/fixtures/schema3-truncated-reads.json` exercises the cap-hit path: a single commit with 300 reads, of which 256 are retained and the 256th is flagged `truncated: true`. The fixture is too long to inline here but is constructed in-test by `tools/checker/tests/fixtures/build-truncated.ts`, which generates the JSON deterministically from a seed.

A third reference fixture at `/Users/rom/workspace/iasbuilt/causl/tools/checker/tests/fixtures/schema2-pre-migration.json` is a hand-authored schema-2 document used as input to TASK 1.4's idempotence and field-preservation tests. It is the *only* schema-2 fixture retained in the tree post-merge, and it lives under a `legacy/` subdirectory specifically excluded from the `Schema` pass's fixture-walker.

---

## Lockstep workflow diff

The exact diff to `/Users/rom/workspace/iasbuilt/causl/.github/workflows/release-checker.yml`:

```diff
       - name: Read versions and assert match
         id: read
         shell: bash
         run: |
           set -euo pipefail
           CARGO_VERSION=$(grep '^version' tools/checker/Cargo.toml | head -1 | sed -E 's/version *= *"([^"]+)".*/\1/')
           NPM_VERSION=$(node -p "require('./packages/checker/package.json').version")
           SCHEMA_FROM_CORE=$(grep -E 'CAUSL_MODEL_SCHEMA *= *' packages/core/src/ir.ts | sed -E 's/.*= *([0-9]+).*/\1/')
           SCHEMA_PINNED=$(grep -E 'causl_model_schema *= *' tools/checker/Cargo.toml | sed -E 's/.*= *"?([0-9]+)"?.*/\1/' || true)
+          SCHEMA_REQUIRED=3
           echo "Cargo: $CARGO_VERSION  npm: $NPM_VERSION  schema(core): $SCHEMA_FROM_CORE  schema(pinned): ${SCHEMA_PINNED:-unset}"
           if [ "$CARGO_VERSION" != "$NPM_VERSION" ]; then
             echo "::error::Cargo.toml version ($CARGO_VERSION) does not match @causl/checker package.json version ($NPM_VERSION)"
             exit 1
           fi
+          if [ "$SCHEMA_FROM_CORE" != "$SCHEMA_REQUIRED" ]; then
+            echo "::error::CAUSL_MODEL_SCHEMA in @causl/core ($SCHEMA_FROM_CORE) does not match the required schema for this release ($SCHEMA_REQUIRED)"
+            exit 1
+          fi
           if [ -n "${SCHEMA_PINNED:-}" ] && [ "$SCHEMA_FROM_CORE" != "$SCHEMA_PINNED" ]; then
             echo "::error::CAUSL_MODEL_SCHEMA in @causl/core ($SCHEMA_FROM_CORE) does not match causl_model_schema pin in tools/checker/Cargo.toml ($SCHEMA_PINNED)"
             exit 1
           fi
           echo "version=$NPM_VERSION" >> "$GITHUB_OUTPUT"
```

And to the trigger block:

```diff
 on:
   push:
     tags:
       - 'checker-v*'
+  pull_request:
+    paths:
+      - 'packages/core/src/ir.ts'
+      - 'tools/checker/Cargo.toml'
+      - 'tools/checker/src/ir.rs'
+      - 'packages/checker/package.json'
+      - '.github/workflows/release-checker.yml'
   workflow_dispatch:
```

The `pull_request` trigger is path-filtered so the workflow only runs on PRs that touch a lockstep-relevant file. The `version-lockstep` job runs on PR; the `build`, `github-release`, `publish-npm`, and `publish-wrapper` jobs are gated on `if: startsWith(github.ref, 'refs/tags/checker-v')` and so do not run on PR.

The `tools/checker/Cargo.toml` addition:

```diff
 [package]
 name = "causl-check"
 version = "0.0.0"
 edition = "2021"

+[package.metadata]
+causl_model_schema = "3"
+
+[features]
+default = ["schema3"]
+schema3 = []
+schema2 = []
+
 [dependencies]
 serde = { version = "1", features = ["derive"] }
 serde_json = "1"
 clap = { version = "4", features = ["derive"] }
 anyhow = "1"

 [dev-dependencies]
+proptest = "1"
+toml = "0.8"
```

The `schema2` feature is a one-release-cycle migration aid for one specific adopter; it is removed in the PR after PR-A. The `default = ["schema3"]` means a plain `cargo build` produces the schema-3 binary.

---

## Codemod algorithm

The `tools/migrate-ir-2-to-3.ts` script implements the following pseudocode, which the TASK 1.4 test suite pins:

```typescript
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const GRAPH_ID_REGEX = /^[A-Za-z0-9_.:-]{1,256}$/

interface MigrateOptions {
  readonly graphId?: string  // explicit; falls back to randomUUID
  readonly seed?: string     // hex; deterministic UUID derivation
}

function migrateOne(json: unknown, opts: MigrateOptions): unknown {
  if (typeof json !== 'object' || json === null) {
    throw new Error('input is not an object')
  }
  const m = json as Record<string, unknown>
  // Idempotent: schema-3 input is returned with no rewrite.
  if (m.schema === 3) return m
  if (m.schema !== 2) {
    throw new Error(`unexpected schema: ${String(m.schema)}`)
  }
  const graphId = opts.graphId ?? deriveGraphId(opts.seed)
  if (!GRAPH_ID_REGEX.test(graphId)) {
    throw new Error(`graphId ${JSON.stringify(graphId)} does not match ${GRAPH_ID_REGEX}`)
  }
  const nodes = (m.nodes as Array<Record<string, unknown>>).map(n => ({ ...n, graphId }))
  const commits = (m.commits as Array<Record<string, unknown>>).map(c => ({ ...c, graphId }))
  return { ...m, schema: 3, nodes, commits, events: m.events ?? [] }
}

function deriveGraphId(seed?: string): string {
  if (seed === undefined) return randomUUID()
  // Deterministic UUID-shape from seed; not cryptographic.
  return `g.seed.${seed}`
}
```

The idempotence property — `migrateOne(migrateOne(x)) === migrateOne(x)` byte-for-byte — is held by the early-return on `schema === 3`. The field-preservation property — every key in the schema-2 input is present in the schema-3 output with the same value — is held by the spread `...m`, which copies every field; the only fields the codemod overwrites are `schema`, `nodes`, `commits`, and (conditionally) `events`. The codemod's CLI entrypoint accepts `--in <dir> --out <dir> [--graphId <name>] [--seed <hex>] [--in-place]` and walks the directory recursively, applying `migrateOne` to every `.json` file.

---

## Out of scope

- **Cross-graph aggregator (§16.2.1.5 deferred).** PR-A puts `graphId` on the wire so a future aggregator does not need a second wire-format break, but does not author the aggregator. The aggregator is a `@causl/devtools-bridge` primitive that merges per-graph IRs from multiple `exportModel` calls; that primitive lives behind a separate trigger and a separate EPIC.
- **Schema 4 forward-compat shape.** We do not draft schema 4 in this EPIC. The `#[non_exhaustive]` discipline on `IrNode` and `IrEvent` reserves the room; the actual shape of schema 4 is tied to whatever future capability triggers it (multi-graph aggregator, async-resource events, snapshot/replay payloads). Speculating on schema 4 here laundered the schema-3 PR's scope.
- **IR consumers outside `@causl/core` and `tools/checker`.** `@causl/devtools-bridge` handles its own update separately per §16.2.1.8 — until its schema-3 PR lands, it ignores the new fields, which is forward-compat. Adapter packages emitting sibling documents own their own schema constants and are unaffected.
- **The four lint passes from §16A.2.1.** `SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose` ship in PR-B and PR-C. PR-A puts the IR-level facts on the wire; PR-B and PR-C author the passes that consume them.
- **The bounded enumerator (§16.4 deferred).** Schema 3 does not enable the bounded enumerator. The enumerator's reopen trigger is independent of the §16A.2 trigger that motivates schema 3.
- **Production-default flip for `captureCallGraph`.** The knob ships defaulting to `true`. The flip to `false` for production builds is a follow-up perf PR with a benchmark gate; it does not block PR-A.
- **External-adopter codemod publishing.** The codemod is in-tree at `tools/migrate-ir-2-to-3.ts`. Publishing it as `@causl/migrate-ir-2-to-3` on npm is a follow-up if and only if an adopter asks for it. The `CHANGELOG.md` entry includes the recipe for running the in-tree codemod against an external directory via `pnpm exec tsx tools/migrate-ir-2-to-3.ts /path/to/fixtures`.

---

## Test rationale at a glance

A roll-up table for reviewers who want the test surface in one view. Every row is a named test that ships in PR-A; every test references the file path it lives in.

| Concern | Test file | Test name | Failure mode caught |
| --- | --- | --- | --- |
| Schema constant immutability | `packages/core/test/ir.test-d.ts` | `CauslModel-schema-is-literal-3` | `as const` removal widens schema to `number`, lockstep gate laundered |
| Discriminator closure | `packages/core/test/ir.test-d.ts` | `IREvent-assertNever-exhaustive` | Sixth `kind` arm added without updating consumers |
| `graphId` required on every node | `packages/core/test/ir.test-d.ts` | `IRNode-graphId-required` | Node constructed without `graphId`, runtime parse fails late |
| JSON round-trip determinism | `packages/core/test/ir.test.ts` | `exportModel-json-byte-stable` | Non-deterministic key ordering, `Date` leakage |
| Structural validator rejects schema-2 | `packages/core/test/ir.test.ts` | `parseCauslModel-rejects-schema-2` | Hand-edited schema-2 fixture passes silently |
| Rust round-trip via proptest, 1000 cases | `tools/checker/tests/ir_roundtrip.rs` | `roundtrip-arbitrary-causl-model` | Serde derive drift, field ordering, missing rename |
| `#[non_exhaustive]` enforced externally | `tools/checker/tests/non_exhaustive.rs` | `external-consumer-must-wildcard` | Adopter's match breaks on schema-4 variant addition |
| Serde rename consistency | `tools/checker/tests/serde_rename.rs` | `field-names-camelcase-on-wire` | `graph_id` leaking into JSON |
| Discriminator literal parity | `tools/checker/tests/serde_rename.rs` | `event-kind-strings-stable` | `tx-set` rendered as `tx_set` |
| Schema-mismatch is structured | `tools/checker/tests/schema_mismatch.rs` | `schema-mismatch-error-shape` | Panic on malformed schema |
| Cargo metadata pinned to "3" | `tools/checker/tests/cargo_metadata.rs` | `cargo-metadata-causl-schema` | Lockstep grep falls through to `unset` |
| Read-trace cap K=256 | `packages/core/test/exportModel.test.ts` | `read-trace-cap-truncated-flag` | Off-by-one, missing flag, flag on wrong record |
| Disposal-tombstone window | `packages/core/test/exportModel.test.ts` | `dispose-tombstone-most-recent-N` | Wrong end of ring drained |
| Subscriber projection no-doubles | `packages/core/test/exportModel.test.ts` | `subscribe-no-double-emission` | Live + pending emitted twice |
| `tx.set` log inside retained window | `packages/core/test/exportModel.test.ts` | `tx-set-foreign-key-to-commits` | `IRTxSet` references pruned commit time |
| `captureCallGraph: false` valid | `packages/core/test/exportModel.test.ts` | `captureCallGraph-false-valid-ir` | Knob wired in name only, default flips silently |
| Property test, 1000 trials | `packages/core/test/exportModel.property.test.ts` | `exportModel-roundtrip-property` | Exporter invariant violated under random ops |
| Codemod idempotent | `tools/test/migrate-ir-2-to-3.test.ts` | `migrate-idempotent-on-schema-3` | Double-application drifts the document |
| Codemod preserves fields | `tools/test/migrate-ir-2-to-3.test.ts` | `migrate-preserves-schema-2-values` | Value normalization, dropped fields |
| Codemod regex enforced | `tools/test/migrate-ir-2-to-3.test.ts` | `migrate-graphId-regex-validation` | Invalid `graphId` injected, runtime rejects |
| Lockstep one-sided bump fails | `tools/test/lockstep.test.sh` | `lockstep-rejects-schema-drift` | Mismatched binary published |
| Fixture migration is byte-stable | `tools/test/fixture-migration.test.ts` | `every-fixture-migrates-cleanly` | Fixture tree post-migration is non-deterministic |
| Schema-2 IR rejected by schema-3 binary | `tools/checker/tests/schema_pass.rs` | `schema-2-rejected-with-message` | Silent migration, panic, missing exit code |
| Schema-3 IR rejected by schema-2 binary | `tools/checker/tests/schema_pass.rs` | `schema-3-rejected-symmetric` | Cutover window unsupported |
| Cargo features mutually exclusive | `tools/checker/tests/feature_flags.rs` | `schema2-and-schema3-cannot-coexist` | Both-features build silently produces broken binary |
| Every fixture passes Schema pass | `tools/checker/tests/fixtures_schema_pass.rs` | `all-fixtures-schema-3` | Forgotten fixture left at schema 2 |
| SARIF rule ID is specific | `tools/checker/tests/sarif_output.rs` | `sarif-schema-mismatch-rule-id` | Reported as `causl/internal-error`, breaks routing |
| Acceptance: cross-language round-trip | `tools/checker/tests/integration/schema-3-roundtrip.rs` | `cross-language-acceptance` | Any TASK regression breaks the EPIC |

The acceptance gate is the last row; every other row is a precondition the gate's success implies but does not exhaustively prove.

---

## Risk register and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Wire-format break breaks an undocumented downstream tool | Medium | Low (tool is undocumented; no SLA) | CHANGELOG stanza calling out tooling consumers; codemod published as a one-liner recipe |
| `captureCallGraph: true` regresses commit-bound benchmark | Medium | Medium | Benchmark gate (existing) catches; default flip to `false` for production builds is a follow-up PR |
| K=256 read cap drops information adopters depend on | Low | Low | `truncated: true` flag is the explicit hint; PR-C (the `UseAfterDispose` pass) emits "pass partial" diagnostic on truncation |
| `graphId` regex rejects an adopter's existing graph name | Low | Low | Adopters who pass `name` get a build-time error at construction; adopters who do not pass `name` get a UUID and are unaffected |
| Codemod drops a field the schema-2 spec did not name but a fixture relies on | Low | Medium | Field-preservation test (TASK 1.4 test 2) walks every field in every fixture and asserts post-migration equality |
| Lockstep workflow's path filter misses a relevant file | Low | Medium | The path filter is conservative (catches every file that influences the check); a missed path means the check does not run on that PR but the on-tag-push run still gates publish |
| `schema2` cutover-window feature outlives one release cycle | Medium | Low | Follow-up PR (post-PR-A) tracked in the EPIC's "Out of scope" stanza; the CHANGELOG entry for the follow-up names the cutover |
| Stack-trace parse fails on a host JS engine that is not V8 | Low | Low | Parse is best-effort; unparseable frames get `site = "<anonymous>"`; no failure mode is an exception |
| Property test seed drift produces a false-positive failure on retry | Low | Low | `propertyTrials` already records the seed in `CAUSL_FUZZ_SEED` and reproduces deterministically; the §15.2 conformance walker catches non-determinism |
| Codemod's `--seed` mode produces collisions between fixtures | Low | Low | The codemod uses `g.seed.<seed>` literal, not a hash; collisions are visible in test output |

---

## What the team considered and rejected

A few alternatives surfaced in the design conversation. We name them here so a future reviewer who comes back to the question knows they were considered.

**"Either schema works" mode in the checker.** Rejected. A binary that accepts both schema-2 and schema-3 documents removes the lockstep gate's load-bearing property: that an out-of-step bump fails loudly. If the binary accepts both, an adopter can publish a schema-2 IR against a binary built from schema-3 code and the checker silently runs the schema-2 path, missing whatever PR-B and PR-C add against schema-3 fields. Wirfs-Brock held the line: the wire format moves once, atomically, with the gate as the safety net.

**Silently migrate schema-2 to schema-3 inside the checker.** Rejected. A silent migration is a second wire format we have to maintain — the migration logic itself becomes a contract. We migrate fixtures via the codemod, which is a one-shot operation with a deterministic output, and we refuse the runtime migration path. Hejlsberg's framing: the checker's job is to verify, not to translate.

**Make `graphId` optional with a default of `"default"`.** Rejected. Optional with a default is an invitation for adopters who do not name their graphs to all collide on the same `graphId` and have the `CrossGraphRead` pass produce false positives across logically-distinct graphs. Miller's framing: a capability that defaults to "everyone has the same one" is no capability. The construction-time UUID fallback is the right discipline; adopters who care name their graphs explicitly.

**Drop the call-graph annotation entirely.** Rejected. Without `IRCallGraph`, the `CommitFromSubscribe` pass (PR-B) has nothing to walk. The pass's whole value proposition is "tell me where this commit came from"; the answer is the call-graph. Markbåge proposed gating capture behind an opt-in instead of an opt-out (default `false`); the team converged on opt-out (default `true`) for development builds, with the explicit expectation that production builds flip the default. The compromise is the `captureCallGraph` knob.

**Use a JSON-schema validation crate (e.g., `schemars`) on the Rust side.** Rejected. The IR is small, the validation is structural, and the serde derives carry most of the weight. Adding a dependency for the few fields that need cross-language validation is overhead we do not need; the hand-rolled validator in TASK 1.1 is 30 lines and the serde derives in TASK 1.2 are the rest.

**Probabilistic sampling for the read trace.** Rejected. §16.2.1.3 names this explicitly: variance defeats differential testing. A random sample of reads on each export means two exports of the same engine state produce different IRs, which breaks the `Determinism` pass's whole premise. The bounded cap with `truncated: true` is the compromise.

**Per-node summary instead of per-event read records.** Rejected. A summary loses ordering, and the `UseAfterDispose` pass (PR-C) needs the temporal ordering to compare `t_d` (dispose time) against `t_r` (read time). The per-event records are the minimum information the pass needs; the cap is the size discipline.

---

## How this lands

A concrete merge plan, written from the team-rep voice for the on-call reviewer:

1. **Day 0 — branch open.** Create `feat/schema-3-ir-foundation` off `main`. Open a draft PR with the EPIC linked and the TASK breakdown in the description.
2. **Day 1 — TASK 1.1 + 1.2 in parallel.** TypeScript types and Rust types land in two commits to the branch. Both have green test suites locally before the commit. The codemod is not yet wired, but the type definitions are static.
3. **Day 2 — TASK 1.3.** Exporter changes land. The property test runs locally with the §15.2 1000-trial floor. The benchmark gate runs locally; we capture the regression number for the `captureCallGraph: true` path and document it in the PR description. If the regression is greater than 5%, we revisit the eager-stack-capture decision and consider lazy parsing.
4. **Day 3 — TASK 1.4.** Codemod authored, fixture tree migrated in-place. The `tools/checker/tests/fixtures/` directory is rewritten in a single commit; the diff is large but byte-deterministic. Reviewers can spot-check by running the codemod themselves and diffing.
5. **Day 4 — TASK 1.5.** Schema pass updated; fixture tree is consumed by the pass with green results. The acceptance gate is wired and run.
6. **Day 5 — PR moved out of draft.** Reviewer cycle. Wirfs-Brock and Hejlsberg are required reviewers; Markbåge reviews the perf-relevant changes; Miller reviews the regex; Beck reviews the acceptance gate.
7. **Day 6-8 — review cycle.** Address feedback. The lockstep workflow's PR trigger fires on every push; the build/publish jobs are gated on tag push and do not run.
8. **Day 9 — merge.** Squash-merge into `main`. The `version-lockstep` job runs on the merge commit (path-filtered) and passes. No release tag is pushed yet.
9. **Day 10 — release tag.** Tag `checker-v0.X.0` (the next minor version). The full release workflow runs: lockstep, build (5 platforms), GitHub release, npm publish (5 per-platform packages plus the wrapper). The new binary is the schema-3-feature default.
10. **Day 10+1 — adopter migration window opens.** Adopters who consume `@causl/core` and `@causl/checker` upgrade together via the lockstep version pin. Adopters with hand-edited fixtures run the codemod. The `iasbuilt/spreadsheet` adopter, who is mid-migration, builds the checker with `--features schema2 --no-default-features` for the cutover window.
11. **Day 24 — cutover window closes.** Follow-up PR removes the `schema2` Cargo feature, the feature-gated code paths, and the `legacy/` fixture subdirectory. CHANGELOG entry names the cutover.

This plan is descriptive, not prescriptive — the actual merge cadence is up to the day-of reviewer. The structure (TASK 1.1 + 1.2 parallel; 1.3 + 1.4 parallel; 1.5; acceptance) is the dependency graph.

---

## Sign-off

- **Wirfs-Brock (schema-versioning, wire-format authority):** the wire format moves once, atomically, with the lockstep gate as the safety net. PR-A is in-scope.
- **Hejlsberg (type-system enforcement):** every IR consumer site terminates in an exhaustive tagged-union match. The `assertNever` discipline is in place. The Rust `#[non_exhaustive]` reserves the room for schema 4 without breaking adopters today. PR-A is in-scope.
- **Markbåge (perf):** the `captureCallGraph` knob ships defaulting to `true`. The production-default flip and the published recipe land in a follow-up. The read-trace cap K=256 is a starting point with the property suite as the safety net. PR-A is in-scope.
- **Miller (capability narrowing):** the per-node `graphId` is the load-bearing capability that makes `CrossGraphRead` decidable at IR-export time with zero false positives. The `name`-from-construction regex is the §16.2.1.5 character-set intersection. PR-A is in-scope.
- **Beck (TDD discipline):** the acceptance gate is the cross-language round-trip test. The EPIC ships the day that test goes green and stays green. Every TASK has a TDD suite with named, specific tests; no placeholder coverage. PR-A is in-scope.
