# `linear-chain × 1000` — redux-toolkit vs causl

_2026-05-12 — read-only analysis against `main`. Companion to
[`2026-05-12-linear-chain-causl.md`](./2026-05-12-linear-chain-causl.md)._

Cited wall-clock: **redux-toolkit 0.337 ms vs causl 0.692 ms** at scale 1000
(≈2.05× delta in redux's favour). The matching `bench.stderr.log` reading is
`redux × linear-chain × 1000: 0.57ms` vs causl 1.00ms reported in
`report/SUMMARY.md`; crossover-curve.md records `causl 0.290 ms median` at 1k
under the dedicated curve harness. Different harness arms hit different envelopes;
the **ratio** (redux is ~2× faster at scale 1k on this synthetic chain) holds
across all three captures and is the subject of this doc.

## 1. What redux-toolkit actually executes on `step()`

Harness: `packages/bench/src/libraries/redux.ts:183–270`.

Build phase (out of `step`): one `createSlice({ name: 'chain', reducers: {
bumpHead } })` + `configureStore({ middleware: () => new Tuple() })` (the empty
middleware tuple disables Immer's dev-only freeze/immutability check and the
thunk middleware — production parity, see the harness header comment at lines
48–61). Then a 1000-iteration loop builds 1000 `createSelector(upstream, v => v
+ 1)` reselect selectors, each upstream-bound by closure to the previous.
Finally `store.subscribe(() => { tail.read(getState()); tally() })`, and one
warmup `tail.read(state)` to populate every link's cache.

Per `step()`:

1. **`store.dispatch(bumpHead(1))`**
   (`node_modules/.../redux@5.0.1/.../redux.legacy-esm.js:145–168`):
   - 5 type-validity branches (action plainness, `action.type` type, reentrance).
   - `isDispatching = true; currentState = currentReducer(currentState, action);`
   - **Reducer** (`createReducer`, RTK dist line 723–758): filter `actionsMap`,
     filter `finalActionMatchers` (size 0 here), build a `caseReducers` array
     (length 1), then `caseReducers.reduce` invokes the slice's `bumpHead`
     under **`produce(previousState, draft => { caseReducer(draft, action) })`**.
     Immer's `produce` creates one proxy draft, the reducer assigns
     `state.head = 1`, Immer commits → returns a new frozen `{ head: 1 }`
     plain object. The slice state is a single primitive field, so Immer's
     draft path is one shallow proxy + one structural-share write.
   - `listeners.forEach(l => l())` walks `currentListeners`, which here is a
     `Map` of size 1 containing the harness's tally closure.
2. **Subscriber callback** runs `tail.read(getState())`. `tail` is the outermost
   reselect selector, wrapped by the harness's `counted` closure.
3. **Reselect tail-pull** (`node_modules/.../reselect@5.1.1/.../reselect.legacy-esm.js:631–700`):
   - Outer `argsMemoize` (`weakMapMemoize`, line 561–628) keys on the single
     argument (`state`). On dispatch, `state` is a NEW object reference (Immer
     freezes a fresh root); the WeakMap entry under the new state pointer is
     empty → cache miss → run `dependenciesChecker`.
   - `dependenciesChecker` calls `collectInputSelectorResults(dependencies,
     arguments)`: invoke `links[N-1].read(state)`. That `counted.read`
     immediately calls the previous reselect selector — same argsMemoize miss
     under the new `state` ref → recurse one level up.
   - The recursion bottoms out at the slice-state primitive read (`s => s.head`),
     then unwinds 1000 levels: at each level the inner `memoizedResultFunc`
     (the `v => v + 1` combiner, wrapped by `weakMapMemoize`) keys on the
     primitive `1` (incremented per level) — first time at this value, also a
     miss — and runs `v + 1`. Result is stored in the WeakMap cache node
     under the new `state` arg at the outer layer and under the primitive at
     the inner layer.
4. `tally()` increments the harness's notification counter.

Total per commit at scale 1000 (counting only the steady-state ops, not the
first-warmup walk):
- 1× `dispatch` envelope (5 branch checks + `isDispatching` set/unset).
- 1× Immer `produce` (proxy creation + one struct-share write + freeze).
- 1× reducer `reduce` over a 1-element `caseReducers` array.
- 1000× nested reselect selector calls, each:
  - `argsMemoize` outer WeakMap probe (insert new state cache node).
  - `memoizedResultFunc` inner `weakMapMemoize` probe on a primitive (Map lookup).
  - One `v + 1` add.
  - Two writes (`cacheNode.s = TERMINATED; cacheNode.v = result`).
- 1× subscriber call.

## 2. Why redux is ~2× faster at scale 1000

The redux path's per-link cost is bounded by **2 hash probes + 2 writes + 1 add**
(reselect's inner+outer memo nodes + the combiner). The causl path's per-link
cost is bounded by **~5 hash probes + multiple object/array allocations + the
compute** (Phase 1/2 BFS, Phase 3 Kahn drain, Phase 4 recompute prologue with
rollback-record allocation, `setDepsFromArray` Map probe, and the
`computeDerived` frame literal + `nextStack` clone + `nextDepsArr` allocation).
See `2026-05-12-linear-chain-causl.md` §1–§2 for the precise inventory; the
relevant numbers are **~5000 hash-table operations in `recomputeAffected`
alone** vs reselect's ~2000 in the chain-walk.

Allocation pressure per commit at scale 1000:

| allocation | redux (per commit) | causl (per commit) |
| --- | ---: | ---: |
| state-root replacement | 1 (Immer's frozen result) | 0 (engine mutates in place under transaction) |
| reverse-dep graph state | 0 | 1 `affected` Set + 1 `indegree` Map + 1 `queue` array + 1 `ordered` array + 1 `processedThisPass` Set |
| per-link object literal | 0 (writes 2 fields on a pre-allocated cache node) | 1000 rollback records + 1000 `RecursiveFrame` literals |
| per-link array | 0 | 1000 `nextDepsArr` + 1000 `nextStack` clones |
| commit log | 0 | 1 `Commit` frozen object + 1 history-ring push |
| input-snapshot retention | 0 | 1 `delta` Map entry |

The dominant deltas are the per-link allocations and the reverse-dep BFS. The
BFS is structural — it makes causl's Phase D commit-time complexity O(|affected|)
in *graph operations* rather than O(|affected|) in *user combinator calls*.
Reselect's pull-on-read model **doesn't have a "Phase D" at all** — there's no
notion of "affected nodes" because there's no graph; the chain is reconstructed
from the recursive function-call trace on each `tail.read`.

V8 hidden-class story:
- Redux's hot path mutates the same two slots (`s`, `v`) on the same `cacheNode`
  shape across all 1000 links. Inline caches stay monomorphic; the `+1` site
  is a SMI op, the equality checks on the args path are pointer-compare on
  WeakMap keys.
- Causl's `computeDerived` allocates new `RecursiveFrame` literals 1000× per
  commit. The shape is monomorphic (graph.ts:2324 keeps the field order stable)
  but the V8 nursery still pays for 1000× 5-field allocations + GC sweep.
  `recordingGet`'s branch ladder (4 conditions before the work) is a hotter
  trampoline than reselect's single-arg memo probe.

## 3. Invariants redux doesn't pay for

Listed in order of cost contribution on this scenario:

1. **Atomic snapshot + reverse-dep graph.** Causl maintains an explicit
   `dependents` Map and walks it in Phase 1/2 BFS to compute the affected set.
   Reselect doesn't have one — propagation is implicit in the chain of nested
   selector calls evaluated on read. The cost: causl spends ~2000 Map/Set ops
   in the BFS *before* a single combiner runs.
2. **Glitch-free recompute under fan-in.** Causl's Kahn drain (Phase 3)
   guarantees every node recomputes after all its upstreams in a single commit
   — the SPEC §3 invariant. Reselect is correct on linear-chain because the
   pull order happens to match topological order; on diamond fan-in it would
   recompute the same upstream twice unless explicitly shared, and the
   second branch's selector wouldn't necessarily see the latest version of
   the first branch's intermediate value. (RTK's diamond harness measures
   exactly this — reselect lands at 0.01 ms only because the harness happens
   to pull both branches through a shared input selector, hand-coordinated.)
3. **Commit log + retention ring.** Causl unconditionally appends to
   `commitHistory` (cap 1000) and maintains the input-snapshot delta map for
   bounded replay. Redux has neither — replay is the application's problem.
4. **Equality-cutoff with structural sharing.** Causl runs `Object.is` against
   `prev.value` at every recompute and propagates `changedThisCommit` only on
   genuine churn (Phase D §938). Reselect skips combiner work when input
   *references* are equal, but on a state-replacing dispatch every reselect
   input ref differs, so the cutoff fires only via the outer `lastResult`
   identity-stability path — and on a chain where every link genuinely
   shifts by `+1` that doesn't help here either.
5. **Rollback frames.** Causl materialises a per-node rollback record in
   Phase 4 so the commit can be aborted atomically. Redux dispatches are
   not transactional; if a reducer throws, the store state isn't rolled
   back per-slice — the dispatch propagates.

The asymmetry is structural: redux + reselect is correct on linear-chain by
*coincidence* (chain pull order = topo order), while causl's engine is
correct on *every* topology by *construction*. The constant-factor cost of
that guarantee is what shows up at small scale; at large fan-out or under
diamond/dynamic-dep workloads, the picture inverts (see the `diamond` row
in `comparison_table.md`: causl 0.01 ms / redux 0.01 ms; on dynamic-dep-flip
causl edges out redux by ~1.5×).

## 4. Three optimisations causl could borrow

These are workload-specific to chain + low-fanout shapes; they should not
compromise the diamond/glitch-freedom invariants.

1. **Fuse Phase 1/2/3 into a single BFS when every node has indegree 1.**
   The Kahn drain is only needed when fan-in > 1; for fan-in-1 the BFS
   enqueue order IS the topological order. Detectable in the BFS itself by
   tracking max indegree; on a `linear-chain × 1000` cell this saves
   ~2000 Map ops per commit (Phase 3's drain becomes a no-op). This is
   optimisation #1 in `2026-05-12-linear-chain-causl.md` §4. It's safe: the
   shape check is invariant-preserving — if any node has indegree > 1, fall
   through to the existing Kahn pass.

2. **Pre-allocate Phase 4's `RecursiveFrame` and `nextDepsArr` on the
   `DerivedEntry` itself, reuse across commits.** Reselect stores
   `cacheNode.s`, `cacheNode.v`, `cacheNode.o`, `cacheNode.p` directly on
   the selector record and mutates two slots per call — zero allocations
   on the steady-state miss path. Causl could hang `recomputeScratch` off
   `DerivedEntry`: a reusable frame struct + a length-tagged dep buffer.
   The frame's hidden class stays monomorphic (already true per graph.ts:2324),
   but the per-commit allocation count drops from 2000+ to 0. Caveat: the
   `nextStack` clone in `computeDerived` exists to support the recursive
   walker re-entry path; on Phase 4's iterative drive every upstream is
   already computed, so the clone is dead weight and can be conditionalised
   on `dirtyStack.length > 0`.

3. **Defer rollback-record materialisation until the first throwing
   compute.** Phase 4 currently allocates a 4-field plain-object literal
   per derived node per commit (`graph.ts:3365`) so the catch arm can roll
   back. On the no-throw steady state — the actual hot path — the record
   is never read. Replace the per-row allocation with two parallel arrays
   on the engine instance (`rollbackId[i]`, `rollbackPriorValue[i]`,
   `rollbackPriorComputed[i]`, `rollbackPriorDeps[i]`) indexed by loop
   position; in the catch arm, walk the arrays. This is the same trick
   #1010 used for the rollback Map (lazy-mint), extended one level deeper.
   On `linear-chain × 1000` this eliminates 1000 object literals per commit.

The combined effect of (1)+(2)+(3) on `linear-chain × 1000` should close
most of the ~2× gap to redux: BFS work drops by ~⅔, per-link allocations
drop to ~0, and the rollback-record cost zeroes out on the no-throw path.
The remaining causl-side cost (Phase F commit log, Phase F.6 retention)
is structural and intentional — the price of replayable commits, which
redux explicitly offloads to the application.

## 5. Cross-references

- `packages/bench/src/libraries/redux.ts:183–270` — RTK linear-chain harness.
- `packages/bench/src/libraries/causl.ts:186–209` — causl linear-chain harness.
- `node_modules/.pnpm/redux@5.0.1/node_modules/redux/dist/redux.legacy-esm.js:84–169`
  — redux core `createStore` / `dispatch` / `subscribe`.
- `node_modules/.pnpm/@reduxjs+toolkit@2.11.2*/node_modules/@reduxjs/toolkit/dist/redux-toolkit.legacy-esm.js:709–761`
  — RTK `createReducer` (Immer wrapper).
- `node_modules/.pnpm/reselect@5.1.1/node_modules/reselect/dist/reselect.legacy-esm.js:541–700`
  — `weakMapMemoize` + `createSelectorCreator`.
- `packages/core/src/graph.ts` Phase D — `recomputeAffected` (line 3185),
  `computeDerivedIterative` (line 2437), `setDepsFromArray` (line 1915).
- Sibling analysis: `2026-05-12-linear-chain-causl.md` §1–§4 (the causl side
  of this comparison; this doc is the redux-side mirror).
- `packages/bench/report/profiles/cpu/causl-linear-chain-1k/INTERPRETATION.md`
  — CPU-profile receipts for the causl side.
- `packages/bench/report/SUMMARY.md` — the headline `1k: causl 1.00ms vs
  redux 0.38ms` snapshot.
