# V2.0 — Rust-SSOT cutover design pin + maturity tripwire

> **Decision-record ticket for epic #1515 (v2.x Rust-SSOT cutover).**
> No production code. Output is this doc + the V2.1–V2.N
> decomposition comment on #1516. Mirrors the #1457 / #1484 /
> #1483→#1493 design-pin pattern (design phase before any
> integration-class cascade).
>
> Anchored at dev `b07df102` (post-#1493 phase C.1–C.7 complete:
> `commit_batch` extern on both bridges, `marshalBatchEnvelope` /
> `applyBatchBridgeResult`, the `BatchedFlush` queue on
> `WasmBackend`, the per-flush cross-backend determinism gate, the
> C.6 `op-rust-batch-boundary` probe, the C.7 no-amendment record).
>
> Read alongside `docs/epic-1483/option-c-batched-boundary.md` (the
> Answer-C scaffolding v2.x rides on), `docs/epic-1483/CONSTRAINTS.md`
> (the adopter-API / deployment / perf / parity rubric), and
> `docs/epic-1133/G1-PERF-MEASUREMENT.md` (the falsification this doc
> does **not** refute).

---

## 0. Honest framing — read this first (preserved verbatim from #1515)

**v2.x does NOT deliver an adopter perf win at current WASM
maturity. The #1133 falsification STANDS.**

