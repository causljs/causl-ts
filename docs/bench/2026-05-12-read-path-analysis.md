# causl `graph.read(node)` + derived-`get` path analysis

Source: `packages/core/src/graph.ts` (commit `67a67bba`, 6933 LOC).

This is a deep-read of the two hot read paths in the engine:

1. The public `graph.read(node)` surface — used by adapters (`@causljs/react`),
   tests, and direct callers.
2. The `get(node)` accessor passed into derived `compute()` callbacks — the
   intra-engine dependency-recording read.

Both ultimately funnel through `readEntryFromResolved`, but their preludes
differ in important ways.

---

## 1. Annotated control flow

### 1.1 Public surface — `graph.read(node)`

The exposed handle is built at the bottom of `createCausl`:

```ts
// graph.ts:6667
read: <T,>(node: Node<T>) => read<T>(node),
```

That arrow indirection is one extra (monomorphic, inline-able) call frame
per read. The actual implementation (`graph.ts:2916`) is:

```
read<T>(node)                                  // graph.ts:2916
  ├─ readEntry(node)                           // graph.ts:1614
  │    ├─ getEntry(node.id)                    // graph.ts:1590
  │    │    └─ entries.get(id)                 // Map lookup
  │    │       + disposed.get(id) on miss
  │    └─ readEntryFromResolved(e, node)       // graph.ts:1640
  │         ├─ if (activeReadTracker) tracker.add(e.id)    // #701
  │         ├─ if input:
  │         │   if (stagedActive && e.lastStagedAt === now)
  │         │     return stagedWriteValues[e.lastStagedRow]   // #995
  │         │   return e.value
  │         ├─ if COMMIT_LOG_ID and stale:
  │         │   e.value = buildCommitLogValue()
  │         ├─ if derived && !e.computed:
  │         │   computeDerived(e)              // lazy first-eval
  │         └─ return e.value
  └─ if (process.env.NODE_ENV !== 'production'):  // graph.ts:2946
       if (h1HazardTrack && !activeReadTracker
           && adapterReadDepth === 0
           && value is object/function):
         h1HazardTrack.push({ ref: new WeakRef(value), nodeId, capturedAt })
         if (length > 4096) pruneH1HazardTrack()
     return value
```

### 1.2 Inside a derived's `compute(get)` body

The `get` accessor that `derived(id, (get) => …)` callbacks see is **not**
a per-call closure. Since #971 it is a single, hoisted, module-private
function `recordingGet` (`graph.ts:2186`) backed by a thread-local frame
slot `activeRecording` (`graph.ts:2177`).

The driver — either the recursive `computeDerived` (`graph.ts:2279`) or
the iterative `computeDerivedIterative` (`graph.ts:2437`) — does:

```
const prevRecording = activeRecording
activeRecording = frame              // RecursiveFrame | IterativeFrame
try {
  next = e.compute(recordingGet)     // user code calls get(n)
} finally {
  activeRecording = prevRecording    // save/restore for nested compute
}
```

Each call into `recordingGet(n)`:

```
recordingGet<U>(n)                              // graph.ts:2186
  ├─ rec = activeRecording                       // 1 closure-slot load
  ├─ if rec === null throw                       // unreachable on hot path
  ├─ dep = getEntry(n.id)                        // Map.get + miss-branch
  ├─ if dep.kind === 'derived':
  │    if rec.kind === 'iterative':
  │      if rec.inFlight.has(n.id) → CycleError
  │      if !dep.computed → throw MissingUpstream(id)
  │    else (recursive):
  │      if !dep.computed → computeDerived(dep, rec.dirtyStack)
  ├─ linear-scan dedup over rec.nextDepsArr[0..nextDepsLen]   // #880
  │    if not already → arr[len++] = id
  ├─ value = readEntryFromResolved(dep, n)       // #964 – avoids 2nd probe
  ├─ if rec.captured !== null:                   // §15.1 invariant gate (off by default)
  │    captured.set(n.id, value)
  └─ return value
```

