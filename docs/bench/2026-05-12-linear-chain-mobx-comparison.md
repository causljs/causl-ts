# Why mobx wins `linear-chain × 100` (and what causl can learn)

Date: 2026-05-12
Subject: mobx 0.032 ms vs causl 0.071 ms — a ~2× gap at depth 100.
Sources read:
- `packages/bench/src/libraries/mobx.ts` — `setup('linear-chain')` lines 144–191.
- `packages/bench/src/libraries/causl.ts` — `setup('linear-chain')` lines 186–209.
- `packages/bench/node_modules/mobx/src/core/computedvalue.ts` (`ComputedValue.get`, `trackAndCompute`).
- `packages/bench/node_modules/mobx/src/core/observable.ts` (`propagateChanged`, `propagateMaybeChanged`, `propagateChangeConfirmed`).
- `packages/bench/node_modules/mobx/src/core/derivation.ts` (`shouldCompute`, `trackDerivedFunction`, `bindDependencies`).

## 1. What both harnesses actually do for `linear-chain × 100`

The two scenarios are identical at the workload level: build `head → c0 → c1 → … → c99`, subscribe (autorun on mobx, `g.subscribe` on causl) to the tail, then time **one** mutation — `head.set(1)` inside `runInAction` on mobx, `tx.set(a, 1)` inside `g.commit` on causl. Each tick recomputes all 100 derived nodes exactly once.

That equivalence is what lets the ratio mean anything. Everything below is about how the two libraries get from "head wrote" to "tail value flushed to the subscriber" in fundamentally different shapes.

## 2. What mobx does on the write

Mobx splits the work into **two passes** triggered by the write, separated by the autorun's tail read.

**Pass 1 — `propagateChanged` from the atom (`observable.ts:185–203`):** the atom flips its own `lowestObserverState_` to `STALE_`, then iterates its direct observers. There is exactly one: `c0`. `c0.dependenciesState_` becomes `STALE_`, and `c0.onBecomeStale_()` fires, which calls `propagateMaybeChanged(c0)` (`observable.ts:229–243`). That walks `c0.observers_` → `c1`, marking `c1` as `POSSIBLY_STALE_`, which recurses through `onBecomeStale_` to `c2`, `c3`, …, `c99`, **and** continues into the autorun (a `Reaction`), whose own `onBecomeStale_` schedules it for the post-action `endBatch` flush.

So at the end of pass 1: `c0` is `STALE_`, `c1..c99` are all `POSSIBLY_STALE_`, the reaction is queued. No values have been computed. **No allocations of any size have happened on this path** — `propagateChanged` / `propagateMaybeChanged` walk an existing `Set<IDerivation>` and only flip enum fields on each node.

**Pass 2 — `endBatch` runs the reaction, which calls `tail.get()` (`computedvalue.ts:205–240`):** `shouldCompute(tail)` sees `POSSIBLY_STALE_` and (lines 91–125 of `derivation.ts`) walks `tail.observing_` — that's a one-element array containing `c98`. It calls `c98.get()`. `c98` is also `POSSIBLY_STALE_`, so it recurses into `c97.get()`, and so on down to `c0`. `c0.shouldCompute` is `STALE_` → it actually recomputes (just `head.get() + 1` = `2`) and calls `propagateChangeConfirmed(c0)` (`observable.ts:206–226`), which **only flips `c1`'s state from `POSSIBLY_STALE_` to `STALE_`** — it does not re-walk transitively. The recursion unwinds: `c1` recomputes, confirms `c2` is stale, etc.

The whole evaluation is a **single recursive descent of depth 100** that touches each node exactly once and reads each value exactly once. There is no separate "build invalidation set" pass, no priority queue, no Kahn ordering, no commit-log entry. The "graph algorithm" is the call stack.

## 3. Why it's ~2× faster at scale=100

The win is a mix of algorithmic shape and implementation polish:

**(a) Pass-1 is allocation-free and constant-time-per-node.** `propagateMaybeChanged` only writes the `dependenciesState_` enum. Causl's Phase D Kahn implementation (`graph.ts` `recomputeAffected`, ~lines 3185–3405 — see the sibling doc `2026-05-12-phase-d-recompute-analysis.md`) builds at least one `Map<NodeId, …>` and a queue of "changed/dirty/pending" IDs per commit. At depth 100 the constant factor on the `new Map()` + per-entry `Map.set` dominates — it's a few µs of work that mobx never pays. That alone explains ~20–30 µs of the 39 µs gap.

**(b) Evaluation is on the call stack, not on a heap-allocated worklist.** Mobx's "iterative" structure is `shouldCompute → obs[i].get() → shouldCompute → …`. That's a single hot megamorphic call path (`ComputedValue.get` calling itself transitively) that V8 inlines aggressively after warmup, with locals living in registers. Causl's iterative recompute driver loads each node out of a `Map<NodeId, Entry>`, runs its `recompute` callback, and writes back — each hop costs a `Map.get` + a closure invocation + a `setDeps` reconciliation pass (the `setDeps` 2.85%-median match in the hypothesis report is real and lives on this exact path).

**(c) V8-friendly object shapes.** `ComputedValue` is a single ES class with a fixed property layout: `observing_`, `observers_`, `dependenciesState_`, `value_`, `flags_` (one bitfield holding five booleans — see `computedvalue.ts:93–98`). Every `c0..c99` is the **same hidden class**, so the polymorphic inline cache on `obs.get()` resolves to a monomorphic dispatch. The five-flag bitfield shaves four properties off the shape compared to one boolean per state. Causl's entry shape is more variant (input vs derived vs commit-metadata-derived, several optional fields per entry — see `graph.ts:246–308`) which means more shape variants and weaker IC behaviour on the read path.

