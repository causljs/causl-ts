# Causl Denotational Semantics

> The page that lands first, in code as well as prose. Every later decision in this repository references it. This is a one-page contract: what a value *means*, before any implementation strategy.

## 0. Why this page exists

The previous draft of the spec described "FRP-like" derivations without saying what a value meant at any particular moment. The team — Conal Elliott explicitly — pushed back: *if I cannot define what a value means, I cannot tell two implementations apart, and I cannot prove glitch-freedom; I can only hope for it.*

This page is the definition. It is intentionally short. The rest of `SPEC.md` and the rest of the code are implementation strategy for evaluating these definitions efficiently.

## 1. The four lines

```text
GraphTime  := an ordered sequence of commit moments t₀ < t₁ < t₂ < ...
GraphState := a snapshot of all input values at one commit moment
Behavior a := GraphTime → a            -- a value that varies over commits
Event   a  := [(GraphTime, a)]         -- discrete occurrences

input(initial)               : Behavior a    where input(t₀) = initial
derived(f, b₁, b₂, ..., bₙ)  : Behavior a    where derived(t) = f(b₁(t), ..., bₙ(t))
transaction(intent, writes)  : Event Commit  where each commit advances GraphTime by 1
```

That is the universe. Every subsequent paragraph is a consequence.

## 2. Three theorems that fall out

The previous spec listed each of these as a *goal* to be implemented. With the equations above they are not goals; they are theorems. The shipped engine's property-based tests confirm correspondence between the running engine and these equations on every CI run (see `SPEC.md` §15.1).

### 2.1 Glitch-freedom

A derived value at time `t` is a pure function of its inputs at the same time `t`. There is no intermediate "B updated but C did not" state because there is no intermediate time.

Formally: for any derived `D = derived(f, B, C)` and any `t`,

```text
D(t) = f(B(t), C(t))
```

There is no `t'` strictly between two commits where `D` could disagree with `f(B, C)`. Whatever the scheduler does internally to evaluate `D`, the meaning is fixed by the equation. A scheduler that produces a different observable answer is wrong; the equation is the oracle.

### 2.2 Determinism

`derived(t) = f(b₁(t), ..., bₙ(t))` is a function. Given the same inputs at the same time, two implementations either agree or one of them is wrong.

Replay determinism is a corollary: a recorded sequence of commits replayed on a fresh graph produces a byte-identical state, because each commit is itself a function from `(GraphState_t, intent, writes)` to `GraphState_{t+1}`.

### 2.3 Atomicity

A transaction creates exactly one new `t`. There is no fractional time. There is no observable state where some of a transaction's writes have landed and others have not. A subscriber wakes once per affected commit, never mid-staging.

## 3. What is *not* a node

The denotational definition gives us two — and only two — primitives whose meaning lives in this page:

```ts
type Node<T> = InputNode<T> | DerivedNode<T>
```

Everything else from previous drafts is a *role* a node can play, not a kind it permanently is. None of these need a separate equation, because each is expressible as one of the two:

| Previous "kind" | What it actually is |
| --- | --- |
| `formula` | A `derived` whose compute interprets an expression string |
| `selector` | A `derived` with a different name |
| `constraint` | A `derived` returning a validation result |
| `resource` | A `derived` over time, fed by an external `Event` source |
| `effect` | Not a node — a post-commit subscription |
| `conflict` | Not a node — a derived view of the engine's lifecycle |
| `collection` / `index` | Uses, not kinds |
| `workflow` | A statechart node, composed with the graph but distinct from it (see `docs/lifecycle.md`) |

The `kind` discriminator does not appear in the public type. A node is its `compute` (or the lack of one). This is what Trygve Reenskaug meant by "class taxonomy masquerading as a domain model."

## 4. The shape of the public API, derived from §1

The seven-method surface in `SPEC.md` §12 is the smallest set of operations that lets a developer construct, mutate, observe, and explain values that obey the four lines.

