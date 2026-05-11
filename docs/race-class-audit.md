# Race-class audit — engine rows vs adapter rows

Per SPEC §9.1 and SPEC.async §9.1.1: 17 engine race rows (the §9.1
catalogue) plus 3 adapter race rows (the SPEC.async additions). This
document is the cross-reference table; the property-test files in
`packages/sync/test/properties/race-row-S-1.property.test.ts`,
`packages/sync/test/properties/disposed-mid-load.property.test.ts`,
`packages/sync/test/properties/conflict-registry-drift.property.test.ts`,
and `packages/sync/test/properties/single-writer-resolution.property.test.ts`
are the runtime witnesses.

> **Important divergence notice (#566, partially resolved in #919).**
> The S-row identities used in this audit doc and in some witness
> file names *do not match* SPEC.async §9.1.1's canonical S-1 /
> S-2 / S-3 names. The audit-doc S-rows were authored against an
> earlier draft and ship as the de facto regression-witness set;
> SPEC.async §9.1.1 names a different set of races
> (**Abandon-then-resume** for S-1,
> **Open-set drift mid-resolution** for S-2,
> **Dispatch-shape leak across capability narrowing** for S-3).
> Both sets are real races — the divergence means there are six
> SPEC-named adapter race classes total. As of #919 the SPEC.async
> §9.1.1 row S-2 (Open-set drift) has its property witness at
> `conflict-registry-drift.property.test.ts`; the audit-doc S-2
> identity (disposed-mid-load) keeps its witness at the renamed
> `disposed-mid-load.property.test.ts`. Authoring witnesses for
> SPEC.async §9.1.1 rows S-1 and S-3 remains tracked under #566;
> this doc describes what the existing witnesses cover and is
> honest about which SPEC text it answers to.

## Audit-doc S-row identities (witness-file truth)

### S-1 — Stale-async resolution race (witness: race-row-S-1.property.test.ts)

**Description.** A loader resolves AFTER the resource has been
invalidated. The §3.1 Theorem 1 origin-pinning contract requires
that the post-invalidate state remain Stale, not transition back
to Loaded with the late value.

**Engine cross-reference.** Adjacent to engine row 6 (stale-async)
but specific to the `@causl/sync` adapter's resource-lifecycle
model. The engine's row-6 catalogue covers the in-engine race
shape; this S-1 is the same shape lifted to the resource state
machine.

**Detection layer.** PROPERTY (1000-trial floor). Future PR adds
STATIC detection via the bounded enumerator's
`stale-async-resolution` oracle.

### S-2 — Disposed-mid-load staleness (witness: disposed-mid-load.property.test.ts)

**Description.** A resource is disposed while a fetch is in
flight; the loader resolves to a value that must NOT mutate the
disposed node. The SPEC.async §10.4 worked-example variant.

**Engine cross-reference.** Adjacent to engine row 11
(use-after-dispose) but specific to the resource lifecycle. The
engine's row-11 catalogue covers the node-level dispose race;
this S-2 is the same shape lifted to the resource state machine.

**Detection layer.** PROPERTY (1000-trial floor) plus integration
test in `packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts`.

### S-3 — Conflict-resolution single-writer race (witness: single-writer-resolution.property.test.ts)

**Description.** Two concurrent calls to `registry.resolve` /
`registry.ignore` / `registry.supersede` on the same conflict id.
The §4 single-writer commitment requires that the first mutation
wins; subsequent mutations on the closed conflict are no-ops.

**Engine cross-reference.** No direct engine-row analogue; the
conflict registry is an adapter-level construct. The witness file
shares this race with EPIC-9's single-writer property test.

**Detection layer.** PROPERTY (1000-trial floor). The witness
file enforces both the chart-shape closure (Property 7 in EPIC-9)
and the first-writer-wins arrow.

## SPEC.async §9.1.1 canonical adapter rows (witness audit, #844)

SPEC.async §9.1.1 names three adapter race classes. Each row names a
canonical property-test filename in SPEC.async; the audit (#844)
verifies the witness exists. Findings:

| SPEC.async row | Race | Witness status |
|---|---|---|
| S-1 (SPEC.async) | **Abandon-then-resume** — host issues fetch, then fail mid-load, then a second fetch before the first loader settles | ✓ Present at `packages/sync/test/properties/race-row-S-1.property.test.ts`. Docstring matches (SPEC.async §9.1.1 / row S-1 — stale-async resolution race). The SPEC.async-canonical filename is `resource-lifecycle.property.test.ts`; the actual filename uses the row-id convention. Functionally equivalent. |
| S-2 (SPEC.async) | **Open-set drift mid-resolution** — open-set compute would emit a different set if re-evaluated between requireOpen guard and resolution commit | ✓ Present at `packages/sync/test/properties/conflict-registry-drift.property.test.ts` (#919). The witness fuzzes randomized open-set-source mutations across the (`requireOpen` guard, resolution-Input commit) seam and asserts the §5 atomicity contract holds: the patch's record stamps the same GraphTime the guard read (and the post-resolve `now` is exactly one tick past), so the drift seam is closed structurally. The mis-labelled file `race-row-S-2.property.test.ts` was renamed to `disposed-mid-load.property.test.ts` in the same PR to remove the false S-2 docstring claim. |
| S-3 (SPEC.async) | **Dispatch-shape leak across capability narrowing** — consumer casts a `ConflictRegistryWriteGraph` slice back to `Graph` via `as Graph` | ~ Partial. `packages/sync/test/conflictRegistry.narrowCapability.test.ts` exists and asserts the type-narrowing + `narrowCapability` runtime gate. The SPEC.async-named `narrowCapability.property.test.ts` does not exist as a `.property.test.ts` under `properties/`. The type-system gate is enforced by `tsc`'s structural-typing pass; the runtime gate is the `narrowCapability` proxy from `@causl/core/internal`. Both layers fail closed without a fast-check property test enrolling thousands of trials. |

The audit (#844) closes here. The S-2 divergence was resolved in #919:
the missing canonical witness was authored at
`conflict-registry-drift.property.test.ts`, and the mis-labelled
`race-row-S-2.property.test.ts` was renamed to
`disposed-mid-load.property.test.ts` to remove the false SPEC.async §9.1.1
S-2 claim its docstring made.

## Engine rows ↔ adapter contributions

This table follows **SPEC §9.1's row numbering verbatim** (#568).
Pre-#568 the audit doc renumbered rows around the lint-pass-and-
property-witness surface, which silently shifted readers' SPEC
cross-references off-by-N. Now row N here is row N in SPEC §9.1.

| # | SPEC §9.1 race class | Adapter contribution | Detection layer (this audit) |
|---|---|---|---|
| 1 | Concurrent engine mutations | Inherited verbatim — adapter mutations route through `graph.commit`. | API design (engine-side) |
| 2 | Reading a not-yet-loaded resource value | Adapter-owned — 5-arm `ResourceState<T>` DU forces the tag check. | STATIC (compile-time) |
| 3 | Reading a partially-parsed formula | Engine-side via `FormulaError`; adapter inherits. | RUNTIME guard today, STATIC after `formula.test-d.ts` lands |
| 4 | Reading a committed-but-not-yet-published snapshot | Engine-side; no API surface to read inside another transaction's staging window. | API design |
| 5 | Diamond glitches | Engine-side via §3 semantic equation; adapter composes via Inputs and Deriveds. | Semantic |
| 6 | Stale-async: a fetch returns after its dependency changed | **S-1 (this audit) lifts this to the resource state machine** | RUNTIME (engine) + PROPERTY (adapter S-1 witness) |
| 7 | Dynamic-dependency cleanup | Adapter participates indirectly via §10.4 dispose-mid-load. | Pre-deploy fuzz |
| 8 | Cycle in a derivation graph | Engine-side; `CycleError` at first cycle-closing commit. | RUNTIME, first-commit |
| 9 | Two app-level Msgs producing inconsistent intermediate state | Adapter participates indirectly via §8.3 dispatch shape. | Application-side property tests |
| 10 | Multi-user write-write race | Out of scope for this epic (SPEC §13 future). | Future epic — not promised |
| 11 | Use-after-dispose on a family-keyed node | **S-2 (this audit) lifts this to the resource state machine** | RUNTIME (engine) + PROPERTY (adapter S-2 witness) |
| 12 | Hydration mismatch (server-snapshot id-set ≠ client node-set) | Engine-side via `schemaHash` + `HydrationSchemaError`. | API design |
| 13 | Hydration emitted but subscribers don't wake | Engine-side; `hydrate()` routes through Phase A–H. | API design |
| 14 | Non-monotonic GraphTime on hydrate | Engine-side; `hydrate()` advances `now` by exactly one tick. | API design + semantic |
| 15 | Time-travel jump is view-only and cannot fork an inconsistent history | Engine-side via `snapshotAt(t) → Retained \| Evicted`. | API design + compile-time |
| 16 | Persistence schema-version mismatch silently overwriting on-disk data | Engine + adapter; typed `PersistenceError` DU. | Compile-time + runtime guard |
| 17 | Suspense fresh-Promise-per-render breaks SuspenseList / startTransition | Adapter-owned — Promise lives on `ResourceState.loading`. | API design + PROPERTY (Theorem 3 / promise-identity-stability) |

## Adapter S-rows summary

| Adapter row | Property witness file | Engine row analogue |
|---|---|---|
| S-1 stale-async resolution (audit-doc identity) | `properties/race-row-S-1.property.test.ts` | row 6 |
| S-2 disposed-mid-load (audit-doc identity) | `properties/disposed-mid-load.property.test.ts` | row 11 |
| S-3 single-writer resolution (audit-doc identity) | `properties/single-writer-resolution.property.test.ts` (EPIC-9 Property 7) | (none) |

Per the divergence callout above, SPEC.async §9.1.1's canonical S-rows
(Abandon-then-resume / Open-set drift / Dispatch-shape leak) name a
different set of races; #566 tracks authoring witnesses for those.

## Audit hygiene

- Adding a new race row requires amending this file AND adding a
  property witness file under `packages/sync/test/properties/`.
- The conformance walker (`packages/core/test/spec-15.2-conformance.test.ts`)
  enforces the 1000-trial floor on every property witness.
- Removing a race row requires written team consensus per SPEC §17.2.
- A PR that touches this file or `SPEC.md`/`SPEC.async.md` §9.1 row
  sources must fill the "Race-class impact" section in
  `.github/PULL_REQUEST_TEMPLATE.md`. The lint at
  `tools/lint/race-class-anchor-check.ts` enforces the section is
  present and well-formed (detection layer ∈ {STATIC, PROPERTY,
  MODEL, RUNTIME-ONLY}). **Current state (as of v0.9.0):** the
  workflow that runs the lint lives at
  `.github/workflows-disabled/race-class-anchor-rule.yml` while the
  Tier-2 enumerator scaffold is parked; the lint script itself is
  reachable today via `tsx tools/lint/race-class-anchor-check.ts`
  and the PR-template anchor in
  `.github/PULL_REQUEST_TEMPLATE.md` remains in force.
- The TS test `packages/core/test/spec-race-class-audit-alignment.test.ts`
  and the race-class-anchor lint test
  `packages/core/test/race-class-anchor-lint.test.ts` pin this doc
  against SPEC §9.1 row order and against the S-row witness file
  truth (#568, #566). A future doc rewrite that silently renumbers
  rows or renames S-rows trips the test at PR time.
- The four-way classifier (`.github/workflows/four-way-classifier.yml`,
  #1070, EPIC-7) walks the corpus under
  `tools/enumerator/corpus/` plus the canonical-seed registry across
  four implementations — the TS engine (`commitInternal` in
  `packages/core/src/graph.ts`, starting at line 3507; Phase markers
  at 3690 / 3746 / 3834 / 3840 for Phases A / B / C / C.5), the
  WASM serde bridge (`tools/engine-rs-bridge-serde`), the WASM
  gc-builtins bridge (`tools/engine-rs-bridge-gc`), and the Rust
  enumerator's BFS (`tools/enumerator`). Disagreement arms are
  classified in `tools/enumerator/diff/src/four_way.rs`. The
  classifier is the §16.5 differential-test gate adjacent to this
  audit — when a row's `MODEL` detection layer fires, the witness
  is one of those four arms.

## Adapter-side scattered tests pointing at the audit table

Pre-EPIC-12, race-row-shaped tests were scattered across
`packages/sync/test/`. EPIC-12 / TASK 12.7 documents the table-anchor
references so each pre-existing test is mapped to the row(s) it
witnesses. The mapping is documentary (the tests themselves are
unchanged); maintainers consult this table when adding new race-row
witnesses or auditing coverage.

| File | Row(s) witnessed |
|---|---|
| `packages/sync/test/properties/fetch-interleavings.test.ts` | row 6 (engine stale-async; different angle from S-1) |
| `packages/sync/test/properties/race-row-S-1.property.test.ts` | S-1 audit-doc identity (stale-async resolution) |
| `packages/sync/test/properties/disposed-mid-load.property.test.ts` | S-2 audit-doc identity (disposed-mid-load; renamed from `race-row-S-2.property.test.ts` in #919) |
| `packages/sync/test/properties/conflict-registry-drift.property.test.ts` | SPEC.async §9.1.1 row S-2 (open-set drift mid-resolution; authored in #919) |
| `packages/sync/test/properties/single-writer-resolution.property.test.ts` | S-3 audit-doc identity (single-writer resolution; shared with EPIC-9 Property 7) |
| `packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts` | S-2 audit-doc (integration shape) |
| `packages/sync/test/conflict-impossible-states.test.ts` | structural witness for the §4 chart closure (informs S-3) |
| `packages/sync/test/conflictTransitions.test.ts` | structural witness for the §4 transition table (informs S-3) |

A PR that adds a new race-row test must add an entry to this table
and to the audit table above.
