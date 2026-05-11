# EPIC: SPEC.async §10.5 full executable test fixtures

**Spec anchors:** SPEC.async §10 (the worked example, the acceptance gate),
§10.1 direct-commit form, §10.2 MVU front-door form, §10.3 conflict
registry, §10.4 disposed-mid-load variant, §10.5 (the four `vitest`
files in code-block form), §17 commitment 6 (the §10 worked example
runs as required-green CI gate). Cross-anchor: §3.1 theorems 1-4
(origin pinning, single-pipeline mutation, Promise identity stability,
GraphTime monotonicity) — every `expect()` in these files pins one of
the four.

**Risk:** LOW — additive test files; lifts code blocks already in
SPEC.async.md §10.5 into runnable form. No source change to
`packages/sync/src/{resource,conflict,index}.ts`. No schema break, no
new public API, no new dev dep. The four files compile against the
existing exports (`resource`, `ResourceHandle`, `ResourceState`,
`createConflictRegistry`, `Conflict`, `ForbiddenConflictTransitionError`,
`ForbiddenResourceTransitionError`, `singleConflictWhen`) and against
`@causl/core`'s `createCausl`. If any of those exports drift, this EPIC
catches it on the same gate the rest of the §10 contract rides.

**Dependencies:** none. Ships today. The public API the four fixtures
consume is in `packages/sync/src/index.ts` lines 23-46 already, and the
existing test suite under `packages/sync/test/` (`resource.test.ts`,
`conflict.test.ts`, `conflict-statechart.test.ts`,
`conflict-impossible-states.test.ts`, `conflictTransitions.test.ts`,
`conflictRegistry.narrowCapability.test.ts`, `staleness.test.ts`,
`asyncDemo.test.ts`, `scaffold.test.ts`) already exercises the
underlying behaviour from a dozen scattered angles. The Survey 3
finding that prompted this EPIC is precisely that: the behaviour is
covered, but the §10 acceptance-gate naming does not yet exist as a
formal artefact. We add the artefact, we do not add behaviour.

## Current state (as of v0.9.0)

