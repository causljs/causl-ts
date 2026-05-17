# Causl — State & Dependency System Specification

**Working name:** causl

**Tagline:** Transactional state for tangled dependency graphs.

---

## 0. Where I'm coming from

I'm building a transactional state engine for applications whose dependency graphs are tangled enough that "just recompute on change" stops being a strategy and starts being a bug source. Tabular UIs whose cells reference each other. Asset hierarchies whose state is interlinked through inferred relationships. Operational systems where the thing on screen depends on a graph of facts the user does not want to see explicitly. The mission is narrow: give those graphs a single mutation pipeline, a single notion of time, and a denotational definition of what a derived value *means* — so that "atomic, deterministic, explainable" stops being marketing and starts being theorems the engine has to satisfy on every commit.

I'm writing this as the team's representative. The team — Conal, Trygve, Alan, Mark, Brendan, David, Anders, and the rest of the bench the closed-PR record names — reviewed an earlier draft of this spec, took it apart paragraph by paragraph, and pushed back hard on every place the prose covered for an ambiguity in the design. What survived that review is what I am willing to defend on a PR; what didn't survive got cut. I write in the first person because the spec is the contract, and a contract benefits from a single throat to choke.

I'm cutting the previous draft roughly in half, and reorganising what remains around five commitments:

1. **I will write down what a derived value *means* before I write down how to compute one.** No more handwaving "FRP-like." If I cannot give a one-line semantic equation for a primitive, I will not ship it. Conal held me to this in §3 and I am keeping the discipline.
2. **I will treat every lifecycle in the system — node status, resource fetch, transaction phase, conflict status, interaction mode — as one composite statechart.** No more parallel string-enums sprinkled across object fields. David's region in §6 is the load-bearing diagram.
3. **I will keep the user's information model strictly separate from the engine's substrate and from editor-controller state.** A selected range and an asset's location do not belong in the same identifier namespace. Trygve's MVC reading of "the model is the model" is non-negotiable in §7.
4. **I will collapse the taxonomy.** The previous draft introduced 57 enum tags across NodeKind, EdgeKind, ConflictKind, CommitMode, AsyncCommitPolicy, ReconciliationPolicy, SchedulerLane, CyclePolicy, NodeStatus before a developer could write a counter. Anders's line — "two primitives, not eleven" — runs §4. The runnable concept count is two on the wire, two in the IR, two in the public type.
5. **I will ship the smallest thing that earns the right to grow.** The public Graph surface is a single-digit canonical set in §12.1 plus a curated second tier in §12.2 — **nineteen public Graph methods/getters today, audited quarterly.** Rust core, GraphQL, Postgres, WASM are not phases of this spec; they live in §13 with explicit reopen triggers or they do not appear at all.

