# Version-counter graph (jotai-style epoch) — investigation

**Status:** research memo, no code changes.
**Issue:** #676 (closed `completed` 2026-05-07; the audit-revised
`experimental/epoch-spike` prototype + ≥ 2× bench gate was not
commissioned post-blockers, and the line of inquiry was retired in
favour of the WASM substrate epic #680 — see §5.5 below). The TS-side
recommendation in this memo (**defer**) was effectively converted to
**not pursued** at issue closure: the cross-link argument in §5.5 stands,
and the epoch design now lives natively in the Rust/WASM backend
under EPIC #680 (closed 2026-05-10; 17 sub-issues merged across
Phase-0 + Phase-1 scaffolding).
**Verdict:** **defer** (recommendation summarised at the end; reasoning below).

## 0. What this memo is

#676 asked: should causl swap its per-derived `lastTime: GraphTime`
field for a jotai-style per-atom epoch counter `n`? The audit's hope
was that an integer-vs-integer compare on epochs would beat the
current "Object.is on the value" equality cutoff and fold the
"is this dep stale?" question into one cheap unsigned increment.

This is a memo, not a prototype. The issue's exit criterion calls for
a `experimental/epoch-spike` branch and a paired bench delta; this PR
is the research half (model reading + invariant analysis) that should
land *before* anyone writes the spike. The recommendation below is
phrased to either commission the spike with a concrete acceptance
gate or close the line of inquiry depending on which evidence the
spike collects.

## 1. Jotai's epoch model — what's actually there

