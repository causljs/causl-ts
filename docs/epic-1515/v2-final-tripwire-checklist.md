<!--
  V2-final (epic #1515, decomposition #1516) — the manual
  maturity-tripwire re-measurement checklist.

  This is the "monitor" epic #1515 acceptance row 5 explicitly
  accepts as a MANUAL re-measurement checklist. No runtime code: all
  four probes already exist; this doc SEQUENCES them against the
  V2-DESIGN §3 T1∧T2∧T3∧T4 thresholds so a future operator can
  re-run the tripwire on demand and decide whether the (separate,
  out-of-#1515-scope) promotion-to-default candidacy is reached.

  CRITICAL FRAMING (preserve verbatim — load-bearing):
  v2.x delivers ZERO adopter perf at current WASM maturity. The
  #1133 median falsification STANDS / is NOT refuted. The present
  value is large-tree GC-survival (#1525, corrected: ~16.6× p99.9
  flattening / transient-not-≈0 — NOT the synthetic 437×/≈0). Only
  a T3 determinism divergence is a true STOP.
-->

# V2-final — manual maturity-tripwire re-measurement checklist

> Epic #1515 (v2.x Rust-SSOT cutover) · decomposition #1516 ·
> closeout ticket V2-final (#1546). Predecessors: V2.0 #1517
> (`97da8420`, the design pin), V2.1 #1522, V2.2 #1531, V2.3 #1533
> (the honest re-measurement, `docs/epic-1515/v2.3-rust-ssot-remeasure.md`),
> 🚦V2.4 #1535 (the **LOAD-BEARING GO** — 1000 trials × 0 byte
> divergence), V2.5 #1544 / PR #1545 (rollback tiers 2+3).
>
> Read alongside `docs/epic-1515/V2-DESIGN.md` §3 (the tripwire this
> checklist operationalises), §4 (the honest-measurement plan), and
> `docs/epic-1515/v2.3-rust-ssot-remeasure.md` (the last recorded
> run of every probe below — the baseline this checklist re-measures
> against).

## 0. Framing sentence (fixed — read first, preserve verbatim)

> **This is the expected current-WASM regression. The #1133
> falsification STANDS. v2.x is gated behind opt-in + the §3
> tripwire until re-measurement clears all four axes.**

`engine: 'rust-ssot'` is **opt-in only and is NOT the production
default**. Promotion of the default to `'rust-ssot'` is a **separate,
tripwire-gated, SPEC-amending future decision explicitly out of epic
#1515's scope** (V2-DESIGN §2.2 / §5 point 6). This checklist does
**not** authorise that promotion; it is the re-runnable instrument
that tells a future operator whether the promotion is even a
*candidate* yet. As of the last recorded run (V2.3 #1533) the answer
is **no** — T1 is ~85× against a ≤3× threshold.

The present, **non-maturity-gated** value of v2.x is large-tree
GC-survival (#1525): the real serde-wasm engine survives 50k-node
trees where TS-SSOT GC-destabilises (the 43→1 natural-major-GC
collapse). The corrected #1525 numbers are **~16.6× p99.9 flattening**
and a **transient (not retained, not ≈0)** heap slope — explicitly
**NOT** the earlier synthetic #1518 437× / ≈0 figures. These
narrowings do not weaken the #1133 / V2-DESIGN §0 framing.

## 1. When to run this checklist

Run the full sequence when ANY of these is true (it is a *manual*
monitor by design — epic #1515 acceptance row 5 — there is no CI
gate, because the binding axis T1 moves on the WASM-runtime-vendor
calendar, not on causl's PR cycle, exactly like the §17.6
DESIGN-DISCIPLINE rationale):

- a new WASM runtime ships GC general availability (WASM GC GA) on a
  SPEC §17.6 host-floor browser (the T2 trigger);
- a baseline-JIT or SIMD improvement lands that plausibly moves the
  Rust-in-WASM engine-exec cost (the T1 trigger);
- the 6-month epic-#1133 cadence revisits the Rust engine port;
- an operator is preparing the (out-of-scope) promotion-to-default
  proposal and needs a current tripwire snapshot to attach to it.

Do **not** run it expecting a pass. As of V2.3 the binding axis T1
needs a **~28× WASM-runtime improvement** (85× → 3×) that no current
runtime delta delivers. A failing run is the **designed-for** state,
not a defect.

## 2. The four probes — exact re-measurement sequence

Run in this order. Each step names the probe, its existing harness
(no new code), the exact command, and the V2-DESIGN §3 threshold the
result is checked against. All four are independent; the tripwire is
**conjunctive** — record every axis even if an earlier one fails (a
future operator needs the full snapshot, not a short-circuit).

### Step 1 — T1 input: F-marshal.6.1 no-marshal engine-exec isolation (THE BINDING AXIS)

- **What it measures**: the Rust-engine-in-WASM **per-commit
  execution cost with zero boundary marshal** — `wasmCommitWithIntent`
  alone vs the G.1 per-cell TS baseline. This is the T1 axis input
  and the binding constraint of the entire bet.
- **Harness (exists)**: the F-marshal.6.1 decomposition profile
  (`wasmCommitWithIntent` / `wasmApplyWrites` isolation), #1479
  comment 4455257530, branch `feat/f-marshal-6-1-stateful-delta`
  @ `28c2fc47`. **Not a merged dev probe** — re-measure by
  re-running the decomposition profile on that branch (or its
  successor) on the target WASM runtime, N≥20 trials, same machine
  as the TS baseline.
- **TS baseline (exists)**: `node --import tsx
  packages/bench/scripts/g1-perf-measurement.ts` — the
  `equality-cutoff` per-cell median (G.1 #1145, ~2.017 ms/10k ⇒
  ~0.2 μs/commit).
- **Threshold (V2-DESIGN §3.1 / §3.2)**: **T1 clears iff
  Rust-in-WASM engine-exec ≤ 3× the TS engine per-commit cost on
  every contract-bearing cell.** (3× = the SPEC §17.5 lower bound of
  the capability-cost band — the SPEC's own number, not invented.)
- **Last recorded value (V2.3 #1533, §2.3)**: `wasmCommitWithIntent`
  171.4 ms/10k ÷ TS 2.017 ms/10k ≈ **~85×** ⇒ **T1 NOT CLEARED**
  (needs ~28× runtime improvement).

### Step 2 — T2: WASM GC general availability on the §17.6 host floor

- **What it measures**: whether WASM GC is GA (unflagged default,
  not origin-trial) across the SPEC §17.6 Tier 1 + Tier 2 host
  matrix, with the `wasmgc-builtins` / `wasmgc-classic` bridges
  measured (not just `serde-json`).
- **Harness (exists)**: the SPEC §17.6 host-matrix capability probe
  (the four feature-detection probes named in §17.6; `detectBridge()`
  in `packages/core/wasm/index.ts`). Re-run the host-matrix
  capability probe against the §17.6 enumeration on the candidate
  host set.
- **Threshold (V2-DESIGN §3.1)**: **T2 clears iff WASM GC is GA
  (unflagged) on the SPEC §17.6 Tier 1 + Tier 2 browser floor**
  (Chrome 95+ / Firefox 102+ / Safari 16+ baseline targets per
  CONSTRAINTS §2).
- **Last recorded value (V2.3 #1533, §3)**: **NOT GA on the §17.6
  browser floor** ⇒ **T2 NOT CLEARED** (browser-vendor timeline; the
  engine-exec gap is partly the no-GC linear-memory clone the
  F-marshal.6.1 profile attributes to `transition_phased` +
  `State::clone()`).

### Step 3 — T4: C.6 boundary (crossing) tax at the rust-ssot default window

- **What it measures**: the FFI crossing tax in ns/op at
  N=10/100/312/1000 — does it amortise to ≤50 ns/op at the rust-ssot
  default window N=312 (`RUST_SSOT_DEFAULT_AFTER_N`)?
- **Harness (exists)**: `node --import tsx
  packages/bench/scripts/op-rust-batch-boundary.ts` (writes
  `report/op-rust-batch-boundary.json`).
- **Threshold (V2-DESIGN §3.1)**: **T4 clears iff the §1-projected
  full crossing tax ≤ 50 ns/op at N=312.** *Informational axis* — T1
  is binding; T4 clearing does not make the bet easier (V2-DESIGN §8
  surprise #4).
- **Last recorded value (V2.3 #1533, §2.4)**: **50.1 ns/op at
  N=312** ⇒ **T4 CLEARS** (the crossing tax is already solved; this
  confirms the binding constraint is unambiguously T1, not the
  boundary).

### Step 4 — T3: C.5 cross-backend determinism gate with Rust PROMOTED

- **What it measures**: byte-identity of the Rust `commit_batch`
  projection vs the JS-engine canonical `Commit[]` at the production
  trial count, **with the V2.4 promotion guard active** (not
  shadow-discarded).
- **Harness (exists)**: `pnpm --filter @causljs/core exec vitest run
  test/properties/cross-backend-determinism.property.test.ts` — the
  🚦V2.4 (#1534) "promote GO/NO-GO" describe block runs the gate
  with the Rust post-state PROMOTED at N=312 × 1000 trials.
- **Threshold (V2-DESIGN §3.1)**: **T3 clears iff 1000 trials × 0
  byte differences with the Decision 1.3 promotion guard active.**
  This is the **only true STOP axis** — any byte divergence is a
  determinism correctness bug (a NO-GO HALT), distinct from the
  *expected* T1 perf regression.
- **Last recorded value (🚦V2.4 #1535)**: **1000 trials × 0 byte
  differences with promotion active** ⇒ **T3 GREEN, GO VERIFIED**
  (the load-bearing proof; V2.5 #1544 added the fail-safe
  sticky-downgrade tiers 2+3 for any *future* divergence).

## 3. Roll-up: is promotion-to-default a candidate? (conjunctive)

Fill this table on every run. The tripwire is **conjunctive — ALL
four axes must clear simultaneously on ONE measurement run** before
promotion-to-default is even a candidate (V2-DESIGN §3.3).

| Axis | Threshold | This run's value | Cleared? |
| --- | --- | --- | :-: |
| **T1** — Rust-in-WASM engine-exec vs TS | ≤ 3× | _(fill: F-marshal.6.1 ms/10k ÷ G.1 TS ms/10k)_ | ☐ |
| **T2** — WASM GC GA on §17.6 host floor | GA, unflagged | _(fill: host-matrix probe result)_ | ☐ |
| **T3** — C.5 gate green @ 1000 trials, Rust **promoted** | 1000 × 0 byte diffs | _(fill: V2.4 gate run result)_ | ☐ |
| **T4** — crossing tax @ N=312 | ≤ 50 ns/op | _(fill: op-rust-batch-boundary.json N=312)_ | ☐ |
| **PROMOTION CANDIDATE?** | **T1 ∧ T2 ∧ T3 ∧ T4** | | ☐ |

**Last recorded roll-up (V2.3 #1533 + 🚦V2.4 #1535):** T1 NOT
cleared (~85×) · T2 NOT cleared · T3 GREEN (V2.4 GO, 1000×0) · T4
CLEARS (50.1 ns/op) ⇒ **PROMOTION NOT A CANDIDATE** (T1 ∧ T2 fail;
the bet is honestly hard — T1 is the binding axis and needs a ~28×
WASM-runtime improvement).

## 4. If all four clear — what this checklist does and does NOT do

A four-axis-clear run makes promotion-to-default a **candidate**. It
does **not** promote anything. The promotion-to-default decision is:

1. **Out of epic #1515 scope** (V2-DESIGN §2.2; epic #1515 body
   "Explicitly out of scope" row 1) — it is tracked by epic #1515's
   continued-open umbrella + child #1541 (WASM-advancement readiness
   tracker), not by this checklist.
2. **SPEC-amending** — it requires a SPEC **§17.5 + §17.6**
   amendment (the §17.5 lower-bound clause's named architectural
   escape valve; the §17.6 host-tier "default engine" line). v2.x
   itself requires **no SPEC amendment** (the V2-final SPEC §19
   "NO amendment" trail row); the amendment belongs to the *future
   promotion decision*, written at the decision that actually
   changes the contract — never here.
3. **Reversible by construction** even if taken — the V2.5 #1544
   Decision 6 rollback (per-flush tier 1 / sticky downgrade tier 2 /
   adopter runtime config flip tier 3) keeps the JS engine the
   always-on byte-identical authority.

Attach the filled §3 roll-up to the (separate) promotion proposal on
epic #1515 / #1541. Do not edit defaults from this checklist.