The brutal-critical review the team runs is real and visible in the closed-PR record (#272 closed the bounded model checker as not-planned; #386, #391, #396, #398, #404 closed the honesty pass; #366 / #378 re-routed `hydrate` through the commit pipeline; #359 / #368 collapsed the IR to two `kind` constants). Every commitment above survived a "name the unavoidable concept the engine cannot express without it" challenge. The ones that didn't are in §13 with a reopen trigger or struck entirely. The "single-digit" promise the previous draft made for §12 was one of the casualties — the team's read was that §12.2's twelve second-tier rows are also load-bearing, that the canonical seven plus second-tier twelve is the honest count, and that pretending otherwise reproduces the drift PRs #266, #395, #420 kept fixing. The §0 surface promise is now the two-tier framing the team will defend.

---

## 1. What causl is

I'm building a state engine for applications where a user action produces a cascade of dependent updates that have to land atomically, deterministically, and explainably — typically tabular UIs whose cells reference each other, asset hierarchies whose state is interlinked, and operational systems where the thing on screen depends on a graph of facts the user does not want to see explicitly. I'm not building a global store; I'm building the dependency engine that sits underneath one.

The whole spec sits on top of a four-line equation:

```text
GraphTime  := an ordered sequence of commit moments t₀ < t₁ < t₂ < ...
GraphState := a snapshot of all input values at one commit moment
Behavior a := GraphTime → a            -- a value that varies over commits
Event   a  := [(GraphTime, a)]         -- discrete occurrences
```

Those four lines fit a transactional engine because they fit a transactional engine *cleanly*: §5's commit is the only operation that advances `GraphTime`, so every Behavior is a pure function of inputs at the time the commit publishes; §3's denotational framing makes recompute pure — given the same inputs at the same `t`, every implementation either agrees with the equation or is wrong. The four-line framing is what makes "atomic, deterministic, explainable" land as theorems in §3, not aspirations.

The spec is the contract. I am the team's representative. I write as "I" so the contract has a single throat to choke; the team pre-agreed every load-bearing claim through brutal-critical review, and the closed-PR record is the audit trail.

---

## 2. What causl is not

I will say no to:

- A spreadsheet engine. I will support spreadsheet *patterns* on top of the core through `@causljs/formula`; I will not ship VLOOKUP.
- A database. There is no query language, no index, no on-disk storage format. The commit log is a bounded ring buffer in process memory; persistence is an adapter (`@causljs/persistence`) that snapshots inputs at chosen commits.
- A queue or message bus. The MVU `update` runner in §8 sequences `Msg` values into commits; it does not buffer them, route them across processes, or guarantee at-least-once delivery.
- A CRDT. Multi-user merge semantics belong in a layer above this one. The §3 denotational model assumes a single `GraphTime` line, and the §6 composite chart assumes a single Engine; multi-writer semantics is a different system.
- A virtual DOM, a renderer, or any kind of view layer. `@causljs/react` translates engine commits into `useSyncExternalStore` snapshot semantics; the rendering decision is React's, not the engine's.
- A state-management library in the Redux / MobX / Jotai / Recoil / Zustand sense. If a global store is the part of an application's architecture that is missing, those libraries are the answer. Causl is the dependency engine that sits *underneath* one of them when the application's state has a non-trivial graph of derivations.
- A build-time framework. There is no codegen step in the core; `graph.exportModel(): CauslModel` is a runtime IR consumed by the §16 static linter, not a precompile pass.

Anders's discipline applies on every row above: the type system tells the truth or it tells nothing. A library that promises "we are also a CRDT" without the type signature to back it is a library that is going to be wrong about every multi-user race it accidentally meets. I would rather name what causl is *not* and let the type signatures of `@causljs/core` carry the things it *is*.

---

## 3. Semantic foundation

Conal raised this and he was right: if I cannot define what a value *means*, I cannot tell two implementations apart, and I cannot prove glitch-freedom — I can only hope for it. The Behavior / Event vocabulary is his; I am using it because it is the smallest vocabulary that captures the engine's claims, and because Brendan's read of the same vocabulary against ECMAScript Promise / AsyncIterator timing is what kept §5's commit boundary honest when the team pushed on async resources.

So here is the meaning, on one page:

```text
GraphTime  := an ordered sequence of commit moments t₀ < t₁ < t₂ < ...
GraphState := a snapshot of all input values at one commit moment
Behavior a := GraphTime → a            -- a value that varies over commits
Event   a  := [(GraphTime, a)]         -- discrete occurrences

input(initial)               : Behavior a    where input(t₀) = initial
derived(f, b₁, b₂, ..., bₙ)  : Behavior a    where derived(t) = f(b₁(t), ..., bₙ(t))
transaction(intent, writes)  : Event Commit  where each commit advances GraphTime by 1
```

From those four lines, every property the previous spec listed as a *goal* becomes a *theorem*:

- **Theorem 1 — Determinism.** `derived(t) = f(b₁(t), …, bₙ(t))` is a function of its inputs at `t`. Recompute is pure: given the same input snapshot at the same `GraphTime`, every implementation produces the same value or is wrong. Two implementations either agree or one of them is the bug.
- **Theorem 2 — Glitch-freedom.** A derived value at time `t` is a pure function of its inputs at the same time `t`. There is no observed `f(B(t), C(t))` in which `B` and `C` disagree on `t`, because there is no intermediate time between commits — the scheduler may interleave work, but the meaning is fixed by the equation. The diamond is structurally non-existent, not heuristically avoided.

  **Uninterruptibility (post-FFI amendment, #1333).** When the engine runs outside the JS event loop — e.g. inside a WebAssembly linear-memory backend — the marshal of a `Commit` envelope across the host boundary MUST be atomic with respect to JS-observable scheduling. No microtask, `requestAnimationFrame` callback, `MessageChannel` callback, or other JS-observable continuation may run between the engine-side Phase E publish (`Commit` envelope sealed in engine memory) and the host-side Phase G dispatch (subscriber callbacks fired in the host language). Theorem 2's "single-tick" proof structure assumes single-threaded JS evaluation; an engine that crosses an FFI boundary must enforce this invariant explicitly. This invariant applies to any non-JS backend whether or not the engine port currently targets one; it captures the contract a future implementation MUST satisfy. The current TS engine satisfies the invariant trivially by virtue of running single-threaded on the JS event loop, so the amendment is observation-equivalent today; it documents the contract any future native backend (Rust, C++, FFI-to-anything) must honor. Landed standalone-value post-STOP-VERDICT on epic #1133 (see §19 trail row and `docs/epic-1133/HANDOFF.md`).
- **Theorem 3 — Atomicity.** A transaction creates exactly one new `t` if it succeeds and zero if it fails. There is no fractional time. A throw escaping any phase from B through F.6 lands in the commit pipeline's catch arm and rolls back the §3 state — input cells, derived state, `commitHistory`, `commitLogEntry`, and `now` — to byte-identical pre-commit values. Either the commit is published in its entirety or it never happened.
- **Theorem 4 — Monotonicity.** `graph.now` advances by exactly one tick per `commit` or `hydrate`, never by zero and never by more than one. The ordering `t₀ < t₁ < t₂ < …` holds across the entire commit log including hydrations. `hydrate(snap)` is a privileged caller of the same commit pipeline (§5), not a parallel one; it advances `now` by one and records `snap.time` on the published `Commit` as `originatedAt` rather than overwriting the engine clock (#366, #378).

A Behavior's domain is `[registrationTime, ∞)` — every Behavior, input *and* derived, registered at GraphTime `t_r` is undefined for `t < t_r`. Reads outside the domain (`readAt(node, t)` for `t < t_r`) surface the discriminated `evicted` arm with `oldestRetainedTime: t_r`; the value isn't reachable because the entity didn't exist as a node in the graph at that moment, and the recovery breadcrumb names the earliest GraphTime where the read would succeed. The input branch landed in #277; the derived branch in #374 closed the symmetric gap — without it, `readAt(derived, t < derivedRegisteredAt)` recomputed against the retained input snapshot and fabricated a value for a Behavior that did not yet exist, violating the domain claim for half of the Behavior universe.

Alan's framing on the §11 liveness page applies here too: the engine is its own observer. `graph.commitLog`, `graph.dependencies`, `graph.dependents`, and `graph.commitMetadataDerived` are not adjuncts to the semantic model — they are Behaviors over `GraphTime` that the engine produces about itself, queryable by the same `read` / `subscribe` / `explain` API as any other graph value. The semantic page is the page I will write before any other code; the rest of the spec is implementation strategy for evaluating these definitions efficiently.

**What the team rejected and why.** Three alternative semantic foundations were on the table. (a) Drop the denotational page entirely and lean on operational semantics — rejected because Conal's challenge was specifically that operational semantics cannot tell two implementations apart at the level §3's theorems require, and the property suite (§15) needs a fixed equation to test correspondence against. (b) Replace the four-line equation with a TLA+-style temporal logic specification — rejected because the spec is a working document for a JavaScript engine and a Rust linter, not an Apalache check; the four-line page is the cheapest formalism that still supports the four theorems. (c) Soften Theorem 4 to "monotone but skipping ticks is allowed" so an implementation could batch hydrations — rejected because batching breaks the §11 liveness contract that "every state change is a commit," and downstream subscribers (`subscribeCommits`, persistence, devtools) would have to reconstruct skipped ticks from `originatedAt` strings instead of inspecting `Commit` records directly.

---

## 4. Two primitives. Everything else is composition.

Anders called this one early: two primitives, not eleven. I'm collapsing the previous draft's eleven `NodeKind` values into two:

```ts
type Node<T> =
  | InputNode<T>        // a writable Behavior
  | DerivedNode<T>      // a Behavior computed from other Behaviors
```

That is the runtime universe — exhaustively. A `Node<T>` is an `InputNode<T>` or a `DerivedNode<T>`; the union has no third arm and the type system is allowed to enforce that with `assertNever` on every switch. Per #359 / #368 / #451, exhaustiveness is a compile-time fact about the engine's `Entry` union (`InputEntry | DerivedEntry`) and a runtime fact about `exportModel`'s dispatch; the previous `as { readonly kind: string }` cast that let adapter packages inject extra entry kinds was retired in #368.

Everything else from the previous draft is a *role* a node can play, not a kind it permanently is:

| Previous "kind" | What it actually is |
| --- | --- |
| `formula` | A `derived` whose compute function happens to interpret an expression string |
| `selector` | A `derived` with a different name |
| `constraint` | A `derived` returning a validation result |
| `resource` | A `derived` over time, fed by an external Event source |
| `effect` | Not a node at all — a post-commit subscription |
| `conflict` | Not a node at all — a derived view of the engine's own lifecycle |
| `collection` / `index` | Uses, not kinds |
| `workflow` | A statechart node (see §6); composed with the graph but distinct from it |

I'm not keeping the `kind` discriminator at all in the public type. A node is its `compute` (or the lack of one). Trygve called this "class taxonomy masquerading as a domain model" — the model is the model; the controller is the controller; the engine's kind universe should not be smuggling either of them in. Mark's principle of least authority (foreshadowed in §12.3) lands on the same point: every spurious `kind` value is a capability that adapter authors have to reason about and that consumers have to handle exhaustively. Two primitives means two arms in every exhaustiveness check, not eleven.

The same discipline holds at the wire boundary. `CauslModel` (the IR `graph.exportModel()` produces and `causl-check` consumes) is closed at two `kind` constants — `'input'` and `'derived'` — and at seven top-level fields — `schema | time | nodes | commits | events | scopes | bridges` — with `schema: 3`. An earlier draft of the IR carried optional `resources`, `conflicts`, and `msgs` arrays alongside dedicated `IRResource | IRConflict | IRMsg` discriminated unions; that surface re-introduced the eleven-`NodeKind` taxonomy as a wire format, taught downstream consumers (the Rust checker, generated bindings, schema-derived types in third-party tooling) the same five-kind universe §4 spent its budget collapsing, and was retired in #359 (schema bumped 1 → 2). EPIC-1 PR-A then bumped schema 2 → 3 to add the multi-graph `graphId` foreign key on every node and commit, the closed six-arm `IREvent` discriminated union, and the `IRScope` / `IRBridge` registries §16.2.1 now codifies — additive widening of the wire format, with the two-`kind` `IRNode` discipline preserved. The engine's internal `Entry` union — `InputEntry | DerivedEntry` — is the single source of truth for what the entries map can hold; `exportModel`'s dispatch is `assertNever`-exhaustive over that union, closing the previous `as { readonly kind: string }` cast (#368). Adapter packages that need richer model state register Inputs and Deriveds through the public `Graph` API like any other consumer and ship a sibling document the checker reads alongside the engine IR.

I considered three NodeKind shapes during the §4 collapse — eleven kinds (the previous draft), five kinds (`Input | Derived | Resource | Conflict | Msg`), and two kinds (`Input | Derived`). Per #359 / #368, the team picked the two-primitive collapse. The reasoning is that any extension lives in an adapter atop `Input | Derived`: `@causljs/sync` registers Resources as `derived` nodes whose compute reads an external Event source; `@causljs/formula` registers parsed-cell state as `derived` nodes whose compute interprets an AST; `@causljs/devtools-bridge` registers Conflicts as `derived` views over the engine's own commit log. Every "kind" in the rejected five-kind shape is reachable as a composition of the two primitives plus an adapter — which is exactly what Anders meant by "two primitives, not eleven": the type discipline is what forces every adapter author to spell their extension as composition rather than as a new arm of the engine's union.

**What the team rejected and why.** Three NodeKind shapes were on the table. (a) Eleven kinds (the previous draft's `formula | selector | constraint | resource | effect | conflict | collection | index | workflow | input | derived`) — rejected because every kind is either composition over `Input | Derived` (formula, selector, constraint, resource, conflict, collection, index) or a different system entirely (effect is a subscription, workflow is a statechart node). The type system was carrying eleven cases for two underlying concepts; #359 bumped schema 1 → 2 to retire the IR-level taxonomy. (b) Five kinds (`Input | Derived | Resource | Conflict | Msg`) — rejected because Resource, Conflict, and Msg are precisely the three that adapter packages already implement on top of two primitives. Promoting them to IR-level kinds taught downstream consumers (the Rust checker, generated bindings, schema-derived types in third-party tooling) a five-kind universe that the engine's runtime did not maintain, recreating the eleven-kind drift in smaller form (#368 closed the symmetric gap). (c) Two kinds (`Input | Derived`) — accepted. Reasoning: any extension lives in an adapter atop `Input | Derived`, the IR exhaustiveness check is two arms (`assertNever` is cheap), and the wire schema is closed at two `kind` constants. The seven-field top-level shape (`schema | time | nodes | commits | events | scopes | bridges`) plus `schema: 3` was the additive widening EPIC-1 PR-A applied for multi-graph support and lifecycle-event capture, with the two-primitive discipline preserved on the `IRNode` axis.

---

## 5. Commit boundary

The previous draft talked about "transactions" the way a database talks about transactions — as a pattern an application opts into when it wants atomicity. That framing leaves the door open to *non*-transactional mutation, which then leaks the partial-state problem the rest of the spec spends its budget closing. I am closing the door instead.

There is exactly one mutation API on the engine, and the type signature is the contract:

```ts
graph.commit(intent: string, run: (tx: Tx) => void): Commit
```

The synchronous return value is the frozen `Commit` record Phase E assembles — `{ time, intent, originatedAt, changedNodes }`. Adopters who need the commit metadata immediately (devtools mirroring, async-pump bookkeeping, sync's `ConflictRegistry`) read it from the return value rather than reaching into the commit-history ring buffer. An earlier draft of this section documented `: void`; the impl returned `Commit` from PR-A onwards and #567 brought SPEC text into agreement with the shipped surface. Outside a `commit`, the graph is read-only. There is no `set`, no `update`, no `replaceMany` on `Graph` itself; the only way bits change is by handing `run` to the engine and letting the pipeline drive the write. Conal Elliott's framing on review — *"atomicity is just the statement that the next state is a function of the previous state"* — is the load-bearing reason this signature exists. A mutation API that returned a `Promise<Graph>` (or, worse, mutated `graph` in place between the `await` and the `then`) makes the next state a function of the previous state *and the scheduler*, and the §3 denotational equation `derived(t) = f(b₁(t), …, bₙ(t))` collapses into a hope.

### 5.1 The eight named phases

Inside the body of `commit`, the pipeline runs eight numbered phases in this order. Each phase is a contiguous block in `packages/core/src/graph.ts`'s commit body; each owns exactly one mutation responsibility; together they are the entire definition of "what advancing GraphTime by one tick means."

| Phase | Mutation responsibility |
| --- | --- |
| **A** — Validate | Run the user's `run(tx)` callback. Collect staged input writes into a transient map. A throw escaping `run` short-circuits the entire pipeline; nothing in B–H has executed yet. |
| **B** — Prepare (publish input writes) | Merge the staged writes into the live input table, gated by `Object.is` so a write of the previous value is a no-op for the rest of the pipeline. |
| **C** — Apply (advance clock) | Increment `now` by exactly one tick. The §3 monotonicity invariant lives on this line: every commit (including hydrate, including simulate-that-actually-commits, including the first commit on a freshly-constructed graph) advances `now` by one and only one. |
| **C.5** — Stamp `lastWriteTime` | Record the new `GraphTime` against every input cell that actually changed value in Phase B. A staged write that collapsed under `Object.is` does not stamp; this is what makes "input changed" a structurally honest predicate downstream. |
| **D** — Recompute fixpoint | Walk the affected sub-graph over derived nodes, re-running `compute` until the dirty set is empty. Captures the pre-recompute state of every derived it touches into `derivedRollback`. This is where the §3 equation `derived(t) = f(...)` is *evaluated*. |
| **E** — Publish derived deltas | Assemble the immutable `Commit` record (changed nodes, intent string, `originatedAt`, `time`). Frozen identically here whether the caller is `commit`, `hydrate`, or any future privileged caller. |
| **F** — Append to history | Push the frozen `Commit` onto the bounded `commitHistory` ring buffer; evict the oldest entry if the cap is reached. **Runs iff `commitHistoryCap > 0`** (Amendment 1, #715): with cap=0 no history is observable and the work is dead. |
| **F.4** — Refresh `commitLog` | Update the engine-owned `commitLogEntry.value` (the `DerivedNode<readonly Commit[]>` that backs `graph.commitLog`) to the just-extended history. Adds the entry to `changed` so Phase G fires its subscribers. **Runs iff `commitHistoryCap > 0`** (Amendment 1, #715): cap=0 leaves `commitLog` at its genesis empty array, byte-identical to the eager rebuild over an empty history. A future tightening (deferred follow-up) gates additionally on the existence of a `commitLog` consumer (subscriber, derived dep, or `commitMetadataDerived` registration) so default cap=1000 with no consumer also skips the rebuild. |
| **F.5** — Commit-metadata derived recompute | Recompute every derived registered via `graph.commitMetadataDerived(id, compute)` against the *just-refreshed* `commitLogEntry.value`. This is the seam (#452, exposed in #455). Phase D walked the affected sub-graph against the *previous* commit's `commitLog` — Phase F.4 had not run yet — so a derivation whose compute reads `graph.commitLog` would have been one commit stale all the way through to Phase G. Phase F.5 closes that gap, and only that gap, by walking only the explicit opt-in set. Ordinary `derived(...)` callers are untouched. **Runs iff `commitMetadataIds.size > 0`** (Amendment 1, #715): with zero registrations the work is dead. |
| **F.6** — Retain per-commit input snapshot | Copy the post-Phase-B input table into the `snapshotRetentionCap`-bounded retention buffer keyed by the new `GraphTime`. This is what makes `readAt(t)` and `snapshotAt(t)` return `Retained` rather than `Evicted` for recent commits. **Runs iff `commitHistoryCap > 0`** (Amendment 1, #715): with cap=0 the retention chain is dead state. |
| **G** — Per-node subscriber dispatch | For every node in the `changed` set (input cells from Phase B, deriveds from Phase D, `commitLogEntry` from Phase F.4, commit-metadata deriveds from Phase F.5), fire its registered observers exactly once. Equality-cutoff means one notification per actual value change, not one per dirty mark. **Runs iff `changed.size > 0`** (Amendment 1, #715): with an empty set every subscriber is value-equal anyway; skipping the iteration is observable-equivalent to running it. |
| **H** — Commit-level subscriber dispatch | Fire `subscribeCommits` observers exactly once with the frozen `Commit` from Phase E. Unlike Phase G, this fires every commit regardless of which nodes changed. **Runs iff `commitObservers.size > 0`** (Amendment 1, #715): with zero registrations the work is dead. |

§5.1 Amendment 1 (#715) — phase preconditions: phases enumerate possible engine behaviour; preconditions describe when the work is materially observable. The §3 atomicity contract is unchanged: any consumer that subscribes still sees byte-identical results to the eager evaluation. A future amendment 2 (#716) flips `commitHistoryCap` default from 1000 to 0 (semver-major) once the long-run-1M evidence (#710) is collected.

§5.1 Amendment 2 (#716): The default `commitHistoryCap` is now 0; opt-in retention requires `createCausl({ commitHistoryCap: 1000 })`. This is a semver-major contract change. Adopters using `readAt` / `snapshotAt` / `commitLog` must explicitly opt in. The change ships paired with §5.1 Amendment 1 (#715) so the cap=0 path is observably equivalent to a cap=1000 path with no commitLog consumer — the gates ensure consumer-less commits pay no envelope cost regardless of cap.

§5.1 Amendment 4 (#1333) — Phase G subscriber container invariant (post-FFI amendment). The per-node subscriber index — i.e. the mapping from `NodeId` to the ordered list of observer ids that receive Phase G fires — MUST preserve **insertion order**. In implementations using ordered containers (`IndexMap<NodeId, SmallVec<[ObserverId; 2]>>` in Rust, `Map<NodeId, Array<ObserverId>>` in JavaScript), insertion order is preserved by the container itself. Implementations using hash-based containers whose iteration order depends on hash seed (`HashMap`, `FxHashMap`, `hashbrown::HashMap`) are **non-conformant for the byte-identity gate** because hashbrown's iteration order changes between minor crate versions; the engine's cross-backend determinism contract requires deterministic iteration. Implementations using sorted containers (`BTreeMap` sorts by id, losing insertion semantics) are likewise non-conformant. Subscriber fire order is: insertion-order per node, then `changedNodes`-insertion-order across nodes; sorted-by-id and hash-iteration containers violate both axes. The current TS engine's `subscriptionsByNode: Map<NodeId, Subscription[]>` already satisfies the invariant by virtue of JS `Map`'s spec-mandated insertion-order iteration, so the amendment is observation-equivalent today; it documents the contract any future native backend must honor. Landed standalone-value post-STOP-VERDICT on epic #1133 (see §19 trail row and `docs/epic-1133/HANDOFF.md`).

§5.1 Amendment 3 (#956) — implementation-detail trail; **no contract change**. The registration-time eager evaluator is iterative end-to-end: `graph.derived(...)` walks the dep graph through `computeDerivedIterative`'s explicit `StackFrame[]` rather than recursive `computeDerived` calls (#670 / #705 / #773 retired the recursive walker on the commit-time Phase D fixpoint; #956 retired the last hot-path recursion at registration). The eager-vs-lazy contract is unchanged — every derived is computed at registration time, every SPEC §3 atomicity / §5.1 phase invariant is preserved byte-identically — but the depth ceiling on linear-chain registration lifts past 12k on Node 22+ (PR #946's lazy-default trial broke 28 §3 / §5.1 invariants and was reverted; iterative-but-still-eager is the design point that preserves every contract). The typed `DerivedRegistrationStackOverflowError` (#936 / PR #943) remains in the engine as defense-in-depth for residual recursion the audit might have missed (a user `derived` body that itself recurses outside the tracker, etc.); it is no longer the expected normal-path failure mode at depth 10k. Bench: `causl × linear-chain × 10000` reports a real median post-#956 (no longer typed-skipped); the comparator harnesses (jotai #922, mobx #798, redux #926) still skip the same cell because their walkers stayed recursive — the asymmetry is structural to the JS engine shape, not the workload.

The phases are named, not numbered with gaps, because each one shipped with a closed-issue rationale: F.4 landed when the team realised `commitLog`'s subscribers needed to wake on the same tick that produced the entry; F.5 landed when #383 surfaced that ordinary `derived(...)` callers reading `graph.commitLog` saw the previous commit's array; F.6 was the per-commit retention seam #277 introduced for input-side `readAt`. Renumbering them into a contiguous `1..12` would erase the audit trail; the dotted suffixes are deliberate.

### 5.2 Atomicity is structural, not aspirational

A throw inside `run` (Phase A) short-circuits the pipeline before any visible state changes — there is nothing to roll back because nothing has been published. A throw inside Phases B through F.6 lands in a single catch arm at the bottom of the commit body, which restores byte-identical pre-commit state across:

- input cells (the staged-writes map is discarded; live cells revert via the captured pre-Phase-B values),
- derived state (`derivedRollback` carries the pre-Phase-D and pre-Phase-F.5 values for every derived the pipeline touched — Phase D and Phase F.5 share the same map by design),
- `commitHistory` (Phase F's push and any FIFO eviction it triggered are undone),
- `commitLogEntry.value` (Phase F.4's refresh is reverted),
- `now` (Phase C's increment is rolled back).

After the catch arm runs, the engine state is byte-identical to the pre-call moment, and the throw propagates to the caller. No subscriber has fired (Phases G and H sit *outside* the try-catch's mutation envelope, so they never run on the failure path). This is what Elliott meant by "the next state is a function of the previous state" — it is also a description of what the implementation does, line for line.

### 5.3 `hydrate` is a privileged caller, not a parallel pipeline

`graph.hydrate(snap)` looks like a second mutation API. It is not. Internally `hydrate` pre-validates `schema` and `schemaHash`, filters `snap.inputs` down to ids the live graph carries, and then routes the writes through the same Phase A–H body that `commit` drives. The published `Commit` carries `intent: 'hydrate'` and `originatedAt: snap.time`; `now` advances by exactly one tick, exactly the way Phase C demands of every caller.

The implementation seam is `commitInternal(intent, run, options)`, which `commit` and `hydrate` both call. `commit` is the public entrypoint with `intent` user-supplied and `originatedAt` defaulted to the new `now`; `hydrate` is the privileged entrypoint with `intent: 'hydrate'` and `originatedAt: snap.time`. Future privileged callers (a server-replay primitive, a devtools-bridge fork operation if §13 ever reopens edit-mode time-travel) get added by extending `commitInternal`'s options bag, never by writing a parallel pipeline. This is the §3 monotonicity invariant kept structurally rather than by hope — there is no API surface where `now` advances by zero ticks or two ticks, because there is no pipeline that does that (#366, #378).

### 5.4 `simulate` is the dry-run, and it is a *prefix* of the same pipeline

`graph.simulate(intent, run): SimulateResult` answers "what would `commit(intent, run)` do if I called it?" without committing. It runs Phases A–E only — staging the user callback, publishing writes onto a transient view, advancing a transient clock, recomputing the fixpoint, assembling the would-be `Commit` — and then unconditionally restores every byte the prefix mutated before returning. Phases F through H are skipped: no history append, no `commitLog` refresh, no commit-metadata recompute, no retention write, no subscriber dispatch.

The discriminated `SimulateResult = { status: 'clean', commit: Commit, stagedDiff: readonly NodeId[], derivedDiff: readonly NodeId[] } | { status: 'failed', error: CauslError | unknown }` is the §9 honesty about errors that would have escaped the real pipeline (`NotAnInputNodeError`, `UnknownNodeError`, `NodeDisposedError`, `StaleTxError`, plus user-thrown errors out of `run` or a derivation compute). They surface on the `'failed'` arm rather than throw — the only throw `simulate` raises is `CommitInProgressError` on re-entry (#367). The `'clean'` arm carries `stagedDiff` (input ids whose value the staged writes would have changed, in `tx.set` iteration order, equality-cutoff applied) and `derivedDiff` (transitively-affected derived ids in topological order over the affected sub-graph) — adopters preview both halves of what the real `commit` would publish without paying for the publish. An earlier draft of this section used an `{ ok: true | false }` discriminator and a single opaque `diff: SimulateDiff`; the impl shipped the named-status / split-diff shape from the start, and #567 brought SPEC text into agreement. After `simulate` returns, engine state is byte-identical to the pre-call moment, the same way the catch-arm of `commit` leaves it byte-identical on failure.

### 5.5 The three options for Phase F.5

Phase F.5 is the seam #455 wired up. The team considered three shapes before picking it; all three are recorded here because the question recurs — every adapter author who needs to read commit metadata from a derivation rediscovers the same trilemma.

1. **Update `commitLogEntry.value` before Phase D.** A derivation that reads `graph.commitLog` from inside Phase D's recompute would see the just-extended array. Rejected: circular. The just-extended array depends on the `Commit` Phase E assembles, which depends on the `changedNodes` set Phase D produces. Refreshing `commitLogEntry` before Phase D either invents a `Commit` Phase E later contradicts, or skips Phase E entirely and ships a half-frozen record. Either way, the §3 atomicity contract dies.
2. **Run `recomputeAffected` twice across all deriveds.** First pass against the pre-Phase-F.4 log (current Phase D); second pass against the post-Phase-F.4 log to catch any derivation whose value changed because of the log refresh. Rejected on Sebastian Markbåge's reading of the cost: every commit pays the doubled-recompute tax, even for graphs with zero deriveds that read commit metadata. The engine's headline cost-of-commit ("a commit producing N derived recomputations runs in O(N), not O(graph size)" — §14) becomes 2N. Adopters whose graphs don't touch commit metadata at all subsidise the ones that do, and the SPEC's performance commitment quietly weakens.
3. **A new "post-commit derived" Behavior class scheduled in Phase F.5.** Adopters opt their derivation into the post-log-refresh recompute by registering it through `graph.commitMetadataDerived(id, compute)` instead of `graph.derived(id, compute)`. The engine indexes the opt-in set; Phase F.5 walks only that set, against the just-refreshed `commitLogEntry.value`, after Phase D and Phase F.4 have settled. Ordinary deriveds settle exactly once per commit in Phase D, preserving the §3 atomicity contract for the load-bearing 99% of nodes. The cost-of-commit headline reverts to O(N) plus the size of the opt-in set, which is bounded by the application's actual use of the seam.

The team picked option 3. Phase F.5 is where it lives, `graph.commitMetadataDerived` is its public surface (§12.2), and the rollback map it shares with Phase D is the structural reason a throw in F.5 still leaves the engine byte-identical to the pre-commit moment. The two whyUpdated / whyNotUpdated explainers from §5.4 of `docs/lifecycle.md` ride directly on top of this seam (#455).

### 5.6 What the team rejected and why

The team rejected the database-style transaction framing for the public API ("`graph.beginTx()` / `graph.commitTx(tx)`") because it leaks the partial-state problem: a `tx` handle that escapes the callback is a hole in the §3 atomicity contract, and "don't escape the handle" is a documentation rule, not a structural one. The closure shape `graph.commit(intent, run)` makes the escape impossible — `tx` is scoped to `run`'s lifetime by the type system.

The team rejected the "`hydrate` is its own pipeline" alternative because it doubled every invariant — Phase C advanced `now` in one place, hydrate's own clock-advance in another, and the bug was guaranteed within two refactors. Routing through `commitInternal` is what makes the §3 monotonicity invariant a *fact about the call graph* rather than a comment in two implementations (#366, #378).

The team rejected an out-of-band rollback API (`graph.discardCommit(handle)`) because a fractional time would be observer-visible — Phase G and Phase H would have already fired by the time the application called `discardCommit`. The closure shape plus the catch-arm's byte-identical restoration is the only honest answer: the only way to *not* commit is to throw inside `run`, and the only way to ask "what would happen if I committed?" is `simulate`.

---

## 6. Composite statechart

The previous draft had at least five state machines hiding as flat enums (`NodeStatus`, `ResourceNode.status`, the 13-step transaction lifecycle, `Conflict` status, interaction mode). None of them had transition rules; the relationships between them were left to the implementer's good intentions. David Harel's response on review was the canonical one — *until the relationships are drawn, there is no system, only a wishlist of states*. The composite chart is the response.

The chart itself lives in `docs/lifecycle.md`. SPEC anchors the chart; SPEC does not duplicate the diagram. Duplicating it across two files is exactly the drift `lifecycle.md`'s reason-to-exist closes (the chart is the one source of truth; SPEC quotes its names but never redraws its edges).

Alan Kay's framing on the same review — *"the regions ARE the program structure"* — is the load-bearing reason §6 sits where it does in this document. The composite chart is not an afterthought illustration; it is the program structure rendered as a state machine. The four orthogonal regions name the four lifecycles the engine is responsible for, and every tag the engine ships (every kind of `Resource`, every kind of `Conflict`, every `WhyReason`, every `ObserverErrorContext.source`) is a state or call-site label on a chart-named edge. New tag families do not appear in code without a region added to the chart first (§17 commitment 7).

### 6.1 Three regions today, four on paper

The chart has three orthogonal regions implemented today — Engine, ResourceFleet, ConflictRegistry — and one *conceptual* region the diagram preserves for pedagogical reasons but the engine does not implement: Controller. I considered drawing all four regions in §6 and shipping them; the team decided to keep the Controller region marked `CONCEPTUAL — not implemented today` until a devtools-bridge use case promotes it. The conceptual marking honours §17 commitment 7 (no enum tags whose transitions aren't specified by the chart) — Controller is a teaching diagram, not a tagged union, so the marking is sufficient.

**Engine region** (orthogonal region 1, implemented). The states are `Idle` and `Committing`, with `Committing` decomposed into the eight phases §5 names: Phase A (`Staging.CollectingWrites` → `Staging.WritesCollected`), Phase B (`Recomputing.WalkingDirty` → `ComputingDerived` for input writes), Phase C and C.5 (clock advance, lastWriteTime stamp), Phase D (`Recomputing.ComputingDerived` to fixpoint), Phase E (`Publishing` — frozen `Commit` assembled), Phase F (history append), Phase F.4 (`commitLog` refresh), Phase F.5 (`CommitMetadataRecomputing` — the explicitly-named state for the post-log derived pass), Phase F.6 (`RetainingSnapshot`), Phase G (`Notifying.PerNode`), Phase H (`Notifying.PerCommit`). Phase F.5 is named explicitly as a state in the Engine sub-chart prose — both here and in `docs/lifecycle.md` §1.1 — because hiding it produces inconsistent depth (a reader of `lifecycle.md` alone would never learn F.5 exists, even though four §11 inspection primitives ride on top of it).

**ResourceFleet region** (orthogonal region 2, implemented in `@causljs/sync`). One sub-statechart per registered resource, with states `ResourceIdle | Loading | Loaded | Stale | Errored` and transitions guarded by `originGraphTime == currentGraphTime` (the stale-async race-class guard from §9.1). The Engine region references this region's vocabulary on `Validating`'s constraint subregion; the resource adapter does not reach back into Engine internals.

**ConflictRegistry region** (orthogonal region 3, implemented as a derived view over the commit log). One sub-statechart per open conflict, with states `Open | Resolved | Ignored | Superseded`. There is no separate conflict store — the registry is a derived projection of the same `commitLog` Phase F.4 maintains, so a conflict that closed three commits ago is reachable through `readAt(commitLogEntry, t)` exactly the way every other historical projection is.

**Controller region** (conceptual, not implemented). The diagram preserves the region as `CONCEPTUAL` so readers see the model / controller / engine separation §7 names, drawn at the same fidelity as the regions that ship. The states the diagram sketches — `Idle | Selecting | Drawing | Inspecting` — are placeholders; no engine code reads them. The reopen trigger is the same one §13 names for any deferred capability: when a devtools-bridge or application-layer use case actually needs a controller-state region tagged in the engine, it lands here, with the regions rebalanced and the chart updated. Until then, the controller layer is application-supplied (§7.2), and the conceptual region is the teaching diagram that explains *why* it lives outside `@causljs/core`.

### 6.2 Sub-regions §5.1 through §5.4 of the chart

Four named sub-regions extend the chart with orthogonal lifecycles whose tag families the engine surfaces. Per §17 commitment 7, every `kind` in every union the engine exports is a reachable state in one of these sub-regions. The full edges live in `docs/lifecycle.md` §5; SPEC names them so a reader knows where to find the chart for any tag they encounter.

- **§5.1 RetentionWindow.** The lifecycle of a per-commit input snapshot retained in Phase F.6, surfaced through `RetentionResult<T>` on `readAt` and `snapshotAt`. Two states: `Retained` (the snapshot is in the `snapshotRetentionCap`-bounded buffer) and `Evicted` (the displaced GraphTime fell out the back of the buffer when a newer commit retained its own snapshot). The transition is monotonic per-GraphTime: a time `t` once evicted never returns to retained.

- **§5.2 PersistedInput.** The lifecycle of a persisted input attempting an I/O round-trip through `@causljs/persistence`. The five `PersistenceError.kind` values (`parse | migrate-threw | migrate-missing | serialise | quota`) are reachable states of the persistence sub-statechart, not parallel enums. `migrate-threw` (the application-supplied migrator threw) and `migrate-missing` (schema mismatch with no migrator on hand) are *distinct* states; encoding both as the presence/absence of an optional `cause?` on a single `migrate` tag was the §17.4 violation #370 retired.

- **§5.3 ObserverError.** The lifecycle of a thrown observer caught by the `onObserverError` hook on `createCausl({ onObserverError })`. The three `ObserverErrorContext.source` values (`subscribe-initial | node-subscriber | commit-subscriber`) are call-site labels on the error edges leaving Engine `Publishing` — not states the engine occupies. The set is closed: any new dispatch path adds a row before it ships.

- **§5.4 WhyReason.** The lifecycle of a lineage-explainer answer from `whyUpdated` and `whyNotUpdated`, landed in #380 and re-routed through `commitMetadataDerived` (Phase F.5) by #455. The six values (`recomputed | directly-set | no-cause | did-update | no-dep-overlap | object-is-deduped`) are call-site labels on the explainer functions, each anchored to a chart-named edge of the §1.1 Engine region. The labels classify whether the explained node was carried by the most recent `Publishing` edge in the supplied commit window, and — when it was not — which Engine guard or short-circuit accounts for the absence. The set is closed: any new `WhyReason` tag adds a row in `docs/lifecycle.md` §5.4, naming the §1.1 Engine edge it describes, before it ships in code.

### 6.3 What the team rejected and why

The team rejected drawing the controller region as a *shipped* region on the chart because it would have promised engineering work without a use case. Marking it `CONCEPTUAL` is honest about what's drawn versus what's wired, and §17 commitment 7 still holds — there is no tagged union the engine ships whose transitions aren't on the chart, because Controller doesn't ship a tagged union.

The team rejected hiding Phase F.5 in `lifecycle.md` because hiding the seam while §5 prose and §5.4 sub-region both name it produces inconsistent depth across the same documentation surface. A reader who only reads `lifecycle.md` is owed the same fidelity as a reader who only reads SPEC; naming F.5 in both is the cheapest way to keep them consistent.

The team rejected duplicating the chart inline in SPEC §6 because the duplication was the drift `lifecycle.md`'s existence is meant to close. SPEC anchors; `lifecycle.md` is the one source of truth for the chart's edges and guards.

---

## 7. Layering

Whose mental model is this? The previous draft answered "all of them, simultaneously," and that was the bug. Trygve Reenskaug's framing on review was the cleanest restatement of the fix: *the model / controller / engine separation is MVC's heritage applied to dataflow*. The user's information model is the M; the editor's controller state is the C; the dependency graph is the engine substrate the V renders. Mixing the three is what made the previous spec impossible to teach, and it is what the §7 layering is non-negotiable about closing.

### 7.1 Three layers, named

- **Information model** — the things the user thinks exist. Buildings, cells with formulas, bookings. Identifiers like `cell:wb1:Sheet1:A1`, `asset:property-1:HVAC-3`. No UI selection state, no drag-in-progress, no fetch-in-flight in this namespace.
- **Editor-controller state** — what the cursor is doing right now, what's selected, what's being drawn, what mode the editor is in. Different identifier namespace (`controller:gridSelection:wb1`, never `ui:selectedRange:wb1` mixed in with assets). Statechart-modeled (§6 Controller region, conceptual). Lifetimes scoped to the editing session, not to the building. Destroyable without destroying any model fact.
- **Engine substrate** — the dependency graph itself. Inputs, derivations, dependencies, the commit log. Application code reads the substrate through the model and controller layers; it does not import substrate types directly except in the lowest-level adapters.

The package layout enforces the layering: `@causljs/core` is the engine substrate; `@causljs/react`, `@causljs/sync`, `@causljs/persistence`, `@causljs/devtools`, `@causljs/devtools-bridge`, `@causljs/formula` are adapters that bridge the substrate to specific controller / view technologies; the application owns the model layer and supplies the controller layer.

### 7.2 Capability narrowing as a security primitive

Mark Miller's framing on review — *"authority is what you can call, not what you know about"* — is the load-bearing reason capabilities exist as a §12.3 internal primitive. An adapter that hands its application code a full `Graph` handle has handed it the entire mutation pipeline; the application can call `commit`, `hydrate`, `commitMetadataDerived`, `exportModel`, anything. Most adapter use cases want a much smaller capability — a selector that reads a node, a listener that wakes on commits, a `now` getter. Handing those callers a full `Graph` violates principle of least authority for no reason.

`narrowCapability(graph, allowedMethods): NarrowedGraph` is the seam. Runtime: the returned proxy intercepts every method call; access to a method outside `allowedMethods` throws `CapabilityViolation`. Compile-time: the `NarrowedGraph` type is `Pick<Graph, ...allowedMethods>`, so a caller that tries to spell `narrowed.commit(...)` fails `tsc` before the code runs. The two enforcement layers are deliberate — the type narrowing catches the honest mistake at compile time; the runtime proxy catches the dishonest reach (`(narrowed as Graph).commit(...)`) by failing closed.

`ReadOnlyGraph = Pick<Graph, 'read' | 'subscribe' | 'subscribeCommits' | 'now'>` is the canonical narrow type — the read-side capability slice every adapter needs and nothing more. It is `@causljs/core/internal`-only per §12.3: applications should not name `ReadOnlyGraph` in their own types because the adapter that supplies the narrowed handle is the one that owns the slice. Per #371, #433, and #441, each adapter declares its own `Pick<Graph, ...>` alias for the slice it actually needs:

- `@causljs/react`'s selector boundary uses `Pick<Graph, 'read' | 'subscribe' | 'now'>` (no `subscribeCommits` — selectors don't need the commit firehose).
- `@causljs/persistence`'s observer uses `Pick<Graph, 'read' | 'subscribeCommits' | 'now' | 'commitLog'>` (no per-node `subscribe` — persistence reacts to commits, not to individual node changes).
- `@causljs/devtools-bridge`'s host channel uses `Pick<Graph, 'read' | 'subscribeCommits' | 'now' | 'commitLog' | 'snapshotAt' | 'readAt' | 'dependencies' | 'dependents'>` (no `commit`, no `hydrate` — the bridge is read-only by §13's view-only-JUMP discipline).

Each adapter's slice is the smallest set of `Graph` methods that adapter actually calls. The slice is documented at the adapter's seam, gated by `narrowCapability`, and audited the same way §12.2's twelve second-tier rows are: any adapter that wants to widen its slice writes the justification in the adapter's own README and the §12.3 row that catalogues `narrowCapability`'s consumers gets updated.

### 7.3 Mechanical enforcement: the ESLint layering rule

The §7 layering needs a mechanical gate, not a review-policy gate, because review is fallible and a layering violation that lands silently is the kind of bug that gets baked in over months. Per #393 and #435, `eslint.config.js` carries a `no-restricted-imports` rule that codifies the layering at lint time:

- **Inversion gate** — `@causljs/core` may not import from any sibling adapter (`@causljs/react`, `@causljs/sync`, `@causljs/persistence`, `@causljs/devtools`, `@causljs/devtools-bridge`, `@causljs/formula`, `@causljs/checker`, `@causljs/bench`, `@causljs/migration-check`). The engine substrate is the bottom of the layer stack; reaching into an adapter inverts the layering and creates the kind of two-way coupling that lets controller-shaped types leak back into the core barrel. The error message names the spec section (`SPEC §17.3 / §7`) so a developer who hits the rule has the rationale one click away.
- **Deep-path gate** — adapter packages may reach engine internals only through the documented `@causljs/core/internal` entrypoint, never through `@causljs/core/dist/*` or `@causljs/core/src/*`. The `exports` field in `packages/core/package.json` already refuses to resolve such paths at runtime; this rule codifies the same contract at lint time so a future bundler or tsconfig change cannot silently re-open the back door.

The team considered three options for enforcement. The other two are recorded so the next reviewer who wants to change the gate has the trade-offs in front of them.

1. **`no-restricted-paths` ESLint rule.** Same shape as `no-restricted-imports`, with explicit zone definitions (`packages/core/**` is one zone; `packages/*/src/**` is another). Rejected on the cost of declaring zones — for nine adapters, the config is nine times longer, and every new adapter requires editing the rule. `no-restricted-imports` reads the inversion gate as "core mustn't import these names" and the deep-path gate as "adapters mustn't reach these paths," which is exactly the contract.
2. **Package-json directional check.** A custom script that walks every package's `dependencies` and asserts the directional invariant (core has no adapter deps; adapters' core dep is `^X.Y.Z` not `link:`). Rejected on the friction it adds to `pnpm install`: every new adapter requires editing the script's allow-list, every dev-dependency upgrade requires re-running the check, and the failure mode is a script failure with no IDE-integration ("which import line did this?"). The lint rule fails on the offending line, in the editor, the moment the import is typed.
3. **IR-level static rule in `causl-check`.** The Rust binary already runs as a CI gate (§16); a layering pass would walk `CauslModel.nodes` and assert no node's compute reaches across a layer boundary. Rejected on scope: the IR is the contract between `@causljs/core` and the checker, and layering is a contract between `@causljs/core` and the *adapter packages* — a different boundary at a different abstraction level. Layering violations live in import graphs, not in the IR. The lint rule sits at the right boundary.

The team picked the ESLint rule. Lowest friction (the rule fires in the editor on the offending line), runs in dev and CI without a separate workflow, and the configuration scales linearly — the addition of a new adapter is a one-line addition to the `group` array. §17 commitment 3 marks layering as MECHANICAL because of this rule.

### 7.4 What the team rejected and why

The team rejected a "layering by README convention" approach (no mechanical gate; reviewers catch violations in PR review) because a single missed review buries the violation in `main`, and once `@causljs/core` imports from an adapter, every subsequent PR pays the cost of *not* reverting the import. The mechanical gate fails on the offending line on the offending PR and never lets the violation become history.

The team rejected promoting `narrowCapability` to §12.2 (a public Graph method instead of a §12.3 internal primitive) because applications should not be in the business of narrowing capabilities directly — the adapter that supplies the handle owns the slice, and exposing the narrowing primitive on the public surface invites every application to invent its own slice taxonomy. The §12.3-internal positioning is what makes adapter slices a reviewable contract instead of a free-for-all.

The team rejected a "controller layer in `@causljs/core`" alternative (a controller-shaped type that ships with the engine, so applications inherit a controller vocabulary) because the controller is the most application-specific layer in the §7 stack — a spreadsheet's controller, an asset-hierarchy editor's controller, and a booking system's controller share almost no vocabulary. Shipping a generic controller in `@causljs/core` is the same mistake the previous draft made by listing eleven inspirations and stacking them with plus signs. The controller layer is application-supplied; the conceptual region in §6 is the teaching diagram that explains why.

---

## 8. MVU shaped surface

The previous draft had no Update story at all. `tx.set(node, value)` is a *write API*, not a *thinking API*; application developers do not think "I will mutate `cell:wb1:Sheet1:A1`," they think "the user clicked Save." Evan Czaplicki's review of the original §8 was the cleanest single critique the team applied to this spec: write down what the application loop *is*, not just what its leaves do. The Elm Architecture's three-part decomposition — model, view, update — is the shape this section commits to, with one concession to the engine's existing semantics: the model is the live `Graph` handle, not a value-typed snapshot.

Concretely, the framing the team defends:

- **Model** — the graph itself. `Graph` is a stable handle whose `now` advances by exactly one tick per `graph.commit(...)`. There is no separate "store"; the engine's value-of-record is the graph.
- **View** — pure projection via selectors. A view is a function `Graph → A` evaluated through `graph.read(node)` (or `useCausl(selector)` in React). Views never mutate.
- **Update** — `(msg, graph) => void`. The handler receives a typed `Msg`, dispatches on the discriminator, and issues `graph.commit(...)`. The return type is `void` because the seam is the commit, not the return value.

Three signatures were on the table for `Update`. Czaplicki's reflex was the Elm-pure shape `(model, msg) => model`, where the runner returns the next model and the host reconciles. The original draft of `@causljs/react` shipped a third hybrid, `(msg, graph) => Graph`, where the handler called `graph.commit(...)` *and* returned the same handle for chaining. The team picked the imperative `(msg, graph) => void` shape, against Czaplicki's first instinct, for one reason: the returned graph in the prior signature was vestigial — the caller already held the same handle, the handle's identity was unchanged across the call, and the only effect of "forgetting to return" was a confusing `undefined` crash on the next dispatch. Per #377, this matches §8 prose: *Update is imperative against a Graph handle; the engine's `commit` is the seam.* Czaplicki accepted the deviation on review on the understanding that the model identity invariant (one engine, one clock, advancing by one) is what made the Elm-pure return redundant in the first place.

Sebastian Markbåge's review focused on the React-render contract. The MVU runner does not own the render loop; React does. Dispatch returns synchronously *after* the commit has published, so by the time the dispatcher's `Promise<void>` (it isn't one — it's plain `void`) resolves, every per-node subscriber and every `subscribeCommits` observer has fired, and `useSyncExternalStore` has the new snapshot ready for the next render. That ordering is the §5 single-pipeline guarantee carried into React. There is no `dispatch().then(...)`; there is no "the commit is queued and you'll see it next tick." Markbåge's note: if dispatch ever became asynchronous, the MVU framing would lose the property that `[msg₁, msg₂, msg₃]` is observably equivalent to three commits in order — and that is the property an `update` runner is for.

Dan Abramov's review pulled on the dispatch ergonomics. `useDispatch()` returns a referentially-stable function memoised against the graph and update identities on the surrounding `<CauslProvider>`; descendants depending on dispatch identity (effect deps, memoised handlers) do not churn every render. The reducer-history framing — every commit is a discrete record in `graph.commitLog`, replayable and inspectable — is the same affordance Redux made famous, except the log is a `DerivedNode<readonly Commit[]>` (§12.2), so the inspection surface composes through the same `read` / `subscribe` / `explain` API as any other graph value.

The team is splitting §8 into two sub-sections. The reason: two of the hooks are the canonical surface that matches the MVU framing exactly; the others are extension surface tied to specific React capabilities that ride on top of the canonical pair without changing the model.

### 8.1 Core hooks — the canonical pair

The canonical surface is two hooks plus the `Update` contract they implement against. This is the §8 promise distilled to what an MVU loop actually needs.

```ts
// The Update contract — imperative against a Graph handle.
type Update<Msg, G extends Graph = Graph> = (msg: Msg, graph: G) => void

// Read side: subscribe to a selector.
function useCausl<T>(selector: (g: Graph) => T): T

// Write side: dispatch a typed Msg.
function useDispatch<Msg>(): Dispatch<Msg>
```

`useCausl` is the read door; `useDispatch` is the write door; `Update` is the seam between them. There is nothing else in the canonical surface.

Matt Pocock's review was on the typed-`Msg` ergonomics. Per #432 the team shipped `defineMsgs` + `payload` + `MsgOf` so the same record-of-tags declares both sides:

```ts
import { defineMsgs, payload, type MsgOf, assertNever } from '@causljs/react'

const msg = defineMsgs({
  inc: null,
  dec: null,
  set: payload<{ value: number }>(),
})
type CounterMsg = MsgOf<typeof msg>
//   ^? { kind: 'inc' } | { kind: 'dec' } | { kind: 'set'; value: number }

const update = createUpdate<CounterMsg>({
  inc: (_m, g) => { g.commit('inc', tx => tx.set(n, g.read(n) + 1)) },
  dec: (_m, g) => { g.commit('dec', tx => tx.set(n, g.read(n) - 1)) },
  set: (m, g)  => { g.commit('set', tx => tx.set(n, m.value)) },
})

dispatch(msg.inc())
dispatch(msg.set({ value: 3 }))
```

Pocock's gate was that adding a fourth tag had to be a compile error in *both* directions. Adding `'reset'` to the `defineMsgs` record without a matching handler is rejected at the `createUpdate` call site by the mapped-type constraint over `Msg['kind']`. Adding `'reset'` to the union without naming it in a `switch (msg.kind)` is rejected at the `assertNever(msg)` default arm — the `value: never` parameter is satisfied only when every variant has a `case`. Both gates fail closed; neither shipped before #432.

### 8.2 Extension hooks and the `<Hydrate>` boundary

The extension surface rides on the canonical pair to handle React-specific concerns the MVU framing does not name. None of these change the engine's contract; each handles a runtime capability the React render model exposes.

| Extension surface | What it adds beyond the canonical pair |
| --- | --- |
| `useCauslShallow(selector)` | Selector-result shallow comparison for object / array projections — re-render only when a key in the projection changes. |
| `useCauslFamily(family, key)` | Family-keyed node lifecycle bound to component mount; the underlying node is created on first read and `dispose`d (§12.3) on the last unmount. |
| `useCauslSuspense(node)` | Narrows on a `Resource = Loading \| Loaded \| Stale \| Errored` (§9) by throwing the engine-owned in-flight Promise on the `Loading` arm. Promise identity is stable across renders for the same loading episode. |
| `<Hydrate snapshot={...}>` | SSR boundary: on mount, calls `graph.hydrate(snap)` (§12.2) before any descendant subscribes. |

The split is a discipline, not a downgrade. The canonical pair is the surface every adopter writes against; the extension surface is opt-in and each row exists because a specific React capability needed an engine-side affordance to compose correctly.

**What the team rejected and why.** The Elm-pure `(model, msg) => model` shape (Czaplicki's first instinct) would have made the runner pure, but at the cost of either (a) cloning the graph on every dispatch — a non-starter against the §3 single-clock invariant — or (b) returning a vestigial handle the caller already holds. The hybrid `(msg, graph) => Graph` shape (the original `@causljs/react` ship) created the "forgot to return" trap without buying anything, so #377 cut the return type and §8 was rewritten around the imperative seam. The "nine hooks flat" listing the previous draft committed to was rejected against #420's two-tier discipline: the canonical pair is what an MVU loop *is*, and the extension hooks are what a React render model *needs*. Conflating them lost the framing.

---

## 9. Make impossible states impossible

The §9 discipline is older than this codebase: Anders Hejlsberg's TypeScript exhaustiveness-via-`never`, applied to the rule Sandi Metz states as *design types so the wrong call doesn't compile*. A struct with four optional fields encodes sixteen states, fifteen of which the design never wanted. The previous draft's `FormulaNode` carried `ast?`, `dependencies?`, `value?`, `error?`, permitting representations like *has a value AND an error AND no AST AND no dependencies* — a state every reviewer agreed was nonsense and that the type system permitted on every read.

The §9 commitment is: every place the previous draft used optional fields to encode distinct states, the engine ships a discriminated union with a `kind` discriminator and an `assertNever(value: never): never` exhaustiveness probe at every dispatch site. Adding a new variant produces a compile error at every switch instead of a silent runtime fallback. The helper lives at `@causljs/core/internal` (§12.3) and is re-exported from each adapter that consumes it.

The closed-issues catalog flagged five separate rediscoveries of this same lesson — #263, #370, #379, #388, #405 — across four different adapter packages, in PRs filed by four different reviewers, over an eighteen-month window. Five rediscoveries is the team's empirical evidence that *the pattern is the rule*, not a one-off. Codifying it in §9 as an explicit shape, with examples drawn from the parts of the codebase the rediscovery happened in, is what prevents the sixth.

The five canonical examples below are the shape. Each names the source PR/issue, the union itself, and the rule the optional-fields-encoding would have permitted that the union now forbids.

#### Example 1 — `Conflict<T>` (#263)

```ts
type Conflict<T> =
  | { kind: 'open';        raisedAt: GraphTime; payload: T }
  | { kind: 'resolved';    raisedAt: GraphTime; payload: T; resolvedBy: UserId; resolvedAt: GraphTime }
  | { kind: 'ignored';     raisedAt: GraphTime; payload: T; ignoredReason: string }
  | { kind: 'superseded';  raisedAt: GraphTime; payload: T; supersededBy: ConflictId }
```

Four arms, one payload per kind, every field required where the kind admits it. The conflict-registry sub-statechart in §6 names the same four states and the transitions between them; the type and the chart agree by construction.

#### Example 2 — `PersistenceError` (#370)

```ts
type PersistenceError =
  | { kind: 'schema-mismatch'; expected: number; actual: number }
  | { kind: 'migration-missing'; from: number; to: number }
  | { kind: 'corrupted-snapshot'; offset: number; reason: string }
  | { kind: 'storage-unavailable'; underlying: string }
```

No `cause?` hoist, no `instanceof` chains. Each kind carries the fields its caller needs to recover, and `assertNever` at the call site ensures every kind is handled.

#### Example 3 — `DevtoolsMessage` (#379)

```ts
type DevtoolsMessage =
  | { kind: 'jump-to-state'; time: GraphTime }
  | { kind: 'import-state'; snapshot: GraphSnapshot }
  | { kind: 'rollback'; toTime: GraphTime }
  | { kind: 'subscribe-commits' }
  | { kind: 'unsubscribe-commits' }
```

Flat tags. No `state?` hoist into a parent envelope.

#### Example 4 — `FormulaError` (#388 / #427)

```ts
type FormulaError =
  | { kind: 'unresolved-ref'; ref: CellRef }
  | { kind: 'non-numeric'; ref: CellRef; raw: string }
  | { kind: 'div-by-zero' }
  | { kind: 'circular' }
  | { kind: 'propagated'; cause: FormulaError }
```

The `propagated.cause: FormulaError` self-reference is the load-bearing detail; without it the chain decays to `Error` at the first hop and the typed-error discipline is lost.

#### Example 5 — `Formula` itself (engineered, deferred until first consumer)

This is the engineered design for the row §9.1 has marked aspirational since the original §9: a four-state discriminated union for `Formula` itself, mirroring the `Conflict` and `Resource` shapes that already ship.

```ts
type Formula =
  | { kind: 'unparsed'; source: string }
  | { kind: 'parsing';  source: string }
  | { kind: 'parsed';   source: string; ast: Ast }
  | { kind: 'errored';  source: string; error: FormulaError }
```

Transitions:

- `unparsed → parsing` — the parser is invoked.
- `parsing → parsed` — the parser succeeded; the AST is attached.
- `parsing → errored` — the parser failed; the `FormulaError` is attached.
- `parsed → unparsed` — the source was edited. The AST is dropped.

Parser entrypoint: `parseFormula(source: string): Formula`.

TDD plan when the four-state union ships:

- **Generator** — random `(source, edit-history)` pairs.
- **Property 1** — every observable `Formula` value is in one of the four arms.
- **Property 2** — every transition recorded by the harness matches the four allowed transitions.
- **Property 3** — for every `(kind: 'parsed', ast)` value, `ast === parseFormula(source).ast`.
- **Promotion gate** — `formula.test-d.ts` exhaustiveness fixture. Adding a fifth arm to `Formula` without updating every `switch` is a compile error.

Once the union and the exhaustiveness fixture land, the §9.1 row for "reading a partially-parsed formula" promotes from runtime-only to **compile-time + runtime guard** alongside `PersistenceError`.

### 9.1 Where each race class is caught

The race-class catalogue is the team's audit of which races are eliminated structurally and which require later layers. It is kept current as the engine grows; David Harel's review of the original §9.1 was that a chart-anchored row format gives every reviewer a single piece of paper to argue against. Seventeen rows today; if the count moves, every new row arrives in this table on the same PR that ships the new public API or it does not ship.

| # | Race class | Mechanism that catches it | Source | Layer |
| --- | --- | --- | --- | --- |
| 1 | Concurrent engine mutations | API shape: `graph.commit` is the only mutation entry; outside a commit the graph is read-only. | §5 | **API design** |
| 2 | Reading a not-yet-loaded resource value | Discriminated union `Resource = Loading \| Loaded \| Stale \| Errored`; accessing `.value` requires a tag check first. | §6 | **Compile-time** |
| 3 | Reading a partially-parsed formula | Today: runtime guard via `FormulaError` (#388 / #427). After the §9 four-state `Formula` union lands and `formula.test-d.ts` exhaustiveness fixture ships: compile-time + runtime. | #388 / #427 | **Runtime guard** today |
| 4 | Reading a committed-but-not-yet-published snapshot | API shape: there is no API to read inside another transaction's staging window. | §5 | **API design** |
| 5 | Diamond glitches (D recomputes off mismatched B and C versions) | The §3 semantic equation makes the bad state non-existent: `D(t) = f(B(t), C(t))` is a function. | §3 | **Semantic** |
| 6 | Stale-async: a fetch returns after its dependency changed | Per-resource statechart guard: `Loading → [stale] → Stale \| Errored`; detection compares originating `GraphTime` to current. | §6 | **Runtime** |
| 7 | Dynamic-dependency cleanup | Property-based test in Phase 1's acceptance gate (§10); two-sided check — stale deps drop AND fresh deps wire up. | §10; §16 stretch | **Pre-deploy fuzz** |
| 8 | Cycle in a derivation graph | Detected at the first commit that closes the cycle, with a structured `CycleError` naming the cycle path. The `strictCycles` option is preserved for backward compatibility but is a no-op as of #670/#705 — first-commit-time Phase D Kahn detection is sufficient and avoids the O(N²) registration-time DFS that capped `linear-chain × 1000` at 420 ms and overflowed the V8 stack on `linear-chain × 10000`. | #360, amended by #670 / #705 | **Runtime, first-commit** |
| 9 | Two app-level `Msg`s producing inconsistent intermediate model state | The MVU `update` is a function so sequences are deterministic, but if `update`'s logic itself races on stale reads the engine cannot tell. | §15.3.3 | **Application-side property tests** |
| 10 | Multi-user write-write race | Out of scope for this epic. | §13 | **Future epic — not promised** |
| 11 | Use-after-dispose on a family-keyed node | Engine throws `NodeDisposedError` from any `read`/`subscribe`/`tx.set` after disposal; tombstone lookup; exercised by `family.property.test.tsx` under `family-P4-disposed-tag`. | #124 | **Runtime guard** |
| 12 | Hydration mismatch (server-snapshot id-set ≠ client node-set) | `schemaHash` capability check at `hydrate()` time; mismatched snapshots rejected with `HydrationSchemaError`. | #184 | **API design** |
| 13 | Hydration emitted but subscribers don't wake | `hydrate()` routes through the same Phase A–H pipeline as `commit()`; one `Commit` with `intent: 'hydrate'` and `originatedAt: snap.time` published. | #366 / #378 | **API design** |
| 14 | Non-monotonic `GraphTime` on hydrate | `hydrate()` advances `now` by exactly one tick regardless of `snap.time`; on-the-wire snapshot label preserved as `originatedAt`. | #366 | **API design + semantic** |
| 15 | Time-travel jump is view-only and cannot fork an inconsistent history | `JUMP_TO_*` via `graph.snapshotAt(t)` returning `Retained \| Evicted` (§9 union); bridge's `applyJumpHandler` projects the snapshot and never hydrates the live engine. JUMP is a *view*, not an *edit*. Edit-mode JUMP deferred (§13). | #213 | **API design + compile-time** |
| 16 | Persistence schema-version mismatch silently overwriting on-disk data | Typed `PersistenceError` discriminated union (§9 Example 2); storage adapter never overwrites on the load-failure path. | #190 / #191 / #370 | **Compile-time + runtime guard** |
| 17 | Suspense fresh-Promise-per-render breaks SuspenseList / `startTransition` | The in-flight Promise lives on `ResourceState.loading` itself (one per loading episode, identity-stable across renders). | §8.2 | **API design** |

§9.1 Amendment 1 (#670 / #705) — row 8 cycle-detection move from registration-time to first-commit-time. The pre-#705 default-true `strictCycles` gate ran an O(|nodes|) DFS at every `derived()` registration that recursively forced upstream recomputes, refreshing stale dep records so a back-edge closed by outside-closure mutation (forward-reference holder) tripped the dirty-stack guard before the new entry landed. The cost was load-bearing on two cells: `linear-chain × 1000` reported a 420 ms median against a 5 ms audit floor, and `linear-chain × 10000` overflowed the V8 stack (registration of the tail node consumed 10 000 stack frames through the recursive `computeDerived` walk). The repair has two halves. **Half one** drops the registration-time DFS — the eager walk now runs once per registration via a new iterative driver (`computeDerivedIterative`) with no upstream-refresh recursion; chain registration retires to O(N) total work and consumes a constant number of V8 stack frames. **Half two** augments Phase D's Kahn pass with a post-recompute back-edge probe: after each recompute records its dynamic dep set, the engine forward-walks the just-recorded deps along the live `entries.deps` graph and throws `CycleError` if the just-recomputed entry is reachable. The probe catches the same holder-mutation cycles the old registration gate caught, but on the first commit that walks into the SCC rather than at the closing `derived()` call. The `strictCycles` option remains accepted on `createCausl({ strictCycles })` for one major version (so adopter call sites do not have to be edited in lockstep with the gate removal) and is documented as deprecated; both `true` and `false` produce identical first-commit-time semantics.

The next two sections push more of the runtime and pre-deploy-fuzz rows toward pre-runtime: §15 turns property-based fuzz into the explicit race-detection commitment, and §16 ships the static IR linter that lifts rows it can decide statically into compile-time-equivalent CI gates. The deeper bounded-enumeration shape originally drafted for §16 is deferred (#272 closed not-planned) and is named explicitly there.

**What the team rejected and why.** Five separate issues rediscovered the same DU-versus-optional-fields lesson over an eighteen-month window. The pattern is not that any one of these designs was wrong on review; it is that the *same* design mistake kept being made because §9 had not codified the shape. Codifying the pattern in §9 with five worked examples, plus the engineered fifth (`Formula`), prevents the sixth rediscovery. The team rejected two alternatives: (a) hoist the pattern into the `@causljs/core/internal` API surface only — rejected because adapter packages would not see the discipline applied to *their* domain types; (b) leave §9 as prose with no examples — rejected because the rediscovery rate is the empirical evidence that prose alone does not transmit. Five examples and one engineered design is the calibration the team could defend.

---

## 10. Worked example

Kent Beck's framing for this section is the part the team most often quotes back at itself: until the worked example works, no other phase begins. The example is small, runnable, and pinned in CI as `packages/core/test/spec-10-worked-example.test.ts` — three test blocks, each a separately-named acceptance for one facet of the engine's promise. The §17 commitment numbered 6 is the contract: this is the gate. If it regresses, the engine is broken; if it holds, the four invariants the example was constructed to expose hold with it.

The team considered three shapes for the §10 acceptance. The first — direct-`commit` only — is the smallest possible proof of engine semantics. The second — MVU-only — is the smallest possible proof of §8 ergonomics. The team picked **both**: the direct form proves the engine, the MVU form proves the front door, and asserting that both produce identical observed sequences is the proof that §8 is not a parallel pipeline. Czaplicki's review on the MVU half was the one that locked it in (per #439): the MVU listing has to land in the same test file as the direct listing, or the equivalence is unverified.

### 10.1 The direct `commit` form

```ts
const graph = createCausl()
const a = graph.input('a', 1)
const b = graph.input('b', 2)
const sum = graph.derived('sum', (get) => get(a) + get(b))
const sumPlusOne = graph.derived('sumPlusOne', (get) => get(sum) + 1)

const log: number[] = []
graph.subscribe(sumPlusOne, (v) => log.push(v))
// 4  — initial subscription fire

graph.commit('bump-a', tx => tx.set(a, 10))
// 13

graph.commit('bump-both', tx => { tx.set(a, 100); tx.set(b, 200) })
// 301  — exactly one notification, not two

expect(log).toEqual([4, 13, 301])
expect(graph.now).toBe(2)
```

If this works, the engine is real. The four invariants Beck named on review fall out of the construction: atomic commit (the third propagation is `301`, not the spurious `201` an interleaved write would produce); dependency tracking (the derived sum recomputes when either input changes); dynamic-dep cleanup (covered in §10.3 below); glitch-free diamond.

### 10.2 The MVU front-door form

Per #439, the same shape driven through the §8 surface, asserting the same observed sequence and the same final clock:

```ts
import { defineMsgs, payload, type MsgOf, createUpdate } from '@causljs/react'

const msg = defineMsgs({
  'bump-a': payload<{ value: number }>(),
  'bump-both': payload<{ a: number; b: number }>(),
})
type Msg = MsgOf<typeof msg>

const graph = createCausl()
const a = graph.input('a', 1)
const b = graph.input('b', 2)
const sum = graph.derived('sum', (get) => get(a) + get(b))
const sumPlusOne = graph.derived('sumPlusOne', (get) => get(sum) + 1)

const update = createUpdate<Msg>({
  'bump-a':    (m, g) => { g.commit('bump-a', tx => tx.set(a, m.value)) },
  'bump-both': (m, g) => { g.commit('bump-both', tx => { tx.set(a, m.a); tx.set(b, m.b) }) },
})

const log: number[] = []
graph.subscribe(sumPlusOne, (v) => log.push(v))

const messages: readonly Msg[] = [
  msg['bump-a']({ value: 10 }),
  msg['bump-both']({ a: 100, b: 200 }),
]
for (const m of messages) update(m, graph)

expect(log).toEqual([4, 13, 301])
expect(graph.now).toBe(2)
```

Same observed values. Same `graph.now`. The §8 promise is that this is a documentation choice, not a different engine; the test pins that.

### 10.3 The dynamic-dep cleanup invariant

Per #361, the third block covers the one invariant the first two cannot expose: dynamic-dep cleanup is two-sided. Stale deps must drop *and* fresh deps must wire up.

```ts
const graph = createCausl()
const a = graph.input('a', 1)
const b = graph.input('b', 2)
const flag = graph.input('flag', true)

let chosenComputes = 0
const chosen = graph.derived('chosen', (get) => {
  chosenComputes++
  return get(flag) ? get(a) : get(b)
})

chosenComputes = 0
graph.commit('flip-off', tx => tx.set(flag, false))
const baseline = chosenComputes

// Negative half: stale `a → chosen` edge must have been dropped.
graph.commit('bump-a-not-read', tx => tx.set(a, 999))
expect(chosenComputes).toBe(baseline)

// Positive half: fresh `b → chosen` edge must be live.
graph.commit('bump-b-now-read', tx => tx.set(b, 42))
expect(chosenComputes).toBe(baseline + 1)
expect(graph.read(chosen)).toBe(42)
```

Both halves of the invariant are pinned. This is the row §9.1 marks as **pre-deploy fuzz** — the type system cannot see across the `if`-branch inside the `derived` body, so the property-based suite (§15) is the layer that closes it.

**What the team rejected and why.** The team considered three §10 acceptance shapes. The first — direct-commit only — was rejected because it provides no proof that §8's MVU framing is an honest claim about the engine. The second — MVU-only — was rejected because it loses the engine-only proof. The team picked both: the direct form proves engine semantics; the MVU form proves §8 ergonomics; the equivalence assertion is the proof that the front door composes onto the engine without behavioral drift.

---

## 11. Liveness

The §11 framing is one sentence: **the engine is its own observer**. Inspection primitives are themselves Graph nodes; subscribing to `whyUpdated(node)` is the same operation as subscribing to any other derived. There is no parallel devtools state model, no shadow event bus, no "reactivity for production / events for inspection" split. Conal Elliott's reading of the same point in FRP terms — that the commit log is a `Behavior [Commit]`, not a stream we attached afterward — is what locks the framing in.

### 11.1 Inspection primitives

Five primitives realise §11 today. Each is a Graph node (or a one-shot projection that composes with one), so each participates in `read`, `subscribe`, `explain`, `readAt`, and `snapshotAt` uniformly with any other node.

- **`graph.commitLog`** (getter) — `DerivedNode<readonly Commit[]>`. The bounded ring-buffer history surfaced as a derived node. Realises Elliott's `Behavior [Commit]` in TypeScript: `subscribe(graph.commitLog, observer)` fires once initially with the current log and once per successful commit thereafter.

- **`whyUpdated(node)`** (in `@causljs/devtools`) — `DerivedNode<WhyUpdatedResult>`. Returns a derived node that recomputes once per commit and answers "what most recently caused this node to update?" Tags: `recomputed | directly-set | no-cause`.

- **`whyNotUpdated(node)`** (in `@causljs/devtools`) — `DerivedNode<WhyNotUpdatedResult>`. The dual of `whyUpdated`. Tags: `did-update | no-dep-overlap | object-is-deduped | no-cause`.

- **`graph.dependencies(node)`** — `readonly NodeId[]`. A one-shot snapshot of the node's direct (depth-1) upstream ids at the current committed time, lex-sorted.

- **`graph.dependents(node)`** — `readonly NodeId[]`. Sister primitive on the reverse edge.

**§11.1 amended (#701):** `subscribeReads(observer, projection)` is the engine-tracked-deps variant of `subscribeCommits`. The engine runs `projection()` once at registration, captures the read-set via the same tracking accessor used for derived computes, and fires `observer(commit, value)` on every commit whose `changedNodes` intersects the captured set. Conditional reads are handled automatically: each re-run refreshes the read-set. This is the contract-layer surface for "subscribe to a derived projection without registering a `derived` node," and is the dispatch shape that `useCauslNode` and similar React adapters can build on without round-tripping through `subscribeCommits`'s every-commit fan-in.

### 11.2 The Phase F.5 seam

`whyUpdated` and `whyNotUpdated` were not derivable through plain `graph.derived(...)`. PR #383 attempted exactly that and surfaced a regression: subscribers fired with the *previous* commit's answer because Phase D — the engine's recompute fixpoint — walks the affected sub-graph against the previous commit's `commitLogEntry.value` (Phase F.4 has not run yet).

The repair is the `commitMetadataDerived(id, compute)` factory, which schedules its derived in Phase F.5, between Phase F.4 (`commitLogEntry.value` refresh) and Phase G (per-node subscriber dispatch). Tagged nodes recompute in F.5, so they see the just-completed commit on the same commit that produced it. Subscribers fire from Phase G with the post-commit value. Ordinary `derived(...)` is unaffected — its Phase D atomicity is the §3 invariant the engine cannot give up. The engine fix and the devtools-side adoption shipped together (#452, #455, #456).

### 11.3 What we did *not* ship for §11

- **Live `dependencies(node) → DerivedNode<readonly NodeId[]>`**. Would require a second metadata seam beyond F.5. Reopen trigger: a UI that genuinely cannot poll on `subscribeCommits`.
- **A `@causljs/repl` package**. The original §11 prose promised "a REPL connected to a running graph." The primitives that make a REPL real have shipped — `liveDerived` (devtools-side hot-swap of compute closures), `replaceMany` (atomic batch swap), `commitMetadataDerived` (Phase F.5 seam) — and the runnable artefact is `docs/demo.md`. A REPL is a usage pattern composed from those three primitives, not a new primitive that earns its own surface row.

**What the team rejected and why.** A "devtools panel" sitting next to the engine — Kay's pushback was unanswerable: a parallel observer system means the engine is *not* its own observer. `whyUpdated` returning a `WhyResult` synchronously — ergonomic, but breaks the §11 framing. A live `commitLog` slice via plain `derived(...)` — shipped in #383, regressed, reverted, replaced by the F.5 seam. A separate `@causljs/repl` package — surface inflation against §17 commitment 6.

---

## 12. Public surface

I keep the contract small and audited. The `Graph` interface in `@causljs/core` is the most-watched contract in the project. The previous draft of this section claimed "seven and only seven." That was a slogan, not a contract. The honest count is **twenty public Graph methods/getters today**: seven canonical that the engine cannot exist without (§12.1), and thirteen second-tier extensions that the engine could in principle be smaller without (§12.2) but that adapter packages and inspection primitives would then have to invent themselves and drift from. Each second-tier row carries its own justification; the `clearCommitHistory` row that used to live there was struck in #401 because the justification had faded.

Below the public surface, the engine ships two additional entrypoints (§12.3, §12.3.1) for adapter packages and test files respectively. Neither is part of the public commitment; both are documented because hiding them would be dishonest about how the codebase is actually organised.

### 12.1 Canonical seven

| Primitive | Signature | Purpose |
| --- | --- | --- |
| `createCausl` | `(options?: CreateCauslOptions) => Graph` | Construct an engine instance. |
| `Graph.input` | `<T>(id: NodeId, initial: T) => InputNode<T>` | Register a writable Behavior; `input(t₀) = initial`. |
| `Graph.derived` | `<T>(id: NodeId, compute: Compute<T>) => DerivedNode<T>` | Register a composed Behavior; deps captured by tracked `get` calls. |
| `Graph.commit` | `(intent: string, run: (tx: Tx) => void) => Commit` | Discrete event; advances time by exactly one. |
| `Graph.read` | `<T>(node: Node<T>) => T` | Read at the current committed time (outside a commit). |
| `Graph.subscribe` | `<T>(node: Node<T>, observer: Observer<T>) => Unsubscribe` | Per-node observer; once per commit during which value changed. |
| `Graph.explain` | `<T>(node: Node<T>) => DerivedNode<Explanation>` | Derived lineage view, itself subscribable. |

### 12.2 Second-tier extensions

| Surface | Signature | Purpose |
| --- | --- | --- |
| `Graph.subscribeCommits` | `(observer: (commit: Commit) => void) => Unsubscribe` | Narrow per-fire notification capability. |
| `Graph.subscribeReads` | `<T>(observer: SubscribeReadsObserver<T>, projection: () => T) => Unsubscribe` | Engine-tracked-deps variant of `subscribeCommits` (§11.1 amended, #701). |
| `Graph.commitLog` (getter) | `DerivedNode<readonly Commit[]>` | Realises §11's `Behavior [Commit]` commitment. |
| `Graph.exportModel` | `(options?: ExportModelOptions) => CauslModel` | The §16 bridge to `causl-check`. |
| `Graph.snapshot` | `() => GraphSnapshot` | Captures input set + GraphTime as a serialisable envelope. |
| `Graph.hydrate` | `(snap: GraphSnapshot) => void` | Routes a snapshot through the same Phase A–H commit pipeline. |
| `Graph.readAt` | `<T>(node: Node<T>, t: GraphTime) => RetentionResult<T>` | Per-node read at past committed time. |
| `Graph.snapshotAt` | `(t: GraphTime) => RetentionResult<GraphSnapshot>` | Whole-graph snapshot at past committed time. |
| `Graph.simulate` | `(intent: string, run: (tx: Tx) => void) => SimulateResult` | Dry-run primitive; observer-invisible. |
| `Graph.dependencies` | `<T>(node: Node<T>) => readonly NodeId[]` | Direct upstream ids; one-shot snapshot. |
| `Graph.dependents` | `<T>(node: Node<T>) => readonly NodeId[]` | Direct reverse-dep ids; sister primitive. |
| `Graph.commitMetadataDerived` | `<T>(id: NodeId, compute: Compute<T>) => DerivedNode<T>` | Phase F.5 opt-in factory for derivations that read commit metadata. |
| `Graph.now` (getter) | `GraphTime` | "What time is it?" without firing a commit. |

**Twenty public Graph methods/getters today (seven canonical + thirteen second-tier).** The team audits this count quarterly. The previous spec promised seven and only seven; honesty cost thirteen more rows. The most recent addition is `subscribeReads` (#701, SPEC §11.1 amended).

### 12.3 Internal-only adapter entrypoint (`@causljs/core/internal`)

A separate entrypoint with strict capability discipline. Adapter packages import these via `@causljs/core/internal`; application code never does. An ESLint rule (#393, #435) enforces the layering at the import statement.

| Surface | Used by | Why internal |
| --- | --- | --- |
| `dispose(graph, node)` | `@causljs/react` `useCauslFamily` lifecycle (#124) | Adapter-owned lifecycle. |
| `narrowCapability(graph)` | `@causljs/react` selectors and listeners | Mark Miller's principle of least authority. |
| `ReadOnlyGraph` (type) | Same as `narrowCapability` | The capability-slice type. Never re-exported on a public adapter barrel (#385). |
| `CapabilityViolation` (class) | Adapter-side test assertions | Thrown by the `narrowCapability` Proxy when application code reaches for excluded authority. |
| `assertNever(value, hint?)` | All adapters (#273) | Adapter-shared exhaustiveness helper. |
| `INTERNAL_ENTRYPOINT` (sentinel) | `internal.test.ts` wiring assertion | Sentinel string confirming the entrypoint resolves. |

#### 12.3.1 Testing seam (`@causljs/core/testing`, npm: `@causljs/core-testing-internal`)

A third entrypoint with a different audience. Test files only.

| Export | Purpose |
| --- | --- |
| `propertyTrials(name, options?, run)` | Property-test trial harness; the §15.2 conformance walker (#437) enforces a 1000+ trial floor. |
| `propertyDag(...)` / `buildPropertyDag(...)` | Random-DAG generators with deterministic seeds. |
| `recomputeCounter()`, `glitchDetector()` | Property-test instrumentation. |
| `assertConsistentGraphTime(trace)`, `assertResultStability(probe)` | Property-test invariant checks. |
| `disposedTombstoneSize(graph)` | Accessor for the tombstone-bookkeeping property test (#251). |

Three entrypoints, three audiences: `@causljs/core` for application code, `@causljs/core/internal` for adapter code, `@causljs/core/testing` for test code. The boundaries are mechanically enforceable.

### 12.4 In-flight additions awaiting classification

*(Empty — retired by EPIC #283. The §395 cautionary tale: `snapshotAt` shipped straight to public bypassing this lot, and only entered §12.2 retroactively. Every new public-surface item passes through §12.4 before landing, with no exceptions.)*

### 12.5 Adapter package surface

`@causljs/core` is the most-watched contract; adapter packages change at their own pace. SPEC §12 audits only the `@causljs/core` `Graph` interface. Each adapter's public surface lives in its own README:

| Adapter | README |
| --- | --- |
| `@causljs/react` | `packages/react/README.md` |
| `@causljs/sync` | `packages/sync/README.md` |
| `@causljs/persistence` | `packages/persistence/README.md` |
| `@causljs/devtools` | `packages/devtools/README.md` |
| `@causljs/devtools-bridge` (private; §13 deferred-product) | `packages/devtools-bridge/README.md` |
| `@causljs/formula` | `packages/formula/README.md` |
| `@causljs/checker` | `packages/checker/README.md` |
| `@causljs/migration-check` | `packages/migration-check/README.md` |
| `@causljs/bench` (workspace-private; not published) | `packages/bench/README.md` |

**What the team rejected and why.** "Seven and only seven" — honest auditing produced twelve more rows. Re-adding `clearCommitHistory` as an internal helper — the §17 commitment 7 reason it was removed (observer-visible mutation outside the commit boundary) does not change just because the surface moves. Enumerating adapter exports inside SPEC §12 — each adapter changes at its own pace; per-README is the lower-cost honesty pass. Hiding §12.3 / §12.3.1 — pretending the codebase is organised differently than it is.

---

## 13. Deferred capabilities

I am not promising any of the items in this section. Each row carries a status — **DEFERRED** (designed, may ship if a trigger fires) or **NOT-PLANNED** (the team has actively decided this is out of scope) — and a reopen trigger if applicable.

### 13.1 Bounded model checker — DEFERRED

**v1 ships a static IR linter; the bounded enumerator is deferred not-planned per #272.** The §16.0 banner is the canonical source for the deferral; the engineered design lives in §16.4–§16.6 in conditional voice. Reopen trigger: see §16.0.

### 13.2 Edit-mode time travel — DEFERRED

Today's JUMP is view-only (#213): the bridge's `applyJumpHandler` projects `graph.snapshotAt(t)` and never hydrates the live engine. If reopened:

- **`Commit.parentTime?: GraphTime`** — opt-in field on the published `Commit` record, populated when a caller invokes `graph.commit(intent, run, { parentTime })`.
- **JUMP path in `@causljs/devtools-bridge`** — switches from view-only `snapshotAt(t)` to branch-forking when `parentTime` is set.
- **Property test on reopen** — a forked timeline preserves §3 monotonicity *within each branch*.

Reopen trigger: a use case that genuinely needs branched commit history. None today.

### 13.3 Multi-graph composition / nested graphs — NOT-PLANNED

§3's denotational model commits to a single totally-ordered `GraphTime` line. Multi-graph composition implies one of three semantic shapes — product, tree, or sum of sibling timelines — and only one of the three preserves Theorems 1–4 without a research-grade extension to §3.

**The three semantic shapes.** Conal's reading on review:

- **Product timelines** (`GraphTime_A × GraphTime_B`). A parent derived `f(b_A(t_A), b_C(t_C))` reads two clocks; Theorem 2 (glitch-freedom) becomes ill-typed because there is no shared `t` to evaluate at. The natural repair forces the parent to sample a child clock at every parent advance, which collapses the design back to single-time with id-prefixes — degenerate.
- **Tree timelines.** A child commit propagates upward; the parent advances when a child does. Theorems 1, 2, 4 hold per branch; Theorem 3 (atomicity) is the casualty — a parent transaction touching two children needs distributed atomicity across child pipelines, and §5's "exactly one mutation pipeline" dies with it.
- **Sum / sibling timelines.** Functionally equivalent to two `createCausl()` instances sharing one event loop. No §3 ripples — the timelines never compose. The application orchestrates ordering through its own `subscribe` / `subscribeCommits` glue. **This shape is supported today.**

Only the sum shape preserves the four §3 theorems. The other two are research, not engineering.

**The §4 collapse argument.** Anders's call: a `SubGraphNode` would be a third arm of the `Node<T>` union — an explicit defection from the §4 two-primitive collapse #359 / #368 spent their budget closing. Adapter packages already model "nested state" as composition over `Input | Derived`: a child graph is a set of nodes registered under a shared id-prefix in the same `Graph` instance. A first-class `subgraph(parent, ...)` primitive would not be a fourth Node kind — it would be a third kind of mutation pipeline, and §5's contract is that there is exactly one.

**Use cases the team has heard.** Six candidate adopter scenarios, none of which requires multi-time semantics:

| Scenario | Resolution today |
| --- | --- |
| Form per row in a list | `useCauslFamily(rowId, factory)` — one identity-keyed Node per row, refcounted, microtask-deferred disposal |
| Plugin sandbox with state isolation | `narrowCapability(graph, ['read', 'subscribe'])` — host issues a capability-narrowed handle; Mark Miller's POLA |
| Multi-tab app with BroadcastChannel | One `createCausl()` per tab; `@causljs/sync` brokers cross-tab |
| iframe-isolated child app, micro-frontend | Separate process, separate engine; composition lives at the message layer |
| Notion-style nested document tree | Tree-shaped Node namespace (`doc:root/page-A/block-12`) inside one graph |
| Undo stack per subtree | `commitMetadataDerived` filtered by id-prefix |

The closed-PR record contains zero requests for sub-graph, embedded graph, or nested provider with shared time. The features adopters actually use — `<CauslProvider>` boundaries, separate engines per tab, capability-narrowed handles — already work today.

**The TanStack Query precedent.** Tanner: I shipped `QueryClient` in TanStack Query and deliberately did *not* ship `QueryClient.parent` or hierarchical caching. The decisions that closed it there close it here too: hierarchical caching produces cache-invalidation rules adopters consistently misread; the test surface roughly 2.4×s for the same coverage when nested clients are prototyped; the bundle cost was non-trivial for a feature near-zero of users would adopt. Causl's situation is strictly worse than Query's because GraphTime nesting is a semantic question Query did not face.

**The §14.2 bundle math.** Sebastian's audit: a pure-additive `embedGraph` API is roughly 7–8 KB across `@causljs/core` (cross-graph dependency tracking, cross-graph subscriber dispatch, new typed errors, cross-graph rollback, branded `GraphId`). That lands core at ~16.6 KB working — crossing the 18 KB working target and chewing two-thirds of the headroom from 18 to 30 KB. It pays back no invariant the type system cannot already express; fails §14.2's "production bytes pay for invariants the type system cannot express" rule on inspection.

**The engineered shape if §13.3 reopens — `@causljs/coordinator`.** Trygve's reframe: the parent/child framing is the wrong frame; there are siblings composed by a coordinator. The shipping shape if the trigger fires is a sibling adapter, not an extension of `@causljs/core`. The coordinator is itself a `Graph` whose Inputs are deltas observed from sibling graphs through the `ReadOnlyGraph = Pick<Graph, 'read' | 'subscribe' | 'subscribeCommits' | 'now'>` capability slice (§7.2). Each sibling appears to the coordinator as a §6 ResourceFleet entry — `idle | loading | loaded | stale | errored` keyed on sibling `now` — so the stale-async guard from §9.1 row 6 is the same guard that protects within-graph async resources. No new top-level chart region; no new public surface on `@causljs/core`; no extension to the §5 pipeline. Markbåge's reading: composing pipelines kills §5.2's byte-identical rollback property the moment a child throw mid-pipeline forces a parent partial-rollback; the coordinator-shaped design observes sibling commits between its own rounds and never re-enters a sibling's pipeline.

**Reopen trigger.** A use case that (a) genuinely cannot fit on a single graph with `useCauslFamily` plus capability narrowing plus per-process engines, (b) names the specific row in §12 the existing surface fails on, AND (c) sketches the §3 multi-time extension — `GraphTime₁ × GraphTime₂` product order, partial order with merge points, or per-engine independent times — that the use case implies. All three conditions, not any one. The previous "research without a use case" formulation stands; this rewrite fixes the silence on *why* the team will not reopen on a vague ask.

**What the team rejected and why.** Promoting to first-class `embedGraph(parent, child)` — rejected on three independent grounds: §3's denotational model requires a multi-time extension that no existing use case earns (Conal); §4's two-primitive collapse weakens (Anders); §14.2's bundle math fails on inspection (Sebastian, Tanner). The compile-time form — promoting `Graph` to `Graph<RootClock> | SubGraph<RootClock, ChildClock>` — is the §13.4 mistake repeated: every consumer pays the inference tax forever for a runtime feature that does not exist (Matt). The composed-pipeline form was rejected in architectural review because it forces a synchronisation alphabet between two §6 Engine regions that does not exist; per Harel, until the synchronisation is drawn, there is no system, only two systems pretending. Designing the multi-time semantics speculatively — rejected because the research-without-use-case shape is precisely what §13's NOT-PLANNED status discriminates against.

### 13.4 Public `Disposed` arm on `Node` — NOT-PLANNED

The runtime check (`NodeDisposedError` thrown by `read`/`subscribe`/`explain`) is exhaustive in practice. Promoting to a compile-time discriminator (`Node<T> = Live<T> | Disposed`) would require every consumer to handle the `Disposed` arm everywhere — a major API breaking change.

Reopen trigger: a use case where the runtime guard's failure mode is observably worse than a compile-time discriminator. None today.

### 13.5 Spreadsheet engine — DEFERRED (via separate adapter)

`@causljs/formula` ships as a separate adapter package; the core itself does not parse expressions, does not know about `=SUM(...)`, does not know about cell references. Reopen trigger for folding into core: none.

### 13.6 Async resources — DEFERRED (via separate adapter)

`@causljs/sync` ships as the adapter that models async fetches as Events feeding Inputs, with the lifecycle in §6. Reopen trigger for folding into core: none.

### 13.7 Multi-user synchronisation — NOT-PLANNED

Out of scope for the core. CRDTs, OT, server-authoritative — none of those are decisions I can make until I have a single-user engine that actually works.

Reopen trigger: a runnable single-user engine with a real adopter, plus a use case that genuinely cannot fit on optimistic-write-with-server-reconciliation patterns.

### 13.8 Rust core — NOT-PLANNED

The Rust crates that ship today fall into two buckets, neither of which is the engine: `tools/checker/Cargo.toml` declares `serde`, `serde_json`, `clap`, `anyhow` for the static IR linter; and `tools/engine-rs-core/` plus `tools/engine-rs-bridge-{serde,gc}/` (per the WASM-backend EPIC #680, Phase-0 + Phase-1 scaffolding) carry the pure-algorithm state machine and the JS↔WASM bridges that back the opt-in `@causljs/core/wasm` substrate. The engine itself — the value-of-record applications import as `@causljs/core` — stays TypeScript.

**Current state (as of v0.9.0).** Post-EPIC #680 the "Rust crate is the checker only" framing is no longer literal: scaffolded Rust crates back the opt-in WASM substrate per §17.6 commitment 14, with `engine-rs-core` carrying real types (generational `NodeId { slot: u32, gen: u32 }` per #1151, `JsonValue::Object(BTreeMap<SmolStr, JsonValue>)` per #1078, the seven-named-struct cell shape per #1077). The full Rust engine port — replacing the TypeScript value-of-record with a Rust kernel — is tracked separately as post-0.9.0 epic #1133 with GO/NO-GO criteria documented in the epic body. The DEFERRED/NOT-PLANNED line in §13 sits where it sits because the engine remains TypeScript today and the §13.8 reopen trigger is the same as it was: a TypeScript engine that meets §10 plus a real adopter with a workload the JS engine cannot meet. Epic #1133 names the engineered shape if the trigger fires (parallel to §13.3's `@causljs/coordinator`); the shape exists in the epic body, the trigger has not. The "NOT-PLANNED" label is preserved for the SPEC commitment surface (the team has not committed to ship epic #1133); the engineered shape on the shelf is the same honesty §16.4 carries for the bounded enumerator.

Reopen trigger: the TypeScript core ships at the bar §10 demands, plus a real adopter with a workload the JS engine cannot meet.

### 13.9 GraphQL adapter — NOT-PLANNED

Out of scope. If an adopter ships GraphQL on top of `@causljs/core` they ship it as their own adapter.

Reopen trigger: an adopter shipping GraphQL on top of `@causljs/core` whose pattern is broadly enough useful to fold into a maintained sibling adapter. None today.

### 13.10 Devtools as a shippable product — NOT-PLANNED

I'll ship inspection primitives (§11) — `whyUpdated`, `whyNotUpdated`, `commitLog`, `dependencies`, `dependents`, `liveDerived`, `replaceMany`, `commitMetadataDerived`. **I will not ship a devtools UI as a product.** The `@causljs/devtools-bridge` package is the wire-protocol substrate that a downstream UI *would* consume; it ships as private precisely so a future UI initiative can ship it as its product.

Reopen trigger: a downstream initiative requesting a maintained UI wrapper plus the engineering capacity to support it.

**What the team rejected and why.** Promising any §13.5–§13.9 row as a v1 deliverable — the previous draft's "Phases 8-15" framing is the precise mistake §13 is correcting. Engineering edit-mode time travel before a use case — §13.2 is the design, frozen, but building it speculatively would add a `parentTime` field nothing reads. Designing multi-graph composition speculatively — §13.3's three-shape walk shows the only multi-time semantics that preserves §3 collapses back to single-time, and the engineered shape if reopened is the `@causljs/coordinator` sibling adapter, not an `embedGraph` extension to core. Promoting the `Disposed` discriminator to compile-time — the runtime guard holds. Folding any adapter taxonomy into core — the semantic-core / adapter split is what makes both teachable.

---

## 14. Perceptual perf

I cut the previous spec's performance table — ten figures across node counts, millisecond budgets, client counts, and snapshot times — because none of them belonged in this document. A spec that promises `100,000 nodes in 16ms p95` either ships a benchmark that proves the number or admits the number was an aspiration printed as a target. The numbers live in `docs/benchmark.md`; SPEC §14 commits only to the two correctness criteria that the engine's denotational definition implies.

The two criteria §3 forces:

1. **A commit producing `N` derived recomputations runs in `O(|affected|)`, not `O(graph size)`.** The §3 equation `derived(t) = f(b₁(t), ..., bₙ(t))` is the *meaning*, not the *plan*; a sound implementation walks only the dirty sub-graph.
2. **A React component subscribed to one node re-renders only when that node's value changes.** Same denotational rule, different observer.

Sebastian Markbåge's framing: the work the engine does inside the commit boundary is the work the renderer cannot defer, and a renderer that targets 60fps on a real workload is structurally compatible only with an engine whose commit cost is bounded by the affected set.

### 14.1 Translating the two criteria into CI gates

| Criterion | Gate | Anchor |
| --- | --- | --- |
| Engine: `O(|affected|)` recompute | `perf-invariant — SPEC §14 gate` | `pnpm --filter @causljs/core run test:perf-invariant` runs `packages/core/test/perf-recompute.test.ts` (#145). |
| React: re-render scope | `perf-invariant — SPEC §14 React subscription gate` | `pnpm --filter @causljs/react run test:perf-invariant` runs the `useCausl`, `useCauslShallow`, `useSyncExternalStore`, `strictMode`, and `family-grid` suites; the family-grid leg ratchets the heap-delta gate under `CAUSL_HEAP_GATE=1` (#389). |

The 60fps end-to-end gate sits one layer up. `packages/formula/e2e/tests/dropped-frames.spec.ts` (#226) runs the 100-cell diamond fixture under Playwright and asserts the dropped-frame ratio stays under the configured ceiling. Specific node-count budgets — millisecond-per-commit numbers, memory deltas, scaling curves — live in `docs/benchmark.md`.

**What the team rejected and why.** Three options sat in front of the team for §14's enforcement shape: assertion-based perf tests, percentile-based, frame-budget. The team picked **assertion-based** for the §3 affected-set proofs (the recompute-count gates are pinned counts, not percentiles) and **frame-budget** for §14's perceptual gate (the dropped-frame ratio is the metric a non-programmer would name). Percentile-based gates were rejected because a CI-friendly p95 threshold needs either a stable shared runner (the team does not have one) or a noise-tolerant statistical model (which would weaken the gate to the point of uselessness).

### 14.2 Bundle budget

The team revised the bundle budget upward: **`@causljs/core` ships in the 15-30 KB minified band, with 18 KB as the working target.** The previous 4.5 KB / 6 KB ceilings were an aesthetic flex, not an engineering target — they forced every interesting invariant into the type system or into documentation, and documentation is not a runtime guarantee. The closed-PR record bears that out: PRs #266, #395, #420 kept fixing surface-count drift; PRs #383 / #455 kept rediscovering that primitives the team had cut for size were the primitives adopters needed; #390 / #454 kept patching distribution rails for adapter packages adopters did not want as separate installs. At 4.5 KB the engine is a primitive; at 18 KB it is a system; at 30 KB it is the system the team actually wants to defend.

The bigger budget pays back only if every kilobyte buys back a property the team can name out loud. Tanner Linsley's framing on review was the load-bearing one: *"if you're under 5 KB you're a primitive, not a library — and adopters compose primitives into systems, so the cost is on them."* TanStack Query at 13.4 KB ships dehydration, hydration, optimistic updates, and devtools wiring, and the team would re-derive each badly across four files per app without it; the calibration is the same here. Sandi Metz pushed harder on the principle: *"does this code prevent a wrong program from running silently? If yes, it is core. If it only helps you write a better test, it stays in the testing seam."*

The new budget is non-negotiable on three rules:

1. **Every kilobyte over 4.5 KB ships with a written team consensus.** A unanimous reading on review (the brutal-critical pass §0 names) is the bar. A single hold-out kills the addition or sends it back to design.
2. **Production bytes pay only for invariants the type system cannot express.** Dev-mode warnings, source-mapped error chains, runtime IR validation — these run *in dev* and dead-code-eliminate at minify time behind `process.env.NODE_ENV !== 'production'`. The 30 KB ceiling applies to the production build; dev builds may exceed it for diagnostic value.
3. **The working target is 18 KB, not 30 KB.** The team rejected "spend the budget because we have it." A bundle that ships at 22 KB of mediocre primitives is a regression against a 5 KB bundle of sharp ones. 18 KB is the calibration the team can defend; 30 KB is the ceiling that bounds the discipline.

#### 14.2.1 What the team agreed to bundle

Five additions reached unanimous consensus across the architecture, React/MVU, TDD, JS/types, and adopter-ergonomics review passes. Each carries the championing reviewer and the size estimate; the sum below lands the production bundle around 14-17 KB and the dev bundle around 23-28 KB.

| # | Addition | Why core (not adapter) | Prod size | Dev size | Champion |
| --- | --- | --- | --- | --- | --- |
| 1 | **Source-mapped error chains across the eleven typed-error hierarchy** — every `CycleError`, `NodeDisposedError`, `HydrationSchemaError`, `CapabilityViolation`, etc. carries `{ commit: Commit, site: CallSite, dependents: NodeId[] }` via `Error.cause` | Every error in `@causljs/core` is a graph-shape error, and graph-shape errors are unsolvable without graph context. The current class-name-plus-string story is a lie about typed errors. | ~3 KB | ~4 KB | Hejlsberg / Eich |
| 2 | **Devtools wiring as a one-line opt-in (`createCausl({ devtools: true })`)** — `connectDevtools` from `@causljs/devtools-bridge` folded into core, dead-code-eliminated when the flag is `false` or `NODE_ENV === 'production'` (extension-absent path) | Adopters install the bridge package on day six, after the first incident. Hiding devtools behind an extra install is self-sabotage; React DevTools succeeded by being the default. | ~0 KB (DCE) | ~3 KB | Markbåge / Linsley |
| 3 | **Runtime IR schema validation in `hydrate()`** — hand-written validator specialised to `CauslModel`, walks the seven top-level fields and the two `kind` discriminants (post-EPIC-1 PR-A schema 3 widening; see §16.2.1). Catches malformed IR from older clients, partial writes, and adversarial input that the `schemaHash` capability check misses | `hydrate()` is a trust boundary; trust boundaries get parsers, not hashes. The IR is the wire format and must self-describe its acceptance criteria. | ~1.5 KB | ~1.5 KB | Miller / Wirfs-Brock |
| 4 | **Branded `NodeId<T>` and discriminated `GraphTime`** — `NodeId` carries a `Symbol` brand so a node from graph A passed to graph B fails `tsc`. `GraphTime` becomes `{ readonly t: number; readonly arm: 'live' \| 'evicted' }` aligned with the §3 `[registrationTime, ∞)` domain | Pure type-level work, near-zero runtime. The current `number` aliases are the kind of TypeScript that gives TypeScript a bad name. | ~0.3 KB | ~0.3 KB | Hejlsberg |
| 5 | **`graph.dehydrate()` / `graph.hydrate(snap)` named SSR pair** — `snapshot` retained as the read-side primitive, `dehydrate()` aliased onto it as the SSR vocabulary every adopter already knows. Typed `DehydratedState` envelope with version, schemaHash, and idempotency for double-hydration guards | Adopters grep for `dehydrate` because that is the SSR vocabulary they already know. Renaming alone removes an entire category of stale-state glue across four files per app. | ~0.6 KB | ~0.6 KB | Linsley |

The five additions sum to about **5.4 KB of production bytes and 9.4 KB of dev bytes**. Layered on top of the current 3.4 KB minified `@causljs/core` engine, the production bundle lands near **8.8 KB** with all five shipping — comfortably inside the 15 KB floor and leaving 6-9 KB of headroom for the next adopter-driven cycle. The dev bundle lands near **12.8 KB**, still under the 18 KB working target.

The remaining headroom (15 KB → 30 KB) is reserved for additions the team has not yet reached consensus on. §14.2.3 lists those by name so future PR reviewers know which conversations are still open.

#### 14.2.2 The four `size-limit` ceilings

The `size-limit` config in root `package.json` matches the new budget on every published surface:

| Bundle | Ceiling | Notes |
| --- | --- | --- |
| `@causljs/core (full import)` | **20 KB** | Production minified. The 15-30 KB band's working target plus ~2 KB headroom for the next adopter-driven addition. |
| `@causljs/core (createCausl-only)` | **15 KB** | The minimal import path — `createCausl`, the canonical seven, and the §14.2.1 additions that ride along. Imports of §12.2 second-tier methods grow the cell-size; consumers who only register inputs and read derivations stay near this floor. |
| `@causljs/react` | **8 KB** | Increased from the previous 3 KB to absorb the §8.2 extension hooks (`useCauslShallow`, `useCauslFamily`, `useCauslSuspense`, `<Hydrate>`) at honest size, plus the dev-mode "Update did not commit" warnings (Dan Abramov championed) DCE'd in production. |
| `@causljs/devtools-bridge (connectDevtools-only, absent-extension path)` | **5 KB** | Increased from 3 KB to absorb the bridge logic that now opts into core via `devtools: true`. The absent-extension path remains the floor; the present-extension path adds real wiring above this number, gated by `__CAUSL_DEVTOOLS__`. |

Each ceiling is a CI gate (the existing `size — bundle-size gate (#147)` job). A PR that crosses any ceiling fails the gate; the PR description must include the §14.2.1 written team consensus or the size-limit bump is rejected. The ceilings are budget caps, not targets — the team works to the **18 KB target on `@causljs/core (full import)`**, with the 20 KB ceiling reserved for the cycle's next addition.

#### 14.2.3 What the team is still debating (post-bump)

The new budget surfaced features whose team consensus is not yet unanimous. The conversations are documented here so future reviewers know they are open, not settled.

- **`useTransition`-aware MVU runner.** Sebastian Markbåge wants this in core; Evan Czaplicki pushes back hard ("framework-agnostic core is incompatible with React-scheduler-aware code"). Unresolved. Likely outcome: stays in `@causljs/react` until a non-React adapter forces the question.
- **Edit-mode time travel via `Commit.parentTime`.** Alan Kay wants the design in core (§13.2 already engineers it); Trygve Reenskaug vetoes core involvement ("a tool concern; ship it in `@causljs/devtools` where roles like Historian and Editor live"). David Harel splits the difference: design lands in core (the `parentTime` field), UX lands in devtools. The split is honest but does not yet pay for itself.
- **`liveDerived` and `replaceMany` promoted from `@causljs/devtools` to core.** Kay yes (the §11 REPL primitives), Reenskaug hard no (role primitives), Harel against on chart-edge grounds, Conal Elliott neutral. Three-to-one against; stays in `@causljs/devtools`.
- **Bundled persistence with localStorage as default.** Tanner Linsley wants it in core; Matt Pocock pushes back on the storage-adapter pluggability argument. Compromise on the table: ship the `StorageAdapter` *protocol* in core and keep concrete adapters (`localStorage`, IndexedDB) in `@causljs/persistence`. Not yet ratified.
- **`secureMode: boolean` on `createCausl`.** Mark Miller wants it; Anders Hejlsberg vetoes the *shape* (mode bits compose badly with types); Brendan Eich splits the difference. Ship neither in this budget round; revisit when a real threat model is written down.
- **Live `dependencies(node) → DerivedNode<readonly NodeId[]>` via Phase F.5b.** Elliott championed it (one-shot adjacency violates §3: adjacency is a function of time, so it must be a Behavior); Reenskaug grudgingly accepts because the public type narrows the lie rather than widening the surface. Estimated 2 KB; the team is leaning toward inclusion in the next cycle once the §14.2.1 five have landed and the empirical bundle weight is measured.
- **Implement Controller region from §6 in code.** Harel + Kay want it; estimated 3 KB. The team-rep hesitation is that the controller is the most application-specific layer in §7's stack, and shipping a generic controller in core is the same mistake the previous draft made by listing eleven inspirations and stacking them with plus signs. Held until a use case earns it.
- **`Behavior` combinators (`map`, `filter`, `combineLatest`, `switchTo`).** Elliott championed it; estimated 2.5 KB. Pure compositions over existing primitives, no new runtime. Held pending consensus on whether the algebra-felt argument outweighs the surface-count cost.
- **`graph.recordTrace()` / `graph.replayTrace()` on the engine itself.** Fowler + Beck championed (~4-5 KB); Haines is neutral; Metz prefers the testing seam. The trade-off is that promoting trace primitives to core lets customer-support engineers attach traces from live sessions without the testing seam loaded, but bundles bytes for a feature 90% of adopters will never call directly. Not yet ratified.

#### 14.2.4 What the team holds the line on (NOT in the new budget)

The bigger budget is not permission to bundle everything. The following stay external or stay deferred regardless of headroom; the team's cross-perspective consensus on each is unanimous.

- **`useCauslFamilyGrid` with virtualization helpers.** Virtualization is a *view* concern, not a state concern. TanStack Virtual and react-virtuoso are better than anything the team would ship in 30 KB.
- **A bundled `<CauslDevtools>` UI component.** The wiring belongs in core (§14.2.1 #2); the UI does not. A panel component pulls in rendering, styling, and accessibility concerns that will balloon past the budget within two minor versions.
- **`graph.snapshotRetentionPolicy` named presets.** A knob, not an invariant. Adopters who need full-replay retention opt into a separate package.
- **Built-in seed-and-shrink helpers on `Graph`.** Duplicates `propertyTrials` from the testing seam and forks the discipline. The testing seam is not a second-class citizen; it is the right home for code that only matters when you are writing tests.
- **`graph.versionInfo` accessor on the wire.** Schema version belongs in the IR header (it is there, `schema: 3` post-EPIC-1 PR-A); engine version belongs in the package manifest. A live accessor invites runtime-branching on engine version, which is exactly the coupling the IR was designed to prevent. Wirfs-Brock and Guo are immovable on this.
- **Public promotion of `narrowCapability` from §12.3 to §12.2.** A sharp tool that works because its callers are us. Public-facing it becomes a footgun that users reach for instead of refactoring their capability boundaries. Wirfs-Brock and Guo are immovable here too.
- **Multi-graph composition / nested graphs.** Requires new §3 multi-time semantics the team has not designed. NOT-PLANNED stands (§13.3).
- **Public `Disposed` arm on `Node`.** Leaks lifecycle into every consumer's pattern match and turns every `switch` into a liability. Reenskaug is right; runtime `NodeDisposedError` holds (§13.4 stands).
- **`useCauslQuery(fetcher)`, `commitMutationQueue` in core.** Server-state and offline-first are real patterns, but neither is universal. Adopters reaching for them are already reaching for Query / SWR; relitigating that fight inside core is wrong. Stay in `@causljs/sync`.
- **`@causljs/formula`, `@causljs/checker`, `@causljs/migration-check` folded into core.** Tooling-adjacent, separate release cadence. Migration-check especially — a one-time-per-upgrade tool, not a runtime dependency.
- **Spreadsheet engine, async resources, GraphQL adapter, Rust core.** All adapter or rewrite concerns. Core stays the denotational kernel plus the four-region chart. §13's NOT-PLANNED rows hold.

**What the team rejected and why (the budget itself).** Three budget shapes were on the table. **Stay at 4.5 KB / 6 KB.** Rejected because the closed-PR record (PRs #266, #395, #420, #383, #455, #390, #454) is the empirical evidence that the small-bundle promise was costing the team more in glue and re-derivation than it was earning in elegance — Tanner's framing on this was decisive. **Lift to 50-100 KB and bundle aggressively.** Rejected because the cost of the bigger bundle compounds: every byte adopters install pays the parse-and-execute cost on every page load, and a state engine that costs more than its renderer does is pricing itself out of the workloads §14 names as the target. **15-30 KB with 18 KB as the working target.** Accepted. Reasoning: the band matches the empirical TanStack Query / Router / Table calibration; the 18 KB target leaves real headroom while bounding the discipline; the 30 KB ceiling is a non-target that constrains future cycles without inviting padding.

---

## 15. Fuzz / property-based testing

The previous draft listed "race tests" as a separate test family. The rewrite collapses that listing: property-based tests are not one family among four — they are the race-detection layer for everything the type system and the API shape do not catch. Sandi Metz's framing: property tests are the type system's runtime answer to questions the type system cannot ask. Corey Haines's deliberate-practice framing kept the team honest about the trial budget — a property suite that runs 100 trials per CI run is a suite that has not yet learned what its property is for.

### 15.1 Properties as the §3 theorems made executable

Each row of §3's denotational equations becomes a property under `packages/core/test/properties/`:

- **Glitch-freedom (the diamond theorem).** Random graphs, random commit sequences, every observable derived value at every committed `GraphTime` equals its compute applied to its current dependencies' values.
- **Atomicity.** A commit produces exactly one new `GraphTime`; subscribers fire exactly once per affected node per commit.
- **Determinism (the replay theorem).** A captured commit sequence replayed on a fresh graph produces a byte-identical state.
- **Dynamic-dependency cleanup.** Random derivations that switch inputs based on conditional reads leave no orphan dependency.
- **Cycle-detection completeness.** Every cycle that exists is caught by the first commit that closes it.

The generator family is `propertyDag` from `@causljs/core-testing-internal`. Every property in the canonical set imports it; every property in adapter packages that exercise the same shapes imports it. The shared generator is the discipline that makes the §15.1 properties auditable as a set.

**§15.1 Amendment — `graph.read(node)` reference identity is not contractually guaranteed (#1124).** `graph.read(node)` is **not** contractually required to return the same JavaScript reference across calls. Reference identity is an implementation detail of the current TS engine — today's `WasmBackend` (as of v0.9.0) is a TS engine wrapped in the FFI shape per the §17.6 Phase-1 disclosure (#1127), so a `read()` for an object-valued node returns the same reference trivially today; the day the engine inside the bridges becomes the real Rust kernel (post-0.9.0 epic #1133, with the Rust-side type prep already merged via #1077 / #1078 / #1079 / #1080 / #1151), `read()` returns a fresh object per call as the value is deserialised across the FFI boundary. Adopters who depend on identity for memoisation (e.g. `React.memo` keyed off the read return, `useMemo(() => transform(value), [value])`) will silently re-render every commit once they `migrate('wasm')` against a real-engine build. The contractual identity surface is **value identity** — `Object.is(read(node)@t, read(node)@t)` holds for any two synchronous reads at the same `GraphTime`, and `Object.is(read(node)@t, read(node)@t')` may or may not hold across commits depending on backend. Adopters who need a stable memoisation key per commit MUST key on `commit.time` (the `GraphTime` exposed on `Commit`) or the per-node version counter `EngineTelemetry` surfaces, **not** the read return reference. Cross-link: §17.6 (commitment 14, host-tier substrate compatibility) names the migration boundary where this contract bite materialises; adopter-facing guidance lives at `docs/wasm-adoption-guide.md` H1 and is mirrored in the host-tier callout at `packages/core/wasm/README.md`.

### 15.2 Conformance and the trial floor

The race-detection commitment: 1000+ random graphs and 1000+ random commit sequences per property on every CI run; failing inputs are shrunk and committed back as regression cases; seeds are deterministic and logged.

The seam is `propertyTrials(label, options?)` from `@causljs/core/testing` (`packages/core/testing/src/propertyTrials.ts`). The defaults are the floor: `numRuns: 1000`, env-driven seed via `CAUSL_FUZZ_SEED`. The seam throws at construction if a caller passes `{ numRuns: N }` with `N < 1000`; the only escape is `unsafeTrials: N` with documented rationale.

The conformance walker at `packages/core/test/spec-15.2-conformance.test.ts` walks every `*.property.test.{ts,tsx}` file at any depth, every file under any `test/properties/` directory, and (the catch-all that broadened in #437) every other `*.test.{ts,tsx}` file that contains a literal `fc.assert(` token. A contributor copy-pasting `numRuns: 100` into a property suite that lives next to its feature tests no longer slips past CI by virtue of living outside `test/properties/`.

### 15.3 What property-based fuzz cannot prove

1. **Multi-process and multi-tab races are out of scope.** The property suite runs in a single process. `@causljs/sync` handles the multi-process case at the network seam; the *cross-graph* race class is the §13 "multi-user synchronisation" item.
2. **UI-side rendering glitches are not §15's job.** Those are §14's gates.
3. **Application-side update races escape the engine's contract.** The §9.1 row "two app-level `Msg`s producing inconsistent intermediate model state" is the canonical example. The recipe lives at `docs/application-side-property-tests.md` (#438 / #445); the in-repo reference example is `packages/migration-check/test/properties/parity.property.test.ts`.

**What the team rejected and why.** Test-by-anecdote — rejected because the §3 theorems are the only thing that makes the engine general. Test-by-formal-proof — rejected because the engine ships TypeScript, and the proof would be against a model of the engine, not the engine itself. Property-based fuzz with a high trial floor and a meta-test that enforces it is what the team picked, in Metz's and Haines's framing both.

---

## 16. Static IR linter (and the deferred bounded enumerator)

### 16.0 Status

What ships in v1 is a **static IR linter** — `@causljs/checker` (npm wrapper) plus the Rust binary `causl-check`, running a fixed set of one-shot passes over a JSON IR exported from `@causljs/core`. What this section originally drafted — a bounded model checker that exhaustively enumerates async-resolution orderings, message-dispatch orderings, and conditional-derived branches — is **deferred and not planned** (#272 closed not-planned; EPIC #282 parks the work).

The §16.4–§16.6 design that follows the linter sub-sections is preserved in the conditional voice. None of it ships today; none of it counts toward §17 commitment 8. Reopen triggers:

- A second external adopter pulls on the rope, OR
- A single adopter blocks on a §9.1 race-class that the static linter cannot decide and the property suite cannot reach.

Mark S. Miller's review: a security-and-correctness gate that promises bounded enumeration but ships static lint launders the promise away — the spec must say what ships, in the same paragraph as what the gate is for. Allen Wirfs-Brock's framing on schema versioning runs through §16.2: an IR that crosses a process boundary is a wire format, and a wire format with no version discipline is a bug-shaped contract. Shu-yu Guo's spec-editor pragmatism: what ships is what the section commits to. Waldemar Horwat's design-defense framing kept the §16.4 conditional voice — the bounded enumerator is preserved as a coherent design rather than struck because the design is the thing a future trigger reopens.

### 16.1 What ships — the static linter

`causl-check` runs in CI as a green/red gate alongside `tsc` and the property-based suite. It runs **eight one-shot passes** over the IR (`tools/checker/src/check.rs`):

| Pass | What it checks |
| --- | --- |
| `Schema` | `schema == CAUSL_MODEL_SCHEMA`. |
| `Bounds` | `nodes ≤ max_nodes`, `commits ≤ max_commits`. |
| `UnknownDep` | Every `deps` and `conditionalDeps` entry references a known node id. |
| `Cycle` | No cycle in the declared edges of the derived sub-graph. |
| `Determinism` | `changedNodes ⊆ knownNodeIds` for every commit. (Not a replay — a foreign-key check.) |
| `Monotonic` | Commit times are strictly increasing. |
| `GlitchPropagation` | A derived listed in `changedNodes` has at least one of its static `deps` in the same commit's `changedNodes`. |
| `OrphanDep` | No derived has itself in its declared `deps`. |

The race-class rows from §9.1 the linter actually addresses live in `docs/checker-coverage.md` — the single source of truth for coverage, re-baselined against §9.1's seventeen rows. The CI gate is the `checker-gate` job in `.github/workflows/ci.yml`, required-green on every PR.

### 16.2 The IR contract

`CauslModel` is the wire format between `@causljs/core` and `causl-check`. Its shape is closed at seven top-level fields and at two `kind` constants (the two-`kind` `IRNode` discipline preserved across the schema 2 → 3 widening that EPIC-1 PR-A applied; see §16.2.1 for the full schema 3 specification):

```ts
interface CauslModel {
  schema: number             // CAUSL_MODEL_SCHEMA, currently 3
  time: GraphTime            // the engine clock at export time
  nodes: IRNode[]            // IRInput | IRDerived
  commits: IRCommit[]        // recorded log up to commitHistoryCap
  events: IREvent[]          // closed six-arm union; see §16.2.1
  scopes: IRScope[]          // scope-id registry
  bridges: IRBridge[]        // cross-graph allowlist
}
```

The schema version is `CAUSL_MODEL_SCHEMA = 3` (`packages/core/src/ir.ts`). The release-checker workflow at `.github/workflows/release-checker.yml` enforces a three-way lockstep: Cargo `version` ↔ npm `@causljs/checker` `version` ↔ `CAUSL_MODEL_SCHEMA` constant. A bump in any without the matching companion fails the `version-lockstep` job; nothing publishes on a mismatch.


### 16.2.1 Schema 3 specification

This sub-section is the formal type spec for the IR shipped under EPIC-1 PR-A and PR-B1. Schema 3 is the **current** wire format — `CAUSL_MODEL_SCHEMA = 3` in `packages/core/src/ir.ts` and `causl_model_schema = "3"` pinned in `tools/checker/Cargo.toml`. Schema 3 keeps the §4 two-primitive `IRNode` discipline (Input | Derived) and grows the wire format along five named axes — per-node `graphId`, the closed six-arm `IREvent` discriminated union (`IRSubscribe | IRSubscribeCallback | IRUnsubscribe | IRDispose | IRRead | IRTxSet`), the `IRScope` registry resolved by `scopeId`, the `IRBridge` cross-graph allowlist, and a bounded call-graph annotation slot on `IRCommit`. The brutal-critical review's recommendations folded into PR-B1 and are reflected here: `IRSubscribeCallback` for commit-from-subscribe lineage; `IRDispose.disposeAt` as a half-open `[enqueueAt, appliedAt]` interval; `IRCommit.originEvent` for callback-frame lineage; `IRRead` distinguishing `derivedId` from `readNodeId`; `IRTxSet.inputId` tightened from a generic `nodeId`.

Wirfs-Brock's framing on wire-format discipline is the load-bearing constraint: an IR that crosses a process boundary is a wire format, and a wire format with no version discipline is a bug-shaped contract. Hejlsberg's framing on type-system enforcement is the second load-bearing constraint: a schema that the TypeScript exporter and the Rust checker both treat as a closed discriminated union catches drift in the compiler, not in production. The cross-language byte-determinism gate runs on every PR via the paired test files `packages/core/test/ir-schema-3-events.test.ts` (TS side) and `tools/checker/tests/ir_schema_3_events.rs` (Rust mirror) — drift in either direction trips on the first deserialization, and the SPEC↔impl parity test in `packages/core/test/spec-ir-parity.test.ts` (#569) catches drift between this section's documentation and what the source files declare.

#### 16.2.1.1 TypeScript schema-3 type definitions

These are the types declared in `packages/core/src/ir.ts`. The SPEC↔impl parity test (`packages/core/test/spec-ir-parity.test.ts`, #569) pins this section against drift.

```ts
export const CAUSL_MODEL_SCHEMA = 3 as const

export type IRGraphId = string
export type IRNodeId = string

export interface IRInput {
  readonly kind: 'input'
  readonly id: IRNodeId
  readonly graphId: IRGraphId
  readonly value: unknown
  readonly serializable: boolean
}

export interface IRDerived {
  readonly kind: 'derived'
  readonly id: IRNodeId
  readonly graphId: IRGraphId
  readonly deps: readonly IRNodeId[]
  readonly conditionalDeps: readonly IRNodeId[]
  readonly value: unknown
  readonly serializable: boolean
}

export type IRNode = IRInput | IRDerived

export interface IRCallFrame {
  readonly site: string
  readonly source?: string
  readonly line?: number
}

export interface IRCallGraph {
  readonly frames: readonly IRCallFrame[]
  readonly truncatedDeeper: boolean
}

export interface IRCommit {
  readonly time: number
  readonly graphId: IRGraphId
  readonly intent: string
  readonly changedNodes: readonly IRNodeId[]
  /**
   * For `graph.hydrate(...)`-issued commits, the GraphTime carried
   * by the originating snapshot envelope. Absent on
   * `graph.commit(...)`-issued records.
   */
  readonly originatedAt?: number
  /**
   * Bounded call-graph annotation captured at commit-issue time.
   * Optional — exporter omits the field when stack-trace capture is
   * disabled.
   */
  readonly callGraph?: IRCallGraph
  /**
   * Lineage to the IRSubscribeCallback (or other IREvent) that
   * initiated this commit. Presence-discriminating: a commit with
   * `originEvent` set was emitted from a callback frame (an EPIC-2
   * `CommitFromSubscribe` candidate); a commit without was
   * user-initiated.
   */
  readonly originEvent?: string
}

export interface IRSubscribe {
  readonly kind: 'subscribe'
  readonly graphId: IRGraphId
  /** Subscription id minted at registration. */
  readonly id: string
  /** Resolves to one of `CauslModel.scopes`. */
  readonly scopeId: string
  /** The node id the observer registered on. */
  readonly target: IRNodeId
  /** Best-effort source location; falls back to `'<unknown>'`. */
  readonly callbackSite: string
  readonly time: number
}

/**
 * Sixth IREvent variant — the moment a registered observer fires
 * during Phase G of a commit. Distinct from IRSubscribe (the
 * registration event); EPIC-2's `CommitFromSubscribe` pass walks
 * `IRCommit.originEvent` lineage back to a callback frame to
 * surface the row-1 cascading-commit anti-pattern.
 */
export interface IRSubscribeCallback {
  readonly kind: 'subscribe-callback'
  readonly graphId: IRGraphId
  /** Callback-frame id (the value referenced by IRCommit.originEvent). */
  readonly id: string
  /** Id of the IRSubscribe this invocation belongs to. */
  readonly subscribeId: string
  readonly firedAt: number
}

export interface IRUnsubscribe {
  readonly kind: 'unsubscribe'
  readonly graphId: IRGraphId
  /** Id of the IRSubscribe being torn down. */
  readonly id: string
  readonly scopeId: string
  readonly time: number
}

export interface IRDispose {
  readonly kind: 'dispose'
  readonly graphId: IRGraphId
  readonly nodeId: IRNodeId
  readonly scopeId: string
  readonly time: number
  /**
   * Half-open `[enqueueAt, appliedAt]` interval per the brutal-critical
   * review's recommendation #5. `appliedAt` is the comparison surface
   * for `UseAfterDispose`: a read at `t_r` is a use-after-dispose iff
   * `t_r > appliedAt`. For an immediate dispose, the two values
   * collapse.
   */
  readonly disposeAt: readonly [number, number]
}

export interface IRRead {
  readonly kind: 'read'
  readonly graphId: IRGraphId
  /** Id of the derived node that performed the read. */
  readonly derivedId: IRNodeId
  /** Id of the node that was read. */
  readonly readNodeId: IRNodeId
  readonly time: number
  /** Index in the retained slice (`0..len-1`). */
  readonly seq: number
  /** Set on the last retained read of a truncated summary. */
  readonly truncated: boolean
}

export interface IRTxSet {
  readonly kind: 'tx-set'
  readonly graphId: IRGraphId
  /** Id of the input the `tx.set(...)` call targeted. */
  readonly inputId: IRNodeId
  readonly time: number
}

/**
 * Closed six-arm discriminated union. Adding a seventh variant
 * requires changing this declaration and is caught at every
 * `assertNever`-guarded reading site in the engine and the checker.
 */
export type IREvent =
  | IRSubscribe
  | IRSubscribeCallback
  | IRUnsubscribe
  | IRDispose
  | IRRead
  | IRTxSet

export interface IRScope {
  readonly id: string
  readonly kind: 'ephemeral' | 'infinite' | 'process-exit'
  readonly lifetime: {
    readonly origin: string
    readonly terminator: string
  }
}

export interface IRBridge {
  readonly from: IRGraphId
  readonly to: IRGraphId
  readonly dep: IRNodeId
  readonly policy: 'legacy-allow' | 'test-only' | 'read-only'
}

export interface CauslModel {
  readonly schema: typeof CAUSL_MODEL_SCHEMA
  readonly time: number
  readonly nodes: readonly IRNode[]
  readonly commits: readonly IRCommit[]
  readonly events: readonly IREvent[]
  readonly scopes: readonly IRScope[]
  readonly bridges: readonly IRBridge[]
  /**
   * Whether the IR's read-set capture was truncated during
   * serialisation (#584 A17-4 / EPIC-1 brutal-critical review #4).
   * `false` or absent = no truncation; `true` = the checker MAY
   * emit false negatives on rows whose proof requires reads past
   * the K=256 cap. Defaults to `false`.
   */
  readonly readsTruncated?: boolean
}
```

#### 16.2.1.2 Rust schema-3 type definitions

Mirrors the TypeScript shapes one-for-one. The Rust crate (`tools/checker/src/ir.rs`) declares these types; every `#[serde(rename = ...)]` pin pairs with a TS field name byte-for-byte.

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CauslModel {
    pub schema: u32,
    pub time: u64,
    pub nodes: Vec<IrNode>,
    pub commits: Vec<IrCommit>,
    #[serde(default)] pub events: Vec<IrEvent>,
    #[serde(default)] pub scopes: Vec<IrScope>,
    #[serde(default)] pub bridges: Vec<IrBridge>,
    /// Whether the IR's read-set capture was truncated during
    /// serialisation (#584 A17-4). Defaulted via serde so pre-#584
    /// documents still parse.
    #[serde(rename = "readsTruncated", default, skip_serializing_if = "is_false")]
    pub reads_truncated: bool,
}

pub type IrGraphId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[non_exhaustive]
pub enum IrNode {
    Input(IrInput),
    Derived(IrDerived),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrInput {
    pub id: String,
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    #[serde(default)] pub value: serde_json::Value,
    pub serializable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrDerived {
    pub id: String,
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    pub deps: Vec<String>,
    #[serde(rename = "conditionalDeps", default)] pub conditional_deps: Vec<String>,
    #[serde(default)] pub value: serde_json::Value,
    pub serializable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrCommit {
    pub time: u64,
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    pub intent: String,
    #[serde(rename = "changedNodes")] pub changed_nodes: Vec<String>,
    #[serde(rename = "originatedAt", default, skip_serializing_if = "Option::is_none")]
    pub originated_at: Option<u64>,
    #[serde(rename = "callGraph", default, skip_serializing_if = "Option::is_none")]
    pub call_graph: Option<IrCallGraph>,
    /// Lineage to the IrSubscribeCallback (or other IrEvent) that
    /// initiated this commit. See `IrCommit.originEvent` in §16.2.1.1.
    #[serde(rename = "originEvent", default, skip_serializing_if = "Option::is_none")]
    pub origin_event: Option<String>,
}

/// Closed six-arm enum mirroring TS `IREvent`. The kebab-case tag
/// rename pins the on-the-wire `kind` literals (`subscribe`,
/// `subscribe-callback`, `unsubscribe`, `dispose`, `read`, `tx-set`)
/// against TS drift.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[non_exhaustive]
pub enum IrEvent {
    Subscribe(IrSubscribe),
    SubscribeCallback(IrSubscribeCallback),
    Unsubscribe(IrUnsubscribe),
    Dispose(IrDispose),
    Read(IrRead),
    TxSet(IrTxSet),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrSubscribe {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    pub id: String,
    #[serde(rename = "scopeId")] pub scope_id: String,
    pub target: String,
    #[serde(rename = "callbackSite")] pub callback_site: String,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrSubscribeCallback {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    pub id: String,
    #[serde(rename = "subscribeId")] pub subscribe_id: String,
    #[serde(rename = "firedAt")] pub fired_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrUnsubscribe {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    pub id: String,
    #[serde(rename = "scopeId")] pub scope_id: String,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrDispose {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    #[serde(rename = "nodeId")] pub node_id: String,
    #[serde(rename = "scopeId")] pub scope_id: String,
    pub time: u64,
    /// Half-open [enqueueAt, appliedAt] interval (#5 of the
    /// brutal-critical review). For an immediate dispose, both
    /// values collapse.
    #[serde(rename = "disposeAt")] pub dispose_at: [u64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrRead {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    #[serde(rename = "derivedId")] pub derived_id: String,
    #[serde(rename = "readNodeId")] pub read_node_id: String,
    pub time: u64,
    pub seq: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrTxSet {
    #[serde(rename = "graphId")] pub graph_id: IrGraphId,
    #[serde(rename = "inputId")] pub input_id: String,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrScope {
    pub id: String,
    pub kind: IrScopeKind,
    pub lifetime: IrScopeLifetime,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IrScopeKind { Ephemeral, Infinite, ProcessExit }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IrScopeLifetime { pub origin: String, pub terminator: String }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IrBridge {
    pub from: IrGraphId,
    pub to: IrGraphId,
    pub dep: String,
    pub policy: IrBridgePolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IrBridgePolicy { LegacyAllow, TestOnly, ReadOnly }
```

The `#[non_exhaustive]` on both `IrNode` and `IrEvent` is deliberate — every match site must either name every arm or accept a `_ => …` fallthrough that the schema-bump audit step rejects via grep.

#### 16.2.1.3 Granularity decisions

| Event | Granularity | Cap | Justification |
| --- | --- | --- | --- |
| `IRSubscribe` | Every event recorded | None | Subscribe is rare; cardinality bounded by application structure. |
| `IRUnsubscribe` | Every event recorded | None | Symmetric to subscribe. |
| `IRDispose` | Every event recorded | None | Already capped upstream by `disposedTombstoneCap` (default 1000). |
| `IRRead` | Bounded per-commit summary | `K = 256` reads per commit | Read is high-cardinality; cap is 1 OoM above largest dep set in the property suite (64-node diamond). Reads beyond cap are dropped; last retained sets `truncated: true`. |
| `IRTxSet` | Every event recorded inside `tx.set` calls | None | `tx.set` cardinality bounded by application code. |
| `IRCommit.callGraph` | Bounded depth | `D = 32` frames | Stack capture cost is linear in depth; `D = 32` is 1 OoM above typical commit-issuing call site. |

The team rejected three alternatives for `IRRead`: every-read (unbounded wire growth), per-node summary (loses ordering), probabilistic sampling (variance defeats differential testing).

#### 16.2.1.4 Exporter behavior

The schema-3 exporter has a new pre-export collection step that drains four runtime maps into the IR's `events` array:

```ts
function exportModel(this: GraphImpl, options: ExportModelOptions = {}): CauslModel {
  // Phase 1 — capture nodes and commits as before
  const time = this.now
  const nodes: IRNode[] = [...this.entries.values()].map((e) => /* ... */)
  const commits: IRCommit[] = this.commitRing.slice(-(options.maxCommits ?? 100))
    .map((c) => ({ /* ..., callGraph: c.callGraph */ }))

  // Phase 2 — drain lifecycle maps into events
  const events: IREvent[] = []
  for (const [nodeId, subs] of this.subscribers) {
    for (const [subId, rec] of subs) {
      events.push({ kind: 'subscribe', graphId: this.graphId, time: rec.time, nodeId, subscriptionId: subId })
    }
  }
  for (const u of this.unsubLog) events.push({ kind: 'unsubscribe', /* ... */ })
  for (const [nodeId, tomb] of this.disposed) events.push({ kind: 'dispose', /* ... */ })
  for (const [commitTime, reads] of this.readTraces) {
    const slice = reads.slice(0, 256)
    const wasTruncated = reads.length > 256
    for (let i = 0; i < slice.length; i++) {
      events.push({ kind: 'read', /* ... */, seq: i, truncated: wasTruncated && i === slice.length - 1 })
    }
  }
  for (const s of this.txSetLog) events.push({ kind: 'tx-set', /* ... */ })

  return { schema: CAUSL_MODEL_SCHEMA, time, nodes, commits, events }
}
```

The runtime side-tables this depends on (`subscribers`, `unsubLog`, `disposed`, `readTraces`, `txSetLog`) all already exist for runtime invariants — schema 3 publishes them; it does not invent them.

The `captureCallGraph` knob on `ExportModelOptions` lets hosts disable stack-trace capture in production:

```ts
export interface ExportModelOptions {
  readonly maxCommits?: number
  readonly captureCallGraph?: boolean
}
```

#### 16.2.1.5 `graphId` source

The decision: **application-supplied `name` from `createCausl({ name })` takes precedence; fallback is an engine-assigned UUID at construction time**.

```ts
export interface CreateCauslOptions {
  readonly name?: string  // matches /^[A-Za-z0-9_.:-]{1,256}$/
}
```

Capture point: the engine constructor stores `this.graphId = options.name ?? randomUUID()` once at construction. The field is `readonly` for the lifetime of the graph. Validity rule: `name`, if supplied, must match `/^[A-Za-z0-9_.:-]{1,256}$/`. The engine throws `InvalidGraphNameError` at construction if the regex does not match. The character set is the intersection of "safe in JSON", "safe in URL fragments", and "safe in filesystem paths".

Multi-graph IR documents — a single `exportModel` call cannot today produce a multi-graph payload. The schema is forward-compatible with a future aggregator (a devtools-bridge primitive that merges per-graph IRs) by carrying `graphId` on every record from day one.

#### 16.2.1.6 Lockstep workflow updates

Diff against the version-lockstep step in `.github/workflows/release-checker.yml`:

```yaml
      - name: Read versions and assert match
        run: |
          set -euo pipefail
          CARGO_VERSION=$(grep '^version' tools/checker/Cargo.toml | head -1 | sed -E 's/version *= *"([^"]+)".*/\1/')
          NPM_VERSION=$(node -p "require('./packages/checker/package.json').version")
          SCHEMA_FROM_CORE=$(grep -E 'CAUSL_MODEL_SCHEMA *= *' packages/core/src/ir.ts | sed -E 's/.*= *([0-9]+).*/\1/')
          SCHEMA_PINNED=$(grep -E 'causl_model_schema *= *' tools/checker/Cargo.toml | sed -E 's/.*= *"?([0-9]+)"?.*/\1/' || true)
          SCHEMA_REQUIRED=3
          if [ "$CARGO_VERSION" != "$NPM_VERSION" ]; then exit 1; fi
          if [ "$SCHEMA_FROM_CORE" != "$SCHEMA_REQUIRED" ]; then exit 1; fi
          if [ -n "${SCHEMA_PINNED:-}" ] && [ "$SCHEMA_FROM_CORE" != "$SCHEMA_PINNED" ]; then exit 1; fi
```

Plus `tools/checker/Cargo.toml`:

```toml
[package.metadata]
causl_model_schema = "3"
```

#### 16.2.1.7 Migration story

**Schema-2 IR shipped to a schema-3 checker.** Fails the `Schema` pass with structured error: "expected schema = 3, received schema = 2". No silent migration.

**Schema-3 IR shipped to a schema-2 checker.** Symmetric failure: "expected schema = 2, received schema = 3".

**Exporter post-bump.** Emits schema 3 always. No knob, no legacy mode.

**Pre-bump code.** A `tools/migrate-ir-2-to-3.ts` codemod walks fixture directories and rewrites JSON: adds `graphId` to every node and commit, adds empty `events: []` array.

#### 16.2.1.8 Backward-compat for IR consumers

- **`@causljs/checker`** — bumps in lockstep.
- **`@causljs/devtools-bridge`** — schema-3 PR adds projection of `events`; until then, ignores the field (forward-compatible).
- **`docs/checker-coverage.md`** — re-baselined.
- **Snapshot / persistence tooling** — distinct wire format (`GraphSnapshot` schema 1); unaffected.
- **Property suite** — inherits schema 3 via the exporter.
- **Adapter packages emitting sibling documents** — own their own schema constants.

#### 16.2.1.9 What schema 3 buys and what is at the implementer's discretion

What schema 3 buys: the IR carries enough lifecycle information that a future linter pass can decide subscriber-leak rows, use-after-dispose rows, and read-after-tx-set rows of §9.1 statically; the multi-graph foreign key (`graphId`) is in place so a future cross-graph aggregator does not need a second wire-format break; and the bounded call-graph annotation gives diagnostic frames for every IR-detected violation.

What is at the implementer's discretion: the exact `K` and `D` caps (256 reads-per-commit, 32 call-frame depth) are starting points to tune against the property suite; the choice to drop reads with `truncated: true` rather than persist externally is a wire-size trade we expect to revisit; the `captureCallGraph` knob's default (`true`) may flip to `false` on production builds if stack-trace API cost dominates.

What schema 3 does *not* buy: a bounded enumerator (still §16.4-deferred), a multi-graph aggregator (still §16.2.1.5-deferred), or any of the §9.1 rows the static linter cannot today decide. We bump to schema 3 the day the §16A.2 trigger fires; we add passes against the new fields the day each pass earns its CI slot under §17.1 commitment 8.

### 16.3 Why a Rust binary

The linter's job is JSON parse plus bounded analysis. Rust gives predictable runtime and cross-platform binary distribution that `npm install` resolves without an adopter-side toolchain. The cargo dependency graph is deliberately small — `serde`, `serde_json`, `clap`, `anyhow`. The bounded enumerator §16.4 sketches would have benefited from Rust's headroom for state-space exploration; v1 does not need that headroom. The choice to ship v1 in Rust is **tactical, not strategic** — starting in Rust avoids a port if the trigger ever fires.

### 16.4 Deferred PLANNED — the bounded enumerator's design

When the §16.0 reopen trigger fires, the enumerator binary `causl-check enumerate` extends `causl-check` with a Norvig-shaped search over the IR's reachable state space. The design below is what reopens — fully written, ready to start TDD at §16.6 milestone 1 the day the trigger fires. Today it is **deferred PLANNED**, not deferred not-planned: the shape, the bounds, the tooling, the oracle, the CI integration are all named here so the v1.x epic does not start green-field.

**State-action transition model (Norvig).** A search problem is a tuple `(S, A, T, s₀, goal)`:

- **State `s ∈ S`** is a tuple `⟨inputs, derivedCache, now, lastWriteTime, retentionBuf, commitLog, observers, disposed, resourceFleet, pendingPipeline⟩`. `pendingPipeline` is `None` when the engine is in `Engine.Idle` and `Some(phase ∈ {A, B, C, C.5, D, E, F, F.4, F.5, F.6, G, H})` mid-commit. Async resources contribute one `ResourceState<T>` per registered resource keyed on the §6.1 ResourceFleet states.
- **Action `a ∈ A(s)`** is one of: `commit(intent, writes)`, `subscribe(node, cb)`, `unsubscribe(handle)`, `dispose(node)`, `hydrate(snap)`, `resourceTransition(rid, event)` from `{startLoad, resolve, fail, markStale}`, `phaseStep` (advance the in-flight commit by one phase).
- **Transition `T(s, a) → s'`** is the §5 pipeline made explicit: `phaseStep` is the per-phase mutation; the others enqueue / start / fault. `T` is **deterministic per action** — non-determinism lives in the action selection, not in the transition. This is what makes Theorem 1 checkable.
- **Initial state `s₀`** is the IR exported via `graph.exportModel()` plus the empty subscriber set.
- **Branching factor `b`**. Inside one commit: bounded by the phases that have a real choice (after our phase ordering, only "what action to schedule between commits"). Within a phase, `T` is deterministic. Between commits: `b ≤ K_subs + K_resources + K_disposes + 1` — concretely 5–20 in realistic scripts.

Norvig's principle, applied: design the abstraction so the branching factor matches what actually races. Commits-as-megasteps with explicit interleavings at the seams, not a full step-relational interleaving over every TS statement.

**The bound.** Stratified, not exhaustive — anyone promising "exhaustive enumeration of medium adopter programs in 5 min CI" is selling something. The 5-min PR gate is a bug-finding gate, not a soundness gate.

| Profile | Nodes | Commits (K) | Resources | Subscribers | Tier 1 (PR, ≤5 min) | Tier 2 (nightly, ≤30 min) |
| --- | --- | --- | --- | --- | --- | --- |
| Toy | 50 | 20 | 2 | 5 | exhaustive | exhaustive |
| Small adopter | 1,000 | 100 | 10 | 50 | K=8 prefix exhaustive + 2,000 random suffixes | K=12 + 20,000 random |
| Medium adopter | 5,000 | 500 | 25 | 200 | K=5 prefix + 1,000 random | K=8 prefix + 5,000 random |

`MODEL_CHECK_TIER=1` (PR): K_prefix=8, suffix=2,000 random, depth=K·12 phases. `MODEL_CHECK_TIER=2` (nightly): K_prefix=12, suffix=20,000 random, plus a 1,000-iteration shrink budget on counterexamples.

**The race-class oracle (Beck).** At every visited `s'`, the oracle evaluates the §3 theorems made executable. The predicates are not new code; they are existing §15.1 properties pointed at the enumerator's trace instead of `propertyDag`'s output:

- **§9.1 row firings.** Did `NodeDisposedError`, `CommitInProgressError`, `StaleTxError`, `ForbiddenResourceTransitionError`, `CycleError`, `HydrationSchemaError`, `CapabilityViolation` fire on any edge where the script did not declare an expectation?
- **Theorem 1 (determinism).** Two action sequences that produce the same input snapshot at the same `now` must produce byte-identical derived caches.
- **Theorem 2 (glitch-freedom).** At every `s'` post-Phase-G, every derived `d` satisfies `d.value == d.compute(get → b(d.lastObservedTimes[b]))` and every `lastObservedTime[b] == now`.
- **Theorem 3 (atomicity).** Inject a throw at every phase boundary B–F.6 of a randomly chosen commit; assert `s_after_throw == s_before_commit` byte-identically. Lamport's "stuttering equivalence" applied to rollback.
- **Theorem 4 (monotonicity).** `now_{i+1} == now_i + 1` after every commit / hydrate edge.

The oracle is shared with §15.1; the enumerator's contribution is **search**, not predicates.

**Tooling — concrete execution with memoisation (Byron).** Pick concrete execution hosted in Rust, calling out to a long-lived Node worker pool over a JSON RPC channel. The Rust enumerator owns the search graph and trace; when it needs `compute(d, snapshot)`, it sends `{nodeId, inputSnapshot}` to a worker, gets a JSON value back, memoises on `(nodeId, hash(snapshot))`. With memoisation the call rate drops to one per (node, distinct-input-snapshot) pair across the whole search — bounded by `|nodes| · |distinct snapshots|`, not by `|states|`. Byron's lift: the IR `CauslModel` *is* the schema, and the schema buys structure without execution. Symbolic execution (rejected — `compute` includes branches, library calls, arbitrary JS) and IR-to-Rust translation (rejected — restricting `compute` to a translatable subset breaks adopter ergonomics) were considered and dropped. `loom` (Rust memory-ordering tool) and Madsim (deterministic async runtime) are rejected — neither targets our IR. Hand-rolled BFS with explicit visited-set hashed on `(node-state-hash, pending-resolutions, msg-queue)` is what ships.

**Stateful trace model (Metz).** §9.1 races are stateful — they fire only after a particular sequence of commits leaves the engine in a particular state. The enumerator's trace structure:

```ts
interface Trace {
  readonly s0: State
  readonly steps: ReadonlyArray<{
    readonly action: Action
    readonly phaseSubsteps: ReadonlyArray<PhaseStep>  // inside one commit
    readonly sBefore: StateRef                         // structural-share id
    readonly sAfter: StateRef
    readonly events: ReadonlyArray<Event>              // errors thrown, observers fired
  }>
  readonly s_final: State
}
```

Structural-sharing is mandatory — full state copies blow memory at K=10. The implementation is a persistent HAMT keyed by node id with copy-on-write at the changed set, identical to the engine's `derivedRollback` map shape. Trace replay is the determinism oracle's input.

The pre-runtime detection target — **90%+ of the §9.1 race-class catalogue, for projects within the configured bounds** — is the ratchet the v1.x epic pins against. Until the binary ships in `checker-gate`, this design is not part of §17 commitment 8.


### 16.4.1 Rust type signatures (formal)

Norvig's framing of a search problem as a tuple `⟨S, A, T, s₀, goal⟩` is the right anchor for §16.4 — but the prose tuple is the wrong shape to hand to whoever picks the work back up. What follows is the same model rewritten as Rust type signatures the implementation can literally `cargo new` against. The signatures presume the existing `causl-check` crate at `tools/checker/src/{ir,check,cycle}.rs` and the dependency set its `Cargo.toml` already names: `serde`, `serde_json`, `clap`, `anyhow`. The new bounded-enumerator crate would sit alongside as `tools/enumerator/`, depending on `causl-check` for `IrNode` / `CauslModel` / `Bounds` and adding three crates the linter does not need: `im` for persistent collections, `blake3` for content hashing, `crossbeam-channel` for the worker pool.

#### State

```rust
use causl_check::ir::{IrInput, IrDerived, CauslModel};
use im::{HashMap as ImHashMap, OrdMap as ImOrdMap, Vector as ImVector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub String);

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ObserverId(pub u64);

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ResourceId(pub u64);

pub type Value = serde_json::Value;
pub type GraphTime = u64;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub inputs: ImOrdMap<NodeId, Value>,
    pub derived_cache: ImOrdMap<NodeId, Option<Value>>,
    pub now: GraphTime,
    pub last_write_time: ImOrdMap<NodeId, GraphTime>,
    pub retention_buf: ImOrdMap<NodeId, ImVector<(GraphTime, Value)>>,
    pub commit_log: ImVector<CommitRecord>,
    pub observers: ImOrdMap<NodeId, im::OrdSet<ObserverId>>,
    pub disposed: im::OrdSet<ObserverId>,
    pub resource_fleet: ImOrdMap<ResourceId, ResourceState>,
    pub pending_pipeline: BTreeMap<ResourceId, PendingResolution>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommitRecord {
    pub time: GraphTime,
    pub intent: String,
    pub changed_nodes: Vec<NodeId>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum ResourceState {
    Idle,
    Loading { since: GraphTime },
    Loaded { value: Value, at: GraphTime },
    Stale { value: Value, at: GraphTime },
    Errored { reason: String, at: GraphTime },
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct PendingResolution {
    pub started_at: GraphTime,
    pub kind: ResolutionKind,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ResolutionKind {
    Settle { value: Value },
    Reject { reason: String },
    Cancel,
}
```

The fields `inputs` and `derived_cache` are deliberately separate even though both map `NodeId → Value`. The `Option<Value>` wrapping in `derived_cache` lets the BFS distinguish "not yet evaluated" from "evaluated and got null". `BTreeMap` for `pending_pipeline` (rather than `HashMap`) gives deterministic JSON projection — two enumerator runs against the same `(node, snapshot)` produce byte-identical request bytes. `im::*` collections keep frontier traces in O(log n) with structural sharing — under `Vec`, branching at K=10 would blow memory.

#### Action

```rust
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
#[non_exhaustive]
pub enum Action {
    Commit { intent: String, writes: Vec<(NodeId, Value)> },
    Subscribe { node: NodeId, observer_id: ObserverId },
    Unsubscribe { observer_id: ObserverId },
    ResolvePending { resource: ResourceId },
    DispatchMsg { target: NodeId, payload: Value },
    BeginFetch { resource: ResourceId },
    Tick,
}
```

#### PhaseStep

```rust
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PhaseStep {
    StageWrites,
    StageWritesObserved,
    DirtyWalk,
    Recompute { node: NodeId },
    RecomputeObserved { node: NodeId },
    DedupeNotifications,
    AppendCommit,
    NotifyObservers { observer_id: ObserverId },
    NotifyObserversObserved,
    RetentionTick,
    ResolveUnblocked,
}
```

#### Transition

```rust
pub fn transition(s: &State, a: &Action) -> Result<State, RaceClass>;
pub fn transition_phased(
    s: &State, a: &Action,
) -> Result<(State, Vec<(PhaseStep, State)>), RaceClass>;
```

Returning `Err(RaceClass)` means "this action is structurally impossible at `s` and the oracle classifies the impossibility as the named race". The BFS treats `Err` as a leaf: no successor, but the `RaceClass` is recorded against the trace. The function is *deterministic* — same `(s, a)`, same `s'`. Where the model branches (e.g. `ResolvePending` against multiple in-flight resources), the branching is encoded in `Action`, not in `T`.

#### Trace

```rust
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub action: Action,
    pub phases: Vec<PhaseStep>,
    pub state_before: StateHash,
    pub state_after: Option<StateHash>,
    pub events: Vec<Event>,
    pub races: Vec<RaceClass>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    pub start: StateHash,
    pub steps: ImVector<Step>,
    pub bound: Bound,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum Event {
    Notify { observer_id: ObserverId, node: NodeId, value: Value },
    CommitAppended { time: GraphTime, intent: String },
    ResourcePhase { resource: ResourceId, phase: ResourceState },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct StateHash(pub [u8; 32]);
```

`im::Vector` rather than `Vec` so two traces sharing a prefix share that prefix's memory. `blake3::Hash` rather than `u64` for `StateHash` because the visited set must resist *engineered* collision — a pathological IR could otherwise be crafted to confuse the enumerator into pruning a real bug.

#### Oracle

```rust
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum RaceClass {
    GlitchPropagation { node: NodeId, at: GraphTime },
    SubscribeAfterDispose { observer_id: ObserverId },
    DynamicDepDivergence { node: NodeId },
    PendingResolveRace { resource_a: ResourceId, resource_b: ResourceId },
    ObserverFiredOnUnchanged { observer_id: ObserverId, at: GraphTime },
    ReachableCycle { path: Vec<NodeId> },
    ReplayDivergence { at: GraphTime },
    StructurallyInvalid { reason: String },
}

pub trait Oracle: Send + Sync {
    fn check(&self, s: &State, prev: Option<&State>, a: &Action) -> Vec<RaceClass>;
    fn name(&self) -> &'static str;
}
```

#### BFS skeleton

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub initial: Vec<Action>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnumerationReport {
    pub schema: u32,
    pub bound: Bound,
    pub states_visited: u64,
    pub states_pruned: u64,
    pub traces_recorded: Vec<Trace>,
    pub races: Vec<RaceClass>,
    pub bounded_out: bool,
}

pub fn enumerate(
    model: &CauslModel,
    script: &Script,
    bound: Bound,
    oracles: &[Box<dyn Oracle>],
) -> EnumerationReport;

// NOTE — supersession (#645). The original design called for a
// three-coordinate `VisitedKey { state_hash, pending_signature,
// msg_queue_depth }` so the BFS could distinguish two states with
// identical inputs but different in-flight queues. The wave-29
// `OrdMap` / `OrdSet` / `Vector` migration made `State::hash()`
// participate over every State field — including `pending_pipeline`
// in FIFO order — so the structured key now computes the same
// information twice. The shipped Rust crate uses the bare
// `StateHash` directly as the visited-set key, which matches the
// SPEC's intent without the redundancy.

pub struct VisitedSet {
    inner: lru::LruCache<StateHash, ()>,
    cap: usize,
}
```

The `lru` crate gives us bounded eviction. The trade is named honestly in `EnumerationReport.bounded_out`: if the search saturated the cap, the report says so, and the soundness claim downgrades to "no race within the explored subspace". This is the same honesty `tools/checker/src/check.rs` already practices for `Bounds::max_nodes`.

#### Bound

```rust
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct Bound {
    pub linter: causl_check::check::Bounds,
    pub k_prefix: usize,
    pub suffix_random: usize,
    pub depth: usize,
    pub tier: Tier,
    pub visited_cap: usize,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    CyclesOnly,    // §16.6 milestone 1
    AsyncAndMsg,   // §16.6 milestone 2
    Full,          // §16.6 milestone 3 — 90% of §9.1
}

impl Bound {
    #[must_use]
    pub fn spec_defaults() -> Self {
        Self {
            linter: causl_check::check::Bounds::spec_defaults(),
            k_prefix: 16,
            suffix_random: 64,
            depth: 256,
            tier: Tier::AsyncAndMsg,
            visited_cap: 1 << 20, // ~1M entries; ~1 GiB RAM
        }
    }
}
```

#### Worker-pool RPC types

`derived` bodies are arbitrary user-supplied closures — the enumerator cannot run them in-process without embedding a JS engine. The shape is a long-lived Node worker pool talking to the Rust enumerator via line-delimited JSON over stdio.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeRequest {
    pub node_id: NodeId,
    pub input_snapshot: BTreeMap<NodeId, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeResponse {
    pub value: Value,
    pub error: Option<String>,
}

pub struct WorkerHandle {
    pub tx: crossbeam_channel::Sender<ComputeRequest>,
    pub rx: crossbeam_channel::Receiver<ComputeResponse>,
    pub pid: u32,
}

pub struct WorkerPool {
    pub workers: Vec<WorkerHandle>,
    pub cache: dashmap::DashMap<[u8; 32], Value>,
}

impl WorkerPool {
    pub fn compute(&self, req: &ComputeRequest)
        -> Result<ComputeResponse, WorkerError>;
}

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("worker {pid} crashed: {reason}")]
    Crashed { pid: u32, reason: String },
    #[error("worker pool exhausted after {tries} tries")]
    Exhausted { tries: u8 },
    #[error("response failed JSON validation: {0}")]
    Malformed(#[from] serde_json::Error),
}
```

The wire format is intentionally JSON, not bincode: `@causljs/core` is TypeScript, the worker is Node, and JSON is the protocol every Node program already speaks. The `dashmap` content-addressed cache makes a hot-path hit O(1) without crossing the process boundary, paying back the parse overhead.

#### What the type signatures buy and what is left to the implementation

What the type signatures buy: a literal day-one `cargo new tools/enumerator` template. The signatures pin the `State`/`Action`/`Trace` shapes such that the differential-testing scaffold §15.1/§16.5 names has a fixed comparison surface from the first commit. They pin the `Bound` knobs to the same names the published `--max-*` CLI flags use. They make the K=10-trace memory budget mechanically enforceable: `VisitedSet`'s `lru::LruCache` is the wall, `EnumerationReport.bounded_out` is the honest report when the wall is hit.

What is left to the implementation: the `transition` function body itself; the oracle implementations (one per §9.1 row, modelled on `glitch_propagation_pass`); the worker-pool supervisor (`crossbeam-channel` send-and-restart-on-crash); the `propertyDag → Script` bridge.

What we explicitly do *not* commit: the schedule. The §16.4 narrative is unchanged — this is still deferred work, the v1 linter still ships the static eight-pass shape, and the trigger for reopening (the §9.1 ratchet hitting 90%) is unchanged. The signatures exist so that *if* the trigger fires, the implementation is not starting from prose.

### 16.5 Deferred PLANNED — the hypothesis grammar

When §16.4 reopens, the differential-testing scaffold is the same generator family §15.1 names: random IRs from `propertyDag`, replayed against the linter and the enumerator side-by-side. A divergence is a bug in one of them.

Lamport's precedent from TLA+ — temporal logic on traces — is the right shape for adopter-written invariants. The grammar:

```ts
hypothesis(name: string, predicate: (trace: Trace) => Verdict)

always(p)                  // ∀ s ∈ trace: p(s)
eventually(p)              // ∃ s ∈ trace: p(s)
p.until(q)                 // p holds at every s until some s where q holds
afterCommit(intent, p)
during(phase, p)
never(eventName)           // shorthand for always(s => !s.justFired(eventName))
implies(p, q)
```

Concrete adopter hypothesis: `hypothesis('no-dispose-during-commit', always(s => !(s.engineState === 'Committing' && s.lastAction.kind === 'dispose')))`. Counterexample shape: a minimal interleaving witnessing the violation, shrunk to **fewest actions**, **fewest distinct nodes**, **earliest violating step** — Hypothesis-style shrinking, not just `quickcheck` first-fail. The shrinker is the part adopters will judge the tool on.

Hypotheses live alongside the entry-point script: `script.causl.ts` exports `entry()` and an array of `hypothesis(...)` records; `causl-check enumerate` reads both. Apalache (TLA+) is rejected as a shipping path — Apalache wants restricted-syntax models, not arbitrary TypeScript `compute`. Translating the IR is a separate compiler. Apalache stays as a **tiny-corpus oracle**: on 10 hand-written models, run both Apalache and our enumerator and assert non-divergence. That is §16.5's differential-testing scaffold in its strongest form.


### 16.5.1 Hypothesis API (full TypeScript signatures)

We are Leslie Lamport and Kent Beck, and we are writing down what the deferred enumerator's hypothesis layer looks like at the surface an adopter touches. The §16.5 narrative names the combinator set as a list. A list is not a grammar. A grammar has signatures, semantics, and a witness story when a check fails. This sub-section pins those three down.

Lamport's line on temporal logic is the one we are building toward: "A specification is a behavior that is allowed; everything else is forbidden." Each combinator below is a behavior-set predicate, defined over a finite trace the enumerator hands us. Beck's framing of the test as the oracle is the load-bearing reason these are TypeScript values an adopter writes by hand: an oracle the adopter cannot read, the adopter cannot trust, and the team has watched four projects discover that the property suite the adopter does not read is the property suite the adopter routes around at the first red CI run.

#### Core types

```ts
export interface Trace<S> {
  readonly steps: ReadonlyArray<Step<S>>
  readonly bound: Bound
  readonly seed: number
}

export interface Step<S> {
  readonly index: number
  readonly state: State<S>
  readonly phase: PhaseStep
  readonly justFired: ReadonlySet<EventName>
  readonly justCommitted: ReadonlyArray<CommitRecord>
}

export interface State<S> {
  readonly graph: GraphSnapshot
  readonly app: S
  readonly justFired: (e: EventName) => boolean
  readonly inPhase: (p: PhaseStep) => boolean
  readonly lastCommit: CommitRecord | null
}

export type PhaseStep =
  | 'idle' | 'commit-prepare' | 'commit-resolve-async'
  | 'commit-fanout' | 'commit-finalize' | 'msg-dispatch' | 'msg-fanout'

export type Verdict<S> =
  | { kind: 'pass' }
  | { kind: 'fail'; step: number; witness: State<S>; reason: string }

export type Predicate<S> = (trace: Trace<S>) => Verdict<S>
export type StepPredicate<S> = (state: State<S>, index: number) => boolean

export interface Bound {
  readonly maxNodes: number
  readonly maxCommits: number
  readonly maxAsyncDepth: number
  readonly maxMsgFanout: number
}

export type SetupFn<S> = (engine: Engine) => S
export type InvariantFn<S> = (state: State<S>) => boolean
```

#### `hypothesis(name, body)` — the factory

```ts
export interface HypothesisBody<S> {
  readonly bound: Bound
  readonly setup: SetupFn<S>
  readonly invariant?: InvariantFn<S>
  readonly predicate: Predicate<S>
}

export interface Hypothesis<S> {
  readonly name: string
  readonly body: HypothesisBody<S>
  readonly run: (trace: Trace<S>) => Verdict<S>
}

export function hypothesis<S>(
  name: string, body: HypothesisBody<S>,
): Hypothesis<S>
```

What `run` does: walk every step, fail fast on `invariant` returning false (with `reason: 'invariant-violation'`), then evaluate `body.predicate(trace)` and return its verdict. The split between `invariant` and `predicate` is the same split TLA+ draws between the safety part of `Spec` and the temporal-formula part: invariants are checked at every step; the predicate is checked once over the whole trace.

A hypothesis file an adopter writes:

```ts
import { hypothesis, always, afterCommit, implies } from '@causljs/hypothesis'

interface AppState { cellId: NodeId; inputId: NodeId }

export default hypothesis<AppState>('derived-never-stale-after-commit', {
  bound: { maxNodes: 12, maxCommits: 6, maxAsyncDepth: 2, maxMsgFanout: 3 },
  setup: (engine) => {
    const inputId = engine.input(0)
    const cellId = engine.derived(({ get }) => get(inputId) * 2)
    return { cellId, inputId }
  },
  invariant: (s) => s.graph.acyclic(),
  predicate: (trace) =>
    afterCommit({ touches: 'inputId' }, (s, app) =>
      s.graph.read(app.cellId) === 2 * s.graph.read(app.inputId),
    )(trace),
})
```

#### `always(predicate)` — Lamport's `[]`

```ts
export function always<S>(predicate: StepPredicate<S>): Predicate<S> {
  return (trace) => {
    for (const step of trace.steps) {
      if (!predicate(step.state, step.index)) {
        return {
          kind: 'fail', step: step.index, witness: step.state,
          reason: `always: predicate failed at step ${step.index}`,
        }
      }
    }
    return { kind: 'pass' }
  }
}
```

`pass` iff `p` holds at every step. `fail` at the first step where `p` returns false. The first-failure rule is what makes the witness narrative legible at the call site.

#### `eventually(predicate)` — Lamport's `<>`

```ts
export function eventually<S>(predicate: StepPredicate<S>): Predicate<S> {
  return (trace) => {
    for (const step of trace.steps) {
      if (predicate(step.state, step.index)) return { kind: 'pass' }
    }
    const last = trace.steps[trace.steps.length - 1]
    return {
      kind: 'fail', step: last.index, witness: last.state,
      reason: 'eventually: predicate never held within trace bound',
    }
  }
}
```

`pass` iff `p` is true at some step. Failure means "never held within trace bound" — not "never held in any model". Adopter response: relax the predicate or raise the bound.

#### `holds(p).until(q)` — Lamport's `U`

```ts
export interface UntilBuilder<S> { until(q: StepPredicate<S>): Predicate<S> }

export function holds<S>(p: StepPredicate<S>): UntilBuilder<S> {
  return {
    until(q) {
      return (trace) => {
        for (const step of trace.steps) {
          if (q(step.state, step.index)) return { kind: 'pass' }
          if (!p(step.state, step.index)) {
            return {
              kind: 'fail', step: step.index, witness: step.state,
              reason: `until: p failed at step ${step.index} before q held`,
            }
          }
        }
        const last = trace.steps[trace.steps.length - 1]
        return {
          kind: 'fail', step: last.index, witness: last.state,
          reason: 'until: q never held within trace bound',
        }
      }
    },
  }
}
```

Strong-`until` by default — `q` must be reached. A `holds(p).weakUntil(q)` variant exists for the case the adopter does not require `q` to be witnessed.

#### `afterCommit(intent, p)` — phase-conditional `always`

```ts
export interface CommitMatcher {
  readonly touches?: string
  readonly tag?: string
  readonly any?: true
}

export function afterCommit<S>(
  match: CommitMatcher,
  p: (state: State<S>, app: S) => boolean,
): Predicate<S>
```

For every step that is the immediate successor of a commit matching `match` and whose phase is `idle` (i.e., commit-fanout has settled), evaluate `p`. The `phase === 'idle'` gate is where this combinator earns its keep over a hand-rolled `always`: post-commit consistency is checked at steady state, not during fanout.

#### `during(phase, p)` — phase-restricted `always`

```ts
export function during<S>(phase: PhaseStep, p: StepPredicate<S>): Predicate<S>
```

At every step where `step.phase === phase`, evaluate `p`. `during('commit-resolve-async', s => s.graph.everyResourceIsResolvable())` is the canonical use.

#### `never(eventName)` — sugar

```ts
export function never<S>(eventName: EventName): Predicate<S> {
  return always<S>((s) => !s.justFired(eventName))
}
```

Shorthand for `always(s => !s.justFired(eventName))`. The reason string says `never: ${eventName} fired at step ${step}`.

#### `implies(p, q)` — material implication

```ts
export function implies<S>(
  p: StepPredicate<S>, q: StepPredicate<S>,
): Predicate<S> {
  return (trace) => {
    for (const step of trace.steps) {
      if (p(step.state, step.index) && !q(step.state, step.index)) {
        return {
          kind: 'fail', step: step.index, witness: step.state,
          reason: `implies: p held but q did not at step ${step.index}`,
        }
      }
    }
    return { kind: 'pass' }
  }
}
```

The reason string distinguishes "p false (vacuous)" from "p true and q false (real violation)" so the adopter is not chasing vacuously-true witnesses.

#### Composition under `and` / `or`

```ts
export function and<S>(...ps: ReadonlyArray<Predicate<S>>): Predicate<S>
export function or<S>(...ps: ReadonlyArray<Predicate<S>>): Predicate<S>
```

`and` short-circuits on first failure; `or` short-circuits on first pass. On full failure of `or`, returns the failure with the smallest `step` index across the disjuncts.

### 16.5.2 Counterexample shrinking algorithm

A hypothesis that fails returns a `Verdict` with a `step`, a `witness`, and a `reason`. That is enough to prove the system has a bug. It is not enough to *teach* the adopter what the bug is. We shrink along three axes: **fewest actions**, **fewest distinct nodes**, **earliest violating step**.

```ts
export interface ShrinkInput<S> {
  readonly hypothesis: Hypothesis<S>
  readonly trace: Trace<S>
  readonly verdict: Extract<Verdict<S>, { kind: 'fail' }>
  readonly seed: number
}

export interface ShrinkResult<S> {
  readonly trace: Trace<S>
  readonly verdict: Extract<Verdict<S>, { kind: 'fail' }>
  readonly passes: ReadonlyArray<{
    readonly axis: 'actions' | 'nodes' | 'step'
    readonly before: number
    readonly after: number
  }>
}

export function shrink<S>(input: ShrinkInput<S>): ShrinkResult<S>
```

**Pass 1: fewest actions.** Standard delta-debug over the action sequence. Try removing chunks of decreasing size; every successful removal preserves the failing verdict. The output is a locally minimal action sequence under chunk-removal.

**Pass 2: fewest distinct nodes.** Two moves per node: drop the node entirely if the trace still fails without it, or merge the node into another node if the trace still fails after the merge. Repeat until neither move makes progress.

**Pass 3: earliest violating step.** Try truncating the prefix of the action list. If the hypothesis still fails at an earlier step on the truncated trace, the prefix was load-bearing for the bug's mechanism but not for the bug itself; drop it.

The outer loop runs until no pass makes progress on any axis. The shrinker invariant: a shrunk trace must still violate the predicate. If a pass produces a passing trace, that is a bug in the shrinker, and we want it loud at the call site.

#### Apalache as the tiny-corpus oracle

**The corpus.** A curated set of 10 hand-written models in `causl-checker/corpus/apalache/*.tla`. Each encodes a §9.1 race-class scenario in TLA+; each has a paired Rust enumerator scenario in `causl-checker/corpus/rust/*.scenario.rs`. The mapping between TLA+ identifiers and Rust IR identifiers is recorded in `causl-checker/corpus/mapping.toml`.

**The differential test.** A CI job — the `Tier 3 — enumerator K=20 D=8 + Apalache corpus` job in `.github/workflows/race-detection.yml` — runs both engines against every model in the corpus, with the same property assertions. Apalache runs in `check` mode against the TLA+ form. The Rust enumerator runs against the IR form. Both produce a verdict per property: `pass`, `fail`, or `bound-exceeded`. The test passes iff every model agrees on every property. (#583 reconciled the SPEC reference with the actual workflow file; the apalache-diff harness skeleton lives in `tools/apalache-diff/` and the Tier 3 graduation is tracked in #574.)

**Divergence detection.** The runner reads both verdict streams, joins on `(model, property)`, and emits a divergence row when:
- one engine returns `pass` and the other returns `fail`;
- both return `fail` but the witness states are not isomorphic up to the mapping;
- one returns `bound-exceeded` and the other returns `pass` (Rust enumerator's bound too tight for a property Apalache can prove — soft failure that opens an issue).

**The report.** The job uploads `apalache-diff-report.md` to the workflow run on every divergence.

The two-engine setup is what Beck's "two oracles, one truth" lesson buys: neither Apalache nor the Rust enumerator is the truth; the truth is the conjunction of their agreement plus the named exceptions. When the corpus is at 10/10 agreement on 47/47 properties, the enumerator is as trustworthy as the corpus is broad, and the corpus's breadth is reviewable in one sitting.

**What the corpus does not buy.** Apalache cannot run on adopter-written hypotheses. The TLA+ form is hand-written and stays small by design. Adopter properties are checked by the Rust enumerator alone. The corpus is the mechanism by which the adopter trusts the Rust enumerator without reading its source.

#### What the formalised grammar buys and what stays at the call site

What the formalised grammar buys: an adopter's hypothesis file is a TypeScript program that compiles to a `Hypothesis<S>` value with named, type-checked combinators, evaluated against the enumerator's traces, with verdicts that point at a specific step and a specific witness state. The reason strings are uniform across the combinator set. The shrinker reduces every red verdict along three named axes before the adopter sees it. The Apalache corpus differential is the team's standing claim that the enumerator's verdicts agree with an independent oracle on the curated scenarios.

What stays at the call site: the *choice* of predicate. The combinators are the vocabulary, not the sentences. Whether the adopter writes `afterCommit({ touches: 'inputId' }, p)` or `during('commit-finalize', p)` or `holds(p).until(q)` is a question about which behavior they are claiming the system has, and that question lives at the call site, in the adopter's domain, with the adopter's review.

### 16.6 Deferred PLANNED — TDD plan when reopened

Five milestones, in this order:

1. **BFS skeleton + cycle row coverage.** The enumerator's BFS over the IR state space, bounded by the `--max-*` flags. Acceptance: rows 1, 4, 8 of §9.1 caught on a known-race fixture; rows 5, 7 caught on the property-suite scaffolding.
2. **Async resolution + Msg trajectory.** State space extends to pending resource resolutions and message-dispatch traversal. Acceptance: rows 2, 6 on a fixture with `@causljs/sync` resources.
3. **Hypothesis evaluator.** `always | eventually | until | afterCommit | during | never | implies` over the trace. Acceptance: a hand-written hypothesis fails closed when an injected race fires; passes when the script is race-free.
4. **Counterexample shrinker.** Three-axis shrinking (fewest actions, fewest nodes, earliest step). Acceptance: a 50-event reproducer shrinks to ≤5 events on a row-7 violation.
5. **Coverage-gate ratchet.** The §9.1 coverage column moves from today's static-linter floor toward the 90% target. Acceptance: `docs/checker-coverage.md` reports ≥90% across STATIC + PROPERTY + MODEL layers; `tools/checker/tests/race-detection-acceptance.rs` enumerates every §9.1 row and refuses to compile if a row has no fixture in its assigned layer.

Determinism is enforced by a 100-run identity test: same IR + same script + same `--seed` + same `--max-*` ⇒ byte-identical output. A flake in the detector fails the build. Beck's rule, sharpened: a model checker that flakes is worse than no checker because it teaches the team to ignore red.

### 16.7 Distribution — per-platform binaries via npm

`@causljs/checker` is published with `optionalDependencies` per-platform packages: `@causljs/checker-{linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64}`. The wrapper resolves the matching package at install time via `os` / `cpu` filtering — no postinstall network fetch — and execs its binary on invocation.

The release workflow lives at `.github/workflows/release-checker.yml`. A `checker-v*` git tag triggers the matrix across five `runs-on:` legs; `workflow_dispatch` runs the build-and-checksum legs without minting a tag. Per #390 / #454 — the distribution rails were the open work that turned the linter from an in-tree CI binary into an adopter-facing dependency.

**What the team rejected and why.** Three shapes were on the table. Ship the bounded enumerator on the original schedule — rejected because the calendar slippage was real, the TDD plan was unwritten, and the static-linter shape closed enough §9.1 rows to earn its CI slot. Strike §16 entirely — rejected because the linter catches structural-IR violations the property suite cannot reach. Ship the linter as v1 with the enumerator deferred under a named reopen trigger — what the team picked.

---

## 16A. Race-detection CI tiers

§16 ships a static linter and parks the enumerator. §16A is the contract that names how the layers compose into a CI gate: which §9.1 row is caught at which layer, what runs on every PR vs nightly, what the adopter sees when a race fires. The section is a sibling of §16 because nesting CI-pipeline shape inside the linter section forces a reader to reconcile "deferred" against "tiered gate" in the same paragraph; §16A is the reopen contract drawn alongside, not buried.

### 16A.1 Layer classification — the §9.1 walk

Hejlsberg's classification, against the seventeen rows. Four detection layers; each row lives in exactly one (or transitions on a named gate):

| # | Race (abridged) | Layer | Caught by |
| --- | --- | --- | --- |
| 1 | Concurrent engine mutations | STATIC | API shape (`commit` is the only mutation entry); `causl-check` `CommitFromSubscribe` pass below. Runtime: `CommitInProgressError`. |
| 2 | Read not-yet-loaded resource | STATIC | `ResourceState<T>` DU + `assertNever`. Runtime: `ForbiddenResourceTransitionError`. |
| 3 | Read partially-parsed formula | STATIC after the §9 four-state union lands; RUNTIME-ONLY today | `FormulaError` DU. |
| 4 | Read mid-staged snapshot | STATIC | API design (no Tx-escape API); `StaleTxError` catches the escape attempt. |
| 5 | Diamond glitches | PROPERTY | §15.1 `glitch-freedom.test.ts` at the 1000-trial floor. `GlitchPropagation` linter pass is structural, not sufficient. |
| 6 | Stale-async resolution | RUNTIME-ONLY | `originGraphTime` compare in `@causljs/sync`. Network is the oracle. |
| 7 | Dynamic-dep cleanup | PROPERTY | `dynamic-deps.test.ts`. MODEL would prove for bounded programs. |
| 8 | Cycle in derivation graph | STATIC for declared edges (`Cycle` pass); PROPERTY for conditional-dep cycles. MODEL closes the gap. |
| 9 | Two app-level Msgs producing inconsistent intermediate state | RUNTIME-ONLY | Adopter-side property tests per `docs/application-side-property-tests.md`. |
| 10 | Multi-user write-write | RUNTIME-ONLY | Out of scope per §13.7. |
| 11 | Use-after-dispose on family node | STATIC after `UseAfterDispose` pass below; PROPERTY today | `disposed-tombstone-bound.test.ts`. Runtime: `NodeDisposedError`. |
| 12 | Hydration mismatch | STATIC | `Schema` pass + `schemaHash` lockstep. Runtime: `HydrationSchemaError`. |
| 13 | Hydrate emitted but subscribers don't wake | STATIC | API shape — same Phase A–H pipeline. |
| 14 | Non-monotonic GraphTime on hydrate | STATIC | `Monotonic` pass. |
| 15 | Time-travel jump cannot fork | STATIC | `Retained \| Evicted` DU at `snapshotAt(t)`. |
| 16 | Persistence schema-version overwrite | STATIC | `PersistenceError` DU + `schemaHash` lockstep. |
| 17 | Suspense fresh-Promise-per-render | STATIC | API shape — Promise lives on `ResourceState.loading`. |

Tally: STATIC = 10, PROPERTY = 3 (rows 5, 7, plus the conditional-dep half of 8), MODEL = the conditional-dep gaps in 7 / 8 plus commit-during-subscribe interleavings the property suite reaches but does not exhaust, RUNTIME-ONLY = 4 (rows 6, 9, 10, plus row 3 until the four-state union ships).

### 16A.2 Static layer additions

Eight passes ship today (§16.1). Four passes are designed for v1.x; **all four depend on a schema bump from 2 to 3** that adds event-level granularity to the IR. The schema bump itself shipped via EPIC-1 PR-A (per §16.2.1) — the current IR is `schema: 3` and carries `graphId` per node and commit, the closed six-arm `IREvent` union (`IRSubscribe | IRSubscribeCallback | IRUnsubscribe | IRDispose | IRRead | IRTxSet`), the `IRScope` registry, and the `IRBridge` allowlist. The schema 3 foundation is in place; the four passes below remain v1.x work because each pass's own logic, fixtures, and SARIF rule metadata are scheduled across the implementation slices PR B / PR C name. (An earlier draft of this paragraph described the schema bump as still-to-ship; that paragraph was retired when EPIC-1 PR-A landed.)

1. **`SubscribeWithoutDispose`** (depends on schema 3 + `IRSubscribe { id, scope, infinite }` + `IRDispose { id, time }`). IR pattern: every `IRSubscribe { id, scope }` must have a matching `IRDispose { id }` reachable in the same `scope` lifetime, OR the scope must be marked `infinite: true`. Estimated false-positive rate: <2% under the React `<Hydrate>` boundary; ~10% in raw-engine scripts. SARIF `ruleId: "causl/subscribe-leak"`, `level: "warning"` outside React, `"error"` inside.
2. **`CommitFromSubscribe`** (depends on schema 3 + call-graph annotation on `IRCommit`). IR pattern: any `IRCommit` whose dynamic-call ancestor in the IR's call-graph annotation contains an `IRSubscribeCallback` is a row-1 violation. Today the engine throws `CommitInProgressError` at runtime; the static pass lifts the row to compile-time-equivalent. False positives: <1% once the call-graph annotation is in place — annotated by the TypeScript exporter, not inferred. SARIF `ruleId: "causl/commit-in-subscribe"`, `level: "error"`.
3. **`CrossGraphRead`** (depends on schema 3 + `graphId` per `IRNode`). IR pattern: a `derived` body's `get(node)` references a node id whose `graphId` differs from the enclosing graph's `graphId`, and the read is not routed through a supported bridge. False positives: 0% by construction once the IR carries `graphId` per node. SARIF `ruleId: "causl/cross-graph-read"`, `level: "error"`.
4. **`UseAfterDispose`** (depends on schema 3 + `IRRead | IRSubscribe | IRTxSet` event records + `IRDispose`). IR pattern: any `IRRead | IRSubscribe | IRTxSet` referencing a node id whose latest IR event is `IRDispose`. Lifts row 11 from RUNTIME-ONLY into STATIC for the bounded prefix the IR captures. False positives: ~5% on family-keyed nodes whose disposal happens in a sibling subtree the IR doesn't model — those stay PROPERTY-caught. SARIF `ruleId: "causl/use-after-dispose"`, `level: "error"`.

Each pass emits a `Violation { kind, node_ids, span, suggested_fix }` matching the existing `tools/checker/src/check.rs::Violation` shape. SARIF output extends today's `Report` JSON with a `to_sarif()` adapter; rule metadata lands in `tools/checker/src/sarif.rs`.

**Implementation slicing.** The four passes ship across three PRs, in this order:

- **PR A — Schema 3 foundation (LANDED).** Bumped `CAUSL_MODEL_SCHEMA: 2 → 3`. Added `graphId` to `IRInput` and `IRDerived`; added event records `IRSubscribe`, `IRSubscribeCallback`, `IRUnsubscribe`, `IRDispose`, `IRRead`, `IRTxSet`; added the call-graph annotation slot on `IRCommit`; added `IRScope` and `IRBridge` registries. Updated the TypeScript exporter (`packages/core/src/ir.ts`, `graph.exportModel()`) to serialize subscriber-registry, disposal-tombstone, and (bounded) read-trace data the engine already tracks internally. Updated the Rust IR types (`tools/checker/src/ir.rs`) and the `Schema` pass to gate on `schema == 3`. Updated the version-lockstep workflow (`.github/workflows/release-checker.yml`) — Cargo `version` ↔ npm `@causljs/checker` `version` ↔ `CAUSL_MODEL_SCHEMA` constant — to fail the release on a 2-vs-3 mismatch. No new pass code landed in PR A.
- **PR B — Subscribe / dispose lifetime passes.** Adds `SubscribeWithoutDispose` and `CommitFromSubscribe` against the new IR. Adds `ViolationKind` variants, fixtures under `tools/checker/tests/fixtures/`, and SARIF rule metadata.
- **PR C — Read / dispose / cross-graph passes.** Adds `CrossGraphRead` and `UseAfterDispose` against the new IR. Closes commitment 9's MECHANICAL anchor for the STATIC subset of §9.1.


### 16A.2.1 Pass specifications (formal)

The narrative above gives the pass *names*. An implementer needs more: the IR pattern, the algorithm, fixtures, the SARIF shape, the false-positive surface, and the Rust enum variants. We three (Wirfs-Brock, Hejlsberg, Miller) sat with the schema-3 IR draft from PR-A and wrote the four passes down at the level a Rust author can implement against without further calibration.

A note before the per-pass blocks. **Wirfs-Brock:** the wire format is the contract; every IR pattern below is expressed against the on-disk JSON shape, not against in-memory Rust types that may drift. **Hejlsberg:** every pattern terminates in a tagged-union match, and every match is exhaustive — the schema-3 enum is `#[non_exhaustive]` precisely so we can add variants without breaking adopters' SARIF consumers, but inside the checker every arm is named. **Miller:** each pass narrows a capability that the runtime would otherwise have to check dynamically. We are pulling those narrowings forward from runtime guards into static rules.

#### SubscribeWithoutDispose

**IR pattern.** For every `IRSubscribe { id, scope_id, target, callback_site }` in `model.events`, let `S` be the `IRScope { id: scope_id, kind, lifetime }`. Emit a violation iff:

```
not exists IRDispose { subscribe_id: id } in model.events
AND S.kind != "infinite"
AND S.lifetime.terminator != "process-exit"
```

**Algorithm.**

```rust
fn subscribe_without_dispose_pass(model: &CauslModel) -> Vec<Violation> {
    let disposed: HashSet<&str> = model.events.iter()
        .filter_map(|e| e.as_dispose().map(|d| d.subscribe_id.as_str()))
        .collect();
    let scopes: HashMap<&str, &IrScope> = model.scopes.iter()
        .map(|s| (s.id.as_str(), s)).collect();
    let mut out = Vec::new();
    for ev in &model.events {
        let Some(sub) = ev.as_subscribe() else { continue };
        if disposed.contains(sub.id.as_str()) { continue; }
        let scope = scopes.get(sub.scope_id.as_str());
        let infinite = scope.is_some_and(|s| s.kind == ScopeKind::Infinite
            || s.lifetime.terminator == LifetimeTerminator::ProcessExit);
        if infinite { continue; }
        out.push(Violation {
            kind: ViolationKind::SubscribeWithoutDispose,
            node: Some(sub.target.clone()),
            commit: None,
            message: format!("Subscription `{}` to `{}` in scope `{}` has no matching dispose",
                sub.id, sub.target, sub.scope_id),
        });
    }
    out
}
```

**Positive fixture.**

```json
{
  "schema": 3, "time": 12, "graphId": "g.main",
  "nodes": [{ "kind": "input", "graphId": "g.main", "id": "count", "value": 0, "serializable": true }],
  "scopes": [{ "id": "scope.editor.row.42", "kind": "ephemeral",
    "lifetime": { "origin": "row-mount", "terminator": "row-unmount" } }],
  "events": [{ "kind": "subscribe", "id": "sub.7", "scopeId": "scope.editor.row.42",
    "target": "count", "callbackSite": "src/RowView.tsx:48" }],
  "commits": []
}
```

**Negative fixture.** Same shape, but with the matching dispose:

```json
{ "events": [
  { "kind": "subscribe", "id": "sub.7", "scopeId": "scope.editor.row.42",
    "target": "count", "callbackSite": "src/RowView.tsx:48" },
  { "kind": "dispose", "subscribeId": "sub.7", "scopeId": "scope.editor.row.42",
    "callSite": "src/RowView.tsx:51" }
]}
```

**Expected SARIF.**

```json
{
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": { "name": "causl-check",
      "rules": [{ "id": "subscribe-without-dispose", "helpUri": "https://causl.dev/checker/subscribe-without-dispose" }] } },
    "results": [{
      "ruleId": "subscribe-without-dispose", "level": "error",
      "message": { "text": "Subscription `sub.7` to `count` in scope `scope.editor.row.42` has no matching dispose" },
      "locations": [{
        "physicalLocation": { "artifactLocation": { "uri": "src/RowView.tsx" }, "region": { "startLine": 48 } },
        "logicalLocations": [
          { "name": "count", "kind": "node" },
          { "name": "scope.editor.row.42", "kind": "scope" }
        ]
      }]
    }]
  }]
}
```

**False-positive examples.**

1. *Adopter mounts a subscription at app boot inside `main()` and the process exits via Ctrl-C.* Scope is process-lifetime but exporter recorded `kind: "ephemeral"`. **Fix:** annotate the scope with `kind: "infinite"`.
2. *Test fixtures that subscribe inside `beforeAll`.* Same shape. **Fix:** wrap in `withTestScope(t, ...)` helper. Suppression also acceptable: `// causl-check: subscribe-without-dispose -- jest-process-scoped`.
3. *FFI bridge code where dispose is performed by a finalizer the IR cannot see.* **Fix:** record a synthetic `IRDispose` event in the exporter's `bridgeFinalizers` hook, OR add suppression `// causl-check: subscribe-without-dispose -- ffi-finalizer`.

```rust
#[non_exhaustive]
pub enum ViolationKind { /* ... */ SubscribeWithoutDispose }
#[non_exhaustive]
pub enum PassName { /* ... */ SubscribeWithoutDispose }
```

#### CommitFromSubscribe

**IR pattern.** For every `IRCommit { time, intent, originEvent }` in `model.commits`, emit a violation iff `originEvent` resolves to an `IRSubscribe` callback frame:

```
let origin = model.events.find(e => e.id == commit.originEvent);
origin.kind == "subscribe-callback"
AND origin.subscribeId is well-formed
```

The commit log carries `originEvent: Option<EventId>` in schema 3 specifically so the linter can answer "where did this commit come from." If the origin is itself the body of a subscription notification, we are inside the dirty-walk and a fresh commit re-enters the engine — a glitch class the §9.1 catalogue names *cascading-commit*.

**Algorithm.**

```rust
fn commit_from_subscribe_pass(model: &CauslModel) -> Vec<Violation> {
    let events: HashMap<&str, &IrEvent> = model.events.iter()
        .map(|e| (e.id(), e)).collect();
    let mut out = Vec::new();
    for c in &model.commits {
        let Some(origin_id) = &c.origin_event else { continue };
        let Some(ev) = events.get(origin_id.as_str()) else { continue };
        let IrEvent::SubscribeCallback(cb) = ev else { continue };
        out.push(Violation {
            kind: ViolationKind::CommitFromSubscribe,
            node: None, commit: Some(c.time),
            message: format!("Commit `{}` at t={} originates inside subscribe callback `{}` (subscribed to `{}`)",
                c.intent, c.time, cb.id, cb.subscribe_id),
        });
    }
    out
}
```

**Positive fixture.**

```json
{ "schema": 3, "time": 4, "graphId": "g.main",
  "events": [
    { "kind": "subscribe", "id": "sub.1", "scopeId": "scope.app", "target": "count" },
    { "kind": "subscribe-callback", "id": "cb.1", "subscribeId": "sub.1", "firedAt": 3 }
  ],
  "commits": [
    { "time": 3, "intent": "user-bump", "changedNodes": ["count"], "originEvent": null },
    { "time": 4, "intent": "mirror-double", "changedNodes": ["doubled"], "originEvent": "cb.1" }
  ]
}
```

**Negative fixture.** Mirror updates inside a `derived` node instead, with no commit-from-callback.

**False-positive examples.**

1. *Two-graph mirror.* The pass fires because the callback is the origin, but the cross-graph hop is the desired isolation. **Fix:** mark the commit with `intent: "bridge:A->B"` and add a per-intent allowlist to the checker config.
2. *Optimistic UI rollback.* **Fix:** wrap the rollback in `causl.bridgeCommit(...)` which the exporter records as `kind: "bridge-commit"`.
3. *Logging adapter.* **Fix:** suppression `// causl-check: commit-from-subscribe -- metrics-sink`.

```rust
#[non_exhaustive]
pub enum ViolationKind { /* ... */ CommitFromSubscribe }
#[non_exhaustive]
pub enum PassName { /* ... */ CommitFromSubscribe }
```

#### CrossGraphRead

**IR pattern.** For every `IRDerived { id, graphId, deps, conditionalDeps }`, for every `dep` in `deps ∪ conditionalDeps`, let `target = lookup(dep)`. Emit a violation iff:

```
target is not None
AND target.graphId != self.graphId
AND not exists IRBridge { from: target.graphId, to: self.graphId, dep: dep } in model.bridges
```

**Algorithm.**

```rust
fn cross_graph_read_pass(model: &CauslModel) -> Vec<Violation> {
    let by_id: HashMap<&str, &IrNode> = model.nodes.iter()
        .map(|n| (n.id(), n)).collect();
    let bridged: HashSet<(&str, &str, &str)> = model.bridges.iter()
        .map(|b| (b.from.as_str(), b.to.as_str(), b.dep.as_str()))
        .collect();
    let mut out = Vec::new();
    for n in &model.nodes {
        let Some(d) = n.as_derived() else { continue };
        let self_g = d.graph_id.as_str();
        for dep in d.deps.iter().chain(d.conditional_deps.iter()) {
            let Some(target) = by_id.get(dep.as_str()) else { continue };
            let target_g = target.graph_id();
            if target_g == self_g { continue; }
            if bridged.contains(&(target_g, self_g, dep.as_str())) { continue; }
            out.push(Violation {
                kind: ViolationKind::CrossGraphRead,
                node: Some(d.id.clone()), commit: None,
                message: format!("Derived `{}` in graph `{}` reads `{}` from graph `{}` without a declared bridge",
                    d.id, self_g, dep, target_g),
            });
        }
    }
    out
}
```

**Positive fixture.**

```json
{ "schema": 3, "graphId": "g.app",
  "nodes": [
    { "kind": "input", "graphId": "g.session", "id": "userId", "value": "u-99", "serializable": true },
    { "kind": "derived", "graphId": "g.app", "id": "greeting",
      "deps": ["userId"], "conditionalDeps": [], "value": "hi u-99", "serializable": true }
  ],
  "bridges": []
}
```

**Negative fixture.** Same nodes; the bridge is declared:

```json
{ "bridges": [{ "from": "g.session", "to": "g.app", "dep": "userId", "policy": "read-only" }] }
```

**False-positive examples.**

1. *Adopter is migrating.* All cross-graph reads light up. **Fix:** the migration tool synthesizes `bridges: []` entries with `policy: "legacy-allow"`. Pass treats `legacy-allow` as level `note`.
2. *Singleton "constants" graph (feature flags).* Declaring N bridges is noisy. **Fix:** wildcard bridge: `{ "from": "g.flags", "to": "*", "dep": "*", "policy": "read-only" }`.
3. *Test fixtures import from a fixture graph.* **Fix:** `withFixtureGraph(t, ...)` injects a wildcard bridge with `policy: "test-only"`, stripped from production exports.

```rust
#[non_exhaustive]
pub enum ViolationKind { /* ... */ CrossGraphRead }
#[non_exhaustive]
pub enum PassName { /* ... */ CrossGraphRead }
```

#### UseAfterDispose

**IR pattern.** For every `IRSubscribe { id }` paired with an `IRDispose { subscribeId: id, time: t_d }`, emit a violation iff there exists an `IRSubscribeCallback { subscribeId: id, firedAt: t_f }` with `t_f > t_d` OR an `IRRead { subscribeId: id, at: t_r }` with `t_r > t_d`.

**Algorithm.**

```rust
fn use_after_dispose_pass(model: &CauslModel) -> Vec<Violation> {
    let dispose_times: HashMap<&str, u64> = model.events.iter()
        .filter_map(|e| e.as_dispose().map(|d| (d.subscribe_id.as_str(), d.time)))
        .collect();
    let mut out = Vec::new();
    for ev in &model.events {
        let (sub_id, fired_at, kind_label) = match ev {
            IrEvent::SubscribeCallback(cb) => (cb.subscribe_id.as_str(), cb.fired_at, "fired"),
            IrEvent::Read(r) => (r.subscribe_id.as_str(), r.at, "read"),
            _ => continue,
        };
        let Some(&t_d) = dispose_times.get(sub_id) else { continue };
        if fired_at <= t_d { continue; }
        out.push(Violation {
            kind: ViolationKind::UseAfterDispose,
            node: None, commit: Some(fired_at),
            message: format!("Subscription `{}` was disposed at t={} but {} at t={}",
                sub_id, t_d, kind_label, fired_at),
        });
    }
    out
}
```

**Positive fixture.**

```json
{ "schema": 3, "time": 10, "graphId": "g.main",
  "events": [
    { "kind": "subscribe", "id": "sub.42", "scopeId": "scope.modal", "target": "ticker", "callbackSite": "src/Modal.tsx:30" },
    { "kind": "dispose", "subscribeId": "sub.42", "scopeId": "scope.modal", "time": 6, "callSite": "src/Modal.tsx:34" },
    { "kind": "subscribe-callback", "id": "cb.99", "subscribeId": "sub.42", "firedAt": 9 }
  ]
}
```

**Negative fixture.** Callback fires *before* dispose (firedAt: 4 < dispose time: 6).

**False-positive examples.**

1. *Race in the recorder.* Exporter snapshots events while a dispose is in flight. **Fix:** widen `disposeAt` to half-open interval `[enqueueAt, appliedAt]`; pass uses `appliedAt`.
2. *Async-resolved capability where dispose closes the handle but a previously-scheduled microtask still fires a no-op callback.* **Fix:** runtime emits `kind: "no-op-callback"` for post-dispose firings; pass ignores them.
3. *Replay/time-travel debugger that re-emits historical events.* **Fix:** debugger sets `model.replay = true`; pass gates off entirely.

```rust
#[non_exhaustive]
pub enum ViolationKind { /* ... */ UseAfterDispose }
#[non_exhaustive]
pub enum PassName { /* ... */ UseAfterDispose }
```

#### Cross-pass interactions

**Multiple violations on the same node.** Each pass returns its own `Violation` independently. We considered deduplicating and rejected it — they are different bugs. `SubscribeWithoutDispose` says "you forgot to clean up." `UseAfterDispose` says "your cleanup happened, but something is still firing." Adopters fix them with different code changes. The SARIF consumer is responsible for grouping by location.

**Order-dependence.** The four passes run in a fixed order: `SubscribeWithoutDispose`, `CommitFromSubscribe`, `CrossGraphRead`, `UseAfterDispose`. Leak detection runs before timing detection. **`CrossGraphRead` does NOT short-circuit `UseAfterDispose`** — a cross-graph read that is also a use-after-dispose is two findings, not one. Schema and bounds gates from the existing 8-pass suite still short-circuit *all* downstream passes.

**Selective enabling — the `--passes` flag.** The CLI accepts a comma-separated list:

```
causl-check model.json --passes=subscribe-without-dispose,use-after-dispose
causl-check model.json --passes=-cross-graph-read     # exclude
causl-check model.json --passes=all                   # explicit default
causl-check model.json --passes=core                  # original 8 only
causl-check model.json --passes=lifetime              # the 4 new ones
```

Two named groups — `core` (the original 8) and `lifetime` (the 4 added in §16A) — plus the literal `all` and per-pass kebab-case names. The flag is parsed by the CLI front end and threaded to `check()` as `enabled_passes: Option<HashSet<PassName>>`, defaulting to `None` (run everything the build supports). `passes_run` in the report records the actual list — the truth of what was checked on this invocation.

#### What the per-pass specs buy and what stays at the implementer's discretion

What the four per-pass specifications buy: an unambiguous IR pattern; positive and negative JSON fixtures in the schema-3 shape, ready to drop into `tools/checker/tests/fixtures/`; a SARIF schema; the Rust enum variants fixed at the spec, not at the implementer's keyboard.

What stays at the implementer's discretion: the internal data structures for cross-pass index sharing (`HashSet<&str>` vs `BTreeSet<String>`); the exact pseudocode-to-Rust mapping for `IRBridge`, `IRScope`, `IREvent`; the error messages (we wrote suggestion text, not strict templates); the performance budget (the four passes are O(N) over events).

The four passes lift four runtime-checked capabilities into static rules. Miller's framing is the load-bearing one: every dynamic check the runtime makes is a check we will eventually make every time the program runs. Pulling the check forward to IR-export time makes it a check we make once per CI run. The schema-3 IR shape is the price; the four passes are the payoff. The price was paid in PR-A. The payoff is the four specs above.

### 16A.3 Three-tier hierarchy

Tanner's framing — per-PR cost matters more than completeness — drives the tiering. A 60-min check that catches 95% of races trains adopters to push-and-walk-away; a 2-min check that catches 80% trains them to read the failure.

| Tier | Trigger | Budget | Adds |
| --- | --- | --- | --- |
| **1** | Every PR | ≤2 min | `causl-check` static (12 passes after v1.x) + `tsc` + unit + property suite at the §15.2 1000-trial floor. |
| **2** | PR with `[model-check]` label, push to `main` | ≤15 min | Tier 1 + property suite at 10,000 trials + `causl-check race --k 10 --depth 5` (when §16.4 reopens). |
| **3** | Nightly cron | ≤2 hr | Tier 2 + `causl-check race --k 20 --depth 8` + soak. |

The label-gated tier 2 is the pressure valve: an adopter who *suspects* a race adds the label and gets the bigger hammer in the same PR. The current `ci.yml` already has the right shape — `ts` + `rust` + `checker-gate` + `formula-e2e` as parallel jobs. Tier 2/3 land as additional jobs under `if: contains(github.event.pull_request.labels.*.name, 'model-check') || github.ref == 'refs/heads/main'`.

### 16A.4 Adopter DX — hypothesis files

Hypotheses live in `tests/hypotheses/*.hypothesis.ts` per project. Vitest tests stay unannotated; the enumerator only runs against declared hypotheses.

```ts
// tests/hypotheses/no-commit-during-subscribe.hypothesis.ts
import { hypothesis, always } from '@causljs/checker/hypothesis'

export default hypothesis({
  name: 'no commit during subscribe callback',
  bound: { k: 10, depth: 5 },
  setup: ({ graph }) => {
    const counter = graph.input(0)
    return { counter }
  },
  invariant: ({ trace }) =>
    always(trace, s => s.phase !== 'subscribe-callback' || s.commitsInFrame === 0),
})
```

Per-tier bounds live in `causl.config.ts`:

```ts
import { defineConfig } from '@causljs/checker/config'
export default defineConfig({
  tiers: {
    pr:      { propertyTrials: 1_000 },
    labeled: { propertyTrials: 10_000, race: { k: 10, depth: 5 } },
    nightly: { propertyTrials: 10_000, race: { k: 20, depth: 8 } },
  },
})
```

The public command name is **`causl-check race`** — `causl-check` is already the binary, already published, already in `ci.yml`; subcommands are the cheapest extension. `causl-race` would fork the distribution; `causl audit` collides with `npm audit`; `causl check` is too generic.

### 16A.5 Diagnostic output and false-positive economy

When the enumerator finds a counterexample, the adopter sees a minimal interleaving (not a full BFS dump), source-mapped frames (the IR build step preserves them per §16.2), and a §9.1 row reference:

```
× hypothesis: no commit during subscribe callback
  bound: K=10 depth=5  trials explored: 47  counterexample depth: 3

  minimal interleaving (3 steps):
    1. graph.commit({ counter: 1 })       at app/cart.ts:42:7
    2. enter subscribe callback for `counter` at app/cart.ts:58:11
    3. graph.commit({ counter: 2 })       at app/cart.ts:60:9   ← invariant violated

  race-class: §9.1 row 7 (commit-inside-subscribe reentry)
  suggested fix: defer the inner commit via queueMicrotask, or
                 hoist it out of the subscribe body.
  reproduce: CAUSL_RACE_SEED=0x9a3f pnpm causl-check race --replay
```

Three load-bearing pieces: minimal trace; source-mapped frames; §9.1 row reference. No counterexample without a row reference — if the enumerator finds one it cannot classify, it files an internal bug rather than warning the adopter (Dan's signal-to-noise rule mechanised).

**False-positive economy.** Three escape valves, ranked by reversibility:

1. **`// causl-ignore-race: <reason>` per-site.** Requires non-empty reason; CI greps for empty / placeholder reasons and fails. Audit-trail-friendly.
2. **Bound tightening per-hypothesis.** `bound: { k: 5, depth: 3 }` in the hypothesis file. Local, reviewable.
3. **Hypothesis exemption.** `exempt: true` with a required `because:` field that points at a §9.1 row the codebase has decided is acceptable. Tracked in a top-level `causl-exemptions.md` so the count is visible.

The anti-rot mechanism is **the exemption count is a SARIF-reported metric**. A PR that adds three exemptions is a PR that gets reviewed for adding three exemptions. Matt's frame: the type-discipline cost is paid in the review, not in the suppression. If suppressions stop being conspicuous, the gate is dead.

### 16A.6 Bundle and runtime cost

Production bytes pay zero. `causl-check` is a Rust binary distributed via `@causljs/checker` per-platform `optionalDependencies` (already shipped — §16.7), `devDependency` only. Hypothesis files live under `tests/`, never resolved by the production bundle entry. The `@causljs/checker/hypothesis` runtime helper ships in `@causljs/core-testing-internal` (already a no-publish-to-prod path per §12.3.1). The size-limit ceilings in `package.json` do not move.

### 16A.7 Detection budget

| Layer | Per-PR | Nightly | False-positive rate |
| --- | --- | --- | --- |
| `tsc` + `assertNever` | ~30 s | same | ~0% |
| `causl-check` static (12 passes after v1.x) | <2 s | same | <2% aggregate |
| Property suite | ~3 min @ 1,000 trials | ~30 min @ 10,000 | <0.5% (shrinker confirmed) |
| Bounded enumerator (when §16.4 reopens) | off / opt-in via label | ~45 min @ K=500/D=50 | <1% inside bound; rows outside bound report `BoundExceeded` not `Race` |

Per-PR budget: ~3.5 min. Nightly budget: ~75 min. Static + property ship today; enumerator is the deferred row.

### 16A.8 What the team rejected and why

Three options weighed:

- **Option A — static layer only.** Catches the 10 STATIC rows. Rejected — strikes §15's load-bearing role and launders the §17 commitment 8 promise.
- **Option B — static + property.** Catches STATIC + PROPERTY (13 rows). Picked. Matches §16.0 + §17 commitment 8 verbatim.
- **Option C — full model checker in v1.** Catches STATIC + PROPERTY + MODEL (15 rows; rows 6, 9, 10 stay RUNTIME-ONLY by definition). Deferred under §16.4's named reopen triggers.

Three placements considered for this section. Extend §16 — rejected; §16 is the linter section, and CI-gate prose belongs adjacent to §17 commitment 8, not buried mid-§16. Extend §15 — rejected; §15 is property-fuzz, and folding CI pipeline shape there confuses the layer boundary §16A.1's classification depends on. New §16A — picked.

Three DX shapes considered. Implicit (every test) — rejected; balloons false positives the moment an adopter writes a test that intentionally commits during subscribe to verify error handling. CI-only — rejected; an adopter who cannot reproduce locally cannot debug the failure, and the `--replay` flag with the seed is non-negotiable. Explicit hypothesis files — picked.

---

## 17. What I'm committing to

The previous spec ended with eight commitments, listed flat. The rewrite keeps those eight, marks each as **MECHANICAL** (a CI gate exists) or **DESIGN-DISCIPLINE** (the discipline is enforced by review policy), and adds the four §16A race-detection rows for the layer-classification contract. Twelve in total at signature; #1005 amended in commitment 13 (capability-cost residual) post-wave, taking the table to thirteen; #690's §17.6 amendment adds commitment 14 (host-tier substrate compatibility) as part of the WASM-backend EPIC #680, taking the table to fourteen. Kent Beck's framing of commitments-as-contract is the load-bearing critique. Robert Martin's TDD-as-professionalism framing reinforces the same line. Martin Fowler's interpretation-for-working-teams framing kept the design-discipline rows from being struck.

### 17.1 The fourteen commitments

The previous draft listed eight; §16A adds four race-detection rows; #1005's §17.5 amendment adds row 13 post-wave; #690's §17.6 amendment adds row 14 as part of the WASM-backend EPIC #680. The signature shape is unchanged — each row marked **MECHANICAL** or **DESIGN-DISCIPLINE**, with the anchor named.

| # | Commitment | Type | Anchor |
| --- | --- | --- | --- |
| 1 | The semantic-foundation page in §3 lands first; every later decision references it. | DESIGN-DISCIPLINE | §3, `docs/semantics.md`; review policy on every SPEC-touching PR. |
| 2 | I will not let public surface grow without a §12.2 audit. | DESIGN-DISCIPLINE | §12.2; quarterly review. |
| 3 | The §7 layering is enforced at the package boundary. | MECHANICAL | `eslint.config.js` (#393 / #435); `packages/core/test/layering-lint.test.ts`. |
| 4 | Every discriminated union in §9 is a tagged union with exhaustiveness via `assertNever`. | MECHANICAL | `assertNever` from `@causljs/core/internal`; per-adapter `*.test-d.ts` exhaustiveness fixtures. |
| 5 | The race-class catalogue in §9.1 is current as the engine grows. | DESIGN-DISCIPLINE | §9.1 plus the PR template anchor at `.github/PULL_REQUEST_TEMPLATE.md` (#399 / #430). |
| 6 | The example in §10 is the gate for "the engine is real." Until it works, no other phase begins. | MECHANICAL | `packages/core/test/spec-10-worked-example.test.ts`; required-green on every PR. |
| 7 | I will not ship enum tags whose transitions are not specified by the §6 statechart. | DESIGN-DISCIPLINE | §6 plus `docs/lifecycle.md`. |
| 8 | `causl-check` ships as a required CI gate alongside `tsc` and the property suite. | MECHANICAL | `checker-gate` job in `.github/workflows/ci.yml`; v1 = static linter, deferred enumerator excluded. |
| 9 | The §9.1 STATIC subset is fully covered by `causl-check` lints (eight passes today plus the four §16A.2 additions when they land). | MECHANICAL | `tools/checker/tests/race-detection-acceptance.rs`; per-pass fixtures under `tools/checker/tests/fixtures/`. |
| 10 | The §9.1 PROPERTY subset has property tests at the §15.2 1000-trial floor. | MECHANICAL | `propertyTrials` floor + the `spec-15.2-conformance.test.ts` walker; `packages/core/test/properties/`. |
| 11 | The §9.1 MODEL subset has bounded-enumerator fixtures on the shelf today; the fixtures graduate to MECHANICAL when §16.4 reopens and the enumerator binary ships in `checker-gate`. | DESIGN-DISCIPLINE today; MECHANICAL on §16.4 reopen | `tools/checker/tests/enumerator/soundness/`; §16.0 reopen note. |
| 12 | Every new §9.1 row ships with a detection-layer assignment in the same PR. | DESIGN-DISCIPLINE | `.github/PULL_REQUEST_TEMPLATE.md` race-class anchor extended; §16A.1 layer table. |
| 13 | The replay-determinism contract premium is paid honestly: causl wall-clock stays inside `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0` on contract-bearing cells, anchored at `1.84× engine baseline + 3.5× contract premium` per §17.5 (#1005 amendment). | MECHANICAL | `MEDIAN_BAND_INVARIANTS` in `packages/bench/src/hypotheses/causl-hypotheses.ts`; `pnpm bench:check-hypotheses` median-band gate; `packages/core/test/properties/spec-17-capability-cost.property.test.ts`. |
| 14 | The opt-in `@causljs/core/wasm` substrate ships against a documented **three-tier host compatibility matrix** (`wasmgc-builtins`, `wasmgc-classic`, `serde-json`) with a fall-through fallback to the TS engine; no adopter is ever stranded on an unsupported host because every supported host either runs at least one tier or hits the documented JS-engine fallback path per §17.6 (#690 amendment). | DESIGN-DISCIPLINE | `packages/core/wasm/README.md` host-tier table + `detectBridge()` fallback chain; `docs/wasm-adoption-guide.md` adopter checklist; §17.6 host-tier table and the four-tier feature-detection contract. |

### 17.2 What MECHANICAL means

Commitment 3 is held by the ESLint layering rule plus the `layering-lint.test.ts` fixture. Commitment 4 is held by the `assertNever` exhaustiveness check at every tagged-union switch site, plus per-adapter `*.test-d.ts` fixtures that compile to red on a missing arm. Commitment 6 is held by the spec-10 worked-example test. Commitment 8 is held by the `checker-gate` job, depending on the `ts` and `rust` jobs. Commitment 9 is held by the per-pass fixture suite under `tools/checker/tests/fixtures/` plus the `race-detection-acceptance.rs` gate that refuses to compile if any STATIC row in §9.1 has no fixture. Commitment 10 is held by the `spec-15.2-conformance.test.ts` walker enrolling every `*.property.test.ts` at the 1000-trial floor. Commitment 13 is held by the median-band invariants in `packages/bench/src/hypotheses/causl-hypotheses.ts` (read against `report/fair-fight-results.json`) plus the `spec-17-capability-cost.property.test.ts` property test that locks in the contract surface (atomicity-on-throw + replay-determinism on a canonical seed) the §17.5 amendment names as the basis for the cost.

### 17.3 What DESIGN-DISCIPLINE means

Commitment 1 is held by the spec rewriter's habit of writing §3 before §4–§18 and by every SPEC-touching PR's review checklist. Commitment 2 is held by the §12.2 quarterly audit. Commitment 5 is held by the PR template's race-class anchor (#399 / #430). Commitment 7 is held by the §6 statechart and `docs/lifecycle.md`'s named transitions. Commitment 11 is held by the shelf fixtures under `tools/checker/tests/enumerator/soundness/` — written today against the §16.4 design so the v1.x epic does not start green-field. Commitment 12 is held by the PR template extension that asks every §9.1 row addition to name its detection layer (STATIC, PROPERTY, MODEL, RUNTIME-ONLY) on the same PR. Commitment 14 is held by the host-tier table in `packages/core/wasm/README.md` plus the adopter checklist in `docs/wasm-adoption-guide.md`; the `detectBridge()` probe and `WasmBackendUnavailableError` structured-code fallback chain are the runtime mechanism, but the *commitment* — that no supported host is stranded — is held by review of the matrix as new browser versions land, not by a CI rule that would false-fire on every Caniuse table revision (see §17.6 for why this row is DESIGN-DISCIPLINE rather than MECHANICAL).

### 17.4 Why not mechanize the design-discipline rows

Three options sat in front of the team. **Mechanize all twelve** — rejected because a CI rule that flags "this PR did not update §3" produces false positives at every refactor. **Mechanize-or-strike** — rejected because the team's stated discipline on §3 going first, on §12.2 audits, on the §9.1 catalogue, on the §6 transitions, on the §16.4 enumerator fixtures-on-the-shelf, and on the new §9.1 row layer-assignment habit is real even when no test runs against it. **Mark explicitly** — what the team picked. The mark itself is the discipline.

**What the team rejected and why.** Reducing the commitments to the mechanizable subset would hand the discipline back to "it's in the back of someone's head." The twelve commitments hold because the team holds them, and the spec is the team's signed contract that they continue to.

### 17.5 Commitment 13 — the capability-cost residual amendment (#1005)

**Status:** added by #1005 after the May-2026 perf-wave (PR #1000 / #1001 / #1002) closed and the team-panel convergence (Beck/Metz on the cost-of-commit framing, Markbåge/Miller on the engine-on-engine methodology) signed the residual.

> **Status (v0.9.0) — pre-deprecation marker (#1158), amended by Phase G.1 (#1145).** The 3.0×-8.0× band below reflects the current TS engine's residual gap to MobX. **The pre-G.1 projection that the post-Rust-port band would narrow to 1.0×-4.0× is retired by the Phase G.1 measurement (`docs/epic-1133/G1-PERF-MEASUREMENT.md`).** The G.1 measurement showed (a) the bench harness today cannot exercise a real-Rust commit path on adopter workloads — `causl-wasm` and `causl-js` ratios cluster at 0.96×–1.17× on all six contract-bearing cells, within sampling noise — and (b) the JS↔WASM marshaling boundary cost in isolation (15.64 μs/op per F-marshal.6) is 78× the entire current TS-engine median on `equality-cutoff × 10000` (2.017 ms / 10k), so a hypothetical SSOT swap to a real-Rust marshaler would **widen** the `causl/mobx` band, not tighten it. The 3.0×-8.0× band text below remains the live SPEC requirement; the post-Rust forecast is **deferred to whatever a future boundary-architecture redesign delivers**. Adopter CI gates should continue to anchor on the 8.0× upper bound and not the speculative 1.0×-4.0× band that was forecast pre-measurement.

> **Trail addendum (epic #1493 phase C.6, option-c batched-commit boundary scaffolding, #1510).** The #1483 re-architecture decision selected option (c) (batched-commit boundary) as the v1.x ship; epic #1493 implemented it. The C.6 `op-rust-batch-boundary-{10,100,312,1000}` bench probe (`packages/bench/scripts/op-rust-batch-boundary.ts`) measured the batched boundary and **confirms — does not amend — this band.** Measured (5 trials × 200 samples): the FFI **crossing tax** amortises EXACTLY 1/N — **1564 / 156 / 50.1 / 15.6 ns/op at N=10/100/312/1000**, matching the option-c doc §1 arithmetic table (`docs/epic-1483/option-c-batched-boundary.md` §1) *exactly*, including crossing the #1484 §3 ≤50 ns boundary floor precisely at N≥312 (N=312 → 50.1 ns/op). This is structural, not merely empirical: C.1's `commit_batch` unit tests (N=1/10/100/312) plus the C.5 per-flush cross-backend determinism gate prove a single `commit_batch` envelope of N actions is byte-identical to N single `commit` envelopes, so the crossing count is provably 1/N. The JS-side marshal *work* is O(N) (N `BridgeCommitAction`s + N `Commit` projections; measured ~212→74 ns/op, NOT amortising) — expected and correct, the §1 doc never projected the `Vec<Action>` construction as amortising. **No SPEC amendment is required at Answer C** (recorded in full in the §17.6 C.7 trail): under option (c)'s pinned Answer C the JS engine remains SSOT for adopter workloads, so the 3.0×-8.0× residual band is **unchanged at v1.x** — option (c) moves only the *theoretical* boundary ceiling a future v2.x WASM-SSOT cutover would obtain, not the adopter-visible v1.x perf. **Option (c) delivers ZERO adopter perf at v1.x by design; the #1133 78× boundary-tax falsification is NOT refuted by this epic.** The probe numbers are MEASUREMENT confirming the scaffolding amortises as the arithmetic predicts — not a STOP-VERDICT (a "high" absolute tax is the expected, deferred-to-v2.x result; only a per-op cost that *failed* to amortise with N would have been a batch-path bug, and none was observed).

**Contract sentence.** On every contract-bearing benchmark cell — `equality-cutoff × 10000`, `equality-cutoff-fanout-10k × 10000`, `spreadsheet-100x100 × 10000` — `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0`. The band is anchored at the post-wave **6.4× residual** decomposed as **1.84× engine baseline × 3.5× replay-determinism contract premium**. The 1.84× factor is the only honest engine-on-engine microbench (`op-tx-set-isolated-1k` post-wave, after #1000's hasDependents fast-path skipped the staging+rollback round-trip on isolated inputs); the 3.5× factor is what causl pays for the four contract surfaces mobx does not ship: `commitLog` rebuild on every commit, `changedNodes` set construction for subscribers, GraphTime monotonicity stamping, and `readAt`/`snapshotAt` retention bookkeeping.

**The two bounds, separately.**

The **upper bound** (`causl_median ≤ mobx_median × 8.0`) is the regression gate. Pre-wave the same `equality-cutoff × 10000` cell ran at 1.94 ms vs mobx 0.215 ms ≈ 9× — the wave delivered a 24% drop (1.94 → 1.47 ms), pulling the residual to ≈6.4× and giving the 8× ceiling ≈25% headroom over the post-wave anchor. A future PR that erodes the wave gains and drives the cell back past 8× either re-introduces the per-write per-derived allocation seam #1000/#1001/#1002 closed, or invents a new one; either way the gate forces the conversation.

The **lower bound** (`causl_median ≥ mobx_median × 3.0`) is the capability-erosion gate. Eich/Horwat's framing of the residual: the ~0.9–1.1 ms causl pays beyond mobx on `equality-cutoff × 10000` is non-addressable from JS — string-keyed Map probes, full-call `Object.is`, frozen `Commit` allocation, and the GC pressure those produce together set a structural floor below which a JS engine that ships replay-determinism cannot go. A future PR that delivers a sub-3× ratio on a contract-bearing cell has either (a) shipped a real architectural breakthrough that deserves a SPEC §17 amendment of its own — promotion of the opt-in `@causljs/core/wasm` substrate (the Rust-backed engine of §17.6 commitment 14, in scaffolded form today at `tools/engine-rs-core/` plus the `engine-rs-bridge-{serde,gc}` cdylibs) to the default engine is the named candidate, and the full Rust engine port that promotion implies lives on the shelf as post-0.9.0 epic #1133 — or (b) silently retired one of the four contract surfaces (commitLog, changedNodes, GraphTime monotonicity, readAt/snapshotAt retention) by trading capability for speed. The 3× lower bound flips that trade-off into a visible failure rather than a silent ship.

**Methodology callouts (Markbåge).** Two cells in the wider engine-on-engine harness produce ratios that **are not** part of the residual calculation, and the band invariants intentionally exclude them: `op-tx-shadow-read-1k` reads ~11× because mobx returns the new value directly inside `runInAction` without a shadow-Map probe (`packages/bench/src/libraries/mobx.ts:1262-1283`), and `op-commit-rollback-1k` reads ~2.8× because mobx is not transactional — `runInAction` does not roll back on throw, so the comparator simulates a failed transaction with a second `runInAction` call (`packages/bench/src/libraries/mobx.ts:1218-1261`). Both are methodology asymmetries rooted in the engines' shipped capabilities, not in their inner-loop costs; folding them into the residual would produce a number the wave program could neither defend nor regress against.

**Why MECHANICAL.** The contract surface (commitLog, changedNodes, GraphTime monotonicity, readAt/snapshotAt) is observable from a property test: a commit log captured on one engine instance and replayed on a fresh instance must produce a byte-identical IR (`spec-17-capability-cost.property.test.ts` is the gate, drawing arbitrary input/derived graphs and asserting both atomicity-on-throw and replay-determinism on a canonical seed). The cost residual is observable from `report/fair-fight-results.json` (refreshed by `pnpm tolerant`). Both gates run on every PR; neither requires a review-policy escalation to fire. Commitment 13 is the only post-§16A row that ships fully MECHANICAL on first signature.

**Compatibility with §17.4.** The amendment does not weaken the §17.4 argument that not every commitment is mechanizable — it is a row whose gate happens to exist. Commitment 14 (added by #690 at §17.6) is DESIGN-DISCIPLINE for exactly the reason this paragraph forecast: the host-tier compatibility matrix is a discipline that gets re-validated when a browser ships a new WASM feature, and a CI rule for it would false-fire every time Caniuse refreshes — the discipline is real but the gate is the review. Commitment 13's gate is well-formed because the contract is byte-comparable and the residual is wall-clock; both reduce to a number, and a number reduces to a comparator. Commitment 14's gate is well-formed in a different way: the host-tier table reduces to a small finite enumeration (three substrate tiers + TS-engine fallback), and the team can review the enumeration on every WASM-touching PR cheaply.

### 17.6 Commitment 14 — host-tier substrate compatibility amendment (#690)

**Status:** added by #690 (this PR) as the final SPEC commitment of the WASM-backend EPIC #680. Lands alongside the adopter-facing documentation in `docs/wasm-adoption-guide.md` and the host-tier table in `packages/core/wasm/README.md`. Commitment 13's §17.5 paragraph forecast a DESIGN-DISCIPLINE commitment 14; this is that row.

**Contract sentence.** The opt-in `@causljs/core/wasm` substrate ships against three host-tier bridges plus a documented TS-engine fallback, and every supported host runs *at least one* tier. The matrix is the public contract — adopters read off whether their host gets the fastest path (`wasmgc-builtins`), the WasmGC-only path (`wasmgc-classic`), the universal-compat path (`serde-json`), or the documented JS-engine fallback through `WasmBackendUnavailableError`. No host is silently stranded.

**The three-tier host-substrate matrix.**

| Tier | Bridge id | Host floor | Bundle (Brotli) | Per-commit boundary cost | Promotes from |
| --- | --- | --- | --- | --- | --- |
| 1 | `wasmgc-builtins` | Chromium 131+ / Firefox 130+ / Node 22.6+ | ~45 KB | `externref` round-trip + `wasm:js-string` direct import; no UTF-8 copy on string-typed reads | (top tier) |
| 2 | `wasmgc-classic` | Safari 18.2+ / Firefox-flagged (any host with WasmGC `ref.null any` but no `wasm:js-string` import binding) | ~50 KB | `externref` round-trip + UTF-16 string round-trip | Tier 1 |
| 3 | `serde-json` | Universal — WebAssembly 1.0 baseline (Chrome 95+ / Firefox 102+ / Safari 16+ / Node 22.0+ / Cloudflare Workers / Deno 1.30+) | ~80 KB | `serde_json` serialise + parse per read | Tier 2 |
| Fallback | (TS engine) | Any host where `WebAssembly.Module` fails to instantiate (CSP `script-src` without `'wasm-unsafe-eval'`; embedded runtimes; `WebAssembly` undefined entirely) | 0 — already in the main bundle | n/a (no boundary) | Tier 3 (via `WasmBackendUnavailableError`) |

The bridge picker (`detectBridge()` in `packages/core/wasm/index.ts`) probes the host at module load and selects the highest tier the host actually supports; the loader does not auto-fall back to a lower tier without surfacing the choice through the `BridgeFeatures` shape on the returned backend (adopters who pin a specific bridge via `loadWasmBackend({ bridge: 'serde-json' })` opt out of the auto-walk and get a hard error if the pinned bridge does not match the host).

**Feature-detection checklist (the four probes the bridge picker runs).**

1. **`WebAssembly.Module` constructable.** If the host throws on a 12-byte canonical module, the loader throws `WasmBackendUnavailableError` (`code: 'CAUSL_WASM_UNAVAILABLE'`) and the JS-engine fallback is the adopter's responsibility (see §17.6 adopter pattern below).
2. **WasmGC support — `(ref null any)` parses.** Compile a tiny module that uses the `anyref` type; if compilation succeeds the host has at least Tier 2 (`wasmgc-classic`). Firefox/Safari/Chromium ship this gated behind the WasmGC default-on flags listed in the matrix above.
3. **`wasm:js-string` import binding.** Compile a module that declares `(import "wasm:js-string" "length" ...)`; if the host accepts the import the loader promotes to Tier 1 (`wasmgc-builtins`). `wasm-bindgen` does not generate this import surface — the GC bridge crate hand-writes the `extern "C"` block per #692.
4. **`tail-call` / `relaxed-simd` future seams.** Reserved — both proposals are Phase 4 candidates as of 2026. The bridge picker exposes them through `BridgeFeatures.tailCall` and `BridgeFeatures.relaxedSimd` as `false` today; when a future bridge variant uses them, the picker promotes Tier 1 to a `wasmgc-builtins-tc` sub-tier without breaking the matrix shape.

**Bundle-size impact per tier (the size-limit ceiling table).**

| Surface | Cost | Ceiling | Notes |
| --- | --- | --- | --- |
| `@causljs/core` main bundle | unchanged from pre-EPIC | 20 KB (§14.2) | Zero WASM imports, zero loader code — adopters who never call `loadWasmBackend()` pay nothing |
| `@causljs/core/wasm` entry stub | 630 B Brotli | 3 KB ceiling (per #684 size-limit) | Public API surface: `loadWasmBackend`, `detectBridge`, `loadStreaming`, `wasmUrlFor`, `WasmBackendUnavailableError`, `BridgeFeatures` |
| `wasm-pkg/gc-builtins/` (Tier 1 artefact) | ~110 KB raw / ~45 KB Brotli | 60 KB Brotli ceiling | Includes the JS bindings glue produced by `wasm-pack` |
| `wasm-pkg/gc-classic/` (Tier 2 artefact) | ~120 KB raw / ~50 KB Brotli | 60 KB Brotli ceiling | UTF-16 path; ships separately so Tier 1 hosts do not pay the classic-strings cost |
| `wasm-pkg/serde/` (Tier 3 artefact) | ~200 KB raw / ~80 KB Brotli | 100 KB Brotli ceiling | The `serde_json` dependency is the bulk; non-negotiable for the universal fallback |

**Current state (as of v0.9.0) — serde bridge raw-byte ceiling divergence, documented per Option C (#1150 CLOSED 2026-05-11 by PR #1161; post-STOP-VERDICT context added 2026-05-13).** The Tier 3 (`wasm-pkg/serde/`) artefact today ships at **213 KB raw / 66 KB Brotli**. Brotli is comfortably under the 80 KB canonical ceiling (14 KB headroom); raw is over the 200 KB canonical ceiling by 13 KB. The 200 KB raw / 80 KB Brotli row above remains the **target** ceiling — the SPEC does not relax the contract. The root `package.json` size-limit cell `@causljs/core wasm bridge — serde-json (raw)` was ratcheted by PR #1112 to **230 KB** to absorb the measurement (the SPEC §17.6 commitment-14 canonical raw ceiling stays at 200 KB). The Brotli ceiling is enforced post-build by `pnpm wasm:build` rather than via a size-limit cell (per the `//size-limit-wasm` comment in root `package.json` and `packages/core/wasm-pkg/README.md`); the post-build serde Brotli ceiling is documented as **70 KB** in `packages/core/wasm-pkg/README.md`, below the canonical 80 KB Brotli target by 10 KB of headroom. The bundle-size CI gate therefore passes against the relaxed cells while the SPEC §17.6 row continues to document 200/80 as the target. This is recorded as a documented divergence per Option C of #1150, not a silent relaxation. **Resolution path (revised post-STOP-VERDICT on epic #1133, 2026-05-13).** Option A (direct `wasm-opt` invocation with the feature flags `wasm-pack` rejects today, per PR #1112's design discussion at #1085) was the originally-planned closure path and was scoped to land as part of Phase A of the Rust engine port (epic #1133). The 2026-05-13 A.1 perf-floor probe fired the kill gate by 35× (STOP-VERDICT on #1133, comment 4442925169), so Phase A is not currently scheduled and Option A inherits that deferral. Re-tightening to ≤200 KB raw now defers to whatever the post-STOP path delivers — DROP (the callout stays a permanent SPEC fixture), PIVOT to a new boundary architecture (the budget gets re-prosecuted from scratch against the new design), or DEFER to the next 6-month #1133 cadence (Option A becomes re-claimable). The §17.6 row's 200/80 contract has held in the SPEC throughout; the §19 amendment trail row for #1150 records the Option C disposition and the post-STOP context. Adopters who write CI gates directly against the §17.6 row (rather than against the size-limit cells) should treat 200/80 as the long-run target and the 230/70 cells as the operational today-ceiling; the live artefact may exceed the raw cap by up to ~30 KB while remaining under the Brotli cap.

The three bridge artefacts are **mutually exclusive** at runtime — a given graph instance loads exactly one tier — and they are **lazily fetched**: an adopter on a Tier 1 host never downloads the Tier 2 or Tier 3 `.wasm` bytes. Bundle-budget enforcement is per-artefact in `.size-limit.json` (lands with #689); the WASM tier-matrix CI gate fails the PR if any artefact exceeds its ceiling.

**The fall-through fallback (why no host is stranded).**

Hosts that fail probe 1 — `WebAssembly` undefined, CSP `script-src` rejecting `'wasm-unsafe-eval'`, embedded runtimes with WASM stripped — get `WasmBackendUnavailableError` from `loadWasmBackend()`. The error carries a structured `code` field (`CAUSL_WASM_NOT_BUILT`, `CAUSL_WASM_UNAVAILABLE`, `CAUSL_WASM_CSP_BLOCKED`, `CAUSL_WASM_BRIDGE_UNAVAILABLE`) so adopters branch in a single `try`/`catch` block at the construction seam:

```ts
import { createCausl } from '@causljs/core'
import { loadWasmBackend, WasmBackendUnavailableError } from '@causljs/core/wasm'

const graph = await createCausl({
  backend: await tryWasmBackend(),
})

async function tryWasmBackend() {
  try {
    return await loadWasmBackend()
  } catch (err) {
    if (err instanceof WasmBackendUnavailableError) return 'js'
    throw err
  }
}
```

The TS engine is the unconditional floor: any host that runs JavaScript runs causl. The WASM substrate is *acceleration*, not *substitution* — commitment 14 names this contract so a future PR that makes the WASM path required for some feature has to amend §17.6 explicitly rather than slide it past the gate.

**Why DESIGN-DISCIPLINE.** The host-tier matrix is a finite enumeration whose entries change on a calendar driven by browser release notes, not by causl's CI. A CI rule that asserted "this PR did not update the Safari floor" would false-fire on every PR that did not touch the WASM surface; the discipline is to *re-validate the matrix when the WASM surface changes*, not when an unrelated PR lands. Concretely: every PR that touches `packages/core/wasm/**`, `tools/engine-rs-*/**`, or the bridge-feature probe in `detectBridge()` must walk the four probes above against the current matrix and either confirm the row is still accurate or update it in the same PR. The reviewer's checklist is the gate; the matrix is the artefact.

**Compatibility with §17.4 / §17.5.** §17.4 frames commitments 1, 2, 5, 7, 11, 12 as DESIGN-DISCIPLINE because a CI rule for them produces false positives at every refactor. Commitment 14 sits in the same equivalence class — the matrix updates when WASM features ship, not when adopter code shifts — so the §17.4 argument extends naturally. §17.5 forecast this exact row in its closing paragraph; §17.6 is the deliberate fulfilment of that forecast, not an opportunistic addition.

**Migration.** None — additive. Adopters who never import `@causljs/core/wasm` see zero behavioural or bundle change. Adopters who do import the entry point gain the structured-error fallback contract above and the documented tier promotion behaviour. The pre-§17.6 behaviour (loader threw `WasmBackendUnavailableError` until the bridge crates landed) is preserved by construction; the loader skeleton in #684 honoured the contract from the start, and the bridge crates have since landed — the `serde-json` bridge wired to `transition_phased` per #1062 / PR #1087, the WasmGC bridge wired with the full `wasm:js-string` extern surface per #1064 / PR #1086, and EPIC #680's Phase-1 closeout per #1093. With both bridges live, `loadWasmBackend()` resolves to a working Tier 1/2/3 backend on supported hosts and falls through to `WasmBackendUnavailableError` only on the documented JS-engine fallback path. **Current state (as of v0.9.0).** The `WasmBackend` returned by `loadWasmBackend()` is a TS engine wrapped in the FFI shape, not a Rust engine: the bridge surface, the cross-bridge byte-identity gate (#1071), and the host-tier contract above are all live, but the perf characteristics are equivalent to `backend: 'js'`. The "Phase-1 wrapper-not-Rust" disclosure callout in `packages/core/wasm/README.md` (above the host-tier table per #1127) is the load-bearing adopter warning; the structural Rust perf win is gated on the post-0.9.0 "real engine" track in epic #1133 (full Rust engine port) and the type-shape prep already merged in #1077 / #1078 / #1079 / #1080 / #1151. **Phase G.1 measurement (#1145, post-F-marshal):** the JS↔WASM marshaling boundary cost has now been measured against the production `serde-json` bridge artefact at `packages/core/wasm-pkg/serde-bundler/engine_rs_bg.wasm`. Three companion probes pin the cost at three points on the work axis: `op-rust-bridge-floor-1k` measures the FFI boundary alone at **1.687 μs / round-trip** (`floor_only_transition`, no engine work), `op-wasm-boundary-1k` measures boundary + `transition_phased(Action::Tick)` at **2.575 μs / round-trip** (minimal engine work), and the F-marshal.6 probe (`packages/bench/test/wasm-marshaler-boundary-tax.test.ts`) measures the full bidirectional commit envelope at **15.64 μs / commit** (PR #1478 closeout record). Projected per 10k commits, the marshal cost is **156.4 ms** — 78× the entire current TS-engine `equality-cutoff × 10000` median of 2.017 ms. The host-tier matrix above is unchanged by this measurement; what is anchored is the arithmetic floor a future SSOT swap from "TS-engine SSOT, marshaler shadow" to "real-Rust marshaler SSOT" would pay before counting any engine work. See `docs/epic-1133/G1-PERF-MEASUREMENT.md` for the full per-cell measurement and the arithmetic verdict.

**Option (c) batched-commit boundary scaffolding — NO §17.6 amendment required at Answer C (epic #1493 phase C.7, #1513).** The #1483 re-architecture decision selected option (c) (batched-commit boundary, `docs/epic-1483/option-c-batched-boundary.md`) as the v1.x ship; epic #1493 implemented it across phases C.1–C.7. **This callout records that option (c) requires no SPEC amendment — neither at §17.6 nor at §3, §5.1, §15.1, or §15.3 — and explains why.** Under option (c)'s pinned **Answer C** (§2.1 of the option-c doc): `commit()` returns a frozen `Commit` **synchronously** by routing Phases A–H through the JS engine, which remains the **single source of truth** for all adopter workloads (`read`/`subscribe`/`Commit`-return/`snapshot`); the WASM bridge runs in a *buffered shadow* mode identical to today's F-marshal.5 wiring, except the shadow flush is deferred from per-commit to per-batch-boundary. The only thing that batches is the **wire crossing**, not the commit semantics. Concretely: (1) **§3 Theorem 4 / monotonicity** — `graph.now` advances by exactly one tick per `commit()`, always (the JS engine advances it synchronously per commit; the batch's `Vec<Action>` carries N `CommitRecord` entries with `time = now+1 … now+N` exactly as N un-batched envelopes would — C.1 unit tests + C.5 per-flush gate prove this byte-for-byte). (2) **§3 Theorem 2 uninterruptibility** — preserved: each Phase E publish → Phase G dispatch runs JS-side on a single tick; the batched `commit_batch` envelope at flush time is one synchronous FFI call. (3) **§5.1 Phase A–H + Amendment 4 (Phase G IndexMap container)** — Phase A–H runs per-commit in the JS engine; Phase G fires JS-side per commit before any flush, so the subscriber-container invariant is untouched. (4) **§15.1 byte-identity** — preserved at the flush boundary by construction: a single `Vec<Action>` of N actions produces the same end-state and the same N `CommitRecord`s as N single-action envelopes (the C.5 cross-backend determinism gate was adjusted to fire **per-flush** instead of per-commit on the WASM mirror — a one-PR test-harness change, *not* a SPEC amendment, per option-c doc §4.2; the 1000-trial × 0-byte-difference discipline carries forward). (5) **§15.3 subscriber-fire** — per-commit synchronous, **unchanged verbatim**: option (c) pins choice (i) (per-commit fire, mid-batch); end-of-batch coalescing would have required two SPEC amendments (§3 + §8) and is explicitly rejected (option-c doc §4.2). (6) **§17.6 host-tier matrix** — inherited verbatim: option (c) adds a `commit_batch` peer extern on both bridge crates and a per-graph `createCausl({ batchedFlush })` opt-in; no host is stranded, no bundle ceiling moves, no `loadWasmBackend()` / `detectBridge()` change. **The honest framing (option-c doc §2.1 / §9.1):** under Answer C, option (c) delivers **ZERO adopter-visible perf at v1.x** — the JS engine remains SSOT, so the §17.5 3.0×-8.0× capability-cost residual band is **unchanged at v1.x** (the C.6 `op-rust-batch-boundary` probe confirmed the FFI crossing tax amortises exactly 1/N per the option-c doc §1 arithmetic — 1564/156/50.1/15.6 ns/op at N=10/100/312/1000, crossing the #1484 §3 ≤50 ns floor precisely at N≥312 — but this is the *theoretical* ceiling a future **v2.x WASM-SSOT cutover** would obtain, not adopter-visible v1.x perf). Option (c) is the *enabling scaffolding* for that future cutover: it lays the wire-amortisation infrastructure so a later SSOT swap to WASM does not re-pay the per-commit boundary tax. **The #1133 78× boundary-tax falsification is NOT refuted by epic #1493** — it is preserved as the standing record; option (c) defers the boundary problem's *resolution* to a future epic that has not yet been scoped. Default `afterN=1` is byte-identical to dev `b15069fa` (the load-bearing C.4 acceptance test proves default-config `commit`/`read`/`subscribe`/`exportModel`/`now` byte-identical to a bare pure-TS graph); the opt-in is additive, per-graph, zero-codemod, zero-deprecation. Adopter-facing documentation lands in `docs/wasm-adoption-guide.md` (the batched-flush opt-in section, carrying the explicit "no v1.x perf change; this is scaffolding for a future v2.x cutover" framing). See the §19 trail row for the epic #1493 disposition.

---

## 18. Final positioning

I am not building Redux + MobX + spreadsheet + statechart + MVCC + GraphQL all at once. The previous draft listed eleven inspirations and stacked them with plus signs, as if a coherent system emerged from the union of features whose authors disagreed with each other. This rewrite is that draft cut roughly in half and reorganised around what a single small team can defend on every PR review:

- A **denotational definition** of what a derived value means (§3), written down before the code that computes one.
- A **single composite statechart** (§6) for every lifecycle in the system — engine, resource fleet, conflict registry, controller — drawn before the conflict and resource code is written.
- **Two primitives** (§4) — `InputNode` and `DerivedNode` — plus one operation (§5) — `commit` — closed at the wire boundary as `kind: 'input' | 'derived'`.
- A **strict separation** (§7) between the user's information model, the editor's controller state, and the engine's substrate, mechanically enforced by §17 commitment 3.
- An **MVU-shaped application surface** (§8) with two canonical hooks and three extension hooks named explicitly.
- **Discriminated unions everywhere optional fields previously hid state machines** (§9), with exhaustiveness via `assertNever` mechanically enforced (§17 commitment 4).
- **Property-based fuzz** (§15) as the race-detection layer for everything the type system and API shape do not catch, with a 1000-trial floor enforced by lint.
- A **Rust-backed static IR linter** (§16) that lifts the §9.1 rows it can decide statically into pre-runtime CI gates, plus a **race-detection CI tier contract** (§16A) that classifies every §9.1 row by detection layer (STATIC / PROPERTY / MODEL / RUNTIME-ONLY), names the four new lint passes for v1.x, and pre-writes the three-tier hierarchy (PR / labelled-or-main / nightly) and the bounded-enumerator design (§16.4 promoted to deferred PLANNED) so the v1.x epic does not start green-field.
- **Fourteen commitments** (§17), the original eight plus the four §16A race-detection rows plus the post-wave capability-cost residual amended in by #1005 plus the host-tier substrate-compatibility row amended in by #690, each marked MECHANICAL or DESIGN-DISCIPLINE.

The §0 promise was a single-digit canonical surface, and the rewrite keeps the framing honest: the canonical seven (§12.1) plus a curated second tier (§12.2), audited quarterly. **Nineteen public Graph methods and getters today** — seven canonical, twelve second-tier — with a named promotion / demotion bar between §12.2 and §12.3 and a parking lot at §12.4 that stays empty until the next public-surface proposal lands.

The arc from §0 to §18 is the spec's own contract. §0 names what the previous draft tried to be and why that was the bug. §3 writes down the meaning. §4–§13 are implementation strategy for evaluating §3 efficiently while keeping the lifecycles, the layering, the surface, and the deferrals honest. §14–§16 are the gates that keep the implementation from drifting from the meaning; §16A is how those gates compose into a CI tier. §17 is the team's signature on the twelve commitments that hold the rest in place. §18 is the arc closed.

If the twelve commitments hold, the system has a chance to be small enough to teach, formal enough to verify, and live enough to be worth the comparison to spreadsheets that the previous spec made and could not back. If they do not hold, this becomes another state library nobody finishes reading. Everything else has to earn its place by being asked for, twice, by people who have already used the part the team shipped. That is what the team is committing to, and the spec is where that commitment is written down.

---

## 19. Amendment trail (perf workstream — May 2026)

The May 2026 perf workstream produced five SPEC amendments (the original four plus the post-wave §17 commitment-13 amendment landed by #1005); the parallel WASM-backend EPIC #680 produced one more (§17.6's commitment 14, landed by #690); the 0.9.0-readiness sweep adds a §15.1 contract-clarification amendment (#1124) for the Markbåge/Miller H1 risk surfaced by the WASM adopter audit, plus the §17.6 current-state callout (#1150) recording the 213 KB serde-bridge raw-byte divergence; the post-STOP-VERDICT documentation pass on epic #1133 adds two FFI-boundary amendments (#1333) — §3 Theorem 2 uninterruptibility and §5.1 Phase G subscriber container pin — capturing invariants any future native backend (Rust, C++, FFI-to-anything) must honor, landed standalone-value after the A.1 perf-floor probe fired the kill gate by 35× and the engine port was frozen. Each is recorded inline at its host section (§3, §5.1, §9.1, §11.1, §15.1, §16.6, §17.5, §17.6); this trail is the one-page reference. Amendments are independent but compose: §5.1 Amendment 1 plus §16.6 Amendment 2 together make `cap=0` plus precondition-gating the new fast path for adopters that do not consume commit history; §17.5 frames the residual the wave program could honestly defend after that fast path landed; §17.6 names the architectural escape valve §17.5's lower-bound clause flagged — promotion of the opt-in `@causljs/core/wasm` substrate (Rust-backed per the scaffolded `tools/engine-rs-core/` crate) to the default engine is the named candidate, the full Rust engine port that promotion implies lives on the shelf as post-0.9.0 epic #1133, and §17.6's host-tier contract is the bar that promotion would have to clear.

### §5.1 Amendment 1 — phase preconditions (#715, PR #730, MERGED)

**Contract sentence:** phases F / F.4 / F.5 / F.6 / G / H run iff their preconditions hold; the phase table annotates each gated phase with a bold **Runs iff …** clause naming the predicate (`commitHistoryCap > 0`, `commitMetadataIds.size > 0`, `changed.size > 0`, `commitObservers.size > 0`).

The §3 atomicity contract is unchanged. Phases enumerate possible engine behaviour; preconditions describe when work is materially observable. Skipping a phase whose dispatch set is empty is observable-equivalent to running it.

**Migration:** none. Existing call sites with at least one observer / one commit-metadata derived / a non-zero `commitHistoryCap` see identical behaviour.

### §9.1 amendment — `strictCycles` deprecated, first-commit Kahn (#670 / #705, MERGED)

**Status:** SPEC text edited inline — §9.1 row 8 names `strictCycles` as a no-op since #670/#705, and §9.1 Amendment 1 documents the registration-time DFS retirement (the recursive registration walker overflowed V8 at `linear-chain × 10000` pre-#705). Both halves landed via PR #773.

**Contract sentence:** `strictCycles` is preserved on `CreateCauslOptions` for backward compatibility but is a no-op as of #670 + #705. The registration-time DFS gate was removed; Phase D's existing Kahn topological sort was augmented with path recovery to surface every cycle the old gate caught at the first commit that closes the cycle. §9.1 row 8's "Detected at the first commit that closes the cycle, with a structured `CycleError`" promise is unchanged; the implementation seam moved from registration to Phase D.

**Migration:** adopters who relied on registration-time `CycleError` see the throw one tick later. `strictCycles: true` is a no-op for one major version with a deprecation warning, then removed. See `docs/migration/cycle-detection-deferred.md`.

### §11.1 amendment — `subscribeReads` engine-tracked deps (#701, MERGED)

**Status:** SPEC text edited inline — §11.1 carries the amended paragraph (`subscribeReads` named alongside the five established inspection primitives) and §12.2 lists the surface row. Landed via PR #776.

**Contract sentence:** `subscribeReads(observer, projection)` is the engine-tracked-deps variant of `subscribeCommits`. The engine runs `projection()` once at subscribe time, captures its read-set via the same `Compute` tracked-`get` Phase D uses, and indexes the observer by the inferred set. The observer fires iff `commit.changedNodes` intersects the inferred set; conditional reads that grow the dep set trigger automatic re-indexing. `subscribeCommits(observer)` retains its "fires every commit" semantics; the two are observationally equivalent for any projection whose downstream value is `Object.is`-equal across runs where `changedNodes` does not intersect its dep set.

**Migration:** none — additive. The React adapter (`useCausl`, #677) routes through the new path automatically; explicit `subscribeCommits` callers are unchanged.

### §16.6 Amendment 2 — default `commitHistoryCap = 0` (#716, MERGED, semver-major)

**Status:** SPEC text edited inline — `§5.1 Amendment 2` records the flip; the engine's `DEFAULT_COMMIT_HISTORY_CAP` is 0. Landed via PR #778, paired with §5.1 Amendment 1 (#715) so the cap=0 path is observably equivalent to a cap=1000 path with no commitLog consumer.

**Contract sentence:** the default `commitHistoryCap` flipped from 1000 to 0 (semver-major). Adopters who use `readAt` / `snapshotAt` / `commitLog` / `subscribeCommits` opt in via `createCausl({ commitHistoryCap: 1000 })`. Pairs with §5.1 Amendment 1: with `cap=0` and no consumer registered, phases F / F.4 / F.6 are dead and skipped — the fast path for ~90% of adopters.

**Migration:** explicit. `createCausl({ commitHistoryCap: 1000 })` restores the prior default. A two-release deprecation cycle preceded the flip — minor N warned adopters that omitted `commitHistoryCap` while using retention APIs; minor N+1 flipped the default and turned the warning into an error; minor N+2 removed the warning machinery.

### §5.1 Amendment 3 — iterative registration walker (#956, MERGED)

**Contract sentence:** **no contract change**. The registration-time eager evaluator (`graph.derived(...)`) walks the dep graph through `computeDerivedIterative`'s explicit-stack driver rather than recursive `computeDerived` calls. Every SPEC §3 atomicity / §5.1 phase invariant is preserved byte-identically (PR #946 attempted a lazy-default trial; it broke 28 §3 / §5.1 invariants and was reverted — iterative-but-still-eager is the design point that lifts the depth ceiling without touching contracts).

**Implementation detail:** the depth ceiling on linear-chain registration lifts past 12k on Node 22+ (pre-#956 the recursive walker overflowed the V8 stack at depth ~10k, gated by PR #943's typed `DerivedRegistrationStackOverflowError`). The typed error remains in the engine as defense-in-depth for residual recursion the audit might have missed (a user `derived` body that itself recurses outside the tracker, etc.). The bench's comparator-symmetric skip-gate (`RecursiveEvalStackOverflowError` for `linear-chain × scale > 1000`) was retired post-#956 because the engine no longer overflows on the canonical workload; jotai #922 / mobx #798 / redux #926 still skip the same cell because their walkers stayed recursive.

**Migration:** none.

### §17 Amendment — commitment 13, the capability-cost residual (#1005)

**Contract sentence:** added inline at §17.1 (commitment 13) and elaborated at §17.5. On contract-bearing cells (`equality-cutoff × 10000`, `equality-cutoff-fanout-10k × 10000`, `spreadsheet-100x100 × 10000`) `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0`. The band decomposes as `1.84× engine baseline × 3.5× replay-determinism contract premium` post-wave (PR #1000 / #1001 / #1002).

**Evidence:** post-wave team-panel convergence (Beck/Metz + Markbåge/Miller). `equality-cutoff × 10000` dropped from 1.94 ms to 1.47 ms (24%); mobx gap pulled from 9× to 6.4×. The 1.84× engine baseline is `op-tx-set-isolated-1k` post-wave; the 3.5× contract premium is what causl pays for `commitLog` / `changedNodes` / GraphTime monotonicity / `readAt`/`snapshotAt` retention. Methodology asymmetries (`op-tx-shadow-read-1k` 11×, `op-commit-rollback-1k` 2.8×) are excluded per `packages/bench/src/libraries/mobx.ts:1218-1283`.

**Migration:** none — additive contract-currency commitment. Existing `pnpm bench:check-hypotheses` runs gain the median-band invariant (`MEDIAN_BAND_INVARIANTS` in `packages/bench/src/hypotheses/causl-hypotheses.ts`); existing property suite gains `spec-17-capability-cost.property.test.ts` enrolling at the §15.2 1000-trial floor.

### §17 Amendment — commitment 14, host-tier substrate compatibility (#690)

**Contract sentence:** added inline at §17.1 (commitment 14) and elaborated at §17.6. The opt-in `@causljs/core/wasm` substrate ships against three host-tier bridges (`wasmgc-builtins`, `wasmgc-classic`, `serde-json`) plus a documented TS-engine fallback through `WasmBackendUnavailableError`. The matrix is the public contract: Chromium 131+ / Firefox 130+ / Node 22.6+ get Tier 1; Safari 18.2+ and any host with WasmGC but no `wasm:js-string` import binding get Tier 2; the universal WebAssembly 1.0 baseline (Chrome 95+ / Firefox 102+ / Safari 16+ / Node 22.0+ / Cloudflare Workers / Deno 1.30+) gets Tier 3; hosts that fail `WebAssembly` instantiation (CSP without `'wasm-unsafe-eval'`; embedded runtimes) get the JS-engine fallback. No supported host is silently stranded.

**Evidence:** the host-tier table aligns with the EPIC #680 design (rows 119–120 of the EPIC body), confirmed against the WasmGC default-on dates per browser (Chromium 119 Oct 2023; Firefox 120 Nov 2023; Safari 18.2 Dec 2024) and the JS String Builtins default-on dates (Chrome 131 late 2024; Firefox 130+; Node 22.6+). Bundle-size ceilings (~45 KB / ~50 KB / ~80 KB Brotli per tier) align with the dual-artefact GC bridge analysis in EPIC #680 and the size-limit ceiling already pinned for `@causljs/core/wasm` (630 B Brotli main + 3 KB ceiling, per PR #1031).

**Why DESIGN-DISCIPLINE.** §17.5's closing paragraph forecast exactly this row: "A future commitment 14 might be DESIGN-DISCIPLINE for the same reason commitments 1, 2, 5, 7, 11, 12 are: the discipline is real but a CI rule for it would produce false positives at every refactor." The host-tier matrix updates on the browser-release calendar, not on causl's PR cycle; a CI rule asserting matrix freshness would false-fire on every unrelated PR. The discipline is to re-validate the matrix on every PR that touches `packages/core/wasm/**`, `tools/engine-rs-*/**`, or `detectBridge()` — held by review, not by a gate.

**Migration:** none — additive. Adopters who never import `@causljs/core/wasm` see zero behavioural or bundle change; adopters who do import the entry point already received the structured-error fallback contract from PR #1031's loader skeleton, and §17.6 makes that contract part of the SPEC commitment surface rather than an implementation detail.

### §15.1 Amendment — `graph.read(node)` reference identity is not contractually guaranteed (#1124)

**Contract sentence:** added inline at §15.1. `graph.read(node)` does not contractually return the same JavaScript reference across calls. Reference identity is an implementation detail that may break when migrating between backends (TS → WASM); adopters who depend on identity for memoisation must memoise on `commit.time` or the per-node version counter exposed by `EngineTelemetry`, not on the read return reference. Value identity at a fixed `GraphTime` is preserved; reference identity across commits is backend-dependent.

**Evidence:** the Markbåge/Miller ship-verdict panel surfaced H1 from the WASM adopter audit (`docs/wasm-backend-adopter-audit.md`, PR #1021) as the load-bearing pre-Rust-swap risk. As of v0.9.0, `WasmBackend` is a TS engine wrapped in the FFI shape (per the §17.6 current-state callout and the `packages/core/wasm/README.md` "Phase-1 wrapper-not-Rust" disclosure landed by #1127), so `graph.read(node)` returns identical references trivially today; the day the engine inside the bridges becomes the real Rust kernel (post-0.9.0 epic #1133), `read()` returns a fresh object per call as the value crosses the FFI boundary. Every adopter who `React.memo`'d on the read reference would re-render every commit silently after that engine swap. The amendment removes the de-facto reference-identity from the contract surface ahead of the swap, and points adopters at `commit.time` (or `EngineTelemetry`'s per-node version counter) as the stable memoisation key. The property test `packages/core/test/properties/read-no-identity-contract.property.test.ts` enrols at the §15.2 1000-trial floor with a custom `BackendEngine` wrapper that returns fresh deep-copies on every `read()`; the existing 715-test suite remains green, demonstrating that no internal engine code accidentally relies on identity.

**Migration:** none — clarification of an always-implied contract. Adopters who never memoised on the read return reference see zero behavioural change. Adopters who did receive an upgrade-time warning via the §17.6 adopter checklist plus the `docs/wasm-adoption-guide.md` H1 section's right-vs-wrong memoisation example; the SPEC §15.1 amendment makes the contract explicit rather than implied, so future audits surface this hazard before the Rust-swap boundary rather than after it.

### §17.6 Amendment — serde bridge raw-byte ceiling current-state divergence (#1150, PR #1161, MERGED 2026-05-11; trail row added by this PR 2026-05-13)

**Status:** SPEC text edited inline at §17.6 by PR #1161 (Option C disposition of #1150) — the bundle-size table's 200 KB raw / 80 KB Brotli row for `wasm-pkg/serde/` is preserved as the **target** ceiling and a "Current state (as of v0.9.0)" callout records the live divergence. This §19 trail row was added by the post-STOP-VERDICT documentation pass on 2026-05-13 so the §19 reference page reflects the amendment that §19's intro paragraph already names (the previous draft cited #1150 in the intro narrative but never added the dedicated row).

**Contract sentence:** the §17.6 commitment-14 row's 200 KB raw / 80 KB Brotli ceiling for the Tier 3 (`wasm-pkg/serde/`) artefact is **not** relaxed. The current-state callout immediately under the table records: the v0.9.0 artefact ships at **213 KB raw / 66 KB Brotli** (Brotli 14 KB under the canonical 80 KB cap; raw 13 KB over the canonical 200 KB cap); the root `package.json` size-limit cell `@causljs/core wasm bridge — serde-json (raw)` is set to **230 KB** (ratcheted by PR #1112) so the bundle-size CI gate absorbs the measurement without false-firing on the documented gap; the Brotli post-build ceiling for the serde bridge is documented at **70 KB** in `packages/core/wasm-pkg/README.md` (enforced by `pnpm wasm:build`, not by a size-limit cell — the `//size-limit-wasm` comment in root `package.json` names that boundary). The divergence is recorded per Option C of #1150 (document the gap rather than silently exceed the SPEC).

**Evidence:** the Eich/Horwat panel review of epic #1133 surfaced the gap during the Phase A audit — adopters writing CI gates against the SPEC commitment-14 row see 200/80 while the live artefact is 213/66. PR #1112's design discussion (#1085) identified direct `wasm-opt` invocation as the structural fix that closes the raw-byte gap; the SPEC-side disposition was filed as #1150 with three options enumerated (A: tighten via `wasm-opt` direct invocation — multi-week, blocked on the Rust engine port; B: relax the SPEC ceiling text — discards the long-run target; C: document the divergence in §17.6, keep the 200/80 row intact, plan the re-tightening). Option C is the disposition this amendment implements.

**Why post-STOP-VERDICT context matters.** The 2026-05-13 STOP-VERDICT on epic #1133 (A.1 perf-floor probe fired the kill gate by 35× — see `docs/epic-1133/HANDOFF.md` and the STOP comment on #1133 at comment 4442925169) means Option A (`wasm-opt` direct invocation as part of Phase A Rust engine port) is **not currently scheduled**. The re-tightening path now defers to whatever the post-STOP path delivers — DROP (the bridge stays at 213 KB indefinitely; the §17.6 current-state callout becomes a permanent SPEC fixture rather than a transitional one), PIVOT to a fundamentally different boundary (a new bridge architecture re-prosecutes the raw-byte budget from scratch), or DEFER (the next 6-month #1133 cadence revisits Phase A and Option A becomes re-claimable). The current-state callout is written to be honest in all three outcomes: it does not promise the gap closes by date X, it names the gating decision (epic #1133's GO/NO-GO/PIVOT verdict) as the trigger.

**Migration:** none — documentation-only amendment. Adopters whose CI gates read the SPEC §17.6 row (200/80) and apply it directly to the live artefact already saw a false failure pre-amendment; the current-state callout names the discrepancy so those adopters can branch — either gate at 230/70 (matching the root `package.json` cells, the operational ceiling today) or keep gating at 200/80 and accept that real builds will fail until the post-STOP-VERDICT path lands the re-tightening. The SPEC contract surface is the 200/80 row; the live ceiling is the 230/70 cell. The amendment makes both visible.

### §3 Amendment — Theorem 2 uninterruptibility (FFI-boundary contract) (#1333, 2026-05-13)

**Status:** SPEC text edited inline at §3 immediately under Theorem 2. Landed post-STOP-VERDICT on epic #1133 (see `docs/epic-1133/HANDOFF.md` and STOP comment on #1133 at comment 4442925169).

**Contract sentence:** when the engine runs outside the JS event loop (e.g. inside a WebAssembly linear-memory backend), the marshal of a `Commit` envelope across the host boundary MUST be atomic with respect to JS-observable scheduling. No microtask, `requestAnimationFrame` callback, `MessageChannel` callback, or other JS-observable continuation may run between the engine-side Phase E publish (`Commit` envelope sealed in engine memory) and the host-side Phase G dispatch (subscriber callbacks fired in the host language). Theorem 2's "single-tick" proof structure assumes single-threaded JS evaluation; an engine that crosses an FFI boundary must enforce this invariant explicitly. The invariant applies to any non-JS backend whether or not the engine port currently targets one.

**Evidence:** Engine-semantics cluster review on epic #1133 (Harel / Elliott / Kay / Reenskaug / Czaplicki) — the TS engine's structural proof of Theorem 2 ("Phase D evaluates BEFORE Phase E publishes the Commit, single-threaded JS event loop") does not survive crossing an FFI bridge unless a new invariant pins the marshal as uninterruptible end-to-end. The amendment was originally framed as a Phase A precondition for the engine port; with the 2026-05-13 STOP-VERDICT (A.1 perf-floor probe fired the kill gate by 35×) the port is frozen, but the contract retains standalone value for any future backend attempt (Rust, C++, FFI-to-anything).

**Why now post-STOP-VERDICT.** Documenting the invariant ahead of any future port attempt is cheaper than retro-fitting it once a native backend has shipped non-conformant behaviour. The current TS engine satisfies the invariant trivially by running single-threaded on the JS event loop; the amendment is observation-equivalent today and future-proofs the SPEC against any post-STOP path (DROP / PIVOT / DEFER per the 2026-05-13 verdict).

**Migration:** none — clarification of a contract any non-JS backend must satisfy. No engine source change; no test change (the TS engine already conforms by virtue of single-threaded JS evaluation).

### §5.1 Amendment 4 — Phase G subscriber container pin (FFI-boundary contract) (#1333, 2026-05-13)

**Status:** SPEC text edited inline at §5.1 immediately after the phase table (alongside §5.1 Amendments 1–3). Landed post-STOP-VERDICT on epic #1133 (see `docs/epic-1133/HANDOFF.md` and STOP comment on #1133 at comment 4442925169).

**Contract sentence:** the per-node subscriber index — the mapping from `NodeId` to the ordered list of observer ids that receive Phase G fires — MUST preserve **insertion order**. Implementations using ordered containers (`IndexMap<NodeId, SmallVec<[ObserverId; 2]>>` in Rust, `Map<NodeId, Array<ObserverId>>` in JavaScript) satisfy the invariant by container choice. Implementations using hash-based containers whose iteration order depends on hash seed (`HashMap`, `FxHashMap`, `hashbrown::HashMap`) are non-conformant for the byte-identity gate (hashbrown's iteration order changes between minor crate versions). Implementations using sorted containers (`BTreeMap` sorts by id) are likewise non-conformant. Subscriber fire order is: insertion-order per node, then `changedNodes`-insertion-order across nodes; sorted-by-id and hash-iteration containers violate both axes.

**Evidence:** Engine-semantics cluster review on epic #1133 — the TS engine's `subscriptionsByNode: Map<NodeId, Subscription[]>` iterates in JS-spec insertion order; the Rust port's prior `state.rs` used `BTreeMap<NodeId, BTreeSet<ObserverId>>` (sorted by id) and panel S13 recommended `FxHashMap` for perf. All three produce different fire orders; byte-identity (#1146) would fail the moment a graph has 2+ subscribers per node registered in non-id order. `IndexMap` is the only shape that satisfies both deterministic iteration and O(1) lookup. The amendment captures the contract any future native backend must honor.

**Why now post-STOP-VERDICT.** Identical to §3 Amendment above: documenting the invariant ahead of any future port attempt is cheaper than retro-fitting. The current TS engine already conforms by virtue of `Map`'s spec-mandated insertion-order iteration; the amendment is observation-equivalent today.

**Migration:** none — clarification of a contract any non-JS backend must satisfy. No engine source change; no test change (the TS engine already conforms via JS `Map` semantics).

### §3 Theorem 3 — atomicity, Rust engine implementation (#1348, 2026-05-13)

**Status:** SPEC text unchanged at §3 Theorem 3 — the theorem statement was already final. This row records that the Rust engine implementation of the atomicity contract landed at PR #NNNN (A.6 of epic #1133 Phase A), porting `packages/core/src/graph.ts:4782-4824` + 4866 (the TS engine's catch-arm rollback walk) into `tools/engine-rs-core/src/transition/rollback.rs::rollback_on_throw`. The walker restores `(cell.value, cell.last_write_time)` byte-identically from A.5's `RollbackBuffer`, clears the per-cell `last_staged_at` sentinel (#995 staleness fix), and resets `state.now = before_now` to undo the Phase C clock advance. After the walk, `State::hash()` equals the pre-tx hash byte-for-byte. The property test `tx_throw_leaves_state_byte_identical` at `tools/engine-rs-core/tests/rollback.rs` enrols at the SPEC §15.2 1000-trial floor for arbitrary `(state, writes)` pairs.

**Contract sentence:** unchanged from §3 Theorem 3 — *"A transaction creates exactly one new t if it succeeds and zero if it fails. A throw escaping any phase from B through F.6 lands in the commit pipeline's catch arm and rolls back the §3 state — input cells, derived state, commitHistory, commitLogEntry, and now — to byte-identical pre-commit values."*

**Evidence:** A.6 ships the input-side rollback (cell values, cell `last_write_time`, staged sentinel clear, `now` reset). Derived rollback (Phase D / Phase F.5) lands when the recompute pipeline lands in Phase B/D of the broader plan; the Rust engine's `State::deriveds` is populated by `create_derived` but no derived-recompute phase mutates it yet, so a derived-rollback would have nothing to restore in A.6's scope. The contract sentence holds for the surface A.6 covers; future tickets extend the rollback walk to derived state without changing the §3 invariant.

**Migration:** none — the Rust engine is not yet the default; the TS engine continues to satisfy Theorem 3 trivially via JavaScript's structured exception model wrapping the catch arm at graph.ts:4782. The amendment records that the Rust engine's input-side rollback satisfies the contract too, ahead of any future swap.

### NO amendment — option (c) batched-commit boundary scaffolding (epic #1493, phase C.7, #1513, 2026-05-14)

**Status:** SPEC text **unchanged** at §3, §5.1, §15.1, §15.3, and §17.6. This row exists to record — explicitly and on the one-page reference — that the #1483 re-architecture decision selected option (c) (batched-commit boundary, `docs/epic-1483/option-c-batched-boundary.md`), epic #1493 implemented it across phases C.1–C.7, and **no SPEC amendment was required**. A "no amendment" row is itself load-bearing: a future reader auditing why a re-architecture epic touched the SPEC commitments and finding no amendment must be able to see that the absence is *deliberate and reasoned*, not an oversight. The §17.6 "Option (c) batched-commit boundary scaffolding" callout carries the full rationale inline; this row is the §19 pointer.

**Contract sentence:** unchanged — every commitment the option-c constraint rubric (`docs/epic-1483/CONSTRAINTS.md` §5) tracks is preserved verbatim. The reason no amendment is needed reduces to option (c)'s pinned **Answer C**: the JS engine remains the **single source of truth** for adopter workloads; `commit()` returns a frozen `Commit` synchronously after Phases A–H run JS-side; only the **WASM-side wire crossing** is batched (the F-marshal.5 shadow flush deferred from per-commit to per-batch-boundary). Because the commit *semantics* never leave the JS engine, §3 Theorem 4 (one tick per commit), §3 Theorem 2 (uninterruptible Phase E→G), §5.1 Phase A–H + Amendment 4 (Phase G IndexMap container), §15.1 (byte-identity — the C.5 cross-backend gate fires per-flush, a test-harness change not a SPEC change), and §15.3 (per-commit synchronous subscriber fire — option (c) pins choice (i); end-of-batch coalescing was rejected precisely because it *would* have required §3 + §8 amendments) all hold without modification. §17.6's host-tier matrix is inherited verbatim (a `commit_batch` peer extern + a per-graph `createCausl({ batchedFlush })` opt-in; no host stranded, no ceiling moved).

**Evidence:** the C.1 `commit_batch` unit tests (N=1/10/100/312, both bridge crates) prove a single batched envelope of N actions is byte-identical to N single envelopes; the C.4 load-bearing acceptance test proves default-config (`afterN=1`, no opt-in) `commit`/`read`/`subscribe`/`exportModel`/`now` behaviour is byte-identical to dev `b15069fa` (a bare pure-TS graph); the C.5 cross-backend determinism gate fires per-flush at N=1/10/100/312 × 1000 trials × 0 byte differences; the C.6 `op-rust-batch-boundary` probe confirms the FFI crossing tax amortises exactly 1/N per the option-c doc §1 arithmetic (1564/156/50.1/15.6 ns/op at N=10/100/312/1000, crossing the #1484 §3 ≤50 ns floor precisely at N≥312). The option-c constraint-rubric fill (`docs/epic-1483/option-c-batched-boundary.md` §8) answers every §1–§5 rubric row with file:line / bench-number / SPEC-§ evidence.

**Migration:** none — additive and zero-codemod. Adopters who never pass `createCausl({ batchedFlush })` (or `loadWasmBackend({ batchedFlush })`) see **zero behavioural change** — default `afterN=1` is byte-identical to pre-epic dev `b15069fa`. The opt-in is per-graph, not global; no deprecation cycle, no lint, no RC track. **The honest framing carried in the §17.6 callout and `docs/wasm-adoption-guide.md`:** option (c) delivers **ZERO adopter-visible perf at v1.x** — the JS engine remains SSOT, so the §17.5 3.0×-8.0× capability-cost residual band is unchanged at v1.x. Option (c) is the *enabling scaffolding* for a future **v2.x WASM-SSOT cutover** (which would re-pay no per-commit boundary tax because the wire is already batched); the boundary problem's *resolution* is deferred to that future epic, which has not been scoped. **The #1133 78× boundary-tax falsification is NOT refuted by epic #1493** — it stands as the standing record; epic #1493 ships the plumbing, not the perf.

### NO amendment — v2.x Rust-SSOT cutover (epic #1515, V2-final, #1546, 2026-05-16)

**Status:** SPEC text **unchanged** at §3, §5.1, §15.1, §15.3, §17.5, and §17.6. This row records — explicitly and on the one-page reference — that epic #1515 (the v2.x Rust-SSOT cutover) was decomposed (#1516) and implemented across V2.0–V2.5 + V2-final (V2.0 design pin #1517 `97da8420`; V2.1 #1522 opt-in surface; V2.2 #1531 shadow byte-compare; V2.3 #1533 honest re-measurement; 🚦V2.4 #1535 the LOAD-BEARING promote GO/NO-GO — verified **GO**, 1000 trials × 0 byte divergence; V2.5 #1544 rollback tiers 2+3; V2-final #1546 this row + the tripwire checklist + the adoption-guide section), and **no SPEC amendment was required for v2.x as scoped**. This is the direct successor of the #1493 C.7 "NO amendment" row above and mirrors its load-bearing rationale: a future reader auditing why an integration-class epic that *moves which engine is canonical at the flush boundary* touched zero SPEC commitments must be able to see that the absence is **deliberate and reasoned, not an oversight**. The full rationale lives inline in `docs/epic-1515/V2-DESIGN.md` §5; this row is the §19 pointer.

**Contract sentence:** unchanged — every adopter-facing commitment is preserved verbatim because `engine: 'rust-ssot'` is **opt-in, per-graph, default-off**, and the JS engine **stays the synchronous per-commit single source of truth** (V2-DESIGN §1.2 Answer-C topology inherited from option (c)). `engine: 'rust-ssot'` only changes which side's post-state the **WASM-side mirror** trusts at the flush boundary, **after** a per-flush byte-compare against the always-on JS-engine shadow promotes the Rust post-state (the 🚦V2.4 load-bearing flip; on byte-divergence the V2.5 Decision 6 rollback keeps the JS post-state canonical and, at K=1 fail-safe, sticky-downgrades the graph to `'js-ssot'` with the structured `RUST_SSOT_DOWNGRADE_ERROR_CODE`). Because the commit *semantics* never leave the JS engine: **§3 Theorem 4** (one tick per `commit()`) — preserved, the JS engine advances `now` synchronously per commit, `engine: 'rust-ssot'` does not move the per-commit clock; **§3 Theorem 2** (uninterruptible Phase E→G) — preserved, each Phase E→G runs JS-side on a single tick, the `commit_batch` envelope at flush is one synchronous FFI call; **§5.1 Phase A–H + Amendment 4** (Phase G IndexMap container) — preserved, Phase A–H + Phase G fire JS-side per commit before any flush, the Rust engine's IndexMap-shaped container is already validated byte-identical by the C.5 gate; **§15.1 byte-identity** — preserved *and now load-bearing*, the wire format is unchanged, v2.x only promotes the already-byte-identical Rust post-state from "discarded shadow" to "canonical for the mirror" after the per-flush compare passes (a wiring change, not a contract change — the same shape the C.7 row used for the per-flush gate adjustment); **§15.3 subscriber-fire** — preserved verbatim, per-commit synchronous JS-side, v2.x does NOT touch subscriber dispatch (keeping the JS engine authoritative for Phase G is what avoids the fan-back cost); **§17.5 capability-cost band** — unchanged at v2.x **because the default stays JS-SSOT** (the band only moves if `rust-ssot` becomes the default — the tripwire-gated future decision explicitly out of #1515 scope); **§17.6 host-tier matrix** — inherited verbatim, v2.x adds no extern (reuses `commit_batch`), strands no host, moves no bundle ceiling, changes no `loadWasmBackend()` / `detectBridge()` path.

**Evidence:** the V2.1 #1522 load-bearing acceptance test proves omitting `engine` (or `'js-ssot'`) is byte-identical to dev `97da8420` (default-config IR / `commit` / `read` / `subscribe` / `now`); the V2.2 #1531 + V2.4 #1534 per-flush byte-compare tests prove the compare/promote path is **never entered** under default `js-ssot` (zero overhead, byte-identical) and prove the V2.4 compare-and-PROMOTE flip; the **🚦V2.4 #1535 LOAD-BEARING GO/NO-GO** ran the C.5 cross-backend determinism gate **with the Rust post-state promoted canonical** at N=312 × **1000 trials × 0 byte differences** ⇒ **GO** (the single point where Rust-SSOT byte-identity under real adopter workloads, with the post-state actually promoted not shadow-discarded, is proven); the V2.5 #1544 sticky-downgrade tests pin the Decision 6 tier 2 fail-safe (1 divergence ⇒ sticky `js-ssot`, the `RUST_SSOT_DOWNGRADE_ERROR_CODE` emitted once, subsequent flushes never promote, default/non-diverging graphs byte-unaffected); the V2.3 #1533 honest re-measurement (`docs/epic-1515/v2.3-rust-ssot-remeasure.md`) records the **~85×** engine-exec T1 axis and the corrected #1525 GC-survival figures (~16.6× p99.9 flattening / transient-not-≈0 — not the synthetic 437×/≈0). The future-promotion SPEC interaction is named but **deliberately not written here**: when the maturity tripwire clears and the *future* promotion-to-default decision is taken, **that decision requires a SPEC §17.5 + §17.6 amendment** (the §17.5 lower-bound clause's named architectural escape valve; the §17.6 host-tier "default engine" line). v2.x scopes that amendment out explicitly — consistent with how every prior FFI-boundary amendment (#1124, #1333, #1493 C.7) was sequenced: document the no-amendment decision now, amend at the decision that actually changes the contract.

**Migration:** none — additive, per-graph, zero-codemod, zero-deprecation. Adopters who never pass `engine: 'rust-ssot'` see **zero behavioural change** — omitting `engine` is byte-identical to dev `97da8420` (the load-bearing V2.1 acceptance property). An adopter who opts in and observes a production issue rolls back with a **per-graph runtime config flip** (Decision 6 tier 3 — omit `engine`; no redeploy, no rebuilt binary, byte-identical the moment the flag is gone), backed by the always-on JS-SSOT shadow (tier 1 per-flush) and the K=1 fail-safe sticky downgrade (tier 2, structured `RUST_SSOT_DOWNGRADE_ERROR_CODE`). **The honest framing carried in `docs/wasm-adoption-guide.md` (the §4a v2.x section) and `docs/epic-1515/V2-DESIGN.md` §0:** `engine: 'rust-ssot'` delivers **ZERO adopter-visible perf at current WASM maturity** — the Rust-engine-in-WASM per-commit execution cost is **~85× the TS engine** (#1479 comment 4455257530), a property of *today's* WASM runtime (no GC GA, limited JIT, no SIMD) that #1493's batching provably cannot amortise. **The #1133 falsification is NOT refuted by epic #1515** — it STANDS as the standing record. The present, non-maturity-gated value is large-tree GC-survival (#1525); promotion of the default to `'rust-ssot'` is a **separate, tripwire-gated, SPEC-amending future decision explicitly out of epic #1515's scope**. Epic #1515 remains **OPEN** as the umbrella tracking that future tripwire-gated promotion + child #1541 (WASM-advancement readiness tracker); the manual re-runnable tripwire monitor is `docs/epic-1515/v2-final-tripwire-checklist.md`.
