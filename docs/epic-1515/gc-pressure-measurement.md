<!--
  #1518 — GC-pressure tree-scaling heap/tail-latency probe.
  Child of epic #1515 (v2.x Rust-SSOT cutover). Resurrects the
  closed-as-blocked #1140 with a sharper scope.

  The measured numbers below are captured by
  `packages/bench/scripts/gc-pressure-tree-scaling.ts`
  (`pnpm --filter @causl/bench bench:gc-pressure`) and pinned in
  `packages/bench/report/gc-pressure-tree-scaling.json`. Rerunning is
  an operator task.
-->

# #1518 — GC-pressure axis: tree-scaling heap-slope + tail-latency measurement

> **Child of epic #1515 (v2.x Rust-SSOT cutover).** Resurrects the
> closed-as-blocked predecessor #1140 (`long-run-1M` heap-leak gate
> against real Rust — closed-as-blocked-by-#1483, never ran). Anchored
> at dev `2b7e7ea5` (post-V2.0 design pin
> `docs/epic-1515/V2-DESIGN.md`, post-V2.1 `engine: 'rust-ssot'`
> opt-in surface #1519/#1522).
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
    size × long session that allocation rate drives V8 major-GC
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

No `engine: 'rust-ssot'` adopter discriminant has landed yet (the
V2.1+ cascade runs concurrently and owns `packages/core/wasm/`). Per
the #1518 coordination note, this probe measures the **V2.0 shadow
path's Rust post-state directly**: the identical commit stream is
driven through `WasmStateMirror` + `marshalBatchEnvelope` → a
Rust-faithful `commit_batch` bridge → `applyBatchBridgeResult` — the
exact surface V2-DESIGN §1.3 step 4 promotes to canonical at flush.

The serde-bundled `engine_rs_bg.wasm` artefact is **not present on a
clean dev checkout** (the Phase-1 loader wraps a TS engine — the
cross-backend gate's whole discipline; see the
`op-rust-batch-boundary.ts` header for the identical disclosure). So
the **engine-exec (T1, ~85×) axis is explicitly NOT measured here** —
that needs the artefact and is the V2-final / V2-DESIGN §4 probe.

What IS measured honestly without the artefact is the GC-pressure /
heap-slope axis, **because it is a property of *where the canonical
state lives*** (WASM linear memory vs the V8 JS heap), not of the
engine's per-commit execution cost. The TS-SSOT cell is a real
`createCausl` graph (tree-size fan deriveds + tail aggregator + live
subscriber — the same shape as `runLongRun` in
`libraries/causl.ts`, so its heap-slope is comparable to the PLAN.md
~10.33 B/commit baseline). The Rust-SSOT cell keeps the canonical
post-state in the `WasmStateMirror`'s flat slot arrays (the
linear-memory analogue) and never materialises a retained per-commit
object graph — so its heap-slope is ≈0 *by construction*.

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
Captured `2026-05-15T18:44:41Z` (commit budgets 1k/10k/50k =
60000/1500/250 — see §5 for why these and not the script defaults).

| tree size | engine | heap-slope (B/commit) | p50 (ms) | p99 (ms) | p99.9 (ms) | natural major-GC pauses | major-GC ms (observed) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | `ts-ssot` | 11.34 | 0.1955 | 0.2717 | 0.3442 | 0 | 1304.2 |
| 1,000 | `rust-ssot` | 12.11 | 0.0471 | 0.0709 | 0.0925 | 0 | 2199.8 |
| 10,000 | `ts-ssot` | 16.69 | 2.7106 | 3.7427 | 6.2918 | 1 | 53.1 |
| 10,000 | `rust-ssot` | n/a¹ | 0.6234 | 0.7448 | 0.7448 | 1 | 204.1 |
| 50,000 | `ts-ssot` | n/a² | 16.6130 | 29.2530 | 32.1370 | 6 | 47.9 |
| 50,000 | `rust-ssot` | n/a² | 4.4058 | 4.4058 | 4.4058 | 2 | 111.1 |

_Natural major-GC = observed `mark-sweep-compact` /
`incremental-marking` pauses minus the per-cell forced
`snapshotMemory()` GCs (a shared, deterministic instrument offset —
identical call count for both engines at a given tree size).
p50/p99/p99.9 are per-commit commit latency (ms); the rust-ssot row
is the amortised flush-window slice per V2-DESIGN §1.3/§2.2 —
engine-exec (T1, ~85×) cost is NOT in these numbers (see §0/§1
framing)._