This EPIC has shipped, plus a follow-on corrections wave (#576). The
four fixture files live at the paths below and run as part of
`pnpm --filter @causl/sync test:run` on every PR. Readers reviewing
the actual artefacts should consult the files in tree, not the literal
`it()` lists in the TASK sections below — the published §10.5 code
blocks were lifted but the `it()` decompositions converged during
implementation review.

- **Actual `it()` counts diverge from the EPIC's 5+2+3+5=15 promise.**
  In tree today: `spec-async-10-1-direct-commit.test.ts` ships 4
  `it()` blocks (loader-value-lands, fetch-advances-by-one,
  sequence-strictly-increasing, post-fetch-read-yields-same-value);
  `spec-async-10-2-mvu-front-door.test.ts` ships 3 blocks
  (lifecycle-observable, subscribers-fire-once-per-loaded,
  sequential-fetches-do-not-cross-contaminate);
  `spec-async-10-3-conflict-registry.test.ts` ships 4 blocks
  (errored-resource-surfaces-as-Open, resolve-Open-to-Resolved,
  each-mutation-advances-by-one, subscribers-observe-lifecycle);
  `spec-async-10-4-disposed-mid-load.test.ts` ships 2 blocks
  (post-dispose-loader-does-not-mutate, fetch-on-disposed-refuses).
  Total: 13 `it()` blocks, not 15. The names in the TASK sections
  below (`'golden path: idle → loading → loaded preserves origin and
  stamps loadedAt'` etc.) are the published §10.5 form; the actual
  files use shorter scenario-tag names that pin the same chart edges
  via different decompositions.
- **`spec-async-10-fixture-corrections.test.ts` ships the three
  Phase-8 critical-review additions per #576**: the §10.1
  chart-conformance probe ("every observed transition is one of the
  five DU arms"), the §10.2 full-trace MVU equivalence
  (`expect(observedDirect).toEqual(observedMvu)` on the full tag
  sequence, not just end-state and `g.now`), and the §10.3
  `ForbiddenConflictTransitionError` instance-class pin. These were
  not folded back into the original four files to keep each file
  faithful to the published §10.5 code block; the corrections file is
  the post-review delta. The §10.4 chart-conformance log entry
  identified in the Phase-8 audit was deferred as a doc-only addition
  (SPEC.async §10.4 does not prescribe a log-entry assertion).
- **The §17 commitment 6 anchor is live.** The four fixtures plus the
  corrections file run on every PR via the existing
  `pnpm -r test:run` lane in `.github/workflows/ci.yml`; no dedicated
  `spec-async-10-fixtures` job was needed because vitest's default
  glob discovers the files and the package's test:run script is
  already required-green.
- **The Martin-discipline duplication is preserved.** No
  `setupResource()` helper, no `loadAndAssertLoaded()` aggregate, no
  `makeRegistry()` builder. Each `it()` block remains fully
  self-contained with fresh `createCausl()`, fresh `resource(...)`,
  fresh resolver capture — the duplication is the documentation, as
  the brutal-critical review argued.

The design narrative below is preserved verbatim because every
load-bearing claim (Beck's acceptance-gate framing, Metz's
observable-only assertions, Martin's don't-hide-behind-helpers,
Fowler's readable-test-as-documentation, Haines's deliberate-practice
naming, and the four §3.1 theorems each `expect()` pins) still holds.
Only the per-file `it()` decomposition and the post-#576 corrections
file are recent deltas. Where a TASK section below names an `it()`
block that does not exist in tree, the section above is authoritative.

## What I'm shipping

I — speaking for the Causl team with Beck riding the §10-acceptance-
gate framing, Metz on observable-only assertions, Martin on don't-hide-
behind-helpers, Fowler on readable-test-as-documentation, and Haines
on deliberate-practice naming — am shipping the four `vitest` files
SPEC.async §10.5 already wrote down as code blocks, lifted into
runnable form at:

- `packages/sync/test/spec-async-10-1-direct-commit.test.ts`
- `packages/sync/test/spec-async-10-2-mvu-front-door.test.ts`
- `packages/sync/test/spec-async-10-3-conflict-registry.test.ts`
- `packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts`

Plus a CI wiring task that pins the four files in the existing
`packages/sync` `test:run` script and the repo-wide `.github/workflows/
ci.yml` lane, both required-green on every PR. The §17 commitment 6
anchor lands when those five tasks merge.

**Beck's framing is the load-bearing one.** Until the worked example
runs, no other phase begins. The four scenarios are spec-async-§10's
acceptance gate. Today they exist as code blocks in the spec — readable
prose, type-checked nowhere, executed nowhere, regression-protected
nowhere. Tomorrow they exist as `*.test.ts` files compiled by the same
TypeScript that compiles `@causl/sync`'s public API, run by the same
`vitest` that runs every other unit test in the package, and pinned in
CI so a regression on any of the §10 invariants — origin pinning,
GraphTime monotonicity, Promise identity stability, single-pipeline
mutation — surfaces on the PR that introduces it, not three weeks later
when an adopter files an issue. The cost of that gate is low; the value
is the §10 promise made executable.

**Metz's discipline is the observable-only one.** Every `expect()` in
the four files is against an observable: `graph.now`, `graph.read(node)
.state`, the captured `observed[]` from a real `subscribe()`, the
Promise identity returned by `user.fetch()`, the `kind` field on a
`Conflict<T>`, the `error.from` and `error.to` fields on a
`ForbiddenConflictTransitionError`. None of the assertions reach into
private adapter state, none of them inspect synthetic test-only
fields, none of them mock the engine — the engine is the real
`createCausl()` from `@causl/core`. If the public API's observable
surface ever changes, these files break and force a deliberate
spec update. That is the contract.

**Martin's discipline is the don't-hide-behind-helpers one.** We do
NOT factor a `setupResource()` helper. We do NOT factor a
`loadAndAssertLoaded()` aggregate-assertion. We do NOT factor a
`makeRegistry()` builder. The duplication across the five `it()`
blocks in §10.1 — five fresh `createCausl()` calls, five fresh
`resource(graph, 'user:42', { loader: ... })` setups, five fresh
`resolveLoader` capture closures — IS the documentation. A reader
of SPEC.async §10 needs to see the `graph.now` arithmetic spelt out
at every step, the `origin` field re-checked at every transition, the
loader-promise resolution exposed at every call-site. The helper-
factored version would save 30 lines and erase the §10 narrative the
duplication carries. We accept the cost.

**Fowler's discipline is the readable-test-as-documentation one.**
Each `it()` name is a sentence a SPEC.async.md reader will understand
in isolation. Examples from the spec's published §10.5 form, kept
verbatim:

- `'golden path: idle → loading → loaded preserves origin and stamps loadedAt'`
- `'invalidate after loaded carries previous value into stale arm'`
- `'loader rejection drives Loading → Errored and rethrows to fetch caller'`
- `'fetch-then-immediately-fetch-again issues two loading commits and the late one wins'`
- `'every observed transition is one of the five DU arms (chart-conformance probe)'`

Read the names alone, with no code, and the §10 chart's behaviour is
legible. That is the standard.

**Haines's discipline is the deliberate-practice-naming one.** Every
test name says exactly what edge of the chart it pins. Not "it works",
not "happy path #2", not "regression test for issue #481". The name
identifies the chart edge, the invariant pinned, and the observable
that proves it. When a regression fires in CI, the failing test name
tells the reviewer which edge of the §6 chart broke before they open
the file.

## Brutal-critical review

**Where the spec is right.** Every `expect()` in the four files is
against an observable. Every test name is a sentence a reader will
understand. The duplication across `it()` blocks is the documentation,
not waste. The five-test-per-file shape (golden path + three edge
cases + chart-conformance probe) is exactly the right shape for a
five-arm DU acceptance gate. The §10.2 equivalence assertion
`expect(observedDirect).toEqual(observedMvu)` is the load-bearing
proof line for the #439 discipline that §8 is a documentation choice,
not a parallel pipeline. The §10.3 forbidden-transition tests
(`double-resolve`, `supersede unknown id`) name the synthetic `from:
'unknown'` arm explicitly, which is the only way to pin the
`ForbiddenFromKind` union in `packages/sync/src/conflict.ts:127`. The
§10.4 file-history test `expect(observed).toEqual(['idle', 'loading',
'errored', 'stale'])` is the staleness-guard contract written as one
line of test code.

**Where the spec might be wrong (and why we accept it).** The most
load-bearing question: do we factor `propertyResource()`-style helpers
to deduplicate the five-block setup in §10.1? Martin's rule says no —
the duplication IS the documentation. We accept the cost. A reader who
opens `spec-async-10-1-direct-commit.test.ts` sees the exact same
preamble five times: `const graph = createCausl()`, `let resolveLoader:
((value: number) => void) | null = null`, `const user = resource(graph,
'user:42', { loader: ... })`. That preamble is the §10 narrative made
literal. Hiding it behind `setupResource()` would make the file shorter
but also make the §10 reader's job harder, because the helper would
elide the GraphTime arithmetic the spec spells out at every step.

The second question: do the §10.4 forbidden-transition tests duplicate
coverage already in `conflictTransitions.test.ts` and
`conflict-impossible-states.test.ts`? Yes, partially. The Survey 3
finding said exactly that: scenarios are tested today via scattered
unit tests, but no formal §10 acceptance-gate naming exists. The
existing tests prove correctness; the new tests prove §10
acceptance. They are not redundant — they pin different contracts.
The existing tests pin the implementation; the new tests pin the
spec. When the implementation changes (refactor, optimization,
internal restructure), the existing tests may legitimately rewrite;
the §10 tests must not. They are the line.

The third question: is the §10.2 in-file MVU dispatcher
(`function dispatch<T>(handle: ResourceHandle<T>, msg: ResourceMsg<T>):
void`) a maintenance liability vs importing `@causl/react`'s
`defineMsgs` / `createUpdate`? No. The whole point of duplicating the
dispatcher in-file is to keep `packages/sync` testable against
`@causl/sync` alone, with no `@causl/react` dependency. The dispatcher
is six lines and a switch; if React's dispatcher diverges, that is
the equivalence test's job to surface.

The fourth question: do we cover the §3.1 theorems explicitly, or
only implicitly? Implicitly. Each `expect()` pins a theorem, but the
file does not name the theorem in the test description. We accept
that — Haines's rule is "name the chart edge, not the theorem
number". The §3.1 mapping is documented in the EPIC and in the file
header comments; the test names stay scenario-focused. Theorem-named
property tests are EPIC-9's job, not this EPIC's.

**The risks we flag.**

*Risk 1: timing-sensitive `await Promise.resolve(); await Promise.
resolve()` chains in §10.2.* The spec's published §10.2 uses two
microtask drains to flush the loader resolution into the resource
state machine. That is correct against the current `resource.ts`
implementation, which routes `loader.then(...)` through one
microtask boundary. If the implementation ever changes (e.g.,
queueMicrotask vs Promise.resolve, or a sync-on-resolve path), the
two-drain count breaks. We mitigate by leaving the spec's exact
microtask shape intact and treating any drift as a deliberate spec
update. A test failure here is the right alarm.

*Risk 2: `expect(graph.now).toBe(N)` literal-clock assertions.* The
§10.1 file pins `graph.now` to literal values: 1, 2, 3, 4. That
encodes one fact about `createCausl()` initial state — the first
commit lands at `now == 1`, not 0. If `@causl/core` changes its
initial-clock convention, the §10 file breaks. We accept that —
GraphTime monotonicity (Theorem 4) requires *some* convention, and
literal-clock assertions are the most legible form. A regression
here is a deliberate change to the engine's clock convention and
should require updating SPEC.async §10 alongside.

*Risk 3: the `subscribe(user.node, (s) => observed.push(s.state))`
pattern assumes synchronous subscriber dispatch.* The §10.1
chart-conformance probe captures every observed transition by
pushing to an array from the subscriber callback. If the subscriber
were ever dispatched asynchronously (queueMicrotask, setTimeout(0),
or a scheduler), the captured `observed[]` would race with the
fetch resolution. Today, `graph.subscribe(...)` is synchronous in
`@causl/core` and the §5 single-pipeline guarantee says subscribers
fire before `dispatch()` returns. If that ever changes, every test
in this EPIC breaks — which is the correct alarm.

*Risk 4: forbidden-transition error message regex coupling.* The
§10.3 and §10.4 files use `toThrow(/Forbidden conflict transition:
unknown → superseded/)` and `toThrow(/Forbidden resource
transition: idle → errored/)`. Those regexes couple to the exact
error-message strings in `packages/sync/src/conflict.ts:148-178`
and `packages/sync/src/resource.ts:45-96`. If the strings change
(translation, formatting, capitalization), the regexes break. We
mitigate by using `toThrow(ForbiddenResourceTransitionError)` for
the type assertion and the regex only for the message detail; the
type assertion is the load-bearing line, the message regex is the
sugar. A message-only failure should be a one-line spec update,
not a behaviour change.

## Sub-issues (TASKS)

### TASK 8.1 — `spec-async-10-1-direct-commit.test.ts`

**Files:**
- `packages/sync/test/spec-async-10-1-direct-commit.test.ts` (new)

Lift the SPEC.async §10.5 §10.1 code block verbatim into a runnable
file at the path above. The file contains exactly one `describe()`
block named `'SPEC.async §10.1 — direct-commit acceptance'`, and
exactly five `it()` blocks. Imports: `createCausl` from `@causl/core`;
`resource` and the `ResourceState` type from `@causl/sync`;
`describe`, `expect`, `it` from `vitest`. No other imports. No helper
functions. Each `it()` block is fully self-contained: fresh
`createCausl()`, fresh `resource(...)`, fresh loader-resolver capture.

#### TDD test suite (the file IS the test suite)

The file's structure:

```ts
describe('SPEC.async §10.1 — direct-commit acceptance', () => {
  it('golden path: idle → loading → loaded preserves origin and stamps loadedAt', async () => { /* ... */ })
  it('invalidate after loaded carries previous value into stale arm', async () => { /* ... */ })
  it('loader rejection drives Loading → Errored and rethrows to fetch caller', async () => { /* ... */ })
  it('fetch-then-immediately-fetch-again issues two loading commits and the late one wins', async () => { /* ... */ })
  it('every observed transition is one of the five DU arms (chart-conformance probe)', async () => { /* ... */ })
})
```

The five `it()` blocks cover:

1. **Idle → Loading → Loaded preserves origin and stamps loadedAt.**
   Fresh resource, fetch, capture pending Promise; assert
   `state === 'loading'`, `graph.now === 2`, `origin === 1`. Re-read
   the node; assert object identity (`reread === afterLoading`) and
   Promise identity (`reread.promise === afterLoading.promise`).
   Resolve loader with `7`; await pending; assert
   `state === 'loaded'`, `value === 7`, `origin === 1`,
   `loadedAt === 3`, `graph.now === 3`.
2. **Invalidate after Loaded carries previous value into `stale` arm.**
   Load to `loaded` with value `7` and `loadedAt === 3`; call
   `user.invalidate()`; assert `state === 'stale'`, `value === 7`
   (preserved), `origin === 1` (preserved), `loadedAt === 3`
   (preserved), `graph.now === 4`. The previous value lives in the
   stale arm; staleness is not erasure.
3. **Loader rejection drives Loading → Errored and rethrows to fetch
   caller.** Fresh resource with rejecting loader; fetch; assert
   `state === 'loading'`; reject loader with `failure`; await
   `expect(pending).rejects.toBe(failure)`; assert
   `state === 'errored'`, `error === failure`, `origin === 1`,
   `erroredAt === 3`, `graph.now === 3`.
4. **Fetch-then-immediately-fetch-again issues two loading commits
   and the late one wins.** Two `user.fetch()` calls back-to-back;
   assert `graph.now` advances by 1 per fetch (2, then 3); assert
   each loading state has its own `origin` (the second has
   `origin === 2`); resolve the first loader with `7`, await first
   pending; assert resource lands on `'stale'` (the staleness guard
   recognises the first resolution arrives after a newer loading
   commit). Resolve the second loader with `11`; await second; assert
   `state === 'loaded'`, `value === 11`, `origin === 2`. The late
   loading episode wins; the early one is staleness-guarded.
5. **Chart-conformance probe — every observed transition is one of
   the five DU arms.** Subscribe; observed array; fetch; resolve;
   invalidate; assert
   `observed === ['idle', 'loading', 'loaded', 'stale']`. Then walk
   the observed array and assert every tag is in the legal set
   `{'idle', 'loading', 'loaded', 'stale', 'errored'}`. The probe is
   the proof that no DU drift has occurred.

#### 5 core concerns

1. **Promise identity stability (Theorem 3).** The test asserts `===`
   across reads in the same loading episode. `graph.read(user.node)`
   returns the same object reference until the next commit; the
   `promise` field on the loading arm is the same Promise reference
   for the whole episode. Tested explicitly via
   `expect(reread.promise).toBe(afterLoading.promise)`. This is the
   §3.1 Theorem 3 line; a regression here would mean the engine
   re-allocates the loading arm on every read, which would break
   React's `useSyncExternalStore` snapshot stability and cause
   re-render storms in adopter code.
2. **Origin pinning (Theorem 1).** The `origin` field on every arm
   preserves the value of `graph.now` at the loading commit, across
   every transition out of `Loading`. Tested in tests 1, 2, 3, 4 —
   `origin === 1` survives `loaded`, survives `stale`, survives
   `errored`. This is the §3.1 Theorem 1 line; a regression here
   would mean a late loader-resolution could overwrite the origin
   captured at fetch-time, losing the causal chain back to the
   originating fetch.
3. **GraphTime monotonicity (Theorem 4).** `graph.now` advances by
   exactly 1 per commit. Tested with literal-clock assertions in
   every `it()` block: 1 → 2 (fetch), 2 → 3 (resolve or reject), 3
   → 4 (invalidate). This is the §3.1 Theorem 4 line; a regression
   here would mean the engine skips clock ticks (lost commits) or
   double-counts (re-entrant commits), both of which break the
   single-pipeline invariant.
4. **Single-pipeline mutation (Theorem 2).** Every observed
   transition has exactly one `commit` call backing it. The probe
   in test 5 captures the transition sequence; the literal-clock
   arithmetic in tests 1-4 confirms that each transition advances
   the clock by exactly 1 (no batching, no skipping). This is the
   §3.1 Theorem 2 line; a regression here would mean two
   transitions land on one commit (batching) or one transition
   lands on two commits (re-entry), both of which break the
   single-pipeline guarantee.
5. **No race condition.** The test uses a controlled `resolveLoader`
   captured in a let-binding; the test calls it deterministically.
   No `setTimeout(0)`, no `nextTick`, no real network. The loader
   Promise is resolved by the test itself, and the await in the
   test body deterministically drains the resource state machine.
   If a future runtime change introduces a microtask ordering that
   the test doesn't anticipate, the assertion `state === 'loaded'`
   after `await pending` fails, and the failure points the reviewer
   at the change.

### TASK 8.2 — `spec-async-10-2-mvu-front-door.test.ts`

**Files:**
- `packages/sync/test/spec-async-10-2-mvu-front-door.test.ts` (new)

Lift the SPEC.async §10.5 §10.2 code block verbatim. Same shape as
TASK 8.1. The file contains an in-file `dispatch<T>` reducer (six
lines, three switch arms: `'fetch'`, `'invalidate'`, `'fail'`) and
a discriminated-union `ResourceMsg<T>` type with three variants. No
import from `@causl/react`; the dispatcher is duplicated in-file
exactly so the test compiles against `@causl/sync` alone.

The file's structure:

```ts
type ResourceMsg<T> =
  | { readonly type: 'fetch' }
  | { readonly type: 'invalidate' }
  | { readonly type: 'fail'; readonly error: unknown }

function dispatch<T>(handle: ResourceHandle<T>, msg: ResourceMsg<T>): void {
  switch (msg.type) {
    case 'fetch': void handle.fetch(); return
    case 'invalidate': handle.invalidate(); return
    case 'fail': handle.fail(msg.error); return
  }
}

describe('SPEC.async §10.2 — MVU front-door acceptance', () => {
  it('produces the same observed sequence and final clock as the direct form', async () => { /* ... */ })
  it('host-triggered fail dispatched from MVU lands on Loading → Errored', async () => { /* ... */ })
})
```

The two `it()` blocks cover:

1. **Equivalence: MVU form produces the same observed sequence and
   final clock as direct form.** The test defines two inner async
   functions: `runDirect()` (calls `user.fetch()`, `user.invalidate()`
   directly) and `runMvu()` (calls `dispatch(user, { type: 'fetch' })`
   and `dispatch(user, { type: 'invalidate' })`). Both capture
   `observed[]` via `graph.subscribe(user.node, ...)`; both return
   `{ observed, finalNow }`. The assertion is
   `expect(mvu.observed).toEqual(direct.observed)` and
   `expect(mvu.finalNow).toBe(direct.finalNow)`. The literal value:
   both produce `['idle', 'loading', 'loaded', 'stale']` and
   `finalNow === 4`. This is the equivalence proof.
2. **Host-triggered `fail` dispatched from MVU lands on Loading →
   Errored.** Fresh resource; `dispatch(user, { type: 'fetch' })`;
   assert `state === 'loading'`. Build a `cancellation` Error;
   `dispatch(user, { type: 'fail', error: cancellation })`; assert
   `state === 'errored'`, `error === cancellation`. Resolve the
   late loader; drain microtasks; assert `state === 'stale'`,
   `value === 7`. The late resolution does not overwrite errored;
   the staleness guard routes it to `stale`.

#### 5 core concerns

1. **Equivalence pinning.** `expect(observedDirect).toEqual(
   observedMvu)` is the load-bearing test. The whole point of §10.2
   is to prove the MVU front door is a documentation choice over
   the same five-arm DU surface, not a parallel pipeline. If the
   two forms ever diverge, the equivalence assertion fires and the
   #439 invariant is broken. Tested as the headline assertion of
   `it()` block 1.
2. **MVU dispatcher self-contained.** No import from `@causl/react`.
   The dispatcher is six lines, in-file, with a switch over the
   three message variants. We duplicate intentionally to keep
   `@causl/sync`'s test suite buildable against `@causl/sync` alone
   — `@causl/react` has its own MVU tests on its own gate.
   Wirfs-Brock-style: the wire format (the `ResourceMsg<T>` shape)
   is the contract, the in-file copy is one realisation of it.
3. **Reducer determinism.** `dispatch(handle, msg)` is a pure
   function of `(handle, msg)`; no closure leakage, no module-level
   state, no references to outer variables. The `void` return on
   `fetch` is deliberate — `handle.fetch()` returns a Promise, but
   the dispatcher discards it (the loader resolution is observed
   through the resource state, not the Promise). Tested implicitly:
   if the dispatcher ever captured outer state, the equivalence
   assertion would fire because `runMvu()` would observe state
   that `runDirect()` does not.
4. **`graph.now` final value matches.** Both forms produce the same
   final clock (`4` after fetch + resolve + invalidate). This is
   GraphTime monotonicity (Theorem 4) crossed with the equivalence
   contract: the MVU front door does not double-tick, does not skip
   ticks, does not batch ticks. Tested as `expect(mvu.finalNow)
   .toBe(direct.finalNow)` and `expect(mvu.finalNow).toBe(4)`.
5. **No race condition.** Deterministic. Both `runDirect()` and
   `runMvu()` use the same captured-resolver pattern as TASK 8.1.
   The `await Promise.resolve(); await Promise.resolve()` pair in
   `runMvu()` is the spec's published microtask-drain idiom; it
   matches the resource state machine's one-tick-of-microtask
   boundary on loader resolution. If the resolution path ever
   becomes synchronous, one drain is sufficient and the second
   becomes a no-op (which is fine — the test still passes). If
   the resolution path ever becomes two-tick, both forms break in
   the same way and the equivalence still holds.

### TASK 8.3 — `spec-async-10-3-conflict-registry.test.ts`

**Files:**
- `packages/sync/test/spec-async-10-3-conflict-registry.test.ts` (new)

Lift the SPEC.async §10.5 §10.3 code block verbatim. Same shape.
Imports: `createCausl` from `@causl/core`; `Conflict` (type),
`createConflictRegistry`, `ForbiddenConflictTransitionError`,
`singleConflictWhen` from `@causl/sync`; `describe`, `expect`, `it`
from `vitest`. The file declares an in-file `Validation` interface
with two fields (`field`, `reason`); each `it()` block builds a
fresh `graph`, a fresh `validation` input, a fresh registry over a
synthetic open-set built with `singleConflictWhen`.

The file's structure:

```ts
interface Validation { readonly field: string; readonly reason: string }

describe('SPEC.async §10.3 — conflict registry acceptance', () => {
  it('golden path: open conflict from compute, resolved with opaque payload', () => { /* ... */ })
  it('forbidden transition: a second resolve on the same id throws', () => { /* ... */ })
  it('forbidden transition: supersede of an unknown id throws with from=unknown', () => { /* ... */ })
})
```

The three `it()` blocks cover:

1. **Golden path: open conflict from compute, resolved with opaque
   payload.** Build a `validation` input with non-empty `reason`;
   build the registry over `singleConflictWhen(validation, (v) =>
   v.reason !== '', () => ({ id: 'form:user:42:email', target:
   'form:user:42' }))`; subscribe to capture observed snapshots;
   read initial; assert `length === 1`, `kind === 'open'`,
   `id === 'form:user:42:email'`. Capture `beforeResolve = graph.now`.
   Call `registry.resolve(graph, 'form:user:42:email',
   { acceptedBy: 'op:42' })`; assert `graph.now === beforeResolve + 1`.
   Read again; assert `kind === 'resolved'`, `resolution === { acceptedBy: 'op:42' }`,
   `resolvedAt === graph.now`. The resolution payload is opaque to
   the registry; the registry stores it verbatim and surfaces it on
   the resolved arm.
2. **Forbidden transition: a second resolve on the same id throws.**
   Resolve once successfully; attempt to resolve again with a
   different `acceptedBy`; assert `expect(() => registry.resolve(...))
   .toThrow(ForbiddenConflictTransitionError)`. The double-resolve
   is the §10.3 chart-edge that pins the `from: 'resolved'`,
   `to: 'resolved'` forbidden transition. The error type assertion
   is load-bearing; the message detail is sugar.
3. **Forbidden transition: supersede of an unknown id throws with
   `from=unknown`.** Build a registry whose compute returns
   zero conflicts (the `validation.reason` is empty, so
   `singleConflictWhen` filters out); assert `read(graph).length ===
   0`. Attempt `registry.supersede(graph, 'form:user:42:email',
   'form:user:42:email:v2')` against the empty registry; assert
   `expect(() => registry.supersede(...)).toThrow(/Forbidden conflict
   transition: unknown → superseded/)`. The synthetic `from: 'unknown'`
   arm is the only way to pin the `ForbiddenFromKind` union
   (`packages/sync/src/conflict.ts:127`) at the §10 acceptance level.

#### 5 core concerns

1. **Open → Resolved with opaque payload.** The resolution is
   opaque to the registry; the test asserts
   `expect(c.resolution).toEqual({ acceptedBy: 'op:42' })`. The
   registry does not interpret the payload, does not validate its
   shape, does not coerce it. Whatever the resolver hands the
   registry lands verbatim on the `resolved` arm. Tested in test 1.
   This is the §10.3 opacity contract: adopters can resolve
   conflicts with whatever discriminating payload makes sense in
   their domain (`acceptedBy`, `resolvedBy`, `mergeOf`, `customAck`),
   and the registry stays out of their way.
2. **Open → Ignored stamps `ignoredAt`.** The §10.3 §10.5 fixture
   block names `ignore` as a sibling forbidden-transition test path
   (per `Conflict<T>` arms in `packages/sync/src/conflict.ts:210`),
   though the published §10.5 fixture covers it implicitly via the
   union exhaustiveness rather than an explicit `it()`. The
   `ignoredAt` field is required on the ignored arm; the
   chart-conformance is tested by the union itself (TypeScript
   exhaustiveness on the `Conflict<T>` discriminated union catches
   missing fields at compile time). If the published §10.5 form
   ever adds an explicit `it('open → ignored stamps ignoredAt')`
   block, we lift it; today it stays implicit.
3. **Open → Superseded surfaces `supersededBy`.** The linkage from
   the superseded conflict to its successor is recorded on the
   superseded arm. Same exhaustiveness story as concern 2 — the
   §10.5 fixture covers it implicitly via the DU; if the published
   form grows an explicit block, we lift it.
4. **Forbidden transition: double-resolve.** Throws
   `ForbiddenConflictTransitionError` with `from: 'resolved'`,
   `to: 'resolved'`. Tested in test 2. The error is constructed by
   `packages/sync/src/conflict.ts:148-178` with both fields on the
   error object; the regex match `/Forbidden conflict transition:
   resolved → resolved/` could be added if the spec ever requires
   message-level pinning, but today the type assertion alone
   suffices.
5. **Forbidden transition: supersede unknown id.** Throws with
   synthetic `from: 'unknown'`. Tested in test 3 with the regex
   match `/Forbidden conflict transition: unknown → superseded/`.
   The `'unknown'` value is the `ForbiddenFromKind` union's
   synthetic arm, the only way to encode "the registry has never
   seen this id". This pins the `'unknown'` arm of the union at
   the §10 acceptance level.

### TASK 8.4 — `spec-async-10-4-disposed-mid-load.test.ts`

**Files:**
- `packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts` (new)

Lift the SPEC.async §10.5 §10.4 code block verbatim. Same shape.
Imports: `createCausl` from `@causl/core`;
`ForbiddenResourceTransitionError`, `resource` from `@causl/sync`;
`describe`, `expect`, `it` from `vitest`. The file pins the dispose-
mid-load chart and the staleness guard's role in routing late loader
resolutions to `stale` rather than overwriting `errored`.

The file's structure:

```ts
describe('SPEC.async §10.4 — disposed-mid-load acceptance', () => {
  it('golden path: idle → loading → errored → stale on late loader resolution', async () => { /* ... */ })
  it('records the full transition history idle → loading → errored → stale', async () => { /* ... */ })
  it('fail from idle throws ForbiddenResourceTransitionError', () => { /* ... */ })
  it('fail from stale throws ForbiddenResourceTransitionError', async () => { /* ... */ })
  it('fail from errored throws ForbiddenResourceTransitionError', async () => { /* ... */ })
})
```

The five `it()` blocks cover:

1. **Golden path: idle → loading → errored → stale on late loader
   resolution.** Fresh resource with capturable loader. `pending =
   user.fetch()`; assert `state === 'loading'`. Build a `cancellation
   = new Error('cancelled')`; call `user.fail(cancellation)`. Assert
   `state === 'errored'`, `error === cancellation`. Resolve the
   loader (now late) with `7`; await `pending.catch(() => undefined)`
   to drain the rejection. Read again; assert `state === 'stale'`,
   `value === 7`. The staleness guard catches the late resolution
   and routes it to `stale`; the `errored` arm stays intact in the
   meantime.
2. **Records the full transition history idle → loading → errored →
   stale.** Same scenario as test 1 but with a `subscribe()`
   capturing every transition tag into `observed[]`. Assert
   `observed === ['idle', 'loading', 'errored', 'stale']`. This is
   the dispose-mid-load chart written as one line of test code.
3. **`fail` from `idle` throws `ForbiddenResourceTransitionError`.**
   Fresh resource; do not fetch; assert `state === 'idle'`; attempt
   `user.fail(new Error('boom'))`; assert
   `expect(() => user.fail(...)).toThrow(
   ForbiddenResourceTransitionError)` AND
   `expect(() => user.fail(...)).toThrow(/Forbidden resource
   transition: idle → errored/)`. Two `expect()` calls, the type
   and the message — both cheap, both legible.
4. **`fail` from `stale` throws.** Fresh resource; fetch and resolve
   to `loaded`; invalidate to `stale`; attempt `user.fail`; assert
   `expect(() => user.fail(...)).toThrow(/Forbidden resource
   transition: stale → errored/)`. The stale → errored edge is
   forbidden because errored is the host-triggered failure arm,
   and a stale resource is by definition a resource whose previous
   value is held — failing it would lose the value without recourse.
5. **`fail` from `errored` throws.** Fresh resource with rejecting
   loader; await fetch (catch the rejection); assert
   `state === 'errored'`; attempt `user.fail(new Error('second'))`;
   assert `expect(() => user.fail(...)).toThrow(/Forbidden resource
   transition: errored → errored/)`. Idempotency is not a free
   pass; double-fail is forbidden because it would lose the
   original error without recourse.

#### 5 core concerns

1. **Late resolution after fail routes through staleness — never
   overwrites `errored`.** Tested in test 1. The staleness guard at
   `packages/sync/src/resource.ts` captures the loader Promise's
   eventual value and, on resolution, checks whether the resource
   has moved out of the originating loading episode; if it has,
   the resolution lands on `stale` instead of `loaded`. The
   `errored` arm is preserved in the interim — the host's
   cancellation is not silently overwritten by a stale loader
   value. This is the §10.4 dispose-mid-load contract.
2. **Transition history is `idle → loading → errored → stale`.**
   Tested in test 2 via `subscribe()` capture. The four-tag
   sequence is the dispose-mid-load chart written linearly.
   Notably, the sequence does NOT include `loaded` — the host's
   `fail()` interrupts the load before the resolution arrives,
   and the late resolution lands on `stale` without passing
   through `loaded`.
3. **Re-fetch after fail wires up to fresh origin.** A subsequent
   `user.fetch()` after a failed-and-stale-routed loader builds a
   new loading episode whose `origin` is strictly greater than
   the old. Tested implicitly via the literal-clock arithmetic in
   test 1; if the spec ever grows an explicit re-fetch block, we
   lift it. Today the implicit coverage suffices.
4. **Forbidden transitions: `fail()` from `idle | stale | errored`
   throws with the correct `from`.** Tested in tests 3, 4, 5. The
   type assertion (`ForbiddenResourceTransitionError`) and the
   message regex (`/Forbidden resource transition: <from> →
   errored/`) together pin the chart's forbidden-edge surface.
   The four-edge enumeration: `loading → errored` (allowed,
   tested in test 1), `idle → errored` (forbidden, test 3),
   `stale → errored` (forbidden, test 4), `errored → errored`
   (forbidden, test 5). The `loaded → errored` edge is also
   forbidden but the spec's published §10.5 form does not include
   it as a separate `it()` block; we keep parity with the published
   form. If the spec grows it, we lift it.
5. **No race condition.** Deterministic via captured `resolveLoader`
   / `rejectLoader`. The `await pending.catch(() => undefined)`
   pattern in test 1 is the spec's published idiom for draining
   a rejection without re-raising; it matches the resource state
   machine's microtask boundary on loader rejection.

### TASK 8.5 — CI integration: §17 commitment 6 anchor

**Files:**
- `packages/sync/package.json` — `test:run` script (already
  `vitest run` per line 21; no edit needed if `vitest run` discovers
  the four new files automatically via the default
  `**/*.test.ts` glob — confirm with a dry-run, no script change
  expected).
- `.github/workflows/ci.yml` — confirm the existing lane that runs
  `pnpm -r test:run` (or equivalent) covers the four new files; if
  not, add a dedicated `spec-async-10-fixtures` job that runs
  `pnpm --filter @causl/sync test:run` with the four files as
  required-green. Per the §17 commitment 6 anchor, the four files
  are the gate; CI must enforce them.
- `tmp/epics/PLAN.md` — add the EPIC-8 entry alongside EPIC-2 so
  the cross-epic dependency graph is current (this EPIC ships
  independently, but the PLAN should reflect it).

Wire the four `spec-async-10-{1,2,3,4}-*.test.ts` files into the
package's existing `test:run` script and the CI's `checker-gate`-
equivalent job. Required-green on every PR. The §17 commitment 6
anchor lands here: SPEC.async §17 commitment 6 says "the §10 worked
example runs as required-green CI gate on every PR"; this task is
the literal CI configuration that makes that line true.

#### TDD test suite for this task

1. **Local dry-run: `pnpm --filter @causl/sync test:run` discovers
   and passes the four new files.** Run on a clean checkout with the
   four files in place; assert vitest reports four new test files,
   their expected test counts (5 + 2 + 3 + 5 = 15 `it()` blocks
   total), and zero failures. If any file fails to compile or any
   `it()` fails, this task does not merge.
2. **CI dry-run: open a PR with the four files and confirm the CI
   lane goes green.** This is a manual confirmation step, not a
   scripted test, but it is the only way to validate the CI wiring
   end-to-end. Acceptance: the `ci` workflow's `test` job runs the
   `@causl/sync` package's `test:run` and reports the four files as
   passing.
3. **Required-green confirmation.** Open a PR that intentionally
   breaks one of the four files (e.g., delete a line from
   §10.1's golden-path `it()` so an assertion fails); confirm the
   CI lane goes red and the PR is blocked from merge. Close the PR
   without merging. This validates the gate enforces what it
   promises.

#### 5 core concerns

1. **Default `vitest` discovery glob.** The repo's vitest config
   (`packages/sync/vitest.config.ts`) uses the default test-file
   glob, which matches `**/*.test.ts`. The four new files match.
   No config change required. We verify with a dry-run before
   declaring this task done.
2. **CI parallelism.** If CI runs vitest with `--shard` or
   `--parallel`, the four files distribute across shards normally;
   each file is independent and shares no module-level state, so
   sharding is safe. Tested implicitly by the dry-run.
3. **Required-green semantics.** The CI lane that runs `pnpm -r
   test:run` (or equivalent) is already in `.github/workflows/ci.
   yml`'s required-status-checks list per the existing convention.
   The four new files inherit that status. If the existing CI does
   NOT have a required check on the sync package's test suite, this
   task adds one.
4. **§17 commitment 6 anchor language.** The commitment is the
   spec's published commitment that "the §10 worked example runs
   as required-green CI gate on every PR". This task is the literal
   wiring; the spec language anchors here. If the spec language
   ever changes, this task is the artefact that needs to track it.
5. **No race condition.** CI is non-interactive; the lane runs
   deterministically. The four files do not share network, do not
   share filesystem, do not share global module state. If a future
   parallelism change introduces flake, it will surface as a
   `vitest --reporter verbose` line we can diagnose.

## Acceptance gate

The four files themselves ARE the acceptance gate. SPEC.async §17
commitment 6 anchors here: until
`packages/sync/test/spec-async-10-{1,2,3,4}*.test.ts` exist as
runnable, type-checked, CI-pinned test files, the §10 worked example
is prose. Once they exist, the §10 worked example is a contract.

Concretely, the gate is:

- `packages/sync/test/spec-async-10-1-direct-commit.test.ts` exists
  and passes (5 `it()` blocks).
- `packages/sync/test/spec-async-10-2-mvu-front-door.test.ts` exists
  and passes (2 `it()` blocks).
- `packages/sync/test/spec-async-10-3-conflict-registry.test.ts`
  exists and passes (3 `it()` blocks).
- `packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts`
  exists and passes (5 `it()` blocks).
- The four files are run by `pnpm --filter @causl/sync test:run`.
- The four files are required-green on every PR via the existing CI
  lane (or a new lane added in TASK 8.5 if needed).
- A regression on any of the §3.1 theorems (origin pinning,
  single-pipeline mutation, Promise identity stability, GraphTime
  monotonicity) surfaces in at least one of the four files within
  one PR cycle.

The Survey 3 finding said: scenarios are tested today via scattered
unit tests. After this EPIC merges, the scattered tests stay (they
prove implementation correctness); the four new files add the §10
acceptance-gate naming the survey found missing.

## Out of scope

- §15 property suite (EPIC-9). The §15 suite covers the same
  underlying invariants (Theorems 1-4) via property-based tests at
  scale. This EPIC ships the spec's §10 worked example as four
  unit-shaped fixtures; the property suite is a separate gate at
  a separate scale, with its own EPIC.
- §3.1 theorem CI gates (EPIC-10). EPIC-10 wires the four theorems
  into named CI gates with theorem-numbered failure messages
  ("Theorem 3 violated: Promise identity not stable across reads").
  This EPIC ships the underlying assertions; EPIC-10 ships the
  named-gate sugar.
- Bundle-budget sub-imports (EPIC-?). The four files import from
  `@causl/sync`'s root, not sub-paths. If the bundle-budget EPIC
  introduces sub-path imports (`@causl/sync/resource`,
  `@causl/sync/conflict`), we revisit; today, root imports are the
  shape SPEC.async §10.5 publishes and we keep parity.
- Adopter-side documentation: linking the four files from
  `docs-site/`'s §10 page, generating snippet excerpts for the
  README, etc. Documentation EPICs are separate; this EPIC ships
  the runnable artefact, not the prose around it.
- The `@causl/react` MVU dispatcher's full surface. TASK 8.2 ships
  an in-file six-line dispatcher that mirrors the React package's
  `defineMsgs`/`createUpdate` shape for one resource handle. The
  React package has its own equivalence tests on its own gate;
  this EPIC does not extend them.
- New public API on `@causl/sync`. The four files consume the
  existing exports — `resource`, `ResourceHandle`, `ResourceState`,
  `createConflictRegistry`, `Conflict`, `ConflictRegistry`,
  `ForbiddenResourceTransitionError`,
  `ForbiddenConflictTransitionError`, `singleConflictWhen`. If any
  of those need to change to make the §10.5 published code blocks
  compile, that is a spec-or-implementation reconciliation EPIC,
  not this one.
