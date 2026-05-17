# Reactive invariants — what causl pays for, what redux/mobx don't

Date: 2026-05-12
Lens: Conal Elliott / Evan Czaplicki — denotational reactive semantics.
Subject: per-commit envelope cost of the five invariants causl pledges
under SPEC §3 (`derived(t) = f(b₁(t), …, bₙ(t))`), measured against the
two comparator architectures that drop one or more of those invariants.

## 0. The five invariants causl pays for

| # | Invariant                  | Phase           | What it costs                                              |
| - | -------------------------- | --------------- | ---------------------------------------------------------- |
| 1 | Atomic snapshot            | A → B → C (+catch arm) | Staging buffers + parallel rollback arrays + Phase C single-tick advance |
| 2 | Glitch-free recompute      | D (Kahn topo)   | BFS over `dependents` + indegree map + Kahn drain + topo iteration |
| 3 | Equality cutoff            | D loop, B, F.4  | `Object.is(before, after)` per derived + the per-input `Object.is` gate in B |
| 4 | Frozen commit envelopes    | E + F + F.6     | `Object.freeze` on Commit + `freezeIfDev` on changedNodes + `Array.from(changed)` |
| 5 | Per-node subscriber dispatch | G             | Walk `changed` → `subscriptionsByNode.get(id)` → fan per bucket in insertion order |

All five are tested as theorems (`@causl/checker` against the IR, plus the
fast-property suite in `packages/core/test/properties/`). The cost is the
engineering price of upgrading those theorems from "should hold" to "holds
under every reachable interleaving the bounded-search checker exhibits."

## 1. What redux does NOT pay for

Redux Toolkit's commit envelope is `dispatch → reducer → notify subscribers`.
Two of causl's five invariants are skipped:

| # | Invariant                  | Redux behaviour                                            |
| - | -------------------------- | ---------------------------------------------------------- |
| 2 | **Glitch-free recompute**  | **NOT PAID.** Selectors are run on-demand at read time per subscriber. A subscriber that reads two selectors derived from the same input observes them at *the same dispatch* by accident (both call `getState()`), not by topological construction. A selector that internally calls *another* selector inherits whatever cache state that callee happens to be in — no Phase D walk. |
| 3 | **Equality cutoff**        | **NOT PAID (engine).** RTK dispatches eagerly: every subscriber fires after every dispatch regardless of whether the slice they care about changed. Reselect-style `createSelector` memos paper over this at the *consumer* layer (each selector's `equalityFn`), but the engine itself does not cut off propagation — the subscriber callback runs every dispatch. |
| 1 | Atomic snapshot            | Paid weakly: a throw inside a reducer leaves the *prior* store intact (immutable reducer pattern), but a throw escaping a reducer's `produce` callback under Immer reverts within that draft only — the dispatch does not roll back any *other* slice's reducer that already ran in the same compound action. Cross-slice atomicity is a user-level concern. |
| 4 | Frozen commit envelopes    | Not framed as an envelope. The action object is the closest analogue; it's conventionally frozen in dev but the store does not retain a history of frozen state snapshots unless DevTools is wired up. |
| 5 | Per-node subscriber dispatch | Not paid (no per-node concept). Subscribers are flat. Every subscriber fires on every dispatch. |

This is why `redux-toolkit × linear-chain × 100` clocks at **41µs/commit
(mean)** — 410ns per "node" — versus causl's **65µs/commit (650ns/node)**.
RTK is doing strictly less per dispatch because it doesn't trace the chain;
it just runs the reducer and notifies. The user's selectors do the chain
walk lazily at read time, often only for the *tail* subscriber (the
intermediate "nodes" never compute at all unless something subscribes
to them).

What this means for causl's positioning: against RTK on a *single-leaf*
linear chain, RTK wins on raw µs because it doesn't compute the
intermediates. As soon as the application's read pattern subscribes to
multiple points in the chain, RTK's lazy re-eval per subscriber becomes
N walks where causl's Phase D was 1.

## 2. What mobx does NOT pay for

MobX's commit envelope is `action → mutate observable → propagate to
observers → run reactions`. Of the five:

| # | Invariant                  | MobX behaviour                                             |
| - | -------------------------- | ---------------------------------------------------------- |
| 1 | **Atomic snapshot**        | **NOT PAID.** `runInAction` defers reaction *notifications* until the action returns, but a throw mid-action propagates *with* the partial mutation visible. The half-update IS observable: an autorun that fires on the next action sees the partial state. Causl's Phase A→B→D→catch contract rolls every byte back; MobX's does not. The bench harness explicitly documents this asymmetry in scenario.ts (`op-commit-rollback-1k` cell). |
| 4 | **Frozen commit envelopes** | **NOT PAID.** No commit history. There is no `Commit` record. Reactions receive a callback fire, not a frozen envelope. Time-travel debugging is wired through a separate `mobx-state-tree` snapshot mechanism that lives above the core. |
| 2 | Glitch-free recompute      | Paid via the `derivation`/`reaction` two-phase scheduler: a computed value is marked stale and recomputed lazily on read, but reactions are scheduled in a queue that drains in dependency order. MobX gets glitch-freedom but pays for it differently — it has no equivalent of Phase D's commit-scoped topological pass, so the propagation is amortised across reaction firings rather than concentrated in one commit envelope. |
| 3 | Equality cutoff            | Paid (computed values shortcut on `===` against prior). |
| 5 | Per-node subscriber dispatch | Paid (per-observable observer lists). |

MobX × linear-chain × 100 = **36µs/commit (360ns/node)**, the fastest of
the four. The savings come almost entirely from invariant 1 (no rollback
bookkeeping — no Phase A.5 dedup walk, no parallel rollback arrays, no
catch-arm `setDeps` restore) and invariant 4 (no `Object.freeze`,
no `Array.from(changed)`, no `IRCommit` history append).

## 3. Per-invariant cost breakdown (per-commit, rough nanoseconds)

Calibrated against the baseline numbers in `packages/bench/fixtures/regression-baseline.json` for `causl × linear-chain × {100, 1000, 10000}` (means: 65µs, 703µs, 5.4ms). All figures are *rough* — V8 hidden-class state, GC phase, and JIT warmth swing each number by ±30%. Per-node costs ÷ chain length; envelope costs are per-commit fixed.

| Invariant                  | Per-node (ns) | Per-commit fixed (ns) | Source phase(s) | Source lines (graph.ts) |
| -------------------------- | ------------- | --------------------- | --------------- | ----------------------- |
| 1 — Atomic snapshot        | ~15 ns        | ~250 ns               | A, A.5, B, C.5, catch-arm | 3840–3970, 4010–4060, 4062–4148, 4156–4166 |
| 2 — Glitch-free recompute  | ~180 ns       | ~120 ns (queue + indegree alloc) | D BFS + Kahn drain | 3224–3294 |
| 3 — Equality cutoff        | ~10 ns        | ~5 ns                 | D loop tail, B inner | 3399–3402, 4123 |
| 4 — Frozen commit envelopes | (≤ 1 ns amortised) | ~180 ns          | E + F           | 4250–4257, 4270+ |
| 5 — Per-node subscriber dispatch | ~25 ns (only on subscribed nodes) | ~30 ns | G | `phaseG_dispatchPerNodeSubscribers` |
| **Per-node compute body**  | **~280 ns**   | n/a                   | `computeDerived` | invoked at 3373 |

**Sums for linear-chain × 100** (chain length 100, 1 subscriber on tail):
- Per-node (×100): atomic 1.5µs + glitch 18µs + equality 1µs + freeze 0 + per-node-sub 0 + compute body 28µs ≈ **48.5µs**
- Per-commit fixed: 250 + 120 + 5 + 180 + 30 ≈ **0.6µs**
- Predicted total: ~49µs. Observed: 65µs. Gap (~16µs) is `entries.get`/Map probe overhead, GC, and the per-input `inputSerializableMemo.delete` calls.

**Sums for linear-chain × 10000**:
- Per-node terms scale linearly: ~5.0ms (vs observed 5.4ms — within model error).
- The per-commit fixed cost (~0.6µs) is *amortised to zero* against 10000 nodes.

### Key claim: per-commit fixed cost is load-bearing ONLY at small scale

At scale 100, the 600ns per-commit fixed envelope is ~1% of total commit
time. At scale 10, it would be ~6%. At scale 1, **it dominates**: a
trivial single-input single-derived commit pays ~600ns of envelope cost
on top of ~300ns of compute, so the engine is doing 2× the work the
naive "just run the reducer" path does.

The op-microbenches `op-commit-noderived-1k` and `op-tx-set-isolated-1k`
exist precisely to measure this fixed envelope without the per-node term
swamping it.

## 4. Which invariants matter at which scale

| Scale | Invariants that dominate cost | Invariants that are vacuously satisfied |
| ----- | ----------------------------- | --------------------------------------- |
| × 1 (single mutation, single derived) | (4) Frozen envelopes, (1) Atomic snapshot | (2) Glitch-freedom — only one derived to recompute; (3) Equality cutoff — only one downstream edge; (5) Per-node dispatch — at most one subscriber |
| × 10 — × 100 | (1) Atomic snapshot bookkeeping (rollback arrays grow), (2) Glitch-free Kahn pass | (4) Frozen envelopes — amortised; (5) Per-node dispatch fan-out is small |
| × 1000 | (2) Glitch-free Kahn pass + per-node compute body | (1), (3), (4), (5) all amortised |
| × 10000 | (2) and the *per-node compute body* — Phase D's BFS + Kahn drain is now N=10k Map probes and Set walks | (1) atomic snapshot — the per-commit fixed setup is 0.01% of total cost |

**Observation:** glitch-freedom (invariant 2) and the per-node compute
body are the only costs that scale linearly with chain length. Everything
else is either fixed-cost (paid once per commit regardless of scale) or
per-subscriber (paid on the tiny `changed ∩ subscribed` slice).

**Corollary:** the per-commit fixed envelope (~600ns) is dead weight at
scale 1–10 — exactly the workload shape that React adopters drive when
re-rendering on a single store key. This is the regime where causl
*looks slow* against redux not because the algorithms are slower, but
because the invariants are unnecessarily strong for the scenario.

## 5. Fast-path proposals for small-scale chains

The principle: an invariant is **vacuously satisfied** when the scenario
makes it un-falsifiable. We can detect three such conditions cheaply at
commit-start, and route the commit through a shorter envelope.

### Proposal A — *Singleton-staged fast path* (single-input commit)

**Detection (after Phase A returns):**
```
inputRollbackEntries.length + stagedWriteEntries.length === 1
&& commitMetadataIds.size === 0
&& commitHistoryCap === 0       // (already required by #715 / #704)
```

**Rationale:** with exactly one staged input, atomic snapshot is
vacuously satisfied (a throw inside Phase D rolls back exactly one cell,
and we already hold its prior value); glitch-freedom is vacuous because
there is only one input edge into Phase D, so Kahn's BFS degenerates to
"walk `dependents.get(theOneInput)` and recompute in dependents-iteration
order, which IS topological for a chain."

**Skipped work:**
- Phase A.5 dedup walk (only one row, no possible revert).
- The `affected` `Set<NodeId>` + `indegree` `Map<NodeId, number>` + the
  Kahn `ready` queue — replace with a direct stack-walk over `dependents`.
- The `derivedRollback` Map — keep a single `{id, value, deps, computed, lastTime}` 5-tuple instead.

**Estimated saving:** ~250ns per-commit fixed + ~70ns per-node (replacing
the indegree decrement+probe with a direct list traversal). On
`linear-chain × 100`: 250 + 7000 = ~7.3µs, an ~11% win.

**Risk:** the "walk `dependents` in iteration order" only equals
topological order when the affected sub-graph is a *chain* (each node
has at most one incoming edge from the affected set). For diamond /
fan-in shapes the proposal is unsound and must fall through to the
full Phase D. The cheap structural check is: every visited node's
`indegree` (counted lazily on the fly) is ≤ 1. The moment we see
`indegree > 1` mid-walk, abort and restart with the full Kahn pass.
Cost of the abort is one wasted half-walk; given that >90% of small
chains in practice ARE chain-shaped (see scrolling-viewport, linear-chain),
the EV is positive.

### Proposal B — *Frozen-envelope dropout for cap=0 adopters*

**Detection:** `commitHistoryCap === 0 && commitObservers.size === 0 &&
process.env.NODE_ENV === 'production'`.

**Rationale:** the `Object.freeze` calls on `Commit` and the `freezeIfDev`
helper exist to make commit-history rows tamper-evident and to give
adopters who debug against the published `Commit` object a contract
violation if they try to mutate it. At cap=0 with no commit observers,
**nobody reads the `Commit`**: it's returned from `commit()` and almost
always immediately discarded by the caller. In production, freezing is
pure dead weight.

**Skipped work:**
- `Object.freeze(commit)` (~80ns on V8 for a 4-field object).
- `freezeIfDev(changedNodes)` — already a no-op in prod but the
  function-call overhead persists.
- `Array.from(changed)` could remain a `[...changed]` literal which V8
  inlines better.

**Estimated saving:** ~120ns per-commit fixed. Tiny in absolute terms,
but this fires on EVERY commit including the singleton hot path —
multiplicatively useful with Proposal A.

**Risk:** an adopter that captures the returned `Commit` across the
boundary and mutates it would silently corrupt their own state. The
`freezeIfDev` discipline acknowledges this — debug builds keep the freeze;
prod builds trust the contract. Already the engine's posture for other
dev-only assertions (H1 hazard warning at line 4446).

### Proposal C — *Phase G skip when changed ⊥ subscriptionsByNode*

**Detection (already inside `commit`, post Phase D):**
```
const nothingSubscribed =
  subscriptions.size === 0
  || (changed.size < subscriptionsByNode.size
      ? !anyOf(changed, id => subscriptionsByNode.has(id))
      : !anyOf(subscriptionsByNode.keys(), id => changed.has(id)));
```

**Rationale:** Phase G is gated by `changed.size > 0` (line 4417) but
*not* by "any changed node has a subscriber." On a linear chain × 100
with the only subscriber at the tail, Phase G walks `changed` (size 101)
and for each id does `subscriptionsByNode.get(id)?.forEach(…)` — 100
of those Map probes return `undefined` and are dead lookups. The
proposed gate is one probe-vs-iterate decision plus, in the worst case,
a sub-linear `anyOf` over the smaller of the two sets.

**Estimated saving:** at × 100 ≈ 100 Map probes × ~15ns = ~1.5µs per
commit when only the tail (or no node) is subscribed. ~2% win on the
benched cell. At × 10000 it's ~150µs, ~3% win.

**Risk:** the `anyOf` itself has a cost that could exceed the savings
when MOST changed nodes ARE subscribed (fanout subscriber pattern).
Mitigate by gating on `subscriptionsByNode.size < changed.size / 16` —
i.e. only short-circuit when subscribers are *sparse* relative to
changed nodes. Empirically true for chain shapes; empirically false for
viewport-scroll shapes.

## 6. What this analysis does NOT propose

- Dropping any invariant for a scenario that has it as a load-bearing
  user contract (the checker's bounded-search would catch this). The
  proposals only short-circuit when the scenario makes the invariant
  vacuously true.
- Removing the Phase D Kahn pass entirely. That is the heart of the
  glitch-freedom theorem; the proposals route AROUND it for chain shapes
  but the fallback to full Kahn is one branch away.
- Conditional behaviour exposed in the public API. All three fast paths
  are detected internally and produce byte-identical Commit envelopes;
  no adopter code changes.

## 7. Next steps

1. Land Proposal B first (lowest risk, lowest payoff, validates the
   tooling for prod-only DCE on this path).
2. Prototype Proposal A behind a flag (`flags.fastPathSingletonStaged`);
   measure on `linear-chain × 100`, `linear-chain × 10` (the regime
   where the win is largest), and `op-commit-noderived-1k` (regression
   gate).
3. Defer Proposal C until A is settled — A removes the BFS that C's
   sparse-subscriber check is racing.

Each proposal should land with a property test that proves the
short-circuit's output is bit-identical to the full envelope's, run
on the same `@causl/checker` interleaving corpus.
