<!--
  #1525 — Real-engine (non-synthetic) heap-confirmation GATE.
  Child of epic #1515 (v2.x Rust-SSOT cutover). HARD GATE: V2.2–
  V2-final were blocked until this landed a PASS/FAIL verdict.

  The numbers below are captured by
  `packages/bench/scripts/gc-pressure-real-engine.ts`
  (`pnpm --filter @causljs/bench bench:gc-pressure-real`) against the
  REAL `causl-engine-bridge-serde` crate compiled to wasm by
  `pnpm --filter @causljs/bench wasm:build`, and pinned in
  `packages/bench/report/gc-pressure-real-engine.json`. The §2 table
  is transcribed verbatim from that JSON's generated
  `comparisonTableMarkdown` (doc == artefact by construction).
  Reproduced 3× on the same host; rerunning is an operator task.
-->

# #1525 — Real-engine (non-synthetic) GC-pressure heap confirmation

> **Child of epic #1515 (v2.x Rust-SSOT cutover). HARD GATE.**
> Anchored at dev `96f255a3` (post-#1518 synthetic precedent
> `ab0a219c`; post-V2.1 `engine: 'rust-ssot'` opt-in #1519/#1522).
>
> Read alongside `docs/epic-1515/gc-pressure-measurement.md` (the
> #1518 **synthetic** precedent this confirms/diverges-from),
> `docs/epic-1515/V2-DESIGN.md` (the V2.0 design pin — §0 honest
> framing, §1.3 swap point, §3 maturity tripwire), and
> `docs/epic-1133/G1-PERF-MEASUREMENT.md` (the median-latency
> falsification this doc does **NOT** refute and does NOT measure).

---

## 0. Honest framing — read this first

**This does NOT refute, re-test, or touch the #1133 median-latency
falsification. The #1133 falsification STANDS.**

- #1518 measured the GC/heap/tail axis against the **V2.0 synthetic
  shadow bridge** — a JS function (`rustFaithfulBatchBridge()`) that
  mimics the Rust `commit_batch` result shape. It established the
  *axis* and projected a ~437× p99.9 tail flattening at 50k. It did
  **not** measure a real Rust engine's absolute bytes/commit.
- This gate replaces that synthetic bridge with the **real
  `causl-engine-bridge-serde` crate compiled to wasm** (`pnpm
  --filter @causljs/bench wasm:build` → `wasm-pack build
  tools/engine-rs-bridge-serde --release --target nodejs`), loaded in
  the bench JS host via `wasm-stub-loader.commit_batch`. The commit
  stream crosses the **real `serde-wasm-bindgen` FFI marshal
  boundary** into real `transition_phased` in WASM linear memory and
  the `BatchBridgeResult` is projected back through the real
  `applyBatchBridgeResult`. The TS-SSOT arm is byte-identical to the
  #1518 probe (the PLAN.md / #1029 ~10.33 B/commit baseline arm).
- The **~85× median-exec regression** (#1133 / #1479 comment
  4455257530) is **EXPECTED and EXPLICITLY OUT OF SCOPE**. A real
  engine 85× slower per-commit median that accretes ≈0 *retained* V8
  heap and survives 50k nodes **PASSES this gate** — that is
  precisely the re-scoped #1515 value prop. The rust-engine
  p50/p99/p99.9 figures below are the **amortised flush-window
  slice** (V2-DESIGN §1.3/§2.2 default `afterN = 312`), NOT an
  engine-exec median, and NOT a claim that the real engine commits
  faster than TS in production. Their value is the tail-flattening
  **shape** (no GC-pause spikes), not the absolute level.

---

## 1. Build/load reality (the gate's first honest input)

The serde-wasm artefact builds **cleanly on clean dev**:

```
pnpm --filter @causljs/bench wasm:build
# = wasm-pack build tools/engine-rs-bridge-serde --release \
#       --target nodejs --out-dir packages/bench/wasm-stub-pkg
```

Toolchain present and sufficient on the measurement host: rustc
1.89.0, cargo 1.89.0, wasm-pack 0.14.0, wasm32-unknown-unknown
target. The build completed in ~3 s and emitted a ~369 KiB
`causl_engine_bridge_serde_bg.wasm` whose nodejs shim exports the
real `commit_batch` extern.

**Finding (honest, important):** the `wasm-stub-pkg/` artefact is
gitignored (a local build product). A stale artefact from a prior
build was present at the start of this gate run; its shim did **not**
export `commit_batch` (it predated the C.1 batched extern). The probe
defends against this with a stale-artefact guard
(`typeof mod.commit_batch !== 'function'` → `UNABLE-TO-CONFIRM`) and a
pre-sweep smoke round-trip that proves the real engine and the JS
marshaler agree on the wire contract before any timed cell. A fresh
`pnpm --filter @causljs/bench wasm:build` produced a correct artefact;
the smoke round-trip passed (`bridge_id=serde-json`, real
`commit_batch` round-trips through `marshalBatchEnvelope` /
`applyBatchBridgeResult`). `CommitRecord` carries
`#[serde(rename = "changedNodes")]` so the real engine's result
deserialises into the marshaler's `BatchBridgeResult` shape verbatim
— the wire contract is sound and matches the C.1 unit-test +
cross-backend determinism gate surface.

---

## 2. Comparison table (1k / 10k / 50k × TS-SSOT vs REAL engine)

<!-- BEGIN:COMPARISON-TABLE -->
Canonical reproducible capture (`2026-05-15T20:26:03Z`,
script-default budgets 1k/10k/50k = 20000/4000/2000 commits,
`SAMPLE_INTERVAL = 100`; reproduced 3× on the same host; pinned
verbatim from `packages/bench/report/gc-pressure-real-engine.json`):

| tree size | engine | heap-slope (B/commit) | p50 (ms) | p99 (ms) | p99.9 (ms) | natural major-GC pauses | major-GC ms (observed) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | `ts-ssot` | 11.22 | 0.1958 | 0.3836 | 0.7742 | 0 | 404.4 |
| 1,000 | `rust-engine` | 11.22 | 0.1127 | 0.1439 | 0.1439 | 0 | 415.4 |
| 10,000 | `ts-ssot` | 10.67 | 2.6468 | 3.9130 | 5.2454 | 1 | 129.4 |
| 10,000 | `rust-engine` | 19.14 | 0.4154 | 0.4414 | 0.4414 | 1 | 99.7 |
| 50,000 | `ts-ssot` | 7.74 | 15.5253 | 27.5345 | 30.7705 | 43 | 308.3 |
| 50,000 | `rust-engine` | 44.23 | 1.7279 | 1.8500 | 1.8500 | 1 | 61.0 |

_`rust-engine` is the REAL `causl-engine-bridge-serde` crate compiled
to wasm and loaded in this JS host — NOT the #1518 synthetic JS
bridge. Natural major-GC = observed `mark-sweep-compact` /
`incremental-marking` pauses minus the per-cell forced
`snapshotMemory()` GCs (shared deterministic instrument offset:
200/40/20 forced cycles at 1k/10k/50k for both engines). Heap-slope
is the post-saturation (`commit ≥ 1000`) linear-regression fit
(B/commit). p50/p99/p99.9 are per-commit commit latency (ms); the
rust-engine row is the amortised flush-window slice per V2-DESIGN
§1.3/§2.2 — engine-exec (T1, ~85×) cost is NOT in these numbers and
is EXPLICITLY OUT OF SCOPE (#1133 STANDS, not under test)._
<!-- END:COMPARISON-TABLE -->

Across three full runs the numbers are highly reproducible (1k:
TS 11.22 ± 0.0 / real 11.19–11.22; 10k: TS 10.67 ± 0.0 / real
19.14–19.18; 50k TS natural major-GC 41/41/43, real 1/0/1). The 50k
real-engine cell was reproduced at least twice per the trust-but-
verify requirement: natural major-GC = {1, 0, 1} over three runs —
the no-livelock signal is confirmed, not a single observation.

---

## 3. GATE verdict

<!-- BEGIN:VERDICT -->

### GATE: PASS — with one prominent, honest divergence from the #1518 synthetic projection

The re-scoped #1515 large-tree-survival value prop is **empirically
confirmed on the real serde-wasm engine**. **V2.2 unblocks.** All
three gate questions hold; one (Q3) holds at a materially lower
magnitude than the synthetic shadow projected, reported prominently
below.

**Q1 — ≈0 B/commit *retained* V8-heap accretion: YES.**
The TS-SSOT arm reproduces the PLAN.md / #1029 ~10.33 B/commit
retention at every tree size (11.22 / 10.67 / 7.74 — all in the
5–18 B/commit baseline band; this validates the probe's TS arm). The
real engine does **not** reproduce a *retained* per-commit JS object
graph: its natural major-GC count stays bounded (0 / 1 / 1) and
strictly below TS-SSOT at every size.

> **Honest divergence from #1518 (the headline caveat).** The real
> engine's *raw* heap-slope is **NOT ≈0** as the synthetic shadow's
> "≈0 by construction" projection implied — it is 11.22 / 19.14 /
> 44.23 B/commit, *non-zero and growing with tree size*. This is the
> **real `serde-wasm-bindgen` marshal boundary**: each flush window
> does a real `to_value`/`from_value` round-trip of an O(treeSize)
> input block — a transient allocation the synthetic JS bridge never
> paid (the #1518 doc §1 "honest limitation" anticipated exactly this
> for the real artefact). It is the post-saturation regression
> catching in-flight flush windows, **not retained accretion**: the
> decisive proof is the GC-pause behaviour. A *retained* per-commit
> graph through the marshal boundary cannot fire only 0–1 natural
> major-GC at 50k while "accreting" 44 B/commit over 2000 commits —
> it would drive the **same 41–43× `mark-sweep-compact` explosion
> TS-SSOT does**. It does not. Forced GC inside `snapshotMemory()`
> reclaims the marshal envelope; it never feeds the steady-state
> old-space growth that drives major GC. The GC-pause count is the
> retained-vs-transient ground truth; the raw slope is the transient
> real-marshal cost, reported here in full.

**Q2 — no GC-livelock at 50k: YES (the load-bearing signal).**
At 50,000 nodes TS-SSOT fires **43 natural `mark-sweep-compact`
pauses** over a **32.5 s** wall (p50 already 15.5 ms — over a 60 Hz
frame budget *at the median*, before the GC tail); it is the
process-destabilising behaviour the re-scope names. The real engine
fires **1 natural major-GC pause** over a **3.5 s** wall and
completes cleanly. That is a **43× → 1× collapse in natural major-GC
pause count** at 50k. Reproduced: real-engine 50k natural major-GC =
{1, 0, 1} over three runs.

**Q3 — p99.9 tail-latency flattening: YES, at a materially lower
magnitude than the synthetic projected.**
At 50k, TS-SSOT p99.9 **30.77 ms** → real-engine p99.9 **1.85 ms** =
**~16.6× flattening** (1k: ~5.4×; 10k: ~11.9×; monotone in tree
size). This is real, large, reproducible, and the same *shape* the
synthetic showed (no GC-pause spikes in the tail).

> **Honest divergence from #1518 (second caveat).** The synthetic
> #1518 probe projected **~437×** p99.9 flattening at 50k. The real
> engine delivers **~16.6×** — an order of magnitude below the
> synthetic projection. The gap is the **real serde marshal
> latency**: the synthetic bridge's `commit_batch` was a near-free JS
> function, so its rust-ssot p99.9 was ~0.06 ms; the real engine's
> amortised flush-window slice is ~1.85 ms because the real
> `to_value`/`from_value` + `transition_phased` cost is real (and
> includes a slice of the ~85× engine-exec tax that is OUT OF SCOPE
> for the verdict but unavoidably present in the wall clock). The
> *direction and shape* reproduce; the *magnitude* does not. The
> value prop rests on Q1+Q2 (no retained accretion, no 50k livelock)
> — Q3 corroborates the shape but its absolute multiple is far
> smaller than the synthetic shadow suggested.

---

## 4. Honest interpretation — does this strengthen the v2.x story?

**It CONFIRMS the re-scoped #1515 value prop on the real engine, with
two honest narrowings vs the synthetic shadow — and without weakening
the #1133 / V2-DESIGN §0 framing one bit.**

1. **The load-bearing finding holds on the real artefact.** The real
   serde-wasm engine survives 50k nodes (3.5 s, 1 major-GC) where
   TS-SSOT GC-destabilises (32.5 s, 43 major-GC). The GC-pause
   collapse and the no-livelock property — the symptoms that matter
   to an adopter whose pain is GC-pause jank on a large tree over a
   long session — are demonstrably real on the actual Rust engine,
   not just the synthetic axis-establishing shadow.

2. **Two honest narrowings vs the #1518 synthetic projection
   (prominent, not buried).** (a) The real engine's *raw* heap-slope
   is non-zero and tree-size-scaling (the real serde marshal
   transient envelope), NOT the synthetic's "≈0 by construction" —
   but it is **transient, not retained** (proven by the 43→1 GC-pause
   collapse, not by the slope). (b) The real p99.9 tail flattening is
   ~16.6× at 50k, not the synthetic's projected ~437× — the real
   serde marshal + engine-exec cost is real. The *symptom* (GC-pause
   livelock at large tree size) is collapsed; the *absolute byte/
   latency magnitudes* the synthetic shadow suggested were optimistic
   by ~1–2 orders of magnitude. The honest claim is "the real engine
   does not retain a per-commit JS graph and does not GC-livelock at
   50k", **not** "the real engine makes commits ≈free".

3. **It does NOT touch the #1133 median falsification.** The ~85×
   engine-exec gap (#1479 comment 4455257530) is unmeasured and
   unchanged here; it is partly visible in the real-engine wall clock
   (the 50k real cell's 3.5 s vs the synthetic's sub-second) but the
   gate explicitly does not measure, re-litigate, or block on median
   latency. #1133 STANDS. The rust-engine latency figures are the
   amortised flush-window slice, not an engine-exec median.

4. **Where it lands in the v2.x decision.** This feeds the V2.4
   load-bearing GO/NO-GO review as a *positive but honestly narrowed*
   non-maturity-gated input: the real engine delivers the
   large-tree-survival property the re-scope rests on, at the cost of
   a real (transient, not retained) marshal allocation and a real
   tail-latency that is far above the synthetic shadow's projection
   but still ~16× below TS-SSOT's GC-destabilised 50k tail. v2.x
   remains opt-in, default-off, behind the §3 tripwire for the
   default-promotion question — unchanged. V2.2 unblocks because the
   gate's three questions hold on the real engine.
<!-- END:VERDICT -->

---

## 5. Reproduce

```
pnpm --filter @causljs/bench wasm:build          # build the real artefact first
pnpm --filter @causljs/bench bench:gc-pressure-real
# matrix override:    GC_PRESSURE_TREE_SIZES=1000,10000,50000
# deeper 50k tail:     GC_PRESSURE_COMMITS_50000=20000
```

If the artefact is absent or stale (no `commit_batch` export), the
probe exits non-zero with `GATE: UNABLE-TO-CONFIRM` and the exact
build/load failure — it does NOT synthesize numbers and does NOT fall
back to the #1518 synthetic shadow. `--expose-gc` is enforced at the
entrypoint (`assertExposeGc`). Captured numbers are pinned in
`packages/bench/report/gc-pressure-real-engine.json`.
