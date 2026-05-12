# V8-engine lens on causl's hot paths

Date: 2026-05-12
Lens: Eich / Wirfs-Brock — what does Crankshaft/Maglev/TurboFan see when
the bench harness drives Phase D + `read()` at `equality-cutoff × 10000`?
File under audit: `packages/core/src/graph.ts` (6933 LOC), plus the
adapter dispatch table in `packages/core/src/internal-dispatch.ts`.

---

## 1. Hidden-class stability — `commitInternal` (graph.ts:3823)

### Findings

**Good (already audited):** the `Commit` envelope at graph.ts:4252 and
the early-exit fast-path Commit at graph.ts:4228 both construct the
record as a single literal with every field present, including the
optional `originatedAt` (always set, even when `undefined`). The
comment cites `#703 Win 5 / #760` — the explicit-`| undefined` typing
keeps the fast-path and slow-path Commit on one hidden class. Same
pattern at graph.ts:4292 for the in-memory `IRCommit` push, so the
history array stays PACKED-Object across all entries.

**Good:** `makeInputEntry` (graph.ts:626) writes every field at the
literal — `kind, id, value, node, lastWriteTime, hasDependents,
lastStagedAt, lastStagedRow` — in declaration order. The docstring
explicitly warns: "appending a field (or reordering one) here
regresses the V8 hidden-class monomorphism guarantee."

