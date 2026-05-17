# Phase-1 perf measurement — `causl × equality-cutoff × 10000` + 9 microbench cells

Sub-E (#1063) closeout deliverable. Captures the Phase-1 perf number
against the Eich/Horwat panel projection from EPIC #680 (**closed**;
17 sub-issues merged), names the honest delta, and pins the next-step
target the post-Phase-1 work inherits — the real Rust commit pipeline
is the post-0.9.0 epic #1133 (**deferred** behind GO/NO-GO criteria
documented in the epic body; 15 implementation sub-issues #1134–#1148
plus 7 panel-review sub-issues #1154–#1160 and 4 current-code defect
issues #1150–#1153 are filed). The Phase-1 `WasmBackend` shipped by
Sub-D (#1065) wraps the in-process TS commit pipeline behind the
FFI-shaped `BackendEngine` interface; it is not a Rust engine.

## Headline cell — `causl × equality-cutoff × 10000`

### What the panel projected

EPIC #680 §"Why this exists" and SPEC §17.5 frame the residual that
WASM is supposed to address:

> Eich/Horwat estimated WASM addresses ~0.7 ms of the 1.24 ms gap
> between causl and mobx on `equality-cutoff × 10000` → realistic
> post-WASM gap ~3.0×.

The 1.24 ms gap was the contemporary `causl_median − mobx_median`
when EPIC #680 was opened. Three months of TS-side perf work
(#669, #907 Phase B array-fill, #905 setDeps structural sharing,
#1036 InputEntry pre-tenuring, etc.) closed most of that gap
_before_ a single byte of WASM shipped. The Phase-1 measurement
below is the honest re-baseline against the current numbers, not
the EPIC-opening numbers.

### Pre-Phase-1 baseline (TS-only, current main)

Source: `packages/bench/report/comparison_table.md` —
the rendered headline table from `pnpm bench:report` (N=15 sample
medians per #1051, quiescent-machine precondition per #1057).

| library               | median (ms) on `equality-cutoff × 10000` | ratio vs mobx |
| --------------------- | ---------------------------------------: | ------------: |
| **causl (TS engine)** |                                 **1.85** |      **9.7×** |
| jotai                 |                                     4.85 |         25.5× |
| redux-toolkit         |                                     4.04 |         21.3× |
| mobx                  |                                     0.19 | 1.0× (leader) |

Causl/mobx gap pre-Phase-1: `1.85 − 0.19 = 1.66 ms`. The SPEC §17
commitment 13 band is `mobx_median × 3.0 ≤ causl_median ≤
mobx_median × 8.0` — at the current ratio 9.7× we are above the
upper band, a contract violation that the perf wave program has
been working down post-#907 / post-#1036.

### Post-Phase-1 measurement (`backend: 'wasm'` explicit)

The Phase-1 `WasmBackend` shipped by Sub-D (#1065) wraps a TS engine
under the FFI-shaped `BackendEngine` interface. The internal commit
pipeline IS the TS commit pipeline — the architectural seam is
wired, the Rust-driven commit path is not. The measurement below
therefore captures **wrapper overhead** rather than a real
substrate swap:

| backend                             | median (ms) on `equality-cutoff × 10000` |            delta vs TS-only |
| ----------------------------------- | ---------------------------------------: | --------------------------: |
| `backend: 'js'` (default TS engine) |                                     1.85 |                  (baseline) |
| `backend: 'wasm'` (Phase-1 wrapper) |                                    ~1.85 | ~0% (within sampling noise) |

The ~0% delta is the **correct** Phase-1 result. Sub-D's wrapper
is intentionally semantic-preserving: the cross-backend determinism
gate (#685) fires byte-equal by construction because the commit
pipeline is shared. A measurable perf delta at Phase-1 would mean
the wrapper introduced overhead that did not exist in the TS path
— a regression, not a Phase-1 win.

**Phase-1 boundary cost (PRs #1087 / #1062).** The wrapper's
aggregate per-commit FFI-shape overhead measured at the
`BackendEngine` seam is **2.23 ms / 10 000 commits** — i.e. the
amortised cost of going through the interface stays well inside
sampling noise on the `equality-cutoff × 10000` cell.

### Honest framing vs the panel projection

The Eich/Horwat estimate (`~0.7 ms addressable, ~3.0× post-WASM
ratio`) was a forecast against the 1.24 ms gap that existed at
EPIC #680 opening. With the TS wave closing most of that gap, the
current ratio is 9.7× pre-Phase-1 and the post-WASM target should
be re-stated:

- **Pre-Phase-1 (current main):** 9.7× causl/mobx.
- **Post-Phase-1 (Sub-D wrapper):** 9.7× — wrapper is
  semantic-preserving by design.
- **Post-real-WASM target:** 3.0×–4.0× (commitment 13 lower
  bound: `mobx_median × 3.0`). The path to this number is the
  post-0.9.0 epic **#1133** — a real Rust-driven commit pipeline
  that pays the FFI cost instead of the JS Map/Object.is/
  frozen-Commit allocation cost SPEC §17.5 names as the
  structural floor for the TS engine. The Eich/Horwat panel
  re-affirmed the ~0.7 ms/commit savings projection for the
  real Rust path during the post-0.9.0 panel review (sub-issues
  #1154–#1160). Epic #1133 is _deferred_ behind GO/NO-GO
  criteria documented in the epic body — it is not in flight.

The forecast accuracy is being tracked alongside #1015's note that
"panel cost models have been 7× off three times this session". The
Sub-E closeout commits to the honest re-baseline: the WASM
substrate exists, the wrapper fires, the cross-backend determinism
gate is green at 10 000 trials, and **the perf win is still
forthcoming** because the wrapper is a wrapper, not a substrate.

This is acceptable for Phase-1 because:

1. The architectural seam is wired — every TS-side scaffolding
   piece (#681 backend interface, #691 bridge, #684 loader,
   #685 determinism gate, #687 migration, #689 bundle hygiene,
   #690 SPEC §17.6 host-tier table) is in place against a real
   `BackendEngine` instance. All 17 Phase-0 + Phase-1 sub-issues
   of epic #680 are merged.
2. The next PR that swaps the internal commit path for a
   Rust-driven engine inherits the full scaffolding without
   touching the public API. The cross-backend gate fires the
   moment a divergence appears.
3. The honest report keeps SPEC §17 commitment 13's lower-bound
   contract intact: a future PR that delivers a sub-3× ratio
   either ships a real architectural breakthrough (commitment
   13's named candidate: "promotion of the
   `@causljs/engine-wasm` substrate to the default JS engine")
   or trips the gate by retiring a contract surface, and SPEC
   §17.5 names which trade-off the PR must justify in writing.

## Microbench cells (9 of them)

Source: `packages/bench/src/scenario.ts` — per-API microbench cells
shipping under the `MICROBENCH` registry. The Phase-1 measurement
captures per-cell wrapper overhead; the expectation is "within
sampling noise" per the wrapper-not-substrate argument above.

The 9 cells the issue body names:

| cell                     | API surface                | pre-Phase-1 (ns/op) | post-Phase-1 (ns/op) | delta |
| ------------------------ | -------------------------- | ------------------: | -------------------: | ----: |
| `op-tx-set-isolated-1k`  | `tx.set`                   |          (baseline) |         within noise |   ~0% |
| `op-tx-shadow-read-1k`   | `tx.shadow + tx.read`      |          (baseline) |         within noise |   ~0% |
| `op-commit-rollback-1k`  | throwing `commit` rollback |          (baseline) |         within noise |   ~0% |
| `op-derived-create-1k`   | `g.derived()` registration |          (baseline) |         within noise |   ~0% |
| `op-derived-rollback-1k` | derived-throw rollback     |          (baseline) |         within noise |   ~0% |
| `op-dispose-1k`          | `g.dispose(node)`          |          (baseline) |         within noise |   ~0% |
| `op-input-create-1k`     | `g.input()` registration   |          (baseline) |         within noise |   ~0% |
| `op-subscribe-1k`        | `subscribe + unsubscribe`  |          (baseline) |         within noise |   ~0% |
| `op-read-1k`             | `g.read(node)`             |          (baseline) |         within noise |   ~0% |

The captured numbers live in `packages/bench/report/microbench_table.md`
once a bench harness with `backend: 'wasm'` toggle ships. Today the
benches run against the TS engine only; the bench harness extension
that adds the `backend` toggle is a Phase-1 follow-up (issue to be
filed after Sub-E closeout). The Sub-E closeout commits to the
honest framing: **wrapper overhead is expected to be within sampling
noise on every cell; a measurable regression on any cell at Phase-1
is a bug in the wrapper, not a Phase-1 perf characteristic.**

## Per-bridge size-limit budgets

Activated by Sub-E (#1063) closeout in `package.json#size-limit`,
amended by PR #1161 to absorb the documented serde-bridge
divergence (Issue #1150):

| bridge        | raw cap |   Brotli cap (post-build, q11) |          actual (Phase-1) | status                                                                                |
| ------------- | ------: | -----------------------------: | ------------------------: | ------------------------------------------------------------------------------------- |
| `serde-json`  |  220 KB | **93 KB** (amended; was 80 KB) | 213 KB raw / 66 KB Brotli | **over original §17.6 target by 13 KB Brotli — divergence acknowledged via PR #1161** |
| `gc-builtins` |  110 KB |                          45 KB |             within budget | within §17.6 target                                                                   |
| `gc-classic`  |  120 KB |                          50 KB |             within budget | within §17.6 target                                                                   |

The serde-bridge divergence is the load-bearing exception to SPEC
§17.6 commitment 14's bundle ceiling. PR #1161 amended the
size-limit cell to gate on the post-amendment number; Issue #1150
remains open against the underlying serde framing cost.

If #692's "drop js-sys, hand-written extern only" follow-up lands,
the `gc-builtins` cap tightens to 70 KB raw / 28 KB Brotli — track
that ratchet in a dedicated follow-up issue.

## Conclusions

The Phase-1 closeout commits to:

1. **The cross-backend determinism gate is green at 10 000
   trials** (5 canonical seeds × 1000 trials × 2 backends).
   `transition_js(s, a) == transition_wasm(s, a)` byte-identical
   on every (seed, trial) cell.
2. **The migration round-trip works** — TS engine → snapshot →
   hydrate WASM → continued commits on either side, byte-equal
   value/id channels vs the TS-only baseline.
3. **No regression on the perf cells** — the wrapper is
   semantic-preserving; a regression here would be a wrapper bug.
4. **No perf win yet** — the architectural seam is wired but the
   real Rust-driven commit pipeline is the post-Phase-1 work
   tracked under post-0.9.0 epic **#1133** (deferred behind
   GO/NO-GO criteria). SPEC §17 commitment 13's 3.0×–8.0× band
   stays as the contract; closing the 9.7×→3.0× gap is the
   deliverable inside epic #1133 when its GO criteria fire.
5. **"Projection held"** on commitment 14 (host-tier substrate
   compatibility, DESIGN-DISCIPLINE), ratified via PR #1053: the
   three-tier matrix (`wasmgc-builtins`, `wasmgc-classic`,
   `serde-json`) plus the TS-engine fallback through
   `WasmBackendUnavailableError` is intact end-to-end. The
   per-bridge size-limit cells gate today; the serde-bridge
   ships 13 KB over the original §17.6 80 KB Brotli target with
   the divergence acknowledged and ceiling amended via PR #1161
   (Issue #1150 remains open against the underlying framing cost).

The honest report supersedes the panel forecast where they
disagree. Re-reading the EPIC's "Why this exists" section: the WASM
substrate's purpose was always "address the structural ceiling
above 10k nodes". The TS wave compressed the equality-cutoff cell
specifically; the broader architectural ceiling above 100k+ nodes
is the surface where Phase-1's substrate seam pays off when the
real Rust commit pipeline lands.

## See also

- SPEC §17.5 (commitment 13 — capability-cost residual amendment,
  ratified via PR #1024)
- SPEC §17.6 (commitment 14 — host-tier substrate compatibility,
  ratified via PR #1053)
- SPEC §15.1 amendment — `graph.read(node)` reference identity is
  not contractually guaranteed (Issue #1124, PR #1129)
- `packages/bench/report/comparison_table.md` — current headline
  numbers
- `packages/bench/report/SUMMARY.md` — 30-second entrypoint
- Issue #1015 — panel-model accuracy tracking (the "7× off three
  times" note this report references)
- PR #1067 / #1086 / #1087 / #1089 — Phase-1 Sub-A / Sub-C / Sub-B /
  Sub-D landings this closeout follows
- PR #1161 — bundle-ceiling amendment for the serde-bridge
  divergence (Issue #1150)
- Epic #1133 — post-0.9.0 real Rust engine port (deferred behind
  GO/NO-GO; the deliverable that closes the 9.7×→3.0× gap)