So: **no `Proxy`, no per-call closure**. Dependency tracking is a
thread-local *current-compute-frame ref* (`activeRecording`) read by a
single hoisted function. Save/restore wraps each compute to support
nested derivation evaluation.

---

## 2. Where the per-read cost lives

### 2.1 Direct `graph.read(node)` (production, steady state)

Per call, in order, on an input read with no staging active:

| Step | Cost |
|---|---|
| `read` arrow wrapper (`graph.ts:6667`) | 1 call frame, inlineable |
| `read` body | 1 `process.env.NODE_ENV !== 'production'` check (DCE-able) |
| `readEntry` | 1 call frame |
| `getEntry` | 1 `Map.get`, 1 truthy check, no miss branch |
| `readEntryFromResolved` | 1 call frame |
| `activeReadTracker !== null` | 1 null check |
| `e.kind === 'input'` | 1 string equality |
| `stagedActive` && `lastStagedAt === now` | 2 boolean/number compares |
| `return e.value` | 1 field load |

**Function calls per read: 4** (`read` arrow → `read` → `readEntry` →
`readEntryFromResolved`; `getEntry` either inlines or counts as a 5th).
**Allocations per read: 0** in production. The H1 hazard tracker
(`new WeakRef` + record literal) is dead-code-eliminated when
`NODE_ENV === 'production'` (`graph.ts:2946`).

In dev with H1 armed, every non-primitive read costs **one WeakRef
allocation + one record-object allocation** plus a periodic O(N) prune
when the ring exceeds 4096 entries. That is the dominant per-read cost
in dev.

### 2.2 `get(node)` inside a derived compute

Same `readEntryFromResolved` tail, but with extra work in front:

| Step | Cost |
|---|---|
| `recordingGet` call | 1 frame |
| `activeRecording` load + null check | 1 load, 1 check |
| `getEntry(n.id)` | 1 `Map.get` |
| derived-branch (kind check) | 1 string compare |
| dedup linear scan over `nextDepsArr` | O(k), k = unique deps so far (typically 1–3) |
| append-on-miss | 1 array index write + len++ |
| `readEntryFromResolved` | as above |
| `captured.set` | only when §15.1 gate on (off by default) |

**Function calls per `get`: 3** (`recordingGet` → `getEntry` → `readEntryFromResolved`).
**Allocations per `get`: 0** in production with the §15.1 gate off — the
frame object is allocated **once per compute**, not per `get`. The
historical pre-#971 shape allocated one closure per `get` call; that has
been eliminated.

The dominant per-`get` cost in production is therefore: 1 `Map.get`, 1
linear-scan dedup (typically 1–3 compares), 1 kind-discriminator branch,
and the `readEntryFromResolved` tail. No hash, no closure, no proxy
trap.

### 2.3 Equality cutoff — where propagation actually stops

Two distinct cutoffs gate downstream work:

1. **Write-side input cutoff** (`graph.ts:3911`): on `tx.set(input, v)`
   for an input with no dependents, `if (Object.is(e.value, value)) return`.
   The write never enters Phase B/C/D — no staging row, no rollback push,
   no recompute. This is the cheapest possible no-op write.

2. **Recompute-side derived cutoff** (`graph.ts:3400` and `:3484`): after
   a derived's `compute` returns, the engine compares the new value to
   the cached one:

   ```ts
   if (!wasComputed || !Object.is(before, e.value)) {
     changedThisCommit.push(id)
   }
   ```

   An unchanged result is **not** added to `changedThisCommit`, which
   means it does not propagate to downstream derivations or to
   subscribers. Subscribers themselves re-apply the same cutoff at
   delivery (`graph.ts:3695`): `if (!sub.hasFired || !Object.is(sub.lastValue, v))`.

The derived cutoff fires *after* `compute` runs — the engine does pay the
compute cost, then short-circuits the propagation. SPEC §15.1 names
`Object.is` (not `===`) so `NaN === NaN` and `+0 vs -0` behave the same
as in `Map`/`Set`.

---

## 3. Three recommendations to make `read` faster

These are ordered by expected impact relative to implementation risk. All
preserve the existing public surface and SPEC §15.1 semantics.

