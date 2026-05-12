# `causl × linear-chain × 1000` — Read-Path Code Walk

_2026-05-12 — read-only review against `main`_

Inputs to this analysis:

- Scenario harness for `linear-chain` in `packages/bench/src/libraries/causl.ts:186–209`.
- Profile cell `packages/bench/src/profile/cells/causl-linear-chain-1k.ts`.
- Engine's read path through derived nodes in `packages/core/src/graph.ts` —
  primarily `commitInternal`'s Phase D dispatch (`graph.ts:4168–4179`),
  `phaseD_recomputeAffected` (`graph.ts:3531–3536`),
  `recomputeAffected` (`graph.ts:3185–3405`),
  `computeDerived` (`graph.ts:2279–2377`),
  `recordingGet` (`graph.ts:2186–2249`), and
  `setDepsFromArray` (`graph.ts:1915–1997`).

The profile cell runs the same arm as `setup('linear-chain', 1000)` in
`libraries/causl.ts`, modulo the `counter.wrap` instrumentation —
construction loop + tail subscription + one `commit('bump', tx => tx.set(a, 1))`.
Construction is paid 50× (ITERATIONS=50) in the profile cell; the bench harness
amortises it over `setup` once and re-runs `step` per cell.

## 1. Code path executed per commit

Per single `g.commit('bump', tx => tx.set(a, 1))` on a chain of 1000 deriveds:

1. `commit(intent, run)` → `commitInternal(intent, run)` (`graph.ts:3517`).
2. Phase A/B — `tx.set(a, 1)` walks the staging path; one InputEntry mutates and
   gets pushed onto `inputRollbackEntries` / `inputRollbackPriorValues` /
   `inputRollbackPriorLastWrite`. `changedInputIds = ['a']`.
3. Phase C — `now += 1`.
4. Phase C.5 — one `lastWriteTime` stamp.
5. **Phase D — `phaseD_recomputeAffected` → `recomputeAffected`** (the bulk of
   the trace):
   - **Phase 1 + 2 fused BFS** (`graph.ts:3224–3270`). Starts at `a`'s
     `dependents` (1 derived: `c0`), then drains the queue, walking
     `dependents.get('cN')` for each. Each step:
     - 1× `dependents.get(id)` Map probe
     - 1× `affected.add(d)`
     - 1× `indegree.set(d, 1)` (since linear-chain has fan-in 1)
     - 1× `queue.push(d)`
     For 1000 deriveds: 1000 Map probes on `dependents`, 1000 `Set#add`
     against `affected`, 1000 `Map#set` against `indegree`, 1000 array pushes.
   - **Phase 3 Kahn drain** (`graph.ts:3271–3294`). Seeds `ready` from the one
     indegree-0 node (`c0`). Each pop decrements `indegree[d]` to 0 and pushes
     `d`. 1000 `indegree.get` + `indegree.set` pairs + 1000 `dependents.get`
     probes + 1000 `affected.has` checks.
   - **Phase 4 recompute loop** (`graph.ts:3326–3403`). For each id in `ordered`:
     - `entries.get(id)` (1000 Map probes).
     - capture `e.value`, `e.computed`, `e.deps`.
     - Rollback record: lazy-mint `Map`, then `m.has(id)` + `m.set(id, {…})`
       — **1000 plain-object literal allocations** for the rollback frames.
     - **`computeDerived(e)`** (`graph.ts:2279`):
       - Allocate `nextDepsArr: NodeId[] = []` (fresh per call).
       - Allocate `nextStack = [...dirtyStack, e.id]` (fresh, length grows).
         This is the seam called out in the §971 comment but only on the
         recursive walker — Phase D enters via `computeDerived(e)` with
         default `dirtyStack = []`, so each call allocates a 1-element array.
       - Allocate the `RecursiveFrame` literal (5 fields).
       - Save/restore `activeRecording`.
       - Run user `compute(get)` — `(get) => get(upstream) + 1`. Calls
         `recordingGet`:
         - `getEntry(n.id)` → `entries.get`.
         - Branch: `dep.kind === 'derived'`, `rec.kind === 'recursive'`,
           `dep.computed === true` (Phase 4 already settled the upstream this
           tick), so the recursive walker re-entry is skipped.
         - Linear scan over `arr` (length 0 → 1) for dedup; push id into
           `nextDepsArr`.
         - `readEntryFromResolved(dep, n)` returns `dep.value`.
         - Captured map is `null` (§15.1 gate off).
       - `e.value = next`.
       - `setDepsFromArray(e.id, nextDepsArr, 1)` —
         **fast-path branch at `graph.ts:1923–1936`**: `len === prevDeps.size`
         (both 1), single-element scan, `prevDeps.has(arr[0])` — returns
         without allocating a new Set, without touching `dependents`. This
         is the steady-state win the §880 comment advertises.
       - `e.computed = true`, `e.lastTime = now`.
     - `processedThisPass.add(id)`.
     - **New-dep probe** (`graph.ts:3386–3392`): walk `e.deps` (size 1) and
       check `prevDeps.has(d)`. On linear-chain re-bumps after the first
       commit, the dep-set is unchanged → no `findCyclePathFrom` call.
     - Equality cutoff: every node's value moved (`+1` shift), so
       `changedThisCommit.push(id)`.
