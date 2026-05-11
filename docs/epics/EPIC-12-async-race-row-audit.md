# EPIC: SPEC.async §9.1.1 Adapter race-row audit

**Spec anchors:** SPEC.async §9.1.1 (formal S-series row format), §17 commitment 5.

**Risk:** LOW — formalization + per-row property tests; existing scattered tests stay.

**Dependencies:** none. Ships today.

> **Current state (as of v0.9.0, 2026-05).** Shipped via Phase 8 wave-1
> (#565, #566, #567, #568, #569, #581 — commit `9664f53`); the audit
> doc lives at `docs/race-class-audit.md`, the PR-template anchor
> lives at `.github/PULL_REQUEST_TEMPLATE.md` "Race-class impact"
> section, and the property witnesses are enrolled in
> `packages/core/test/spec-15.2-conformance.test.ts`. Concrete
> divergences from the original draft:
>
> - **The property-file names diverged from the EPIC's plan.** The
>   draft promised `resource-lifecycle-s1.property.test.ts`,
>   `conflict-open-set-drift.property.test.ts`,
>   `conflict-narrow-capability.property.test.ts`. The repo ships
>   `packages/sync/test/properties/race-row-S-1.property.test.ts`
>   (audit-doc S-1 — stale-async resolution),
>   `packages/sync/test/properties/disposed-mid-load.property.test.ts`
>   (audit-doc S-2 — disposed-mid-load; renamed from the misleading
>   `race-row-S-2.property.test.ts` in #919),
>   `packages/sync/test/properties/conflict-registry-drift.property.test.ts`
>   (SPEC.async §9.1.1 S-2 — open-set drift, authored in #919), and
>   `packages/sync/test/properties/single-writer-resolution.property.test.ts`
>   (audit-doc S-3 — single-writer resolution; co-authored with
>   EPIC-9 Property 7).
> - **The S-row identities forked between the audit-doc and
>   SPEC.async §9.1.1.** The audit-doc S-rows (stale-async,
>   disposed-mid-load, single-writer) were authored against an
>   internal taxonomy; SPEC.async §9.1.1 names different rows
>   (abandon-then-resume, open-set drift, dispatch-shape leak). The
>   doc explicitly documents the divergence in its preamble and the
>   `## Audit-doc S-row identities (witness-file truth)` /
>   `## SPEC.async §9.1.1 canonical adapter rows (witness audit, #844)`
>   sections. #919 reconciled the S-2 row (open-set drift) by
>   authoring `conflict-registry-drift.property.test.ts`; the
>   reconciliation for S-1 and S-3 against the SPEC.async canonical
>   names remains tracked under #566 — runtime + type-system gates
>   for S-3 are in place (`conflictRegistry.narrowCapability.test.ts`),
>   but no `.property.test.ts` enrols thousands of trials yet.
> - **The meta-acceptance test landed under a different name.**
>   `packages/sync/test/properties/race-row-audit-acceptance.test.ts`
>   was not created; the §15.2 conformance walker in
>   `packages/core/test/spec-15.2-conformance.test.ts` (commitment 8
>   witness in `docs/commitment-audit.md`) is the active gate that
>   asserts every property file is enrolled at the 1000-trial floor.
>   The bidirectional table-↔-file invariant from this EPIC's
>   acceptance pseudocode is enforced through the audit doc's
>   manually-maintained "Adapter S-rows summary" table rather than
>   through a parser test.
> - **CODEOWNERS coverage on the audit doc** landed via the broader
>   doc-ownership entry, not a per-file entry written in this EPIC.
>
> The EPIC's structural claim — adapter race-row coverage is named,
> witnessed by property tests at the 1000-trial floor, and required
> on every adapter PR via the template — holds. The S-3
> property-test gap is the most visible remaining piece, tracked at
> #566.

## What I'm shipping

Hejlsberg's framing for this EPIC is the design's spine: type-system enforcement is the §9 dual. The dual is not a parallel surface; it is the *same* surface seen from the other end. Every adapter race row is a transition on the `ResourceState<T>` discriminator. Every chart-illegal edge is a typed error at the boundary. The dual covers the composition because every edge in the trajectory is the same discriminator's transition — there is no second vocabulary, no second alphabet, no second alphabetisation. S-1, S-2, S-3 are not three separate failure modes; they are three *compositions* of the same six-edge chart, audited as rows so adopters can read them as one closed list.

Metz reinforces it from the event-vocabulary side: the seven §5 event classes are exhaustive. There is no eighth class hiding in the adapter; if there were, the adapter would have to emit an event the engine could not consume, and §5's atomicity contract would not hold. The closed event vocabulary is what makes the row-format formalisation tractable — the S-series is *closed* because the events the rows describe are closed. We can audit completeness of the row table because we can audit completeness of the event class set, and §5 already did that work.

Harel's contribution is the chart-by-construction discipline. An episode-scoped chart's properties — re-entry, terminal absorption, abandonment-as-staleness — are recoverable from the chart-by-resource view via projection. The S-1 row exists because the projection is *not* the identity: an episode-scoped chart has a notion of "abandoned but late-settling" that the chart-by-resource view collapses into a single staleness predicate. Harel's framing is that both views are correct and the row format makes the relationship between them legible.

What this EPIC ships:

1. Three formal §9.1.1 S-series rows in `docs/race-class-audit.md` — S-1 (abandon-then-resume), S-2 (open-set drift mid-resolution), S-3 (dispatch-shape leak across capability narrowing).
2. A §9.1.1 cross-reference table mapping the seventeen §9.1 engine rows to the adapter's contributions, so an adopter reading the engine table can find the adapter's row from the engine row's number.
3. Three property test files — one per S-row — at the §15.2 1000-trial floor, enrolled in the conformance walker.
4. A PR-template anchor (§17 commitment 5) requiring every §9.1-row addition to name its detection layer (STATIC / PROPERTY / MODEL / RUNTIME-ONLY) on the same PR.
5. A meta-acceptance test that fails CI if the audit table and the property files drift out of sync — every row in the table must point to a property file, every property file must back a row.

What this EPIC is *not*: it is not the engine §9.1 table itself (that lives in `SPEC.md` and is owned by a separate EPIC); it is not the bundle gates (EPIC-11); it is not the §15 property suite (EPIC-9 covers that, with a different focus — §15 properties are general invariants, §9.1.1 rows are specific race compositions). The boundary is sharp: §9.1 enumerates engine races, §9.1.1 enumerates adapter races, and this EPIC owns the §9.1.1 table.

### Why this EPIC ships now

Survey 3 (the adapter-race-row survey) found all three rows S-1, S-2, S-3 *are tested today* — `staleness.test.ts`, `conflictTransitions.test.ts`, `conflictRegistry.narrowCapability.test.ts`, plus the property file `fetch-interleavings.test.ts` cover the underlying behaviours. The gap is not coverage; the gap is *naming*. An adopter who reads `staleness.test.ts` cannot tell from the file alone that it is the property-test backing of S-1, because S-1 is not a name today — it is a behaviour spread across three test files and several spec paragraphs. The audit table closes the naming gap so the adapter's race surface is legible as a closed list.

Naming-as-discipline is the lesson Metz has been drilling for six months: a behaviour that has no name cannot be reasoned about, cannot be cross-referenced, cannot be regressed-against. The §9.1.1 row format is the naming discipline applied to adapter races. Once the rows have names, the property tests can be re-organised around the names (TASK 12.2-12.4 rename the existing scattered tests into per-row property files), the PR template can require the names (TASK 12.6), and the meta-acceptance test can enforce the names (the acceptance gate). Every downstream piece of discipline is unlocked by the naming.

### Why the row format is anchored on §9.1's engine row format

Hejlsberg's dual is the technical reason; the practical reason is that an adopter who has learned to read the engine table must not have to re-learn how to read the adapter table. The columns are identical: row identifier, edges-fire, edges-do-not-fire, event class, invariant, detection layer, where-caught path, notes. The numbering is different (S-N for adapter, #N for engine) so the two tables are immediately distinguishable, but the row's *shape* is the same. This is the principle of least new vocabulary: the audit table introduces three new row identifiers (S-1, S-2, S-3) and zero new column types.

### What the table *cannot* be

A list. A flat list of "races we test" is what the scattered tests already produce — open `staleness.test.ts` and read the `describe` blocks. If the audit table were just a flat list, it would not improve on the scattered tests; the gain would be only the centralisation. The row format is *richer* than a flat list: each row names the chart edges (which compose), the event class (which closes the alphabet), the detection layer (which sets the discipline), the property file (which makes it regression-resistant), and the notes (which carry the worked example and the open questions). Every column is mandatory because every column is a different kind of falsifiability — without the chart edges column an adopter cannot tell which transitions are involved; without the event class column an adopter cannot tell which §5 contract applies; without the detection layer column an adopter cannot tell which gate is responsible.

A specification. The audit table is *not* a substitute for the spec prose. The rows are anchors *into* the spec; the spec text remains the source of truth. An adopter who reads only the table and never the spec will misunderstand the chart's compositional semantics. We mitigate by including the worked example in each row's notes — the example is concrete enough that an adopter who reads it will be motivated to read the spec section it cites.

A bug list. The rows are not "things that are broken"; they are "races that the system handles correctly, with named composition rules". A row's existence is evidence of *resolution*, not a TODO. This is a critical framing: an adopter scanning the table for "what's wrong" will misread it; an adopter scanning the table for "how does the system handle this race" will read it correctly. The table's introduction in `docs/race-class-audit.md` will say this explicitly.

## Brutal-critical review

Where the spec is right:

- Every chart-illegal edge throws a typed error. The chart's edges are the type system's discriminated-union transitions; the type system rejects illegal edges at compile time and the runtime guard catches the residual cases the type system cannot see (e.g., a deserialized state crossing a network boundary). Hejlsberg's dual is *complete* in this sense, not merely *suggestive*.
- Every typed error has a property test. The §15.2 conformance walker enrols every property file in the suite; the floor is enforced; the suite is required-green. There is no daylight between "we said we test this" and "CI runs the test on every PR".
- The seven §5 event classes are closed. Metz's event vocabulary is small enough to enumerate on a page and that finitude is what makes the row table auditable.
- The chart-by-construction discipline is recoverable. Harel's two views (episode-scoped, resource-scoped) are related by a projection, and the projection is documented; an adopter who reads one view can mechanically produce the other.

Where the spec might be wrong:

- S-1's "composition of three chart edges plus one runtime guard" framing is subtle. Adopters reading the row will wonder if the chart "loses" anything in the composition — i.e., is there a property of the three-edge composition that none of the individual edges captures? The answer is no: the composition is the conjunction of the three edges' guards, and the conjunction is decidable. But the row's prose deserves a worked example to make that obvious. TASK 12.1 includes a worked example as the row's "Notes" field.
- S-2's "open-set drift mid-resolution" framing assumes the seam is closed by §5's atomicity contract. The contract is correct, but the *observability* of the seam from inside a property test is not obvious — a test that claims to exercise the seam needs to show it has actually crossed the boundary. TASK 12.3 includes a "seam-crossing assertion" — the test's invariant must read both pre-Phase-A and post-Phase-A graph time and confirm they differ.
- S-3's "dispatch-shape leak across capability narrowing" framing has a known gap: the type system gate is a `tsc` error, the runtime gate is a proxy throw, but the *third* gate (a static lint pass that catches `as Graph` upcasts in source) is not yet wired. TASK 12.4 names the gap as a deferred follow-up; the runtime gate is sufficient for now because the upcast pattern is rare and the proxy catches it.
- The cross-reference table assumes the engine §9.1 rows are stable. They are *currently* stable (no row has been renamed in the last six months), but the table will need a CI assertion that engine row numbers are immutable once published. TASK 12.1 includes that assertion.
- The PR-template anchor depends on adopters reading the template. We accept that some PRs will skip it; TASK 12.6 mitigates by failing CI when the template's "Race-class anchor" section is empty *and* the PR touches the audit table or §9.1. The combination — template asks, CI enforces only when relevant — is the right pressure level.

Where the design has known unknowns:

- The seventeen engine rows are the current count; the engine team adds rows occasionally. The cross-reference table has to track the engine count or fail loudly. TASK 12.1 concern 4 names this.
- The property tests use `fast-check`'s default shrinker; for S-2 the shrinker is known to be slow on graph commits. We accept the slowness — Tier-1 budget is 1000 trials, not 10,000, so the shrinker's cost is bounded. If shrinking exceeds the budget we'll revisit with a custom shrinker, but that is out of scope for this EPIC.
- The interaction between S-1 and the React Suspense boundary. S-1 is currently scoped to non-Suspense consumers; the Suspense interaction has its own runtime semantics (the Promise the loader returns is the same Promise React throws). The audit table's row for S-1 explicitly notes this scope; a Suspense-specific row (call it S-4) is a follow-up if Suspense changes the abandon-then-resume semantics. We do not believe it does, but the row's notes column flags the question for an adopter.
- The behaviour under React's StrictMode double-invocation. StrictMode runs effects twice in development; this means the loader is created twice and the abandonment path of S-1 runs every render. This is *intentional* — StrictMode is exactly the discipline that exposes S-1 — but the property tests do not run under StrictMode (they don't render React). The unit tests in `staleness.test.ts` cover the StrictMode case; the audit table's row notes this division of labour.
- The interaction with persistence (the offline state). When a resource is loaded from persistence and a fresh fetch is in flight, the chart's edges include a `Persisted → Loading → Loaded` path that the audit table currently does not differentiate. We treat persistence-loaded states as semantically equivalent to a `Loaded` for S-1's purposes; if persistence introduces a distinct race (e.g., persistence-vs-network ordering), it would be a new row. Deferred to a persistence-specific EPIC.

Where the brutal critique points back at us:

- We are formalising rows that already work. The motivation is naming, not bug-fixing. A reader might ask: "if the rows already pass their tests, why does the audit table matter?" The answer is in the *future tense*: every future race we discover will be a new row in this table; every future PR that touches the adapter must consult the table; every future adopter who reads the codebase finds the table as the index. The table's value compounds — it is small today, larger in six months, indispensable in two years. Shipping it now is the lowest-cost moment because the rows are still few enough to enumerate by hand.
- The CI assertions are stricter than the current discipline. PRs today can add a property test without enrolling it in the conformance walker; PRs today can add an exemption without justifying it. Tightening the discipline produces short-term friction (a few PRs will be sent back for the missing enrolment or justification). We accept the friction; the alternative is that the discipline erodes silently over months and we end up with the same naming gap Survey 3 found, but for the next generation of rows.

## Sub-issues (TASKS)

### TASK 12.1 — Add §9.1.1 audit table to `docs/race-class-audit.md`

**Files:** `docs/race-class-audit.md` (new), `packages/sync/README.md` (link added), `SPEC.async.md` cross-reference verified by CI.

The chart-anchored row format from §9.1.1. Three rows (S-1, S-2, S-3) plus the cross-reference table mapping the seventeen §9.1 engine rows to the adapter's contribution column.

The row format is fixed: each row has columns for the row identifier (S-N), the chart edges that fire, the chart edges that do *not* fire, the §5 event class involved, the staleness/atomicity/capability invariant, the detection layer (STATIC / PROPERTY / MODEL / RUNTIME-ONLY), the property file path, and the worked-example reference. The format is anchored on §9.1's engine row format so an adopter who has read one table can read the other without re-learning the columns.

The cross-reference table is keyed on the engine row number (#1-#17). Each engine row has zero, one, or many adapter contributions; the contribution cell names the S-row and a one-line note on how the adapter narrows or composes the engine race.

#### Cross-reference table (preview)

The shape of the cross-reference (final values land in the doc):

| Engine row | Adapter contribution | Notes |
|---|---|---|
| #1 patch-vs-read atomicity | S-2 narrows to open-set predicate | open-set re-emission at `now+1` |
| #2 dual-resolution ordering | S-1 narrows to abandon-then-resume | second-loader's `loadedAt` supersedes first |
| #3 capability narrowing leak | S-3 directly | proxy + tsc dual |
| #4 commit-time monotonicity | (none — engine-only) | adapter inherits |
| #5 episode boundary identity | S-1 supports | Promise identity within episode |
| #6 phase-A read consistency | S-2 supports | guard read = patch commit time |
| #7 deserialization re-entry | S-3 supports | runtime gate is the proxy |
| #8 ... #17 | (filled in TASK 12.1's PR) | |

The preview shows the *shape* of the mapping; the final cell text is finalised when the PR lands. The table's invariants (every cell either references an S-row or says "(none — engine-only)" or "(none — out of scope)") are enforced by the lint check named in concern 4.

#### Row prose template

Each row in the table follows a fixed prose template:

```
### S-N: <short name>

**Chart edges that fire:** <edge-1>, <edge-2>, ...
**Chart edges that do NOT fire:** <edge-X>, ...
**§5 event class:** <class-name>
**Invariant:** <one-sentence>
**Detection layer:** <STATIC | PROPERTY | MODEL | RUNTIME-ONLY>
**Where caught:** `<path/to/property/file.test.ts>`
**Scattered coverage:** `<path/to/scattered/test.ts>`, ...

**Worked example:**

<numbered-step-list>

**Notes:**

<free-form prose; out-of-scope flags; pointers to related rows>
```

The template is enforced by a markdown lint plugin (TASK 12.1 concern 1) that parses each row and asserts every required field is present. A row missing a field fails the lint.

#### TDD test suite (≥5 tests)

- The markdown file passes `markdownlint` with the project's existing config — no new lint rules.
- The S-1, S-2, S-3 rows match the §9.1.1 prose verbatim (a fixture parses the spec section and asserts the row text is identical).
- The cross-reference table maps every adapter contribution to a §9.1 row that exists today.
- Every row's "where caught" column references a real test file (the path resolves on disk).
- A PR that adds a new race class to the codebase but does NOT update the audit table is rejected by CI — a static check scans for new property files matching `*.race.test.ts` and fails if their basename is not enrolled in the audit table.

#### 5 concerns

1. **Naming discipline** — S-1, S-2, S-3 are stable identifiers, never renamed across PRs. The lint check fails any PR that renames an S-row in `docs/race-class-audit.md`. New rows append (S-4, S-5, ...) — they do not reorder.
2. **Chart-edge cross-reference** — every row names the §6 chart edge that fires AND the chart edge that does not fire. This is the dual: the row is not just "what happens" but also "what is forbidden by composition". The row is incomplete without both.
3. **Property-test cross-reference** — every row names the property file that catches the regression. The path is required and validated; an empty cell fails the lint.
4. **Engine-row cross-reference** — the §9.1 audit table includes the seventeen engine rows (#1-#17) with the adapter's contribution column. The row numbers are immutable once published; the lint check fails any PR that renumbers an existing engine row. New engine rows append.
5. **No race condition** — markdown is static. The audit table itself has no concurrency surface; the only races are in the property tests it indexes.

### TASK 12.2 — S-1 property test: `resource-lifecycle-s1.property.test.ts`

**Files:** `packages/sync/test/properties/resource-lifecycle-s1.property.test.ts` (new).

Per §9.1.1 S-1. The row's prose: "An episode whose loader is abandoned and replaced before the first loader settles must record the late settle as `stale`, not `loaded`. The chart edges `Loading → Errored → Loading` (re-entry) and the runtime guard `loadedAt > origin_first` compose to make the first loader's late resolution land as `stale` and the second loader's clean resolution land as `loaded`."

The property test generates random `fetch / fail / fetch` sequences (using `fast-check`'s `commands` generator) with controlled loader Promise identities. Each loader is a deferred whose resolution we control; the test interleaves resolution with new fetch calls and asserts the final state matches the row's invariant.

#### Worked example (S-1)

The row's worked example is the abandon-then-resume sequence Harel uses to teach the projection between the two chart views:

1. The component subscribes to a resource at `t=0`. State: `Loading(loader_A, origin_first=0)`.
2. The loader fails at `t=1` (network error). State: `Errored(error, origin_first=0)`.
3. The component re-subscribes at `t=2`, triggering a new loader. State: `Loading(loader_B, origin_second=2)`. The chart edge `Errored → Loading` fires; this is a chart-legal re-entry.
4. At `t=3`, `loader_B` resolves cleanly. State: `Loaded(payload_B, loadedAt=3)`. The chart edge `Loading → Loaded` fires for `loader_B`.
5. At `t=4`, `loader_A` *also* resolves (it had been awaiting in the background; the deferred we used to fail it earlier was a separate signal). The runtime guard `loadedAt > origin_first` fires: `loadedAt=4 > origin_first=0` is *true*, but the *current* state's `loadedAt=3` is *also* greater than `origin_first=0`, so the guard's question is "does the late settle replace the current state?" The answer: no, because `origin_first` is the *first* loader's origin, and the second loader's `loadedAt` already supersedes it. The late settle is recorded as `stale` — its payload is preserved (so adopters can inspect it for debugging) but the current state remains `Loaded(payload_B, loadedAt=3)`.

The property test enumerates random sequences of this shape and asserts the final state's `payload` is always `payload_B` (the second loader's), never `payload_A` (the first loader's late settle).

#### 5 concerns

1. **1000-trial floor** — `numRuns: 1000` from `CAUSL_PROPERTY_TRIALS` env (or the floor from §15.2). The conformance walker (TASK 12.5) rejects lower values.
2. **Episode boundary** — both loaders' Promise identities are tracked; `===` within an episode (two awaits of the same loader produce the same Promise), `!==` across episodes (a fetch-after-fail produces a fresh Promise). The test asserts both invariants.
3. **Staleness guard for first loader** — `loadedAt > origin_first` is the runtime guard; the test asserts the first loader's resolved state has `staleness === "stale"` and that the second loader's resolved state has `staleness === "fresh"`. The two assertions together exclude the race outcome where the first loader "wins" the second loader's slot.
4. **Re-entry edge** — `Errored → Loading` is a chart-legal edge. The test asserts the chart accepts the transition; a chart-illegal version of this test (with a chart that forbids re-entry) would fail at the typed-error layer, not the property layer.
5. **No race condition** — controlled loaders. The test does not use real timers or real network; the deferreds are resolved in-test, so there is no wall-clock dependency. This is the §15.2 discipline: property tests must be deterministic given a seed.

### TASK 12.3 — S-2 property test: `conflict-open-set-drift.property.test.ts`

**Files:** `packages/sync/test/properties/conflict-open-set-drift.property.test.ts` (new).

Per §9.1.1 S-2. The row's prose: "An open-set predicate evaluated mid-resolution must observe the same GraphTime as the patch commit that closes the resolution. The §5 atomicity contract closes the seam: guard read and patch commit are in the same Phase A, and the open-set re-emission happens at `now+1`."

The property test generates random open-set predicates (modeled as graph-query expressions over a small fixed schema), random resolution payloads, and interleaves them with random graph commits. The invariant: at every Phase A boundary, the predicate's read time equals the patch's commit time, and the resolution payload is preserved across the commit.

#### Worked example (S-2)

The row's worked example is the open-set drift sequence Metz uses to teach the §5 atomicity boundary:

1. A consumer registers an open-set predicate `P = { x | x.status === "pending" }` at `t=0`. The predicate evaluates against `GraphTime=g0` and emits the initial set `{x1, x2}`.
2. At `t=1`, the consumer initiates a resolution: it calls `resolve(x1, payload="approved")`. The resolution enters Phase A.
3. Inside Phase A: the guard reads `P(x1)` at `GraphTime=g0` (still `g0`, because the guard read is in Phase A). The guard returns `true` (x1 is pending). The patch commits at `GraphTime=g0` (the *same* GraphTime — this is the atomicity contract: guard and patch share a single Phase A's read view).
4. Phase A closes. `GraphTime` advances to `g1`. The patch's effect is visible at `g1`.
5. The open-set predicate re-emits at `t=now+1` (i.e., at `GraphTime=g1`, after the commit). The new emission removes x1 from the set (because x1 is no longer pending). The re-emission carries the payload `"approved"` opaquely — the consumer can read it from the resolution event but the predicate's set membership is independent of the payload.

The property's invariant: the guard's read time and the commit's time, observed inside Phase A, are equal. If the test's instrumentation observes `read_time !== commit_time`, the §5 atomicity contract is broken and the test fails. The property's secondary invariant: the re-emission's GraphTime is strictly greater than the commit's. If they were equal, the open-set's monotonic-emission discipline would be violated (an adopter would see two emissions at the same GraphTime, with no way to order them).

#### 5 concerns

1. **1000-trial floor.** Same discipline as TASK 12.2.
2. **Same Phase A** — guard read and patch commit observe the same GraphTime. The test reads the GraphTime at both points and asserts equality. This is the §5 atomicity contract operationalised.
3. **Resolution preserves payload** — opaque `resolution` value carried across the commit. The test generates a random opaque value (a string with no semantic structure), commits the patch, and asserts the value at the post-commit read site equals the value at the pre-commit guard site.
4. **Open-set re-emission** — happens at `now+1`, not in the same Phase A. The test asserts the re-emission's GraphTime is strictly greater than the commit's. A re-emission at the same GraphTime would fold the "after" event into the "before" view and break the open-set's monotonic-emission discipline.
5. **No race condition** — single-threaded. The test simulates the seam by sequencing the guard read and the commit explicitly; there is no actual concurrency. The property is structural, not temporal.

### TASK 12.4 — S-3 property test: `conflict-narrow-capability.property.test.ts`

**Files:** `packages/sync/test/properties/conflict-narrow-capability.property.test.ts` (new).

Per §9.1.1 S-3. The row's prose: "A consumer holding a narrowed capability slice (e.g., `ConflictRegistryWriteGraph`) that attempts to upcast to a wider capability (e.g., `Graph`) must be rejected at compile time by the type system and at runtime by the `narrowCapability` proxy. The composition rejects the leak across the narrowing boundary."

The property test generates random consumer code (modeled as a small AST of capability operations) holding a narrowed slice, then attempts the upcast via `as Graph`. The invariant: the upcast either fails to compile (the typed-error layer caught it) or throws `CapabilityViolation` at runtime (the proxy caught it).

#### Worked example (S-3)

The row's worked example is the dispatch-shape leak Hejlsberg uses to teach the dual:

1. A handler is registered with the conflict registry; the registry passes the handler a narrowed `ConflictRegistryWriteGraph` slice. The slice exposes only the methods the handler is allowed to call (a subset of `Graph`'s surface — the conflict-relevant writes plus a read-only view of the rest).
2. The handler attempts an upcast: `const wide: Graph = slice as unknown as Graph`. The type system has been bypassed via `as unknown as` — `tsc` sees the cast and accepts it because the consumer asserted the wider type. (This is the bypass case; the un-bypassed case `slice as Graph` is rejected by `tsc` directly with TS2352.)
3. The handler calls a method on `wide` that exists on `Graph` but not on `ConflictRegistryWriteGraph`: `wide.unrestrictedWrite(...)`.
4. The proxy's `get` trap fires. The trap reads the called method's name, looks it up in the slice's allowlist, finds it absent, and throws `CapabilityViolation` with a message naming the method and the slice's name.
5. The registry's overlay value is unchanged — the throw happens *before* any side effect, so the §5 atomicity contract is preserved.

The property test enumerates random method names (some in the allowlist, some not) and asserts: methods in the allowlist execute normally; methods not in the allowlist throw `CapabilityViolation`; in either case, the registry's overlay value before the call equals the value after the call (modulo the legitimate write the in-allowlist methods perform).

#### 5 concerns

1. **1000-trial floor.** Same discipline.
2. **Type-system gate** — the upcast is a `tsc` error before runtime. The test's compile-time leg is a fixture file that the test runs `tsc --noEmit` against; the fixture must produce an error of code TS2352 or TS2322 (the structural-type-mismatch codes) on the upcast line. A fixture that compiles cleanly fails the test.
3. **Runtime gate** — the proxy throws on dishonest upcast via `as Graph`. The test forces the upcast (using `as unknown as Graph` to bypass the type system) and asserts the proxy's `get` trap throws `CapabilityViolation` with the expected message. This is the runtime safety net for the deserialization case where the type system cannot see the upcast.
4. **No-effect on registry overlay** — the leak attempt does not change the overlay value. The test reads the overlay value before and after the failed upcast and asserts equality. A leak that *partially* succeeded — e.g., one that changed state before throwing — would violate the §5 atomicity contract.
5. **No race condition** — single-threaded. The proxy's enforcement is synchronous; there is no async surface in this row.

### TASK 12.5 — Conformance walker enrolment for the 3 new property files

**Files:** `packages/core/test/spec-15.2-conformance.test.ts` (modified — adds the three new files to the walker's expected-files list).

Confirm the walker discovers the three new files; confirm the trial floor is enforced; confirm the enrolment is exhaustive (no double-counting, no skipped files).

The conformance walker is the §15.2 enforcement layer: it parses every `*.property.test.ts` file under `packages/sync/test/properties/`, asserts each file declares `numRuns: 1000` (or reads the env), and asserts the file is enrolled in the expected-files list. A file that exists but is not enrolled fails the walker; a file that is enrolled but does not exist also fails.

#### 5 concerns

1. **Walker discovers `resource-lifecycle-s1`, `conflict-open-set-drift`, `conflict-narrow-capability`** — the three basenames are added to the walker's expected-files list. The walker runs as part of `pnpm test:run` and is required-green.
2. **Floor enforced** — `numRuns: 100` is rejected. The walker parses each file's `fc.assert` calls and reads the `numRuns` literal (or the env-var fallback); a value below 1000 fails the walker.
3. **The enrolment doesn't double-count files** — a file added to the list twice is rejected. The walker uses a `Set` and asserts the array's length equals the set's size.
4. **No-skip** — a property file that is added to the directory but not enrolled in the walker is rejected. This is the discovery-vs-enrolment gate: discovery finds files on disk, enrolment lists them in the walker; the two sets must match exactly.
5. **Single-threaded walker.** The walker reads files synchronously and runs in a single Vitest worker; there is no concurrency surface in the walker itself. (The property tests it enrols are independently single-threaded per TASK 12.2-12.4 concern 5.)

### TASK 12.6 — PR template anchor for §9.1 row updates

**Files:** `.github/PULL_REQUEST_TEMPLATE.md` (modified — adds the "Race-class anchor" section).

Per §17 commitment 5. The PR template asks every §9.1-row addition to name its detection layer (STATIC / PROPERTY / MODEL / RUNTIME-ONLY) on the same PR. The template's "Race-class anchor" section is required when the PR touches `docs/race-class-audit.md` or `SPEC.async.md` §9.1.

The section's required fields:
- Row identifier (S-N or engine row #N).
- Detection layer (STATIC / PROPERTY / MODEL / RUNTIME-ONLY).
- Property file path (if PROPERTY).
- Static pass name (if STATIC).
- Model file path (if MODEL).
- Justification for RUNTIME-ONLY (if RUNTIME-ONLY) — RUNTIME-ONLY is the discouraged tier; the justification is required so adopters cannot silently downgrade a row that should be PROPERTY or STATIC.

A lint check (`tools/lint/race-class-anchor-check.ts`) parses the PR body via the GitHub Actions context and fails if the section is empty when the PR touches the audit-table files. The lint runs in the existing required-green workflow.

#### 5 concerns

1. **The template includes a `## Race-class anchor` section** — the section is added between the existing "Summary" and "Test plan" sections; the order is fixed.
2. **CI fails if the section is empty AND the PR touches `docs/race-class-audit.md` or `SPEC.async.md` §9.1** — the conjunction is the right pressure level. PRs that don't touch the audit table do not need the section; PRs that do, do.
3. **The DESIGN-DISCIPLINE commitment is documented** — §17 commitment 5 is referenced from the template's section header so adopters reading the template can find the spec text without searching.
4. **Every adapter-touching PR honours the template** — the lint runs on every PR, not only on PRs labelled with `audit-table`. Labels are too easy to skip; path-filters on the audit-table files are the enforcement mechanism.
5. **No race condition** — the lint runs single-threaded inside one Actions job; there is no concurrency in the lint itself.

### TASK 12.7 — Migration of existing scattered tests to point at the audit table

**Files:** `packages/sync/test/staleness.test.ts` (modified — adds `// @audit-row: S-1` header), `packages/sync/test/conflictTransitions.test.ts` (modified — header for whichever row(s) it covers), `packages/sync/test/conflictRegistry.narrowCapability.test.ts` (modified — header for S-3), `packages/sync/test/properties/fetch-interleavings.test.ts` (modified — header for S-1).

The scattered tests Survey 3 found are not deleted by this EPIC — they continue to provide unit-level coverage that the property tests do not duplicate. They are *annotated* with the row identifier they back, so an adopter reading a scattered test can find the audit table from the test, and an adopter reading the audit table can find the scattered tests from the row's notes column.

The header comment format is fixed: `// @audit-row: S-N` on the first non-shebang line of the file. Multiple rows are allowed: `// @audit-row: S-1, S-2`. The meta-acceptance test reads these headers and includes the scattered tests in the row's "where caught" list (alongside the primary property file).

#### 5 concerns

1. **Header format is parseable** — the `@audit-row:` comment is regex-readable (`^//\s*@audit-row:\s*(S-\d+(\s*,\s*S-\d+)*)\s*$`); a malformed header is a CI failure.
2. **Backwards-compatible** — the header is a comment, so adding it does not change test behaviour. Every modified file still passes its existing tests.
3. **No deletion** — the scattered tests stay. This EPIC adds names; it does not remove coverage. The deletion question (do we eventually consolidate the scattered tests into the per-row property files?) is deferred to a later EPIC.
4. **Cross-link** — the audit table's notes column for each row lists the scattered tests in addition to the primary property file, so the relationship is visible in both directions.
5. **No race condition** — the headers are static text in test files.

## Acceptance gate

`packages/sync/test/properties/race-row-audit-acceptance.test.ts` (new) — meta-test importing the three new property files and parsing `docs/race-class-audit.md`; asserts every row in the audit table has a corresponding property file, and every property file has a row.

### Acceptance test pseudocode

```typescript
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import "./resource-lifecycle-s1.property.test";
import "./conflict-open-set-drift.property.test";
import "./conflict-narrow-capability.property.test";

const auditTablePath = resolve(__dirname, "../../../../docs/race-class-audit.md");
const auditTableSource = readFileSync(auditTablePath, "utf8");

describe("§9.1.1 race-row audit acceptance", () => {
  test("every S-row in the audit table has a property file", () => {
    const rowsInTable = parseSRows(auditTableSource); // returns Set<"S-1" | "S-2" | ...>
    const filesOnDisk = listPropertyFiles(__dirname); // returns array of { path, declaredRows }
    const rowsInFiles = new Set(filesOnDisk.flatMap(f => f.declaredRows));
    expect(rowsInTable).toEqual(rowsInFiles);
  });

  test("every cross-reference cell points at a real S-row or a sentinel", () => {
    const cells = parseCrossReferenceCells(auditTableSource);
    for (const cell of cells) {
      if (cell.kind === "s-row") {
        expect(parseSRows(auditTableSource)).toContain(cell.id);
      } else {
        expect(cell.kind).toMatch(/^(none-engine-only|none-out-of-scope)$/);
      }
    }
  });

  test("every property file's @audit-row header is parseable", () => {
    const files = listPropertyFiles(__dirname);
    for (const file of files) {
      expect(file.declaredRows.length).toBeGreaterThan(0);
      for (const row of file.declaredRows) {
        expect(row).toMatch(/^S-\d+$/);
      }
    }
  });

  test("engine row numbers are in [1, 17] and unique", () => {
    const engineRows = parseEngineRowNumbers(auditTableSource);
    expect(new Set(engineRows).size).toBe(engineRows.length);
    for (const n of engineRows) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(17);
    }
  });
});
```

The pseudocode is illustrative; the final test will live in the file named at the top of this section. The shape is the contract: parse the markdown, parse the headers, assert the bidirectional mapping, assert the engine-row range.

The meta-test's invariants:

1. The set of S-row identifiers in the audit table equals the set of S-row identifiers declared in the property files (each file declares its row via a `// @audit-row: S-N` header comment).
2. Every S-row identifier matches the format `^S-\d+$` — no informal IDs.
3. The cross-reference table's adapter-contribution column references S-rows that exist in the same document.
4. The cross-reference table's engine-row numbers are in the range `[1, 17]` and are unique (no duplicate engine rows in the table).
5. Every property file referenced by a row resolves on disk and exports a Vitest test suite (the meta-test imports the file and asserts the import succeeds).

The meta-test is required-green and runs in Tier-1 (per EPIC-6's CI hierarchy). It is the closing of the loop: the audit table cannot drift from the property files because the meta-test fails CI on drift.

## Out of scope

- The Engine §9.1 row updates (separate; live in `SPEC.md` and are owned by the engine team's audit-table EPIC, not this one).
- Bundle gates (EPIC-11) — bundle-size checks for the new property files are inherited from EPIC-11's gate; this EPIC adds no new bundle surface.
- Property suite (EPIC-9) covers the §15 properties (different focus). EPIC-9's properties are general invariants over the engine's state space; this EPIC's properties are specific race compositions in the adapter. The two are complementary, not overlapping.
- The third gate for S-3 (a static lint pass for `as Graph` upcasts in source). The runtime proxy gate is sufficient for now; a static lint pass is a follow-up EPIC if the upcast pattern becomes more frequent.
- Custom shrinkers for the property tests. `fast-check`'s default shrinker is acceptable at the 1000-trial floor; if Tier-2 (10,000 trials) shows shrinking cost dominating, a custom shrinker is a follow-up.
- Localization of the audit table (the row prose is English-only; no translation discipline is in scope).
- Performance benchmarks for the property tests. The 1000-trial floor's runtime is bounded by Tier-1's 2-min budget (per EPIC-6); a per-row benchmark is not in scope. If a row's property test exceeds 30s wall-clock, a follow-up EPIC will investigate.
- The model-checker corpus for these rows. The Apalache models for S-1, S-2, S-3 are a follow-up EPIC; the property tests are the Tier-1 layer, the models are the Tier-3 layer (per EPIC-6's tier hierarchy).
- Visualisation of the chart edges in the audit table. The row's prose names the edges textually; a graphical view (e.g., embedded SVG or a separate chart-viewer page) is a documentation polish task for a later EPIC.

### Open questions deferred

- Should the audit table track a row's history (when it was added, when it was last revised)? A `history` column would help adopters understand the row's stability but adds maintenance burden. Deferred; we will reconsider if a row needs to be revised in the next quarter.
- Should the row format include a "negative example" column (a sequence that *looks like* the row's race but is actually a different row)? Negative examples are pedagogically valuable but the format is already wide. Deferred to the documentation-polish EPIC.
- Should the cross-reference table also map to §16A (race-detection CI) rows? §16A's rows are about *when* the detection runs (Tier-1, Tier-2, Tier-3), not *what* it detects, so the mapping is mostly orthogonal — but a "tier" column on each S-row would let an adopter see which tier catches the row's regression. Deferred; we will revisit after EPIC-6 lands.

## Sequencing

The tasks are independent at the file level and can land in any order, but the meta-acceptance test (the acceptance gate) depends on all of TASK 12.1–12.5 being complete. The recommended sequence:

1. TASK 12.1 (audit table) — establishes the format and the cross-reference. Lands first because the row identifiers are referenced by every downstream task.
2. TASK 12.2, TASK 12.3, TASK 12.4 (property tests) — three independent PRs, each landing one S-row's property file. Can land in parallel with each other; each PR is reviewed by the row's owner (S-1 by Harel for the chart-projection check, S-2 by Metz for the atomicity-contract check, S-3 by Hejlsberg for the type-system check).
3. TASK 12.5 (walker enrolment) — depends on the three property files existing. Lands after TASK 12.2-12.4 are merged.
4. TASK 12.6 (PR template) — independent of the property work; can land in parallel with any of the above.
5. TASK 12.7 (migration of scattered tests) — independent of the property work; can land in parallel with TASK 12.2-12.4.
6. Acceptance gate — final PR; lands after all of the above and flips the meta-test to required-green.

The whole EPIC is sized for one sprint (5 working days). Per-task estimates: TASK 12.1 ~1 day (drafting the prose, building the cross-reference, wiring the lint); TASK 12.2/12.3/12.4 ~0.5 day each (the test logic is mechanical given the row format); TASK 12.5 ~0.25 day; TASK 12.6 ~0.5 day (the GitHub Actions integration is the time-sink); TASK 12.7 ~0.25 day; acceptance gate ~0.25 day. Total ~3.75 days with buffer for review.

The risk is LOW because every task is additive — no existing test is removed, no existing row is renamed, no existing CI gate is weakened. The only failure mode is the meta-acceptance test catching a drift, which is exactly the failure mode we want.

### Review discipline

Every PR in this EPIC is reviewed by at least two of {Hejlsberg, Metz, Harel}. The discipline is symmetric to the row format: the dual (Hejlsberg) and the chart projection (Harel) and the event-vocabulary closure (Metz) are co-authoritative on the row's correctness. A single reviewer is not enough because each of the three views can miss an error the others would catch.

For the property tests specifically, the third reviewer is the test-infrastructure owner (currently Lin, per the team rotation) — they verify the conformance walker enrolment, the trial floor, and the determinism of the test under a fixed seed. This is the §15.2 enforcement view; it is orthogonal to the row's content.

## Anchors recap

- SPEC.async §9.1.1 — formal S-series row format.
- SPEC.async §17 commitment 5 — DESIGN-DISCIPLINE: every §9.1-row addition names its detection layer.
- SPEC.async §6 — chart edges referenced by row's "edge fires / does not fire" columns.
- SPEC.async §5 — closed event vocabulary, atomicity contract.
- SPEC.async §15.2 — property-suite floor (1000 trials), conformance walker.
- SPEC.md §9.1 — engine row table cross-referenced by the §9.1.1 table.

Hejlsberg signs the dual; Metz signs the event-vocabulary closure; Harel signs the chart-by-construction projection. The team-lead authority for the EPIC is Hejlsberg; Metz and Harel are co-authoritative on the row format itself. The EPIC ships today.
