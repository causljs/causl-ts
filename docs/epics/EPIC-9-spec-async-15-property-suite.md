# EPIC: SPEC.async §15 property suite + `@causl/sync-testing-internal` package

> **Current state (as of v0.9.0): SHIPPED — minor divergences from plan.**
> EPIC-9 landed via PR #555 (commit `7386aa1`, "test(sync): EPIC-9 — SPEC.async §15 property suite (8 properties at 1000-trial floor)"). All eight property files exist under `packages/sync/test/properties/`; the `@causl/sync-testing-internal` workspace package ships at `packages/sync-testing-internal/`. Subsequent work refined the original drop: PR #610 (Phase 8 #578) retrofitted the harness factories to wrap a LIVE `@causl/core` Graph (replacing the pre-#578 model-state simulation, with `applyEventsLive`/`applyConflictEventsLive` shipped alongside the original signatures); PR #1153 (commit `4a4e915`) routed property tests through `tieredPropertyTrials` (the tier-aware variant) instead of plain `propertyTrials`. Several additional property files appeared in `packages/sync/test/properties/` after the EPIC drop (`disposed-mid-load.property.test.ts`, `evaluate-statechart-agreement.property.test.ts`, `conflict-registry-drift.property.test.ts`, `race-row-S-1.property.test.ts`) — those came from EPIC-12 and downstream work and are out of scope for this EPIC. The conformance walker baseline was NOT extended with the eight EPIC-9 names (TASK 9.10 did not need to land — the walker's auto-discovery rules cover the `/properties/` directory by construction). The planned `all-properties-acceptance.test.ts` meta-test did not ship. See per-section "Divergence" callouts below.

**Spec anchors:** SPEC.async §15.0 (property predicates formalised), §15.1 (Resource properties 1–4), §15.2 (Conflict properties 5–8), §15.3 (1000-trial floor), §17.1 commitment 8 (the §15 properties hold at the floor), with composition into the `spec-15.2-conformance.test.ts` walker that already enforces the floor across every property suite in the workspace.

**Risk:** LOW — additive test files plus one new dev-only workspace package. No production runtime change. No public API change on `@causl/sync`. No engine-side change beyond a one-line walker self-check that asserts the new property files were discovered. (As shipped: no walker baseline change was needed — the auto-discovery rules already cover `packages/sync/test/properties/`.)

**Dependencies:** none. Ships today. (Shipped.)

## Property-to-anchor table

The eight properties anchor as follows. Each row names the property number, the file we ship, the `propertyTrials` label the seam helper uses, the §15.0 chart anchor, and the §9.1 race row (if any) the property covers as a regression vector.

| # | File | Label | Chart anchor | §9.1 race row |
| --- | --- | --- | --- | --- |
| 1 | `lifecycle-exhaustiveness.property.test.ts` | `resource.lifecycle-exhaustiveness` | §6 five-arm DU on `Resource<T>` | umbrella; covers any sixth-arm regression |
| 2 | `origin-bound-resolution.property.test.ts` | `resource.origin-bound-resolution` | §3 Theorem 1 (origin equality) | row 6 (stale-async) |
| 3 | `forbidden-resource-transitions.property.test.ts` | `resource.forbidden-transitions` | §6 transition table; §17 commitment 7 | (no specific row; covers off-chart writes) |
| 4 | `promise-identity-stability.property.test.ts` | `resource.promise-identity-stability` | §3 Theorem 3 (Promise identity) | row 17 (Suspense fresh-Promise) |
| 5 | `conflict-lifecycle-exhaustiveness.property.test.ts` | `conflict.lifecycle-exhaustiveness` | §4 four-arm DU on `Conflict<T>` | umbrella; covers any fifth-arm regression |
| 6 | `forbidden-conflict-transitions.property.test.ts` | `conflict.forbidden-transitions` | §4 transition table; §17 commitment 7 | (no specific row; covers off-chart writes) |
| 7 | `single-writer-resolution.property.test.ts` | `conflict.single-writer-resolution` | §4 single-writer; §13.7 multi-user boundary | (no specific row; covers multi-write leak) |
| 8 | `open-set-computation.property.test.ts` | `conflict.open-set-computation` | §4 derived-view commitment | (no specific row; covers overlay glitch) |

The existing `fetch-interleavings.test.ts` is a ninth file in the discovery set, with label `fetch-interleavings`; it covers Theorem 1 from a different angle (random-program statechart-invariant fuzzing), and is unchanged by this EPIC.

## What I'm shipping

We are landing the seven property suites that §15.0 formalised but did not yet ship in code, plus the `@causl/sync-testing-internal` package the seven suites consume. Today the adapter has exactly one property suite — `packages/sync/test/properties/fetch-interleavings.test.ts`, which covers the Theorem 1 staleness arrow at 1000 trials and is the EPIC's existence proof that the seam (`propertyTrials` from `@causl/core/testing`) and the conformance walker (`packages/core/test/spec-15.2-conformance.test.ts`) compose end-to-end. The remaining seven properties from §15.1 and §15.2 are prose with no runtime witness. Sandi Metz's framing on this is the load-bearing one: **make the test prove the rule, not the example.** A property whose generator was written by reading the prose once and typing the obvious shape is a property whose generator covers exactly the cases the prose author already had in mind — every other case is an example the test does not prove. Corey Haines's deliberate-practice framing is the discipline that keeps the generator honest: a property whose generator is a one-liner is a property whose author has not yet thought about what the property is for. We pay both costs once, on the eight predicates, and we never pay them again until the chart changes.