6. After Phase D: `downstreamChanged.length === 1000`, so the §704 empty-derivation
   fast path is bypassed. Phase E allocates `changedNodes = Array.from(changed)`
   (1001 entries) and constructs the frozen `Commit`.
7. Phase F — `commitHistory.push(...)` (default `commitHistoryCap = 1000`).
8. Phase F.4 — `commitLogConsumerCount === 0` for the bench arm (no consumer
   reads `graph.commitLog`); gate skips.
9. Phase F.5 — `commitMetadataIds.size === 0`; gate skips.
10. Phase F.6 — input snapshot retention; one delta entry.
11. **Phase G — `phaseG_dispatchPerNodeSubscribers`** (`graph.ts:3653`). Walks
    `changed` (1001 ids). For each `changedId`, `subscriptionsByNode.get(id)` —
    999 of the 1000 buckets are `undefined` (only the tail has a subscriber);
    the tail bucket fires the harness's `tally` once.
12. Phase H — `commitObservers.size === 0`; gate skips.

## 2. Hottest 3–5 lines (per static reading)

Ranked by repetitions × cost on a 1000-deep chain. These line numbers refer to
`packages/core/src/graph.ts`.

1. **`graph.ts:3373` — `computeDerived(e)`** inside the Phase 4 recompute loop.
   Called 1000× per commit; each call allocates a `nextDepsArr`, a `nextStack`
   (`[...dirtyStack, e.id]`), a `RecursiveFrame` literal, and runs the user's
   `(get) => get(upstream) + 1`. The arrow body itself is cheap, but the per-call
   frame literal + `nextStack` clone is the dominant allocation pressure visible
   to the GC on the chain. The §971 comment hoisted the `get` closure out of
   `compute` — but the per-call frame literal and `nextStack` clone remain.

2. **`graph.ts:2186` (`recordingGet`) — branch + dedup-scan + `readEntryFromResolved`.**
   Called 1000× (one tracked read per chain link). The hot work is the
   `dep.kind === 'derived'` / `rec.kind === 'iterative'` / `inFlight.has` /
   `dep.computed` triple-branch (`graph.ts:2198–2223`) followed by the linear-scan
   dedup loop (`graph.ts:2233–2243`). For fan-in 1, the dedup scan is trivially
   `len === 0` so it returns instantly, but the branch ladder runs every time —
   `recordingGet` is the V8 hot inline target.

3. **`graph.ts:3252–3270` — fused Phase 1/2 BFS body.** 1000 iterations over
   `dependents.get(id)` (Map probe) + `for (const d of downstream)` (Set
   iteration) + `affected.has(d)` (Set probe) + `affected.add(d)` +
   `indegree.set(d, 1)` + `queue.push(d)`. Five hash-table operations per
   chain link; on linear-chain with fan-out 1, the BFS body is structurally
   the same number of operations as Phase 4 but without the user-compute call.