- The Rust-engine-in-WASM **per-commit execution cost** is
  **~17 μs/commit** (`wasmCommitWithIntent` alone = 171.4 ms/10k,
  F-marshal.6.1 profile, #1479 comment 4455257530). This is the
  engine call **with zero boundary marshal** — the diagnostic probe
  isolated `wasmApplyWrites` (the delta marshal) at 3.1 ms/10k and
  `wasmCommitWithIntent` (the engine call alone) at 171.4 ms/10k.
- The TS engine `equality-cutoff` baseline (G.1 #1145) is
  **~0.2 μs/commit** (2.017 ms / 10k).
- The Rust-engine-in-WASM per-commit execution cost is therefore
  **~85× the TS engine** *even with zero boundary crossing*
  (17 μs ÷ 0.2 μs ≈ 85).
- #1493's batching amortises the **crossing** tax exactly 1/N
  (C.6 measured 1564 / 156 / 50.1 / 15.6 ns/op at
  N=10/100/312/1000, crossing the ≤50 ns floor at N≥312). It does
  **NOT** amortise the engine-execution gap. The engine-execution
  gap is the binding constraint, and it is a property of *today's*
  WASM runtime (no GC GA, limited baseline JIT, no SIMD on the hot
  path), not of the bridge architecture.

**Therefore**: v2.x is **infrastructure investment against future
WASM maturity** (WASM GC general availability, baseline-JIT
improvements, SIMD intrinsics on the engine hot path). The cutover
is built, validated byte-identical, kept behind an explicit opt-in
plus a documented **maturity tripwire**, and only promoted to
production default when a re-measurement clears the tripwire
criteria pinned in §4.

Project-owner direction (recorded on #1515): proceed on `dev` as
future-facing infra — *"Even if it won't be our solution right now,
as WASM in browsers matures, we can use it."*

**Nothing in this document implies v2.x is a current perf win. Any
reader who comes away thinking "v2.x makes causl faster today" has
misread it.** The honest result of the v2.x honest-measurement plan
(§5) is an *expected, designed-for regression* on every
contract-bearing cell at current WASM maturity.

---

## 1. Decision 1 — SSOT-swap mechanics

### 1.1 Where the swap point lives

**Recommended: the swap point is the `BatchedFlush.flush()` body in
`packages/core/wasm/index.ts:759-809`, NOT `WasmBackend.commit()`.**

Today (`WasmBackend.commit()`, index.ts:952-1034) the canonical
adopter return is `this.#graph.commit(...)` — the wrapped TS engine
(index.ts:965-977). The `commit_batch` envelope crosses the FFI at
flush time and the result is **discarded into the mirror**
(`applyBatchBridgeResult(this.#mirror, result)`, index.ts:780) —
this is the F-marshal.5 shadow path, deferred per-batch by #1493
C.3.

The v2.x swap **inverts which result is canonical at the flush
boundary**, not at the commit boundary:

- The TS engine still runs Phases A–H **synchronously per
  `commit()`** so the §3 Theorem 4 one-tick-per-commit invariant,
  §3 Theorem 2 uninterruptibility, §5.1 Phase A–H + Amendment 4,
  and §15.3 per-commit subscriber fire are all preserved verbatim
  (exactly as option-c Answer C pins them — `docs/epic-1483/
  option-c-batched-boundary.md` §2.1 / §3.1 / §4.2).
- At flush, the `BatchBridgeResult` returned by `commit_batch`
  (bridge `lib.rs:602-631`, the `commits: Vec<CommitRecord>` array
  with `time = now+1 … now+N`) becomes the **promoted canonical
  post-state for the WASM-side mirror that adopter
  `snapshot()` / `readAt()` / `exportModel()` shadow through**
  (F-marshal.7 marshaler-routed paths). The per-commit
  adopter-visible `Commit` return stays the TS engine's.

This is the minimal-surface promotion: it reuses the existing
`commit_batch` extern (no Rust change), the existing
`marshalBatchEnvelope` / `applyBatchBridgeResult` helpers (no
marshaler change), and the existing `BatchedFlush` queue. The
"swap" is a **canonicality flag on which side's post-state the
mirror trusts at flush**, not a re-architecture.

### 1.2 Does the JS engine become shadow/fallback, or get removed?

**Recommended: JS engine stays in the hot path as the canonical
*per-commit synchronous return* AND the *shadow validator*. It is
NOT removed.**

Three reasons, each load-bearing:

1. **The ~85× engine-exec gap (#1479 comment 4455257530) makes
   removing the JS engine a guaranteed regression at current WASM
   maturity.** If the Rust engine became the per-`commit()`
   synchronous SSOT, every adopter `commit()` would pay ~17 μs vs
   the TS engine's ~0.2 μs. The whole opt-in-plus-tripwire posture
   exists precisely so this does not happen by default.
2. **Removing the JS engine would force the §3 Theorem 2 / §15.3
   fan-back cost** the option-c doc §3.3 footnote already
   identified: a WASM-SSOT that owns subscriber dispatch must fan N
   intermediate `CommitRecord` entries back across the FFI per
   fired Phase G observer, destroying the 1/N amortisation. Keeping
   the JS engine authoritative for subscriber dispatch is what
   makes the batched boundary pay the crossing tax **once per
   batch**, not once per commit's subscriber fan-out.
3. **The JS engine is the rollback target (Decision 6).** A
   production divergence on opt-in rust-ssot must fall back to a
   byte-identical authority that is *already running*, not one that
   has to be cold-started. The JS engine is that authority by
   construction because it ran every commit synchronously already.

So the v2.x topology is: **JS engine = synchronous per-commit
authority + always-on shadow validator; Rust engine = promoted
canonical for the WASM-side mirror at flush, validated
byte-identical against the JS engine's accumulated `Vec<Action>`
every flush before promotion is honoured.**

### 1.3 How the batched-flush queue interacts

The Rust SSOT **consumes the batch**; the JS engine **validates
per-flush**. Concretely, the v2.x `flush()` body (a future
modification of index.ts:759-809) becomes:

1. JS engine has already run Phases A–H synchronously for each of
   the N buffered commits (unchanged — `WasmBackend.commit()` line
   965).
2. `marshalBatchEnvelope(mirror, batch)` (index.ts:774) → one
   `commit_batch` FFI crossing (bridge `lib.rs:602`).
3. **v2.x addition**: compare the `commit_batch`
   `BatchBridgeResult.commits` (N `CommitRecord`s, bridge
   `lib.rs:562-567`) byte-for-byte against the N TS-engine
   `Commit`s the JS engine produced for the same window. This is
   the C.5 per-flush cross-backend determinism gate **promoted from
   a test-harness assertion to a load-bearing runtime invariant**
   (Decision 3 tripwire axis "gate green at production trial
   count"; Decision 6 rollback trigger).
4. On byte-match: promote the Rust post-state as canonical for the
   mirror (`applyBatchBridgeResult`, index.ts:780 — unchanged
   call, now load-bearing).
5. On byte-divergence: **do not promote**; keep the JS-engine
   post-state canonical; surface the divergence on the rollback
   path (Decision 6); the captured-error seam
   (`BatchedFlush.#error`, index.ts:625/803-808) already exists for
   exactly this.

**Surface-area estimate**: ~1 new canonicality flag on
`WasmBackend` + ~1 per-flush byte-compare call in `flush()` +
promotion of the C.5 gate's compare to a runtime guard. **No Rust
change, no marshaler change, no new extern.** ~40–60 LoC + the
gate-promotion test wiring.

---

## 2. Decision 2 — Opt-in surface

### 2.1 The exact adopter API

**Recommended: `createCausl({ engine: 'rust-ssot' })` /
`loadWasmBackend({ engine: 'rust-ssot' })` — a new `engine`
discriminant, NOT a flag on the existing `batchedFlush` options
object, NOT an env/build flag.**

Rationale:

1. **`batchedFlush` is explicitly framed as a wire-tempo knob, not
   an SSOT switch.** `docs/wasm-adoption-guide.md:392-399` and the
   SPEC §17.6 option-c callout both promise verbatim that
   `batchedFlush` "delivers ZERO adopter-visible performance change"
   and "changes only *when the WASM-side shadow wire crossing
   happens*". Overloading it to also flip SSOT would break that
   contract sentence and confuse the audit trail. A distinct
   `engine: 'rust-ssot'` discriminant keeps the two concerns
   orthogonal: `batchedFlush` tunes tempo; `engine` chooses
   authority.
2. **It mirrors the existing `backend` discriminant shape.**
   `createCausl` already accepts `backend: 'js' | 'auto'`
   (`packages/core/src/types.ts:754`, per G.1 doc §1). An `engine`
   sibling discriminant on the WASM path is the same shape adopters
   already program against; `auto-adapt.ts`'s `AdaptThresholds`
   seam (CONSTRAINTS §1b row) is the natural future promotion point
   without coupling.
3. **An env/build flag is rejected** because it is not per-graph.
   Multi-graph adopters (`@causl/sync`, embedded) must be able to
   opt one graph into rust-ssot without cross-graph coupling —
   exactly the per-graph constraint option-c §2.3 pinned for
   `batchedFlush`. A build flag also makes the rollback story
   (Decision 6) a redeploy instead of a runtime config change.

### 2.2 Default stays JS-SSOT

`engine` defaults to **`'js-ssot'`** (the current behaviour:
TS-engine canonical, Rust shadow). Omitting `engine` is
byte-identical to dev `b07df102` — the same load-bearing
acceptance property #1493 C.4 established for `batchedFlush`
(index.ts:885-924 / SPEC §19 #1493 trail row). `engine:
'rust-ssot'` is purely additive, per-graph, zero-codemod,
zero-deprecation. v2.x ships opt-in **until the §4 tripwire
clears**; promotion of the default is explicitly out of scope for
epic #1515 (epic body "Explicitly out of scope" row 1).

`engine: 'rust-ssot'` implies `batchedFlush` is active (the swap
rides the batched-flush queue per Decision 1.3); if the adopter
does not also pass `batchedFlush`, v2.x defaults the window to
`afterN: 312` (the #1484 §3 ≤50 ns crossing-floor window, C.6
confirmed) so the *crossing* tax is amortised even though the
*engine-exec* tax is not (honest framing: this does not make it
fast — see §0).

**Surface-area estimate**: ~1 new union member on the options type
+ validation + threading through `instantiateBackend`
(index.ts:434-470, mirrors the `batchedFlush` threading at
index.ts:467-469). ~30–50 LoC + type tests.

---

## 3. Decision 3 — Maturity-tripwire criteria

The tripwire is the **measurable, re-runnable** set of conditions
under which a *future* decision (out of scope for #1515) could
promote `engine: 'rust-ssot'` to the production default. It is
deliberately conjunctive: **ALL axes must clear simultaneously on
the same measurement run** before promotion is even a candidate.

### 3.1 The four axes (concrete + re-measurable)

| # | Axis | Threshold | How re-measured | Current value |
| - | --- | --- | --- | --- |
| **T1** | Rust-engine-in-WASM per-commit **execution** cost vs TS engine | **≤ 3× the TS engine per-commit cost on every contract-bearing cell** (see §3.2 for the rationale on "3×") | Re-run the F-marshal.6.1 decomposition probe (`wasmCommitWithIntent` alone, no-marshal isolation) + the G.1 per-cell TS baseline, same machine, N≥20 trials | **~85×** (17 μs vs 0.2 μs, #1479 comment 4455257530) |
| **T2** | WASM GC general availability across the SPEC §17.6 host-tier matrix | **GC GA (not origin-trial, not flag-gated) on Tier 1 + Tier 2 hosts** (Chrome 95+/Firefox 102+/Safari 16+ baseline targets per CONSTRAINTS §2), with the `wasmgc-builtins`/`wasmgc-classic` bridges measured (not just `serde-json`) | Host-matrix capability probe re-run against the §17.6 enumeration; GC must be unflagged-default on the named browser floor | Not GA on the §17.6 browser floor (the engine-exec gap is partly the no-GC linear-memory clone the F-marshal.6.1 profile attributes to `transition_phased` + `State::clone()`) |
| **T3** | Cross-backend determinism gate green **at the production trial count** with Rust as the promoted canonical | **1000 trials × 0 byte differences** on the C.5 per-flush gate **with the Decision 1.3 promotion guard active** (not shadow-discarded) | Run the C.5 per-flush gate (`packages/core/test/properties/cross-backend-determinism.property.test.ts`) with the rust-ssot promotion guard enabled | Green in **shadow** (F-marshal.5 / C.5, 1000 trials); **not yet load-bearing** (this is what V2 GO/NO-GO proves — see decomposition) |
| **T4** | Boundary (crossing) tax ≤ 50 ns/op at the chosen default N | **≤ 50 ns/op confirmed at the rust-ssot default window (N=312)** | Re-run the C.6 `op-rust-batch-boundary` probe (`packages/bench/scripts/op-rust-batch-boundary.ts`) | **Already clears** — C.6 measured 50.1 ns/op at N=312 (SPEC §17.5 trail addendum, #1493 C.6). This axis is *informational*; T1 is the binding axis. |

### 3.2 Rationale for the T1 "within 3×" threshold

The F-marshal.6.1 baseline gap is **~85×** (the explicit starting
point #1516 names). The threshold is **3×**, chosen as follows:

- **3× is the SPEC §17.5 lower bound of the live capability-cost
  band** (`mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0`,
  SPEC §17.5 / §17.1 commitment 13). The §17.5 lower-bound clause
  is *already the documented "this is the floor below which a JS
  engine that ships replay-determinism cannot go"* (SPEC §17.5
  Eich/Horwat framing). If the Rust-in-WASM engine reaches within
  3× of the TS engine's *own* per-commit cost, it has reached the
  point where promoting it can no longer *widen* the §17.5 band —
  which is the exact condition SPEC §17.5's lower-bound clause
  names as the trigger for "a real architectural breakthrough that
  deserves a SPEC §17 amendment of its own". The threshold is not
  invented; it is the band the SPEC already commits to.
- **Why not 1× (parity) or 8× (upper band)?** 1× (true parity) is
  not required for promotion to be *defensible*: the §17.5 band
  tolerates a contract premium up to 8×, but promoting at 8× would
  *consume the entire premium budget on the engine swap alone*,
  leaving no headroom for the four contract surfaces (commitLog,
  changedNodes, GraphTime monotonicity, readAt/snapshotAt) the
  premium is supposed to pay for (SPEC §17.5). 3× is the lower
  bound precisely because it is where the swap stops *eroding* the
  premium and starts being *free* relative to the band the SPEC
  already promises adopters.
- **Honest note**: 85× → 3× is a **~28× improvement** that no
  current WASM-runtime delta delivers. T1 is deliberately a hard
  bar. It is expected to be the *last* axis to clear (T4 already
  clears today; T2 is a browser-vendor timeline; T3 is provable now
  in shadow). T1 is the bet's binding constraint, and the doc says
  so plainly.

### 3.3 The tripwire is conjunctive and re-runnable

Promotion is a *future* decision (out of #1515 scope). It becomes a
*candidate* only when **T1 ∧ T2 ∧ T3 ∧ T4 all clear on one
measurement run**, captured as a comparison table (§5) filed on
#1515. A manual re-measurement checklist is acceptable for v2.x
(epic #1515 acceptance row 5: "a monitor (manual re-measurement
checklist is acceptable)"). The V2-final ticket ships that
checklist + the `docs/wasm-adoption-guide.md` v2.x section
documenting "opt-in only; not production default until tripwire
clears; here is the tripwire" (epic #1515 decomposition row 3).

**Surface-area estimate**: the tripwire itself is documentation +
a re-measurement checklist (no runtime code). The probes it re-runs
(F-marshal.6.1 decomposition, G.1 per-cell, C.5 gate, C.6
`op-rust-batch-boundary`) **all already exist** — the checklist is
a sequencing doc, ~1 markdown file.

---

## 4. Decision 4 — Honest measurement plan

### 4.1 Which probes re-run under Rust-SSOT

| Probe | Location (exists today) | What it shows under rust-ssot |
| --- | --- | --- |
| G.1 per-cell, 6 contract-bearing cells | `packages/bench/scripts/g1-perf-measurement.ts` | The headline regression: rust-ssot canonical vs TS baseline |
| F-marshal.6.1 decomposition (no-marshal isolation) | `packages/bench/test/wasm-marshaler-delta-profile.test.ts` (#1479) | The ~17 μs/commit engine-exec component in isolation — the T1 axis input |
| C.6 `op-rust-batch-boundary-{10,100,312,1000}` | `packages/bench/scripts/op-rust-batch-boundary.ts` | The crossing tax amortises 1/N (T4; already clears) |
| C.5 per-flush cross-backend determinism gate | `packages/core/test/properties/cross-backend-determinism.property.test.ts` | Byte-identity with Rust **promoted** (T3) — green expected |

### 4.2 Expected current-WASM result (the designed-for regression)

**Expected: every contract-bearing cell regresses by roughly the
~85× engine-exec multiple, partially offset only on cells where
the per-commit cost is small relative to fan-out.** Using the G.1
TS baselines (CONSTRAINTS §3) and the ~17 μs/commit engine-exec
cost (#1479 comment 4455257530):

| Cell | TS median (ms/10k) | Rust-SSOT projected (ms/10k) | Projected ratio |
| --- | ---: | ---: | ---: |
| `equality-cutoff` | 2.017 | ~171 (engine-exec dominated) | **~85×** |
| `scrolling-viewport` | 0.112 | ~170 (boundary irrelevant; engine-exec is the wall) | **~1500×** |
| `spreadsheet-100x100` | 0.334 | ~171 | **~512×** |
| `linear-chain` | 5.820 | ~177 (engine-exec + the long fixpoint) | **~30×** |

These are projections from the isolated profile, **not** new
measurements (V2-final files the real numbers). The shape of the
table is the contract: a regression column, a ratio column, and
the explicit statement that **this is the expected, designed-for
result at current WASM maturity — NOT a STOP-VERDICT.** A
regression here is the bet working as designed (infra built,
gated, waiting on WASM maturity); only a *determinism* failure
(T3 red) would be a true STOP.

### 4.3 The comparison-table shape filed on #1515

The honest-measurement ticket (V2.x in the decomposition) files a
comparison table on **#1515** (epic, not #1516) with exactly these
columns: `cell | TS baseline | rust-ssot measured | ratio | T1
verdict (≤3×? yes/no) | tripwire axis status (T1/T2/T3/T4)`. The
table's framing sentence is fixed: *"This is the expected
current-WASM regression. The #1133 falsification stands. v2.x is
gated behind opt-in + the §3 tripwire until re-measurement clears
all four axes."*

**Surface-area estimate**: the measurement harnesses all exist;
the honest-measurement ticket is a *run + record* ticket (run the
4 probes under the rust-ssot canonicality flag, write the table to
a report file + the #1515 comment). ~0 new harness code; ~1
report doc + 1 comment.

---

## 5. Decision 5 — SPEC amendment scope

**Recommended: NO SPEC amendment is required for v2.x as scoped
(opt-in, default-off, behind the tripwire). Record the no-amendment
decision explicitly, mirroring #1493 C.7 (SPEC §19 #1493 trail
row).**

Why no amendment is needed — the same structural argument C.7 made
for option (c), now checked against the rust-ssot swap:

1. **§3 Theorem 4 / monotonicity** — preserved. The JS engine still
   advances `now` by exactly one tick per `commit()` synchronously
   (Decision 1.2). `engine: 'rust-ssot'` does not move the
   per-commit clock; it only changes which side's post-state the
   *mirror* trusts at flush. The `commit_batch` extern already
   produces N `CommitRecord`s with `time = now+1 … now+N` (bridge
   `lib.rs:562-567`), byte-identical to N un-batched envelopes (C.1
   unit tests + C.5 per-flush gate).
2. **§3 Theorem 2 uninterruptibility** — preserved. Each Phase E →
   Phase G runs JS-side on a single tick (the JS engine stays the
   synchronous authority — Decision 1.2); the `commit_batch`
   envelope at flush is one synchronous FFI call.
3. **§5.1 Phase A–H + Amendment 4 (Phase G IndexMap container)** —
   preserved. Phase A–H + Phase G fire JS-side per commit before
   any flush; the Rust engine's `IndexMap`-shaped container is
   already validated byte-identical by the C.5 gate (SPEC §5.1
   Amendment 4 / §15.1).
4. **§15.1 byte-identity** — preserved *and now load-bearing*. v2.x
   does not change the wire format; it promotes the already-byte-
   identical Rust post-state from "discarded shadow" to "canonical
   for the mirror" only **after** the per-flush byte-compare passes
   (Decision 1.3). The C.5 gate moving from test-harness assertion
   to runtime promotion guard is a **wiring change, not a contract
   change** — exactly the shape C.7 used to argue the per-flush
   gate adjustment was "a one-PR test-harness change, *not* a SPEC
   amendment" (SPEC §17.6 option-c callout).
5. **§15.3 subscriber-fire** — preserved verbatim. Per-commit
   synchronous, JS-side, unchanged. v2.x does NOT touch subscriber
   dispatch (Decision 1.2 reason 2 — keeping the JS engine
   authoritative for Phase G is what avoids the §3.3 fan-back
   cost).
6. **§17.5 capability-cost band** — **unchanged at v2.x because
   default stays JS-SSOT.** The band only moves if rust-ssot
   becomes the default, which is the *tripwire-gated future
   decision explicitly out of #1515 scope*. The §17.5 lower-bound
   clause already names "promotion of the opt-in `@causl/core/wasm`
   substrate to the default engine" as the candidate that would
   "deserve a SPEC §17 amendment of its own" (SPEC §17.5). That
   amendment belongs to the *future promotion decision*, not to
   v2.x. v2.x is the opt-in; the amendment is the promotion.
7. **§17.6 host-tier matrix** — inherited verbatim. v2.x adds no
   extern (reuses `commit_batch`), strands no host, moves no bundle
   ceiling, changes no `loadWasmBackend()` / `detectBridge()` path.
   Same argument as the C.7 §17.6 no-amendment record.

**The one SPEC interaction worth naming**: when the tripwire
clears and the *future* promotion decision is taken, **that
decision requires a SPEC §17.5 + §17.6 amendment** (the §17.5
lower-bound clause's named escape valve; the §17.6 host-tier
"default engine" line). v2.x scopes that out explicitly and pins
it here so a future auditor sees the absence is *deliberate and
reasoned, not an oversight* (the exact rationale the C.7 SPEC §19
"no-amendment" trail row gives for why a no-amendment row is itself
load-bearing).

**Surface-area estimate**: 0 SPEC text changes for v2.x. 1 SPEC
§19 trail row recording the v2.x no-amendment decision (the
V2-final ticket, mirroring the #1493 C.7 row at SPEC §19). The
future-promotion amendment is scoped but NOT written here.

---

## 6. Decision 6 — Rollback story

**Recommended: rollback is a per-flush automatic fallback to the
always-on JS-SSOT shadow, plus a runtime config flip for
persistent divergence — no redeploy, no data loss.**

The rollback path has three tiers, all enabled by Decision 1.2
(the JS engine never leaves the hot path):

1. **Per-flush automatic (the common case).** Decision 1.3 step 5:
   if the per-flush byte-compare between the `commit_batch`
   `BatchBridgeResult.commits` and the JS engine's accumulated
   `Commit`s diverges, the flush **does not promote** the Rust
   post-state. The JS-engine post-state stays canonical for that
   window. The adopter-facing `commit()` returns were the JS
   engine's *all along* (Decision 1.2) — so a divergence is
   **invisible to adopter `commit()` / `read()` / `subscribe()`**;
   only the WASM-side mirror (which shadows `snapshot()` /
   `exportModel()`) would have lagged, and it simply does not get
   the divergent promotion. The captured-error seam already exists
   (`BatchedFlush.#error`, index.ts:625 / 803-808, surfaced via
   `__getBatchedFlushForTests().error` and the C.5 gate's assertion
   path).
2. **Sticky downgrade (persistent divergence).** If divergence
   recurs across K consecutive flushes (K pinned in V2
   implementation; proposed K=1 for fail-safe — first divergence
   downgrades), the backend **sticky-downgrades that graph to
   `engine: 'js-ssot'`** for the remainder of the graph's lifetime
   and records the divergence for the adopter's structured-error
   surface (the `WasmBackendUnavailableError`-style `code` dispatch
   the §17.6 host-tier fallback contract already uses —
   CONSTRAINTS §1a row). No data loss: the JS engine's state is
   the authority and is already complete.
3. **Adopter-initiated runtime flip.** Because the opt-in is
   per-graph runtime config (Decision 2, *not* a build flag), an
   adopter who observes a production issue flips `engine:
   'rust-ssot'` → omit it (or `'js-ssot'`) and redeploys *config*,
   not a rebuilt binary. The graph behaves byte-identically to dev
   `b07df102` the moment the flag is gone (the load-bearing
   default-off acceptance property, Decision 2.2).

**The JS-SSOT shadow is ALWAYS present under v2.x** — that is the
non-negotiable design constraint that makes all three tiers work.
v2.x never reaches a state where the Rust engine is the *only*
authority; the §0 honest framing (current WASM is ~85× slower)
makes "Rust-only" indefensible until the tripwire clears anyway,
so "JS shadow always present" costs nothing the design wasn't
already paying.

**Surface-area estimate**: tier 1 is the Decision 1.3 per-flush
guard (already counted). Tier 2 is ~1 consecutive-divergence
counter + sticky flag + structured-error code (~30–40 LoC). Tier 3
is free (it is just *not passing* the opt-in — the Decision 2.2
default-off property already guarantees byte-identity). Total
rollback-specific surface: ~30–40 LoC + the structured-error code
constant.

---

## 7. Constraint-rubric delta vs option (c)

v2.x inherits every option-c Answer-C rubric answer
(`docs/epic-1483/option-c-batched-boundary.md` §8) **except** the
perf rows, which change as follows (honest framing preserved):

| Constraint (CONSTRAINTS §3) | Option (c) v1.x | v2.x rust-ssot (opt-in) |
| --- | --- | --- |
| `equality-cutoff` ≤ 2.017 ms/10k (TS baseline) | YES (JS SSOT) | **NO when opted in** — ~85× regression, by design, §0/§4.2 |
| §3 ≤50 ns/op boundary tax | PARTIAL (N≥312) | Crossing tax: YES at N=312 (T4). **Engine-exec tax: NO** (~17 μs, not a boundary cost — T1) |
| §17.5 band held (3.0–8.0×) | YES (JS SSOT, v1.x) | **YES at v2.x default** (default stays JS-SSOT); band only at risk if the *future* promotion lands (Decision 5 point 6) |
| Cross-backend determinism gate green | YES (shadow) | **YES, promoted to load-bearing** (T3 — the GO/NO-GO proof) |
| Kill-criterion | None at Answer C (JS SSOT) | **The tripwire IS the kill-criterion inverted**: v2.x is *expected* to "fail" the perf floor at current maturity; that is the designed state, not a STOP. Only T3 (determinism) red is a true STOP. |

---

## 8. Surprises found during research (honest, both directions)

1. **The swap point is the flush body, not `commit()` — and that
   makes v2.x dramatically lighter-touch than the #1515 framing
   implies (better than assumed).** Because option-c Answer C
   already keeps the JS engine as the synchronous per-commit
   authority, "promote Rust to SSOT" reduces to *"trust the Rust
   post-state for the mirror at flush, after a byte-compare"* —
   `commit_batch`, `marshalBatchEnvelope`, `applyBatchBridgeResult`,
   and the C.5 gate **all already exist and need zero structural
   change**. The v2.x cascade is mostly *promoting existing shadow
   wiring to load-bearing*, not building new wiring.
2. **The ~85× gap is engine-exec, and #1493 provably cannot touch
   it (worse than a casual reading assumes).** The F-marshal.6.1
   profile (#1479 comment 4455257530) isolated `wasmApplyWrites`
   (the marshal) at 3.1 ms/10k and `wasmCommitWithIntent` (the
   engine call alone) at 171.4 ms/10k. #1493's entire value is
   amortising the *marshal/crossing* tax — which is **already the
   cheap component**. The expensive component (`transition_phased`
   walk + `State::clone()` in linear memory) is *downstream of
   every boundary optimisation*. v2.x cannot make this faster; only
   WASM-runtime maturity (GC GA killing the linear-memory clone,
   JIT/SIMD on the phase pipeline) can. The tripwire T1 axis is the
   honest encoding of this.
3. **The §17.5 lower bound gives the tripwire a non-arbitrary
   number (better than "pick an X").** #1516 asked us to "propose X
   with rationale". The SPEC §17.5 3.0× lower-bound clause already
   *names promotion of the WASM substrate to default* as the
   architectural-breakthrough escape valve and pins 3.0× as the
   floor below which the band cannot honestly go. The tripwire T1
   threshold is therefore *the SPEC's own number*, not an invented
   one — which makes the tripwire defensible against a future
   "where did 3× come from?" audit.
4. **T4 already clears today (no help to the bet — neutral but
   worth stating honestly).** C.6 measured 50.1 ns/op at N=312
   (SPEC §17.5 trail addendum). The crossing tax is solved. This is
   *not* progress toward the bet clearing — it just confirms the
   binding constraint is unambiguously T1 (engine-exec), exactly as
   #1515 framed it. The bet does not get easier because a
   non-binding axis is green.
5. **No SPEC amendment for v2.x, but the future promotion needs two
   (§17.5 + §17.6) — and the SPEC already anticipated this.** SPEC
   §17.5's lower-bound clause and §17.6's host-tier "default
   engine" line were *written ahead* of any swap precisely to be
   the named escape valve. v2.x scoping the amendment out (to the
   future promotion decision) is consistent with how every prior
   FFI-boundary amendment (#1124, #1333, #1493 C.7) was
   sequenced: document the no-amendment decision now, amend at the
   decision that actually changes the contract.

---

## 9. Honest GO / NO-GO recommendation

**GO on v2.x as future-facing infrastructure**, with the framing
recorded verbatim in the SPEC §19 trail row (the V2-final ticket):

> v2.x ships the Rust-SSOT cutover behind an explicit per-graph
> opt-in (`engine: 'rust-ssot'`), default-off, byte-validated
> per-flush against the always-on JS-SSOT shadow. It delivers
> **ZERO adopter perf at current WASM maturity** — the
> Rust-engine-in-WASM per-commit execution cost is ~85× the TS
> engine (#1479 comment 4455257530), a property of today's WASM
> runtime (no GC GA, limited JIT, no SIMD) that #1493's batching
> provably cannot amortise. The #1133 falsification is **NOT
> refuted**. v2.x is infrastructure investment against future WASM
> maturity; promotion to default is a separate, tripwire-gated,
> SPEC-amending future decision explicitly out of epic #1515's
> scope.

- **Confidence HIGH** that v2.x is *structurally feasible and
  lightest-touch* — the swap is promoting existing shadow wiring,
  not building new architecture (surprise #1).
- **Confidence HIGH** that v2.x delivers **no current perf win**
  and the doc says so without hedging — this is the designed
  state, not a failure (§0, §4.2, §7 kill-criterion row).
- **Confidence HIGH** the tripwire is concrete + re-measurable: all
  four probes already exist; T1's threshold is the SPEC's own
  §17.5 number (surprise #3).
- **The bet is honestly hard**: T1 needs a ~28× WASM-runtime
  improvement (85× → 3×) that no current runtime delta delivers.
  v2.x is a *position*, not a *win*. That is exactly what #1515
  asked for, and this doc does not dress it up as anything else.