The suites we ship are eight files under `packages/sync/test/properties/`, one per property: `lifecycle-exhaustiveness.property.test.ts`, `origin-bound-resolution.property.test.ts`, `forbidden-resource-transitions.property.test.ts`, `promise-identity-stability.property.test.ts`, `conflict-lifecycle-exhaustiveness.property.test.ts`, `forbidden-conflict-transitions.property.test.ts`, `single-writer-resolution.property.test.ts`, `open-set-computation.property.test.ts`. The existing `fetch-interleavings.test.ts` stays where it is — it has a different shape (it asserts statechart invariants over a random program DSL rather than a single chart predicate), and renaming or merging it would break the `spec-15.2-conformance.test.ts` baseline assertion that the walker discovers it. The conformance walker already picks up `*.property.test.ts` at any depth and any file under `test/properties/` (per `findPropertySuites`'s three rules in `spec-15.2-conformance.test.ts`), so the eight new files are enrolled at the floor automatically — the walker self-check we add in TASK 9.10 is the structural witness, not a new gate.

The `@causl/sync-testing-internal` package sits at `packages/sync-testing-internal/` and ships only as a workspace dependency of `packages/sync/`. Its public surface is exactly the API sketch in §15.0: six generator factories (`resourceEventGen`, `conflictEventGen`, `conflictIdGen`, `loadingEpisodeGen`, `readScheduleGen`, `openSetSampleGen`), three harness factories (`propertyResource`, `propertyConflict`, `propertyConflictWithMap`), two event appliers (`applyEvents`, `applyConflictEvents`), and two shrinking-aware shape preservers (`preserveLoadingEpisode`, `preserveOpenPriming`). The package is `"private": true` and has the same `peerDependency` shape as `@causl/core-testing-internal` (which we copied as the structural template, since the two packages do the same job for different surfaces — the engine for `@causl/core`, the adapter for `@causl/sync`). The eight property suites import everything they need from `@causl/sync-testing-internal` and from `@causl/core-testing-internal` (for `propertyTrials`); they import nothing else from inside `@causl/sync`'s `src/` tree beyond the public re-exports a regular adopter would touch. That symmetry is deliberate: the property suite is an adopter from the perspective of the adapter's surface, and the harness factories are the seam that lets it stay one.

The trial-budget arithmetic is concrete. Eight properties at 1000 trials each is 8000 trials per CI run at tier 1; with the existing `fetch-interleavings.test.ts` at 1000 trials, the adapter's total property-trial budget is 9000 per CI run. At tier 2 (`MODEL_CHECK_TIER=2`), each property runs 10,000 trials, so the budget grows to 90,000 trials per nightly run. On the workstation profile, a single 1000-trial property completes in 2-6 seconds depending on the generator's complexity (the umbrella properties run faster because their predicates are short; Property 4's read-schedule property runs slower because each trial allocates Promises and awaits microtasks). The aggregate per-CI-run budget is approximately 60 seconds wall-clock at tier 1, well under vitest's per-suite default budget; tier 2 adds about 9 minutes wall-clock to the nightly run, which is consistent with the engine-side §16A.3 nightly tier and does not require infrastructure changes.

The §15.0 shrinking note matters here: two of the eight properties (Property 2, origin-bound resolution; Property 6, conflict forbidden transitions) have generators whose default fast-check shrinker can collapse a structurally meaningful sample into a structurally trivial one before the test author notices. The two helpers `preserveLoadingEpisode` and `preserveOpenPriming` are non-trivial — they wrap an `fc.Arbitrary<T>` in a custom shrinker that contracts the contractible parts (interleaved-sequence length, priming-tail length) but pins the load-bearing arrow (the loading-episode boundary, the open-set anchor `raise` event for the target id). Without those two helpers the property suite under-tests exactly the cases the property is named after; with them the shrinker drives towards the smallest counterexample whose chart shape is still the one under test. The §15.0 prose flags this; the package implements it; the property suite for Property 2 and Property 6 is the runtime witness.

## Brutal-critical review

**Where the spec is right.** Every property has a TypeScript signature in §15.0, an `fc.Arbitrary` generator named in the API sketch, a `propertyTrials(label)` invocation that routes through the seam helper, and a falsifying-input shape the §15.0 prose names in the form of a counterexample. The §15.3 floor is shared with the engine-side floor and is not negotiable — the conformance walker rejects any `propertyOptions({ numRuns: N })` or `propertyTrials({ runs: N })` with `N < 1000`, full stop. The shrinking helpers are not gold-plating; they are the difference between "the property tests the chart" and "the property tests a corner of the chart whose bounds the shrinker happens to leave intact." We are paying the helpers' design cost once, today, on two specific arrows the spec named.

The conformance walker has the right shape for this EPIC's enrolment story. Its three discovery rules — `test/properties/` directory, `*.property.test.ts` filename, any test file containing a literal `fc.assert(` call — mean a contributor cannot drop a new property suite anywhere under `packages/sync/test/` that escapes the floor enforcement. The catch-all (rule 3) closes the gap a contributor would otherwise leave by putting a property test next to a feature test instead of in a `properties/` subdirectory. The walker has been hardened against parser regressions (the `extractFcAssertParams` self-checks for trailing commas, leading comments, and string literals containing commas — six self-checks that would not exist if the walker had not already been broken once). We trust it to enrol these eight suites without further work beyond the assertion in TASK 9.10 that names them in the canonical baseline.

**Where the spec might be wrong.** Eight properties for 5 + 4 = 9 chart arms (5 Resource arms, 4 Conflict arms). Are we missing a property? The §15.0 audit says no — Property 1 (Resource lifecycle exhaustiveness) is the umbrella over all 5 Resource arms; Property 5 (Conflict lifecycle exhaustiveness) is the umbrella over all 4 Conflict arms; Properties 2, 3, 4 sharpen the Resource umbrella on the three arrows §3 names as load-bearing (origin equality, transition closure, identity stability); Properties 6, 7, 8 sharpen the Conflict umbrella on the three arrows §4 names (transition closure, single-writer, open-set correctness). The question is whether there is a 9th property covering an arrow the audit silently omitted — for instance, the `idle → idle` transition under a sequence of `invalidate` events, which is a no-op the §6 chart specifies but no property names. We considered shipping it; we declined. The umbrella property (Property 1) generates random `invalidate` event sequences and asserts the post-state is one of the five arms, so a regression where `idle → invalidate → idle` somehow becomes a sixth arm is caught by Property 1's exhaustiveness check. Adding a 9th property whose oracle is "the post-state is `idle`" duplicates the umbrella's coverage; the marginal trial budget buys us nothing the umbrella does not already buy. If a future race row in §9.1 names a no-op transition as a regression vector, we revisit; today, no.

**The `@causl/sync-testing-internal` package boundary is the second risk.** A workspace package is cheap to add but expensive to remove — once the eight property suites import from it, removing the package means rewriting eight test files. We asked whether the harness factories should live inside `@causl/core-testing-internal` instead, since that package already ships `propertyTrials` and is the spiritual home of cross-adapter test infrastructure. We declined for two reasons. (1) The harness factories construct an adapter-side `Resource<T>` and `ConflictRegistry<T>` — both are types from `@causl/sync`, not `@causl/core`, and putting them in the engine's testing package would create a circular dependency edge `@causl/core-testing-internal → @causl/sync` that the engine's own test infrastructure refuses to depend on. (2) The §15.0 API sketch is explicit about the package name (`@causl/sync-testing-internal`) and the path (`packages/sync-testing-internal/`); the spec is the source of truth for the surface, and the spec named a separate package because the engine-side and adapter-side test infrastructures have different consumers. We obey the spec.

**The "generators are the contract" framing in §15.0 is load-bearing for review.** Every property review on this EPIC asks the question §15.0 names: "what does this generator NOT produce?" A generator that produces only `{ kind: 'fetch' }` events covers Property 1's umbrella but never reaches a `loaded` state, so the umbrella's exhaustiveness check is trivially satisfied. A generator that produces only resolved-with-success outcomes covers Property 2 but never exercises the `errored` arm. The §15.0 prose flags this; the property suite's docstring is the author's answer; the review is the audit. We commit to writing the docstring on every property file, naming the cases the generator produces and the cases the generator does not.

**One thing we explicitly are NOT shipping: a stateful fuzz layer over the engine commit pipeline from inside the adapter test suite.** §15.4 names this as out of scope: the engine's commit pipeline is the engine's responsibility per `SPEC.md` §15, and the adapter's properties exercise the chart shapes the adapter ships, not the pipeline the engine ships. The eight properties drive `graph.commit('label', tx => ...)` and `graph.read(node)` against the public engine surface — no `Graph` internals, no monkey-patching, no reaching into `@causl/core/internal` for state the property could otherwise observe through the read API. If a future EPIC needs cross-cutting fuzz over engine plus adapter, it is a different EPIC and a different §15 row.

**One more thing we explicitly are NOT shipping: real-network fuzz, real-backend integration tests, or microtask-scheduler torture.** §15.4 rejects all three. The loader is the seam; the loader resolves on `Promise.resolve(value)` or `Promise.reject(error)` under controlled microtask ordering; nothing under `packages/sync/test/properties/` opens a TCP connection, intercepts `fetch`, or sets up a fake HTTP server. The shrinker's seed is deterministic via `CAUSL_FUZZ_SEED`; the property suite's reproducibility contract is the seed, and a real backend would break it. This is not a gap; this is a boundary.

**Beck on the trial-floor gate.** Kent Beck's framing on the 1000-trial floor is non-negotiable, and it is non-negotiable in a specific way: the floor is enforced at three independent layers, and a PR that lowers the floor fails all three before it merges. Layer 1 is the `propertyTrials` seam helper (in `@causl/core-testing-internal`), which throws at construction if a caller passes `{ numRuns: N }` with `N < 1000` outside the documented `unsafeTrials` escape. Layer 2 is the `spec-15.2-conformance.test.ts` walker, which scans every property suite in the workspace and rejects raw `{ numRuns: N }` literals plus any `propertyOptions({ numRuns: N })` or `propertyTrials({ runs: N })` with `N < 1000`. Layer 3 is review policy: every property-touching PR is reviewed against §15.3, and a contributor who proposes lowering the floor "just for this one suite" is asked to write the rationale and amend §15.3 first. The three layers are independent — layer 1 catches the runtime construction; layer 2 catches the file-shape regression; layer 3 catches the policy drift. A PR that bypasses all three is a PR that has rewritten the seam helper, edited the walker, and amended the spec; we trust the review at that point because the diff is large enough to read.

**Hejlsberg on the testing-internal API surface.** Anders Hejlsberg's framing on the package's TypeScript surface is the closure-over-named-exports discipline the engine's `@causl/core-testing-internal` already enforces. The §15.0 sketch names 13 exports; the package exports exactly 13; a 14th is a §15.0 amendment, not a quiet addition. The runtime gate is TASK 9.1 test 2 — the `Object.keys` audit. The compile-time gate is the `index.ts` re-export list, which is a closed set. The review gate is the §15.0 prose, which is the spec source-of-truth. Adding a 14th export means: (1) amending §15.0 to name the new export, (2) updating the `index.ts` re-export list, (3) updating the audit test, (4) the property suite that consumes the new export ships in the same PR. No drive-by additions, no "while we're here let me add a helper" — the same closure discipline `tsc`'s `--target` enum enforces, lifted to an internal package's public surface.

## Sub-issues (TASKS)

### TASK 9.1 — `@causl/sync-testing-internal` package scaffold

> **Divergence (as of v0.9.0):** The package shipped, but the source-file split landed as a single `src/index.ts` (consolidated from the planned `generators.ts` / `harness.ts` / `events.ts` / `shrink.ts` / `types.ts` split). All 13 exports per the §15.0 sketch are present (see `packages/sync-testing-internal/src/index.ts`). Post-#578 (PR #610), the harness factories wrap a LIVE `@causl/core` Graph plus a real `@causl/sync` Resource / ConflictRegistry; `applyEventsLive` and `applyConflictEventsLive` were added alongside the original `applyEvents` / `applyConflictEvents` (which retain their pre-#578 model-state signatures for back-compat with the property tests authored at that time). The package test suite ships at `packages/sync-testing-internal/test/{harness.test.ts, apply-events-live.test.ts}` — narrower than the five-test plan below; the API-closure `Object.keys` audit and the `private: true` checks live there in a consolidated shape rather than as five separately-named tests.

**Files:** `packages/sync-testing-internal/package.json` (new), `packages/sync-testing-internal/tsconfig.json` (new), `packages/sync-testing-internal/src/index.ts` (new), `packages/sync-testing-internal/src/generators.ts` (new), `packages/sync-testing-internal/src/harness.ts` (new), `packages/sync-testing-internal/src/events.ts` (new), `packages/sync-testing-internal/src/shrink.ts` (new), `pnpm-workspace.yaml` (extend `packages` glob if needed; today's glob `packages/*` already covers the new directory, so no edit beyond a verification check), `packages/sync/package.json` (add `"@causl/sync-testing-internal": "workspace:*"` to `devDependencies`).

The structural template is `packages/core/testing/package.json` — the engine's existing internal-testing package. We copy its shape: `"private": true`, `"name": "@causl/sync-testing-internal"`, `"type": "module"`, `"main": "./src/index.ts"`, `"types": "./src/index.ts"`, `"peerDependencies": { "@causl/core": "workspace:*", "@causl/sync": "workspace:*" }`, `"devDependencies": { "fast-check": "^3.20.0", "vitest": "^2.0.0" }`. The peer-dep on `@causl/sync` is what closes the `Resource<T>` / `ConflictRegistry<T>` type loop: the harness factories return the public types from `@causl/sync` so the property suites consume them at the same surface a regular adopter would.

The four source files split the API sketch by concern. `generators.ts` owns the six `fc.Arbitrary` factories (`resourceEventGen`, `conflictEventGen`, `conflictIdGen`, `loadingEpisodeGen`, `readScheduleGen`, `openSetSampleGen`). `harness.ts` owns the three test-fixture factories (`propertyResource`, `propertyConflict`, `propertyConflictWithMap`); each one constructs a fresh `createCausl()` graph plus the adapter primitive and returns the handle, the graph, and a controlled `settle` / `raise` / `unraise` shim that drives the loader queue without racing the microtask scheduler (the same `Deferred<T>` pattern the existing `fetch-interleavings.test.ts` already uses, lifted into the package so eight new suites do not re-implement it). `events.ts` owns the two appliers (`applyEvents`, `applyConflictEvents`) — pure interpreters over the event-DU types from `generators.ts`. `shrink.ts` owns the two shape-preservers (`preserveLoadingEpisode`, `preserveOpenPriming`).

The `index.ts` re-export list is a closed set, named once, in §15.0 order:

```ts
// packages/sync-testing-internal/src/index.ts
export {
  resourceEventGen,
  conflictEventGen,
  conflictIdGen,
  loadingEpisodeGen,
  readScheduleGen,
  openSetSampleGen,
} from './generators.js'
export {
  propertyResource,
  propertyConflict,
  propertyConflictWithMap,
} from './harness.js'
export {
  applyEvents,
  applyConflictEvents,
} from './events.js'
export {
  preserveLoadingEpisode,
  preserveOpenPriming,
} from './shrink.js'

export type {
  ResourceEvent,
  ConflictEvent,
  LoadingEpisode,
  ReadSchedule,
  OpenSetSample,
} from './types.js'
```

The type re-exports are five DU types named in §15.0's predicate signatures; they live in `src/types.ts` as a sixth source file (we declined to inline them in `generators.ts` because the property suites consume the types directly to spell their `fc.Arbitrary<ResourceEvent>` etc. annotations, and a separate types file is the cleanest import path). The package therefore has five source files, not four; the §15.0 sketch did not enumerate the types-file because it was focused on the runtime API. We name it here for completeness.

The harness factory shape is concrete:

```ts
// packages/sync-testing-internal/src/harness.ts
import { createCausl, type Graph } from '@causl/core'
import { resource, type ResourceHandle } from '@causl/sync'

export function propertyResource<T>(): {
  graph: Graph
  handle: ResourceHandle<T>
  settle: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => void
} {
  const graph = createCausl()
  // controlled deferred queue lifted from fetch-interleavings.test.ts
  const queue: Array<Deferred<T>> = []
  const handle = resource<T>(graph, 'r', {
    loader: () => {
      const d = defer<T>()
      queue.push(d)
      return d.promise
    },
  })
  const settle = (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => {
    const d = queue.find((q) => !q.settled)
    if (!d) return
    if (outcome.ok) d.resolve(outcome.value)
    else d.reject(outcome.error)
  }
  return { graph, handle, settle }
}
```

`propertyConflict<T>()` and `propertyConflictWithMap<T>(openIds)` follow the same shape against the `ConflictRegistry<T>` surface. The `Deferred<T>` and `defer()` helpers are private to `harness.ts` — the property suites do not import them, only the harness wiring does.

#### TDD test suite (≥5 tests)

Tests live at `packages/sync-testing-internal/test/`. They run under the package's own `vitest.config.ts`. They exist because a workspace package without tests is a workspace package whose API is whatever the first contributor typed.

1. **`package_builds_with_tsc_noemit`.** A subprocess test that spawns `pnpm --filter @causl/sync-testing-internal exec tsc --noEmit` and asserts exit code 0. Catches the failure mode where the package's `index.ts` re-exports a name that no source file actually defines.
2. **`public_api_matches_section_15_0_sketch_exactly`.** Imports `* as api from '@causl/sync-testing-internal'` and asserts the union of `Object.keys(api)` is exactly the 13 names in the §15.0 API sketch (`resourceEventGen`, `conflictEventGen`, `conflictIdGen`, `loadingEpisodeGen`, `readScheduleGen`, `openSetSampleGen`, `propertyResource`, `propertyConflict`, `propertyConflictWithMap`, `applyEvents`, `applyConflictEvents`, `preserveLoadingEpisode`, `preserveOpenPriming`). Adding a 14th export, removing one of the 13, or renaming any of them is a red test before the property suite breaks.
3. **`package_is_workspace_only_and_excluded_from_publish`.** Reads `package.json` and asserts `private === true`. Asserts no `publishConfig.access === 'public'`. Asserts the package name does not appear in any other package's `dependencies` (it appears only in `devDependencies` of `@causl/sync` and the adapter's property test files). The grep is over the workspace's `package.json` files.
4. **`importing_at_causl_sync_does_not_pull_in_testing_internal`.** Spawns a tiny ESM script that does `import * as sync from '@causl/sync'` and asserts `Object.keys(require.cache)` (or its ESM equivalent — `import.meta.resolve` + a Node `--experimental-vm-modules` introspection) does NOT contain a path under `packages/sync-testing-internal/`. The test is the structural witness that the production bundle of `@causl/sync` cannot accidentally pull in the test infrastructure. The same shape is used today for `@causl/core-testing-internal`; we copy the assertion.
5. **`generators_are_seed_deterministic`.** A property test (yes, even the testing-internal package has its own properties): for each of the six generators, assert that `fc.sample(gen(), { numRuns: 100, seed: 42 })` produces the same array of values across two invocations. Catches the failure mode where a generator closes over `Math.random()` or `Date.now()` and silently breaks the `CAUSL_FUZZ_SEED` reproducibility contract.

#### 5 concerns

1. **Workspace-only.** The package is `"private": true`; `pnpm publish --filter @causl/sync-testing-internal` exits with a clean refusal rather than uploading the package. The same `private: true` flag protects the engine's `@causl/core-testing-internal` today; we lift the pattern unchanged.
2. **API closure.** Every export from `@causl/sync-testing-internal` is named in §15.0's API sketch. A 14th export is a §15.0 amendment, not a quiet addition. Test 2 above is the runtime gate; the §15.0 prose is the spec gate.
3. **Bundle isolation.** `@causl/sync`'s production bundle does not include `@causl/sync-testing-internal`. The `peerDependencies` declaration on the testing-internal package (which ties it to `@causl/sync` at workspace-link time) does NOT pull the testing-internal package's source into `@causl/sync`'s production bundle, because `@causl/sync` does not declare a `dependency` on the testing-internal package — only the eight property test files do, via the workspace-level `devDependency` we add to `packages/sync/package.json`. Test 4 is the structural witness.
4. **Generator determinism.** Same `propertyTrials` seed produces same generator output. Test 5 is the runtime gate. The contract is `CAUSL_FUZZ_SEED=$N pnpm test` reproduces the failing trace exactly, every time, on every workstation.
5. **No race condition.** Generators are pure functions of their seed, returned as `fc.Arbitrary<T>` values. No closures over module-level mutable state, no `Date.now()`, no `Math.random()` outside `fc`'s seeded RNG. Test 5 covers it; review enforces it on every PR that touches `generators.ts`.

---

### TASK 9.2 — Property 1: Lifecycle exhaustiveness (Resource)

> **Divergence (as of v0.9.0):** All eight property tests under this EPIC route their `fc.assert` calls through `tieredPropertyTrials(label)` (the tier-aware variant added in PR #1153 / commit `4a4e915`), not the plain `propertyTrials(label)` named throughout this EPIC. `tieredPropertyTrials` preserves the §15.3 ≥1000 floor by construction (the conformance walker's regex was extended in #1153 to recognise the new wrapper at the same enforcement strictness) and additionally resolves `MODEL_CHECK_TIER` envelopes. Read every subsequent `propertyTrials(label)` mention in this EPIC as `tieredPropertyTrials(label)`.

**Files:** `packages/sync/test/properties/lifecycle-exhaustiveness.property.test.ts` (new).

The property is the §15.0 Property 1 predicate, lifted into a vitest `it(...)` block, routed through `propertyTrials('resource.lifecycle-exhaustiveness')`. The generator is `fc.array(resourceEventGen(), { maxLength: 32 })`. The predicate is `lifecycleExhaustiveness` from §15.0 — a fresh `propertyResource<number>()`, `applyEvents(handle, graph, events)`, then `graph.read(handle.node).state` must satisfy `VALID_TAGS.includes(tag)`. The falsifying-input shape per §15.0: a trace whose final state tag is anything other than `idle | loading | loaded | stale | errored`.

The docstring on the test file names what the generator produces and what it does not. Per Haines's deliberate-practice framing, this is the half of the contract the predicate cannot state on its own. The generator produces sequences of length 0..32 over six event classes; it does not produce sequences whose `commit-elsewhere` count exceeds 32 (so very long stale-episode chains are out of scope — the property's umbrella covers any stale arm reachable in 32 events, not "the stale arm is reachable for arbitrary commit pressure"). The maxLength bound is 32 because §15.0's example uses 32 and because the conformance walker's per-property budget is shaped around traces of that length running 1000 trials in well under the 2-second per-test budget vitest uses.

The chart anchor is §6's five-arm DU on `Resource<T>`: `idle | loading | loaded | stale | errored`. The umbrella property is the runtime witness that the chart is closed by construction — for every event sequence reachable under the `applyEvents` interpreter, the post-state tag is one of the five. A counterexample would be a trace whose post-state is a sixth tag, which is the §17 commitment 7 violation made structural: an off-chart write produced a state the type system did not name. The umbrella does not test which arm is reached for which trace — that is what Properties 2, 3, and 4 do. The umbrella's job is exhaustiveness, full stop.

The harness factory `propertyResource<number>()` returns `{ graph, handle, settle }`. `handle` is the public `ResourceHandle<number>` from `@causl/sync` — same surface a regular adopter would touch. `graph` is the public `Graph` from `@causl/core`. `settle` is a controlled microtask shim that drives the loader queue: it accepts an outcome `{ ok: true, value: T } | { ok: false, error: unknown }` and resolves or rejects the in-flight loader's deferred. The shim awaits the loader's microtask before returning, so the post-state read after `settle` is observed quiescent. The same shim pattern is used by `applyEvents` when it interprets `{ kind: 'resolve', value }` and `{ kind: 'reject', error }` events — the property does not have to coordinate microtasks itself.

#### TDD test suite (≥5 tests)

The "test suite" for a property test is one `fc.assert` block plus a small set of self-checks on the generator and the harness. We treat these as parts of the same vitest file.

1. **The property itself.** `it('lifecycle is exhaustive over five arms (≥1000 cases)', () => { fc.assert(fc.property(fc.array(resourceEventGen(), { maxLength: 32 }), lifecycleExhaustiveness), propertyTrials('resource.lifecycle-exhaustiveness')) })`. The §15.3 floor is enforced by the seam helper; the conformance walker is the structural backstop.
2. **Generator coverage self-check.** A small `it(...)` block that runs `fc.sample(resourceEventGen(), { numRuns: 1000 })` and asserts the sample contains at least one of each of the six event classes (`fetch`, `invalidate`, `fail`, `resolve`, `reject`, `commit-elsewhere`). Catches the regression where a generator one-of branch is removed and the property silently under-tests its space. The 1000-sample budget is the same floor the property uses; the test runs in well under a second.
3. **Falsifying-input shape documented.** A `describe.skip` block (so it does not run, but the prose is present) showing the §15.0 example shape: `[{ kind: 'fetch' }, { kind: 'resolve', value: 7 }, { kind: 'commit-elsewhere' }, { kind: 'invalidate' }, { kind: 'fetch' }, { kind: 'fail', error: 'x' }]` would be a 6th-tag counterexample if the chart were broken. The block is documentation in code, not a runtime gate; it is here so the next contributor reads the falsifying shape without re-deriving the chart.
4. **Harness factory smoke test.** `it('propertyResource produces an idle resource', () => { const { handle, graph } = propertyResource<number>(); expect(graph.read(handle.node).state).toBe('idle') })`. Catches the regression where the harness factory accidentally fetches on construction.
5. **Per-property identity check.** `expect(graph.read(handle.node)).toBe(graph.read(handle.node))` (object-identity, not deep-equality) on a quiescent state. Catches the regression where `graph.read` allocates a new state object on every call, which would break the `===` Promise-identity check Property 4 owns.

#### 5 concerns

1. **Floor: 1000 trials** via `propertyTrials('resource.lifecycle-exhaustiveness')`. The seam helper refuses lower; the conformance walker rejects lower; the property runs at 1000 today and at 10,000 under `MODEL_CHECK_TIER=2` per §15.3.
2. **Generator coverage.** Every event class has non-zero probability in the random sample. Self-check test 2 is the runtime gate; the §15.0 generator is the spec gate.
3. **Shrinking.** The default `fc.array` shrinker is acceptable for Property 1 — a counterexample whose final state is a sixth tag remains a counterexample under length contraction (the umbrella check has a defined answer for the empty array: `idle`, which is in VALID_TAGS). No `preserveLoadingEpisode` wrapper is needed here; the helpers earn their cost on Properties 2 and 6, not Property 1.
4. **Falsifying input shape documented** as a `describe.skip` block per test 3 above. Future contributors read the shape, not the prose alone.
5. **No race condition.** `fc.assert` is single-threaded; shrinking is deterministic under the seed. Microtask ordering is controlled inside `applyEvents` (which awaits each `Deferred` settlement before continuing). No real-time clock reads, no real network.

---

### TASK 9.3 — Property 2: Origin-bound resolution (Theorem 1 made executable)

**Files:** `packages/sync/test/properties/origin-bound-resolution.property.test.ts` (new).

The §15.0 Property 2 predicate. The generator is `loadingEpisodeGen()` from `@causl/sync-testing-internal`, wrapped in `preserveLoadingEpisode(...)` so the shrinker contracts the interleaved-commit count without reordering the loading-episode boundary events. The predicate body is the §15.0 implementation: a fresh `propertyResource<number>()`, a `handle.fetch()` that opens the loading episode at origin `t = graph.now`, a loop applying the interleaved `commit-elsewhere` events (each one bumps `graph.now`), `settleEpisode(handle, episode.resolvesWith)` to drive the loader's outcome, then a structural assertion on `graph.read(handle.node)`: success outcomes resolve to `loaded` iff `interleaved.length === 0` and to `stale` iff `interleaved.length > 0`; failure outcomes resolve to `errored` regardless of interleaved count.

The §15.3 floor is `propertyTrials('resource.origin-bound-resolution')`. The falsifying-input shape per §15.0: a loading episode whose post-resolution arm violates the bi-implication — for instance, an episode with `interleaved.length === 0` whose post-resolution arm is `stale` rather than `loaded` (Theorem 1 violation, §9.1 row 6 regression).

The `loadingEpisodeGen()` generator's shape is concrete:

```ts
// packages/sync-testing-internal/src/generators.ts (excerpt)
export const loadingEpisodeGen = (): fc.Arbitrary<LoadingEpisode> =>
  fc.record({
    origin: fc.nat({ max: 100 }) as fc.Arbitrary<GraphTime>,
    interleaved: fc.array(
      fc.constant({ kind: 'commit-elsewhere' as const }),
      { maxLength: 16 },
    ),
    resolvesWith: fc.oneof(
      fc.record({
        ok: fc.constant(true as const),
        value: fc.integer(),
      }),
      fc.record({
        ok: fc.constant(false as const),
        error: fc.anything(),
      }),
    ),
  })
```

The `interleaved` field is an array of `{ kind: 'commit-elsewhere' }` literals — the events that bump `graph.now` between fetch-begin and resolve. The maxLength of 16 is the §15.0 default; the property's coverage probe (test 2) verifies both empty and non-empty cases are produced. The shrinker's default behavior on `fc.array` is to contract length towards 0, which is exactly what we want for this property, but only when wrapped in `preserveLoadingEpisode` — without the wrapper, the shrinker can also flip the `resolvesWith.ok` field from `true` to `false` mid-shrink, which would land the property at a different chart arm than the one the counterexample was about.

The `preserveLoadingEpisode` helper's shape is a custom `fc.Arbitrary<T>` with an explicit `shrink` method:

```ts
// packages/sync-testing-internal/src/shrink.ts (sketch)
export function preserveLoadingEpisode<T extends LoadingEpisode>(
  arb: fc.Arbitrary<T>,
): fc.Arbitrary<T> {
  return fc.Arbitrary.from({
    generate: arb.generate.bind(arb),
    shrink: (sample, context) => {
      // Only contract the interleaved-array length; never flip
      // resolvesWith.ok, never mutate origin.
      const baseShrinks = arb.shrink(sample, context)
      return baseShrinks.filter((shrunk) => {
        return (
          shrunk.value.origin === sample.origin &&
          shrunk.value.resolvesWith.ok === sample.resolvesWith.ok &&
          shrunk.value.interleaved.length <= sample.interleaved.length
        )
      })
    },
    canShrinkWithoutContext: arb.canShrinkWithoutContext.bind(arb),
  })
}
```

The implementation filters the default shrinker's output rather than re-implementing the shrinker from scratch — this keeps the helper small (the filter predicate is three structural assertions), and any future fast-check shrinker improvement is inherited automatically. The trade-off is that the filter is a cull, not a transform: a sample whose default shrinks all flip `ok` would land on no shrinks at all, and the shrinker would report the original sample as the smallest counterexample. We accept this; in practice `fc.record`'s default shrinker produces enough length-contracting shrinks that the cull always leaves a non-empty subset. The `preserveOpenPriming` helper in TASK 9.7 has the same shape against a different filter predicate (the `raise` event for the target id must remain in the priming prefix).

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('loading resolves to loaded iff origin === graph.now (≥1000 cases)', ...)`. The §15.3 floor is enforced by the seam helper. The generator is `preserveLoadingEpisode(loadingEpisodeGen())` — the shrinking-aware wrapper is non-optional here.
2. **Generator coverage self-check.** `fc.sample(loadingEpisodeGen(), { numRuns: 1000 })` produces episodes with at least one `interleaved.length === 0` case (the `loaded` arm), at least one `interleaved.length > 0` case (the `stale` arm), at least one success outcome, at least one failure outcome. Coverage of the four cells of the (length × outcome) cross-product is the gate that the generator probes the bi-implication's full table.
3. **`preserveLoadingEpisode` shrinks the interleaved-tail without reordering boundary events.** A focused unit test on `preserveLoadingEpisode`: feed it a sample with `interleaved.length = 5` and a success outcome; run the wrapper's shrinker; assert every shrunk sample has `interleaved.length <= 5`, a success outcome (not flipped to failure), and the same `origin` field. Catches the regression where the helper accidentally allows the shrinker to flip the outcome polarity.
4. **The `origin` field is preserved across both arms.** A focused assertion inside the property: when `post.state === 'loaded'`, `post.origin === episode.origin`. When `post.state === 'stale'`, `post.origin === episode.origin` AND `post.loadedAt > episode.origin`. The §6 chart names origin as load-bearing for Theorem 3's identity invariant; the property is the runtime witness that origin survives the resolve.
5. **Falsifying-input shape documented.** A `describe.skip` block showing the §9.1 row 6 regression: an episode with `{ origin: 5, interleaved: [], resolvesWith: { ok: true, value: 7 } }` whose post-state is `{ state: 'stale', origin: 5, loadedAt: 6 }` would falsify (the `interleaved.length === 0` case must resolve to `loaded`, not `stale`).

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('resource.origin-bound-resolution')`.
2. The bi-implication is total — no third branch. The success arm partitions exactly into `loaded` (length 0) and `stale` (length > 0). The failure arm goes to `errored`. The predicate has no fall-through `return false` for an "indeterminate" case; if the shrinker lands on a sample whose post-state is neither loaded, stale, nor errored, the predicate returns `false` and the trace is the counterexample.
3. Both `loaded` and `stale` arms preserve the `origin` field. Test 4 above is the focused witness.
4. The `interleaved` array length determines the staleness branch. The generator produces lengths 0..(some bound) and the shrinker contracts towards 0; both endpoints are exercised.
5. No race condition. `settleEpisode` awaits the loader's microtask before returning, so the post-state read is observed quiescent.

---

**Generator-review note (Haines).** The §15.0 generator for Property 2 produces episodes with bounded `interleaved` length (max 16), bounded `origin` value (max 100), and one of two `resolvesWith` polarities. What the generator does NOT produce: episodes with `interleaved.length > 16` (so very long stale-pressure chains are out of scope — the property's umbrella is "any non-zero interleaved count produces stale," not "stale holds for arbitrary commit pressure"). Episodes whose `interleaved` events are anything other than `commit-elsewhere` (so other event-class interleavings are out of scope — the property tests Theorem 1 specifically, not the full transition table, which is Property 1's job). Episodes with `origin` values in the millions (the property's logic is `<=` and `===` on numeric `GraphTime`, which holds for any non-negative integer; bounding `origin` at 100 keeps the shrinker's contraction toward 0 fast). The review committed to the generator's coverage at PR time: "what does this generator NOT produce?" → "long pressure chains, non-commit interleavings, large origin values," and the property's docstring names each one.

---

### TASK 9.4 — Property 3: Forbidden Resource transitions throw

**Files:** `packages/sync/test/properties/forbidden-resource-transitions.property.test.ts` (new).

The §15.0 Property 3 predicate. The generator is `fc.record({ primingEvents: fc.array(resourceEventGen(), { maxLength: 8 }), failError: fc.anything() })`. The predicate body partitions the post-priming state into legal-`fail` source (`loading` or `loaded`) and illegal-`fail` source (`idle`, `stale`, `errored`); the legal partition runs `handle.fail(...)` without throwing and asserts the post-state is `errored`; the illegal partition runs `handle.fail(...)` and asserts a `ForbiddenResourceTransitionError` is thrown with the typed `{ from, to: 'errored', event: 'fail', key: handle.key, id: handle.key }` payload.

The §15.3 floor is `propertyTrials('resource.forbidden-transitions')`. The falsifying-input shape per §15.0: any (state, event) pair §4 names as illegal that produces a non-throwing call, OR any pair that throws an `Error` whose typed payload is missing or malformed.

The chart anchor is §6's transition table, which names the legal and illegal partitions for every method on `ResourceHandle<T>`. Property 3 ships the runtime witness for one method — `fail` — and not for the other three (`fetch`, `invalidate`, `resolve` / `reject` paths through the loader). This is intentional: the §15.0 predicate names `fail` specifically because `fail` is the method whose illegal calls are the most likely §17 commitment 7 violation in adopter code (an off-chart write that races an in-flight loader). The other three methods' transition closures are tested by Property 1's umbrella exhaustiveness check; if the chart has a fifth source-state arm `fail` can illegally enter, Property 1 catches it first. We do not extend Property 3 to cover `invalidate` or `fetch` here; if a future race row in §9.1 names one of those as a regression vector, the §15.0 sketch grows a Property 3', and we ship it then.

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('forbidden Resource transitions throw the typed error (≥1000 cases)', ...)`.
2. **Both partitions exercised.** A self-check that the priming-event distribution lands the source state in each of the five arms (idle, loading, loaded, stale, errored) at least once across the 1000-sample coverage probe. If the generator never reaches `stale`, the property's illegal-partition assertion is vacuous on `stale`.
3. **Typed payload integrity.** When the illegal partition throws, the payload's `from` field equals the source-state tag, the `to` field is `'errored'`, the `event` field is `'fail'`, and the `key` / `id` field equals `handle.key`. The §17 commitment 7 anchor — off-chart writes are structural — needs the payload to be machine-readable; this assertion is the runtime witness that it is.
4. **Legal partition does not throw.** A focused assertion that loading and loaded source states accept `handle.fail(error)` without throwing and the post-state is `errored`. Catches the regression where a tightening on the legal set accidentally rejects a legal transition.
5. **Falsifying-input shape documented.** A `describe.skip` block showing two §4 illegal pairs: `(idle, fail)` and `(errored, fail)`. Either one not throwing (or throwing a generic `Error`) would falsify.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('resource.forbidden-transitions')`.
2. The legal/illegal partition is total — every priming sequence lands the source in one of the five arms, and the partition function is exhaustive over the five.
3. The throw shape is `ForbiddenResourceTransitionError`, not a generic `Error`. The payload's named fields are checked individually; a missing field is a counterexample.
4. The legal partition runs without throwing. The illegal partition throws. Both are checked in the same predicate; the `boolean` return is the conjunction of both branches' assertions.
5. No race condition. The throw is synchronous; no microtask scheduling intervenes.

---

### TASK 9.5 — Property 4: Promise identity stability (Theorem 3 made executable)

**Files:** `packages/sync/test/properties/promise-identity-stability.property.test.ts` (new).

The §15.0 Property 4 predicate. The generator is `readScheduleGen()` from `@causl/sync-testing-internal`, which produces samples of shape `{ readsBeforeResolve: number, secondEpisodeReadsBeforeResolve: number }` with bounded counts. The predicate body opens a loading episode, reads the resource state `readsBeforeResolve` times and stashes the `promise` reference from each read; settles the episode; opens a second loading episode; reads the state `secondEpisodeReadsBeforeResolve` times and stashes those promise references; then asserts pointer equality within episode A, pointer equality within episode B, and pointer inequality between A and B (provided both episodes had at least one read).

The §15.3 floor is `propertyTrials('resource.promise-identity-stability')`. The falsifying-input shape: a read schedule under which two reads inside the same loading episode produce `!==` promise references (Theorem 3 violation, §9.1 row 17 regression — Suspense fresh-Promise-per-render).

Theorem 3's chart anchor is the loading-episode boundary: a single Promise instance is associated with a single loading episode, and every read of the resource during that episode returns the same Promise reference. The Suspense regression (§9.1 row 17) is the failure mode where each render allocates a fresh Promise — the React reconciler then sees a new "thrown promise" on every render, never resolves the suspense boundary, and the user sees a permanent loading spinner. The property's pointer-equality check (`===`, not `equals`) is the only check that catches this regression, because two freshly-allocated Promises with identical structure would pass any structural-equality check while still being a runtime catastrophe. Metz's framing on the test-as-rule applies here: the rule is "one Promise per episode," not "structurally-similar Promises per episode," and the test must prove the rule.

The cross-episode inequality half of the contract (`promisesEpisodeA[0] !== promisesEpisodeB[0]`) is the dual: a new fetch begins a new episode, and the new episode must allocate a new Promise. Without this half, an implementation that caches the original Promise across episode boundaries would pass the within-episode check trivially and ship a different bug — the second fetch would never observe a fresh load. Both halves of the contract are stated in the §15.0 predicate, both halves are tested, and the predicate's `boolean` return is the conjunction of three sub-checks: within-A equality, within-B equality, A-vs-B inequality (modulo the vacuous-empty-episode guard).

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('promise identity is stable within an episode and changes across episodes (≥1000 cases)', ...)`.
2. **Generator coverage.** `readScheduleGen()` produces schedules covering both `readsBeforeResolve = 0` (vacuous within-A check) and `readsBeforeResolve > 0`; same for episode B. The vacuous-on-empty case is handled by the predicate's guard `promisesEpisodeA.length === 0 || promisesEpisodeB.length === 0 || promisesEpisodeA[0] !== promisesEpisodeB[0]`.
3. **Within-episode equality is `===`, not `equals`.** Pointer equality is the contract; `Promise` objects are compared by reference. A `deepEqual` check would silently pass on a regression where a new Promise is allocated per read but happens to share structure.
4. **Cross-episode inequality.** A focused assertion that the first read of episode A and the first read of episode B produce `!==` promise references when both reads exist. Catches the regression where the resource caches the original Promise across episode boundaries.
5. **Falsifying-input shape documented.** A `describe.skip` block showing a schedule `{ readsBeforeResolve: 3, secondEpisodeReadsBeforeResolve: 0 }` where the three reads in episode A return three distinct Promise references — this would be the §9.1 row 17 regression made concrete.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('resource.promise-identity-stability')`.
2. Pointer equality (`===`) across reads in the same loading episode; pointer inequality across episode boundary. Both halves of the contract are stated, both are tested.
3. The predicate's early-return on a non-loading state (`if (s.state !== 'loading') return false`) is a structural witness that the harness drove the resource into the right arm; a counterexample where the resource is not loading mid-episode is itself a chart bug.
4. The vacuous-case guard (zero reads in either episode) is total — the predicate has a defined answer for every shrinker-reachable schedule.
5. No race condition. Reads inside a loading episode happen synchronously between `handle.fetch()` and `settleEpisode(...)`; the microtask scheduler is not engaged until `settleEpisode` awaits.

---

**Generator-review note (Haines).** The `readScheduleGen()` generator produces schedules with bounded `readsBeforeResolve` and `secondEpisodeReadsBeforeResolve` (each in the range 0..16). What the generator does NOT produce: schedules with reads after the loader settles but before the next fetch (the loaded/stale arms have different identity semantics — there is no Promise to be identity-stable for, so reads in those arms are out of scope for Property 4); schedules with concurrent reads from two observers (the property tests sequential reads from one observer, because microtask ordering is controlled and concurrent reads collapse to sequential ones in vitest's single-threaded runner); schedules with bounded counts in the thousands (the trial budget would explode). The review committed: the read-schedule alphabet is bounded at 16 reads per episode; the property tests within-episode and cross-episode identity, not pre-/post-loader identity; the cross-observer case is out of scope and lives in `packages/react/test/properties/` if it lands.

---

### TASK 9.6 — Property 5: Conflict lifecycle exhaustiveness

**Files:** `packages/sync/test/properties/conflict-lifecycle-exhaustiveness.property.test.ts` (new).

The §15.0 Property 5 predicate — the conflict-side mirror of Property 1. The generator is `fc.array(conflictEventGen(), { maxLength: 32 })`. The predicate body applies the random conflict-event sequence to a fresh `propertyConflict<number>()`, then asserts every overlay row's `kind` is in `['open', 'resolved', 'ignored', 'superseded']`. The §15.3 floor is `propertyTrials('conflict.lifecycle-exhaustiveness')`. The falsifying-input shape: a sequence whose final overlay contains a fifth-arm row.

The chart anchor is §4's four-arm DU on `Conflict<T>`. The umbrella's correctness depends on `applyConflictEvents` being a faithful interpreter over the random event sequence — if the applier silently drops events whose preconditions are unmet (e.g. a `resolve` against an id that was never raised), the umbrella's exhaustiveness check passes vacuously on those events. The §15.0 implementation guards against this: `applyConflictEvents` is the same total interpreter the harness factories expose, and the property suite drives it directly. The five conflict event classes (`raise`, `unraise`, `resolve`, `ignore`, `supersede`) are fed in random order over random ids, and the resulting overlay is the post-state every property in §15.2 reads against. Generator coverage matters here in a specific way: the random sequences must include `raise` events densely enough that subsequent `resolve` / `ignore` / `supersede` events have legitimate targets, otherwise the property over-tests the empty-overlay case.

The harness factory `propertyConflict<number>()` returns `{ graph, registry, raise, unraise }`. The property uses `applyConflictEvents(registry, graph, events)` for the bulk drive and reads the final overlay via `registry.read(graph)`. The overlay's shape is a `readonly Conflict<number>[]` — one row per currently-tracked conflict id, with the `kind` discriminant and the per-arm payload. The exhaustiveness check is `list.every((c) => VALID_KINDS.includes(c.kind))`, which is total over the empty overlay (`every` on `[]` is `true`) and over every non-empty overlay reachable under the chart.

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('conflict lifecycle is exhaustive over four arms (≥1000 cases)', ...)`.
2. **Generator coverage.** `conflictEventGen()` produces all five conflict event classes (raise, unraise, resolve, ignore, supersede) with non-zero probability across the 1000-sample probe.
3. **Multi-id coverage.** The generator produces sequences referencing more than one conflict id, so the overlay's per-id partition is exercised — a regression where the four-arm closure holds for id `c1` but breaks for id `c2` is caught.
4. **Empty-sequence base case.** `applyConflictEvents` with `events: []` produces an overlay of length 0 — the predicate's `every` reduces to `true`, which is the correct answer for the empty case.
5. **Falsifying-input shape documented.** A `describe.skip` block showing a sequence whose final overlay contains a row with `kind: 'pending'` (a fifth arm) — that would be a §4 four-arm DU commitment violation.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('conflict.lifecycle-exhaustiveness')`.
2. Generator coverage of all five event classes; coverage of multi-id sequences.
3. The four-arm DU is closed by construction in `@causl/sync`'s source; the property is the runtime witness against fuzzer-discovered escape.
4. The empty-sequence base case is handled correctly by the predicate's `every` reduction.
5. No race condition.

---

### TASK 9.7 — Property 6: Forbidden Conflict transitions throw

**Files:** `packages/sync/test/properties/forbidden-conflict-transitions.property.test.ts` (new).

The §15.0 Property 6 predicate — the conflict-side mirror of Property 3. The generator is wrapped in `preserveOpenPriming(...)` so the shrinker keeps a single `raise` event for the target conflict id pinned in the priming sequence's prefix; without the wrapper, the shrinker would collapse the priming towards an empty sequence and land the source state at `unknown` — a legitimate non-Open state the property has a defined answer for, but not the state the property is named after. The predicate partitions the post-priming source state into legal (`open`) and illegal (`resolved`, `ignored`, `superseded`, `unknown`); legal calls succeed; illegal calls throw `ForbiddenConflictTransitionError` with the typed payload.

The §15.3 floor is `propertyTrials('conflict.forbidden-transitions')`. The falsifying-input shape: any illegal pair that does not throw, or throws a generic `Error`.

The §15.0 prose names this as the property where the shrinker's structural decomposition is most likely to silently break the property. The default shrinker contracts the priming-event array towards `[]`, which lands the source state at `unknown` — that is a legitimate non-Open state, the property has a defined answer for it, and the predicate returns `true` on that case (because `unknown` is in the illegal partition and the throw fires). The shrinker, having found a `true`-returning sample at length 0, keeps contracting and the counterexample reported is "an empty priming sequence" — which tells the contributor nothing about what actually broke. `preserveOpenPriming` fixes this: it pins one `raise` event for the target id at the head of the priming, contracts everything after, and ensures the shrinker's smallest counterexample is one whose source state is the named one. Haines's deliberate-practice framing applies sharply here — without the wrapper, the property's review question "what does this generator NOT produce after shrinking?" answers "the case the property is named after," which is the failure mode §15.0 names by name.

The four illegal source states are `resolved`, `ignored`, `superseded`, and `unknown`. The first three are reachable by priming with a `raise` followed by the corresponding terminal-arm event; the fourth is reachable by priming with no `raise` for the target id. The generator's coverage probe (test 3 below) confirms all four are produced. The throw payload's `from` field is the source-state tag for the first three; for `unknown` it is the literal string `'unknown'`, which is the §6 chart's name for "no row exists in the overlay for this conflict id."

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('forbidden Conflict transitions throw the typed error (≥1000 cases)', ...)`.
2. **`preserveOpenPriming` keeps the raise pinned.** A focused unit test: feed the helper a sample with three priming events including a `raise` for target id `c1`, run the shrinker, assert every shrunk sample still has a `raise` for `c1` in its priming. Catches the regression where the helper allows the shrinker to drop the anchor.
3. **All four illegal source states exercised.** The 1000-sample coverage probe lands the source state at each of the three terminals (`resolved`, `ignored`, `superseded`) and at `unknown` at least once. If the generator never produces an illegal source state, the property's illegal-partition assertion is vacuous.
4. **Typed payload integrity.** When the illegal partition throws, the payload's `from` is the source-state tag, `to` is the attempted-event's target arm, and `conflictId` is the conflict's id. The §17 commitment 7 anchor on the conflict side.
5. **Falsifying-input shape documented.** A `describe.skip` block showing a (resolved, resolve) attempt that does not throw — the single-writer commitment violation made concrete.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('conflict.forbidden-transitions')`.
2. `preserveOpenPriming` is the load-bearing helper; without it, the shrinker collapses the priming and the property under-tests the named arrow.
3. All four illegal source states are reachable under the generator; coverage probe is the runtime witness.
4. Typed payload integrity is enforced field by field.
5. No race condition.

---

**Generator-review note (Haines).** The `conflictEventGen()` generator produces all five conflict event classes with non-zero probability and references conflict ids drawn from a small pool (size 4 per the §15.0 default; ids `c1` through `c4`). What the generator does NOT produce: ids drawn from an unbounded alphabet (the trial budget would not exercise multi-id partitions usefully); events whose `value` payload is non-numeric (Property 5's exhaustiveness check is over the `kind` discriminant, not the payload type, so polymorphism is out of scope); event sequences longer than 32 (the same maxLength bound Property 1 uses, for the same reason — trial-budget shape). The review committed: the 4-id pool probes multi-id sequences in 1000 trials; the `value: number` constraint is the §15.0 default and matches the property suite's `propertyConflict<number>()` instantiation.

---

### TASK 9.8 — Property 7: Single-writer resolution

**Files:** `packages/sync/test/properties/single-writer-resolution.property.test.ts` (new).

The §15.0 Property 7 predicate. The generator is `fc.record({ raiseValue: fc.integer(), firstResolution: fc.anything(), secondResolution: fc.anything() })`. The predicate body raises a conflict with `raiseValue`, calls `registry.resolve(graph, 'c1', firstResolution)` (which succeeds), then calls `registry.resolve(graph, 'c1', secondResolution)` (which must throw `ForbiddenConflictTransitionError`), then asserts the post-state overlay row for `c1` has `kind: 'resolved'` AND `resolution === firstResolution` (NOT `secondResolution`). The §15.3 floor is `propertyTrials('conflict.single-writer-resolution')`. The falsifying-input shape: any `(firstResolution, secondResolution)` pair where the second `resolve` call succeeds, OR where the first resolution is overwritten by the second.

The §15.0 prose names the chart anchor explicitly: this is the `SPEC.md` §13.7 multi-user-synchronisation row leaking into the single-user adapter. The single-user adapter's contract is one resolution per conflict id; a multi-user adapter would track a list. The property is the runtime witness that the single-user contract holds — a second-resolve call must throw, not append. Haines's deliberate-practice framing on the generator: `fc.anything()` is not a thin generator. It produces `null`, `undefined`, deeply-nested objects, circular references, `BigInt`, `Symbol`, `Map`, `Set`, primitives of every type. The predicate's `===` reference-equality check is total over all of them; the property tests the full value space, not a subset.

The harness drive is straightforward — `propertyConflict<number>()` gives `{ registry, graph, raise }`; `applyConflictEvents` seeds the raise; the two `registry.resolve(graph, 'c1', ...)` calls are direct method invocations against the registry's typed surface. The throw is synchronous; no microtask scheduling is needed. The post-state read is one `registry.read(graph).find(c => c.id === 'c1')`. The two-write attempt is the smallest possible counterexample shape — any two adjacent writes to the same conflict id is enough to falsify the single-writer contract — so the generator does not need to grow a multi-id or multi-event-class shape.

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('second resolve on a resolved conflict throws and preserves the first resolution (≥1000 cases)', ...)`.
2. **The first resolution's value is preserved.** A focused assertion that `overlay.find(c => c.id === 'c1').resolution === firstResolution` after the failed second-resolve attempt. Catches the regression where the throw fires but the registry partially mutates before the throw.
3. **The second resolve does not mutate the first's commit log entry.** A read of the commit log (via the engine's public introspection, if available; otherwise via a re-read of the registry overlay across a no-op commit) confirms that the failed second-resolve attempt produced no commit-log row.
4. **Generator coverage of pathological values.** `fc.anything()` produces `null`, `undefined`, deeply-nested objects, circular references — the predicate's `===` identity check is total over all of them (it compares by reference, so circular refs are not a problem).
5. **Falsifying-input shape documented.** A `describe.skip` block showing a `(firstResolution: 'A', secondResolution: 'B')` pair where the second resolve overwrites — that would be a §13.7 multi-user-synchronisation row leaking into the single-user adapter, per the §15.0 prose.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('conflict.single-writer-resolution')`.
2. The throw shape is `ForbiddenConflictTransitionError`, not a generic Error. The `instanceof` check is the gate.
3. The first resolution's `resolution` field is preserved; pointer-identity check via `===`.
4. The second resolve does not mutate the first's commit log entry; the no-op-commit read is the witness.
5. No race condition. Synchronous registry calls; no microtask scheduling.

---

**Generator-review note (Haines).** The single-writer generator produces `(raiseValue, firstResolution, secondResolution)` triples where `raiseValue` is an integer and the two resolutions are `fc.anything()` — the unconstrained value space. What the generator does NOT produce: triples with more than two resolution attempts (the property tests one transgression, not many — a third resolve attempt against an already-resolved conflict is structurally identical to the second, so the marginal trial budget buys no coverage); triples where the conflict id varies (the property tests `c1`-against-`c1`, because cross-id resolutions are not single-writer transgressions and live in Property 6's territory); triples with Symbol-keyed resolutions (`fc.anything()` produces Symbols, but the engine's commit pipeline does not constrain resolution-value types — the `===` reference check works for all of them). The review committed: the two-write shape is the smallest counterexample shape; `fc.anything()` is the right value-space generator; cross-id transgressions are Property 6.

---

### TASK 9.9 — Property 8: Open-set computation correctness

**Files:** `packages/sync/test/properties/open-set-computation.property.test.ts` (new).

The §15.0 Property 8 predicate. The generator is `openSetSampleGen()` from `@causl/sync-testing-internal`, which produces samples of shape `{ openIds: NodeId[], inputMap: ReadonlyMap<NodeId, T>, resolutions: { id: NodeId, record: ResolutionRecord }[] }`. The predicate body seeds the input map, applies the resolution records (some of which may target ids that are not currently open — those throws are caught and ignored, per the §15.0 implementation), reads the overlay, and asserts the overlay's id set equals the `openIds` set AND every overlay row's `kind` matches the resolution record (or `'open'` if no record). The §15.3 floor is `propertyTrials('conflict.open-set-computation')`. The falsifying-input shape: an overlay whose id set differs from the `openIds` set, OR an overlay row whose `kind` is wrong for its resolution record.

The chart anchor is §4's derived-view commitment on `Conflict<T>`: the public overlay is a function of the Input map plus the resolution records — same inputs produce same overlay, full stop. Property 8 is the runtime witness that the function is correctly implemented. A counterexample is an overlay glitch — a case where the same inputs produce different overlays across two reads, or where the overlay contains an id the inputs do not name, or omits an id the inputs do name. The §15.0 prose lists this as "the §4 derived-view commitment failing on the conflict primitive" — the most likely failure mode in a multi-id workload, where the registry's overlay computation drifts away from the predicate's spec under a sequence of mixed-target resolutions.

The `propertyConflictWithMap<T>(openIds)` harness factory is the seam that makes Property 8 tractable. It returns `{ graph, registry, sourceInput }` where `sourceInput` is the Input map node feeding the registry. The property seeds `sourceInput` with the random `inputMap`, then drives the resolution records via `applyResolutionRecord(registry, graph, id, record)` — which throws if the targeted id is not currently open, and the property catches the throw and proceeds (per the §15.0 implementation comment "// not currently open — ignore"). The catch-and-ignore branch is structurally important: a resolution targeting a non-open id is not a counterexample, it is an out-of-band call the registry correctly rejects. The property tests the overlay's correctness for the legal subset, and the catch is the boundary between the property's domain and the registry's error surface (which Property 6 owns).

#### TDD test suite (≥5 tests)

1. **The property itself.** `it('the open-set overlay equals the predicate-named ids (≥1000 cases)', ...)`.
2. **Set-equality is set-equality, not list-equality.** The predicate uses `Set` membership for the comparison; an overlay that contains the right ids in a different order is not a counterexample.
3. **The catch-and-ignore on `applyResolutionRecord` is structural.** A self-check that feeds the generator a sample with a resolution record targeting a non-open id, asserts the predicate returns `true` (the throw is caught, the overlay is unchanged for that id). Catches the regression where the catch is removed and the property starts spuriously failing on legitimately-illegal resolutions.
4. **Per-id `kind` correctness.** A focused assertion that `overlay.find(c => c.id === id).kind === expectedKind` for each id; the expected kind is `record?.kind ?? 'open'` per the §15.0 implementation.
5. **Falsifying-input shape documented.** A `describe.skip` block showing an overlay whose id set is a strict subset of `openIds` — that would be a §4 derived-view commitment failure.

#### 5 concerns

1. Floor 1000 trials via `propertyTrials('conflict.open-set-computation')`.
2. Set-equality (size + every-member-present) over the id sets; the `Set`-based comparison is order-insensitive.
3. The catch-and-ignore branch on `applyResolutionRecord` is correct by construction — illegal resolutions are not counterexamples.
4. Per-id `kind` correctness; the expected kind is derived from the resolution record, with `'open'` as the default.
5. No race condition. The seed commit, the resolution applications, and the overlay read are all synchronous against the engine's public surface.

---

**Generator-review note (Haines).** The `openSetSampleGen()` generator produces samples with bounded `openIds.length` (max 8 per the §15.0 default), bounded `inputMap` size (matching the open-id count plus a few extras to test the "id in map but not in open set" case), and bounded `resolutions` length (max 8). What the generator does NOT produce: samples where the id-space is unbounded (the property's set-equality check is over a finite alphabet); samples where the resolution records target ids outside `openIds` exclusively (the catch-and-ignore branch would be exercised but the legal subset would be empty, making the overlay-correctness check vacuous); samples with cyclic input-map structures (the engine's commit pipeline rejects cycles, so the property's seed commit would throw before the overlay read). The review committed to the generator's coverage: the 8-id alphabet probes the multi-id partition without making the trial budget explosive; the resolution records mix legal and illegal targets so both the overlay-write path and the catch-and-ignore path are exercised in the same trial.

---

### TASK 9.10 — Conformance walker enrolment

> **Divergence (as of v0.9.0): NOT NEEDED, NOT SHIPPED.** The conformance walker's auto-discovery rules (anything under `test/properties/`, `*.property.test.{ts,tsx}`, or any file containing `fc.assert(`) already cover the eight EPIC-9 files; the planned `expect.arrayContaining` baseline extension was not necessary. The current baseline in `packages/core/test/spec-15.2-conformance.test.ts` does NOT enumerate the eight EPIC-9 names — it lists only the canonical race-detection family set (`atomicity.test.ts`, `determinism.test.ts`, `dynamic-deps.test.ts`, `glitch-freedom.test.ts`, `family.property.test.tsx`, `cross-tree.property.test.tsx`, `persistedInput.test.ts`, `ssr-property.test.tsx`, `useSyncExternalStore.test.tsx`, `family-grid.test.tsx`, `readAt.test.ts`, `conflict-statechart.test.ts`). The eight EPIC-9 files are discovered via rules 1 and 2; a "name regression" gate (the failure mode TASK 9.10 was meant to catch) would require explicit enumeration — that gate does not exist today. If a future contributor wants name-level enforcement, the planned baseline extension is the right escalation.

**Files:** `packages/core/test/spec-15.2-conformance.test.ts` (extension only — no new file).

The conformance walker's `findPropertySuites` already discovers the eight new files automatically (rule 1 fires on `test/properties/`, rule 2 fires on `*.property.test.ts`, rule 3 fires on the `fc.assert(` token regardless). The walker does not need its discovery logic changed. What we extend is the canonical-baseline assertion — the existing `it('discovers the canonical property-test suites', ...)` test names twelve property files in its `expect.arrayContaining([...])` baseline; we extend the baseline by eight names so the walker fails loudly if the discovery rule regresses and one of the new files goes undetected.

The extension is one block diff:

```ts
expect(baseNames).toEqual(
  expect.arrayContaining([
    // ...existing entries (atomicity.test.ts, determinism.test.ts,
    // dynamic-deps.test.ts, glitch-freedom.test.ts, family.property.test.tsx,
    // cross-tree.property.test.tsx, persistedInput.test.ts, ssr-property.test.tsx,
    // useSyncExternalStore.test.tsx, family-grid.test.tsx, readAt.test.ts,
    // conflict-statechart.test.ts) ...

    // SPEC.async §15 property suite (EPIC-9)
    'fetch-interleavings.test.ts', // already present; named here for completeness
    'lifecycle-exhaustiveness.property.test.ts',
    'origin-bound-resolution.property.test.ts',
    'forbidden-resource-transitions.property.test.ts',
    'promise-identity-stability.property.test.ts',
    'conflict-lifecycle-exhaustiveness.property.test.ts',
    'forbidden-conflict-transitions.property.test.ts',
    'single-writer-resolution.property.test.ts',
    'open-set-computation.property.test.ts',
  ]),
)
```

The walker's existing assertion shape uses `expect.arrayContaining`, which means we add to the baseline rather than replace it — adding a name does not require removing one. The eight new names are listed in the canonical §15.0 order (Property 1 through Property 8), with the existing `fetch-interleavings.test.ts` named alongside for completeness even though it was already in the baseline. The walker's discovery rules are unchanged; the regex gates are unchanged; the cross-package walk is unchanged.

The walker's three other tests (`rejects raw fc.assert(prop, { numRuns: N }) literal arguments`, `rejects propertyOptions({ numRuns: N }) where N < 1000`, `rejects propertyTrials({ runs: N }) where N < 1000`) need no change — they are file-shape gates that fire on every discovered file, and the eight new files satisfy them by construction (each one routes through `propertyTrials(label)` per the §15.3 floor).

#### TDD test suite (≥5 tests)

1. **Walker discovers all 8 new property files.** The extended baseline is the runtime gate; a new file is discovered iff it appears in the baseline. The test fails if any of the 8 names is missing.
2. **Floor enforced** — a PR lowering `numRuns` is rejected. The existing walker tests already enforce this; we add a self-check fixture under `packages/core/test/fixtures/conformance-floor-violation.test.ts.fixture` (a `.fixture` extension so it is not a runnable test) showing what a violating file looks like, and a unit test that runs the walker's regex against the fixture and asserts a violation is reported. This is documentation-as-test: the next contributor reads the fixture to learn what the gate rejects.
3. **No-skip guarantee** — the walker fails if a property file is added but not enrolled. The walker's `findPropertySuites` walk is structurally exhaustive (it scans every `*.test.ts` and `*.test.tsx` under `packages/*/test/`), so no-skip is held by construction. The new test above (test 1) is the structural witness on the new files; the walker's three discovery rules are the structural gate on every other file.
4. **Cross-package coverage.** The walker spans `packages/core`, `packages/sync`, `packages/migration-check`, and every other package whose `test/` directory exists. We extend the baseline self-check to assert the discovery span covers all four — a regression where the walker silently scopes itself to one package would be caught.
5. **No race condition.** The walker is a single-pass file scan over a stable directory tree; no parallelism, no caching, no state shared between test invocations. The walker is re-run on every test invocation; results are reproducible across CI runs.

#### 5 concerns

1. **Walker discovers all 8 property files.** Test 1 above.
2. **Floor enforced** — `propertyOptions({ numRuns: 999 })` is rejected by the existing regex; `propertyTrials({ runs: 999 })` is rejected by the sibling regex. We do not touch the regexes; we extend the baseline only.
3. **No-skip guarantee.** Held by `findPropertySuites`'s structural walk. A contributor cannot add a property file that escapes discovery short of putting it outside `packages/*/test/` entirely.
4. **Cross-package coverage.** The walker iterates `readdirSync(packagesDir)` and walks each package's `test/` subtree. The new files live under `packages/sync/test/properties/`; the walker reaches them on rule 1 (the `test/properties/` directory rule). The walker also reaches the testing-internal package's tests under `packages/sync-testing-internal/test/` — those tests do not call `fc.assert` (they test the package's API closure, not its properties), so they do not trigger rule 3, and they are not under `test/properties/`, so they do not trigger rule 1; if any of them grows an `fc.assert` call (per TASK 9.1 test 5, which uses `fc.sample` rather than `fc.assert`, so the trigger is avoided), rule 3 fires and the floor is enforced.
5. **No race condition.** Walker is a single-pass file scan; deterministic across CI runs; no shared mutable state.

---

## Acceptance gate

> **Divergence (as of v0.9.0): NOT SHIPPED.** The planned `all-properties-acceptance.test.ts` meta-test did not land. Acceptance is held instead by (a) the eight per-property vitest files running on every CI pass, (b) the §15.2 conformance walker's auto-discovery + ≥1000-trial floor regexes (extended in #1153 to cover `tieredPropertyTrials`), and (c) the `@causl/sync-testing-internal` package's own test suite at `packages/sync-testing-internal/test/`. The five-assertion acceptance list below remains the design for a future meta-test if the deletion-detection / harness-deduplication gate becomes load-bearing.

`packages/sync/test/properties/all-properties-acceptance.test.ts` (new) — a meta-test that imports each of the eight property files for their side effect (the `it(...)` registration via `propertyTrials`), reads the workspace's vitest run summary after the suite completes, and asserts:

1. All eight properties registered through the seam helper at the §15.3 floor.
2. The existing `fetch-interleavings.test.ts` is unchanged (its `propertyTrials('fetch-interleavings')` call is still discovered).
3. The `@causl/sync-testing-internal` package was loaded once per property suite — the harness factories are not duplicated across the eight files.
4. The conformance walker's baseline assertion passes — the eight new files appear in the discovery set.
5. The aggregate trial count across the eight properties is `8 × 1000 = 8000` per CI run at tier 1, `8 × 10_000 = 80_000` at tier 2 (`MODEL_CHECK_TIER=2`).

The acceptance gate runs against the real test suite, not against a mocked harness. A regression where a property file is added but not registered through the seam helper, or where the eight files duplicate the harness wiring, is caught here before merge.

## Pre-flight checklist

Before the EPIC merges, the following structural commitments are verified:

1. **Eight property files exist** under `packages/sync/test/properties/` with the names this EPIC enumerates. The conformance walker's baseline (TASK 9.10) is the runtime witness; a `git ls-files packages/sync/test/properties/` listing is the manual cross-check.
2. **The `@causl/sync-testing-internal` package builds clean.** `pnpm --filter @causl/sync-testing-internal exec tsc --noEmit` exits 0; `pnpm --filter @causl/sync test` discovers and runs all eight property files.
3. **The §15.3 floor holds across the eight new files.** Each file routes its `fc.assert` through `propertyTrials(label)`; no raw `{ numRuns: N }` literals appear; the conformance walker's three regex gates pass.
4. **The 13-export API closure on the testing-internal package is intact.** TASK 9.1 test 2 passes; the `index.ts` re-export list matches the §15.0 sketch line for line.
5. **The two shrinking helpers behave correctly.** TASK 9.3 test 3 (`preserveLoadingEpisode`) and TASK 9.7 test 2 (`preserveOpenPriming`) both pass; the focused unit tests on the helpers' shrink behavior are green.
6. **The eight property suites are seed-deterministic.** `CAUSL_FUZZ_SEED=42 pnpm --filter @causl/sync test` produces the same trial sequence on two consecutive runs; a counterexample on one workstation reproduces on every workstation.
7. **The §17 commitment 8 mechanical gate is held.** The `spec-15.2-conformance.test.ts` walker discovers all eight new files (plus the existing `fetch-interleavings.test.ts`); the walker's `expect.arrayContaining` baseline names them; a future contributor cannot drop a property file under `packages/sync/test/` that escapes discovery.
8. **The package is bundle-isolated.** TASK 9.1 test 4 passes; importing from `@causl/sync` does not transitively pull in `@causl/sync-testing-internal`; the production bundle of `@causl/sync` is unchanged in size and shape.
9. **The §15.4 boundaries are respected.** No property file opens a TCP connection, intercepts `fetch`, runs against a real backend, or exercises the engine's commit pipeline beyond the public `graph.commit` / `graph.read` surface. The grep is over the eight files plus the testing-internal package's source.
10. **The acceptance gate is green.** `packages/sync/test/properties/all-properties-acceptance.test.ts` passes; the five assertions in the acceptance section above are all satisfied.

## Out of scope

- §10.5 worked-example fixtures. EPIC-8 ships those. The spec-async-§10 worked example is its own gate per §17 commitment 6; this EPIC does not touch it.
- §3.1 theorem gates. EPIC-10 ships the theorem-level structural gates. This EPIC ships the property-level runtime witnesses; the two are complementary, not overlapping.
- Bundle-budget sub-imports. The `@causl/sync-testing-internal` package is `private: true` and excluded from the production bundle by construction (TASK 9.1 concern 3); we do not extend the bundle-budget tooling to cover sub-imports of an unpublished package.
- Network-level fuzz, real-backend integration tests, and microtask-scheduler torture. §15.4 rejects all three; we obey.
- A 9th property covering the `idle → idle` no-op transition. Discussed in the brutal-critical review and refused; Property 1's umbrella covers the no-op transition by exhaustiveness.
- Cross-cutting fuzz over engine plus adapter from a single property suite. §15.4 rejects this; the engine's pipeline is the engine's responsibility.
- A `causl-sync-testing.toml` config file. We refused to add a config file for one workspace package; the package's `package.json` is the config surface.
- Forward-compat to a hypothetical §15.5 (additional properties). When a future EPIC names them, we ship them under the same shape; today, the eight are the eight.
- A property suite that targets the `react`-binding adapter (`packages/react/`). The React adapter has its own statechart concerns (Suspense boundaries, `useSyncExternalStore` reads, hydration races) and its own race-row catalogue; those properties live under `packages/react/test/` and are governed by the same conformance walker but are not in this EPIC's scope. The `@causl/sync-testing-internal` package's harness factories produce `Resource<T>` and `ConflictRegistry<T>` values, not React components; if the React adapter grows its own property suite, it imports its own testing-internal package or extends the sync-testing-internal one in a separate PR.
- Continuous fuzz against an external corpus. The property suite is hermetic — every trial runs against in-memory state, with no I/O, no clock reads, no network. A future tier-3 fuzz row might consume an external corpus of recorded traces from production telemetry; that is its own EPIC, its own §15 row, and its own infrastructure budget.
- Property-test sharding across CI workers. Today the eight properties run sequentially on a single vitest worker because the trial budget is small enough (8 × 1000 = 8000 trials, well under 60 seconds wall-clock on the workstation profile). If the budget grows past the per-PR window, sharding lands as a separate PR against `vitest.config.ts`; the property suites themselves are unchanged.

## Spec-cross-reference table

For traceability, the EPIC's mapping to the spec is:

| EPIC artefact | Spec anchor |
| --- | --- |
| Eight property files under `packages/sync/test/properties/` | §15.0 (predicates), §15.1 (Resource), §15.2 (Conflict) |
| `propertyTrials(label)` invocations at 1000-trial floor | §15.3 (trial floor) |
| `@causl/sync-testing-internal` package | §15.0 API sketch |
| `preserveLoadingEpisode`, `preserveOpenPriming` | §15.0 shrinking note |
| Walker enrolment in `spec-15.2-conformance.test.ts` | §15.3 walker; §17 commitment 8 |
| Acceptance gate (`all-properties-acceptance.test.ts`) | §17 commitment 8 (mechanical) |
| Out-of-scope rejections (no real-network, no real-backend, no engine-pipeline fuzz) | §15.4 |
| §9.1 race-row coverage (rows 6 and 17) | §9.1, §17 commitment 5 |

The table is the EPIC's commitment to the spec; a future contributor reads it to confirm the EPIC discharges every §15 row it claims.

## Worked counterexample story

To make the falsifying-input shape concrete for the next contributor, the §9.1 row 6 regression on Property 2 is the worked example. The regression is: a loading episode at origin `t = 5` resolves successfully with value `7`; between fetch-begin and resolve, exactly one `commit-elsewhere` event fires, bumping `graph.now` to `6`. The expected post-state is `{ state: 'stale', origin: 5, loadedAt: 6, value: 7 }` — the stale arm, with `origin < loadedAt`. The regression would produce `{ state: 'loaded', origin: 5, loadedAt: 6, value: 7 }` — the loaded arm with `origin < loadedAt`, which is a Theorem 1 violation: the loaded arm requires `origin === loadedAt`.

The property's predicate catches this exactly: when `episode.interleaved.length === 1` (one commit-elsewhere) and `episode.resolvesWith.ok === true`, the predicate's expected branch is `expectedStale = true`, so the post-state must satisfy `post.state === 'stale' && post.origin === episode.origin && post.loadedAt > episode.origin`. A regression where `post.state === 'loaded'` instead falsifies. The shrinker (with `preserveLoadingEpisode`) contracts the sample towards `interleaved: [{ kind: 'commit-elsewhere' }]` (length 1, the smallest non-empty case) and reports it as the counterexample. The contributor reading the failure sees:

```
Property failed after 1 tests
{ seed: 42, path: "0:0", endOnFailure: true }
Counterexample: {
  origin: 5,
  interleaved: [{ kind: "commit-elsewhere" }],
  resolvesWith: { ok: true, value: 7 }
}
Shrunk 8 time(s)
Got error: Property failed by returning false
```

— and the shrunk sample is small enough to read without re-deriving the chart. This is what Metz's "make the test prove the rule, not the example" buys us: the property's failure message is a structural statement of which arrow broke, not a stack trace into the implementation.

---

We four sign for this EPIC. Sandi Metz and Corey Haines lead, with Kent Beck on the TDD seam and Anders Hejlsberg on the TypeScript API surface for the testing-internal package. Metz owns the test-as-rule discipline — every property predicate is a total function over its generator's output space, with no skip-this-case guard, and the docstring on every property file names what the generator covers and what it does not. Haines owns the deliberate-practice review on every generator — every property review asks "what does this generator NOT produce?" and answers in code, not prose; the eight generator-review notes in the TASK sections above are the audit trail. Beck owns the trial-floor gate — the 1000-trial floor is non-negotiable, the conformance walker is the structural enforcement, the seam helper is the runtime enforcement, and a PR that lowers the floor fails three independent gates before it merges. Hejlsberg owns the testing-internal package's TypeScript API surface — every export is named in the §15.0 sketch, the `Object.keys` audit (TASK 9.1 test 2) is the closure boundary, and a 14th export is a §15.0 amendment, not a quiet addition.

The eight properties are the runtime witness for §17 commitment 8; the package is the seam that lets the eight property suites stay decoupled from the adapter's `src/` tree; the walker is the conformance gate that lets the floor hold across every property suite in the workspace. The §15.0 prose committed the predicates; this EPIC ships the runtime; the conformance walker holds the floor; the §17 commitment table cites this EPIC as the mechanical anchor.

This EPIC is downstream of nothing and upstream of nothing. EPIC-8's §10.5 worked-example fixtures and EPIC-10's §3.1 theorem gates are siblings, not blockers. The eight property suites and the testing-internal package land today against the surface we have, and they hold every commitment §15 names. We pay the full cost today, on the eight predicates, and we never pay it again until the chart changes.