**(d) `bindDependencies` short-circuits on no-change.** After each `c_i.computeValue_`, mobx's `bindDependencies` (`derivation.ts:225–252`) walks `newObserving_` once; for `linear-chain` the dep set is identical between runs (each `c_i` always reads exactly `c_{i-1}`), so the diff is a single-entry compare and no observer mutation happens. Causl's `setDeps` is the equivalent pass but does more work even on a no-change reconciliation (the array fast-path post-#880 cut it from 4.2% to 2.85% median, but it still allocates and walks).

The split is roughly: **(a)+(b) algorithmic, ~25–30 µs; (c)+(d) implementation-level, ~10–15 µs.** Mobx's design choices stack — it isn't one trick.

## 4. Is the win fragile?

**Yes, and the bench already documents it.** Mobx's "the call stack is the graph" trick has a hard ceiling at depth ~1000. The harness explicitly caps mobx at `MOBX_LINEAR_CHAIN_MAX_SCALE = 1000` (`packages/bench/src/libraries/mobx.ts:1376`) and throws `RecursiveEvalStackOverflowError` above that. At 10k, mobx doesn't just slow down — it stack-overflows mid-`bindDependencies`, leaves `observation` arrays with `undefined` slots, and corrupts the global reaction state (#720 / #721 part 3 documented in the source comments at lines 155–176 and 1366–1404). The other libraries that try the same recursion trick (jotai, redux's chained reselect post-#899) hit the same cliff at the same depth.

Causl pays a per-commit constant overhead (the Map / Kahn machinery) to get **scale invariance**: it runs `linear-chain × 10000` cleanly (when other libraries skip with a typed error), and its cost stays linear in changed-node count rather than catastrophically failing past a V8 stack limit. That's the trade-off in one sentence: mobx is faster on shallow chains because it does less per-node bookkeeping; causl is the only library that finishes deep chains because it does that bookkeeping iteratively.

The fragility is also visible at "natural" depths an adopter might hit: deeply-nested selectors in a React app rarely reach 100, but a spreadsheet column with formulas referencing the row above (`=A1`, `=A2+A1`, …) hits 1k effortlessly. Mobx would skip those workloads entirely. That's not a hypothetical — it's why the bench's `spreadsheet-100x100` cell exists.

There's a second fragility worth naming: mobx's pass-1 propagation visits every transitively-reachable observer, even ones that turn out to be `===`-equal post-recompute. The `propagateChangeConfirmed` short-circuit only fires after a value is recomputed and compared. In `linear-chain` every node changes, so the short-circuit is moot — but in workloads where a write produces an `===`-equal output (the `equality-cutoff` scenarios), mobx still pays the pass-1 walk to every downstream observer before the cutoff fires. Causl can cutoff at write time when `tx.set` sees an `===`-equal value (post-#972).

## 5. Two or three optimizations causl could borrow

**(1) Per-entry state flag combined into one bitfield, replacing the current "state + multiple booleans" object shape.** Mobx packs five booleans into one number on `ComputedValue.flags_` (`computedvalue.ts:93–98`). Causl's `DerivedEntry` carries several boolean-ish fields as separate properties. Collapsing them to a single uint8 bitfield with masked getters/setters: (a) shrinks the entry's hidden-class signature, improving IC stability on the recompute hot path; (b) reduces per-entry retained bytes (mobx's edge on the retained-bytes-per-subscription bench is partially attributable to this); (c) lets the V8 JIT inline the flag tests into a single `& mask` instead of multiple property loads. Estimated win: 3–5 µs at scale=100, scaling to ~30–50 µs at scale=1000. Risk: low, behaviour-preserving.

**(2) Short-circuit the Kahn driver when `|changedInputs| × maxFanOut << |entries|`.** At `linear-chain × 100` causl walks Kahn's algorithm over a 100-node DAG when the actual reachable set from `a`'s write is a single chain. Mobx avoids this entirely because its "graph" is implicit in `observers_` Sets per node — the propagation is "BFS from each dirty input, stop at the autorun." Causl could keep its iterative driver as the general path but **fast-path** the common shape (single-input commit, linear or near-linear downstream): walk `entry.dependents` directly without building the Map/queue when the affected set is small. This is the same trick as mobx's `propagateChanged` walk, retained on top of the Kahn driver for the fan-in / diamond / spreadsheet shapes where the iterative driver wins. Estimated win: matches mobx within ~10 µs at depth 100. Risk: medium — needs a robust heuristic for when to engage; the wrong threshold regresses spreadsheet-class workloads.

**(3) Allocation-free invalidation walk.** Mobx's pass-1 (`propagateChanged` + `propagateMaybeChanged`) allocates zero garbage. Causl's Phase D allocates at least one Map and grows a worklist. The simplest borrow: pre-size the worklist arrays and reuse them across commits (per-graph instance, reset at the start of Phase D). This pattern is what dropped GC self-time from 39% pre-#971 down to 6.6% post-#971; pushing it the rest of the way (zero per-commit allocation for the worklist itself) buys back the remaining 6.6% on long-running workloads and tightens the `linear-chain` constant factor by 3–8 µs. Risk: low; the lifetime is well-scoped to a single commit.

A pattern that's **NOT worth borrowing**: recursive evaluation on the call stack. The 2× win at depth 100 is not worth losing scale invariance at depth 10k. Causl's existing iterative driver is the right base; the win is in optimizing its constant factor toward mobx's, not in replacing the algorithm.
