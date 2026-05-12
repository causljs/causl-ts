# Phase D Kahn topological recompute — allocation analysis

Date: 2026-05-12
Subject: `recomputeAffected` in `packages/core/src/graph.ts` (lines 3185–3405)
Sibling helper: `recomputeCommitMetadata` (Phase F.5, lines 3439–3489) — same allocation shape.

## Why this matters

Phase D is the per-commit hot path: every `commit()` call lands here. V8's
Scavenge (young-generation GC) trips on per-commit allocations as object
churn climbs into the tens-of-thousands of derived nodes per second the
benches push through. Each `new Map()`, `new Set()`, fresh array, and
closure created inside the recompute loop is a Scavenge candidate; the
fewer Scavenges we trigger per 10k commits, the cleaner the steady-state
throughput curve.

## 1. Data structures (line 3185–3294)

The function is **NOT** named with the `changedNodes / dirty / pending`
trio described in the brief. The real local-state vocabulary is:

| Brief name        | Actual local              | Type                       | Lines      | Role                                                        |
| ----------------- | ------------------------- | -------------------------- | ---------- | ----------------------------------------------------------- |
| `pending` queue   | `queue` + `qHead`         | `NodeId[]` + monotonic idx | 3226, 3251 | BFS frontier over `dependents`; head-pointer iteration (#703 Win 4) |
| `dirty` set       | `affected`                | `Set<NodeId>`              | 3224       | Membership filter for the BFS / Kahn drain                  |
| `dirty` set       | `indegree`                | `Map<NodeId, number>`      | 3225       | Internal-edge count per affected node                       |
| Kahn ready queue  | `ready` + `rHead`         | `NodeId[]` + monotonic idx | 3272, 3280 | Nodes with zero remaining internal upstream                 |
| Topo order        | `ordered`                 | `NodeId[]`                 | 3279       | Drain output                                                |
| `changedNodes` accumulator | `changedThisCommit` | `NodeId[]`              | 3325       | Equality-cutoff survivors returned to caller                |
| Cycle-probe witness | `processedThisPass`     | `Set<NodeId>`              | 3324       | Latent-cycle probe (#705) — entries this pass already touched |

`rollback` is an external `DerivedRollbackHolder` (`{ map: Map | undefined }`,
lines 3181–3183) passed in from `commitInternal`. The holder lazy-mints
its `Map` on first write (#1010) — short-circuiting commits never pay
the allocation.

## 2. Per-iteration cost (Phase 4 loop, lines 3326–3403)

Per derived-node recompute, the loop performs:

- **`entries.get(id)`** (line 3327) — 1 Map probe to resolve `e`.
- **`computeDerived(e)`** (line 3373) — see breakdown below.
- **`m.has(id)` / `m.set(id, …)`** (lines 3364–3371) — 1 Map probe + 1 write
  per *first-touch* derived (skipped if no rollback param, or already
  recorded).
- **`processedThisPass.add(id)`** (line 3374) — 1 Set write.
- **New-dep probe** (lines 3386–3392) — up to `|e.deps|` `prevDeps.has(d)`
  lookups; early-exit on first miss.
- **`Object.is(before, e.value)`** (line 3400) — exactly 1 equality check
  per derived; the equality cutoff that gates `changedThisCommit.push(id)`.

Inside `computeDerived` (lines 2279–2377), every call allocates:

1. `nextDepsArr: NodeId[] = []` (line 2300) — fresh dep-buffer array.
2. `nextStack = [...dirtyStack, e.id]` (line 2301) — spread-clone of the recursion stack.
3. `frame: RecursiveFrame` object literal (lines 2324–2330) — 1 object,
   4–5 fields. Replaces the pre-#971 per-call closure pair (which itself
   was allocating Context slots — that was the prior GC root).
4. `frame.captured = new Map()` *only* under the §15.1 determinism
   gate (line 2329) — production runs allocate `null`.
5. `setDepsFromArray` (lines 1915–1997): on the **fast path** (dep-set
   unchanged) — zero allocations. On the **slow path** — 1 `new Set()`
   plus at most one `new Set()` per fresh `dependents` bucket (line 1969).

Inside `recordingGet` (lines 2186–2249), every `get(dep)` call performs:
- 1 `getEntry(n.id)` Map probe (line 2197).
- A linear scan over `nextDepsArr` for dedup (lines 2234–2239) — O(k) but
  k is tiny (1–3 deps typical), zero allocations.

## 3. The hot inner loop

Lines **3326–3403** — `for (const id of ordered)`. This is the loop the
trace-perf catalogue flags. Annotated control flow:

```
3326  for (const id of ordered) {              // single allocation: iterator state on Array (negligible, JIT-inlined)
3327    const e = entries.get(id)               // Map probe #1
3328    if (!e || e.kind !== 'derived') continue
3329    const before = e.value                  // capture pre-recompute snapshot
3330    const wasComputed = e.computed
3337    const prevDeps = e.deps                 // capture by reference (#703 Win 3 — NO clone)
3351    if (rollback !== undefined) {
3359      let m = rollback.map                  // lazy-mint the rollback Map
3360      if (m === undefined) {
3361        m = new Map<NodeId, DerivedRollback>()   // ALLOCATION (once per commit)
3362        rollback.map = m
3363      }
3364      if (!m.has(id)) {
3365        m.set(id, { value, deps, computed, lastTime })  // ALLOCATION (DerivedRollback record per first-touch)
3371      }
3372    }
3373    computeDerived(e)                       // see §2 — allocations: nextDepsArr, nextStack, frame, maybe Set
3374    processedThisPass.add(id)
3386    let hasNewDep = false
3387    for (const d of e.deps) {               // new-dep probe — read-only
3388      if (!prevDeps.has(d)) { hasNewDep = true; break }
3392    }
3393    if (hasNewDep) { findCyclePathFrom(e.id); ... }   // cold path
3400    if (!wasComputed || !Object.is(before, e.value)) {
3401      changedThisCommit.push(id)            // equality cutoff: most rows skip this
3402    }
3403  }
```

Phases 1–3 (3224–3294) run **once per commit**, not per derived. They
allocate: 1 `Set<NodeId>` (`affected`), 1 `Map<NodeId, number>` (`indegree`),
3 `NodeId[]` arrays (`queue`, `ready`, `ordered`). All are scoped to the
function and thrown away on return — single-generation Scavenge food.

## 4. Allocation hot-spots (per-commit, ranked)

| Rank | Allocation                                  | Site             | Per-commit count                  | Notes |
| ---- | ------------------------------------------- | ---------------- | --------------------------------- | ----- |
|  1   | `nextDepsArr: NodeId[] = []`                | line 2300        | 1 × every recomputed derived      | Always allocated, even when dep-set is unchanged |
|  2   | `nextStack = [...dirtyStack, e.id]`         | line 2301        | 1 × every recomputed derived      | Spread-clone on every call (size grows with recursion depth) |
|  3   | `frame: RecursiveFrame { … }`               | lines 2324–2330  | 1 × every recomputed derived      | Object literal; replaces pre-#971 closure-pair shape |
|  4   | `DerivedRollback { value, deps, … }`        | lines 3365–3370  | 1 × every first-touch derived (when `rollback` provided) | Skipped if commit is rollback-free |
|  5   | `affected: Set<NodeId>`                     | line 3224        | 1 × commit                        | Scales with affected-subgraph size |
|  6   | `indegree: Map<NodeId, number>`             | line 3225        | 1 × commit                        | Could fuse with `affected` via paired flat-array (see §5 rec 2) |
|  7   | `queue / ready / ordered: NodeId[]`         | 3226, 3272, 3279 | 3 × commit                        | Small wrapper overhead; payload grows with affected-set size |
|  8   | `new Set()` in `setDepsFromArray` slow path | line 1942        | 0 × steady-state (fast-path elides) | Slow path is the dep-shift case; steady-state recompute keeps the same set |
|  9   | `rollback.map = new Map()`                  | line 3361        | 0 or 1 × commit (lazy-mint #1010) | Already amortised; included for completeness |

Allocations 1–3 fire **per recomputed derived**. For a 1k-affected commit
that is 3000 short-lived objects feeding the next Scavenge — the dominant
GC pressure source on the `linear-chain × 1k` benchmark.

## 5. Fast path (equality cutoff)

The propagation cutoff is the `Object.is(before, e.value)` check on
line 3400. When most derived values are stable, this is the **only**
side-effect of the iteration:

- `e` is recomputed (allocations 1–3 fire regardless — equality is checked
  *after* compute, not before).
- `setDepsFromArray` short-circuits at line 1935 because `prev.deps`
  matches the rebuilt read-set (no new Set, no dependents-map churn,
  no `commitLogConsumerCount` touch).
- `changedThisCommit.push(id)` is skipped, so the downstream propagation
  in subsequent commits sees a smaller seed.

There is **NO pre-compute equality short-circuit**: the loop unconditionally
calls `computeDerived(e)` before comparing. That is by design —
input changes upstream may not change `e.value`, but the engine cannot know
that without running `e.compute`. The fast-path savings are downstream
(via the equality cutoff feeding the next commit's seed), not within the
current commit.

## 6. Three concrete recommendations

### Rec 1 — Pool `nextDepsArr` across compute calls (allocation #1, line 2300)

The dep-buffer array is allocated fresh on every `computeDerived` call and
discarded after `setDepsFromArray` consumes its first `len` slots. Replace
with a single engine-scope `Array<NodeId>` pool keyed by recursion depth
(or a re-usable per-frame slot in a thread-local stack). The `nextDepsLen`
counter already provides logical length, so a backing array can grow
monotonically with `arr.length === capacity` and the dedup loop reads only
`[0, len)`. Eliminates one array allocation per derived recompute.

Risk: `setDepsFromArray` retains a *reference* to the array only for the
duration of the call (it copies into a new Set on the slow path, and on
the fast path it copies nothing). Pool reuse is safe across calls because
the buffer is read-only beyond `len` and overwritten on next compute.

### Rec 2 — Replace `dirtyStack`-spread (allocation #2, line 2301) with a single mutable stack

`nextStack = [...dirtyStack, e.id]` clones the recursion stack on every
call so `computeDerived` can pass it down recursively. Replace with a
single shared `currentDirtyStack: NodeId[]` that the recursive call site
`push`/`pop`s around the inner `computeDerived(dep, …)` invocation
(line 2221). The cycle check `dirtyStack.includes(e.id)` (line 2284) reads
just as well from a shared array, and `[...dirtyStack, e.id]` becomes
`stack.push(e.id); try { … } finally { stack.pop() }`. Eliminates one
spread-clone allocation per derived recompute; payoff scales with chain
depth.

Risk: requires every throw site downstream to be inside the try/finally so
the pop fires on `CycleError` / `NonDeterministicComputeError` /
`MissingUpstream` propagation. The existing structure already has a
finally for `activeRecording` save/restore (line 2331–2338); piggy-back.

### Rec 3 — Fuse `affected` + `indegree` into a single typed-array structure

`affected: Set<NodeId>` and `indegree: Map<NodeId, number>` carry the same
key set with parallel payloads (membership / count). Replace with a
single `Map<NodeId, number>` where `has(id)` substitutes for
`affected.has(id)` and the value is the indegree (sentinel `-1` for
"discovered but not yet incoming-counted" if needed). Saves one Set
allocation per commit, halves the hash-probe count in the BFS body
(lines 3257–3267) since `affected.has` and `indegree.get` merge into one
`indegree.has` call, and shrinks the resident size of the affected-subgraph
working set by ~50% (one hash table vs two).

Risk: zero — the two structures are written/read in lockstep already;
sentinel choice (use `0` as "discovered, no internal edge yet") is the
natural lift since the Kahn seed loop (line 3273) is already a
`d === 0` filter.

## Cross-reference

- `recomputeCommitMetadata` (lines 3439–3489) shares allocations #3, #4
  via the same `computeDerived` path plus the same `DerivedRollbackHolder`
  lazy-mint. Recs 1–2 apply unchanged; rec 3 is N/A (no BFS / Kahn).
- Property-test gate for any refactor:
  `packages/core/test/properties/phase-d-entry-capture.property.test.ts`
  (1000+ random topologies × random commit storms — denotational
  equivalence regardless of walker shape).
- Trace-perf baseline: `linear-chain × 1k` INTERPRETATION.md, `getEntry`
  at 0.64% engine-self-time (rank 25), below the 100 µs `--cpu-prof`
  sampler floor — any of Rec 1/2/3 would need a bench-engine catalogue
  rerun to certify above the noise floor before shipping (#883 / #917 /
  #931 negative-finding precedents).