4. **`graph.ts:3326–3403` — Phase 4 prologue per derived.** Specifically the
   rollback-record allocation at `graph.ts:3364–3371`: a 4-field plain-object
   literal allocated 1000× per commit. Per the §1010 comment this is already
   lazy-minted (the Map itself is one allocation amortised across the loop),
   but the per-row object literal is unavoidable on the rollback path — it is
   the load-bearing rollback record.

5. **`graph.ts:1923–1936` — `setDepsFromArray` fast-path.** Called 1000× per
   commit, and on the steady-state chain (deps don't shift) every call hits
   the structural-equality fast path: `len === prevDeps.size`, then a single
   `prevDeps.has(arr[0])` probe, then `return`. The branch is cheap but the
   call frame setup + `entries.get(derivedId)` probe at `graph.ts:1920` happen
   1000×. The Map probe here is structurally redundant with the `entries.get(id)`
   already done at `graph.ts:3327` two stack frames up.

## 3. Comparison to redux-toolkit (`bench/src/libraries/redux.ts:182–270`)

What the redux-toolkit harness does on the same workload:

- One Redux store with a single-input slice (`{ head: number }`).
- 1000 `createSelector(upstream, v => v + 1)` chained reselect selectors.
- `store.subscribe(() => { tail.read(getState()); tally() })`.
- `step()` dispatches `bumpHead(1)` and reads `tail`.

What that path actually does on dispatch:

1. Reducer mutates `head` (Immer draft → one structural-share write).
2. Store calls each subscriber — **one** subscriber, which calls
   `tail.read(state)`.
3. Reselect's tail call traces upstream **lazily on read**:
   `tail` checks its input-selector results against the cached pair; the input
   selector is `(s) => links[N-1].read(s)`, which in turn checks _its_ input
   against cache, etc. The chain is walked **only when something pulls** —
   there is no eager forward push.
4. For each link the work per node is: argument-equality check
   (`prev[0] === args[0]`), a cache miss → run the combiner `v + 1`, store
   `lastArgs` + `lastResult`. Two reads, two writes, no Map/Set ops, no
   per-call frame literal beyond reselect's own memo record.

Why this is faster than causl at small scale on this synthetic workload:

- **No reverse-dep graph walk.** Reselect has no `dependents` Map, no Kahn
  pass, no `indegree` Map, no `affected` Set, no `processedThisPass`. The
  cost causl pays in Phase 1–3 (≈4× the Map operations per link) before
  it touches a single user compute is structurally absent.
- **No per-link allocations on the steady-state path.** Reselect's
  `lastArgs` / `lastResult` slots are pre-allocated on the selector record
  itself; the steady-state miss path mutates two fields. causl's
  `computeDerived` allocates `nextDepsArr`, `nextStack`, `RecursiveFrame`,
  and (in Phase 4) a rollback record per link per commit.
- **No glitch-freedom invariant to maintain.** Reselect's caller-pulls model
  is not glitch-free on diamonds — it is correct here only because the
  topology happens to be a chain, and `tail.read` triggers the chain in
  pull order. causl pays for the diamond guarantee on every workload.
- **No commit log / retention / snapshot rings.** causl's Phase F.6
  retention chain (one `delta` Map allocation per commit, FIFO eviction
  loop) and Phase F bounded-history push are unconditional work for
  default `commitHistoryCap = 1000`; reselect-style stores have no
  analogous mechanic to amortise.

The redux-toolkit harness's `step` total Map/Set probes per commit:
~0 (reselect is array-record based). causl's `recomputeAffected` alone:
~5000 hash-table operations (3000 in Phase 1/2 BFS, 2000 in Phase 3 Kahn
drain) before user code runs.

Caveat: reselect's pull-on-read model **does not scale** to fan-out (every
unique pull path re-evaluates upstream caches without sharing across consumers
that don't read in the same `getState` call) and is not glitch-free under
diamond fan-in. The advantage is workload-specific to chain + one subscriber.

## 4. Concrete optimizations causl could apply

1. **Specialise Phase D for fan-in-1 chains** — detect `affected` topologies
   where every node has `indegree === 1` and a single dependent, and skip the
   Kahn pass entirely: a chain is its own topological order. The BFS already
   discovers the order it enqueues nodes in; for fan-in-1 the enqueue order
   IS the recompute order. This collapses Phase 1/2/3 from 3 passes to 1
   pass over `dependents`, saving ~2/3 of the hash-table work on
   linear-chain workloads. The shape check is `indegree.size === affected.size
   && queue.length === ordered.length && every indegree === 1`, detectable
   in one pass.

2. **Capture-by-reference in Phase 4** — eliminate the `entries.get(id)` probe
   at `graph.ts:3327` by walking the BFS-captured `DerivedEntry` references
   directly (the §941 comment explicitly previews this seam, deferred on the
   1k-trace evidence). On a 1000-node chain this drops 1000 Map probes from
   Phase 4 plus 1000 from `setDepsFromArray:1920`. The "future scenario
   widens the affected set into the tens-of-thousands range" trigger the §941
   comment cites is the linear-chain × 10 000 cell that already ships.

3. **Pool/reuse the `RecursiveFrame` and `nextDepsArr`** across the Phase 4
   recompute loop. The current shape allocates a fresh frame + array per
   `computeDerived(e)` call; on a chain, only one frame is live at a time
   (the recursive walker only recurses when the upstream is uncomputed —
   in Phase 4, by topological order, all upstreams are computed before the
   current node runs). A single reusable frame stored on the engine instance,
   reset between calls, eliminates 1000 frame literals + 1000 array literals
   per commit on the linear-chain cell. The `RecursiveFrame` hidden class is
   already monomorphic (`graph.ts:2324`); a pool would preserve that contract.

4. **Skip the per-derived rollback record when no rollback can fire.** The
   §1010 lazy-mint already amortises the `Map` allocation, but the per-row
   object literal at `graph.ts:3365` is allocated unconditionally inside the
   loop. The compute function `(get) => get(upstream) + 1` cannot throw; the
   engine has no static way to know that, but it could **defer the rollback
   record allocation until the first compute call that throws** (record only
   the loop index + entries reference, materialise the per-row records only
   in the catch arm). On the no-throw steady state — the actual hot path —
   this collapses 1000 rollback-record literals to zero.

5. **Specialise `recordingGet` for the "upstream already computed" branch.**
   The `dep.kind === 'derived'` / `rec.kind === 'iterative'` / `inFlight.has`
   / `dep.computed` ladder at `graph.ts:2198–2223` is dead weight on the
   Phase 4 steady-state recompute walk (where every upstream IS already
   computed by topological order). A separate `recordingGetReadOnly` accessor
   passed into `compute` when the engine knows no `MissingUpstream` can fire
   — i.e. inside `recomputeAffected`'s Phase 4 loop where `e`'s upstreams are
   all in `ordered` and already settled — collapses the read path to
   `getEntry` + dedup-scan + `readEntryFromResolved`. The accessor is a
   different function reference, so V8 can monomorphise the IC on the
   `compute(get)` call site at the speculation tier.

## File path index

- `/Users/rom/workspace/iasbuilt/causl/packages/bench/src/libraries/causl.ts`
- `/Users/rom/workspace/iasbuilt/causl/packages/bench/src/libraries/redux.ts`
- `/Users/rom/workspace/iasbuilt/causl/packages/bench/src/profile/cells/causl-linear-chain-1k.ts`
- `/Users/rom/workspace/iasbuilt/causl/packages/bench/src/scenario.ts`
- `/Users/rom/workspace/iasbuilt/causl/packages/core/src/graph.ts`
