# `@causl/sync` — Async-Resource Adapter Specification

**Working name:** causl-sync

**Tagline:** The seam where the synchronous engine meets the asynchronous world.

---

## 0. Where I'm coming from

I'm building the adapter that bridges the synchronous Causl engine to the world's async fetches, websocket pushes, and IndexedDB callbacks. `SPEC.md` §3 commits the core to a single GraphTime line, evaluated by a single mutation pipeline (§5), with no async anywhere on the inside; `SPEC.md` §13.6 names what this document specifies — the deferred-via-separate-adapter answer to the async-resource question. The mission of `@causl/sync` is precisely that delegation: keep the semantic core synchronous, and let one well-shaped adapter package own the place where Promises become commits.

The reason this is an adapter and not a core feature is the §5 atomicity contract. A `fetch` that returns mid-commit cannot advance time without breaking the eight-phase pipeline — Phase C advances `now` exactly once per commit, and the throw-arm restores byte-identical state across Phases B through F.6. Folding `await` into the engine body would mean either (a) suspending the pipeline mid-phase and inviting observer-visible partial states, or (b) re-entering the pipeline from a resolution callback while it was already running, which `CommitInProgressError` (#367) closes the door against. Neither was an option the team was willing to ship. The honest answer is that resolution callbacks route through `graph.commit`, the same way every other mutation does — `commit` is the only operation that advances `GraphTime`, and the adapter is the bookkeeping that makes async resolutions land on that one operation.

I'm writing this as the team's representative, the same way `SPEC.md` is written. The same brutal-critical review the engine's spec went through ran on this one. I am keeping five framing commitments that mirror `SPEC.md` §0:

1. **Resource lifecycle is a §6 sub-statechart** — the ResourceFleet orthogonal region, drawn in `docs/lifecycle.md` §1, with five states (`Idle | Loading | Loaded | Stale | Errored`) and a closed event vocabulary. I will not introduce a sixth state, and I will not introduce a parallel enum. New behaviour finds an edge or it does not ship.
2. **The stale-async race is structural, not heuristic.** `SPEC.md` §9.1 row 6 is closed by comparing `originGraphTime` against the engine clock at resolution; the `Loading → Stale` edge fires when they disagree. There is no timeout, no exponential backoff, no debounce — the guard is the GraphTime equality check, and it is total over the resolution event space.
3. **The Suspense Promise is identity-stable per loading episode.** `SPEC.md` §9.1 row 17 names this commitment; the in-flight Promise lives on `ResourceState.loading` itself, observable to every render that reads the node while the resource is in the loading arm. SuspenseList and `startTransition` see one Promise per loading episode, not one per render.
4. **Conflict is a derived view over engine state.** Per `SPEC.md` §4 the conflict registry is not a node kind — it is a role a derived node plays. The registry is a derived overlay of an application-supplied open-set computation onto a resolution Input map; there is no separate conflict store, and a conflict that closed three commits ago is reachable through the same `readAt` / `snapshotAt` surface as any other historical projection.
5. **The adapter ships nothing to core.** `@causl/core` does not import `@causl/sync`, does not know about resources, does not know about fetches, does not know about conflicts. The §7 layering rule (`SPEC.md` §7.3) holds: the engine is the bottom of the stack, and this package sits above it.

The brutal-critical review held the line on every commitment above. The team's read on the most-tempting alternative — fold the loader into a `commitAsync` primitive on `Graph` — was unanimous: the moment the engine speaks Promise, the four §3 theorems become claims-with-an-asterisk, and §5's catch arm has to be redesigned around suspension points the §3 monotonicity invariant has no name for. The adapter pays the bookkeeping so the core does not have to.

---

## 1. What `@causl/sync` is

I'm building the async-resource adapter for `@causl/core`. The package ships two primitives, both registered against the public `Graph` API, neither of which adds a new node kind to the engine's IR:

- `resource(graph, key, options)` — registers a single Input node initialised to `{ state: 'idle' }`, plus a `ResourceHandle<T>` that drives the four legal transitions out of `Idle` (`fetch-begin`, the loader's resolve and reject branches under the staleness guard, and the host-side `fail()` for the chart-named `Loading | Loaded → Errored` edges). The loader signature is `(origin: GraphTime) => Promise<T>`; the adapter does not call `fetch` directly, does not bundle a fetch implementation, and does not know about HTTP.
- `createConflictRegistry(graph, options)` — registers a Derived node whose compute overlays a resolution Input map onto an application-supplied open-set computation, plus mutators (`resolve`, `ignore`, `supersede`) that each commit one patch to the resolution Input. The registry is a derived view; `SPEC.md` §4's row "`conflict` is not a node at all — a derived view of the engine's own lifecycle" is the type-level commitment this primitive realises.

Both primitives anchor to the `SPEC.md` commitments that already named them: the `ResourceFleet` orthogonal region (`SPEC.md` §6, `docs/lifecycle.md` §1) is the chart this package implements; the `ConflictRegistry` orthogonal region is the chart the second primitive realises. The race-class catalogue (`SPEC.md` §9.1) calls out the rows this adapter closes — row 2 (reading a not-yet-loaded resource), row 6 (stale-async resolution), row 17 (Suspense fresh-Promise-per-render). The §11 inspection primitives compose through unchanged; a resource node is a `Node<ResourceState<T>>` like any other, so `subscribe`, `readAt`, `dependencies`, and the `whyUpdated` family work against it without a new surface.

The package surface is the §12.5 row that points at `packages/sync/README.md`. There are two exported functions, two error classes (`ForbiddenResourceTransitionError`, `ForbiddenConflictTransitionError`), and the type aliases the two primitives surface. Nothing else.

---

## 2. What `@causl/sync` is not

I will say no to:

- **A fetch library.** The adapter takes a loader callback and calls it. Bring your own `fetch`, your own `axios`, your own websocket client; the adapter does not import a network library and does not bundle one. The loader is the seam, not the network.
- **A query cache.** There is no request deduplication beyond the per-resource-key identity, no background refetch interval, no focus-based revalidation, no retry-on-mount. Those are TanStack Query's responsibilities; if an adopter wants them, they compose Query atop `@causl/sync`, the same way they would compose Query atop any other state primitive. Stacking a query cache into this package would relitigate `SPEC.md` §14.2.4 ("`useCauslQuery(fetcher)`, `commitMutationQueue` in core") — that fight was settled, in a different package.
- **A CRDT.** Resolution is single-writer; the registry tracks one resolution record per conflict id, and a second resolution overwrites the first under the standard `commit` ordering. Multi-writer reconciliation belongs above this layer, the same way `SPEC.md` §13.7 names it for the engine.
- **A websocket protocol.** The adapter does not specify wire formats, reconnect logic, heartbeats, or backpressure. An external Event source feeds the engine through ordinary `commit` calls (host-driven `fetch`, `invalidate`, `fail`); the protocol that produces those events is the application's, not the adapter's.
- **A persistence layer.** `@causl/persistence` ships separately and owns the load / migrate / save lifecycle. Resources registered through `@causl/sync` live in process memory by default; an adopter that wants a resource snapshot to survive a reload composes the two adapters explicitly.

The reasoning is the same one `SPEC.md` §2 spells out: the type system tells the truth or it tells nothing. A package that promises "we are also a CRDT" without the conflict-resolution discriminator to back it is going to be wrong about every concurrent write it accidentally meets. I would rather name what `@causl/sync` is *not* and let the two primitives the package does ship carry the things it *is*.

---

## 3. Semantic foundation — Resource as a Behavior fed by external Events

Conal Elliott raised this on review and he was right: if I cannot say what a `Resource<T>` *means* against the §3 vocabulary the engine already commits to, I cannot tell two implementations apart, and the staleness guard becomes a heuristic instead of a theorem. The Behavior / Event vocabulary `SPEC.md` §3 establishes is the smallest one that captures this adapter's claims; using it lets every property the package promises sit on the same denotational footing as the engine's four theorems.

So here is the meaning, on one page:

```text
Resource<T>      := Behavior (ResourceState<T>)        -- a Behavior over GraphTime
ResourceState<T> :=                                     -- discriminator is `state`, not `kind`
  | { state: 'idle' }
  | { state: 'loading';  origin: GraphTime; promise: Promise<T> }
  | { state: 'loaded';   value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'stale';    value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'errored';  error: unknown; origin: GraphTime; erroredAt: GraphTime }

resource(key, loader)        : Resource<T>             where resource(t₀) = { kind: 'idle' }
external Event source        : [(GraphTime, ResourceState<T>)]
                                  -- arrivals route through `graph.commit`
```

The `Resource<T>` Behavior is fed by an external Event source — the loader's Promise resolution, the host's `invalidate()` call, the host's `fail()` call. None of those events advance time on their own; each one routes through `graph.commit`, which is the only operation the §5 pipeline permits. Brendan Eich's read of the same vocabulary against ECMAScript Promise / AsyncIterator timing is what kept this honest on review: a Promise is an Event source whose arrival ordering is the engine's microtask queue, and every arrival becomes one commit, advancing `GraphTime` by exactly one tick the way `SPEC.md` Theorem 4 demands.

From the equation, four theorems follow:

- **Theorem 1 — Origin-bound resolution.** A `loading` resource resolves with respect to the GraphTime at which its loader was invoked (`origin`). If `origin === graph.now` at resolution, the transition is `Loading → Loaded`; otherwise `origin !== graph.now` and the transition is `Loading → Stale`. The guard is total over the GraphTime line — there is no third branch — and the comparison is structural, not heuristic. `SPEC.md` §9.1 row 6 is closed by the equality check, not by a timeout.

- **Theorem 2 — Single-pipeline mutation.** Every state transition lands through `graph.commit`. The adapter does not call `tx.set` outside a commit; the adapter does not advance `now` directly; the adapter does not bypass the eight-phase body for any reason, including the loader's resolution callback. Each of `fetch-begin`, `fetch-resolve` (under either guard branch), `fetch-reject`, `invalidate`, and `fail` produces exactly one commit and advances `GraphTime` by exactly one tick. (The `dep-changed` event class was struck by the 2026-07-06 review amendment, H4 — it never shipped as a reducer event; see §5.)

- **Theorem 3 — Promise identity stability.** For a given `(resource, origin)` pair, the in-flight `Promise<T>` is exactly one object reference for the duration of the loading episode. `useCauslSuspense` (`@causl/react` §8.2) sees the same Promise across renders; SuspenseList's coordination and `startTransition`'s deferral both rely on that identity. `SPEC.md` §9.1 row 17 is closed by carrying the Promise on the `loading` arm of the discriminated union itself, not by re-creating it on every render.

- **Theorem 4 — Behavior domain.** A resource's domain is `[registrationTime, ∞)`, the same way every other Behavior in `SPEC.md` §3 has a domain bounded below by registration. `readAt(resourceNode, t < registeredAt)` returns the `evicted` arm of `RetentionResult<T>`; the value is not reachable because the entity did not exist as a node in the graph at that moment, and the recovery breadcrumb (`oldestRetainedTime`) names the earliest GraphTime where the read would succeed. The §6 retention sub-region applies uniformly — a resource node is a Behavior, and Behaviors share one retention story.

**What the team rejected and why.** Three semantic shapes for `Resource<T>` were on the table. (a) **Resource as a separate primitive over an `AsyncBehavior` type**, distinct from `Behavior` — rejected on Elliott's framing: the §3 equation is `Behavior a := GraphTime → a`, and inventing a parallel `AsyncBehavior` type doubles the denotational page for one adapter package's convenience. The state of an in-flight fetch is *part* of the Behavior's value at GraphTime `t`, not a parallel timeline. (b) **Drop the `origin` field and re-derive it from the commit log at resolution time** — rejected because the resolution callback would have to walk `graph.commitLog` to find which commit issued the loader, and a log eviction (`SPEC.md` §6 RetentionWindow region) would make the answer `evicted` for a still-in-flight load. The `origin` lives on the `loading` arm itself precisely so the staleness guard is total over the GraphTime line, including evicted prefixes. (c) **Carry the Promise on a separate side-channel keyed by resource id, not on the `loading` arm** — rejected because the side-channel is observer-visible state outside the commit pipeline, and Theorem 2 (single-pipeline mutation) becomes a hope: a side-channel write between the `loading` commit and the resolution commit fragments the §5 atomicity contract for the loading episode. The Promise sits on the union member; that is the only place it can sit without inventing engine surface the team is not going to ship.

---

### 3.1 Theorems formalised

The four theorems above name what the adapter is willing to defend; they do not yet say what a reviewer is supposed to *check*. This sub-section closes that gap. For each theorem I write the predicate as a TypeScript signature against the actual `ResourceState<T>` discriminator the package ships (`state`, not `kind` — `packages/sync/src/resource.ts` line 98), the proof obligation the implementation must carry structurally, a counterexample fragment whose appearance in a PR falsifies the theorem, and the CI gate that holds it. The `SPEC.md` §3 theorems are formalised against the engine's own `Behavior` / `Event` vocabulary; this sub-section is the same exercise for the adapter, and the predicates reduce to the engine's predicates exactly the way the adapter reduces to `graph.commit`.

The shared imports — written once so the four sub-sections can stay focused — are the engine `Graph`, `GraphTime`, `Node<T>`, the resource `ResourceState<T>` union, and the engine's `RetentionResult<T>` discriminated union for retention reads. All four predicates are total functions over the engine's commit log; none of them mention wall-clock time, retry counts, or scheduler internals.

```ts
import type { Graph, GraphTime, Node, RetentionResult } from '@causl/core'
import type { ResourceState } from '@causl/sync'

// The five-arm DU `@causl/sync` ships, repeated for the predicates' sake.
//   `state` is the discriminator; `assertNever` polices every dispatch site.
//   (Shipped shape today lives at packages/sync/src/resource.ts line 100.)
type _RS<T> =
  | { state: 'idle' }
  | { state: 'loading';  origin: GraphTime; promise: Promise<unknown> }
  | { state: 'loaded';   value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'stale';    value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'errored';  error: unknown; origin: GraphTime; erroredAt: GraphTime }
```

#### Theorem 1 — Origin-bound resolution

**Statement.** For every loading episode `(node, origin)` whose loader resolves at GraphTime `loadedAt`, the post-resolution `ResourceState<T>` is `loaded` if and only if `origin === loadedAt`, and `stale` otherwise. The disjunction is exhaustive over the GraphTime line — the predicate is total and structural, with no third arm. This is the denotational restatement of `SPEC.md` §3 Theorem 1 (determinism) projected onto the resource sub-statechart: the post-resolution `Behavior` value is a function of `(loaderInputs, origin, graph.now-at-resolution)` and nothing else.

```ts
type ResolvedFromLoading<T> =
  | { state: 'loaded'; value: T; origin: GraphTime; loadedAt: GraphTime }
  | { state: 'stale';  value: T; origin: GraphTime; loadedAt: GraphTime }

declare function originBoundResolution<T>(
  pre:  Extract<ResourceState<T>, { state: 'loading' }>,
  post: ResolvedFromLoading<T>,
): boolean
// the predicate the property test asserts:
//   post.state === 'loaded' ↔ post.origin === post.loadedAt
//   post.state === 'stale'  ↔ post.origin <  post.loadedAt
//   (post.origin > post.loadedAt is structurally unreachable — Theorem 4
//    of SPEC.md §3 forbids retrograde GraphTime, so the third branch
//    cannot exist; the disjunction is total.)
```

**Proof obligation.** Phase A of the loading commit captures `origin = graph.now` exactly once, *before* invoking the loader callback. Phase A of the resolution commit reads `graph.now` exactly once, calls it `loadedAt`, and computes the staleness flag as `loadedAt > origin` — a single structural comparison against engine state, performed before any write is staged. The `tx.set(node, ...)` call commits the already-decided `loaded`-or-`stale` payload, with the same `origin` field carried across the episode. Anders's reading: the `loaded` and `stale` arms of `ResourceState<T>` carry the same payload shape (`value`, `origin`, `loadedAt`) precisely so the only difference between the two branches is the discriminator the predicate names; the type-level structure forces the comparison to be the entire content of the branch.

**Counterexample fragment.** Any code path that decides the staleness branch *without* reading `graph.now` at the resolution boundary, or that decides it more than once per episode and chooses based on which read won, falsifies Theorem 1. The pattern a reviewer should refuse:

```ts
// FALSIFIES THEOREM 1: the staleness flag is a function of wall-clock
// elapsed time, not of GraphTime. There exist commit interleavings under
// which `origin === graph.now` at resolution but elapsedMs > threshold,
// producing a `stale` post-state from a non-stale episode.
const elapsedMs = performance.now() - startedAt
const isStale   = elapsedMs > STALE_AFTER_MS
graph.commit(`fetch:${key}:${isStale ? 'stale' : 'loaded'}`, tx =>
  tx.set(node, isStale
    ? { state: 'stale',  value, origin, loadedAt: graph.now }
    : { state: 'loaded', value, origin, loadedAt: graph.now }))
```

The same falsification pattern appears in any draft that lets the host pass an explicit `forceStale: boolean` flag into the resolve path — the staleness branch becomes a function of caller intent rather than of GraphTime, and the predicate above no longer holds for every episode.

**Mechanical anchor.** Property test `packages/sync/test/theorems/theorem-1-origin-pinning.test.ts` (Theorem 1 fast-check property), backed by the §15-tier property file at `packages/sync/test/properties/origin-bound-resolution.property.test.ts`, which generates an arbitrary interleaving of N concurrent loaders against M unrelated commits and asserts the bi-implication on every produced `(pre, post)` pair. The CI gate is the `pnpm -F @causl/sync test:theorems` job, which fails the build on any counterexample fast-check finds. **Current state (as of v0.9.0).** The static IR companion — a `resource:origin-bound` rule that would re-assert the bi-implication from `causl-check` against an exported `CauslModel` — does *not* ship today. The Rust linter lives at `tools/checker/` (not `packages/causl-check/`), and `docs/theorem-1-static-lint-design.md` records the deferral: the resource state machine is an adapter-level construct over `IRInput`, the `origin` field is part of the application payload rather than the IR's structural shape, and the chosen path (closed via EPIC-10 / TASK 10.5, #522) is to keep the runtime property at the 1000-trial floor as the witness while the bounded enumerator's runtime evaluator (EPIC-3) takes over the static role once Schema 3 lands. The runtime witness is sufficient for the theorem today; the IR-level claim is on the shelf.

**Waiver — `stalenessGuard: false` (review 2026-07-06, M5).** Theorem 1's totality ("the guard is total over the resolution event space; no timeout, no backoff, no debounce") holds **for resources constructed with `stalenessGuard` ≠ `false`** — i.e. the default. `ResourceOptions.stalenessGuard` (§12.2) is a per-resource opt-out: set to `false`, late resolutions are treated as **authoritative (last-writer-wins)** — `resource.ts` consults the flag and, when it is off, commits `Loading → Loaded` even for an arbitrarily-stale resolution (`graph.now > loadingAt`). With the guard off, `SPEC.md` §9.1 row 6's closure is **opt-out**: the equality check that Theorem 1 quantifies over is bypassed, so the bi-implication does not hold for that resource. This is a **named, per-resource waiver of §9.1 row 6**, not a hole in the theorem: the theorem is stated over guard-on resources, and the waiver is a deliberate capability for hosts that want the newest fetched value regardless of GraphTime ordering.

#### Theorem 2 — Single-pipeline mutation

**Statement.** Every observable transition between adjacent `ResourceState<T>` values for a registered resource node is induced by exactly one `graph.commit(intent, run)` call, and the new state is the value `run` staged through `tx.set(node, next)` during Phase A of that commit. There is no transition path that bypasses the eight-phase pipeline; there is no `tx.set` invocation outside a commit; there is no parallel mutation API that advances `now` for resource events. This is the resource-side projection of `SPEC.md` §3 Theorem 3 (atomicity) and Theorem 4 (monotonicity): each event-class arrival produces zero commits if the guard refuses, or exactly one commit advancing `GraphTime` by exactly one tick if the guard admits.

```ts
type ResourceEventClass =
  | 'fetch-begin'
  | 'fetch-resolve-loaded'
  | 'fetch-resolve-stale'
  | 'fetch-reject'
  | 'invalidate'
  | 'fail'
  // 'dep-changed' struck by review amendment 2026-07-06 (H4): it never
  // shipped as a reducer event class; dependency-driven invalidation is
  // host-composed via `subscribe` + `invalidate()` (see §5).

declare function singlePipelineMutation(
  graph: Graph,
  node:  Node<ResourceState<unknown>>,
  event: ResourceEventClass,
): {
  // exactly one commit, exactly one tick — or zero of each on a refused
  // (chart-illegal) edge; never two commits for one event, never an
  // observable transition on the node without a commit attributable to it.
  commitsProduced:    0 | 1
  graphTimeAdvanceBy: 0 | 1
  observableMutation: boolean // ↔ commitsProduced === 1
}
```

**Proof obligation.** Brendan's runtime reading: every adapter mutator (`fetch`, the loader's `.then` and `.catch` arms, `invalidate`, `fail`) reaches engine state through `graph.commit` and only `graph.commit`. The adapter does not retain a `Tx` reference past the `run` callback's return; the adapter does not expose a side-channel mutation surface; the adapter's `loading` arm carries the in-flight `Promise<T>` on the union member itself (Theorem 3) so no Promise side-channel ever needs to write to engine state outside a commit. The chart-illegal edges (`Idle → Errored`, `Stale → Errored`, `Errored → Errored`) throw `ForbiddenResourceTransitionError` from inside Phase A *before* any `tx.set` is staged — Phase A's "throw short-circuits the entire pipeline" closure makes the refusal a zero-commit observation with byte-identical pre-call state, satisfying the `commitsProduced: 0` arm of the predicate.

**Counterexample fragment.** Any code path that mutates a resource's `ResourceState<T>` through anything other than a `graph.commit(...)` call, including a "fast path" that writes the loading-arm Promise into a private cache before committing the loading state, falsifies Theorem 2. The pattern a reviewer should refuse:

```ts
// FALSIFIES THEOREM 2: the in-flight Promise lives in a side cache keyed
// by node id; the loading arm of ResourceState only carries `origin`, and
// the cache is mutated outside any commit. A render that reads the node
// between the cache write and the eventual `commit` sees a `loading` arm
// with no Promise; SuspenseList's coordination collapses; Theorem 2's
// "every state transition lands through graph.commit" is false because
// the Promise-bearing state transition lands through a Map.
const inFlight = new Map<NodeId, Promise<unknown>>()
function fetchOnce(): Promise<T> {
  const promise = loader(graph.now)
  inFlight.set(node.id, promise)              // <-- side-channel mutation
  graph.commit(`fetch:${key}:start`, tx =>
    tx.set(node, { state: 'loading', origin: graph.now })) // <-- no promise!
  return promise
}
```

The symmetric falsification pattern is any draft that reaches into the engine's internal `Entry` map directly (`(graph as { _entries: Map<...> })._entries.set(...)`) to "skip the pipeline for the loading commit because we know it's safe" — the cast is the falsifier; Theorem 2 is the contract the cast violates.

**Mechanical anchor.** Two gates run in series. (1) Type fixture `packages/sync/test-d/no-tx-escape.test-d.ts` (#575) asserts via `tsd` that the adapter's public surface exposes no function whose return type contains `Tx` or any structural equivalent — the seam is sealed at the type level and a PR adding such an escape fails `tsc --noEmit` before any test runs. (2) Runtime guard `packages/sync/test/theorems/theorem-2-single-pipeline-mutation.test.ts` instruments `graph.commit` with a counter and asserts that the cardinality of resource-state transitions observed via `graph.subscribe(node, ...)` over a randomised event sequence equals the cardinality of `graph.commit` calls whose `intent` matches `/^(fetch|invalidate|fail):/` (the `dep-changed` intent arm was struck with the phantom event class, H4). The Tier-1 CI gate is the `pnpm -F @causl/sync test:theorems` job in `.github/workflows/race-detection.yml` (which also runs `causl-check` over the §9.1 fixtures per `docs/race-detection-tiers.md`). **Current state (as of v0.9.0).** The Rust linter's `resource:single-pipeline` rule (parallel to `resource:origin-bound` from Theorem 1) does *not* ship today for the same reasons recorded in `docs/theorem-1-static-lint-design.md`: the resource statechart is an adapter-level role over `IRInput`, so the IR walker does not see resource-shaped events directly. The two runtime gates (the type fixture and the property-instrumented `theorem-2-*` test) are the load-bearing witness today; the static IR layer is on the shelf pending EPIC-1 / Schema 3.

#### Theorem 3 — Promise identity stability

**Statement.** For a resource node `node` and a loading episode beginning at `origin`, the `Promise<unknown>` carried on the `loading` arm of `ResourceState<unknown>` is exactly one object reference for the entire duration of the episode. "Duration of the episode" is the contiguous interval `[t_begin, t_end]` of GraphTimes during which `graph.read(node).state === 'loading' && graph.read(node).origin === origin`; at every GraphTime in that interval, `graph.read(node).promise` is `===` to the Promise returned by the `handle.fetch()` call that initiated the episode. This closes `SPEC.md` §9.1 row 17: SuspenseList and `startTransition` rely on Promise identity holding across renders, and the only way the identity can hold is if the Promise lives on the discriminated union arm itself rather than being re-constructed per read.

```ts
declare function promiseIdentityStability<T>(
  graph: Graph,
  node:  Node<ResourceState<T>>,
  origin: GraphTime,
): boolean
// the predicate the property test asserts:
//   ∀ t1, t2 ∈ [t_begin, t_end]:
//     let s1 = graph.readAt(node, t1), s2 = graph.readAt(node, t2)
//     s1.state === 'loading' ∧ s1.origin === origin ∧
//     s2.state === 'loading' ∧ s2.origin === origin
//       ⇒ s1.promise === s2.promise
//
// Symmetrically, on episode boundary (re-fetch from Loading → Loading
// with a new origin), the new arm's `promise` is a fresh reference and
// the previous reference is unreachable from any post-boundary readAt.
```

**Proof obligation.** Conal's denotational reading: a `Behavior (ResourceState<T>)` evaluated at GraphTime `t` returns *one* value, and that value carries *one* Promise. The Promise is a field on the `loading` arm of the union — not a value cached in a closure, not a value re-created per render, not a value materialised by `derived(...)` from some upstream signal. The adapter's `fetchOnce` constructs the Promise once per episode (line 230 onward in `resource.ts`), commits it in the `tx.set(node, { state: 'loading', origin, promise })` payload, and never re-creates it for the duration of the episode. Re-fetch from `Loading` (the `(re-fetch: → Loading)` cell on the chart) starts a *new* episode with a new `origin` and a new Promise; the predicate is quantified per `(node, origin)` pair, so the re-fetch case is a different episode and the identity claim does not transit the boundary.

**Counterexample fragment.** Any code path that materialises the loading-arm Promise per read, or that wraps `graph.read(node).promise` in a fresh `Promise.resolve` adapter on every observation, falsifies Theorem 3. The pattern a reviewer should refuse:

```ts
// FALSIFIES THEOREM 3: every read produces a new Promise via the wrapper.
// `useCauslSuspense` sees a different Promise on every render; React's
// SuspenseList coordination treats each render as a new pending boundary
// and the loading episode is observably re-entered on every commit that
// happens to wake the node's subscribers. The (resource, origin) →
// promise mapping is no longer a function — it's a freshly-allocated
// Promise per call site.
function useResourcePromise<T>(node: Node<ResourceState<T>>): Promise<T> {
  const s = graph.read(node)
  if (s.state !== 'loading') throw new Error('not loading')
  return new Promise<T>((resolve, reject) => {        // <-- fresh per call
    s.promise.then(resolve, reject)
  })
}
```

The symmetric falsification pattern is any draft that stores the Promise in a `WeakMap<Node, Promise<unknown>>` *outside* the union arm and reads from the WeakMap on each observation — the WeakMap is observer-visible state outside the commit pipeline (also falsifying Theorem 2), and a WeakMap eviction between two reads in the same loading episode breaks the `===` claim.

**Mechanical anchor.** Property test `packages/sync/test/theorems/theorem-3-promise-identity-stability.test.ts` runs a fast-check generator that produces N (where N ∈ [2, 64]) `graph.read(node)` observations interleaved with M unrelated commits during a single loading episode, then asserts every pair of `loading`-arm Promises is `===`. A React-side companion test (mounted under `<SuspenseList>` against three resources) asserts that the Promises React's renderer sees across re-renders are the same object references the engine commits stored on the `loading` arms; that test lives in `packages/react/` per EPIC-10 / TASK 10.3 (#499). The type-fixture gate `packages/sync/test-d/loading-arm-shape.test-d.ts` (#575) asserts via `tsd` that `Extract<ResourceState<unknown>, { state: 'loading' }>['promise']` is reachable directly from the union and is not optional — the field cannot be elided to a side-channel without `tsc --noEmit` failing.

#### Theorem 4 — Behavior domain

**Statement.** A resource node `node` registered at GraphTime `registrationTime` has domain `[registrationTime, ∞)` on the engine's `GraphTime` line. For every `t < registrationTime`, `graph.readAt(node, t)` returns the `evicted` arm of `RetentionResult<ResourceState<T>>`, with `oldestRetainedTime: registrationTime` as the recovery breadcrumb naming the earliest GraphTime where the read succeeds. For every `t >= registrationTime` that has not fallen out of the retention window, the read returns the `retained` arm carrying the published `ResourceState<T>` value at `t`. This is the resource-side instance of `SPEC.md` §3's "every Behavior, input *and* derived, registered at GraphTime `t_r` is undefined for `t < t_r`" — a resource node *is* a Behavior, and Behaviors share one retention story.

```ts
declare function behaviorDomain<T>(
  graph: Graph,
  node:  Node<ResourceState<T>>,
  registrationTime: GraphTime,
): boolean
// the predicate the property test asserts, paraphrased against
// RetentionResult<T>'s actual two-arm shape:
//   ∀ t < registrationTime:
//     graph.readAt(node, t) matches { arm: 'evicted',
//                                     oldestRetainedTime: registrationTime }
//   ∀ t ∈ [registrationTime, ∞) ∩ retentionWindow:
//     graph.readAt(node, t) matches { arm: 'retained', value: ResourceState<T> }
//
// The disjunction is total; there is no third arm of RetentionResult<T>,
// and the predicate covers every GraphTime on the engine's clock —
// including `t = registrationTime - 1`, where the answer is `evicted`
// even though the engine clock did once equal that value, because the
// node did not exist as an entity at that moment.
```

**Proof obligation.** The resource registration path (`resource(graph, key, options)`) calls `graph.input<ResourceState<T>>(key, { state: 'idle' })` exactly once, at GraphTime `registrationTime = graph.now`. The engine's input-registration code stamps `registrationTime` on the entry's metadata as part of the same commit that publishes the `idle` initial value (`SPEC.md` #277 / #374 closed the input-and-derived branches of this gap, and the resource branch inherits the engine's `readAt` machinery without adding an adapter-specific read path). The adapter does not implement its own `readAt`; it does not synthesise a value for `t < registrationTime`; it does not paper over the `evicted` arm with an `idle` fallback. Trygve's framing applies: the model is the model. A read of the node before the node existed is `evicted`, full stop — the recovery breadcrumb is the contract, and the host UI either renders an "unknown" state or rewinds to `oldestRetainedTime`.

**Counterexample fragment.** Any code path that fabricates a `ResourceState<T>` value for `t < registrationTime` — most commonly by treating "resource not yet registered at `t`" as semantically equivalent to "resource is idle at `t`" — falsifies Theorem 4. The pattern a reviewer should refuse:

```ts
// FALSIFIES THEOREM 4: the read of a resource at a GraphTime before its
// registration synthesises an `idle` value instead of returning the
// `evicted` arm. The host UI cannot tell the difference between
// "resource was idle at t" (a domain-valid observation) and "resource
// did not exist at t" (an out-of-domain read), and the recovery
// breadcrumb (`oldestRetainedTime`) never reaches the caller.
function readResourceAt<T>(
  graph: Graph,
  node:  Node<ResourceState<T>>,
  t:     GraphTime,
): ResourceState<T> {
  const result = graph.readAt(node, t)
  if (result.arm === 'evicted') {
    return { state: 'idle' }                          // <-- fabricated
  }
  return result.value
}
```

The symmetric falsification pattern is any draft that registers the resource at `t₀` (the engine's first commit) by privileged-caller back-dating — bypassing `graph.commit` to plant the input entry as if it had existed since the beginning of time. Such a draft simultaneously falsifies Theorem 2 (the back-date is a side-channel mutation) and Theorem 4 (the domain claim now lies about when the node became a Behavior).

**Mechanical anchor.** Property test `packages/sync/test/theorems/theorem-4-behavior-domain.test.ts` (#575) asserts for a registered resource and any GraphTime `t < registrationTime` that `graph.readAt(node, t)` returns the `evicted` arm of `RetentionResult<T>`. The witness covers the headline domain claim, the symmetric retained-arm case, multi-resource fleet independence, and the absence of a privileged back-dating API. A companion file `theorem-4-graphtime-monotonicity.test.ts` rides in the same directory. The runtime guard layer is the engine's existing `readAt` implementation (`packages/core/src/readAt.ts`, the input-and-derived branches landed under #277 / #374); the adapter inherits it without override. **Current state (as of v0.9.0).** The Rust linter's `resource:domain-bounded` rule — parallel to `resource:origin-bound` from Theorem 1 — does *not* ship today; the same adapter-level-statechart-vs-IR-shape constraint from `docs/theorem-1-static-lint-design.md` applies. The property test plus the engine's inherited `readAt` machinery are the witness today; the IR-level back-dating gate is on the shelf pending Schema 3.

---

**What the formalisation buys and what it does not.** The four predicates above are total over the GraphTime line; the four counterexample fragments are concrete enough that a reviewer can spot the pattern at a PR; the four mechanical anchors are gates the CI runs on every push. What that buys is the same thing `SPEC.md` §3 buys for the engine: a way to tell two implementations apart — given the same `(loaderInputs, origin, graph.now-at-resolution)`, every implementation either agrees with the predicate or is wrong, and a PR that reaches the runtime guard gate has its bi-implication checked against `min(N_property_runs, N_static_facts)` arrivals before it merges.

What the formalisation does *not* buy is a substitute for the chart. The predicates quantify over the post-state of each transition, not over the *legality* of the transition itself; a draft that mutates the `loading` arm into a new bespoke seventh state by editing the union and threading the new tag through `assertNever` will satisfy Theorem 1 (origin-bound resolution still holds for the four arms it remains defined on), Theorem 2 (the new transition still routes through `graph.commit`), Theorem 3 (the new arm can carry its own Promise), and Theorem 4 (the registration time is unchanged) — and yet the chart in `docs/lifecycle.md` §1 has been silently widened, the §17 commitment 7 fence has been moved, and the closed event vocabulary the team committed to has acquired a row no review meeting authorised. The four predicates do not catch that. The five-arm DU itself catches it: every dispatch site polices a missing or extra arm via `assertNever`, the wire schema (`schema: 2`) is closed at two top-level `kind` constants and refuses an adapter-side third, and the `lifecycle.md` chart is the human-readable artifact a chart-edit PR has to touch alongside the code. Review still has to catch by eye that a chart edit and a code edit landed in the same PR — the predicates hold every property the chart already commits to, but they do not commit the chart. That is the gap the formalisation does not close, and the one the brutal-critical review still owes its time to.

---


## 4. Two primitives: Resource and Conflict

Anders Hejlsberg's framing from `SPEC.md` §4 lands again here: two primitives, not eleven. The adapter ships a `Resource` primitive and a `Conflict` primitive, and neither is a `NodeKind` in `@causl/core`'s IR. Per `SPEC.md` §4 the IR is closed at `'input' | 'derived'` and the wire format is `schema: 2`; both adapter primitives register through the public `Graph` API like any other consumer, and the IR exhaustiveness check stays at two arms. Trygve Reenskaug's reading on review was the load-bearing one: the model is the model. A `Resource` is a derived view over engine state — the underlying Input node carries the discriminated `ResourceState<T>` union, and the handle is the controller-shaped object that drives transitions. The engine substrate does not need a `Resource` row; the adapter supplies the role.

David Harel's framing on the same review was the structural restatement: a `Resource` is a sub-statechart, not a kind. The `ResourceFleet` orthogonal region in `docs/lifecycle.md` §1 draws five states and the closed event vocabulary that connects them; every legal transition the adapter exposes is an edge on that chart, and every illegal transition (`Idle → Errored`, `Stale → Errored`, `Errored → Errored`) throws `ForbiddenResourceTransitionError` rather than ship an enum tag whose transition is not specified by the chart. `SPEC.md` §17 commitment 7 is held structurally, not by review policy: there is no path from a host-side mutator to an off-chart write, because every path runs through a guard that consults the current state and the chart's edge set.

Mark Miller's principle of least authority lands on the conflict registry, where the boundary is sharper. The registry's read methods take `Pick<Graph, 'read' | 'subscribe'>`; the registry's mutators take `Pick<Graph, 'read' | 'commit' | 'now'>`. A caller that hands the registry a read-side handle cannot then reach `commit` through that same value — the surface is sealed at the type system, the way `SPEC.md` §7.2 names the discipline for every adapter's internal seam. The `narrowCapability` proxy from `@causl/core/internal` is the runtime gate; the `Pick` aliases (`ConflictRegistryReadGraph`, `ConflictRegistryWriteGraph`) are the compile-time gate. Both layers fail closed.

The `Resource<T>` shape is a five-arm discriminated union, because every variant carries a different payload that the statechart proves is present in that state. The team considered three shapes:

1. **Five-arm DU (the shipped shape).** `idle | loading | loaded | stale | errored`, each carrying exactly the fields the chart guarantees in that state. `loading` carries `origin` and `promise`; `loaded` carries `value` and `loadedAt`; `stale` carries the previous `value`, the original `loadedAt`, and the `staleAt` GraphTime; `errored` carries the error and `erroredAt`. The discriminator is `kind` and `assertNever` at every dispatch site catches a missing arm at compile time.
2. **Status enum + optional fields** — `{ status: 'loading' | 'loaded' | …, value?, error?, origin?, loadedAt? }`. Rejected per `SPEC.md` §9 (DU-vs-optional-fields), which catalogues five separate rediscoveries of this same lesson over an eighteen-month window. A status-plus-optionals encoding permits sixteen states, fifteen of which the design never wanted (`{ status: 'loading', value: 42, error: ... }` is a type-checkable nonsense). Codifying `Resource` as a five-arm DU prevents the sixth rediscovery.
3. **Class hierarchy** — `IdleResource extends Resource`, `LoadingResource extends Resource`, etc. Rejected because it conflates state with type identity: a resource that transitions from `Loading` to `Loaded` would have to be a *different object*, which breaks the engine's identity-stable Node contract, and `instanceof` checks make pattern-match exhaustiveness invisible to `assertNever`. The discriminated union puts the state where `tsc` can see it; the class hierarchy puts it where `tsc` cannot.

The `Conflict<T>` shape is a four-arm discriminated union, for the same reasons applied to a different domain. The team considered three shapes:

1. **Four-arm DU (the shipped shape).** `open | resolved | ignored | superseded`, each carrying the fields the conflict statechart guarantees: `open` carries the always-present `ConflictBase<T>` fields and nothing else; `resolved` carries `resolution` (opaque application tag) and `resolvedAt`; `ignored` carries `ignoredAt`; `superseded` carries `supersededBy` (the subsuming conflict id) and `supersededAt`. The discriminator is `kind` and `assertNever` polices the dispatch sites.
2. **Status enum + optional resolver** — `{ status: 'open' | 'resolved' | …, resolution?: unknown, supersededBy?: NodeId, … }`. Rejected on the same DU rediscovery grounds as the `Resource` alternative. `SPEC.md` §9 Example 1 already catalogues this exact shape for `Conflict<T>`, and the rejection has been on the books since #263.
3. **Three-arm DU collapsing `ignored` and `superseded`** — one terminal `closed` arm with a sub-discriminator. Rejected because the two terminal arms carry distinct payloads (`ignoredReason: string` vs `supersededBy: ConflictId`) and the chart-named transitions (`Open → Ignored` via `ignore`, `Open → Superseded` via `new-conflict-on-same-target`) have different sources. Collapsing the two arms requires a sub-tag, at which point the encoding is a four-arm DU with a slightly worse name.

Both primitives end up as roles played by `Input` and `Derived` nodes. A `Resource` is one Input node carrying a `ResourceState<T>` union; the handle is the controller-shaped surface that drives transitions through `graph.commit`. A `Conflict` registry is two Inputs (the resolution map keyed by conflict id) plus two Derived nodes (the application-supplied open-set compute, and the public overlay node) — the registry's mutators commit patches to the resolution Input, and the overlay derived node recomputes the public `Conflict<T>[]` stream when either dependency changes. Neither primitive teaches `@causl/core` a new node kind; both compose the existing two.

**What the team rejected and why.** Three Resource shapes were on the table; the five-arm DU is what the team picked. Three Conflict shapes were on the table; the four-arm DU is what the team picked. The pattern across both decisions is the §9 discipline made concrete: every place the adapter could have used optional fields to encode distinct states, it ships a discriminated union with a `kind` discriminator and `assertNever` at every dispatch site. Adding a sixth resource state or a fifth conflict state produces a compile error at every switch instead of a silent runtime fallback — which is the only kind of API surface the §17 commitment 7 chart-conformance discipline can be held to structurally. Two primitives, two unions, no parallel enums.

---

## 5. Commit boundary — every async event lands as one commit

The previous draft of this adapter — the one before the §3 denotational re-grounding landed — talked about resolution callbacks the way a UI library talks about effects: the loader resolves, the adapter "updates the resource state," the framework eventually re-renders. That framing leaves the commit boundary implicit, which is the same hole `SPEC.md` §5 closes for the engine. I am closing it the same way for the adapter. There is exactly one path from an async event to engine state, and that path is `graph.commit`.

The five event-class names the adapter ships are the closed vocabulary of resource-side commits. Every one of them produces exactly one commit. Every one of them advances `GraphTime` by exactly one tick. Every one of them traverses the eight-phase pipeline `SPEC.md` §5.1 names — A through H, plus the dotted suffixes F.4, F.5, F.6 — without exception, without a parallel API, without a side channel.

| Event class | Trigger | Source state | Target state |
| --- | --- | --- | --- |
| `fetch-begin` | `handle.fetch()` invoked | `Idle | Loading | Loaded | Stale | Errored` | `Loading` |
| `fetch-resolve` (Loaded) | loader resolves, `origin === graph.now` at resolution | `Loading` | `Loaded` |
| `fetch-resolve` (Stale) | loader resolves, `origin !== graph.now` at resolution | `Loading` | `Stale` |
| `fetch-reject` | loader rejects | `Loading` | `Errored` |
| `invalidate` | `handle.invalidate()` invoked | `Loaded` | `Stale` |
| `fail` | `handle.fail(error)` invoked | `Loading | Loaded` | `Errored` |

**Amendment (review 2026-07-06).** Two corrections landed here. **(H4) The `dep-changed` row is struck.** It never shipped as a reducer event class — the reducer's event union is exactly `fetch-start | fetch-resolve | fetch-reject | invalidate | fail`, and no dependency-watching machinery exists. `dep-changed` survives *only* as a `whyUpdated` lineage-classification label (§11.1), not as a state-transition event. Dependency-driven invalidation is **host-composed**, not automatic: a host that wants a resource to go `Loaded → Stale` when another node advances subscribes to that node (`graph.subscribe`) and calls `handle.invalidate()` from the observer. The adapter promises no automatic `Loaded → Stale` on dependency advance; an adopter who registered a loader that reads another node gets a permanently-fresh value until it composes the invalidation itself. **(M4) `fetch-begin` legalises `Loading` as a source state.** The shipped reducer legalises `* → Loading` via `fetch-start` (`statechart-reducers.ts`), so calling `fetch()` mid-flight is allowed and starts a new, overlapping episode — the source-state column now includes `Loading` (it previously omitted it). The overlapping-episode semantics are specified below.

Five rows; the chart in `docs/lifecycle.md` §1 has one edge per row out of the non-terminal states; every cell on the chart is in this table. The `fetch-resolve` row is split across two guard branches because the staleness guard is what distinguishes the two transitions structurally — the loader's `then` arm runs the same code in both branches up to the GraphTime comparison, and the comparison is the entire content of the `Loading → Stale` versus `Loading → Loaded` edge. There is no third branch.

**Overlapping loading episodes (review 2026-07-06, M4 — normative).** Because `fetch()` is legal from `Loading`, a second `fetch()` issued while a first episode is still in flight starts a **second** episode with a fresh `origin`, a fresh in-flight `Promise`, and a fresh `loadingAt`, and the resource's `state` remains `Loading` (now against the second episode). The adapter is **last-writer-wins** across episodes, and the interleaving is: the *first* loader's later resolution runs the staleness guard against its own `loadingAt`, finds `graph.now > loadingAt` (the second `fetch-begin` commit advanced the clock), and therefore commits as **`stale`** carrying the *first* episode's value — overwriting the second episode's `loading` arm, including the second episode's in-flight `Promise`. An adopter relying on Theorem 3's Promise-identity stability for the second episode must be aware that a straggling first-episode resolution can replace the second episode's `loading` arm before the second loader resolves. Hosts that need strict de-duplication (one in-flight load per key, coalescing concurrent `fetch()` calls onto the same Promise) must compose that above the adapter; the adapter itself does not dedupe.

Walk one event end-to-end to see the eight phases at work. The host calls `handle.fetch()` while the resource is `Idle`. The adapter captures `origin = graph.now` *before* invoking the loader, constructs the loader's `Promise<T>`, wraps it in the Suspense-safe `.then(() => undefined, () => undefined)` shape that carries identity without producing an unhandled rejection, and then calls `graph.commit('fetch:${key}:start', tx => tx.set(node, { state: 'loading', origin, promise }))`. That `commit` call is the entry into the engine pipeline. **Phase A** runs the staged write callback and collects the `loading`-tagged value into the transient writes map. **Phase B** publishes the write onto the resource's Input node. **Phase C** advances `now` by exactly one tick — the same Theorem 4 invariant every commit pays. **Phase C.5** stamps `lastWriteTime` on the resource's Input cell. **Phase D** walks the dependents of the resource node and recomputes any derivation that reads it (a Suspense-bound selector, an open-set compute that watches the resource's tag for a `loading` arm to register a "load-in-progress" conflict). **Phase E** assembles the immutable `Commit` record carrying `intent: 'fetch:${key}:start'`. **Phases F, F.4, F.5, F.6** append history, refresh `commitLog`, recompute commit-metadata deriveds, and retain the per-commit input snapshot. **Phase G** fires the resource node's per-node subscribers; **Phase H** fires the commit-level subscribers. The host's `await handle.fetch()` returns the loader's still-unresolved Promise; control yields back to the event loop.

The loader resolves. The adapter's `.then` arm runs in a microtask. It reads `graph.now` — call this `loadedAt` — and compares it against the `loadingAt` GraphTime captured immediately after the `loading` commit returned. If `loadedAt === loadingAt`, no other commit has advanced `now` while the Promise was awaiting; the resolution is authoritative for `origin` and the adapter calls `graph.commit('fetch:${key}:loaded', tx => tx.set(node, { state: 'loaded', value, origin, loadedAt }))`. If `loadedAt > loadingAt`, the equality fails; the adapter calls `graph.commit('fetch:${key}:stale', tx => tx.set(node, { state: 'stale', value, origin, loadedAt }))`. Either way the commit is the same eight-phase pipeline; the two intent strings are the only difference outside the published `ResourceState<T>` payload.

This is where the staleness guard's location becomes a design question worth recording. Three options were on the table; the team rejected two and shipped one.

1. **Inside the loader's `await` chain — rejected.** The first sketch placed the `loadedAt > loadingAt` comparison in the adapter code that wraps the loader, *before* calling `graph.commit`. The adapter would resolve the Promise, decide which intent to commit, and then call `commit` with the already-decided tag. Rejected on Brendan Eich's read of the microtask scheduler: the comparison itself is structural (it lives on the GraphTime line `SPEC.md` §3 commits to), but the *decision* it drives is engine-state-dependent — `graph.now` is read between two ticks, and another microtask can interleave between the read and the `commit` call. A second `fetch-resolve` for a different resource that lands in the microtask queue ahead of this one would advance `now` between the read of `graph.now` and the dispatch to `commit`, and the resource would be marked `loaded` against a `now` value that already moved. The guard would be heuristic, not total. Theorem 1's "the comparison is structural, not heuristic" phrasing is precisely what this option violates.
2. **On the Phase B / C boundary — rejected.** The second sketch placed the comparison in the engine itself: a hook called between Phase B (publish input writes) and Phase C (advance clock) that the adapter could install to inspect the staged write and rewrite its tag if a staleness condition was detected. Rejected on Sebastian Markbåge's reading of the commit-cost ripples: every commit pays the cost of evaluating the hook, even on the 99% of commits that are not resource-side. The headline cost-of-commit ("a commit producing N derived recomputations runs in O(N)" — `SPEC.md` §14) acquires a per-commit overhead proportional to the number of installed hooks. Worse, the hook would have to mutate the staged write, which is exactly the partial-state problem Phase A's "throw short-circuits the entire pipeline" closure is meant to eliminate; rewriting a staged write between B and C invents a fractional time the catch-arm rollback cannot describe.
3. **Inside Phase A on the host-supplied event before Phase B writes — what shipped.** The adapter computes the staleness decision in the loader's `.then` arm, *before* the `commit` call, and commits the decided tag in the standard one-shot pattern. The Phase A callback `tx => tx.set(node, decidedState)` carries a fully-formed `ResourceState<T>` payload; Phase B publishes it; Phase C advances `now`; the rest of the pipeline runs identically to any other commit. The microtask interleaving Brendan flagged in option (a) is closed by Theorem 4's domain commitment: the comparison reads `graph.now` once, and any other commit that lands before this one's `commit` call will be reflected in the `graph.now` *that very read returns*. The decision is then deterministic against the engine's own clock — the staleness branch is taken on the GraphTime the read observed, not on a stale snapshot of it. The staleness guard becomes a property of which `now` the read saw, which is the only honest property a guard can hold against a moving clock.

`ForbiddenResourceTransitionError` is the §17 commitment 7 fence around the chart-illegal edges. The adapter's `fail()` mutator reads the resource's current state in Phase A — before any write is staged — and throws the typed error if the source state is anything other than `loading` or `loaded`. The throw escapes `run`, which short-circuits the eight-phase pipeline at Phase A. Nothing has been published; nothing in B through F.6 has executed. After the throw propagates to the caller, the engine state is byte-identical to the pre-call moment, exactly the way `SPEC.md` §5.2 names. The `try` envelope around Phases B through F.6 never engages because Phase A never completed; the catch arm's "restore byte-identical state" is structural here in the trivial sense that there was nothing staged to roll back. The error itself carries the `from` state and the `to: 'errored'` target, so the host UI can route the failure into an operator-facing message — the chart is a contract with the user, not just with the engine.

Conal Elliott's reading of the §3 origin-bound resolution theorem is the load-bearing reason the staleness comparison shipped where it did. The theorem is "a `loading` resource resolves with respect to the GraphTime at which its loader was invoked"; the comparison that closes the theorem is `origin === graph.now`. Putting the comparison inside the engine pipeline (option b) breaks the theorem by making the resolution condition a function of *the pipeline's progress through Phase B*, not of the GraphTime at which the loader was invoked. Putting the comparison outside the pipeline in the loader's adapter wrapper (option c) keeps the theorem honest because the read of `graph.now` is the only operation that observes the engine clock, and that read is what the theorem's predicate is *quantified over*. Brendan's microtask reading and Sebastian's commit-cost reading converged on the same answer from two different directions.

**What the team rejected and why.** Three options for the staleness-guard location, and the one that shipped is the one where the comparison lives outside the engine pipeline but reads `graph.now` exactly once, before the `commit` call. Two parallel rejections walked alongside it: first, an out-of-band cancellation API (`handle.cancel()`) that would let the host abort an in-flight fetch and produce no state change at all — rejected because "no state change at all" is not an edge in the chart, and shipping a mutator with no chart edge violates §17 commitment 7; the host that wants cancellation calls `fail()` and the resource lands in `Errored` with a chart-named edge. Second, a `commitMaybeStale` privileged-caller variant that would let the adapter pass the staleness flag into a single fused commit instead of computing it in the `.then` arm — rejected because the fusion was vestigial: the `.then` arm has to read `graph.now` to compute the flag, and once it has read `graph.now` it can call the public `commit` exactly the same way every other caller does. Adding a parallel API for the convenience of one branch was the same mistake `SPEC.md` §5.3 closed for `hydrate`. The single pipeline holds.

---

## 6. Composite statechart — ResourceFleet and ConflictRegistry

The previous draft of this adapter modelled "resource state" and "conflict status" as two enums hanging off the resource and conflict types, with no transition rules drawn anywhere. The statechart was implicit; the relationships between transitions were left to the implementer's good intentions; the chart was — to borrow David Harel's framing from the engine review — *a wishlist of states, not a system*. The composite chart is the response. `SPEC.md` §6 anchors three orthogonal regions implemented today; this adapter owns two of them, and the third (Engine) is `@causl/core`'s. The chart itself lives in `docs/lifecycle.md`. SPEC.async anchors the chart; SPEC.async does not duplicate the diagram. Duplicating it across two files is exactly the drift `lifecycle.md`'s reason-to-exist closes.

### 6.1 ResourceFleet — five states, five event classes

The ResourceFleet orthogonal region carries one sub-statechart definition, instantiated per registered resource. Five states: `Idle`, `Loading`, `Loaded`, `Stale`, `Errored`. The complete edge set is the cross-product of this state-by-event-class matrix (the `dep-changed` column was struck by the 2026-07-06 review amendment, H4 — see §5):

| State \ Event | `fetch-begin` | `fetch-resolve(Loaded)` | `fetch-resolve(Stale)` | `fetch-reject` | `invalidate` | `fail` |
| --- | --- | --- | --- | --- | --- | --- |
| **Idle** | → Loading | — | — | — | — | throw |
| **Loading** | (re-fetch: → Loading) | → Loaded | → Stale | → Errored | — | → Errored |
| **Loaded** | → Loading | — | — | — | → Stale | → Errored |
| **Stale** | → Loading | — | — | — | — | throw |
| **Errored** | → Loading | — | — | — | — | throw |

Every dash is a non-edge: the chart has no transition under that event from that state, and the adapter's runtime guard refuses the call rather than ship an off-chart write. Every `throw` is a `ForbiddenResourceTransitionError` with the `from` and `to` populated. The three throw cells (`Idle → Errored`, `Stale → Errored`, `Errored → Errored`) are the §17 commitment 7 fence the type-checked code in `resource.ts` enforces structurally. The `(re-fetch: → Loading)` cell is the same edge as the `Idle → Loading` transition under `fetch-begin`; calling `fetch()` on a resource that is already loading abandons the previous loading episode and starts a new one, with a new `origin`, a new in-flight Promise, and a new identity for Theorem 3 to be quantified over. The previous episode's resolution still routes through the staleness guard against the new `origin`; the guard fires and the previous loader's resolution lands as `stale`, never as `loaded`. The chart promises that a resource has at most one in-flight episode at any GraphTime, and the re-fetch edge is what makes that promise compositional.

The reason the region is *fleet*, not *single resource*, is that multiple concurrent resources share the chart definition but each resource is a separate Input node carrying its own `ResourceState<T>`. The chart is one diagram, instantiated per resource, the same way `SPEC.md` §6 names it. The fleet is the set of running instances; the chart is the rule each instance follows. Three options for the chart granularity were considered.

1. **One chart per resource id — rejected.** Each registered resource would own its own chart, drawn separately in documentation, with its own event vocabulary. Rejected on Sandi Metz's framing of closed event vocabularies: the moment the chart is per-id, the event vocabulary is per-id, and a sixth event class can sneak into one resource without adding a row to the global table. Five rediscoveries of the optional-fields-vs-DU lesson (`SPEC.md` §9, Examples 1–5) is the team's evidence that vocabulary fragmentation is the failure mode this discipline closes; per-id charts re-open it.
2. **One chart for the fleet with per-resource state — what shipped.** One definition; per-resource instantiation. The state of resource `A` is `loaded`; the state of resource `B` is `loading`; both are positions on the same chart. Adding a sixth state requires editing one diagram, not N; adding a seventh event class requires adding one row to the table above, not N copies of it. The per-resource Input node is the storage; the chart is the rule.
3. **One chart per `(resource id, episode id)` pair — rejected.** Each loading episode gets its own chart instance, with a fresh `Idle → Loading → ...` traversal per episode. Rejected because the fresh-per-episode framing reintroduces the very identity problem Theorem 3 closes: the Promise lives on the `loading` arm of the resource's `ResourceState<T>` for the duration of the episode, and re-creating the chart instance on each episode would mean re-creating the Promise carrier; SuspenseList's coordination depends on the Promise identity holding across renders, and an episode-scoped chart is at least as identity-stable as that, but the bookkeeping overhead is N times the shipped option for no observable property gain. The chart-by-episode view is recoverable from the chart-by-resource-with-`origin`-on-`loading` view by reading the `origin` field; the converse requires extra storage. Harel's framing of charts-by-construction is what lets option (b) carry option (c)'s observable properties without paying option (c)'s storage cost.

### 6.2 ConflictRegistry — four states, three terminal arms

The ConflictRegistry orthogonal region is one sub-statechart per conflict id observed by the registry's open-set compute. Four states: `Open`, `Resolved`, `Ignored`, `Superseded`. Only `Open` has outgoing edges; the other three are terminal. The complete edge set:

| State \ Trigger | `resolve` | `ignore` | `supersede` | `new-conflict-on-same-target` |
| --- | --- | --- | --- | --- |
| **Open** | → Resolved | → Ignored | → Superseded | → Superseded |
| **Resolved** | throw | throw | throw | (no-op; conflict is closed) |
| **Ignored** | throw | throw | throw | (no-op) |
| **Superseded** | throw | throw | throw | (no-op) |

`ForbiddenConflictTransitionError` is the runtime guard that fires on every throw cell. The error carries `from`, `to`, and the conflict id; the `from` field admits a synthetic `'unknown'` value for the case where the registry has never observed the id at all (the `currentKindOf` helper in `conflict.ts` returns `'unknown'` when the id is in neither the resolution Input map nor the live open set). The synthetic tag is the closest honest report against the four-state chart; the chart has no `'unknown'` state because the four states are reachable lifecycle positions, and an id the registry has never seen has no lifecycle position to be in. Operator-facing UIs branch on `from === 'unknown'` to distinguish "id has never been observed" from "id is in a terminal state," which are different things even though both reject the mutation.

The two `→ Superseded` edges out of `Open` look like one edge with two triggers, but they are the same edge: `supersede` is the host-driven mutator that fires when an application registers a subsuming conflict explicitly, and `new-conflict-on-same-target` is the adapter-internal trigger that fires when the open-set compute emits a conflict whose `target` matches an already-open one. Both produce the same `kind: 'superseded'` resolution record; both carry the `supersededBy` field naming the subsuming conflict id. The chart treats them as one edge with two callers, the way `SPEC.md` §6 treats `Loading → Errored` as one edge with two callers (`fetch-reject` from the loader's rejection, `fail` from the host).

**Engine region — owned by `@causl/core`, composed-with by this adapter.** The third orthogonal region in the composite chart is the Engine region (eight phases, `Idle | Committing`, the named sub-states A through H). The adapter does not draw it and does not implement it; the adapter composes with it. Every transition this adapter ships routes through `graph.commit`, which means every transition is a `Committing` traversal in the Engine region's frame of reference. The composition is structural: the ResourceFleet region's `Loading → Loaded` edge is, *in the composite chart*, the conjunction of "the resource's per-instance chart traversed `Loading → Loaded`" and "the engine's region traversed `Idle → Committing → Idle`." The two regions are orthogonal because the engine's progress through its eight phases does not constrain which resource-side edge is firing; the resource's edge does not constrain which Engine sub-state the pipeline is in. Harel's chart-by-construction framing is the load-bearing reason the orthogonality is honest: the regions compose because their state spaces are independent, and the adapter's job is to keep them independent by routing every adapter-side transition through the one engine-side mutation API.

**What the team rejected and why.** The chart-granularity question (the three options above) was the load-bearing one; the shipped option is one chart per region, instantiated per resource or per conflict. Two parallel rejections walked alongside: first, drawing the ConflictRegistry chart with five states (one per resolution record kind plus `Unknown`) — rejected because `Unknown` is not a lifecycle position, it is the absence of one, and the synthetic tag on the error class is the right place for it (the type system carries the four-state DU; the error class carries the five-tag report including the synthetic). Second, collapsing the two `Open → Superseded` triggers into a single chart edge labelled with both names — rejected because the two triggers have different sources (host-driven and adapter-internal) and the chart's audit trail benefits from naming both; the trigger column in the table above is what lets a reviewer searching for "where does `new-conflict-on-same-target` route" find the chart edge in one read.

The chart is the rule, not the documentation. Sandi Metz's framing of closed event vocabularies is the discipline that makes the rule mechanically enforceable: the type-level set of event classes is the union of the columns in the two tables above, and adding an event without adding a column is a missing case in the runtime guard, which fails the `assertNever` arm at the dispatch site.

---

## 7. Layering — capability narrowing for the registry

`SPEC.md` §7 commits the engine to a model / controller / engine separation enforced by package layout, ESLint inversion gate, and capability narrowing. This adapter ships under the same discipline. Trygve Reenskaug's framing on review of the engine spec — *the model is the model* — applies here verbatim: a `ResourceHandle<T>` is a controller-shaped surface that drives transitions on an underlying Input node; the Input node and its `ResourceState<T>` payload are the model. The package layout enforces the layering at the import graph; the capability-narrowing types enforce it at the function signature; the runtime proxy enforces it at the call site. Three layers of enforcement, none of which fail open.

### 7.1 The `ResourceHandle<T>` controller / Input model split

The `resource(graph, key, options)` factory returns a `ResourceHandle<T>` whose `.node` field is the underlying `Node<ResourceState<T>>`. The handle is the controller; the node is the model. The split is consequential. Application code that wants to read the resource's state — a Suspense selector, a `useCausl(g => g.read(node))` consumer, an `assertNever`-policed `switch` over the five `state` arms — operates on the node, never on the handle; the node is what the engine substrate stores and what subscriptions and `readAt` and the inspection primitives compose against. Application code that wants to *drive* the resource — `fetch()`, `invalidate()`, `fail()` — operates on the handle, never on the node; the handle is what the chart's edges hang off, and every method on the handle terminates in exactly one `graph.commit(...)` call. The two types do not mix. A consumer that holds the node cannot drive the resource; a consumer that holds the handle but not the node has no read door. Reenskaug's "the model is the model" reading is what makes the split structural — the controller's surface is a different type from the model's surface, and the type system is what enforces the separation of concerns.

The same pattern lands for `ConflictRegistry<T>`. The `node: DerivedNode<readonly Conflict<T>[]>` field is the model: the public derived view that subscribers wake on, that `read` returns a stream from, that `readAt` reaches into for historical projections. The mutators (`resolve`, `ignore`, `supersede`) are the controller: each one terminates in one `graph.commit(...)` against the underlying resolution Input node. Application code reads through the node and writes through the mutators; the two surfaces are the two halves of the controller / model split applied to a derived-view primitive.

### 7.2 Capability narrowing — `Pick<Graph, ...>` is a security primitive

Mark Miller's principle of least authority lands on the conflict registry's mutators with the sharpest edge in this adapter. The reason is structural: the registry is constructed once with a full `Graph` (because `createConflictRegistry` legitimately needs `input` and `derived` to register the three engine objects the registry stores), but the *methods* the registry exposes need a much smaller authority. The read methods need `read` and `subscribe`; the write methods need `read`, `commit`, and `now`. Handing a full `Graph` to either is precisely the §7.2 failure shape Miller's framing closes: *authority is what you can call, not what you know about*, and a method whose parameter type is the full `Graph` has handed its caller every method on the engine for the convenience of the three the method actually invokes.

The adapter ships two capability slices, both as `Pick<Graph, ...>` aliases declared at `@causl/sync`'s public surface:

```ts
export type ConflictRegistryReadGraph  = Pick<Graph, 'read' | 'subscribe'>
export type ConflictRegistryWriteGraph = Pick<Graph, 'read' | 'commit' | 'now'>
```

The read slice is the smallest set of methods `read` and `subscribe` need to invoke: `read` calls `g.read(node)`; `subscribe` calls `g.subscribe(node, observer)`. Nothing else. The write slice is the smallest set the three mutators need: each one reads the resolution Input map (to enforce the Open-only guard), commits a single-tick patch, and stamps the GraphTime via `now`. Nothing else. The capability split is enforced by `tsc`: a mutator implementation that tries to call `g.input(...)` or `g.derived(...)` fails to compile against the `ConflictRegistryWriteGraph` signature, and the failure surfaces on the line that called the disallowed method. A read-side consumer that holds a method reference to `registry.read` and tries to widen back to `Graph` to reach `commit` fails at the cast site; the narrowing is not assignable upward without an explicit `as Graph` that names the violation in the source. The `*.narrowCapability.test.ts` suite asserts both directions — a `ConflictRegistryReadGraph` does not satisfy `ConflictRegistryWriteGraph`, and neither widens to `Graph` without the cast.

The runtime gate sits underneath. `narrowCapability(graph, allowedMethods)` from `@causl/core/internal` is the proxy `SPEC.md` §7.2 names; the registry's call sites pass the proxy where the type is `ConflictRegistryReadGraph` or `ConflictRegistryWriteGraph`, and a caller who managed to circumvent the type narrowing — `(narrowed as Graph).commit(...)` — meets a runtime `CapabilityViolation` instead of a successful call. The two layers are deliberate: the type narrowing catches the honest mistake at compile time, and the runtime proxy catches the dishonest reach by failing closed. Both layers are "belt-and-braces" the way `SPEC.md` §7.2 names the discipline; this adapter does not invent a new mechanism, it composes the engine's existing one.

### 7.3 Package layering — `@causl/sync` imports `@causl/core`, never the inverse

The package layout enforces the directional invariant. `@causl/sync` imports `@causl/core`'s public surface (`Graph`, `Node`, `InputNode`, `NodeId`, `GraphTime`, the `Compute` and `DerivedNode` types) and `@causl/core/internal` for `assertNever` and `narrowCapability`. `@causl/core` does *not* import `@causl/sync` and does *not* know about resources, fetches, conflicts, or the registry. The §7.3 ESLint inversion gate is what makes this structural: the `no-restricted-imports` rule lists `@causl/sync` in the disallowed-imports group for files under `packages/core/`, and the rule's error message names this section ("SPEC.async §7 / SPEC §17.3") so a developer who hits the rule has the rationale one click away.

The deep-path gate enforces the same discipline at finer grain. `@causl/sync` reaches `@causl/core/internal` only — the documented entrypoint — never `@causl/core/dist/*` or `@causl/core/src/*`. The `exports` field in `@causl/core/package.json` refuses to resolve such paths at runtime; the lint rule codifies the same contract at the import-line level. A future bundler change or tsconfig drift cannot silently re-open the back door because both gates fail the build before the import resolves.

### 7.4 Three options for the registry's API shape

The capability split shipped on the registry's mutators is not the obvious shape; the team considered three before settling.

1. **One `Graph` parameter on every method — rejected.** The first sketch had every registry method take a full `Graph` argument: `registry.read(graph)`, `registry.resolve(graph, id, resolution)`, etc. The argument simplifies the implementation (no parameter-type bookkeeping; the implementation reaches whichever method it needs without ceremony) but hands every caller the entire mutation pipeline for the convenience of the two or three methods the implementation invokes. Rejected on Miller's framing: the read methods do not need `commit`, and the write methods do not need `input` or `derived`; shipping a parameter type that admits both is the §7.2 failure shape made the default. The registry's surface would become an unrestricted authority over the engine, and the §17.4 commitment to layering would hold by review policy alone.
2. **Two parameter overloads for read-only and writable — what shipped.** The parameter type narrows per-method to the `Pick<Graph, ...>` slice the method actually needs. `Graph` is assignable to either slice, so existing call sites that pass a full engine handle keep compiling; what is now blocked is the §7.2-failure shape of "controller-shaped state leaks into the model layer." A read-side consumer holding a reference to `registry.read` cannot reach `commit` through the parameter; a write-side consumer holding a reference to `registry.resolve` cannot reach `derived` or `hydrate`. The capability split is enforced at the type system rather than at review.
3. **Capability tokens passed at construction — rejected.** A third sketch had `createConflictRegistry` accept two tokens (a `ReadToken` and a `WriteToken`) at construction, each sealed against forgery, and the methods would consume the appropriate token to authorise the operation. Rejected on the ergonomic cost: the token bookkeeping is one extra concept the application has to thread through its dependency-injection surface, and the gain over the `Pick<Graph, ...>` shape is structurally zero — both shapes prevent the same misuses, but the token approach requires the application to manage the token lifecycle, which is one more place for the layering to drift. The narrowed-parameter shape is the lowest-ceremony version of the same property.

The team picked option 2. The capability split lives on the function signature, not on a parallel auth system, and the `Graph` value the application holds keeps its existing identity through the entire registry lifecycle. Sebastian Markbåge's reading on the same review was the layering perf benefit: the narrowed types do not change the runtime cost of the registry's methods at all (the proxy is constructed once at the call site if `narrowCapability` is invoked, and the methods themselves run identical code regardless of which slice the parameter has), and the compile-time cost is the part that pays for the safety. The performance budget the engine commits to in `SPEC.md` §14 is not affected; the type budget the spec commits to in §7.2 is reinforced.

**What the team rejected and why.** Three API shapes for the registry; the narrowed `Pick<Graph, ...>` parameter shape is what shipped. Three parallel rejections walked alongside: first, exposing `narrowCapability` itself as a public method on the registry — rejected because applications should not be in the business of narrowing capabilities directly (the same reason `SPEC.md` §7.4 keeps `narrowCapability` `@causl/core/internal`-only); the registry supplies the narrowed slices on its method signatures, and the application does not reach for the proxy. Second, declaring `ResourceHandle<T>` with a similarly narrowed parameter on each mutator — rejected because the handle is constructed once with a full `Graph` and the methods are closures over that handle, not parameterised by it; the layering invariant for `ResourceHandle<T>` is enforced by the constructor capturing the `Graph` and exposing only the controller-shaped surface, with the underlying `Node<ResourceState<T>>` reachable only through the handle's `.node` field for read-side composition. Third, a generic `narrowedRegistry()` helper that would derive the read and write slices from the registry's method signatures by type-level introspection — rejected because the explicit `ConflictRegistryReadGraph` and `ConflictRegistryWriteGraph` aliases are documentation as well as types, and the explicit names are what the `*.narrowCapability.test.ts` suite asserts against. Naming the slices is what makes them auditable; deriving them by introspection is what makes them disappear.

---

## 8. React/MVU surface — useCauslSuspense and the dispatch shape

`SPEC.md` §8 commits `@causl/react` to a canonical MVU pair (`useCausl` for the read door, `useDispatch` for the write door) plus an extension surface that handles React-specific concerns the canonical pair does not name. This adapter does not ship React hooks itself — the hooks live in `@causl/react`, which imports `@causl/sync` for the resource and conflict primitives. What this section commits to is the *shape* the hooks compose against: the `ResourceState<T>` discriminated union the Suspense hook narrows, the `ResourceHandle<T>` surface the dispatch hook ergonomics ride on top of, and the `<Hydrate>` boundary that re-issues a `fetch` against a freshly-hydrated resource node. The §8 framing is Evan Czaplicki's; the adapter's job is to keep the canonical pair working when the leaf primitives are async.

### 8.1 The Suspense surface — `useCauslSuspense(resource)`

`useCauslSuspense` is the canonical Suspense projection for resources. The implementation lives at `packages/react/src/useCauslSuspense.ts`; the contract it implements is the five-arm narrowing the chart authorises:

- `state: 'loading'` → throw the in-flight Promise carried on the state. Identity-stable per loading episode (Theorem 3 of this spec; row 17 of `SPEC.md` §9.1).
- `state: 'loaded'` → return `value`.
- `state: 'stale'` → return cached `value`. Suspending here would make a stale-but-renderable resource un-renderable for the duration of the next fetch, which is precisely the ergonomic the staleness arm exists to avoid.
- `state: 'errored'` → throw `error`. The Error Boundary catches it; the renderer's contract is that throwing a non-Promise is the error path.
- `state: 'idle'` → throw a Promise that resolves on the next graph commit. The Suspense contract is "suspend, not error" for an unrendered resource; the adapter's job is to surface a Promise that holds the renderer until the host issues a `fetch()` and the resource leaves `idle`. The Promise identity is stable per graph for the duration of the `idle` state.

The Promise on the `loading` arm is identity-stable across renders for the same loading episode. This is Theorem 3 made operational: SuspenseList's coordination depends on Promise identity, `startTransition`'s deferral depends on Promise identity, and the in-flight Promise lives on the `ResourceState.loading` arm of the discriminated union, not on a side channel keyed by resource id. Every render that reads the resource node while it is in the `loading` arm sees the same Promise reference; the reference remains stable until the loader's resolution commits a new state (`loaded`, `stale`, or `errored`) onto the Input node. Dan Abramov's reading on the engine review was the load-bearing one: Suspense's semantics are *the renderer awaits the thrown Promise and re-renders when it resolves*, and the renderer's re-render is the point at which a fresh selector read returns the post-loading state. A fresh-Promise-per-render shape — one of the §9.1 row-17 failure modes — would defeat SuspenseList because each render hands SuspenseList a different Promise to coordinate against, and the coordination collapses into "every render is a separate suspension." Carrying the Promise on the union member is the only place it can sit without inventing engine surface the team is not going to ship.

### 8.2 The non-Suspense surface — `useCausl(g => g.read(resourceNode))`

Suspense is opt-in. The default surface for resources is the same `useCausl(selector)` hook the canonical MVU pair commits to: the selector returns the full `ResourceState<T>` discriminated union, and consumers `switch (state.state)` over the five arms with `assertNever` at the default. The discriminator is `state` — *not* `kind`, despite the prose conventions of `SPEC.md` §9 calling out `kind` as the canonical discriminator across the engine's typed unions. The actual implementation in `packages/sync/src/resource.ts` uses `state` as the discriminator name; this adapter is internally consistent with the code that ships, and the inconsistency with the §9 convention is one the team accepted on review because the resource code-base predates the §9 convention's hardening and the migration cost across the existing test fixtures, the `@causl/react` Suspense hook, and the application call sites was greater than the consistency benefit. `Conflict<T>` uses `kind` as documented in §4 of this spec and §9 Example 1 of the engine spec; the two unions have different discriminator names because of the historical sequencing, and the spec records the inconsistency rather than papering over it.

The five-arm `switch` is the canonical consumer pattern. A renderer that wants to handle the `idle` state with a "click to load" button, the `loading` state with a spinner, the `loaded` state with the value, the `stale` state with the cached value plus a refresh affordance, and the `errored` state with an error message writes one `switch (state.state)` and `assertNever` at the default. The §9.1 row-2 commitment — "reading a not-yet-loaded resource" caught at compile time — is what the discriminated union plus `assertNever` realises: a renderer that forgets to handle the `loading` arm fails the exhaustiveness check and never ships. The non-Suspense path is the surface every adopter who is not yet on React 18's Suspense-everywhere story writes against; the adapter does not force the choice.

### 8.3 The dispatch surface — `useDispatch(handle)` and the registry mutators

The MVU pair's write door is `useDispatch`. For resources, the canonical shape mirrors `SPEC.md` §8.1's pair: the hook returns a referentially-stable object exposing the controller methods, with each method internally calling exactly one `graph.commit(...)`.

```ts
const { fetch, invalidate, fail } = useDispatch(userResource)
// fetch:      () => Promise<T>
// invalidate: () => void
// fail:       (error: unknown) => void
```

The returned object is memoised against the handle identity on the surrounding `<CauslProvider>`; descendants that depend on the dispatch identity (effect deps, memoised handlers) do not churn every render. This is the same referential-stability commitment `useDispatch<Msg>()` ships for the message-typed canonical surface; the resource-typed variant is the same shape applied to a controller-shaped handle instead of a message-typed dispatch. The hook does not invent a new dispatch primitive; it composes the controller surface the resource handle already exposes.

The conflict registry's mutators follow the same shape. `useDispatch(registry)` returns `{ resolve, ignore, supersede }` — a referentially-stable object whose three methods correspond to the three legal transitions out of `Open`. Each method takes the same arguments the underlying registry mutator does (with the engine handle threaded through the hook's closure, so the call site does not name `graph`), and each method terminates in exactly one `graph.commit(...)`. The capability narrowing the registry enforces at the type level (§7 above) is preserved through the hook: the hook closes over a `ConflictRegistryWriteGraph`, and the methods it exposes do not leak a wider authority. The `ForbiddenConflictTransitionError` the registry throws on a chart-illegal call surfaces through the dispatch method the same way it would from a direct call; the hook is a thin stable wrapper, not a transformation.

Tanner Linsley's TanStack Query precedent is the comparison the team weighed and recorded. Query's `useMutation({ mutationFn })` pattern returns a mutate function plus a status object; the status object is what the renderer reads to know the mutation's progress. This adapter does not ship a status object — the resource's status *is* the `ResourceState<T>` on the node, readable through the same `useCausl` hook the renderer is already using — but the dispatch shape is otherwise compatible: the mutate function corresponds to `fetch()`, the status corresponds to the `state` discriminator, and the renderer composes both through the canonical pair. The composition is what `SPEC.md` §2 names: this adapter is not a query cache, but it is a primitive that composes correctly with one, and the dispatch shape is the seam.

### 8.4 The `<Hydrate>` boundary

`<Hydrate snapshot={snap}>` is the SSR boundary `SPEC.md` §8.2 names. On mount, the boundary calls `graph.hydrate(snap)` before any descendant subscribes; the hydrate routes through the same `commitInternal` body `commit` does, advancing `now` by exactly one tick and publishing the snapshot's input values onto the live graph. Resources hydrate via this same mechanism: a resource node registered with the host is an Input node like any other, and its `ResourceState<T>` payload is part of the snapshot. After hydrate, the resource's state is whatever the snapshot recorded — `idle` if the server never fetched it, `loaded` with a server-fetched `value` and `loadedAt` if the server did.

The host has two clean stories for what to do post-hydrate. The first: re-issue `fetch` unconditionally on the client, treating the snapshot as a render-blocking SSR optimisation that lets the first paint show real data while a fresh fetch confirms the value is current. The second: read the `loadedAt` GraphTime off the resource and decide on the client whether the server's fetch is fresh enough to skip the re-fetch. Both stories compose against the existing surface — the client reads `useCausl(g => g.read(node))`, switches on the `state` discriminator, and either renders directly (story 2) or calls `dispatch.fetch()` from a `useEffect` (story 1). The adapter does not pick; the host does. The chart-named `Loaded → Loading` edge is what the re-fetch uses; the adapter does not invent a new edge for the post-hydrate case.

### 8.5 Three options for the loading-state ergonomics

The default surface (non-Suspense) plus the opt-in Suspense hook is not the obvious shape; the team considered three before settling.

1. **Implicit Suspense everywhere — rejected.** `useCausl(g => g.read(resourceNode))` would itself throw the Promise on the `loading` arm, and the renderer would suspend on every read of an in-flight resource without an explicit Suspense opt-in. Rejected because adopters need non-Suspense paths for React 18 fallback: not every application is on Suspense, and an application that uses the resource primitive purely for its discriminated-union ergonomics (rendering an `idle` placeholder, a `loading` spinner, etc., in the renderer's normal control flow) should not be forced into a `<Suspense>` boundary. Implicit Suspense would also break the canonical-pair commitment from `SPEC.md` §8: `useCausl` is meant to be the single read door, and an implementation that throws a Promise from inside `useCausl` is a different contract than the one the canonical pair commits to. The opt-in shape preserves the canonical pair and adds the Suspense projection alongside.
2. **Opt-in Suspense via `useCauslSuspense` with the non-Suspense default — what shipped.** The renderer that wants Suspense semantics imports `useCauslSuspense` and wraps the read site in a `<Suspense>` boundary; the renderer that does not import the Suspense hook gets the full discriminated union from `useCausl` and writes the `switch` directly. Two surfaces, two import paths, no global flag. Adopters who want Suspense for some resources and not others (a common pattern: Suspense for above-the-fold resources, normal control flow for below-the-fold ones) get both behaviours from the same provider with no per-resource configuration.
3. **Global Suspense mode flag on the provider — rejected.** A `<CauslProvider suspense={true}>` flag would switch every `useCausl` read on a resource into Suspense semantics, and the adopter would set the flag once at the top of the tree. Rejected because reactivity changes from one provider to another break testability: a component that works in a test harness with the flag off and breaks in production with the flag on is the failure mode this option creates by default. Worse, a provider-level flag couples the renderer's behaviour to a piece of context state, and the §8.1 commitment that the canonical pair is a *behaviour*, not a configuration, is what the per-import-path opt-in preserves.

The team picked option 2. `useCauslSuspense` is the explicit Suspense surface; `useCausl` is the explicit non-Suspense surface; both compose against the same `ResourceState<T>` discriminated union without coordination at the provider level. Dan Abramov's reading on review was the deciding one: Suspense's semantics are most legible when the *call site* opts in, because the call site is where the thrown-Promise contract is observable, and a global flag hides the contract one level above where the renderer reads it. Sebastian Markbåge's reading on render-cost converged: the non-Suspense path's render-cost is the same as any other `useCausl` read (a `useSyncExternalStore` subscription plus the selector evaluation), and the Suspense path's render-cost is the additional Promise throw on the `loading` and `idle` arms — neither path subsidises the other, and the adopter's choice of which to use is a choice about ergonomics, not about cost.

**What the team rejected and why.** Three options for the loading-state ergonomics, and the shipped option preserves the canonical pair while adding the Suspense projection as opt-in. Two parallel rejections walked alongside: first, exposing `useDispatch` with a message-typed surface that wraps the resource's controller methods into a `Msg` union (`{ kind: 'fetch' } | { kind: 'invalidate' } | { kind: 'fail', error: unknown }`) — rejected because the wrap-into-Msg shape would force the resource consumer through the message-typed dispatcher, and the resource's controller methods are already typed and named at the handle surface; the wrap is vestigial. Adopters who *want* a message-typed wrapper for their own application's dispatch loop write one with `defineMsgs` and route to the handle's methods from inside `createUpdate` — the canonical pair composes; the adapter does not pre-empt the composition. Second, a `useResource(handle)` hook that combined the read door and the write door into a single hook returning `[state, { fetch, invalidate, fail }]` — rejected because conflating the two doors is the same mistake `SPEC.md` §8 closes for the canonical pair; the read door is `useCausl`, the write door is `useDispatch`, and the resource adapter follows the same split. The hook count stays low; the doors stay separate. The MVU shape holds.

---

## 9. Make impossible states impossible

The §9 discipline that anchors `SPEC.md` lands in this adapter twice: once for `ResourceState<T>` and once for `Conflict<T>`. Anders Hejlsberg's exhaustiveness-via-`never` framing — paired with Sandi Metz's reading that the design must make the wrong call fail at the type system, not at code review — is the rule both unions answer to. A struct with optional fields encodes one nonsense state per optional; an in-flight resource with a `value` defined and an `error` defined is a lie the compiler should refuse, and `SPEC.md` §9's catalogue of five rediscoveries (#263, #370, #379, #388, #405) is the empirical evidence for *why* the rule has to be structural.

Two unions ship from `@causl/sync`, both keyed on a discriminator that no second arm shares:

- **`ResourceState<T>`** — five arms, discriminator `state` (one of `'idle' | 'loading' | 'loaded' | 'stale' | 'errored'`). The discriminator field name is `state`, not `kind`, deliberate against the precedent of `Conflict<T>` for one reason: the resource union's tag is the state-machine state, and the field name pulls the chart's vocabulary into the type. A reader who narrows on `r.state === 'loaded'` is reading the chart's "Loaded" position back; the field name carries the §6 commitment into the type system, where Harel's framing wants it.
- **`Conflict<T>`** — four arms, discriminator `kind` (one of `'open' | 'resolved' | 'ignored' | 'superseded'`). The discriminator name is `kind` because the precedent set by `SPEC.md` §9 Example 1 is `kind`, the registry's resolution-record discriminator is `kind`, and the §9 catalogue's other DUs (`PersistenceError`, `DevtoolsMessage`, `FormulaError`) are all keyed on `kind`. Two adjacent unions in the same package using two different discriminator names is intentional surface friction — it keeps the per-domain narrowing visually distinct at every call site, and the `*.test-d.ts` exhaustiveness fixtures fail loudly if a refactor accidentally homogenises one to the other.

Both unions carry the §9 commitment all the way to the dispatch sites. The conflict overlay's switch in `createConflictRegistry` (the loop body in `packages/sync/src/conflict.ts` that maps each `ResolutionRecord` arm to a public `Conflict<T>` arm) ends in `return assertNever(r, 'unhandled ResolutionRecord kind')` — adding a fifth resolution-record arm without updating that switch is a compile error at the `assertNever` call site, the same shape `SPEC.md` §9 names. The resource-side dispatch sites that the adapter does *not* own (host code that switches on `r.state`) are policed by the `*.test-d.ts` fixtures shipped alongside the adapter: `resource.test-d.ts` carries an exhaustiveness probe over all five `ResourceState<T>` arms, and `conflict.test-d.ts` carries the four-arm probe for `Conflict<T>`. Both fixtures are written so that adding a sixth `ResourceState<T>` arm or a fifth `Conflict<T>` arm produces a `tsc --noEmit` error in CI before any consumer notices.

The compile-time DU is one half of the §9 dual; the runtime guard is the other half. Two error classes ship from this package as the runtime gate for transitions the chart does not specify:

- **`ForbiddenResourceTransitionError`** — thrown by `ResourceHandle.fail` when the source state is not one the chart names as a legal predecessor for `Errored`. The chart (`SPEC.md` §6 / `docs/lifecycle.md` §1) draws exactly two edges into `Errored`: `Loading → Errored` (`fetch-reject`) and `Loaded → Errored` (host-side `invalidate(error)` / `fail()`). A `fail()` from `Idle`, `Stale`, or `Errored` is a write the chart does not specify, so the mutator throws rather than ship an off-chart enum tag. The error carries the resource's id, the source state tag (one of all five so the diagnostic does not lie about which arm the call hit), and the target tag (`'errored'`).
- **`ForbiddenConflictTransitionError`** — thrown by every `ConflictRegistry` mutator (`resolve`, `ignore`, `supersede`) when the targeted conflict id is not in the `open` arm. The chart draws exactly three edges out of `Open` and zero edges out of any of the three terminal arms; a second resolution after a first is a write the chart does not specify. The error carries the conflict id, the source `kind` (or the synthetic `'unknown'` sentinel for ids the registry has never observed — the chart has no "unknown" position, but the diagnostic has to tell the truth about the registry's view), and the target `kind`.

The dual is what `SPEC.md` §9 calls the type-plus-runtime commitment. The DU prevents the impossible *value*; the typed throw prevents the impossible *transition*. A union arm that nobody can construct, paired with a transition nobody can fire, is the §17 commitment 7 chart-conformance discipline made structural rather than reviewer-policed.

### 9.1 Race-class catalogue — what `@causl/sync` closes

The `SPEC.md` §9.1 catalogue is seventeen rows long. This adapter closes four of them and inherits the closure of one more from `@causl/core`. It also introduces two adapter-specific race classes that the catalogue does not yet name; both are caught by the same compile-time / runtime / property-test layering the engine's catalogue uses, and the rows below are written in the same chart-anchored format Harel asked for on the original §9.1 review.

| # | Race class | Scenario | Mechanism that catches it | Layer |
| --- | --- | --- | --- | --- |
| 2 | Reading a not-yet-loaded resource value | A consumer reads `.value` on a resource that has never been fetched, or whose fetch is still in flight, and the type permits the access. | The `idle` and `loading` arms of `ResourceState<T>` carry no `value` field. A consumer that has not narrowed on `state === 'loaded'` (or `'stale'`, the other arm that carries `value`) cannot reach for `.value` — `tsc` rejects the read. | **Compile-time** (DU shape) |
| 6 | Stale-async resolution | A `loading` resource's loader resolves *after* a later commit has advanced GraphTime past the `origin` the load was issued at; without a guard, the late value would overwrite a now-authoritative state. | At Phase A of the resolve commit, `fetchOnce` reads `graph.now` (call it `loadedAt`) and compares against the GraphTime captured at the loading commit (`loadingAt`). If `loadedAt > loadingAt`, the transition is `Loading → Stale`; otherwise `Loading → Loaded`. The check is structural and total — there is no third branch. | **Runtime guard** (GraphTime equality, no timeout) |
| 17 | Suspense fresh-Promise-per-render | A renderer that throws a fresh `Promise` per render breaks SuspenseList's coordination and `startTransition`'s deferral, because every render presents a new identity to the renderer's pending-Promise table. | The in-flight Promise is constructed once per loading episode, in `fetchOnce` *before* the loading commit, and stored on the `loading` arm itself (`{ state: 'loading', origin, promise }`). Every render that reads the node during the loading episode receives the same Promise reference. | **API design** (DU member carries identity) |
| 1 | Concurrent engine mutations | A loader resolution callback re-enters the commit pipeline while a commit is already running. | Inherited from `@causl/core` Phase A: `CommitInProgressError` is the gate. The adapter does *not* re-implement this guard — the resolve / reject branches route through `graph.commit`, and `commit` is the operation that throws if a commit is already in flight. | **Inherited from core** (Phase A) |

Two adapter-specific race classes the engine's catalogue does not yet name:

| # | Race class | Scenario | Mechanism that catches it | Layer |
| --- | --- | --- | --- | --- |
| S-1 | Abandon-then-resume | A resource is fetched, the host calls `invalidate()` (driving `Loading → Stale` was *not* the chart's `invalidate` edge — `invalidate` only drives `Loaded → Stale`; this scenario is the variant where the host calls `fail()` mid-load to abandon the fetch, then re-issues `fetch()` before the first loader's Promise has settled). The first loader's late resolution would otherwise commit a value the host has already abandoned. | The staleness guard from row 6 covers this case structurally: the second `fetch()` advances GraphTime, so when the first loader's Promise resolves, `loadedAt > loadingAt` of the *first* episode and the transition is `Loading → Stale`. The `fail()` call in between also advances GraphTime and parks the resource in `errored`, after which a second `fetch()` issues a new `origin` that the first loader's resolution can never match. The first loader's late settle lands as a stale write that the second loader's clean resolution overwrites; the resulting commit log records both events truthfully. | **Runtime guard** (GraphTime monotonicity) |
| S-2 | Open-set drift mid-resolution | A `ConflictRegistry` carries a conflict in the `open` arm; the host invokes `resolve(graph, id, payload)`; between the registry's read of the open set (during the guard's `requireOpen`) and the resolution-Input commit, the application-supplied open-set compute would emit a different set if it were re-evaluated. | The guard reads through `graph.read(openSet)` and the patch commits through `graph.commit` on the same `ConflictRegistryWriteGraph` slice, both observing the same GraphTime. The §5 atomicity contract closes the window: between the guard read and the patch commit the engine cannot advance time, so the open-set compute cannot have re-emitted. The patch lands at GraphTime `now+1`, and any subsequent open-set re-emission is a downstream Phase D recomputation against the post-patch resolution map — i.e. the public `Conflict<T>[]` overlay reflects the resolved arm, not a phantom open arm. | **API design** (single GraphTime per guard-and-patch pair, inherited from §5) |

For each row, the layer column names where the catch lands relative to `SPEC.md` §9.1's vocabulary: **compile-time** (the DU shape rejects the call), **runtime guard** (a typed throw or a structural equality check at a named pipeline phase), **API design** (the surface does not admit the wrong call), **inherited from core** (the catch is a `@causl/core` mechanism the adapter does not re-implement). The two adapter-specific rows above are added to the catalogue on the same PR that ships this section, per the §9.1 discipline that every new public surface item arrives in the table or it does not ship.

### 9.1.1 Adapter race rows formalised (S-series) and engine cross-references

The two prose rows the team-§9-12 agent introduced — S-1 abandon-then-resume and S-2 open-set drift mid-resolution — sit downstream of two different chart regions and answer to two different §17 commitments. Writing them in the same chart-anchored format Harel asked for on the original `SPEC.md` §9.1 review is what makes them auditable; writing them in the same layer vocabulary `SPEC.md` §16's static-IR linter uses for its coverage map is what lets `causl-check` know whether to claim them in its coverage column. The two contributions land as one table addition with formal columns, plus an audit-extension pass against the rest of the adapter's surface, plus a cross-reference back to the seventeen engine rows.

Hejlsberg's framing is that a row in this table earns its slot by naming the type-system mechanism that refuses the wrong call before runtime; Metz's framing is that a row earns it by naming the closed event vocabulary the chart admits and the position of the violating call in that vocabulary; Harel's framing is that a row earns it by naming the chart edge that fires and the chart edge that does *not* fire.

#### S-1 abandon-then-resume

| # | Race name | Scenario | Source state(s) | Layer | §6 chart edge / property test / runtime guard | §17 commitment closed |
| --- | --- | --- | --- | --- | --- | --- |
| S-1 | Abandon-then-resume | Host issues `fetch()`, then `fail()` mid-load, then a second `fetch()` before the first loader's Promise has settled. | `Loading` (first episode) crossing into `Errored` via host `fail()`, then `Errored → Loading` via second `fetch-begin`. | **RUNTIME-ONLY** (composed from row 6's structural staleness guard plus chart-by-construction `Errored → Loading` re-entry) | Late settle: `Loading → Stale` from the first loader's resolution against the second episode's `origin`. The `Loading → Loaded` edge does not fire. Property test `packages/sync/test/properties/race-row-S-1.property.test.ts` enrols the abandon-then-resume sequence (alongside `lifecycle-exhaustiveness.property.test.ts`, the chart-conformance witness); runtime guard `ForbiddenResourceTransitionError` from `Errored → Errored` does not fire (`fetch-begin` from `Errored` is a chart-legal edge). | Adapter §17 commitment 7 — closed structurally because the trajectory traverses only chart-named edges. |

The team's reading on S-1: the row exists because the failure mode it names is a *composition* of three chart edges with a Promise-settlement event sandwiched between two of them. Hejlsberg's framing carries it: the type-system enforcement is the §9 dual, and the dual covers the composition because every edge in the trajectory is the same `ResourceState<T>` discriminator's transition.

#### S-2 open-set drift mid-resolution

| # | Race name | Scenario | Source state(s) | Layer | §6 chart edge / property test / runtime guard | §17 commitment closed |
| --- | --- | --- | --- | --- | --- | --- |
| S-2 | Open-set drift mid-resolution | A `ConflictRegistry` carries a conflict in the `open` arm; the host invokes `resolve(graph, id, payload)`; between the registry's `requireOpen` guard read and the resolution-Input commit, the application-supplied open-set compute would emit a different set if it were re-evaluated mid-call. | `Open` arm of `Conflict<T>` for the targeted id. | **API design** (single GraphTime per guard-and-patch pair, inherited from `SPEC.md` §5's atomicity contract); **STATIC** for the IR-level shape; **RUNTIME-ONLY** for the negative case (`narrowCapability` proxy fails closed with `CapabilityViolation`). | `Open → Resolved` (chart-legal). The `narrowCapability` proxy is the runtime gate; the §5 atomicity contract holding both reads inside the same Phase A pre-flight is the structural gate. Property test `conflict-registry-drift.property.test.ts` enrols the drift-mid-resolution sequence. | Adapter §17 commitments 3 and 7. |

The team's reading on S-2: the row exists because the failure mode it names is *not* observable from inside `commit`'s eight phases — it is a failure mode that lives at the seam between the host's open-set compute and the registry's resolution Input map. The §5 atomicity contract closes the seam structurally.

#### S-3 dispatch-shape leak across capability narrowing

The audit promotes one further row from the §7 capability discussion into a formal §9.1 entry.

| # | Race name | Scenario | Source state(s) | Layer | §6 chart edge / property test / runtime guard | §17 commitment closed |
| --- | --- | --- | --- | --- | --- | --- |
| S-3 | Dispatch-shape leak across capability narrowing | A consumer holds a `ConflictRegistryWriteGraph` slice obtained through a hook's closure, casts it back to `Graph` via `as Graph`, and reaches `input` or `derived` to register a node outside the registry's authority. | `Open` arm with leaked authority pointed at a different region's storage. | **STATIC** (TS-level `Pick<Graph, ...>` rejects the upcast); **RUNTIME-ONLY** for the dishonest reach (`narrowCapability` proxy throws `CapabilityViolation`). | None — S-3 is not a chart-edge race; it is an authority race. Runtime witness `packages/sync/test/conflictRegistry.narrowCapability.test.ts` exercises a synthetic consumer holding a leaked slice. **Current state (as of v0.9.0).** A property-based witness is not yet authored; the row is tracked under #566 (per `docs/race-class-audit.md`'s "Important divergence notice"). | Adapter §17 commitments 3 and 9. |

The team's reading on S-3: Miller's principle of least authority is not a *race* in the row-1 sense; it is an *authority* race in the sense that a leaked slice's `commit` racing with the registry's own `commit` would produce two writes against the same Phase A pre-flight. The runtime gate is the same `CommitInProgressError` that closes row 1, but the *reason* the leak even reaches the `commit` site is the capability narrowing's type system, and the gate at the type system is what S-3 names.

The team did not find further candidates beyond S-3. The reasoning, walked region by region:

- **The 5-arm `ResourceState<T>`.** Every transition is row 6, row 17, S-1, or a chart-legal edge with no race.
- **The 4-arm `Conflict<T>`.** Every transition is S-2, S-3, or a chart-legal `Open → {Resolved | Ignored | Superseded}` edge.
- **The 7 event classes from §5.** Closed vocabulary; every event class is covered.
- **The 4 ConflictRegistry mutators.** Covered by S-2, S-3, and the chart-legal edges.
- **The Suspense path (§8).** Row 17 covers Promise-identity stability; the rest is React's responsibility.
- **The Hydrate boundary (§8.4).** Engine rows 12, 13, 14 cover the boundary.

#### Cross-reference with SPEC.md §9.1

| Engine row | Engine race class | Adapter contribution | Layer |
| --- | --- | --- | --- |
| 1 | Concurrent engine mutations | Inherited verbatim — resolve/reject branches route through `graph.commit`. | Inherited from core (Phase A). |
| 2 | Reading a not-yet-loaded resource value | Adapter-owned — 5-arm `ResourceState<T>` DU. | STATIC. |
| 5 | Diamond glitches | Engine-side; adapter composes via Input nodes. | — |
| 6 | Stale-async resolution | Adapter-owned — `loadedAt > loadingAt` GraphTime comparison. | RUNTIME-ONLY. |
| 7 | Dynamic-dependency cleanup | Adapter participates indirectly — §10.4 dispose-mid-load. | Pre-deploy fuzz. |
| 9 | Two app-level Msgs producing inconsistent state | Adapter participates indirectly via §8.3 dispatch shape. | Application-side. |
| 11 | Use-after-dispose on a family-keyed node | Engine-side; adapter inherits `NodeDisposedError`. | Inherited from core. |
| 12 | Hydration mismatch | Engine-side; adapter's `<Hydrate>` calls `graph.hydrate`. | Inherited from core. |
| 13 | Hydration emitted but subscribers don't wake | Engine-side; same Phase A–H pipeline. | Inherited from core. |
| 14 | Non-monotonic GraphTime on hydrate | Engine-side; adapter's GraphTime fields ride on the commitment. | Inherited from core. |
| 17 | Suspense fresh-Promise-per-render | Adapter-owned — Promise lives on `ResourceState.loading`. | API design. |

Of the seventeen engine rows, the adapter contributes mechanism to four (rows 2, 6, 7, 17), inherits closure on five (rows 1, 11, 12, 13, 14), participates indirectly in two (rows 5, 9), and the remaining six are entirely engine-side. The adapter then adds three rows of its own (S-1, S-2, S-3). The combined catalogue is twenty rows.

#### What this audit found and what it did not

The audit found two formalised rows (S-1, S-2) whose prose was already in the team-§9-12 agent's draft and one promotion (S-3) of a row the team had treated as covered by the §7 capability discussion alone. The audit did not find a fourth or fifth adapter-specific race class. The team's reasoning is the closure-by-construction discipline Harel asked for on the original §9.1 review: the 5-arm `ResourceState<T>`, the 4-arm `Conflict<T>`, the seven §5 event classes, the four ConflictRegistry mutators, the Suspense narrowing surface, and the Hydrate boundary together close the adapter's surface. If a future trigger surfaces a fourth adapter-specific race class, the row arrives in this table on the same PR that ships its public-surface mechanism. Today the count is twenty (seventeen engine + three adapter). The team is satisfied that the count is current; the team is unwilling to claim it is final.


### 9.4 Forbidden transition catalogue

The chart-anchored catalogue of transitions the runtime guards refuse. For each row, the source state, the target state, the trigger, and the reason the chart does not draw the edge.

**ResourceFleet — transitions `ForbiddenResourceTransitionError` refuses:**

| Source | Target | Trigger | Why the chart refuses it |
| --- | --- | --- | --- |
| `idle` | `errored` | `fail(error)` | The chart draws no edge from `Idle` into `Errored`. A resource that has never been fetched has no `origin` to pin the failure to; the `errored` arm requires `origin` and `erroredAt`, and `Idle` does not carry an `origin`. The honest path is `Idle → Loading → Errored`, which the host triggers by calling `fetch()` and letting the loader reject (or by issuing `fetch()` and then `fail()` from the `loading` arm). |
| `stale` | `errored` | `fail(error)` | The chart draws no edge from `Stale` into `Errored`. A `Stale` resource has a previous `value` it is honest about; failing it would discard a still-readable value and replace it with an error that does not correspond to a fresh load attempt. The host that wants to "give up on" a stale resource invokes `fetch()` and lets the loader fail, which routes through the chart-legal `Loading → Errored` edge. |
| `errored` | `errored` | `fail(error)` | The chart treats `Errored` as a terminal-until-refetched state. A second `fail()` on an already-`errored` resource is either a redundant write (the resource is already errored with a different error) or an attempt to overwrite the recorded error with a newer one. The chart-legal path for "now there's a different error" is `fetch()` → `Loading → Errored` with the new loader rejection. |
| `loading` | `errored` (host) | `fail(error)` | *Not* refused — this is the chart-legal `Loading → Errored` edge driven from the host side. Listed here for completeness against the `Loading → Errored` triggered by the loader's own rejection branch in `fetchOnce`. The two triggers (host `fail()` vs. loader rejection) hit the same edge; the diagnostic distinguishes them by the commit's `intent` label (`fail:${key}` vs. `fetch:${key}:error`). |
| `loaded` | `errored` (host) | `fail(error)` | *Not* refused — the chart-legal `Loaded → Errored` edge, triggered when the host learns of a server-side error for an already-loaded resource through an out-of-band channel (websocket push, devtools intervention). Listed for symmetry with the `loading` row. |

The two non-refused rows are catalogued because the §9.4 promise is a complete enumeration, not just the negative half. A reader who consults this table to ask *"can I call `fail()` from `loaded`?"* should find the answer ("yes, this is the chart-legal `Loaded → Errored` edge") in the same place as the negative answer.

**`invalidate` off-chart sources — a third refusal shape (review 2026-07-06, M4).** The catalogue above enumerates the transitions `ForbiddenResourceTransitionError` refuses by *throwing*. `invalidate()` uses a **different** refusal shape and must be catalogued so the two are not conflated. `handle.invalidate()` is chart-legal only from `Loaded` (→ `Stale`); called from any **non-`Loaded`** state (`Idle`, `Loading`, `Stale`, `Errored`) the shipped adapter is a **silent no-op** — the reducer returns `next === state`, and `applyEvent` skips the commit entirely (`packages/sync/src/resource.ts`). This is a *third, chart-sanctioned* refusal shape alongside the typed throw and the non-edge dash: **no-op-by-reducer-equality**. It is distinct from the §9.4 option (a) "silent no-op on illegal transitions" that the team rejected — that rejection is about *mutators that should surface a chart violation to the caller* (e.g. registry `resolve()` on a terminal conflict). `invalidate` from a non-`Loaded` state is not an off-chart *write* the host needs signalled; it is a request whose precondition ("there is a loaded value to mark stale") is unmet, and the reducer-equality no-op is the honest shape for "nothing to invalidate." A host that needs to distinguish "invalidated" from "no-op" reads the resource `state` before/after or inspects the returned commit's presence. (If a future revision wants `invalidate` to *throw* from non-`Loaded` states instead, that is the alternative the review flagged; the shipped behaviour is the no-op documented here.)

**ConflictRegistry — transitions `ForbiddenConflictTransitionError` refuses:**

| Source | Target | Trigger | Why the chart refuses it |
| --- | --- | --- | --- |
| `resolved` | `open` | (no mutator exists) | The chart draws no edge out of `Resolved`. A "re-open" mutator would be a `Resolved → Open` write the chart does not specify; the package ships no such mutator, and the absence is structural rather than policy. |
| `ignored` | `open` | (no mutator exists) | Same shape: `Ignored` is terminal, no edge leaves it, no mutator exists. |
| `superseded` | `open` | (no mutator exists) | Same shape: `Superseded` is terminal, no edge leaves it, no mutator exists. |
| `resolved` | `ignored` | `ignore(graph, id)` | The chart draws no `Resolved → Ignored` edge — a resolved conflict is not "downgradeable" to ignored. The `requireOpen` guard refuses the call; the diagnostic reports `from: 'resolved'`, `to: 'ignored'`. |
| `resolved` | `resolved` | `resolve(graph, id, payload)` | A second `resolve` on an already-resolved conflict is the §9 single-writer discipline at work: the chart does not re-enter `Resolved` from `Resolved`, and the registry refuses rather than silently overwrite the first resolution's `resolution` payload. |
| `ignored` | `resolved` | `resolve(graph, id, payload)` | Same shape: the chart names no `Ignored → Resolved` edge, and a host that wants the conflict resolved-after-ignored has to re-raise it (the application-supplied open-set compute is the only path that can put the conflict back into the `open` arm with a fresh id). |
| `superseded` | `resolved` / `ignored` | any mutator | The chart names `Superseded` as terminal; the conflict's resolution lives on the *superseding* conflict, not the superseded one. A mutator on the superseded id is refused. |
| `unknown` | any | any mutator | The synthetic `'unknown'` source — an id the registry has never observed — is refused. The diagnostic reports `from: 'unknown'`, which adapter UIs distinguish from a terminal-state refusal to route the operator-facing message correctly ("registry has never seen this id" vs. "id is in a terminal state"). |

Three options were on the table for the runtime-guard shape. The team picked option (b) — typed throw with diagnostic context — and the reasoning is the failure modes of the alternatives:

- **(a) Silent no-op on illegal transitions.** Rejected because a `resolve()` call that silently does nothing is the failure mode `SPEC.md` §17 commitment 7 forbids by name: the host has no way to distinguish "the registry accepted my resolution" from "the registry rejected my resolution". A devtools panel showing a stale `open` conflict after the operator pressed "resolve" three times is the user-facing manifestation; reviewer-policing it after the fact is the discipline §9 was authored to obviate.
- **(b) Typed throw with diagnostic context (what shipped).** The throw surfaces the chart-shape violation at the call site, named (`ForbiddenResourceTransitionError`, `ForbiddenConflictTransitionError`), and instrumented with the metadata an adapter UI needs to route the failure (id, source state/kind, target state/kind, prose message naming the chart-legal edges). The error class extends `Error` and carries an explicit `name` field set in the prototype, so a `try { ... } catch (e) { if (e instanceof ForbiddenConflictTransitionError) ... }` discriminates correctly even after a `structuredClone` round-trip into a worker.
- **(c) `console.warn`-and-continue.** Rejected because `console.warn` is observability that depends on the host environment having a console, the host having configured the warn channel to fail loudly in CI, and nobody having muted the channel for unrelated noise. The §17 commitment 7 chart-conformance discipline cannot be held on top of an observability layer that the application may have silenced. A typed throw is structural; a `console.warn` is hope.

Trygve Reenskaug's read on review pinned the choice: a model-layer rule that the controller can violate is not a model-layer rule. The throw is the only shape that keeps the chart enforceable from the model side, and the runtime guard is the only place the adapter can catch a host that calls a mutator the chart does not draw an edge for.

### 9.5 What the team rejected

Three §9-shaped temptations sat on the table during this adapter's design and were declined for reasons the team has since cited at every adapter review.

- **A single seven-arm union folding `ResourceState<T>` and `Conflict<T>` into one.** The framing was that "both unions are sub-statecharts of the composite lifecycle, so one DU per lifecycle is the natural surface." Rejected because the discriminator's role is to make the *narrow* call obvious at the read site, and a seven-arm union forces every consumer to handle arms from a region they did not opt into. A consumer that subscribes to a `ResourceHandle.node` does not want to narrow on `'open' | 'resolved' | ...`; a consumer that subscribes to a `ConflictRegistry.node` does not want to narrow on `'idle' | 'loading' | ...`. Two unions, two narrowing surfaces, two `assertNever` probes, two `*.test-d.ts` fixtures — the cost is two fewer rediscoveries of the §9 lesson per adapter package.
- **An `assertNever`-free dispatch using a record-of-handlers map.** The framing was that `{ idle: ..., loading: ..., loaded: ..., stale: ..., errored: ... }` enforces exhaustiveness via the record's key set. Rejected because the record approach catches *missing keys* but not *extra keys* (an arm that no longer exists in the union still has a handler), and because a record with a function value per arm allocates one closure per arm per dispatch — the §3 micro-cost the engine charges for every `subscribe` and `read` is the budget the team will not spend on a stylistic alternative. `switch` + `assertNever` produces zero runtime allocations beyond the local discriminant read; the record approach produces five.
- **A `Result<T, E>` shape for the resource's loaded value carrying the error inline.** The framing was that `ResourceState<T> = { state: 'idle' } | ... | { state: 'settled'; result: Result<T, E> }` collapses `loaded`, `stale`, and `errored` into one settled arm. Rejected because the chart names *five* states for a reason: a `Stale` resource is observably different from a `Loaded` one (the consumer that displays "stale, reloading…" against a still-rendered previous value), and the difference is the chart edge (`Loaded → Stale` via `invalidate` or via the staleness guard) the §6 region depends on. Collapsing the three settled arms into one `Result`-carrying arm makes the chart unimplementable without re-introducing a discriminator on the `Result` — at which point the encoding is a five-arm DU with a worse name.
- **A timeout-based staleness guard layered on top of the GraphTime check.** The framing was that the GraphTime equality check catches most of row 6 but a "wall-clock timeout" would catch the long-tail case where a loader hangs forever without any later commit firing. Rejected because the `SPEC.md` §3 semantic equation does not mention wall-clock time, and a guard that depends on `Date.now()` is observably non-deterministic — two replays of the same commit log against the same loader would diverge on whether the staleness guard fired. The chart-legal path for a hung loader is the host-driven `fail()` call (`Loading → Errored`), driven by whatever wall-clock policy the application chooses; that decision belongs above the adapter, the same way `SPEC.md` §13.7 names multi-writer reconciliation as belonging above the engine.
- **A "soft-fail" mutator that demotes `Loaded` to `Idle` rather than `Errored`.** The framing was that some applications want to clear a stale-or-errored resource without preserving an error tag. Rejected because the chart has no `Loaded → Idle` edge, no `Errored → Idle` edge, and inventing one would re-open the §17 commitment 7 question the chart was authored to close. The honest path for "I want this resource cleared" is to dispose the handle and re-register the resource at the same key; the engine's input-replacement behaviour resets the `state` to the `Idle` arm at registration time, and the host has gained no observable surface the chart did not already permit.

---

## 10. Worked example — the acceptance gate

Kent Beck's framing for `SPEC.md` §10 lands here too: until the worked example works, no other phase begins. The §10 examples below are the adapter's acceptance gate, pinned in CI as four runnable files under `packages/sync/test/` — `spec-async-10-1-direct-commit.test.ts`, `spec-async-10-2-mvu-front-door.test.ts`, `spec-async-10-3-conflict-registry.test.ts`, `spec-async-10-4-disposed-mid-load.test.ts` — each a separately-named acceptance for one facet of the adapter's promise. (EPIC-8 / #474 shipped the four-file split; an earlier draft of this section referenced a single `spec-async-10-worked-example.test.ts` aggregate that was retired when the per-block fixtures landed.) The §17 commitment 6 contract on the engine side has its mirror in this adapter: if the §10 examples regress, the adapter is broken; if they hold, the four invariants the examples were constructed to expose hold with them.

The team considered the same three §10 acceptance shapes that `SPEC.md` §10 considered. Sandi Metz's first review on the adapter side was the one that locked the shape: the direct-commit form proves the engine integration; the MVU form proves the §8 ergonomics composes onto this adapter without behavioural drift; the conflict-registry example proves the second primitive against the same gate; the dynamic-dep cleanup variant proves §10.3's invariant lands on a resource node the same way it lands on any other Behavior. Robert Martin's reading on the same review was the one that anchored the cross-form equivalence assertion (per the same #439 discipline `SPEC.md` §10.2 cites): the MVU listing has to land in the same test file as the direct listing, with `expect(observedDirect).toEqual(observedMvu)` as the proof line that §8 is not a parallel pipeline. Martin Fowler's review was the one that pushed the conflict example into its own block rather than folding it into a fifth assertion on the resource block: two primitives, two acceptance scenes, one file. Andrew Haines's review was the one that named the dynamic-dep cleanup variant as the load-bearing fourth block — a resource that is registered, fetched, and then disposed mid-load is the §10.3 cleanup invariant viewed through the `ResourceFleet` chart, and without the explicit example the invariant degrades to a property the §15 fuzz suite alone has to defend.

### 10.1 The direct-commit form

```ts
import { createCausl } from '@causl/core'
import { resource } from '@causl/sync'

const graph = createCausl()
let resolveLoader: ((value: number) => void) | null = null
const user = resource(graph, 'user:42', {
  loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
})

// Initial state: registered, never fetched.
expect(graph.read(user.node)).toEqual({ state: 'idle' })
expect(graph.now).toBe(1) // exactly one commit so far: the input registration.

// Fetch begins; the `loading` commit advances GraphTime by exactly one tick.
const pending = user.fetch()
const afterLoading = graph.read(user.node)
expect(afterLoading.state).toBe('loading')
if (afterLoading.state === 'loading') {
  expect(afterLoading.origin).toBe(1) // origin pinned to pre-fetch GraphTime.
  // Promise identity stability: every read during the loading episode
  // returns the same Promise reference (SPEC.async §3 Theorem 3).
  expect(graph.read(user.node)).toBe(afterLoading)
}

// Loader resolves cleanly — origin still equals graph.now.
resolveLoader!(7)
const settled = await pending
expect(settled).toBe(7)
const afterLoaded = graph.read(user.node)
expect(afterLoaded.state).toBe('loaded')
if (afterLoaded.state === 'loaded') {
  expect(afterLoaded.value).toBe(7)
  expect(afterLoaded.origin).toBe(1)
  expect(afterLoaded.loadedAt).toBe(2)
}

// Invalidate: chart-legal Loaded → Stale, no refetch.
user.invalidate()
const afterInvalidate = graph.read(user.node)
expect(afterInvalidate.state).toBe('stale')
if (afterInvalidate.state === 'stale') {
  // Stale arm preserves `value` — the §6 commitment that a stale
  // resource carries a still-readable previous value.
  expect(afterInvalidate.value).toBe(7)
}

// Re-fetch: a second loader call advances time again. While loading, the
// node reads back as `loading`, not `stale` — the chart edge `Stale → Loading`
// fires on the loading commit.
let resolveSecond: ((value: number) => void) | null = null
const second = resource(graph, 'user:42-v2', {
  loader: () => new Promise<number>((resolve) => { resolveSecond = resolve }),
}).fetch()
// (single-resource form: the same key would re-use `user.fetch()`; this
// is the multi-handle case the test pins for clarity.)
resolveSecond!(7)
await second
```

If this works, the resource adapter is real. The four invariants that fall out of the construction match `SPEC.md` §10's four: atomic commit (each transition is exactly one GraphTime tick), origin-bound resolution (`origin === graph.now` at the loading commit, preserved across the `loaded` arm), Promise identity stability (the `loading` arm carries one Promise reference for the duration of the episode), and chart-conformance (every observed state is one of the five DU arms, never an out-of-chart write).

### 10.2 The MVU front-door form

Per the #439 discipline, the same scenario driven through the §8 surface, asserting the same observed state sequence and the same final clock:

```ts
import { createCausl } from '@causl/core'
import { defineMsgs, payload, type MsgOf, createUpdate } from '@causl/react'
import { resource } from '@causl/sync'

type ResourceMsg =
  | { type: 'fetch' }
  | { type: 'invalidate' }
  | { type: 'fail'; error: unknown }

const msg = defineMsgs({
  fetch: payload<{}>(),
  invalidate: payload<{}>(),
  fail: payload<{ error: unknown }>(),
})
type Msg = MsgOf<typeof msg>

const graph = createCausl()
let resolveLoader: ((value: number) => void) | null = null
const user = resource(graph, 'user:42', {
  loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
})

const observed: ResourceState<number>['state'][] = []
graph.subscribe(user.node, (s) => observed.push(s.state))

const update = createUpdate<Msg>({
  fetch:      (_, g) => { void user.fetch() },
  invalidate: (_, g) => { user.invalidate() },
  fail:       (m, g) => { user.fail(m.error) },
})

update(msg.fetch({}), graph)
resolveLoader!(7)
await Promise.resolve() // settle the resolution commit.
update(msg.invalidate({}), graph)

expect(observed).toEqual(['idle', 'loading', 'loaded', 'stale'])
expect(graph.now).toBe(4) // input registration + loading + loaded + stale invalidate.
```

Same observed sequence as the direct form, same final `graph.now`. The §8 promise — that the MVU front door is a documentation choice, not a different engine — is the line this test pins. The MVU `update` reduces every host-side intent to one of the three `ResourceHandle` mutators; the resource adapter does not need a parallel `update`-aware surface.

### 10.3 Conflict registry — open, derived overlay, resolution

The second primitive's acceptance scene. The registry is registered over a synthetic open-set computation; the public derived node is observed through `subscribe`; resolutions land via `resolve` and the overlay updates accordingly.

```ts
import { createCausl } from '@causl/core'
import { createConflictRegistry, singleConflictWhen, type Conflict } from '@causl/sync'

interface Validation { readonly field: string; readonly reason: string }

const graph = createCausl()
// Source input: a validation record. When `reason` is non-empty, a
// conflict is open against `'form:user:42'`.
const validation = graph.input<Validation>('validation:user:42', {
  field: 'email',
  reason: 'invalid-format',
})

const registry = createConflictRegistry<Validation>(graph, {
  id: 'conflicts:form:user:42',
  compute: singleConflictWhen(
    validation,
    (v) => v.reason !== '',
    (v) => ({ id: 'form:user:42:email', target: 'form:user:42' }),
  ),
})

const observed: readonly Conflict<Validation>[][] = []
graph.subscribe(registry.node, (cs) => observed.push(cs))

// Initial overlay: one open conflict.
const initial = registry.read(graph)
expect(initial.length).toBe(1)
expect(initial[0]!.kind).toBe('open')

// Resolve: chart-legal Open → Resolved with an opaque payload.
registry.resolve(graph, 'form:user:42:email', { acceptedBy: 'op:42' })
const afterResolve = registry.read(graph)
expect(afterResolve.length).toBe(1)
expect(afterResolve[0]!.kind).toBe('resolved')
if (afterResolve[0]!.kind === 'resolved') {
  expect(afterResolve[0]!.resolution).toEqual({ acceptedBy: 'op:42' })
  // GraphTime stamping: resolvedAt is the GraphTime at the resolve commit.
  expect(afterResolve[0]!.resolvedAt).toBe(graph.now)
}

// Forbidden transition: a second resolve on the same id throws.
expect(() => registry.resolve(graph, 'form:user:42:email', {}))
  .toThrow(/Forbidden conflict transition: resolved → resolved/)
```

The four invariants this block pins: open-set drives the open arm (the registry surfaces an `'open'` conflict whenever the application's compute emits a partial), resolution lands as an Input patch (one commit per `resolve` / `ignore` / `supersede` call, advancing GraphTime by one tick), the overlay is single-source-of-truth (the public derived node is the only surface consumers read; there is no parallel resolution store), and the chart guard is total (a forbidden transition throws `ForbiddenConflictTransitionError` rather than silently overwriting).

### 10.4 The dynamic-dep cleanup variant — disposed mid-load

Per Andrew Haines's review, the fourth block covers the §10.3 cleanup invariant viewed through `ResourceFleet`. The scenario: a resource is registered and fetched; before the loader settles, the host calls `fail()` to abandon the load. The chart-legal edge is `Loading → Errored` (host-triggered), and the late loader resolution must not overwrite the `errored` arm.

```ts
import { createCausl } from '@causl/core'
import { resource } from '@causl/sync'

const graph = createCausl()
let resolveLoader: ((value: number) => void) | null = null
const user = resource(graph, 'user:42', {
  loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
})

const pending = user.fetch()
expect(graph.read(user.node).state).toBe('loading')

// Mid-load disposal: host-triggered Loading → Errored.
const cancellation = new Error('cancelled')
user.fail(cancellation)
const afterFail = graph.read(user.node)
expect(afterFail.state).toBe('errored')
if (afterFail.state === 'errored') {
  expect(afterFail.error).toBe(cancellation)
}

// Late resolution: the original loader resolves AFTER the fail commit.
// The §3 Theorem 1 guard fires — origin !== graph.now — and the
// resolution commits as `stale` rather than overwriting `errored`.
//
// Note the precise behaviour: the `errored` arm was written at GraphTime
// strictly greater than the loader's `origin`, so when the loader
// resolves the staleness guard observes loadedAt > loadingAt and writes
// the `stale` arm. The recorded transition history is:
//   idle → loading → errored → stale
// Each transition is the chart-legal edge for its trigger; the late
// resolution is honest about being late.
resolveLoader!(7)
await pending.catch(() => undefined)
const afterLate = graph.read(user.node)
// The late resolution wrote `stale` — the chart preserves the previous
// `value` if it had one, and surfaces the late-arrival fact.
expect(afterLate.state).toBe('stale')
```

The invariant this block pins is the one §10.3 names but cannot expose without an async edge: the cleanup path for a mid-load disposal is the chart's `Loading → Errored` edge, and the late loader resolution routes through the staleness guard rather than the loaded edge. `SPEC.md` §10.3's two-sided invariant — stale deps drop *and* fresh deps wire up — has its async-edge dual here: an abandoned load drops, *and* a re-issued load wires up to a fresh `origin`. The property-based suite (`packages/sync/test/resource.property.test.ts`) generalises this single example into a random-trial sweep, per `SPEC.md` §15.

**What the team rejected and why.** The team considered three §10 shapes for this adapter. Direct-commit only — rejected on the same #439 grounds `SPEC.md` §10 names: no proof that §8 composes onto the adapter without behavioural drift. MVU only — rejected because the engine-only proof is lost. The shipped four-block form is the §10 / §10.2 / §10.3 / §10.4 scene: direct, MVU, conflict registry, dynamic-dep cleanup. Folding the conflict registry into a fifth assertion on the resource block was rejected on Fowler's framing — two primitives, two acceptance scenes. Folding the disposal block into the direct-commit block was rejected on Haines's framing — the late-resolution edge is structurally distinct from the clean-resolution path and earns its own scene.

---

### 10.5 Full executable test fixtures (the acceptance gate, runnable form)

Kent Beck's framing for the §10 acceptance gate is the line we keep coming back to: until the worked example *runs*, no other phase begins. The four blocks below are the runnable form of that gate — four `vitest` files, each pinned in CI, each pinned to one of the four facets the prose names. Sandi Metz's discipline on the test-as-contract framing told us to spell every `expect()` against an *observable* — `graph.now`, `graph.read(node).state`, the captured `observed[]` from a real `subscribe`, the Promise identity of the `loading` arm — never against a private of the adapter. Robert Martin's don't-hide-behind-helpers rule is why none of these files factor a `setupResource()` helper or a `loadAndAssertLoaded()` aggregate-assertion: the duplication is the documentation, and a §10 reader needs to see the GraphTime arithmetic spelt out at every step. Martin Fowler's readable-test-as-documentation rule is why each `it()` name is a sentence a `SPEC.async.md` reader will understand in isolation, and why each file's `describe()` block names the section number it implements. Corey Haines's deliberate-practice naming is why every test name says exactly what edge of the chart it pins.

#### 10.1 The direct-commit form

The first acceptance scene proves the engine integration without any §8 ergonomics in the loop: one resource, one loader, the four chart-legal transitions out of `Loading`, and a re-fetch that exercises `Loaded → Loading` cleanly. The four invariants this fixture pins are the same four `SPEC.md` §10 names: atomic commit (each transition advances `graph.now` by exactly one tick), origin-bound resolution (`origin === graph.now` at the loading commit, preserved across the `loaded` arm), Promise identity stability (one Promise reference for the duration of the loading episode), and chart-conformance (every observed `state` is one of the five DU arms). The edge cases — fetch-fail, invalidate-while-loading, fetch-then-immediately-fetch-again — are the three rows the §6 chart names but the prose example does not exercise; we surface them here so a regression in any of the three lights up CI on the same gate.

```ts
// packages/sync/test/spec-async-10-1-direct-commit.test.ts
//
// SPEC.async.md §10.1 — Direct-commit acceptance gate.
// Pinned per the §10 framing: until this file passes, no later phase begins.

import { createCausl } from '@causl/core'
import { resource, type ResourceState } from '@causl/sync'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §10.1 — direct-commit acceptance', () => {
  it('golden path: idle → loading → loaded preserves origin and stamps loadedAt', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () =>
        new Promise<number>((resolve) => {
          resolveLoader = resolve
        }),
    })

    expect(graph.read(user.node)).toEqual({ state: 'idle' })
    expect(graph.now).toBe(1)

    const pending = user.fetch()
    const afterLoading = graph.read(user.node)
    expect(afterLoading.state).toBe('loading')
    expect(graph.now).toBe(2)
    if (afterLoading.state !== 'loading') throw new Error('narrowing')
    expect(afterLoading.origin).toBe(1)

    const reread = graph.read(user.node)
    expect(reread).toBe(afterLoading)
    if (reread.state !== 'loading') throw new Error('narrowing')
    expect(reread.promise).toBe(afterLoading.promise)

    resolveLoader!(7)
    const settled = await pending
    expect(settled).toBe(7)

    const afterLoaded = graph.read(user.node)
    expect(afterLoaded.state).toBe('loaded')
    if (afterLoaded.state !== 'loaded') throw new Error('narrowing')
    expect(afterLoaded.value).toBe(7)
    expect(afterLoaded.origin).toBe(1)
    expect(afterLoaded.loadedAt).toBe(3)
    expect(graph.now).toBe(3)
  })

  it('invalidate after loaded carries previous value into stale arm', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () =>
        new Promise<number>((resolve) => {
          resolveLoader = resolve
        }),
    })

    const pending = user.fetch()
    resolveLoader!(7)
    await pending

    user.invalidate()
    const afterInvalidate = graph.read(user.node)
    expect(afterInvalidate.state).toBe('stale')
    if (afterInvalidate.state !== 'stale') throw new Error('narrowing')
    expect(afterInvalidate.value).toBe(7)
    expect(afterInvalidate.origin).toBe(1)
    expect(afterInvalidate.loadedAt).toBe(3)
    expect(graph.now).toBe(4)
  })

  it('loader rejection drives Loading → Errored and rethrows to fetch caller', async () => {
    const graph = createCausl()
    const failure = new Error('boom')
    let rejectLoader: ((reason: unknown) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () =>
        new Promise<number>((_, reject) => {
          rejectLoader = reject
        }),
    })

    const pending = user.fetch()
    expect(graph.read(user.node).state).toBe('loading')

    rejectLoader!(failure)
    await expect(pending).rejects.toBe(failure)
    const afterError = graph.read(user.node)
    expect(afterError.state).toBe('errored')
    if (afterError.state !== 'errored') throw new Error('narrowing')
    expect(afterError.error).toBe(failure)
    expect(afterError.origin).toBe(1)
    expect(afterError.erroredAt).toBe(3)
    expect(graph.now).toBe(3)
  })

  it('fetch-then-immediately-fetch-again issues two loading commits and the late one wins', async () => {
    const graph = createCausl()
    const resolvers: Array<(value: number) => void> = []
    const user = resource(graph, 'user:42', {
      loader: () =>
        new Promise<number>((resolve) => {
          resolvers.push(resolve)
        }),
    })

    const first = user.fetch()
    expect(graph.now).toBe(2)
    const firstLoading = graph.read(user.node)
    expect(firstLoading.state).toBe('loading')

    const second = user.fetch()
    expect(graph.now).toBe(3)
    const secondLoading = graph.read(user.node)
    expect(secondLoading.state).toBe('loading')
    if (secondLoading.state !== 'loading') throw new Error('narrowing')
    expect(secondLoading.origin).toBe(2)

    resolvers[0]!(7)
    await first
    const afterFirst = graph.read(user.node)
    expect(afterFirst.state).toBe('stale')

    resolvers[1]!(11)
    await second
    const afterSecond = graph.read(user.node)
    expect(afterSecond.state).toBe('loaded')
    if (afterSecond.state !== 'loaded') throw new Error('narrowing')
    expect(afterSecond.value).toBe(11)
    expect(afterSecond.origin).toBe(2)
  })

  it('every observed transition is one of the five DU arms (chart-conformance probe)', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () =>
        new Promise<number>((resolve) => {
          resolveLoader = resolve
        }),
    })
    const observed: ResourceState<number>['state'][] = []
    graph.subscribe(user.node, (s) => observed.push(s.state))

    const pending = user.fetch()
    resolveLoader!(7)
    await pending
    user.invalidate()

    expect(observed).toEqual(['idle', 'loading', 'loaded', 'stale'])
    const legal = new Set<ResourceState<number>['state']>([
      'idle', 'loading', 'loaded', 'stale', 'errored',
    ])
    for (const tag of observed) expect(legal.has(tag)).toBe(true)
  })
})
```

#### 10.2 The MVU front-door form

The second acceptance scene drives the same scenario through a hand-rolled MVU dispatcher, asserting the exact same observed state sequence and the exact same final `graph.now`. The #439 discipline is the line this fixture pins: §8 is a documentation choice, not a parallel pipeline. We do not import `@causl/react`'s `defineMsgs` / `createUpdate` here because the test must `tsc` cleanly against `@causl/sync` alone — the MVU front door is duplicated as a tiny in-file reducer to keep the file self-contained, and the equivalence assertion `expect(observedDirect).toEqual(observedMvu)` is the proof line that the same five-arm DU surface reaches the same observers regardless of which front door issued the call.

```ts
// packages/sync/test/spec-async-10-2-mvu-front-door.test.ts

import { createCausl } from '@causl/core'
import { resource, type ResourceHandle, type ResourceState } from '@causl/sync'
import { describe, expect, it } from 'vitest'

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
  it('produces the same observed sequence and final clock as the direct form', async () => {
    async function runDirect(): Promise<{
      observed: readonly ResourceState<number>['state'][]; finalNow: number
    }> {
      const graph = createCausl()
      let resolveLoader: ((value: number) => void) | null = null
      const user = resource(graph, 'user:42', {
        loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
      })
      const observed: ResourceState<number>['state'][] = []
      graph.subscribe(user.node, (s) => observed.push(s.state))
      const pending = user.fetch()
      resolveLoader!(7); await pending; user.invalidate()
      return { observed, finalNow: graph.now }
    }
    async function runMvu(): Promise<{
      observed: readonly ResourceState<number>['state'][]; finalNow: number
    }> {
      const graph = createCausl()
      let resolveLoader: ((value: number) => void) | null = null
      const user = resource(graph, 'user:42', {
        loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
      })
      const observed: ResourceState<number>['state'][] = []
      graph.subscribe(user.node, (s) => observed.push(s.state))
      dispatch(user, { type: 'fetch' })
      resolveLoader!(7)
      await Promise.resolve(); await Promise.resolve()
      dispatch(user, { type: 'invalidate' })
      return { observed, finalNow: graph.now }
    }
    const direct = await runDirect()
    const mvu = await runMvu()
    expect(mvu.observed).toEqual(direct.observed)
    expect(mvu.observed).toEqual(['idle', 'loading', 'loaded', 'stale'])
    expect(mvu.finalNow).toBe(direct.finalNow)
    expect(mvu.finalNow).toBe(4)
  })

  it('host-triggered fail dispatched from MVU lands on Loading → Errored', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
    })
    dispatch(user, { type: 'fetch' })
    expect(graph.read(user.node).state).toBe('loading')
    const cancellation = new Error('cancelled-by-host')
    dispatch(user, { type: 'fail', error: cancellation })
    const afterFail = graph.read(user.node)
    expect(afterFail.state).toBe('errored')
    if (afterFail.state !== 'errored') throw new Error('narrowing')
    expect(afterFail.error).toBe(cancellation)
    resolveLoader!(7)
    await Promise.resolve(); await Promise.resolve()
    const afterLate = graph.read(user.node)
    expect(afterLate.state).toBe('stale')
    if (afterLate.state !== 'stale') throw new Error('narrowing')
    expect(afterLate.value).toBe(7)
  })
})
```

#### 10.3 Conflict registry — open, derived overlay, resolution

The third acceptance scene proves the second primitive against the same gate. The registry is registered over a synthetic open-set computation built with `singleConflictWhen`; the public derived node is observed through `subscribe`; resolutions land via `resolve`, `ignore`, and `supersede`, and the overlay updates accordingly.

```ts
// packages/sync/test/spec-async-10-3-conflict-registry.test.ts

import { createCausl } from '@causl/core'
import {
  type Conflict, createConflictRegistry,
  ForbiddenConflictTransitionError, singleConflictWhen,
} from '@causl/sync'
import { describe, expect, it } from 'vitest'

interface Validation { readonly field: string; readonly reason: string }

describe('SPEC.async §10.3 — conflict registry acceptance', () => {
  it('golden path: open conflict from compute, resolved with opaque payload', () => {
    const graph = createCausl()
    const validation = graph.input<Validation>('validation:user:42', {
      field: 'email', reason: 'invalid-format',
    })
    const registry = createConflictRegistry<Validation>(graph, {
      id: 'conflicts:form:user:42',
      compute: singleConflictWhen(
        validation, (v) => v.reason !== '',
        () => ({ id: 'form:user:42:email', target: 'form:user:42' }),
      ),
    })
    const observed: (readonly Conflict<Validation>[])[] = []
    registry.subscribe(graph, (cs) => observed.push(cs))

    const initial = registry.read(graph)
    expect(initial.length).toBe(1)
    expect(initial[0]!.kind).toBe('open')
    expect(initial[0]!.id).toBe('form:user:42:email')

    const beforeResolve = graph.now
    registry.resolve(graph, 'form:user:42:email', { acceptedBy: 'op:42' })
    expect(graph.now).toBe(beforeResolve + 1)

    const afterResolve = registry.read(graph)
    expect(afterResolve[0]!.kind).toBe('resolved')
    if (afterResolve[0]!.kind !== 'resolved') throw new Error('narrowing')
    expect(afterResolve[0]!.resolution).toEqual({ acceptedBy: 'op:42' })
    expect(afterResolve[0]!.resolvedAt).toBe(graph.now)
  })

  it('forbidden transition: a second resolve on the same id throws', () => {
    const graph = createCausl()
    const validation = graph.input<Validation>('validation:user:42', {
      field: 'email', reason: 'invalid-format',
    })
    const registry = createConflictRegistry<Validation>(graph, {
      id: 'conflicts:form:user:42',
      compute: singleConflictWhen(
        validation, (v) => v.reason !== '',
        () => ({ id: 'form:user:42:email', target: 'form:user:42' }),
      ),
    })
    registry.resolve(graph, 'form:user:42:email', { acceptedBy: 'op:42' })
    expect(() =>
      registry.resolve(graph, 'form:user:42:email', { acceptedBy: 'op:99' }),
    ).toThrow(ForbiddenConflictTransitionError)
  })

  it('forbidden transition: supersede of an unknown id throws with from=unknown', () => {
    const graph = createCausl()
    const validation = graph.input<Validation>('validation:user:42', {
      field: 'email', reason: '',
    })
    const registry = createConflictRegistry<Validation>(graph, {
      id: 'conflicts:form:user:42',
      compute: singleConflictWhen(
        validation, (v) => v.reason !== '',
        () => ({ id: 'form:user:42:email', target: 'form:user:42' }),
      ),
    })
    expect(registry.read(graph).length).toBe(0)
    expect(() =>
      registry.supersede(graph, 'form:user:42:email', 'form:user:42:email:v2'),
    ).toThrow(/Forbidden conflict transition: unknown → superseded/)
  })
})
```

#### 10.4 The dynamic-dep cleanup variant — disposed mid-load

The fourth acceptance scene is the load-bearing one Corey Haines's review named: a resource that is registered, fetched, and then *abandoned* before the loader settles is the §10.3 cleanup invariant viewed through `ResourceFleet`. The chart-legal edge is `Loading → Errored` (host-triggered via `fail`), and the late loader resolution must not overwrite the `errored` arm — instead, the staleness guard catches it and routes the resolution to `stale`.

```ts
// packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts

import { createCausl } from '@causl/core'
import { ForbiddenResourceTransitionError, resource } from '@causl/sync'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §10.4 — disposed-mid-load acceptance', () => {
  it('golden path: idle → loading → errored → stale on late loader resolution', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
    })
    const pending = user.fetch()
    expect(graph.read(user.node).state).toBe('loading')
    const cancellation = new Error('cancelled')
    user.fail(cancellation)
    const afterFail = graph.read(user.node)
    expect(afterFail.state).toBe('errored')
    if (afterFail.state !== 'errored') throw new Error('narrowing')
    expect(afterFail.error).toBe(cancellation)
    resolveLoader!(7)
    await pending.catch(() => undefined)
    const afterLate = graph.read(user.node)
    expect(afterLate.state).toBe('stale')
    if (afterLate.state !== 'stale') throw new Error('narrowing')
    expect(afterLate.value).toBe(7)
  })

  it('records the full transition history idle → loading → errored → stale', async () => {
    const graph = createCausl()
    let resolveLoader: ((value: number) => void) | null = null
    const user = resource(graph, 'user:42', {
      loader: () => new Promise<number>((resolve) => { resolveLoader = resolve }),
    })
    const observed: string[] = []
    graph.subscribe(user.node, (s) => observed.push(s.state))
    const pending = user.fetch()
    user.fail(new Error('cancelled'))
    resolveLoader!(7)
    await pending.catch(() => undefined)
    expect(observed).toEqual(['idle', 'loading', 'errored', 'stale'])
  })

  it('fail from idle throws ForbiddenResourceTransitionError', () => {
    const graph = createCausl()
    const user = resource(graph, 'user:42', { loader: () => Promise.resolve(7) })
    expect(graph.read(user.node).state).toBe('idle')
    expect(() => user.fail(new Error('boom'))).toThrow(
      ForbiddenResourceTransitionError,
    )
    expect(() => user.fail(new Error('boom'))).toThrow(
      /Forbidden resource transition: idle → errored/,
    )
  })

  it('fail from stale throws ForbiddenResourceTransitionError', async () => {
    const graph = createCausl()
    const user = resource(graph, 'user:42', { loader: () => Promise.resolve(7) })
    await user.fetch()
    user.invalidate()
    expect(graph.read(user.node).state).toBe('stale')
    expect(() => user.fail(new Error('boom'))).toThrow(
      /Forbidden resource transition: stale → errored/,
    )
  })

  it('fail from errored throws ForbiddenResourceTransitionError', async () => {
    const graph = createCausl()
    const user = resource(graph, 'user:42', {
      loader: () => Promise.reject(new Error('original')),
    })
    await user.fetch().catch(() => undefined)
    expect(graph.read(user.node).state).toBe('errored')
    expect(() => user.fail(new Error('second'))).toThrow(
      /Forbidden resource transition: errored → errored/,
    )
  })
})
```

---


## 11. Liveness — inspection over resources and conflicts

Alan Kay's framing for `SPEC.md` §11 lands again here: the engine is its own observer. A resource node is a `Node<ResourceState<T>>` like any other; a conflict registry's public node is a `DerivedNode<readonly Conflict<T>[]>` like any other. The §11 inspection primitives compose through unchanged — `subscribe`, `readAt`, `dependencies`, `dependents`, `whyUpdated`, `whyNotUpdated`, `commitLog`, `commitMetadataDerived` — and this section walks how each one applies to the adapter's two primitives without any new surface. There is no parallel inspection state for resources, no parallel observer for conflicts, no shadow event bus for loading episodes.

### 11.1 Inspection primitives applied

The five primitives `SPEC.md` §11.1 names compose onto resource and conflict nodes uniformly. Each row below restates the engine primitive and names what the adapter-side answer looks like.

- **`graph.commitLog`** (getter, `DerivedNode<readonly Commit[]>`). The bounded ring-buffer surfaces every commit a resource or registry produces. A loader's resolution commits as a `Commit` whose `intent` is `fetch:${key}:loaded` (clean), `fetch:${key}:stale` (staleness guard hit), or `fetch:${key}:error` (loader rejected). A registry mutator commits as `conflict:${kind}:${id}`. Adapter-side observers that want to render a loading-episode timeline subscribe to `commitLog` and filter on the `intent` prefix; the answer is the same `Behavior [Commit]` shape Conal Elliott's framing names, no new surface required.

- **`whyUpdated(node)`** (`DerivedNode<WhyUpdatedResult>`). For a resource node, the per-commit answer is one of an enumerated set — and the adapter ships the enumeration as `ResourceUpdateReason`. **Current state (as of v0.9.0).** Both `whyUpdated`, `whyNotUpdated`, and the seven-arm `ResourceUpdateReason` enumeration ship as adapter-side decoders from `@causl/sync` itself (`packages/sync/src/whyUpdated.ts`, per #577), composing onto the engine's commit log and `intent` labels rather than reaching for a separate `@causl/devtools` import.

  ```text
  ResourceUpdateReason :=
    | 'fetch-begin'      -- transition into `loading` from `idle | stale | errored`
    | 'fetch-resolved'   -- transition into `loaded` (clean) from `loading`
    | 'fetch-stale'      -- transition into `stale` (staleness guard) from `loading`
    | 'fetch-rejected'   -- transition into `errored` from `loading` via loader rejection
    | 'invalidated'      -- transition into `stale` from `loaded` via host invalidate()
    | 'failed'           -- transition into `errored` from `loading | loaded` via host fail()
    | 'dep-changed'      -- a downstream derived node observed this resource updating
                            (the §6 ResourceFleet region's interaction with the rest of the graph)
  ```

  The seven tags are total over the resource's transition space. `whyUpdated` consumes the commit's `intent` label (which the adapter sets uniquely per transition) plus the pre/post-commit DU arms to disambiguate. The `dep-changed` arm is the engine-side answer for downstream `derived` nodes that re-ran because their resource dependency advanced; it is the §11.1 `recomputed` tag specialised to a resource source.

- **`whyNotUpdated(node)`** (`DerivedNode<WhyNotUpdatedResult>`). The dual: a render that expected a resource to update but did not see one. For a resource node, the typical no-update reasons are `no-dep-overlap` (the commit didn't touch this resource's input) and `object-is-deduped` (the next state was structurally equal to the previous — rare on the resource adapter because every transition advances at least one of the GraphTime-stamped fields, but possible for a `loaded` write that resolves to the same `value` after a `Loaded → Stale → Loading → Loaded` cycle). Ships from `@causl/sync`, as with `whyUpdated`.

- **`graph.dependencies(resourceNode)`** (`readonly NodeId[]`). Returns the direct upstream ids. A resource node is an Input, not a Derived, so the dependency list is empty — `[]` — which is the chart-honest answer: a resource is fed by its host's `ResourceHandle` mutators, and those are not engine nodes. A registry's public node is Derived, and `dependencies(registry.node)` returns `[${id}::__open, ${id}::__resolutions]` — the two upstream nodes the overlay reads. Both answers are the §11.1 one-shot snapshot the engine ships uniformly.

- **`graph.dependents(resourceNode)`** (`readonly NodeId[]`). Returns the direct reverse-dep ids. A resource node's dependents are the Derived nodes that read its current state — typically a UI selector that narrows on `state === 'loaded'`. A registry's public node's dependents are whatever Derived nodes downstream (a count of unresolved conflicts, an operator-facing list, etc.). Both answers compose through unchanged.

- **`graph.commitMetadataDerived(id, compute)`** (Phase F.5 factory). The adapter does not ship its own derivations that read commit metadata; consumers that want a derivation reading both a resource's current state and the most recent commit's metadata register their own through `graph.commitMetadataDerived`. The Phase F.5 seam (`SPEC.md` §11.2) is what makes that derivation see the post-Phase-F.4 `commitLogEntry.value` on the same commit it fires on.

### 11.2 The Phase F.5 seam

A consumer that wants to render "loaded by commit at GraphTime t, intent `${commitIntent}`" needs to read both `resource.state` and the most recent `Commit` from `graph.commitLog` *on the same commit that produced both*. A naive `graph.derived(...)` registration would observe the previous commit's metadata, because Phase D walks the affected sub-graph against the previous `commitLogEntry.value` (Phase F.4 has not run yet). This is the same regression `SPEC.md` §11.2 catalogues for the engine's own `whyUpdated` derivation; the repair is the same `graph.commitMetadataDerived(id, compute)` factory.

The adapter ships no Phase F.5 derivations of its own. The Phase F.5 seam is documented here so that an adapter consumer who wants a derivation reading `(resource.state, latestCommit)` knows to register through `commitMetadataDerived` rather than `derived`. The §11.2 commitment that ordinary `derived(...)` composes unchanged with resources holds: the resource's state itself is a Phase D value, not a Phase F.5 value, and any consumer that reads only the state through `derived(...)` sees the post-commit value on the commit that produced it.

### 11.3 What we did *not* ship for §11

- **A `resource.history` Behavior** — a derived node surfacing the full transition history of a resource. The reasoning is the same one `SPEC.md` §11.3 cites for the engine's "live `dependencies(node)` Behavior": the §6 retention sub-region applies uniformly, and a resource node is a Behavior whose history is recoverable through `readAt(resourceNode, t)` for any `t` in the bounded ring-buffer's window. A consumer that wants the last N transitions composes `commitLog` filtered on the resource's `intent` prefix; a consumer that wants the resource's value at past time `t` calls `readAt`. Both compose through unchanged. Shipping a parallel `resource.history` surface would invent a second retention discipline alongside the engine's, which `SPEC.md` §6 explicitly forbids.
- **A loading-episode telemetry node** — a derived node surfacing live load duration, success/failure rate, P95 latency. Rejected on the same surface-inflation grounds: the loader-side timing is observable to the host code that constructs the `loader` callback; the engine-side timing is observable through `commitLog` (the `fetch:${key}:start` and `fetch:${key}:loaded` commits' `committedAt` fields differ by exactly the loader's wall-clock duration plus pipeline overhead). Composing those two sources at the application layer is the §11.3 path.
- **A `ConflictRegistry.history` Behavior** — same shape as `resource.history`, same rejection. The registry's per-conflict transition history is recoverable through `commitLog` filtered on `conflict:` and through `readAt` on the resolution Input.

### 11.4 Composition patterns the adapter inherits

The §11 inspection surface composes onto adapter primitives without per-primitive exception. Three patterns the team has used at adapter review and that are worth naming explicitly so consumers do not re-invent them:

- **Time-travel against a resource node.** `graph.readAt(resourceNode, t)` returns the resource's `ResourceState<T>` at any retained GraphTime. A consumer rendering "what did this resource look like three commits ago?" reaches for `readAt` and narrows on the returned arm; the §6 retention sub-region's `Retained | Evicted` envelope wraps the answer. There is no resource-specific time-travel API; the engine's primitive composes through.
- **Whole-graph snapshots that include resource state.** `graph.snapshotAt(t)` includes every Input's value at GraphTime `t`, which means it includes every resource's `ResourceState<T>` arm at `t` (because the resource's backing storage is an Input). A `snapshotAt` taken mid-loading-episode captures the `loading` arm with its `origin` and `promise` — and the Promise reference is the same one every other reader of the snapshot saw, because the snapshot is a structural projection of the engine's value graph at `t`. Re-hydrating such a snapshot in a fresh engine is not in-scope for the adapter; `@causl/persistence` owns that surface, and a `loading`-arm snapshot rehydrates as `idle` (the loader closure does not survive serialisation, and the §6 chart treats the rehydration as a fresh registration).
- **Subscribing to a registry's transitions through `subscribeCommits`.** A consumer that wants per-resolution callbacks (e.g. "log every conflict resolution to the audit trail") subscribes to `graph.subscribeCommits` and filters on the `intent` prefix (`conflict:resolved:`, `conflict:ignored:`, `conflict:superseded:`). The narrow per-fire surface `SPEC.md` §12.2 describes is the path the adapter recommends; subscribing to the registry's public node fires once per overlay change, which includes upstream open-set re-emissions that did not commit through the registry's mutators.

**What the team rejected and why.** A "resource devtools panel" sitting next to the engine's devtools — Kay's framing on the engine side applies: a parallel observer system for resources means the engine is *not* its own observer of resources. A `whyUpdated` returning a resource-specific result type — rejected because the §11.1 enumeration is engine-side, and a per-adapter `WhyResult` would fragment the inspection surface across packages. The shipped path is `WhyUpdatedResult` carrying the `recomputed | directly-set | no-cause` tags engine-side, with the adapter-specific `ResourceUpdateReason` enumeration as the *meaning* a host-side decoder applies to the commit's `intent` label — one inspection surface, two layers of interpretation. A `resource.subscribe(observer)` method on `ResourceHandle` directly — rejected because `ResourceHandle.node` is a `Node<ResourceState<T>>` and `graph.subscribe(handle.node, observer)` is the canonical path; adding a handle-level subscribe convenience would duplicate the engine's `subscribe` surface and invite drift between the two paths.

---

## 12. Public surface

Anders Hejlsberg's framing for `SPEC.md` §12 — the surface is the contract — lands on this adapter at a smaller scale. `@causl/sync` ships nine public symbols, organised into the canonical surface (§12.1) and the second-tier extensions (§12.2). The package is one of the canonical sibling adapters in `SPEC.md` §12.5; its README is the row at `packages/sync/README.md`. The §12 audit on the engine side (twenty-one public `Graph` members — see `SPEC.md` §12) does not apply here — adapters change at their own pace, and this section is the per-adapter honesty pass.

### 12.1 Canonical surface

The nine symbols below are the surface every consumer of `@causl/sync` reaches for. Each row's "why canonical" column names what the package would have to invent if the symbol were absent.

| Export | Signature | Why canonical |
| --- | --- | --- |
| `resource` | `<T>(graph: Graph, key: NodeId, options: ResourceOptions<T>) => ResourceHandle<T>` | The first primitive. Without this factory, the adapter has no entry point; every Resource is constructed through this call. The 3-arg shape (`graph`, `key`, `options`) is deliberate against a 2-arg curried alternative — see §4 — and pins the engine binding at the call site. |
| `createConflictRegistry` | `<T>(graph: Graph, options: ConflictRegistryOptions<T>) => ConflictRegistry<T>` | The second primitive. Without this factory, the adapter has no path to register a conflict overlay; every `ConflictRegistry` is constructed through this call. |
| `singleConflictWhen` | `<T>(source: Node<T>, predicate: (v: T) => boolean, describe: (v: T, t: GraphTime) => Pick<ConflictBase<T>, 'id' \| 'target'>) => Compute<readonly ConflictBase<T>[]>` | The single-source convenience compute factory. Without this helper, the common case ("raise a conflict whenever this one node violates this one rule") would re-implement the predicate-plus-describe shape at every call site; centralising it in the adapter prevents the §9 rediscovery from happening in application code. |
| `ResourceState` | `type` (five-arm DU, discriminator `state`) | The §3 / §9 commitment realised as a type. Consumers narrow on `r.state` and let `tsc` enforce the chart's per-state field set. Without the export, every consumer would have to redeclare the union or reach through `ResourceHandle['node']`'s value type. |
| `ResourceHandle` | `interface` (carrying `node`, `key`, `fetch()`, `invalidate()`, `fail(error)`) | The controller-shaped surface that drives transitions. Without the export, every consumer that stores a handle in a map or passes one across a module boundary would have to type the value as `ReturnType<typeof resource>`, which loses the `T` parameter and forces a re-declaration. |
| `Conflict` | `type` (four-arm DU, discriminator `kind`) | The §9 commitment for the conflict primitive realised as a type. Same reasoning as `ResourceState`: consumers narrow on `c.kind`. |
| `ConflictRegistry` | `interface` (carrying `node`, `read(g)`, `subscribe(g, observer)`, `resolve(g, id, payload?)`, `ignore(g, id)`, `supersede(g, id, by)`) | The registry's public surface. Without the export, every consumer that stores a registry or passes one across a module boundary loses the `T` parameter the same way `ResourceHandle` does. |
| `ForbiddenResourceTransitionError` | `class extends Error` (carrying `id`, `from`, `to`) | The runtime gate for off-chart `fail()` calls. Without the export, callers that want to handle forbidden transitions distinctly from generic errors would have no `instanceof` discriminator. |
| `ForbiddenConflictTransitionError` | `class extends Error` (carrying `id`, `from`, `to`) | The runtime gate for off-chart registry mutator calls. Same reasoning as the resource error. |

Nine canonical symbols, no slogan. The previous draft of this section claimed "two functions and two error classes" — that count was honest about the two factories and the two errors but elided the seven type/interface exports the surface requires to be *usable*. Hejlsberg's review on the same draft was unanswerable: a `resource()` call whose return type the consumer cannot name is not a usable surface. Counting the type-side exports brings the canonical surface to nine.

### 12.2 Second-tier extensions

The four exports below are useful but not load-bearing — a consumer who wanted to could re-derive each from the canonical surface, at a small per-call-site cost the adapter spares them by centralising the alias.

| Export | Signature | Why second-tier (and not internal) |
| --- | --- | --- |
| `ResourceOptions` | `interface { loader: (origin: GraphTime) => Promise<T>; stalenessGuard?: boolean }` | The options bag for `resource()`. A consumer could re-declare it inline at every call site, but the adapter centralises it so the staleness-guard default and the loader signature have one source of truth. `stalenessGuard` defaults to on; setting it to **`false`** is the last-writer-wins opt-out — a **named, per-resource waiver of Theorem 1 / `SPEC.md` §9.1 row 6** (review 2026-07-06, M5): late resolutions commit `Loading → Loaded` as authoritative regardless of GraphTime ordering. |
| `ConflictRegistryOptions` | `interface { id: NodeId; compute: Compute<readonly ConflictBase<T>[]> }` | Same shape as `ResourceOptions`: the options bag for `createConflictRegistry()`, centralised. |
| `ConflictBase` | `interface { id; target; value; raisedAt }` | The shared field set every `Conflict<T>` arm intersects with. A consumer who wants to type a value that is "any conflict, regardless of arm" reaches for `ConflictBase<T>`. |
| `ConflictKind` | `type 'open' \| 'resolved' \| 'ignored' \| 'superseded'` | The discriminator's value space. Useful for adapter UIs that want to switch on the kind without committing to a specific arm's payload. |
| `ConflictRegistryReadGraph` | `Pick<Graph, 'read' \| 'subscribe'>` | The read-side capability slice, per `SPEC.md` §7.2 / §12.3 layering. Re-exported because consumers who write read-side helpers around the registry need the named type at the helper's signature. |
| `ConflictRegistryWriteGraph` | `Pick<Graph, 'read' \| 'commit' \| 'now'>` | The write-side capability slice. Same reasoning: consumers who write mutator-shaped helpers need the named type. |

Six second-tier exports. The pattern across all six is the same: each is a name the consumer would otherwise have to invent, and each names a concept the §3 / §9 / §7.2 commitments already commit the adapter to. The team would rather ship a name than relitigate the concept at every call site.

**Current state (as of v0.9.0).** The `packages/sync/src/index.ts` barrel ships a handful of additional symbols beyond the nine canonical + six second-tier rows tabled above: the §11.1 decoders shipped via #577 (`whyUpdated`, `whyNotUpdated`, the closed seven-arm `ResourceUpdateReason` enumeration, the `RESOURCE_UPDATE_REASONS` value tuple, plus the `CommitForDecoding` and `WhyNotUpdatedReason` types), and the conventional `VERSION` semver-string constant. The §11 prose (`§11.1`) discusses `whyUpdated` / `whyNotUpdated` in the inspection-primitive section but does not table them here; future audits should fold them into §12.1 or §12.2 with the next pass.

### 12.3 Internal-only

None in the v1 adapter. The implementation files (`resource.ts`, `conflict.ts`) carry private helpers — `setState`, `fetchOnce`, `patch`, `currentKindOf`, `requireOpen`, `ResolutionRecord`, `ForbiddenFromKind` — and none of them are exported from `index.ts`. The adapter consumes `assertNever` and the `narrowCapability` proxy from `@causl/core/internal` (the §12.3 entrypoint on the engine side), but does not re-export them; downstream adapters that compose atop `@causl/sync` reach for those through `@causl/core/internal` directly, the same way `@causl/sync` does.

The two private types worth naming for completeness:

- `ResolutionRecord` — the discriminated union stored in the internal resolution Input. Three arms (`resolved | ignored | superseded`) mirroring three of the four `Conflict<T>` arms; the `open` arm has no resolution record because absence-of-record *is* the open state in the overlay.
- `ForbiddenFromKind` — the `ConflictKind | 'unknown'` synthetic tag used in `ForbiddenConflictTransitionError.from`. The `'unknown'` arm is the synthetic position the chart does not have but the diagnostic needs; an exported version of this type would invite consumers to switch on `'unknown'` in their own guard code, which would be relitigating the chart at the application layer.

Both are intentionally not exported. If a downstream consumer demonstrates a need (the bar `SPEC.md` §12.3 sets is "without it the adapter would have to invent a parallel surface"), they move to §12.2. Until then, they stay in the implementation files.

### 12.4 In-flight additions awaiting classification

Empty in v1, by the same #283 / #395 retirement logic `SPEC.md` §12.4 names: every new public-surface item passes through this section before landing in §12.1 or §12.2, with no exceptions. The adapter has no in-flight additions today; the next one will land here first.

### 12.5 The package's place in the adapter table

`@causl/sync` is the row at `packages/sync/README.md` in the `SPEC.md` §12.5 table. The README is the canonical per-adapter surface document; this spec (`SPEC.async.md`) is the architecture-level commitment that the README's surface is faithful to. The two documents are kept in sync the same way `SPEC.md` and `packages/core/README.md` are: a public-surface change opens a PR that touches both, and the §17 commitment 7 chart-conformance discipline is enforced across the pair.

The other canonical sibling adapters in the §12.5 table — `@causl/react`, `@causl/persistence`, `@causl/devtools`, `@causl/formula`, `@causl/checker`, `@causl/migration-check` — each ship their own SPEC-shaped architecture document. `@causl/sync` is one of the eight sibling adapters; nothing about its position in the table makes it more or less canonical than its peers. The SPEC-anchored discipline is one architecture commitment per package, one surface README per package, one §17 commitment 7 audit across both.

**What the team rejected and why.** "Two functions and two error classes" — honest auditing produced nine canonical and six second-tier rows. Hiding the option-bag interfaces (`ResourceOptions`, `ConflictRegistryOptions`) — a consumer cannot name the second argument to either factory without them, and the resulting `Parameters<typeof resource>[2]` workaround is a §9-shape violation at every call site that uses it. Re-exporting `assertNever` from this adapter — `@causl/core/internal` is the single source of truth for that helper, and a per-adapter re-export would fragment the helper's identity across packages. Promising "no second-tier exports" — the §12 audit on the engine side cost twelve more rows than the previous draft promised, and this adapter pays the same honesty cost at a smaller scale.

---

## 13. Deferred capabilities

I am not promising any of the items in this section. The discipline mirrors `SPEC.md` §13: each row carries **DEFERRED** (designed, may ship if a trigger fires) or **NOT-PLANNED** (the team has actively decided this is out of scope). The rows below are the adapter-specific deferrals — the ones that come up about `@causl/sync` but never about `@causl/core` — and each one names the design on the shelf and the trigger that would reopen it. Tanner Linsley's framing on review was the spine: a deferral the spec cannot name a trigger for is a feature the spec cannot say no to, and the row collapses to vapor under the first adopter pull.

### 13.1 Background refetch on focus / interval — DEFERRED

TanStack Query's defaults are the precedent: `refetchOnWindowFocus`, `refetchInterval`, `refetchOnReconnect`. None of those ship in `@causl/sync` today. Today's adapter takes the loader callback and calls it when the host invokes `handle.fetch()`; it does not subscribe to `window.focus`, does not poll, does not own a timer, and does not reach across the network seam to decide a refetch is due. The §2 commitment ("a fetch library is what this is not") rules out the network-side primitives; the §1 commitment ("the loader is the seam, not the network") rules out the timer-side primitives.

**The shape on the shelf if reopened.** A `revalidate(handle, policy)` helper on top of the existing `ResourceHandle<T>` surface, where `policy` is one of `{ kind: 'focus' } | { kind: 'interval'; ms: number } | { kind: 'reconnect' }`. The helper is a thin wrapper that calls `handle.fetch()` from the appropriate browser event source and is composable atop the existing five-arm DU without a sixth state. Three placement options were on the table: (a) fold the policy into `ResourceOptions<T>` as an optional field, rejected because `ResourceOptions` would acquire a knob whose absence is not a sensible default for non-browser hosts; (b) ship a sibling subpath import `@causl/sync/revalidate`, the leading candidate if the trigger fires; (c) leave it to the adopter to wire `addEventListener('focus', () => handle.fetch())` themselves, what `@causl/sync` ships today.

**Reopen trigger.** An adopter who needs window-focus revalidation that the loader-as-seam cannot express. Tanner's bar from `SPEC.md` §13.3 holds verbatim: a use case that genuinely cannot fit on the loader-plus-`addEventListener` composition the package supports today, with a named row in §12 the existing surface fails on. A vague "this would be nicer" does not reopen.

### 13.2 Request deduplication beyond per-resource-key identity — DEFERRED

Today: two `resource(g, 'user:1', loader)` calls registered against the same key collide at registration — the second registration throws under the engine's id-collision rule, and the underlying Input node is one node by key identity. That is the only deduplication the adapter ships, and it is structural — the `Graph`'s id-uniqueness invariant is the deduplication mechanism. A consumer that wants two consumers to share one resource shares the *handle*, not a second `resource(...)` call.

NOT shipped: two `useCauslQuery({ url: '/users/1', vars: { id: 1 } })` calls with structurally-identical `vars` deduping to one in-flight request. That is the vars-fingerprint contract — the loader inputs become the cache key. TanStack Query ships this; `@causl/sync` does not. The reason: the loader signature is `(origin: GraphTime) => Promise<T>`, and the loader's *closure* is the input — there is no public, structural, hashable description of "what this loader will do" that the adapter can use as a dedup key without forcing the adopter to round-trip every input through a serialiser. Forcing the adopter through a serialiser would be a `useCauslQuery(fetcher)` shape, which `SPEC.md` §14.2.4 named as the precise feature core does not bundle. The adapter respects that line.

**The shape on the shelf if reopened.** A `resourceFromQuery(graph, queryKey, fetcher)` overload where `queryKey` is a structurally-hashable descriptor, the loader is reduced to a function of `queryKey`, and two `resourceFromQuery(g, ['user', 1], fetchUser)` calls with `dequal(['user', 1], ['user', 1])` collapse to one Input + one in-flight Promise. The implementation is straight composition over the existing `resource(...)` primitive plus a `Map<hash, ResourceHandle<unknown>>` registry keyed on the structural hash of `queryKey`. There is no engine surface change.

**Reopen trigger.** Clearly-needed by 3+ adopters. The 3-adopter floor is borrowed from `SPEC.md` §13.5 / §13.9's pattern: one adopter is an idiosyncrasy, two adopters are a coincidence, three adopters are a use case the package's surface should answer to. Today: zero requests in the closed-PR record.

### 13.3 Optimistic mutations — DEFERRED (via `@causl/sync` extension or sibling adapter)

The conflict registry handles *resolution* — the post-hoc record that one of two converging writes wins, with the loser routed to `Open → Resolved | Ignored | Superseded`. Optimistic-then-rollback is a different pattern: the application writes the predicted value to the engine *before* the network confirms, then either reconciles (the prediction was right, no further commit) or rolls back (the prediction was wrong, a corrective commit lands). The two patterns share the word "conflict" and nothing else.

Today: an adopter wires it manually. The pattern is one `tx.set` call on the optimistic value, then one `tx.set` call on the resolve / reject of the loader. Both calls go through `graph.commit`, both produce the standard observer dispatch, and the §5 atomicity contract holds for each commit independently. The adapter exposes `ResourceHandle<T>.fetch()` and `ResourceHandle<T>.fail()`; the application code's two `tx.set` calls compose with those handles cleanly without a new primitive.

**The shape on the shelf if reopened.** A `mutation(graph, key, options)` primitive whose lifecycle is a four-arm DU `idle | pending | succeeded | failed`, whose handle exposes `mutate(input)` and whose `pending` arm carries the optimistic value plus the rollback patch. It is structurally a sibling to `resource` — same statechart shape, different events, different chart-named transitions. It would either ship inside `@causl/sync` as a third primitive (rejected today on §12.1's two-primitive surface bar) or as `@causl/mutate` (the leading candidate if the trigger fires).

**Reopen trigger.** An adopter whose hand-rolled pattern matures into something worth folding back into the package. The bar is the §13.5 spreadsheet engine bar, repeated: a maintained external pattern, with public reproduction, plus an adopter who would prefer the maintained version to the rolled-by-hand version. None today. Kent Beck's framing on review was the calibration: optimistic mutation is the kind of pattern every team writes once and discovers their version was correct enough; the package should not pre-empt that discovery.

### 13.4 Multi-key resource family — DEFERRED

Today: `resource(g, 'user:1', loader)` is one resource. An adopter who needs `user:1`, `user:2`, `user:3`, … as a family of resources writes a wrapper that registers each on demand and tracks the ones registered so far. The wrapper is roughly fifteen lines, calls the existing `resource` primitive once per id, and stores the handles in a `Map<id, ResourceHandle<T>>`. The adapter does not ship this wrapper.

NOT shipped: `resourceFamily(graph, 'user', userIdToLoader)` — a factory that produces a per-id `ResourceHandle<T>` on demand, with refcounted lifecycle (microtask-deferred disposal when no consumer remains), and id-prefixed namespace under the family's root key. The shape mirrors `useCauslFamily` from `@causl/react` (`SPEC.md` §13.3's table row 1). The reason it does not ship is the §10 worked-example bar: the v1 release does not have a fixture proving the family's lifecycle interacts correctly with the conflict registry's open-set computation across family-keyed resolution ids, and shipping the family without that proof would be a deferred PLANNED row pretending to be a shipping row.

**The shape on the shelf if reopened.** A `resourceFamily(graph, rootKey, idToLoader)` factory whose handle is a `ResourceFamilyHandle<T>` exposing `get(id): ResourceHandle<T>` and `all(): readonly ResourceHandle<T>[]`. Internal storage is a `Map<id, ResourceHandle<T>>` with refcounting on `subscribe` / `unsubscribe`. Disposal is microtask-deferred on refcount-zero (the §6 RetentionWindow region's pattern).

**Reopen trigger.** An adopter whose pattern reproduces faithfully across two or more codebases, plus a measurement showing the hand-rolled wrapper's overhead exceeds the engine's `O(|affected|)` ceiling — i.e., the family lifecycle is doing observer dispatch the adapter could fold. The measurement bar is `SPEC.md` §14.1's framing applied: the recompute count is the metric, and the family wrapper that costs `O(|family|)` to dispatch a single child's update is the row that earns the reopen.

### 13.5 Subscriptions / Server-Sent Events as a typed channel — DEFERRED

Today: an adopter wires SSE → `tx.set` manually. The pattern is one `EventSource` on the application side, one `eventSource.addEventListener('message', e => graph.commit(({ tx }) => tx.set(node, JSON.parse(e.data))))` per channel, and the engine's commit pipeline does the rest. The Promise / Event bridge from §3 is the equation that licences this pattern: an SSE message arrival is an Event, the Event becomes one commit through `graph.commit`, and the resource's underlying Input transitions through the existing five-arm DU's events (the host calls `handle.fail()` on transport error, calls a host-side mutator on message arrival).

NOT shipped: `subscription(graph, key, openWebSocket)` — a typed channel where the loader equivalent is `(send: (value: T) => void, fail: (e: unknown) => void) => () => void` (a callback-based open returning a teardown), and the lifecycle is a six-arm DU adding `connected | disconnected` to the existing five. The shape is well-formed — it composes the same two-Input, two-Derived structure the conflict registry uses, and registers through the public Graph API without a new node kind. The reason it does not ship is the `SPEC.md` §2 commitment ("a websocket protocol is what this is not"); shipping `subscription` would force the adapter to take a position on reconnect logic, heartbeats, and backpressure, which the §2 commitment explicitly disclaims.

**The shape on the shelf if reopened.** A maintained sibling pattern under `@causl/subscription` (the leading candidate for a separate package), or a subpath import `@causl/sync/subscription` if the trigger fires light enough that a sibling package would be over-engineering. The `subscription` primitive's underlying chart is `idle | connecting | connected | disconnected | errored | closed`, with closed transitions named `open-begin | open-resolve | open-reject | message-arrive | transport-fail | host-close`.

**Reopen trigger.** A maintained sibling pattern with reproduction across two or more codebases, plus an adopter who would prefer the maintained version to the rolled-by-hand version. The pattern bar is the §13.3 framing applied: an external pattern that has matured past the rolled-by-hand stage and is now paying support cost the adapter could absorb.

### 13.6 Conflict resolution UI primitives — NOT-PLANNED

The registry supplies the data — `ConflictRegistry<T>.read()` returns the current `Conflict<T>[]`, which subscribes through the existing `subscribe` surface — and the application renders that data however the application's UI library asks. The adapter does not ship a `<ConflictResolverDialog>` React component, does not ship a default conflict-row template, does not ship a Tailwind class set, and does not ship an accessibility pattern for "decide which write wins." The UI is the application's.

The reason this is NOT-PLANNED rather than DEFERRED is the §14.2.4 bundled-`<CauslDevtools>` argument applied to the conflict domain: a UI component pulls in rendering, styling, and accessibility concerns that balloon past the bundle budget within two minor versions, and the rendering decisions are application-specific in a way that no maintained default could honestly serve. Trygve Reenskaug's read on review was the load-bearing one: the registry is the *model*, and the model is the model — the view is the application's domain, and shipping a view that pretends to be neutral is shipping a view that is wrong about every adopter's brand, layout, and accessibility constraints.

**Reopen trigger.** None.

### 13.7 Cross-graph conflict registry — NOT-PLANNED

A conflict registry that spans two `createCausl()` instances — i.e., one registry tracking conflicts where the resolution Input lives in graph A and the open-set computation reads from graph B — references the same multi-graph composition row `SPEC.md` §13.3 names as NOT-PLANNED. The reason is identical: the §3 single-time invariant is what licences the conflict registry's chart, and a registry whose two underlying Inputs live in different `GraphTime` lines is reading two clocks that have no shared `t` to evaluate at. Theorem 1 (origin-bound resolution) becomes ill-typed, the same way `SPEC.md` §13.3's product-timeline rejection names it ill-typed for the engine itself.

The composed-pipeline shape — a coordinator graph whose Inputs are deltas from sibling graphs, with the registry living on the coordinator — is the same `@causl/coordinator` shape `SPEC.md` §13.3 names as the engineered shape if multi-graph composition reopens. The conflict registry would compose into that coordinator without a separate cross-graph registry primitive; the registry sits on a single `Graph`, and the coordinator is the graph that hosts it.

**Reopen trigger.** Same as `SPEC.md` §13.3 — a use case that genuinely cannot fit on a single graph with `useCauslFamily` plus capability narrowing plus per-process engines, AND names the specific row in §12 the existing surface fails on, AND sketches the §3 multi-time extension the use case implies. All three conditions, not any one. None today.

### 13.8 What the team rejected and why

Promoting any §13.1–§13.5 row to a v1 deliverable — the reasoning is the §13.10-equivalent argument from the engine spec: a feature pre-engineered without a use case is a feature the test surface cannot honestly cover. Folding optimistic mutations into the conflict registry — rejected because the registry's chart is *resolution*, not *prediction*, and overloading one primitive with two charts is the precise §6 violation the four-region composite chart was drawn to prevent. Shipping a `<ConflictResolverDialog>` as a default UI — rejected per Trygve's framing above: the registry is the model, and the view is the application's. Shipping a websocket protocol — rejected per the `SPEC.md` §13.6 / §13.9 framing applied: the protocol is the application's, and a "default" protocol is the same trap as a default UI in a different domain.

The pattern across the rejected rows is one rule: a row earns DEFERRED status only if the design fits behind the existing two-primitive surface without inventing a third arm to the engine's `Node` union or a third operation to the `Graph` mutation surface. A row earns NOT-PLANNED status when the design either contradicts §3's single-time invariant or replicates a domain the application owns by structural commitment. The rule is the §13 discipline made concrete; the table above is the rule applied row by row.

---

## 14. Perceptual perf

The two correctness criteria from `SPEC.md` §3 are the only criteria this section commits to. The adapter does not ship a perf table — no node counts, no millisecond budgets, no scaling curves — for the same reason `SPEC.md` §14 cut its perf table: a number printed as a target without a benchmark behind it is an aspiration with a fixed-pitch font. The numbers, when they exist, live in `docs/benchmark.md`. SPEC.async §14 commits only to the two criteria the §3 denotational equation forces, applied to the adapter's primitives.

The two criteria, restated against the adapter's surface:

1. **A resource's resolve commit produces `O(|dependents|)` Derived recomputes, not `O(|all resources|)`.** The §3 equation `derived(t) = f(b₁(t), ..., bₙ(t))` is the *meaning*, not the *plan*; the engine walks only the dirty sub-graph, and the adapter's resolve commit does not add a fan-out the engine's walk would not perform anyway. A resource that has zero subscribers and zero dependents costs the dispatch a one-node update; a resource that has fifty derived dependents costs fifty recomputes. The adapter does not introduce a path that touches resources outside that affected set.
2. **A subscribing component re-renders only when the resource state changes.** Same denotational rule, different observer. A component that reads `resource.read().state === 'loaded' ? value : null` re-renders when the resource transitions in or out of the `loaded` arm; switching between two `loading` arms with structurally-equal Promise identity must NOT re-render. The Theorem 3 (Promise identity stability) commitment from §3 is the thing that makes this re-render gate a structural property, not a debouncing heuristic.

Sebastian Markbåge's framing from `SPEC.md` §14, applied to the adapter: the work the adapter does inside the resolve commit is the work the renderer cannot defer, and a renderer that targets 60fps on a real workload is structurally compatible only with an adapter whose resolve cost is bounded by the affected set. A resource that is read by one component must dispatch to that one component, not to every component reading any resource.

### 14.1 Translating the two criteria into CI gates for the adapter

Two pinned-count gates on the same shape `SPEC.md` §14.1 names for the engine:

| Criterion | Gate | Anchor |
| --- | --- | --- |
| Resource resolve: `O(|dependents|)` recompute | `perf-invariant — SPEC.async §14 gate` | `pnpm --filter @causl/sync run test:perf-invariant` runs `packages/sync/test/perf-resource-recompute.test.ts` (pinned counts). |
| React: re-render scope across the loading arms | `perf-invariant — SPEC.async §14 React subscription gate` | `pnpm --filter @causl/sync run test:perf-invariant` runs the `loading-arm-stability` and `resolve-then-loaded` legs against the `useCauslSuspense` integration fixture. |

The pinned-count discipline is `SPEC.md` §14.1's discipline applied: the gate is an *assertion* against a specific recompute count, not a percentile against a noisy distribution. A resolve commit whose affected set is twelve nodes asserts twelve recomputes. A thirteenth recompute is a regression; an eleventh is a separate regression (the dispatch missed a dependent). The gate fails closed in either direction.

The React leg is the structural one: the same fixture mounts a component that reads the resource through `useCauslSuspense`, advances the resource through one `loading → loaded` transition, and asserts the component re-renders exactly once across the transition. A regression that re-creates the Promise reference per render — the §9.1 row 17 race — fails this gate at the Promise-identity assertion before the re-render-count assertion gets to fail. Theorem 3 is the contract the gate holds the adapter to.

The 60fps end-to-end gate sits one layer up, in `@causl/react`'s e2e suite; this section does not duplicate it. The adapter's CI gate stops at the recompute-count and re-render-count assertions; the dropped-frame ratio is a downstream concern.

**What the team rejected and why.** Three options for the adapter's CI shape sat in front of the team. **Percentile-based gates against a millisecond budget** — rejected on the same grounds `SPEC.md` §14.1 rejects them for the engine: a CI-friendly p95 threshold needs a stable shared runner the team does not have, or a noise-tolerant statistical model that weakens the gate to uselessness. **No CI gate, leave perf to manual benchmarking** — rejected because the §3 affected-set property is structural, not aspirational, and a structural property without a CI gate decays into a structural property nobody runs. **Pinned-count assertion against the `O(|dependents|)` invariant** — what the team picked, and what `SPEC.md` §14.1 picked for the engine. Same discipline, applied to the adapter.

### 14.2 Bundle budget for `@causl/sync`

`SPEC.md` §14.2's table-based discipline is the bar: every kilobyte over the floor ships with a written team consensus, production bytes pay only for invariants the type system cannot express, and the working target is a number the team can defend out loud while the ceiling bounds the discipline. Applied to `@causl/sync`, the numbers come out of the actual code surface today.

The code surface is two source files — `packages/sync/src/resource.ts` at ~363 lines and `packages/sync/src/conflict.ts` at ~546 lines — plus a barrel `index.ts` and the two sub-import entry shims `resource-entry.ts` and `conflict-entry.ts`. The five-arm `ResourceState<T>` DU, the `ResourceHandle<T>` interface, and the `ForbiddenResourceTransitionError` class together account for the bulk of `resource.ts`; the four-arm `Conflict<T>` DU, the `ConflictBase<T>` shared shell, the two `Pick<Graph, ...>` capability-narrowed type aliases, the `createConflictRegistry` factory, the `ForbiddenConflictTransitionError` class, and the `singleConflictWhen` helper account for the bulk of `conflict.ts`.

The minified weight of those 870-odd lines (after `tsc → esbuild → minify`) lands the working target at **8 KB** — comfortably under the engine's 18 KB working target, which is the right calibration for a sibling adapter that compose atop core. The ceiling is **12 KB** — 50% headroom over the working target, sufficient to absorb one cycle's worth of additions without forcing a budget-renegotiation PR.

The 8 KB / 12 KB calibration is justified against three reference points:

1. **The engine itself ships at ~8.8 KB production with the §14.2.1 five additions** (`SPEC.md` §14.2.1's footing). An adapter that ships heavier than the engine inverts the layering — adopters install the engine first, the adapter second, and the adapter weighing more than the engine signals the adapter is doing work the engine should be doing. Eight KB keeps the layering honest.
2. **TanStack Query at 13.4 KB ships dehydration, hydration, optimistic updates, and devtools wiring.** `@causl/sync` at 8 KB ships two primitives, two error classes, and two type aliases. The Query bar is the right one for a maintained adapter; landing under the Query bar by ~5 KB is the calibration that says "this package is structurally narrower than Query and the bytes prove it."
3. **The 12 KB ceiling absorbs §13's reopen rows without renegotiation.** The §13.4 multi-key resource family adds ~1.5 KB; the §13.1 `revalidate` policy adds ~0.5 KB; the §13.3 mutation primitive adds ~2 KB. The ceiling absorbs the first two without crossing 12 KB; the third forces the §14.2 written-consensus PR. That is the right friction surface.

**Three options for the bundle ceiling shape** sat in front of the team:

(a) **One number for the whole adapter** — a single `@causl/sync (full import)` ceiling at 12 KB. Rejected because adopters who only need `resource(...)` pay for `createConflictRegistry(...)`'s code path, and the conflict registry is the heavier of the two primitives at 526 lines. The single-ceiling shape forces the lighter consumer to pay for the heavier consumer's surface, which is the precise §14.2 discipline rejection (production bytes pay for invariants this consumer does not need).

(b) **Per-primitive sub-imports** — `@causl/sync/resource` and `@causl/sync/conflict` as separate tree-shakeable entries, neither over the combined-import ceiling. **Picked.** The shape mirrors `@causl/core (createCausl-only)` from `SPEC.md` §14.2.2's table — a tree-shakeable entry per primitive, with a working-target ceiling per entry, and a combined ceiling on the full barrel. Adopters who only need `resource(...)` import from `@causl/sync/resource` and pay the sub-import ceiling; adopters who only need the conflict registry import from `@causl/sync/conflict` and pay the sub-import ceiling; adopters who need both pay the combined ceiling. The tree-shaking is honest because the two primitives share zero runtime code.

(c) **Deep-imports forbidden, single-import only** — only `import { resource, createConflictRegistry } from '@causl/sync'` is supported, with the unused primitive dead-code-eliminated by the bundler. Rejected because dead-code elimination is bundler-dependent, and an adopter on a bundler that cannot DCE the unused primitive (Webpack 4, esbuild without sideEffects, etc.) silently pays the full combined ceiling. Per-primitive sub-imports make the cost explicit; DCE makes the cost implicit-and-fragile.

The shipped shape is (b). The two `package.json` `exports` keys are `./resource` and `./conflict`; the barrel `.` re-exports both. The `size-limit` config in root `package.json` adds three rows for `@causl/sync`. **Current state (as of v0.9.0).** The shipped size-limit cells are `@causl/sync (full import)` at 12 KB, `@causl/sync/resource (resource-only)` at 8 KB, and `@causl/sync/conflict (conflict-only)` at 8 KB. The earlier draft of this section anchored the sub-imports at 5 KB / 7 KB (matching a 12 KB combined cap exactly); the shipped cells use 8 KB / 8 KB sub-imports, which keeps the per-cell headroom symmetric and matches the §14.2 written-consensus discipline (the cells in root `package.json` are the truth, this spec text describes the intent). The combined 12 KB ceiling is unchanged; each row is a CI gate.

**The §14.2 written-consensus rule applies.** A PR that crosses any of the three ceilings fails `size — bundle-size gate` and must include a written team consensus the same way `SPEC.md` §14.2.1's five additions did, or the size-limit bump is rejected.

### 14.3 What the team rejected

Three calibrations sat in front of the team. **Pin to the engine's 18 KB target** — rejected because the adapter is structurally narrower than the engine and a target borrowed from the engine is a target padding to. Tanner's framing on `SPEC.md` §14.2's bar applies: an adapter whose target is "as much as the engine" is an adapter that has not measured itself. **Pin to TanStack Query's 13.4 KB** — rejected because the Query surface is wider (dehydration + hydration + optimistic updates + devtools) and the calibration borrows a number whose denominator does not match. **8 KB working / 12 KB ceiling, derived from the actual code surface** — what the team picked. The 8 KB is the measured weight of the two primitives at the surface they ship today; the 12 KB is the calibrated headroom for one cycle's additions; the gap is the team's defended discipline.

The per-primitive sub-import shape was the second decision the team weighed. Three options (a/b/c above), one picked. The reason (b) wins is `SPEC.md` §12.2's audit discipline applied to the bundle: a public surface row that adopters pay for whether they use it or not is a row the audit fails. Per-primitive sub-imports make the "pay for what you use" rule structural rather than DCE-dependent.

---

## 15. Fuzz / property-based testing

`SPEC.md` §15's framing applies: property-based tests are the race-detection layer for everything the type system and the API shape do not catch, applied to the adapter's two primitives. The adapter does not invent a parallel test infrastructure; it imports `propertyTrials` from `@causl/core/testing`, and every `*.property.test.ts` under `packages/sync/test/properties/` is enrolled by the conformance walker (`packages/core/test/spec-15.2-conformance.test.ts`, broadened in #437) the same way every engine-side property suite is.

The 1000-trial floor from `SPEC.md` §15.2 is the shared default. The adapter does not lower it; the seam refuses to construct a runner with `numRuns < 1000` outside the documented `unsafeTrials` escape. Sandi Metz's framing — property tests are the type system's runtime answer to questions the type system cannot ask — is the load-bearing one for the adapter's properties, because the adapter's lifecycle invariants (origin-bound resolution, Promise identity stability, single-writer resolution) are precisely the questions `tsc` cannot answer at the call site. Corey Haines's deliberate-practice framing keeps the trial budget honest: a property suite that runs 100 trials per CI run is a suite that has not yet learned what its property is for.


### 15.0 Property predicates formalised

The eight properties §15.1 and §15.2 name in prose are predicates the team has not yet committed to in TypeScript. Sandi's framing on this — "make the test prove the rule, not the example" — is the load-bearing one: a property suite written from prose is a suite that proves whatever the first contributor's example happened to exercise. The predicate has to land as a signature; the generator has to land as an `fc.Arbitrary<T>`; the falsifying shape has to land as a concrete trace the next contributor can read without re-deriving the chart. Corey's deliberate-practice framing is the discipline that keeps this honest: a property whose generator is a one-liner is a property whose author has not yet thought about what the property is for. We formalise all eight here so the §15.1 / §15.2 prose has a runtime shape under it, and the `*.property.test.ts` files under `packages/sync/test/properties/` consume the formalisation rather than re-inventing it.

All eight predicates share one structural commitment: they are total functions over their generator's output space, returning `boolean` (or throwing for the forbidden-transition properties, where the throw IS the predicate's positive answer). None of them branches on a runtime fact the generator did not produce. None of them admits a "skip this case" shape — fast-check shrinking should never land on a sample the predicate does not have a defined answer for.

#### Property 1 — Lifecycle exhaustiveness

```ts
type ResourceEvent =
  | { kind: 'fetch' }
  | { kind: 'invalidate' }
  | { kind: 'fail'; error: unknown }
  | { kind: 'resolve'; value: unknown }
  | { kind: 'reject'; error: unknown }
  | { kind: 'commit-elsewhere' }

const VALID_TAGS = ['idle', 'loading', 'loaded', 'stale', 'errored'] as const

const lifecycleExhaustiveness =
  (events: ResourceEvent[]): boolean => {
    const { handle, graph } = propertyResource<number>()
    applyEvents(handle, graph, events)
    const tag = graph.read(handle.node).state
    return (VALID_TAGS as readonly string[]).includes(tag)
  }

const resourceEventGen = (): fc.Arbitrary<ResourceEvent> =>
  fc.oneof(
    fc.constant({ kind: 'fetch' as const }),
    fc.constant({ kind: 'invalidate' as const }),
    fc.record({ kind: fc.constant('fail' as const), error: fc.anything() }),
    fc.record({ kind: fc.constant('resolve' as const), value: fc.integer() }),
    fc.record({ kind: fc.constant('reject' as const), error: fc.anything() }),
    fc.constant({ kind: 'commit-elsewhere' as const }),
  )

it('lifecycle is exhaustive over five arms (≥1000 cases)', () => {
  fc.assert(
    fc.property(
      fc.array(resourceEventGen(), { maxLength: 32 }),
      lifecycleExhaustiveness,
    ),
    propertyTrials('resource.lifecycle-exhaustiveness'),
  )
})
```

A counterexample is a trace whose final state tag is anything other than the five named arms.

#### Property 2 — Origin-bound resolution (Theorem 1 made executable)

```ts
type LoadingEpisode = {
  readonly origin: GraphTime
  readonly interleaved: readonly { kind: 'commit-elsewhere' }[]
  readonly resolvesWith: { ok: true; value: number } | { ok: false; error: unknown }
}

const originBoundResolution =
  (episode: LoadingEpisode): boolean => {
    const { handle, graph } = propertyResource<number>()
    const fetchPromise = handle.fetch()
    for (const e of episode.interleaved) graph.commit('elsewhere', () => {})
    settleEpisode(handle, episode.resolvesWith)
    const post = graph.read(handle.node)
    if (!episode.resolvesWith.ok) return post.state === 'errored'
    const expectedStale = episode.interleaved.length > 0
    return expectedStale
      ? post.state === 'stale' && post.origin === episode.origin && post.loadedAt > episode.origin
      : post.state === 'loaded' && post.origin === episode.origin && post.loadedAt === episode.origin
  }

it('loading resolves to loaded iff origin === graph.now (≥1000 cases)', () => {
  fc.assert(
    fc.property(loadingEpisodeGen(), originBoundResolution),
    propertyTrials('resource.origin-bound-resolution'),
  )
})
```

#### Property 3 — Forbidden transitions throw

```ts
const forbiddenTransitionsThrow =
  (sample: { primingEvents: ResourceEvent[]; failError: unknown }): boolean => {
    const { handle, graph } = propertyResource<number>()
    applyEvents(handle, graph, sample.primingEvents)
    const tag = graph.read(handle.node).state
    if (tag === 'loading' || tag === 'loaded') {
      handle.fail(sample.failError)
      return graph.read(handle.node).state === 'errored'
    }
    try {
      handle.fail(sample.failError)
      return false
    } catch (e) {
      return (
        e instanceof ForbiddenResourceTransitionError &&
        e.from === tag &&
        e.to === 'errored' &&
        e.id === handle.key
      )
    }
  }
```

#### Property 4 — Promise identity stability (Theorem 3 made executable)

```ts
const promiseIdentityStability =
  (schedule: ReadSchedule): boolean => {
    const { handle, graph } = propertyResource<number>()
    handle.fetch()
    const promisesEpisodeA: Promise<unknown>[] = []
    for (let i = 0; i < schedule.readsBeforeResolve; i++) {
      const s = graph.read(handle.node)
      if (s.state !== 'loading') return false
      promisesEpisodeA.push(s.promise)
    }
    settleEpisode(handle, { ok: true, value: 1 })
    handle.fetch()
    const promisesEpisodeB: Promise<unknown>[] = []
    for (let i = 0; i < schedule.secondEpisodeReadsBeforeResolve; i++) {
      const s = graph.read(handle.node)
      if (s.state !== 'loading') return false
      promisesEpisodeB.push(s.promise)
    }
    const allEqualWithinA = promisesEpisodeA.every((p) => p === promisesEpisodeA[0])
    const allEqualWithinB = promisesEpisodeB.every((p) => p === promisesEpisodeB[0])
    const aDifferentFromB =
      promisesEpisodeA.length === 0 || promisesEpisodeB.length === 0 ||
      promisesEpisodeA[0] !== promisesEpisodeB[0]
    return allEqualWithinA && allEqualWithinB && aDifferentFromB
  }
```

#### Property 5 — Lifecycle exhaustiveness (Conflict)

```ts
type ConflictEvent =
  | { kind: 'raise'; id: NodeId; target: NodeId; value: number }
  | { kind: 'unraise'; id: NodeId }
  | { kind: 'resolve'; id: NodeId; resolution: unknown }
  | { kind: 'ignore'; id: NodeId }
  | { kind: 'supersede'; id: NodeId; bySupersedingId: NodeId }

const VALID_KINDS = ['open', 'resolved', 'ignored', 'superseded'] as const

const conflictLifecycleExhaustiveness =
  (events: ConflictEvent[]): boolean => {
    const { registry, graph } = propertyConflict<number>()
    applyConflictEvents(registry, graph, events)
    const list = registry.read(graph)
    return list.every((c) => (VALID_KINDS as readonly string[]).includes(c.kind))
  }
```

#### Property 6 — Forbidden transitions throw (Conflict)

The predicate is the conflict-side mirror of Property 3. The legal partition is `Open → resolved | ignored | superseded`; every other source state (the three terminals + the synthetic `unknown`) throws `ForbiddenConflictTransitionError`.

#### Property 7 — Single-writer resolution

```ts
const singleWriterResolution =
  (sample: {
    raiseValue: number; firstResolution: unknown; secondResolution: unknown
  }): boolean => {
    const { registry, graph } = propertyConflict<number>()
    applyConflictEvents(registry, graph, [
      { kind: 'raise', id: 'c1', target: 'n1', value: sample.raiseValue },
    ])
    registry.resolve(graph, 'c1', sample.firstResolution)
    let threw = false
    try {
      registry.resolve(graph, 'c1', sample.secondResolution)
    } catch (e) {
      threw = e instanceof ForbiddenConflictTransitionError
    }
    if (!threw) return false
    const overlay = registry.read(graph).find((c) => c.id === 'c1')
    if (!overlay || overlay.kind !== 'resolved') return false
    return overlay.resolution === sample.firstResolution
  }
```

#### Property 8 — Open-set computation correctness

```ts
const openSetComputationCorrect =
  (sample: OpenSetSample): boolean => {
    const { registry, graph, sourceInput } = propertyConflictWithMap<number>(sample.openIds)
    graph.commit('seed', (tx) => tx.set(sourceInput, sample.inputMap))
    for (const r of sample.resolutions) {
      try {
        applyResolutionRecord(registry, graph, r.id, r.record)
      } catch { /* not currently open — ignore */ }
    }
    const overlay = registry.read(graph)
    const overlayIds = new Set(overlay.map((c) => c.id))
    const expectedIds = new Set(sample.openIds)
    if (overlayIds.size !== expectedIds.size) return false
    for (const id of expectedIds) if (!overlayIds.has(id)) return false
    for (const c of overlay) {
      const record = sample.resolutions.find((r) => r.id === c.id)?.record
      const expectedKind = record?.kind ?? 'open'
      if (c.kind !== expectedKind) return false
    }
    return true
  }
```

#### `@causl/sync-testing-internal` API sketch

```ts
// @causl/sync-testing-internal/src/index.ts
export const resourceEventGen: () => fc.Arbitrary<ResourceEvent>
export const conflictEventGen: () => fc.Arbitrary<ConflictEvent>
export const conflictIdGen: () => fc.Arbitrary<NodeId>
export const loadingEpisodeGen: () => fc.Arbitrary<LoadingEpisode>
export const readScheduleGen: () => fc.Arbitrary<ReadSchedule>
export const openSetSampleGen: () => fc.Arbitrary<OpenSetSample>

export const propertyResource: <T>() => {
  graph: Graph
  handle: ResourceHandle<T>
  settle: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => void
}
export const propertyConflict: <T>() => {
  graph: Graph
  registry: ConflictRegistry<T>
  raise: (id: NodeId, target: NodeId, value: T) => void
  unraise: (id: NodeId) => void
}
export const propertyConflictWithMap: <T>(openIds: readonly NodeId[]) => {
  graph: Graph
  registry: ConflictRegistry<T>
  sourceInput: InputNode<ReadonlyMap<NodeId, T>>
}

export const applyEvents: (
  handle: ResourceHandle<unknown>, graph: Graph,
  events: readonly ResourceEvent[],
) => void
export const applyConflictEvents: (
  registry: ConflictRegistry<unknown>, graph: Graph,
  events: readonly ConflictEvent[],
) => void

export const preserveLoadingEpisode: <T>(arb: fc.Arbitrary<T>) => fc.Arbitrary<T>
export const preserveOpenPriming: <T>(arb: fc.Arbitrary<T>) => fc.Arbitrary<T>
```

The package sits under `packages/sync-testing-internal/`, ships only as a workspace dependency of `packages/sync/`, and is excluded from the public bundle the same way `@causl/core-testing-internal` is. Adopters never import from it; the property suite is its only consumer.

#### Note on shrinking

Fast-check's default shrinker walks the generator's structural decomposition, removing array elements and contracting integer ranges towards zero. Two of our properties have arrows the shrinker can break without the testing harness telling it not to:

- **Property 2 (origin-bound resolution).** The shrinker can collapse `interleaved.length` to zero, which is fine — the property has a defined answer for the zero case (`loaded`, not `stale`). What the shrinker MUST NOT do is reorder the loader settlement before the interleaved commits — the loading-episode boundary is the chart shape under test. `preserveLoadingEpisode` wraps the generator in a `fc.Arbitrary` whose shrink function only contracts the interleaved sequence's length, never reorders the boundary events.

- **Property 6 (conflict forbidden transitions).** The shrinker can collapse `priming.length` towards zero, which lands the source state at `unknown` — a legitimate non-Open state the property has a defined answer for. What the shrinker MUST NOT do is shrink an `Open` priming sequence into one whose target conflict id never appears in the open set. `preserveOpenPriming` keeps a single `raise` event for the target id pinned in the priming sequence's prefix; the shrinker contracts everything else.

#### Generators are the contract

The eight predicates above are not the contract on their own. The predicate is one half; the generator is the other half, and the generator is the half that decides what "for all inputs" actually quantifies over. `fc.array(resourceEventGen(), { maxLength: 32 })` is a different property than `fc.array(resourceEventGen(), { maxLength: 4 })` even though the predicate body is identical — the first probes interleaved multi-episode traces, the second never reaches a second loading episode. A property suite whose generator is thin gives a guarantee that is thin in exactly the same shape. Corey's deliberate-practice framing is the discipline that keeps the generator's coverage honest: every property review asks "what does this generator NOT produce?" and answers that question in the property's docstring. The generator is the contract the property suite signs with the chart, and the chart pays the property suite back exactly to the extent the generator covers it.

### 15.1 Properties for Resource

Four properties anchor the `Resource<T>` chart against the §3 / §6 commitments:

- **Property 1 — Lifecycle exhaustiveness.** Random sequences of `fetch / invalidate / fail / resolve / reject` events, applied to a fresh resource, produce only states from the five-arm DU `idle | loading | loaded | stale | errored`. The property exists because the chart is closed by construction, and the property is the runtime witness that no fuzzer-discovered sequence reaches a sixth state. A counterexample at this property is a chart-violation bug in `resource.ts`'s transition table.
- **Property 2 — Origin-bound resolution (Theorem 1 made executable).** A loading episode at origin `t` resolves to the `loaded` arm if `graph.now === t` at resolution; resolves to the `stale` arm if `graph.now > t` at resolution. The equality check is total over the event space: there is no third branch, no timeout-tolerance window, no "approximately equal" guard. The property generates random commit sequences between the loader's `fetch-begin` and the loader's resolution, and asserts the post-resolution arm matches the equality check exactly. A counterexample is a §9.1 row 6 regression — the stale-async race reopened.
- **Property 3 — Forbidden transitions throw.** Random calls from non-legal source states (`Idle → Errored`, `Stale → Errored`, `Errored → Errored`, the three transitions §4 names as illegal) throw `ForbiddenResourceTransitionError` with the typed `{ from, to, event, key }` payload. The property generates random `(state, event)` pairs, partitions them into legal / illegal, applies the event to a resource in that state, and asserts the legal ones succeed and the illegal ones throw the typed error. A counterexample is an off-chart write — the §17 commitment 7 violation made structural.
- **Property 4 — Promise identity stability (Theorem 3 made executable).** A loading episode's `promise` reference is `===` across all renders / reads while the resource is in the `loading` arm; flips to a NEW reference exactly when a new fetch begins. The property generates random read sequences from random observers during a single loading episode and asserts pointer-equality across every read; then advances to a new fetch and asserts pointer-inequality with the previous episode's promise. A counterexample is a §9.1 row 17 regression — the Suspense fresh-Promise-per-render race reopened.

### 15.2 Properties for Conflict

Four properties anchor the `Conflict<T>` chart and the registry's overlay computation against the §3 / §6 commitments:

- **Property 5 — Lifecycle exhaustiveness.** Random sequences of `resolve / ignore / supersede` events, applied to a fresh conflict id, produce only states from the four-arm DU `open | resolved | ignored | superseded`. A counterexample is a fifth arm reachable through a fuzzer-discovered sequence — the §4 four-arm DU commitment violated.
- **Property 6 — Forbidden transitions throw.** Random calls from non-legal source states throw `ForbiddenConflictTransitionError` with the typed `{ from, to, event, conflictId }` payload. A counterexample is an off-chart write on the conflict side — the §17 commitment 7 violation, conflict-side.
- **Property 7 — Single-writer resolution.** A second `resolve()` call on the same conflict id overwrites the first; the registry tracks one resolution record per conflict id, not a list. A counterexample is a multi-writer accumulation — the `SPEC.md` §13.7 multi-user-synchronisation row leaking into the single-user adapter.
- **Property 8 — Open-set computation correctness.** For random Input maps and random open-set predicates, the public overlay derived produces exactly the conflict ids the predicate names. A counterexample is an overlay glitch — the §4 derived-view commitment failing on the conflict primitive.

### 15.3 Trial floor

The 1000-trial default is the floor, shared with `SPEC.md` §15.2. The adapter does not lower it. The nightly tier bumps to 10,000 the same way `SPEC.md` §16A.3's tier 2 bumps the engine-side property floor; the adapter inherits the bump under the same `MODEL_CHECK_TIER=2` env switch the engine respects.

The seam is `propertyTrials(label, options?)` from `@causl/core/testing`. The defaults: `numRuns: 1000`, env-driven seed via `CAUSL_FUZZ_SEED`. The seam throws at construction if a caller passes `{ numRuns: N }` with `N < 1000`; the only escape is `unsafeTrials: N` with documented rationale. The conformance walker at `packages/core/test/spec-15.2-conformance.test.ts` walks every `*.property.test.ts` at any depth, every file under any `test/properties/` directory, and every other `*.test.ts` containing a literal `fc.assert(` token — so a contributor copy-pasting `numRuns: 100` into a property suite under `packages/sync/test/` no longer slips past CI by virtue of living in the adapter package rather than the engine.

### 15.4 What the team rejected

The §15 discipline applied to the adapter rejects the same shapes the engine spec rejects, plus three adapter-specific shapes:

- **Stateful fuzz of the engine commit pipeline from inside the adapter's test suite.** Rejected because the engine's commit pipeline is the engine's responsibility per `SPEC.md` §15. The adapter's properties exercise the chart shapes the adapter ships, not the pipeline the engine ships.
- **Network-level fuzz** — random `fetch()` interception, random HTTP status codes, random websocket disconnects, random bandwidth throttling. Rejected because the loader is the seam (§1), the network is not part of the adapter's surface (§2), and a fuzz layer that targets the network is targeting a layer the adapter does not own.
- **Property suites that depend on a real backend** — a property test that opens an actual HTTP connection to a test server. Rejected because the property suite must be deterministic (`SPEC.md` §15.2's seed-deterministic rule), and a real backend introduces non-determinism the property suite cannot reproduce. The property suite uses fake loaders that resolve on `Promise.resolve(value)` or `Promise.reject(error)` under controlled microtask ordering.

The pattern across the rejected shapes is one rule: a property suite tests the chart, not the network, and the chart is the abstraction the adapter ships.

---

## 16. IR support — `@causl/sync` and `causl-check`

`SPEC.md` §16 / §16A define what the IR linter understands and what it does not, and the adapter's IR commitment is structural: the adapter does not invent a third arm of the IR's `kind: 'input' | 'derived'` discriminator. Every node the adapter registers is one of the two existing kinds. The §4 two-primitive collapse from `SPEC.md` is the commitment the adapter respects; the §16A.1 layer-classification table is the contract the adapter's race-class catalogue maps onto.

### 16.1 The adapter's IR commitment

Three structural facts:

1. **A `Resource<T>` is an Input node carrying a `ResourceState<T>` union.** The IR sees it as `kind: 'input'` per `SPEC.md` §4. The five-arm DU lives on the Input's value, not on a separate node kind. A static linter walking the IR sees one input row per resource — the same shape it would see for any other Input — and the discriminator on the value is opaque to the linter.
2. **A `ConflictRegistry<T>` is two Inputs + two Deriveds.** The two Inputs are the resolution map (keyed by conflict id) and the open-set computation's input dependencies; the two Deriveds are the application-supplied open-set compute and the public overlay node that produces the `Conflict<T>[]` stream. All four register through public Graph APIs; none of them is a fifth node kind. The IR linter sees four rows per registry — two inputs, two deriveds — same shape it would see for any other four-node sub-graph.
3. **The Causl static linter (`causl-check`) does not understand resources or conflicts directly.** The linter walks the IR, runs the eight one-shot passes from `SPEC.md` §16.1 plus the four §16A.2 additions, and emits violations against the structural shape. There is no `causl-check` pass that knows the adapter's chart; there is no pass that decodes the `ResourceState<T>` union into its arms. The linter's structural passes apply uniformly across engine-registered and adapter-registered nodes.

### 16.2 The §16A static layer's adapter-relevant rules

Two §16A.2 passes catch the adapter's most common race patterns:

- **`SubscribeWithoutDispose`.** Every `IRSubscribe { id, scope }` must have a matching `IRDispose { id }` reachable in the same scope lifetime. Applied to the adapter: a component that subscribes to a `resource(...)` node must dispose the subscription on unmount. The linter's pass does not know the node is a resource; it knows the node has a subscribe edge with no matching dispose, and that is enough to fire the warning.
- **`UseAfterDispose`.** Any `IRRead | IRSubscribe | IRTxSet` referencing a node id whose latest IR event is `IRDispose` is a row 11 violation. Applied to the adapter: a component that reads a `resource(...)` after the resource's underlying Input has been disposed is caught at the static layer. The pass lifts row 11 from RUNTIME-ONLY into STATIC for the bounded prefix the IR captures.

The remaining two §16A.2 passes (`CommitFromSubscribe`, `CrossGraphRead`) apply to adapter-registered nodes the same way they apply to engine-registered nodes; the adapter does not require special handling.

### 16.3 The §16A.1 layer-classification table — adapter rows

`SPEC.md` §16A.1's table covers all seventeen rows of the §9.1 race-class catalogue. Three rows map directly to `@causl/sync`'s primitives:

| # | Race (abridged) | Layer | How the adapter contributes |
| --- | --- | --- | --- |
| 2 | Read not-yet-loaded resource | STATIC + RUNTIME-ONLY | `ResourceState<T>` DU + `assertNever` at every dispatch site (STATIC); `ForbiddenResourceTransitionError` when the read happens through a non-discriminating path (RUNTIME). |
| 6 | Stale-async resolution | STATIC for the structural commitment + RUNTIME-ONLY for the equality check | The `originGraphTime` field on `ResourceState.loading` is a STATIC commitment — every `loading` arm carries the field, and `assertNever` enforces it. The equality check at resolution (`origin === graph.now`) is RUNTIME-ONLY because the network is the oracle of when the loader resolves. |
| 17 | Suspense fresh-Promise-per-render | STATIC | The `promise` field on `ResourceState.loading` is a structural commitment; the API shape — Promise lives on the union member — is the STATIC enforcement. A regression that re-creates the Promise per render fails Property 4 (§15.1) at the property layer. |

Row 6 is the row that cannot be statically decided — network is the oracle, not the type system. The static layer's contribution to row 6 is the structural commitment that `originGraphTime` is captured at fetch-begin; the runtime layer's contribution is the equality check at resolution. The two together close the row, with the runtime layer carrying the load the static layer cannot.

### 16.4 What the team rejected

Three options for the adapter's IR support sat in front of the team:

(a) **Add a `kind: 'resource'` IR variant** — extend the IR's two-arm DU to `kind: 'input' | 'derived' | 'resource'`. Rejected per `SPEC.md` §4's two-primitive collapse argument: the IR is closed at two arms by structural commitment, and the third arm would be a defection from the §4 collapse #359 / #368 spent their budget closing.

(b) **Ship a sibling document the linter reads** — a `causl-sync-model.json` artifact alongside `causl-model.json`. Rejected for the v1 release because the static linter's eight-pass coverage plus the four §16A.2 additions plus the property suite's eight properties closes the adapter's race classes adequately for the v1 bar. Deferred until needed; reopen trigger is a §9.1 row the existing layers cannot decide.

(c) **Stay structural** — every resource is an Input, every conflict registry component is a public-API node, and the existing linter rules apply uniformly. **Picked.**

The pattern across the rejection of (a) and (b) is one rule: the adapter does not widen the IR, and the adapter does not ship a sibling IR. The adapter composes the existing IR's two arms, and the linter that walks the existing IR walks the adapter's nodes by virtue of walking the IR. Anders Hejlsberg's framing on review was the calibration: a typed boundary widens by a measure, and the measure is "this widening pays back an invariant the type system cannot otherwise express." The adapter's race classes are expressed at the property layer (Properties 1–8) and the runtime layer (the two typed errors), not at the IR layer. The IR does not need to widen.

---

## 17. Commitments

`SPEC.md` §17's framing applies: a flat list of commitments, each marked **MECHANICAL** (a CI gate exists) or **DESIGN-DISCIPLINE** (the discipline is enforced by review policy), with the anchor named. The adapter's commitments are nine — narrower than the engine's twelve, because the adapter sits on top of the engine and inherits the engine's commitments by composition. The nine below are the rows the adapter signs in addition to the engine's twelve.

### 17.1 The nine adapter commitments

| # | Commitment | Type | Anchor |
| --- | --- | --- | --- |
| 1 | The semantic-foundation page in §3 of SPEC.async.md lands first; every later decision references it. | DESIGN-DISCIPLINE | §3, `docs/semantics-async.md`; review policy on every SPEC.async-touching PR. |
| 2 | The two-primitive surface stays at two — `Resource` and `Conflict`, no third primitive without a §12.1 audit. | DESIGN-DISCIPLINE | §12.1; quarterly review. |
| 3 | Capability narrowing on `ConflictRegistry` per §7 — read-side handle cannot reach `commit`; write-side handle cannot subscribe arbitrarily. | MECHANICAL | TS-level `Pick<Graph, ...>` types verified by `tsc`; runtime gate via `narrowCapability` from `@causl/core/internal`. |
| 4 | DU + `assertNever` exhaustiveness on `ResourceState`, `Conflict`. | MECHANICAL | `assertNever` from `@causl/core/internal`; `packages/sync/test/*.test-d.ts` exhaustiveness fixtures. |
| 5 | The §9.1 race-class catalogue is current for the adapter's race classes (rows 2, 6, 17). | DESIGN-DISCIPLINE | §9.1 plus the PR template anchor at `.github/PULL_REQUEST_TEMPLATE.md` (#399 / #430), extended for adapter-touching PRs. |
| 6 | The §10 worked example is the gate for "the adapter is real." Until it works, no other phase begins. | MECHANICAL | The four `packages/sync/test/spec-async-10-{1,2,3,4}-*.test.ts` files (EPIC-8 / #474); required-green on every PR. |
| 7 | No enum tags whose transitions are not specified by the §6 chart. | DESIGN-DISCIPLINE | §6 plus `docs/lifecycle.md` §1 (ResourceFleet) and §2 (ConflictRegistry). |
| 8 | The §15 properties (Properties 1–8) hold at the 1000-trial floor. | MECHANICAL | `propertyTrials` seam; `spec-15.2-conformance.test.ts` walker enrols every `*.property.test.ts` under `packages/sync/test/properties/`. |
| 9 | The §16A static layer's adapter-relevant rules (`SubscribeWithoutDispose`, `UseAfterDispose`) cover the adapter's race classes. | MECHANICAL when those passes ship. | `tools/checker` lint passes; per-pass fixtures under `tools/checker/tests/fixtures/` extended for adapter-registered nodes. |

### 17.2 What MECHANICAL means

Commitment 3 is held by the two `Pick<Graph, ...>` type aliases in `packages/sync/src/conflict.ts`, verified by `tsc`'s structural-typing pass at every call site, plus the runtime `narrowCapability` gate that fails closed if the registry is invoked outside its capability slice. Commitment 4 is held by the `assertNever` exhaustiveness check at every tagged-union switch site in `packages/sync/src/`, plus the per-adapter `*.test-d.ts` fixtures that compile to red on a missing arm. Commitment 6 is held by the four `packages/sync/test/spec-async-10-{1,2,3,4}-*.test.ts` worked-example fixtures shipped via EPIC-8 (#474). Commitment 8 is held by the `spec-15.2-conformance.test.ts` walker enrolling every `*.property.test.ts` under `packages/sync/test/properties/` at the 1000-trial floor; EPIC-9 (#475) closed the eight-property suite and the `@causl/sync-testing-internal` workspace package that hosts the arbitraries. Commitment 9 is held by the `tools/checker/tests/fixtures/` per-pass fixtures. **Current state (as of v0.9.0).** Commitment 9's `SubscribeWithoutDispose` / `UseAfterDispose` static passes are engine-side rules that compose onto adapter-registered nodes uniformly (per §16.2); resource-shaped IR rules such as `resource:origin-bound`, `resource:single-pipeline`, and `resource:domain-bounded` named in §3.1's mechanical anchors are *not* shipped today and remain deferred behind EPIC-1 / Schema 3, per `docs/theorem-1-static-lint-design.md`.

### 17.3 What DESIGN-DISCIPLINE means

Commitment 1 is held by the spec rewriter's habit of writing §3 before §4–§18 of `SPEC.async.md`. Commitment 2 is held by the §12.1 quarterly audit. Commitment 5 is held by the PR template's race-class anchor extended for adapter-touching PRs. Commitment 7 is held by the §6 statechart and `docs/lifecycle.md`'s named transitions.

### 17.4 What the team rejected

Three options for the commitment shape sat in front of the team. **Inherit the engine's twelve commitments verbatim and add zero adapter-specific commitments** — rejected because the adapter's surface is not covered by the engine spec. **Ship a parallel twelve-commitment list that mirrors the engine's structure exactly** — rejected because the adapter does not have analogues for some of the engine's rows. **Ship a nine-commitment list scoped to the adapter's surface** — what the team picked. The total contract is twelve plus nine, with no double-counting and no commitment without a named anchor.

---

## 18. Final positioning

`@causl/sync` is the adapter. `SPEC.md` §3 commits the engine to a single `GraphTime` line, evaluated by a single mutation pipeline (§5), with no async anywhere on the inside; `SPEC.md` §13.6 names this package as the deferred-via-separate-adapter answer to the async-resource question. The arc from `@causl/sync` §0 through §17 is the team's signature on what that delegation looks like in code, in tests, in CI gates, and in the surface adopters import.

The shape, restated:

- **Two primitives** (§1, §4, §12.1) — `resource(graph, key, options)` and `createConflictRegistry(graph, options)` — neither of which adds a new node kind to the engine's IR.
- **The five-arm `ResourceState<T>` DU and the four-arm `Conflict<T>` DU** (§4, §9). Each arm carries the fields the chart guarantees in that state; the discriminator is `state` / `kind`; `assertNever` polices every dispatch site.
- **Chart-by-construction** (§6, §17 commitment 7). Every legal transition is an edge on the §6 ResourceFleet sub-statechart or the §6 ConflictRegistry sub-statechart. Every illegal transition throws `ForbiddenResourceTransitionError` or `ForbiddenConflictTransitionError`.
- **Origin-bound resolution** (§3 Theorem 1, §15 Property 2). The stale-async race (`SPEC.md` §9.1 row 6) is closed by the equality check `origin === graph.now` at resolution.
- **Promise identity stability** (§3 Theorem 3, §15 Property 4). The Suspense fresh-Promise-per-render race (`SPEC.md` §9.1 row 17) is closed by carrying the Promise on the `loading` arm of the discriminated union itself.
- **Single-pipeline mutation** (§3 Theorem 2). Every state transition lands through `graph.commit`.
- **Capability narrowing on the registry** (§7, §17 commitment 3). Two `Pick<Graph, ...>` aliases plus the runtime `narrowCapability` proxy.
- **The 1000-trial property suite** (§15, §17 commitment 8). Eight properties at the engine's shared 1000-trial floor.
- **The bundle budget** (§14.2). 8 KB working target, 12 KB ceiling, three rows in the `size-limit` config.
- **The §17 commitments.** Nine rows, each marked MECHANICAL or DESIGN-DISCIPLINE. The adapter's nine compose with the engine's twelve to cover the system.

The arc from §0 to §17 is the spec's own contract. §0 names what the previous draft tried to be — a fold-async-into-the-engine shape — and why that was the bug. §3 writes down the meaning. §4–§13 are implementation strategy. §14–§16 are the gates that keep the implementation from drifting from the meaning. §17 is the team's signature on the nine adapter commitments that hold the rest in place. §18 is the arc closed.

This document is what the team signed for the canonical adapter that `SPEC.md` §13.6 names — `@causl/sync`. It ships today: two primitives, two DUs, two error classes, two `Pick<Graph, ...>` capability slices, eight properties, two §16A.2 passes for the adapter's most common race patterns, and a 12 KB bundle ceiling with two sub-import rows under it. The §3 theorems hold structurally, the §6 charts hold by construction, the §15 properties hold at the 1000-trial floor, and the §17 commitments hold because the team holds them.