**Risk — `tx` literal (graph.ts:3865):** a fresh `tx` object is
allocated *per commit* with a single `set` method. The shape is
trivially monomorphic, but the construction site sits inside
`commitInternal`, so V8 attaches the allocation-site feedback to that
SFI rather than to a module-level constructor helper. Promoting the
literal to a module-level `makeTxFor(state)` (mirroring
`makeInputEntry`'s extraction at graph.ts:626) would let
`pretenureInputAllocationSites` warm the SFI alongside the other
inputs. Today the first ~K commits in a fresh process still pay the
allocation-site retune for the `tx` literal.

**Risk — `derivedRollback` holder (graph.ts:3985):** allocated as
`{ map: undefined }` and only later mutated to `{ map: <Map> }` on the
first derived recompute that needs to record pre-state (inside
`recomputeAffected`, graph.ts:3362: `rollback.map = m`). This is a
classic hidden-class transition: the holder is constructed in one
shape (`map: undefined`) and migrates to a second shape (`map: Map`)
mid-commit. The comment at the construction site argues amortisation
("Commits whose Phase D short-circuits never allocate the inner Map"),
which is correct for the empty-derivation fast path, but every commit
that **does** touch a derived pays the transition. Pre-initialising
`map: new Map()` would keep the holder on one shape at the cost of
one Map allocation per commit on the slow path — net win if more
than ~1/3 of commits touch a derived (the canonical
`scrolling-viewport` and `equality-cutoff` workloads do).

**Risk — `commitHistorySnapshot` (graph.ts:4002):** declared `let
commitHistorySnapshot: IRCommit[] | null = null`, then conditionally
reassigned at graph.ts:4267 when `commitMetadataIds.size > 0`. Two
shapes again (`null` vs. `Array`). Less hot than `derivedRollback`
because the conditional gate filters out adopters with zero
commit-metadata-derived registrations entirely, but the same
`pre-initialise vs. lazy-allocate` audit applies.

---

## 2. Inline-cache state — `read()` and `recordingGet`

### Findings

**`read()` (graph.ts:2916) is monomorphic at the call site:** every
adopter call funnels through `readEntry → readEntryFromResolved`
(graph.ts:1640), then dispatches once on `e.kind === 'input'`. The
dev-only H1 hazard tracker is wrapped in
`process.env.NODE_ENV !== 'production'` so production reads see a
clean monomorphic IC on the `node.id → Map → entry → value` chain.

**`recordingGet` (graph.ts:2186) is the megamorphism risk.** The
recorder is module-scope (`#971` hoist) but dispatches internally on
`rec.kind === 'iterative' | 'recursive'` (graph.ts:2199, 2215) AND on
`dep.kind === 'derived'` (graph.ts:2198). Within a single
`compute(get)` call the `rec.kind` is stable, so V8's branch
prediction should converge — but the IC on the call site
(`e.compute(recordingGet)` at graph.ts:2336 and graph.ts:2505) sees
**every adopter compute function** dispatched through the same
recorder. With N distinct user-supplied `compute` callbacks, the
`e.compute` call site is megamorphic by construction (more than ~4
hidden classes for `e.compute`'s receiver `e`). The mitigation
already in place is to thread the resolved entry shape through one
`DerivedEntry` constructor at graph.ts:2618, so the receiver `e` IS
monomorphic; the dispatch megamorphism is **only on the closure
identity of `compute`** itself, which is intrinsic to a fan-out
graph and not actually a deopt.

**`readEntryFromResolved` (graph.ts:1640) ICs:** the `e.kind === 'input'`
branch at graph.ts:1661 is the only place the bimorphic `InputEntry |
DerivedEntry` discriminator fires. Both shapes have a `kind: string`
slot in the same declaration order (graph.ts:144 and graph.ts:251), so
V8's IC stays bimorphic, not megamorphic. The
`stagedActive && e.lastStagedAt === now` probe at graph.ts:1662 is two
Smi field loads — exactly the V8-friendly shape the `#995` audit
engineered.

---

## 3. Allocation-site tenuring

### Findings

**Already addressed (#1036 + #1132):** `pretenureInputAllocationSites`
(graph.ts:757) warms the SFIs for `makeInputNode`, `makeInputEntry`,
and the per-instance `input()` closure. The PRETENURE_WARMUP_COUNT is
`2 ×` the bench-gate scale (20 000) — sufficient for the documented
deopts.

**Residual sites NOT covered by the warmup:**

1. **`tx` literal at graph.ts:3865** — per-commit allocation, SFI is
   `commitInternal`. Tenuring decision flips on the first ~100 commits
   in a fresh process. The pretenure loop does not exercise this site
   (no `commit()` call). Recommended: add a single
   `g.commit('__pretenure__', tx => {})` to the warmup body so the
   `commitInternal` SFI converges before any user-driven commit.

2. **`inputRollbackEntries / inputRollbackPriorValues /
   inputRollbackPriorLastWrite` triple at graph.ts:3859–3861** — each
   `const x: T[] = []` is a separate allocation site, attached to
   `commitInternal`. The `#993` audit (graph.ts:4077 comment block)
   documented the historical `wrong map` deopts here from the
   per-push elements-kind cycling; the fix was to pre-grow via
   `arr.length = cap` rather than per-row `.push()`. That fix removes
   the **elements-kind** flip, but the **tenuring** flip still hides
   here on a fresh process. The warmup commit suggested above also
   exercises this site.

3. **`new Map<NodeId, number>()` for indegree at graph.ts:3225 and
   `new Set<NodeId>()` for `affected` at graph.ts:3224** — allocated
   fresh on every Phase D walk, never warmed. These are intrinsically
   per-commit and reachable only via `commit()`. The warmup commit
   would also need at least one derived registered to exercise these.

---

## 4. For-in / iteration

### Findings

**No `for…in` usages in `packages/core/src/graph.ts`.** Grep
`grep -nE "for \([^;]+ in " graph.ts` returns zero hits. Iteration
is uniformly via `for (const x of <iterable>)` or indexed
`for (let i = 0; i < n; i++)` — both V8-fast.

**Three `Object.entries(...)` call sites (graph.ts:5853, 5941, 6092)
in cold paths only:** snapshot/hydrate import, not recompute. Each
allocates a tuple array per key; replacing with `for (const k of
Object.keys(snap.inputs)) { const v = snap.inputs[k]; … }` would
shave the tuple allocation on the hydrate path, but hydrate is a
once-per-mount operation and is not on the recompute hot path.
Negligible. Leave as-is.

---

## Three concrete recommendations

### R1 — Pre-allocate `derivedRollback.map` (graph.ts:3985)

Change

```ts
const derivedRollback: DerivedRollbackHolder = { map: undefined }
```

to

```ts
const derivedRollback: DerivedRollbackHolder = { map: new Map<NodeId, DerivedRollback>() }
```

and drop the lazy-mint branch at graph.ts:3359. Keeps the holder on
one V8 hidden class across the entire commit lifecycle. Cost: one
extra empty-Map allocation per commit when Phase D short-circuits;
benefit: zero hidden-class transition for every commit that does
touch a derived, which is the steady-state workload.

### R2 — Add a `commit()` warmup leg to `pretenureInputAllocationSites`

After the input-creation loop at graph.ts:790, register one derived
on the throwaway graph and run a single `commit('__pretenure__', tx
=> tx.set(node, 1))`. This drives the `commitInternal` SFI through
its first tenuring decision so the `tx` literal, the
`inputRollback*` arrays, and the `recomputeAffected` `Map / Set / []`
sites all converge **before** any user-measured workload. Closes
the residual three sites from §3 above with a one-time ~0.5ms
warmup increment.

### R3 — Promote `tx` to a module-level constructor

Extract `commitInternal`'s `tx` literal (graph.ts:3865) into a
sibling helper `makeTx(graphState): Tx`, analogous to
`makeInputEntry`. Single SFI for the allocation site, single hidden
class, same monomorphism guarantee `#703 Win 5` already buys for
`Commit` and `IRCommit`. The captured engine-closure references
(`getEntry`, `stagedWriteEntries`, …) thread through the
`graphState` parameter rather than via free-variable capture, which
also kills the per-commit closure-context allocation V8 currently
attaches to the `set` arrow.

---

## Out-of-scope but worth noting

- The `compute(get)` megamorphism in §2 is intrinsic to the fan-out
  graph shape — no V8-side fix is possible without sacrificing the
  pure-function semantics SPEC §3 commits to. The mitigation already
  applied (`recordingGet` is module-scope, `e` is monomorphic) is
  the right ceiling.
- The H1 hazard tracker (graph.ts:2946–2966) is fully tree-shaken at
  `NODE_ENV=production`. Verified clean.

---

## Cross-references

- `packages/bench/report/engine-status.md` — deopt baseline this
  audit checks against.
- `packages/bench/report/engine-status-deopts/SUMMARY.md` — the
  `#917` / `#883` / `#881` audit notes that established the
  monomorphism contract for Commit / InputEntry literals.
- PR #1036 — closed the original `makeInputNode` / `makeInputEntry`
  tenuring deopt pair via the pretenure warmup loop.
- PR #1132 — extended the warmup to the per-instance `input()`
  closure SFI after the `#1123` audit surfaced a second tenuring
  flip attributed to the enclosing closure.
