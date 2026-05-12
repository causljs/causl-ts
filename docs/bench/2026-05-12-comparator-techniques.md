# Comparator fast-path techniques — what causl can borrow

Date: 2026-05-12.
Scope: the three reactive/selector libraries causl benches against in
`packages/bench` (reselect, jotai, mobx). For each, I read the actual
shipped source under `node_modules/` (versions pinned in the workspace
lockfile) and identified ONE specific technique that could plausibly
plug into causl without breaking the §3 atomic-snapshot or §15 glitch-free
invariants.

Sources read:

- `node_modules/.pnpm/reselect@5.1.1/node_modules/reselect/src/createSelectorCreator.ts`
- `node_modules/.pnpm/reselect@5.1.1/node_modules/reselect/src/weakMapMemoize.ts`
- `packages/bench/node_modules/jotai/vanilla/internals.js` (the shipped
  vanilla store, post-rev2 building-blocks layout)
- `packages/bench/node_modules/mobx/src/core/derivation.ts`
- `packages/bench/node_modules/mobx/src/core/computedvalue.ts`

causl baseline assumed by this analysis (from `packages/core/src/graph.ts`):

- Equality cutoff via `Object.is(prev, next)` on input writes (#972) and
  derived results — already present.
- `InputEntry.hasDependents` boolean fast-path (#994) to skip rollback
  bookkeeping when an input has no downstream subscribers.
- Per-node version counter map (#1242) accumulated at commit time and
  surfaced through `EngineTelemetry.nodeVersion(node)`. This is the
  closest analogue to mobx's `runId_` and jotai's `atomState.n` — but
  currently only exposed for telemetry, not used as a read-time
  short-circuit key inside the engine.

---

## 1. reselect 5.1.1 — `weakMapMemoize` argument-tree caching

### Technique

reselect's default memoizer is **not** a one-slot last-args cache. It is
an N-ary tree of cache nodes, one node per argument. Object/function
arguments descend through a `WeakMap` branch; primitive arguments
descend through a `Map` branch. Each `CacheNode` carries
`{ s: status, v: value, o: WeakMap, p: Map }` and a terminated leaf
holds the result.

```ts
// weakMapMemoize.ts:183-218 (paraphrased)
function memoized() {
  let cacheNode = fnNode
  for (let i = 0; i < arguments.length; i++) {
    const arg = arguments[i]
    if (typeof arg === 'object' || typeof arg === 'function') {
      // descend WeakMap branch (.o)
    } else {
      // descend Map branch (.p)
    }
  }
  if (cacheNode.s === TERMINATED) return cacheNode.v
  // ... compute, store at this leaf
}
```

The "fast path" is: walk N hash lookups by reference identity for
objects (cheaper than equality on object args) and by value identity
for primitives. On a hit the recompute is skipped entirely. Cache
entries for object arguments are reclaimed by GC when the object is
collected (`WeakMap` semantics), so the cache is "effectively
unbounded" without a leak.

Top of the file also pulls the dual primitive/object cache idea from
React's internal `ReactCache.js`, which is the same shape.

There is a second layer in `createSelectorCreator.ts:402-443`: the
*output* selector is wrapped by an outer `argsMemoize` (defaulting to
`weakMapMemoize` again), so the dependency-collection loop itself is
skipped when the outer args repeat.

### Code reference

- `node_modules/.pnpm/reselect@5.1.1/node_modules/reselect/src/weakMapMemoize.ts:172-269`
  (`weakMapMemoize` itself)
- `node_modules/.pnpm/reselect@5.1.1/node_modules/reselect/src/createSelectorCreator.ts:388-448`
  (the inner `memoizedResultFunc` + outer `argsMemoize` wrapping)

### Fit with causl's invariants

Mostly fits. The atomic-snapshot invariant is not threatened: causl
reads happen against a `resolvedState` already pinned to one
`GraphTime`, so a `WeakMap`-keyed cache that maps "this state object →
this derived value" preserves the per-commit snapshot view. Glitch
freedom is independent — the cache is keyed on the inputs themselves,
not on an intermediate value, so a stale-input read can never produce
a downstream value computed from a different commit's input.

Caveat 1: causl's `read()` does not currently take additional
parameters (no equivalent of reselect's "parametric selector" with
`(state, id)`). The N-ary tree's expressive power is wasted on a
1-argument read. The interesting subset is just the leaf `WeakMap<
stateRef, computedValue>` for object-valued inputs, which is the same
shape as React's `useSyncExternalStoreWithSelector` cache.

Caveat 2: the §15.1 Amendment (#1124) already warns adopters that
`graph.read(node)` will *not* preserve JS reference identity once the
Rust engine ships behind the FFI. A `WeakMap`-keyed cache that lives
inside causl's TS facade is safe today and degrades to "always miss"
on the Rust backend — acceptable, as long as the cache is
documented as a TS-engine-only optimisation, not a contract.

---

## 2. jotai (post-rev2 vanilla store) — atom epoch numbers + store epoch

### Technique

Every atom in jotai's vanilla store carries an `AtomState` with three
load-bearing fields:

- `d: Map<Atom, number>` — dependency map: which atoms this atom read
  last time, *and the epoch number each dependency had when it was
  read*.
- `n: number` — this atom's own epoch counter. Incremented when its
  value actually changes.
- `m: number` — the store-epoch number this atom was last validated
  against.

A separate `storeEpochHolder[0]` is the global store epoch; it is
incremented exactly once per *user-initiated write that actually
changed an input* (see `internals.js:525-528`):

```js
if (prevEpochNumber !== aState.n) {
  ++storeEpochHolder[0];
  changedAtoms.add(a);
  invalidateDependents(store, a);
}
```

The read fast-path lives in `BUILDING_BLOCK_readAtomState`
(`internals.js:306-470`). On entry, before doing *any* dependency
traversal:

```js
if (isAtomStateInitialized(atomState)) {
  if (mountedMap.has(atom) && invalidatedAtoms.get(atom) !== atomState.n
      || atomState.m === storeEpochNumber) {
    atomState.m = storeEpochNumber;
    return atomState;            // ← O(1) early exit, no dep walk
  }
  // ... fall back to per-dep epoch comparison
  for (var [a, n] of atomState.d) {
    if (readAtomState(store, a).n !== n) {
      hasChangedDeps = true; break;
    }
  }
  if (!hasChangedDeps) { atomState.m = storeEpochNumber; return atomState; }
}
```

So there are *two* short-circuits:

1. **Store-epoch sentinel** (`atomState.m === storeEpochNumber`):
   already validated this atom against the current store epoch —
   nothing has been committed since, return immediately.
2. **Per-dep epoch compare**: the dependency-map values are not the
   dependency *values*, they are the dependency *epoch numbers*. A
   miss is a single integer compare per dep, no equality on the
   payload.

### Code reference

- `packages/bench/node_modules/jotai/vanilla/internals.js:306-470`
  (`BUILDING_BLOCK_readAtomState` — the read fast-path)
- `packages/bench/node_modules/jotai/vanilla/internals.js:490-541`
  (`BUILDING_BLOCK_writeAtomState` — where the store epoch advances)

### Fit with causl's invariants

Excellent fit, and arguably the most natural borrow. causl already
maintains a per-node version counter (`nodeVersions` map at
`packages/core/src/graph.ts:1400`), and it already advances exactly
when a node's value changes per `Object.is`. What is missing is:

1. A **global commit epoch** — currently the engine has `GraphTime`
   per commit, but no monotonic integer that derived entries can
   stamp to say "I was validated up through commit N, anything that
   reads me before commit N+1 can short-circuit." The
   "fast-path dedup sentinel" comment at `graph.ts:155-161` hints
   that one already exists in some form on `lastStagedAt`, but it is
   intra-transaction, not per-commit.
2. A **per-derived dep-epoch map** — when a derived is recomputed,
   record `Map<NodeId, number>` of "what version each dep had when I
   ran." On the next read, if every dep's current version equals
   the recorded version, the derived can return its cached value
   without re-running `compute`.

The atomic-snapshot invariant is preserved exactly because that is
how jotai preserves it: epochs are stamped *at commit*, not during
reads, so a reader at commit N sees a consistent view by checking
"all deps still at the epoch they were at when I last ran." Glitch
freedom is preserved by the *order* of invalidation
(`invalidateDependents` walks all transitive dependents first, then
the recompute pass reads dep epochs in order — exactly causl's
Phase-D Kahn pass.)

---

## 3. mobx — three-state staleness + `POSSIBLY_STALE` lazy confirmation

### Technique

mobx's computed values are lazy: they do not re-run when a dependency
changes, only when they are read *and* their dependency state
indicates a recompute is needed. The state machine is in
`derivation.ts:11-29`:

```ts
enum IDerivationState_ {
  NOT_TRACKING_   = -1,  // outside batch, no deps recorded
  UP_TO_DATE_     =  0,  // no dep changed since last computation
  POSSIBLY_STALE_ =  1,  // some deep dep changed, unclear if shallow dep did
  STALE_          =  2,  // a shallow dep definitely changed
}
```

The two interesting transitions:

- A direct atom write propagates `STALE_` to its observers.
- A computed that re-runs and **does not change its result** (per
  `equals_`, default `Object.is`) propagates `POSSIBLY_STALE_` — not
  `STALE_` — to its observers. This is the load-bearing bit.

On the next read, `shouldCompute` (`derivation.ts:84-128`) returns
`false` for `UP_TO_DATE_`, `true` for `STALE_`, and for
`POSSIBLY_STALE_` it walks the dependency list *in original read
order* and short-circuits on the first dependency that confirms it
changed:

```ts
case POSSIBLY_STALE_: {
  for (let i = 0; i < obs.length; i++) {
    const obj = obs[i]
    if (isComputedValue(obj)) {
      obj.get()                              // forces upstream to settle
      if (derivation.dependenciesState_ === STALE_) {
        return true                          // ← first changed dep wins
      }
    }
  }
  changeDependenciesStateTo0(derivation)     // none changed → up-to-date
  return false
}
```

The optimisation is: a chain `A → B → C → D` where `A` writes a value
that changes but `B` produces the same output (equality cutoff at
`computedvalue.ts:258-287`) marks `C` and `D` as
`POSSIBLY_STALE_`, not `STALE_`. When `D` is eventually read, it
walks its deps; `C` walks *its* deps; they hit `B` which has already
settled to `UP_TO_DATE_`; `D` returns its cached value without ever
calling its compute. The equality cutoff at `B` short-circuits the
entire downstream chain at *first read*, lazily, without a recompute.

### Code reference

- `packages/bench/node_modules/mobx/src/core/derivation.ts:84-128`
  (`shouldCompute` — the lazy confirmation walk)
- `packages/bench/node_modules/mobx/src/core/computedvalue.ts:258-287`
  (`trackAndCompute` — where equality cutoff returns `false` and
  declines to propagate `STALE_`)

### Fit with causl's invariants

Partial fit, with a meaningful caveat. causl is *eager*: Phase-D
runs the recompute pass synchronously inside `commit`, before
returning. The §3 semantic equation `D(t) = f(B(t), C(t))` is
defended by making the entire derived closure consistent *at commit*,
not at read. Adopting mobx's POSSIBLY_STALE shape would push some
work from commit-time to first-read-time, which is observable —
commit duration would drop, first-read after commit would rise, and
glitch-freedom audit hooks (`glitchPropagation` in the property
tests) would need a new "read-time settle" pass to remain meaningful.

The *equality-cutoff propagation rule itself*, however, fits cleanly
and is the more portable subset:

> "If a derived recomputes and its new value `Object.is`-equals its
> old value, do not stamp downstream nodes as changed in this commit."

causl already does the first half (the equality cutoff at `B`); the
borrowable half is making sure the cutoff *propagates correctly
through chains of derived nodes in one commit* — the chain `A → B →
C → D` where `B` equality-cuts should never even visit `C` and `D`
in Phase D's dirty list. mobx's `lowestObserverState_` field
(`derivation.ts:248-249`) and `propagateMaybeChanged` /
`propagateChangeConfirmed` are the implementation idea: derive a
"the lowest state I've seen on any of my new deps" while binding,
and skip the entire downstream walk if it's `UP_TO_DATE_`.

This is essentially what causl's #972 + #994 fast-path already does
for *direct* inputs to a single derived — extending it to "downstream
derived chains" is the borrowable subset.

---

## Borrowable techniques, ranked by fit

| Rank | Technique                                              | Source       | Fit | Why                                                                                                                                       |
| ---- | ------------------------------------------------------ | ------------ | --- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Per-dep epoch map + global commit epoch O(1) short-circuit | jotai        | Best | causl already has a per-node version counter and a per-commit `GraphTime`. Promoting `nodeVersions` from a telemetry surface to an internal read-path key, and adding a `lastValidatedCommit: number` field on each derived entry, is additive: it preserves atomic-snapshot (epochs are stamped at commit) and preserves glitch-freedom (the recompute order is unchanged, only the *skip* check is cheaper). Replaces a per-dep value compare with a per-dep integer compare. |
| 2    | Equality-cutoff *propagation* through derived chains   | mobx         | Good | Borrows mobx's idea ("an equality-cutting derived must not propagate STALE downstream") without borrowing the lazy-read part that would change the engine's eager-commit semantics. Strengthens an existing causl fast-path (#972, #994) to chains, not just immediate downstream. No invariant change — just better Phase-D pruning. |
| 3    | `WeakMap`-keyed result cache on the read facade        | reselect     | Niche | Lives in the TS engine's `read()` facade only, not in the engine core. Useful where adopters call `read()` repeatedly with the same node + state object reference (typical in React render). Loses its effect against the future Rust backend per §15.1 Amendment (#1124), so it is a temporary TS-side speedup, not a portable engine technique. Worth the ~20 LOC if and only if benches show repeat-read pressure on the same `GraphTime`. |

Recommendation: try (1) first. It is the most aligned with causl's
existing telemetry plumbing, requires no semantic changes, and the
per-dep integer compare is the same fast-path that benches show
buying jotai its `linear-chain × 10000` advantage in the
`packages/bench` harness.