### R1 — Collapse the public `read` arrow wrapper

`graph.ts:6667` exposes `read: <T,>(node: Node<T>) => read<T>(node)`. The
wrapper is a generic-arrow over the inner `read` and exists only because
the handle object is built once. V8 will inline it most of the time, but
the indirection still appears on flame graphs and prevents the H1
NODE_ENV guard inside the inner `read` from being hoisted past the
wrapper.

Either:

- Assign the inner `read` directly to the handle slot
  (`read: read as <T,>(n: Node<T>) => T`), or
- In production builds, replace the handle's `read` slot with
  `readEntry` directly (the H1 tracker is DCE'd anyway), saving one
  frame **and** one `process.env` check per read.

Expected: ~5–10% reduction in steady-state `graph.read` self-time for
tight read loops (e.g. viewport-render fan-outs).

### R2 — Specialize the input fast path

`readEntryFromResolved` always pays:

1. `activeReadTracker !== null` null check (only true under
   `subscribeReads`, a < 1% surface),
2. `e.kind === 'input'` discriminator (always true for inputs),
3. `stagedActive && e.lastStagedAt === now` (only true mid-commit).

For the dominant case — a steady-state read of an input outside a
commit — every one of these is dead work. Split into two dedicated
helpers:

- `readInputCommitted(e)` — returns `e.value` with no staging probe.
  Used when `stagedActive === false` (the read-only-outside-commit case
  that covers 95%+ of adopter calls).
- `readEntryFromResolvedSlow` — the existing body, used inside
  `commit` / `simulate` frames.

Gate selection on the `stagedActive` slot at the `readEntry` level. The
discriminator collapses from a 3-branch chain to a single boolean check
that V8 will inline; the input read becomes one `Map.get` + one boolean
+ one field load.

### R3 — Inline the dep-dedup into the hot `recordingGet` shape

The linear-scan dedup at `graph.ts:2234–2243` is correct and cheap for
small dep sets, but `recordingGet` is the per-edge cost of every derived
in the graph. Two micro-opts compose:

- **Skip dedup for kind === 'derived' with `computed === true` AND a
  predictable single-use pattern.** Most derived `compute` bodies read
  each upstream exactly once (the canonical `(get) => get(a) + get(b)`
  shape). The dedup loop is dead work for these. A `frame.singleUseHint`
  flag set on the first compute and cleared on any duplicate could
  short-circuit the scan; the dep-array would self-correct on the next
  recompute if the hint was wrong (over-record is already the
  conservative behaviour for §15.1).

- **Hoist `getEntry` to a direct `entries.get(id)` + inline tombstone
  check.** `getEntry` adds a frame + a throw-path that's never taken on
  the hot path. Inlining the `Map.get` and falling back to the slow path
  on undefined keeps the success branch as one Map probe with no extra
  frame.

Together: `recordingGet` collapses to (load `activeRecording`, one
`Map.get`, one kind branch, one array append, one
`readEntryFromResolved` call). Steady-state cost approaches a single
property access plus bookkeeping.

---

## Appendix — function-call & allocation summary

| Path | Frames | Allocations (prod) | Allocations (dev, gate off) |
|---|---|---|---|
| `graph.read(input)` outside commit | 4 | 0 | 0 (1 WeakRef + 1 record if H1 armed) |
| `graph.read(input)` inside commit, staged | 4 | 0 | 0 (same H1 caveat) |
| `graph.read(derived)` already computed | 4 | 0 | 0 (same H1 caveat) |
| `graph.read(derived)` first lazy eval | 4 + compute | depends on compute | depends on compute |
| `get(input)` in compute | 3 | 0 | 0 |
| `get(derived)` in compute, computed | 3 | 0 | 0 |
| Derived recompute body, no §15.1 gate | 1 frame object/compute | 1 frame literal + 1 dep-array if shape changed | same |

The §15.1 invariant-gate path (`flags.assertDeterministicCompute`)
doubles compute work and adds a `Map<NodeId, unknown>` per recompute; it
is off by default and irrelevant to production cost.