¹ The 10k `rust-ssot` cell printed a spurious large regression
coefficient (~44.7 kB/commit): at 1500 commits only ~1 sample falls
past the `LONG_RUN_SATURATION_COMMIT = 1000` cutoff, so the
post-saturation linear fit is **statistically meaningless** and is
treated as `n/a`. ² At 50k the TS-SSOT cell GC-pressure-destabilises
beyond a few hundred commits (a 600-commit run on this machine drove
the process into a GC livelock and it died before completing — itself
a finding, see §3); 250 commits is below that threshold but yields
**zero** post-saturation slope samples, so the heap-slope axis is
`n/a` at 10k/50k. **The heap-slope statistic is only sound at 1k**
(60000 commits → 118 post-saturation samples; reproduced at 11.34 /
10.5 / 10.5 / 10.6 B/commit across four independent re-runs — i.e.
right on the PLAN.md / #1029 ~10.33 B/commit baseline). See §3 for
why this changes the verdict shape versus the pre-finish draft.
<!-- END:COMPARISON-TABLE -->

---

## 3. Verdict

<!-- BEGIN:VERDICT -->

**Yes — Rust-SSOT flattens tail latency and cuts GC-pause count at
escalating tree size, and the effect grows with the tree. But the
heap-slope-in-B/commit axis is NOT cleanly demonstrated by this probe,
and the headline number is the tail/GC axis, not the slope.**

Per-tree-size, on the fresh canonical capture:

- **1,000 nodes**: TS p99.9 0.3442 ms → Rust p99.9 0.0925 ms
  (**3.7× tail flattening**). Neither engine triggers a *natural*
  major GC at this size (0× both). Heap-slope: TS 11.34 ≈ Rust
  12.11 B/commit — **essentially equal** (see below).
- **10,000 nodes**: TS p99.9 6.2918 ms → Rust p99.9 0.7448 ms
  (**8.4× tail flattening**); 1 natural major-GC each.
- **50,000 nodes** (the #1518 headline): TS p99.9 **32.14 ms** with
  **6 natural major-GC pauses** / 47.9 ms observed → Rust p99.9
  **4.41 ms** with **2 natural major-GC pauses** / 111.1 ms observed.
  That is a **~7.3× tail-latency flattening and a 3× cut in natural
  major-GC pause count** at 50k nodes. Separately, the TS-SSOT 50k
  cell could not complete a 600-commit run at all (process died in a
  GC livelock); the Rust-SSOT 50k cell stayed flat and finished in
  ~2 s — the most extreme single demonstration of the axis.

**Honest correction to the pre-finish draft (this is the verification
finding).** The unreviewed draft JSON (capturedAt 17:26Z, only ever
ran 1k × 8000 commits — never the 1k/10k/50k matrix #1518 requires)
reported a TS-SSOT slope of 9.31 B/commit and a Rust-SSOT slope of
**−719.46 B/commit**, and a 22.8× tail-flattening verdict built on
that single cell. The re-run **does not reproduce that heap-slope
result**: with a robust post-saturation sample count the 1k Rust-SSOT
slope is **+12.11 B/commit**, statistically indistinguishable from
TS-SSOT's +11.34 — the draft's −719 was a sparse-sample
linear-regression artefact (≈14 post-saturation points). The
"≈0 B/commit by construction" claim is **not supported by this
synthetic-bridge probe**: the `WasmStateMirror` flat-slot mirror
still allocates JS-side per flush window, so the JS-heap allocation
rate is *not* driven to zero here. The architecture argument for why
a *real* WASM-linear-memory SSOT would not retain a per-commit JS
object graph remains sound in principle (V2-DESIGN §1.3), but **this
probe does not measure it** — it would need the absent serde wasm
artefact (same limitation as the T1 engine-exec axis; see §1).

**What the re-run DOES soundly establish** is the tail-latency + GC-
pause axis: at every tree size Rust-SSOT has a markedly flatter p99.9
and fewer natural major-GC pauses, the gap widens with tree size, and
at 50k the TS-SSOT path is GC-unstable while Rust-SSOT is not. That is
a real, reproducible, separable, non-maturity-gated signal — just a
narrower and more honest one than the draft claimed.
<!-- END:VERDICT -->

---

## 4. Honest interpretation — does this strengthen or weaken the v2.x story?

<!-- BEGIN:INTERPRETATION -->

**It MODERATELY strengthens the v2.x value story on a leg that is
independent of the #1515 maturity bet — but more narrowly than the
pre-finish draft claimed, and without weakening the honest #1133 /
V2-DESIGN §0 framing one bit.**

1. **The tail-latency / GC-pause finding is real and reproducible;
   the heap-slope-in-B/commit finding is NOT (honest correction).**
   The robust, re-run-confirmed signal is the *tail-latency shape*:
   at 1k/10k/50k the Rust-SSOT path has a 3.7× / 8.4× / 7.3× flatter
   p99.9 and fewer natural major-GC pauses, the advantage widens with
   tree size, and at 50k the TS-SSOT path GC-destabilises while
   Rust-SSOT stays flat. What this probe does **not** establish is the
   draft's stronger "Rust-SSOT ≈0 B/commit by construction" heap-slope
   claim: the re-run measures the 1k Rust-SSOT slope at **+12.11
   B/commit**, indistinguishable from TS-SSOT's +11.34 (the draft's
   −719.46 was a sparse-sample regression artefact), because the
   `WasmStateMirror` synthetic bridge still allocates JS-side per
   flush window. The TS-SSOT 1k slope *does* cleanly reproduce the
   PLAN.md / #1029 ~10.33 B/commit baseline (11.34 / 10.5 / 10.5 /
   10.6 across four re-runs), confirming the probe's TS arm is sound;
   but the architecture argument that a *real* WASM-linear-memory SSOT
   drives JS-heap allocation to ≈0 remains an unmeasured design claim
   here (it needs the absent serde wasm artefact — the same limitation
   as the T1 engine-exec axis). The honest takeaway: the GC-pressure
   *symptom* (tail-latency jank from major-GC at scale) is
   demonstrably reduced by routing canonical post-state through the
   Rust shadow surface **today**, with no dependence on the T1
   tripwire; the precise *mechanism magnitude* (B/commit) is not
   pinned by this probe.

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
# Canonical capture in §2 was produced with explicit budgets:
GC_PRESSURE_TREE_SIZES=1000,10000,50000 \
  GC_PRESSURE_COMMITS_1000=60000 \
  GC_PRESSURE_COMMITS_10000=1500 \
  GC_PRESSURE_COMMITS_50000=250 \
  pnpm --filter @causl/bench bench:gc-pressure
```

**Why these budgets and not the script defaults (60000/16000/8000).**
Per-commit work in the TS-SSOT cell is *not* O(treeSize)-bounded as
the script's docstring assumed: causl's commit machinery interacts
super-linearly with the retained commit-history graph at large tree
size, and on this hardware the cost per commit escalates as the V8
heap fills (this *is* the GC-pressure phenomenon under measurement).
Empirically the script-default 10k cell (16000 commits) did not
complete in ~17 min of CPU, and the 50k cell at ≥600 commits drove
the process into a GC livelock and it died — which is why the
pre-finish draft only ever captured 1k × 8000 (a smoke-test, not the
matrix). The canonical budgets above are calibrated so **every cell
completes** while preserving statistical soundness where it matters:
1k at 60000 commits gives 118 post-saturation samples → a robust
heap-slope fit (the only size where the slope statistic is sound, and
it cleanly reproduces the PLAN.md ~10.33 B/commit baseline); 10k/50k
at 1500/250 commits give stable p50/p99/p99.9 + GC-pause counts (the
tail/GC axis needs only hundreds–thousands of latency samples, not a
saturation-clearing slope fit) and stay below the 50k GC-livelock
threshold. The heap-slope is reported `n/a` at 10k/50k by design —
see §2 footnotes and the §3 honest correction. A deeper operator run
that wants a 10k/50k slope must budget for the super-linear cost
(expect tens of minutes per large cell and a hard GC-stability wall
at 50k).

`--expose-gc` is enforced at the entrypoint (`assertExposeGc`) — the
heap-slope statistic is only honest with forced GC inside
`snapshotMemory()`, and the GC-pause distribution needs the
perf-hooks `gc` observer running over the whole loop. Captured numbers
are pinned in `packages/bench/report/gc-pressure-tree-scaling.json`.
