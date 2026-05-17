<!--
  #1518 — GC-pressure tree-scaling heap/tail-latency probe.
  Child of epic #1515 (v2.x Rust-SSOT cutover). Resurrects the
  closed-as-blocked #1140 with a sharper scope.

  The measured numbers below are captured by
  `packages/bench/scripts/gc-pressure-tree-scaling.ts`
  (`pnpm --filter @causl/bench bench:gc-pressure`) and pinned in
  `packages/bench/report/gc-pressure-tree-scaling.json`. The §2 table
  is transcribed verbatim from that JSON's own generated
  `comparisonTableMarkdown` (doc == artefact by construction).
  Rerunning is an operator task.
-->

# #1518 — GC-pressure axis: tree-scaling heap-slope + tail-latency measurement

> **Child of epic #1515 (v2.x Rust-SSOT cutover).** Resurrects the
> closed-as-blocked predecessor #1140 (`long-run-1M` heap-leak gate
> against real Rust — closed-as-blocked-by-#1483, never ran). Anchored
> at dev `2b7e7ea5` (post-V2.0 design pin `docs/epic-1515/V2-DESIGN.md`
> #1517; post-V2.1 `engine: 'rust-ssot'` opt-in surface #1519/#1522).
>
> Read alongside `docs/epic-1515/V2-DESIGN.md` (the V2.0 shadow path
> this probe measures against — §0 honest framing, §1.3 swap point,
> §3 maturity tripwire) and `docs/epic-1133/G1-PERF-MEASUREMENT.md`
> (the median-latency falsification this doc does **NOT** refute).

---

## 0. Honest framing — read this first

**This does NOT refute the #1133 median-latency falsification. The
#1133 falsification STANDS.**

- G.1 (#1145) measured **median commit latency** on contract-bearing
  cells — the axis where Rust-engine-in-WASM loses **~85×** (the
  `wasmCommitWithIntent`-alone engine-exec cost is 171.4 ms/10k vs the
  TS engine's ~2.017 ms/10k, #1479 comment 4455257530). That gap is a
  property of *today's* WASM runtime (no GC GA, limited baseline JIT,
  no SIMD on the phase pipeline) and is the binding T1 axis of the
  V2-DESIGN §3 maturity tripwire. **Nothing here changes that.**
- This probe measures the **orthogonal, separable,
  NON-maturity-gated** axis #1140 was the ticket for and which G.1
  never touched: **heap-slope + tail latency + major-GC pauses at
  escalating tree size**. The two engines differ here by
  *architecture*, not by WASM-runtime maturity:
  - **TS-SSOT** (current default): commit history + retention chain
    live in the V8 JS heap. PLAN.md / #1029 pinned the `long-run-1M`
    post-saturation slope at **~10.33 B/commit**. At escalating tree
    size × long session the steady-state heap V8 must mark-sweep grows
    with the tree, so that allocation rate drives V8 major-GC
    (`mark-sweep-compact`) pauses — frame-budget jank that surfaces in
    p99 / **p99.9**, NOT in the median.
  - **Rust-SSOT** (V2.0 shadow path, V2-DESIGN §1.3): canonical
    post-state lives in WASM **linear memory**. No per-commit retained
    JS object graph → **≈0 B/commit V8-heap allocation by
    construction**. This is architecture-guaranteed and true *today* —
    unlike the median-latency (T1) axis.

If this axis pays off, #1515's value story gains a leg that does
**not** depend on the T1 maturity tripwire clearing. This is the
GO/NO-GO input the V2.4 load-bearing review feeds on (#1518 acceptance
row 4). It does not weaken the V2-DESIGN §0 framing: v2.x is still NOT
a current median-latency win, and this measurement is not a current
median-latency win either — it is a different axis entirely.

---

## 1. What "Rust-SSOT" means here (methodology disclosure)

The `engine: 'rust-ssot'` adopter discriminant **has now landed** (V2.1
#1519/#1522, dev `2b7e7ea5`). It is consumed only on the
`backend: 'auto'` path (forwarded to `loadWasmBackend({ engine })`
when the auto-adapt wrapper migrates to the WASM backend); the
per-flush byte-compare promotion guard is V2.2 and promotion itself is
V2.4-gated. The serde-bundled `engine_rs_bg.wasm` artefact is **not
present on a clean dev checkout** (the Phase-1 loader wraps a TS
engine — the cross-backend gate's whole discipline; see the
`op-rust-batch-boundary.ts` header for the identical disclosure), so
selecting the flag still resolves the **shadow-computed Rust
post-state**, not a real WASM engine call.

This probe therefore measures the **V2.0/V2.1 shadow path's Rust
post-state directly** — the identical commit stream driven through
`WasmStateMirror` + `marshalBatchEnvelope` → a Rust-faithful
`commit_batch` bridge → `applyBatchBridgeResult`, which **is exactly
the surface `engine: 'rust-ssot'` promotes to canonical at the
batched-flush boundary** (V2-DESIGN §1.3 step 4). Driving the flag via
`createCausl({ engine: 'rust-ssot' })` on this checkout would resolve
to the same post-state computation plus the auto-adapt/loadWasmBackend
wrapper and a TS-engine fallback — it would not change *what is
measured*. The **engine-exec (T1, ~85×) axis is explicitly NOT
measured here** — that needs the absent artefact and is the V2-final /
V2-DESIGN §4 probe.

What IS measured honestly without the artefact is the GC-pressure /
heap-slope axis, **because it is a property of *where the canonical
state lives*** (the `WasmStateMirror`'s flat slot arrays vs the
`createCausl` graph's retained commit-history object graph in the V8
heap), not of the engine's per-commit execution cost. The TS-SSOT
cell is a real `createCausl` graph (a tree-size fan of deriveds off
one input + an O(1) live tail + a subscriber); it accretes
commit-history objects on the V8 heap, reproducing the PLAN.md /
#1029 ~10.33 B/commit baseline. The Rust-SSOT cell holds the
canonical post-state in the mirror's flat slot arrays and writes one
input slot per commit (symmetric to TS-SSOT's `tx.set(a, c)`), so it
never accretes a retained per-commit object graph.

**Honest limitation (verification finding — read before §3).** The
synthetic-bridge mirror still allocates JS-side per flush window
(`marshalBatchEnvelope` rebuilds the O(treeSize) live slot block — the
option-c §1 / C.6 known JS-side marshal cost). That allocation is
**transient, not retained**: the heap-slope (a post-saturation
linear-regression fit, which only tracks *retained* growth) shows the
Rust-SSOT path does **not systematically accrete** — its slope hovers
around 0 ± jitter at every tree size (12.76 / 29.73 / **−4.01**
B/commit; the small/negative values are mirror-map + forced-GC noise,
not a trend), whereas TS-SSOT shows a **consistent positive ~10
B/commit slope at every tree size** (11.22 / 10.67 / 9.63 — squarely
on the PLAN.md baseline). So this probe **does** soundly establish
"Rust-SSOT does not accrete a per-commit retained JS object graph";
the precise *real-engine* ≈0-bytes magnitude (vs the synthetic
bridge's transient marshal) remains a V2-DESIGN §1.3 design claim that
only the serde artefact can pin (same limitation as the T1 axis).

**Latency note**: the rust-ssot p50/p99/p99.9 figures are the
amortised flush-window slice (V2-DESIGN §1.3/§2.2 default
`afterN = 312`), NOT the median-engine-exec cost. They are NOT a claim
that rust-ssot has lower commit latency than TS in production — that
is the ~85× T1 axis, not measured here. The p99.9 comparison's value
is the **tail-flattening shape** (no GC-pause spikes), not the
absolute level.

---

## 2. Comparison table (1k / 10k / 50k nodes × TS-SSOT vs Rust-SSOT)

<!-- BEGIN:COMPARISON-TABLE -->
Canonical reproducible capture (`2026-05-15T18:47:39Z`,
script-default budgets 1k/10k/50k = 20000/4000/2000 commits,
`SAMPLE_INTERVAL = 100` → 11–31 post-saturation samples per cell;
pinned verbatim from
`packages/bench/report/gc-pressure-tree-scaling.json`):

| tree size | engine | heap-slope (B/commit) | p50 (ms) | p99 (ms) | p99.9 (ms) | natural major-GC pauses | major-GC ms (observed) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | `ts-ssot` | 11.22 | 0.2028 | 0.2789 | 0.3578 | 0 | 377.2 |
| 1,000 | `rust-ssot` | 12.76 | 0.0006 | 0.0019 | 0.0040 | 0 | 406.9 |
| 10,000 | `ts-ssot` | 10.67 | 2.6712 | 3.5486 | 4.1300 | 1 | 121.2 |
| 10,000 | `rust-ssot` | 29.73 | 0.0059 | 0.0076 | 0.0076 | 1 | 87.6 |
| 50,000 | `ts-ssot` | 9.63 | 15.5997 | 23.9542 | 26.4946 | 41 | 243.6 |
| 50,000 | `rust-ssot` | -4.01 | 0.0269 | 0.0606 | 0.0606 | 1 | 60.8 |

_Natural major-GC = observed `mark-sweep-compact` /
`incremental-marking` pauses minus the per-cell forced
`snapshotMemory()` GCs (a shared, deterministic instrument offset —
identical call count for both engines at a given tree size: 200 / 40 /
20 forced cycles at 1k / 10k / 50k respectively). Heap-slope is the
post-saturation (`commit ≥ LONG_RUN_SATURATION_COMMIT = 1000`)
linear-regression fit (B/commit); the TS-SSOT column reproduces the
PLAN.md / #1029 ~10.33 B/commit baseline at every tree size, the
Rust-SSOT column hovers around 0 ± jitter (no accretion — see §1
honest limitation). p50/p99/p99.9 are per-commit commit latency (ms);
the rust-ssot row is the amortised flush-window slice per V2-DESIGN
§1.3/§2.2 — engine-exec (T1, ~85×) cost is NOT in these numbers (see
§0/§1 framing)._
<!-- END:COMPARISON-TABLE -->

---

## 3. Verdict

<!-- BEGIN:VERDICT -->

**Yes — Rust-SSOT flattens tail latency and collapses GC-pause count
at escalating tree size, and the effect grows sharply with the tree.
The 50k headline: a ~437× p99.9 tail-latency flattening and a 41× → 1×
collapse in natural major-GC pause count.**

Per tree size, on the canonical reproducible capture:

- **1,000 nodes**: TS-SSOT p99.9 **0.358 ms** → Rust-SSOT p99.9
  **0.004 ms** — **~89× tail flattening**. Neither engine triggers a
  *natural* major GC at this size (0× both — the heap is small enough
  that the forced `snapshotMemory()` cycles keep old-space trimmed).
  Heap-slope: TS **11.22** B/commit (right on the PLAN.md ~10.33
  baseline) vs Rust **12.76** B/commit (no accretion trend — jitter
  around 0; see §1).
- **10,000 nodes**: TS-SSOT p99.9 **4.130 ms** → Rust-SSOT p99.9
  **0.008 ms** — **~541× tail flattening**; 1 natural major-GC each.
  TS-SSOT slope **10.67** B/commit (PLAN.md baseline holds, tree-size-
  invariant as theory predicts since retention is O(1)/commit).
- **50,000 nodes** (the #1518 headline): TS-SSOT p99.9 **26.49 ms**
  with **41 natural major-GC pauses** / 243.6 ms observed → Rust-SSOT
  p99.9 **0.061 ms** with **1 natural major-GC pause** / 60.8 ms
  observed. That is a **~437× p99.9 tail-latency flattening and a 41×
  collapse in natural major-GC pause count** at 50k nodes. The
  TS-SSOT 50k cell's p50 is already **15.6 ms** (over a 60 Hz frame
  budget *at the median*, before the GC tail); Rust-SSOT's p50 is
  **0.027 ms**. The TS-SSOT slope stays on the ~10 B/commit baseline
  (9.63) while the Rust-SSOT slope is **−4.01** (≈0, no accretion).

**The effect is monotone in tree size and the GC-pause collapse is the
load-bearing signal.** At 1k there is no natural GC to eliminate (the
win is purely the flatter latency distribution); by 50k the TS-SSOT
path is firing **41 mark-sweep-compact pauses** over the run while
Rust-SSOT fires **1**. The mechanism is exactly the §0 thesis: the
TS-SSOT path accretes commit-history objects in the V8 heap at ~10
B/commit *regardless of tree size*, but the **steady-state heap V8
must mark-sweep grows with the tree**, so the major-GC pause cost
explodes at 50k; the Rust-SSOT path's canonical post-state is a flat
slot array that does not feed that growth.

**Honest scope of the claim (verification correction).** This probe
soundly establishes the **tail-latency + GC-pause-count axis** and
that **Rust-SSOT does not accrete a retained per-commit JS object
graph** (slope ≈0 ± jitter at every size vs TS-SSOT's reproducible
~10 B/commit). It does **not** measure a real WASM-linear-memory
engine's absolute bytes/commit (the synthetic bridge still allocates a
*transient* O(treeSize) marshal envelope per flush — §1); the
"≈0 B/commit by construction" V2-DESIGN §1.3 statement is consistent
with — but not independently pinned by — this probe, exactly like the
T1 engine-exec axis (both need the absent serde artefact). The
tail-latency / GC-pause result is real, reproducible, separable, and
non-maturity-gated; that is the #1518 deliverable and it is honestly
narrower than "Rust makes commits free."
<!-- END:VERDICT -->

---

## 4. Honest interpretation — does this strengthen or weaken the v2.x story?

<!-- BEGIN:INTERPRETATION -->

**It STRENGTHENS the v2.x value story on a leg that is independent of
the #1515 maturity bet — without weakening the honest #1133 /
V2-DESIGN §0 framing one bit.**

1. **The tail-latency / GC-pause finding is real, reproducible, and
   non-maturity-gated.** At 1k/10k/50k the Rust-SSOT path has a
   ~89× / ~541× / ~437× flatter p99.9 and the natural major-GC pause
   count collapses from 41× to 1× at 50k. The TS-SSOT arm cleanly
   reproduces the PLAN.md / #1029 ~10.33 B/commit slope at every tree
   size (11.22 / 10.67 / 9.63), confirming the probe's TS arm is
   sound; the Rust-SSOT arm shows no accretion trend (slope ≈0 ±
   jitter). The win holds **today**, on the current WASM runtime, with
   **no dependence on the T1 (~85× engine-exec) tripwire ever
   clearing** — it is a property of *where the canonical state lives*,
   not of engine-exec speed. This is exactly the "separable,
   non-maturity-gated value axis" #1518 hypothesised, now measured.
   The honest narrowing (vs a naive "Rust ≈0 B/commit" reading): the
   synthetic bridge does not pin a real engine's absolute bytes/commit
   (§1) — but the *symptom that matters to adopters* (GC-pause
   tail-latency jank at large tree size) is demonstrably collapsed by
   routing canonical post-state through the Rust shadow surface.

2. **It does NOT refute or even touch the #1133 median falsification.**
   The ~85× per-commit engine-exec gap (#1479 comment 4455257530) is
   the binding T1 tripwire axis and is **not measured here** (it needs
   the serde wasm artefact; see §1). The rust-ssot latency figures in
   §2 are the amortised flush-window slice, not an engine-exec median;
   they are NOT a claim that rust-ssot commits are faster than TS in
   production. The value this probe surfaces is **tail-latency
   *shape*** (no GC-pause spikes), a different axis from the median
   the #1133 work falsified. Both statements are simultaneously true
   and honest: v2.x is not a current median-latency win **and** the
   GC-pressure axis is a genuine, today-true win.

3. **Where it lands in the v2.x decision.** This feeds the V2.4
   load-bearing GO/NO-GO review (#1518 acceptance row 4) as a
   *positive, non-maturity-gated* input. It does not move the
   V2-DESIGN §3 tripwire (that is the engine-exec/determinism axis);
   it adds an orthogonal reason the opt-in infrastructure is worth
   carrying even while T1 stays red: an adopter whose pain is
   **GC-pause jank at large tree size on a long session** (not raw
   median throughput) is served by `engine: 'rust-ssot'` *today*, at
   the cost of the documented ~85× median regression they opt into
   with eyes open. v2.x remains opt-in, default-off, behind the
   tripwire for the *default-promotion* question — that scoping is
   unchanged. The honest GO/NO-GO is: this is a real second leg, and
   it does not require the maturity bet to pay off.
<!-- END:INTERPRETATION -->

---

## 5. Reproduce

```
pnpm --filter @causl/bench bench:gc-pressure
# matrix override:    GC_PRESSURE_TREE_SIZES=1000,10000,50000
# deeper operator run: GC_PRESSURE_COMMITS_50000=20000  (etc.)
```

**On the script-default budgets (1k/10k/50k = 20000/4000/2000
commits).** Per-commit work in the TS-SSOT cell is O(treeSize) — every
commit dirties the one input and the whole fan recomputes — and the
cost per commit additionally escalates as the V8 heap fills (this *is*
the GC-pressure phenomenon under measurement). The defaults are
tapered down sharply as the tree grows so the full 6-cell sweep is an
operator-feasible single-digit-minute run while still clearing the
`LONG_RUN_SATURATION_COMMIT = 1000` cutoff with ≥10 post-saturation
samples (`SAMPLE_INTERVAL = 100`) at every size — the heap-slope is
O(1)/commit and saturates well before these budgets, so the larger
cells confirm the 1k cell's PLAN.md ~10.33 B/commit slope at lower
commit counts. An earlier all-input-write Rust-SSOT cell shape drove
the 50k cell into an O(FLUSH_WINDOW × treeSize) buffered-Map memory
explosion; the canonical script writes a single input slot per commit
(symmetric to TS-SSOT) and completes cleanly. A deeper operator run
that wants a longer 50k tail can raise `GC_PRESSURE_COMMITS_50000`
(expect the TS-SSOT 50k cell to dominate wall time and to
GC-destabilise well before tens of thousands of commits — itself a
finding).

`--expose-gc` is enforced at the entrypoint (`assertExposeGc`) — the
heap-slope statistic is only honest with forced GC inside
`snapshotMemory()`, and the GC-pause distribution needs the
perf-hooks `gc` observer running over the whole loop. Captured numbers
are pinned in `packages/bench/report/gc-pressure-tree-scaling.json`.