Read against jotai's vanilla store at
[`pmndrs/jotai/src/vanilla/internals.ts`](https://github.com/pmndrs/jotai/blob/main/src/vanilla/internals.ts)
(commit on `main`, fetched 2026-05).

### 1.1 Per-atom state

```ts
type AtomState<Value> = {
  readonly d: Map<AnyAtom, EpochNumber>  // dep → epoch-when-read
  readonly p: Set<AnyAtom>               // pending-promise dependents
  n: EpochNumber                          // this atom's own epoch
  m?: EpochNumber                         // store-epoch when last validated
  v?: Value                               // value
  e?: AnyError                            // thrown error (alt-arm)
}
```

Three counters compose:

- `n` (per-atom): the atom's own epoch. Bumped iff a write or
  recompute lands a *value-distinct* (`Object.is`-distinct) value.
- `d` (per-dep): a `Map<dep, epoch-when-read>`. Each entry says
  "when I last computed, dep had epoch `k`". This is the
  freshness contract: if `dep.n !== k`, the cached value is stale.
- `m` and `storeEpoch`: a coarser store-wide counter incremented per
  write so unmounted atoms can short-circuit re-reads when nothing in
  the store has moved at all.

### 1.2 Where `n` is incremented

Two sites, both in `BUILDING_BLOCK_setAtomStateValueOrPromise`
(lines ~1054–1082) and the catch arm of
`BUILDING_BLOCK_readAtomState` (line ~814):

```ts
// setAtomStateValueOrPromise
if (!hasPrevValue || !Object.is(prevValue, atomState.v)) {
  ++atomState.n
}

// readAtomState catch (a thrown compute counts as a value-distinct landing)
} catch (error) {
  delete atomState.v
  atomState.e = error
  ++atomState.n
}
```

The increment is **always gated on `Object.is`** (or on the catch
arm). The epoch is *not* a "tick per write" — it is a "tick per
distinct value." A write that lands the same value as before never
moves `n`. This is the same equality cutoff causl spells `Object.is`
against `e.value` in Phase B / Phase D / Phase F.5, expressed as
"did the counter move?" rather than "did the value change?".

### 1.3 Where `n` is compared

`BUILDING_BLOCK_readAtomState` line 677:

```ts
let hasChangedDeps = false
for (const [a, n] of atomState.d) {
  if (readAtomState(buildingBlocks, store, a).n !== n) {
    hasChangedDeps = true
    break
  }
}
if (!hasChangedDeps) {
  atomState.m = storeEpochNumber
  return atomState   // ← cache hit; skip recompute entirely
}
```

This is the load-bearing read. For each cached dep, jotai compares
the dep's current `n` against the `n` jotai recorded the last time
this atom evaluated. *If every dep's epoch matches, jotai skips the
compute entirely and returns the cached value.*

This is the seam the audit pointed at. Causl, by contrast, has no
"skip compute by counter" mechanism — Phase D's
`recomputeAffected` walks the affected sub-graph from
`changedInputIds` via `dependents` and unconditionally recomputes
every entry it visits, only short-circuiting *after* compute via
the `Object.is(before, e.value)` post-recompute equality cutoff.

### 1.4 Invariants the epoch model carries in jotai

- **Glitch-freedom.** A topological pre-pass
  (`BUILDING_BLOCK_recomputeInvalidatedAtoms` lines 546–633) sorts
  changed atoms before fanning out, so a derived sees consistent
  upstream epochs. Same property causl gets from Phase D's Kahn pass.
- **Equality cutoff.** Encoded as "epoch didn't move." Same
  observable contract as causl's `Object.is(before, e.value)`.
- **Cache validity.** A cached atom is still fresh iff `∀ dep:
  dep.n === atomState.d.get(dep)`. This is the *new* property — causl
  has nothing equivalent because it has no "skip compute" path; every
  affected derived recomputes once per commit.

### 1.5 What jotai does *not* have

- **No commit envelope.** A jotai write is a synchronous walk on the
  affected sub-graph; there is no "Phase E assembles a Commit record"
  step. The store epoch advances per write, the per-atom epoch
  advances per value-distinct landing, and that is the entire
  observability surface for change.
- **No retention buffer.** Past values are not retained. A jotai atom
  has no analog of `readAt(node, t)` or `snapshotAt(t)`.
- **No replay determinism.** Jotai's contract is "the store has a
  current value;" causl's §15.1 contract is "given the same input
  trace, the same `Commit` sequence is replayable byte-identically."
  Jotai's epoch counters are runtime-state, not part of any wire
  format.

These three absences are exactly the structural reasons epoch alone
is not a drop-in for `lastTime` in causl — section 4 below.

## 2. Causl's `lastTime` model — what's actually there

Read against `packages/core/src/graph.ts` HEAD on this branch.

### 2.1 What `lastTime` is

`DerivedEntry.lastTime: GraphTime` is the engine clock value at which
this derivation last successfully recomputed. Sister field on
`InputEntry` is `lastWriteTime: GraphTime`, stamped at Phase C.5 of
`commit` for inputs whose value actually moved (`Object.is`-distinct
in Phase B).

### 2.2 Where it's written

Five sites (line numbers reflect `graph.ts` HEAD as of v0.9.0; the
file has grown since the original memo — the commitInternal driver
now starts at line 3507):

1. `commitLogEntry` initialisation at the genesis seed (line 1374):
   `lastTime: 0`.
2. The commitLog lazy-rebuild fallback in `readEntry` (line 1529):
   `e.lastTime = now` after rebuilding from `commitHistory` on a
   bare `g.read(g.commitLog)` against a stale cache.
3. `computeDerived` (line 2222): `e.lastTime = now` after a
   successful compute. This is the canonical write site — every
   Phase D recompute and every Phase F.5 commit-metadata recompute
   funnels through here.
4. `computeDerivedIterative` (line 2442): identical write inside
   the iterative driver used by registration-time eager compute
   (#670, closed 2026-05-07).
5. `derived` registration (line 2570): seeded to the current `now`
   at registration time so a derivation that never recomputes still
   has an honest stamp matching its `derivedRegisteredAt`.

There is also a *rollback restore* site in both `commit` and
`simulate` catch arms (lines 4159 and 4564) where the
pre-recompute `lastTime` is restored as part of the byte-identical
atomicity contract.

### 2.3 Where it's read

Two consumer surfaces:

1. **`Graph.explain`** (`buildExplanation`, lines 5130–5174).
   `lastTime` populates `Explanation.computedAt` for derived nodes
   and `DepFrame.contributedAt` for derived deps; for input deps the
   sister `lastWriteTime` plays the same role. The whyUpdated /
   whyNotUpdated explainers (commitMetadataDerived'd in Phase F.5,
   #455) read these fields to answer "when did this derivation last
   actually move?"
2. **The lazy-rebuild guard** in `readEntry` (line 1527):
   `if (e.id === COMMIT_LOG_ID && e.lastTime < now && commitHistoryCap > 0)`.
   The `lastTime < now` predicate keeps repeated reads on a
   quiescent engine from rebuilding the commitLog array on every
   call.

That is the entire read surface. `lastTime` is never compared
across nodes for change detection (the way jotai's `n` is); it is
strictly metadata stamped on a write and projected to explain output.

### 2.4 Invariants `lastTime` supports

| Invariant | Where | What `lastTime` carries |
| --- | --- | --- |
| §3 [registrationTime, ∞) domain | `derivedRegisteredAt` field, separate from `lastTime` | Domain anchor is *separate* from the recompute stamp; epoch swap leaves it untouched |
| §11 explain (`Explanation.computedAt`, `DepFrame.contributedAt`) | `buildExplanation`, lines 5130–5174 | Names the GraphTime the derivation last moved at |
| §11 whyUpdated / whyNotUpdated lineage | `@causljs/devtools-bridge` reads `computedAt` | Derives "this commit recomputed it / a prior commit produced it" by comparing `computedAt` to the commit window |
| Phase F.4 lazy-rebuild guard | `readEntry`, line 1527 | Compares `lastTime < now` to skip rebuilds on quiescent engines |
| §15.1 replay determinism | Indirect: `lastTime` is *not* on the wire (`ir.ts` confirms), so it's a pure observability field | A replay reconstructs `lastTime` deterministically from the recompute schedule; the field is not part of the byte-identical contract |

The retention chain (§5.1, lines 234 of `SPEC.md`) does **not** read
`lastTime` — `readAt` walks the per-commit input snapshot delta
chain and recomputes derivations against it via
`recomputeFromSnapshot` (line 5992), which never inspects the live
entry's `lastTime`. So an epoch swap leaves the retention contract
untouched.

## 3. Model comparison

| Dimension | Causl `lastTime: GraphTime` | Jotai `n: EpochNumber` |
| --- | --- | --- |
| **Cardinality** | One global counter (`now`), stamped onto each derived | Per-atom counter; no shared clock |
| **Increment policy** | Stamped at every successful recompute (every node walk in Phase D) — even when the value didn't move | Only when value moves (`Object.is`-distinct landing) |
| **Used for change detection** | No — engine uses `Object.is(before, e.value)` | Yes — `dep.n !== aState.d.get(dep)` is the freshness check |
| **Used for observability** | Yes — `Explanation.computedAt`, `DepFrame.contributedAt`, whyUpdated/whyNotUpdated | No — runtime-only |
| **Wire format** | Absent (`ir.ts` carries no `lastTime` field) | N/A (no wire format) |
| **Skip-compute semantics** | None — every affected derived recomputes once per commit | All deps' epochs match → return cached value, skip compute entirely |
| **Atomicity rollback** | Restored byte-identically by `derivedRollback` | Increment is one-way; jotai has no transactional rollback |

The honest read: the two models answer **different questions**.

- Causl's `lastTime` answers *"when did this derivation last move,
  for explanation purposes?"* It is observability metadata.
- Jotai's `n` answers *"is the cached value still fresh, given my
  recorded view of dep epochs?"* It is a cache-validity oracle.

The two are not mutually exclusive. A causl variant could carry
*both* — `lastTime: GraphTime` (kept for explain) plus `epoch:
number` (added for cache-skip). But that doubles per-derived
hidden-class footprint and the audit's "monomorphize hidden
classes" investment in #703 Win 5 makes that worth measuring before
committing to it.

## 4. Pros / cons of an epoch graph for causl

### 4.1 Potential wins

| Win | Likelihood | Caveat |
| --- | --- | --- |
| **Skip compute on equality-cutoff cells** — when an input write doesn't actually move a downstream derived, the derived never re-runs `compute` | Medium | Requires per-dep epoch-at-read map (`atomState.d` → `Map<NodeId, number>`); doubles dep-set storage. Causl's `Set<NodeId>` is currently 1× the deps; jotai's is 2× plus a Map's overhead per dep |
| **Cheaper post-recompute equality** | Low — jotai still calls `Object.is` *inside* `setAtomStateValueOrPromise` to gate the increment | Same `Object.is` call moves from after-the-recompute (current causl) to inside-the-set; net work is unchanged |
| **Smaller hidden-class footprint** | Low | A single `epoch: number` is no smaller than `lastTime: GraphTime` (both are `number`s on V8). The footprint argument for #676 is unsupported by hidden-class analysis |
| **More predictable cache locality** | Medium | The skip-compute path *avoids* touching the user's compute closure; that's the real win, not "two ints in cache" |
| **Validates WASM backend epoch design** (#680 cross-link) | High | This is the most defensible reason to pursue regardless: even if the JS engine doesn't ship the change, the spike informs the Rust side where the win is unambiguously larger |

The single defensible win is **(1) skip-compute on equality-cutoff
cells**. Everything else is wash or speculative. The audit's
post-#669 / post-#678 baseline is the right cell to measure
against; sections 5.2–5.3 of #676 already nominate
`equality-cutoff × 10000` as the canonical bench.

### 4.2 Drawbacks / costs

| Cost | Severity | Why |
| --- | --- | --- |
| **Loses `Explanation.computedAt` semantics** | High | The epoch is a tick counter, not a `GraphTime`. Adopters who read `computedAt` and the whyUpdated explainer rely on it being a real engine-clock value (e.g. comparing it against `commitHistory` rows). An epoch alone cannot answer "what was the value at time t" |
| **Doubles dep-set storage** | Medium | `Set<NodeId>` (1 hashtable) → `Map<NodeId, number>` (1 hashtable + N number boxes). On `linear-chain × 10000` this is ~10k extra entries' worth of allocation |
| **Atomicity rollback complicates** | Medium | `derivedRollback` currently restores `value`/`deps`/`computed`/`lastTime`. Adding an `epoch` field means one more byte in the rollback record; the per-dep epoch-at-read map *also* needs rolling back, and that's a deep clone of a Map per touched derived. Today's rollback is a `new Set(prior.deps)` copy; an epoch graph would need `new Map(prior.deps)` of (id, number) pairs |
| **Phase F.5 commit-metadata seam needs rethinking** | Medium | F.5 recomputes commit-metadata deriveds *against the freshly refreshed `commitLogEntry.value`* even when their dep-set's epochs haven't moved. The "skip if all dep epochs match" optimisation would break F.5: the cached commit-metadata derived's epoch *did* match, but its semantic intent is to refresh anyway. Either F.5 ignores the epoch (and the win disappears for the F.5 sub-graph) or the skip-compute logic carries a "this is a metadata derived, force recompute" flag |
| **Migration cost** | Medium-High | Three sites in `graph.ts` plus their tests; the `lastTime` field stays for explain → the change is *additive* (epoch + lastTime), not a substitution. ~400 LOC of engine + ~200 LOC of tests, not the 200 LOC #676 estimates |
| **`commitLog` lazy-rebuild guard** | Low | The `lastTime < now` check on line 925 still works under a hybrid (keep `lastTime`, add `epoch`); under a strict swap (epoch only), it would have to compare against the COMMIT_LOG_ID's *last-write* epoch, which doesn't exist as a primitive yet |
| **Fairness concern for the bench** | Medium | Jotai's "no commit envelope" win is already gone in causl-with-cap=0 (#715/#716 amendments). Comparing causl-with-epoch against causl-with-lastTime on `equality-cutoff × 10000` at cap=0 is the only fair comparison; comparing at cap=1000 conflates the epoch question with the envelope question |

The combination — **explain semantics retention forces "epoch + lastTime", not "epoch instead of lastTime"** — is the load-bearing reason this is *additive* engineering rather than a substitution. That's the single thing #676's effort estimate misjudges.

### 4.3 SPEC sections an epoch graph would touch

| Section | Touch | Reason |
| --- | --- | --- |
| §3 (denotational equation) | None | The equation `derived(t) = f(b₁(t), …, bₙ(t))` is implementation-agnostic; epoch is purely a recompute-skip strategy |
| §5 Phase D | **Amend** | Phase D currently walks every affected derived; with epochs, Phase D could short-circuit visit on `∀ dep: dep.epoch === aState.d.get(dep)`. The §3 atomicity contract is preserved (one new GraphTime per commit) but the *visit* count drops |
| §5.1 retention | None | Retention chain reads input deltas; doesn't touch derived `lastTime` or epoch |
| §11 Explanation / explain | Touch (additive) | `computedAt` stays as `lastTime`; epoch is internal-only. If the team chose epoch-only (no `lastTime`), §11 needs a new "what does `computedAt` mean now" answer |
| §15.1 replay determinism | Touch (audit) | `lastTime` is not on the wire; epoch is not on the wire; replay determinism is unaffected by either choice. But the property test should be re-run to confirm the epoch increments are deterministic across replays (jotai's are; causl-with-epoch's would be by the same construction) |
| §17 commitments (closed unions, atomicity) | None | Both fields are private to graph.ts; no public union shape changes |

The amend list is short. The §5 Phase D amendment is the load-bearing
one; everything else is cosmetic.

## 5. The decision

### 5.1 Recommendation: **defer, pending a measured spike**

This memo's verdict is **defer** rather than pursue/reject because
the evidence to support either harder verdict is not yet collected.
The case for pursue rests on a single bench cell
(`equality-cutoff × 10000`) post-#669 / post-#678. Without those
numbers, the recommendation is a guess; with them, it's a decision.

The audit's verdict in #676 already pins the gate at **≥ 2× speedup
on `equality-cutoff × 10000`** with the post-fix baselines. That gate
is the right one. This memo neither lowers it nor pre-commits to it.

### 5.2 What "defer" means concretely

> **Current state (as of v0.9.0):** the blockers below all landed
> (#669, #670, #674 in early May 2026; #678 fair-fight on 2026-05-06).
> The audit-revised exit criterion for #676 nevertheless required a
> measurable spike (`experimental/epoch-spike`) and a ≥ 2× bench gate
> against `equality-cutoff × 10000`. That prototype was never
> commissioned, and #676 was closed `completed` on 2026-05-07 with
> the research memo (this file) as the sole deliverable. The
> follow-on decision artifact contemplated in §5.5 of the issue
> body (`docs/architecture/version-counter-graph-decision.md`) was
> not written. The line of inquiry on the TS engine side is
> effectively retired; the equivalent native-epoch work lives in
> the WASM substrate under EPIC #680 (closed 2026-05-10).

1. **Block on #678** (fair-fight) and **#669–#674** (surgical bench
   fixes) landing. Without those, the baseline is the wrong baseline.
   (Status: all closed early May 2026.)
2. **Then commission the prototype** named in #676's exit criterion:
   ~200 LOC on a `experimental/epoch-spike` branch. The prototype is
   *additive* (epoch + lastTime), not substitutive — section 4.2's
   "explain retention" cost is the reason. The 200 LOC estimate in
   #676 holds for the engine slice but should be doubled for the
   property-test + bench harness work; budget ~1 week elapsed,
   3–4 days of actual engine work.
3. **Property test** (#676's (c)): `epoch(node)` advances iff
   `Object.is(prev, next) === false`, run against the prototype 1000
   trials. Jotai's `setAtomStateValueOrPromise` line 1076 is the
   shape to mirror.
4. **Bench delta** (#676's (b)): the 2× gate on
   `equality-cutoff × 10000` and `transaction-throughput × 10000`,
   measured at cap=0 (the new default per §5.1 Amendment 2).
5. **Decision artifact**: replace this memo's "defer" arm with
   either an `accept-and-implement` arm (referencing the spike's
   bench numbers) or a `reject-and-document` arm (likewise). The
   decision lands as an amendment to this same file.

### 5.3 What evidence would change the recommendation

- **Toward pursue:** the spike's `equality-cutoff × 10000` is ≥ 2×
  the post-#678 baseline AND the property test passes 1000 trials
  AND the explain-retention cost can be shown to be < 5% of the
  engine's hot-path budget.
- **Toward reject:** the spike's `equality-cutoff × 10000` is < 2×
  the baseline OR the property test fails OR the per-dep
  `Map<NodeId, number>` allocation cost shows up as a regression
  on `linear-chain × 10000` (which is the cell jotai's epoch model
  *should* be cheap on, not expensive).

### 5.4 Effort if pursued

If the spike's numbers clear the gate, the implementation issue
should land as **one PR** (not split: the engine state and the
explain semantics move together):

- `packages/core/src/graph.ts`: ~400 LOC delta. Add `epoch: number`
  to `DerivedEntry`; change `deps: Set<NodeId>` to
  `deps: Map<NodeId, number>`; add the skip-compute branch in Phase
  D's `recomputeAffected`; thread the epoch through
  `derivedRollback`; bump it in the same place the post-recompute
  `Object.is` cutoff lives; carry `lastTime` unchanged.
- `packages/core/test/`: ~6 new test files covering the skip-compute
  invariant, the epoch-monotonicity invariant, the rollback
  correctness invariant, the F.5 force-recompute carve-out, the
  property test from #676, and a regression test pinning the
  equality-cutoff bench number.
- **SPEC §5 Phase D amendment** documenting the skip-compute branch.
  Two paragraphs; the §3 contract is unchanged.
- Cross-link to #680 (WASM backend epoch).

Estimated effort: **2 weeks** including the SPEC amendment and the
review cycle. #676's "1 week" estimate counts the spike only.

### 5.5 Why not reject outright

Two reasons:

1. **#680 cross-link.** The Rust/WASM backend has separately
   nominated jotai-style epochs as its native model. The TS spike
   is independently valuable as a control for that work even if
   the JS engine never ships the change. Rejecting outright would
   strand #680's design check. (Update: EPIC #680 closed
   `completed` on 2026-05-10 — 17 sub-issues merged across Phase-0
   + Phase-1 scaffolding — so the cross-link argument is now
   self-contained on the Rust side and no longer needs a TS-side
   control. This is the reason #676 closed `completed` without a
   commissioned spike: the cross-link work moved natively into
   the WASM substrate.)
2. **The skip-compute path is genuinely missing in causl.** Every
   affected derived recomputes once per commit today. The epoch
   model offers a credible structural mechanism for a "no-op
   commit short-circuits the entire downstream walk" — which is
   exactly what `equality-cutoff × 10000` measures. If the audit's
   2× gate clears, the win is real. Rejecting before the
   measurement is a forfeit.

## 6. Out of scope

- **A pure jotai port.** Jotai's lazy/pull-based eval is forbidden by
  §5 Phase D's mandatory eager-evaluation contract. The audit's
  framing already calls this out; this memo agrees.
- **Multi-store epoch.** `storeEpochHolder` (jotai's `m` field) is
  jotai's answer to multi-store mounting. Causl's single-engine §3
  contract makes this irrelevant.
- **Replacing `lastTime` with epoch.** Section 4.2 above — the
  explain retention cost makes this strictly worse than additive.

## 7. Sources read

- Jotai: `pmndrs/jotai/src/vanilla/internals.ts` (commit on `main`,
  fetched 2026-05). Specifically:
  - `AtomState` shape, lines 29–50.
  - `BUILDING_BLOCK_setAtomStateValueOrPromise`, lines 1054–1082.
  - `BUILDING_BLOCK_readAtomState`, lines 638–825.
  - `BUILDING_BLOCK_writeAtomState`, lines 849–910.
  - `BUILDING_BLOCK_recomputeInvalidatedAtoms`, lines 546–633.
  - `BUILDING_BLOCK_invalidateDependents`, lines 827–847.
- Causl: `packages/core/src/graph.ts` HEAD as of v0.9.0.
  Specifically the `lastTime` write sites (lines 1374, 1529, 2222,
  2442, 2570), read sites (lines 1527, 5130–5174), and the
  rollback record (`DerivedRollback`, line 2841).
- Causl: `SPEC.md` §3, §5, §5.1, §11, §15.1, §17.
- Causl: `packages/core/src/ir.ts` (confirms `lastTime` is not in
  the IR wire format).
- Issue #676 (audit framing, exit criterion).
- Issue #680 (WASM backend cross-link).

---

**TL;DR for the reviewer:** epoch graphs answer a different
question than `lastTime` (cache-validity vs explain-stamp). A
hybrid is the only honest port; a substitution would cost §11
explain semantics. The win is real on `equality-cutoff × 10000`
*if* the spike's measured ≥ 2× gate clears against the post-#678
baseline. Without that measurement this is a guess. Defer,
commission the spike named in #676, decide on numbers.