| API | Equation it realises |
| --- | --- |
| `createCausl()` | constructs an empty `GraphState` at `t₀` |
| `graph.input(id, initial)` | `input(initial) : Behavior a, input(t₀) = initial` |
| `graph.derived(id, f)` | `derived(f, b₁, …, bₙ) : Behavior a, derived(t) = f(b₁(t), …, bₙ(t))` |
| `graph.commit(intent, tx => …)` | `transaction(intent, writes) : Event Commit`, advances `GraphTime` by 1 |
| `graph.read(node)` | `node(t_now)` — read at the current committed time (value identity at a fixed `GraphTime`; reference identity across commits is **not** contractually guaranteed — see §4.1 below) |
| `graph.subscribe(node, observer)` | observation of an `Event` derived from successive `(node(t_i), node(t_{i+1}))` pairs |
| `graph.explain(node)` | a *derived* `Behavior` over the lineage, satisfying §1 like any other derived value |

Every additional public symbol is a teaching cost paid by every future user. Adding one without adding a row above is a spec violation.

### 4.1 Current state (as of v0.9.0) — `graph.read(node)` reference identity

The §1 equations fix *value* identity at a `GraphTime`: two synchronous reads of the same node at the same `t` are `Object.is`-equal. They say nothing about JavaScript reference identity *across* commits, and `SPEC.md` §15.1 was amended (PR #1129, closing #1124) to make this explicit: `graph.read(node)` is not contractually required to return the same JavaScript reference across calls. Today's TS engine and the TS-engine-wrapped `WasmBackend` return the same reference trivially; once the real Rust `serde`/`wasmgc` bridges land per `SPEC.md` §17.6, `read()` will return a freshly deserialised object per call. Adopters memoising on the read return (`React.memo`, `useMemo([value])`) must key on `commit.time` or the per-node version counter from `EngineTelemetry` instead. The amendment is a clarification of a contract that was always implied; the property suite enrols `read-no-identity-contract.property.test.ts` at the §15.2 trial floor with a backend that returns deep-copies per read, so the rest of the engine demonstrably never relies on identity. Adopter-facing guidance lives at `docs/wasm-adoption-guide.md` H1.

## 5. What this page does *not* commit to

- **No scheduler.** "How does the engine compute `derived(t)`?" is implementation strategy. Push, pull, dirty-marking, MVCC, salsa-style memoisation — all are legal answers. The denotational definition rules out only those that disagree with `f(B(t), C(t))`.
- **No performance bound.** §1 says nothing about *how long* `commit` takes. `SPEC.md` §14 contains the two correctness-shaped performance criteria; they live there, not here.
- **No persistence model.** A graph is a value over `GraphTime`. Whether the value is stored in memory, a journal, or a database is orthogonal.
- **No multi-user semantics.** `GraphTime` is a total order. Two clients each producing their own `GraphTime` is a *future* problem; merging two total orders into one is a CRDT problem, not this page's problem.

## 6. Acceptance for §3 in code

The shipped property-based suite gates the engine against §1 on every CI run (see `SPEC.md` §15.1, §15.2):

1. **Atomicity** — for any commit with writes `[w₁, w₂, …]`, no observer ever sees a state with a strict subset applied.
2. **Determinism (replay)** — a recorded commit sequence replayed on a fresh graph produces a byte-identical commit log and equal `read(n)` for every node.
3. **Glitch-freedom (diamond)** — for `D = f(B, C)` with `B = g(A)`, `C = h(A)`, and any update to `A`, every observation of `D` is `f(g(A_new), h(A_new))`; no observation is `f(g(A_old), h(A_new))` or its mirror.
4. **Dynamic-dependency cleanup** — for a derivation that switches inputs based on a conditional read, the active dependency set after a commit equals exactly the set of nodes the compute would currently read; no orphans.

Each invariant is fuzzed with ≥1000 random graphs and ≥1000 random commit sequences per CI run. Failing inputs are shrunk and committed as regression cases (see `SPEC.md` §15).

## 7. Where this page sits relative to the rest of the spec

- `SPEC.md` §3 — the four lines, copied verbatim into the spec for context.
- `SPEC.md` §5.1 — the eight named phases (A–H, including F.4/F.5/F.6) that turn the §1 equations into a per-commit pipeline.
- `docs/semantics.md` (this file) — the long-form contract.
- `docs/lifecycle.md` — the composite statechart that names every transition the engine is allowed to take *between* commits.
- `packages/core/src/*` — the implementation strategy; the per-commit pipeline lives in `commitInternal` in `packages/core/src/graph.ts` (Phase A–H markers in the body of that function).
- `packages/core/test/*` — the executable acceptance test of §1.

If any of these contradict §1, §1 wins. The implementation is wrong, or the lifecycle is wrong, or the test is wrong. The equation is not.
