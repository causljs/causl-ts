# Feasibility study (c) — batched-commit boundary

> Re-architecture epic #1483, feasibility candidate **C** (batched
> commits across one FFI envelope). Sibling studies: #1485 (native
> binary, option (a)), #1486 (in-place mutation, option (b)).
>
> Read alongside `docs/epic-1483/CONSTRAINTS.md` (the constraint
> rubric this doc fills against). Anchored at dev `336ec6bd`
> post-#1484 (PR #1489).

## 0. Premise (one sentence)

Keep every byte of the current Phase-1 architecture — TS engine SSOT,
Rust engine port reused as `commit_batch` peer, both bridge crates
unchanged in shape — and add a **JS-side commit queue** that buffers
**N commits** before a single `Vec<Action>` envelope crosses the FFI
boundary, amortising the 15.64 μs / op marshal tax across the batch
window. At `N=1` the architecture is byte-identical to today; at
`N=312` the per-commit boundary tax falls below the 50 ns
kill-threshold derived in #1484's §3.

This is the **lightest-touch** of the three candidates: nothing in
#1133's 75 PRs is structurally thrown away; the only contract
migration is the adopter-API timing question (Promise vs sync
commit-return), and N=1 is the default so existing adopters see zero
behavioural change unless they opt in.

---

## 1. Boundary cost projection at varying N

### 1.1 Arithmetic

Anchor: F-marshal.6 (PR #1478) measured **15.64 μs / commit** as the
full bidirectional marshal envelope (JS→Rust serialise + Rust→JS
deserialise + bridge call) against the production
`serde-json`-bundled artefact at
`packages/core/wasm-pkg/serde-bundler/engine_rs_bg.wasm`. The
component decomposition (G.1 / F-marshal.6 trail row):

- `op-rust-bridge-floor-1k` (FFI alone, no engine work): **1.687 μs**
- `op-wasm-boundary-1k` (FFI + `Action::Tick`): **2.575 μs**
- Full commit envelope: **15.64 μs** (= 1.687 μs FFI + 13.95 μs
  serde marshal + Phase A–H engine work in WASM)

The marshal cost (∼13.95 μs) is dominated by serde encode/decode of
the `inputs: Vec<InputCell>` block and the `BridgeResult` triple. In
batched mode, **one** envelope carries N commits' worth of action
payload, so the per-commit boundary tax is **(15.64 / N) μs**:

| N | Per-commit boundary tax | Per-10k-commit marshal cost | Status vs §3 50 ns floor |
| ---: | ---: | ---: | --- |
| 1 (today) | **15.64 μs / commit** | 156.4 ms | 313× over the floor — fails on every contract-bearing cell |
| 10 | **1.564 μs / commit** | 15.64 ms | 31× over — fails `scrolling-viewport` (1.418× the cell's full TS workload) |
| 50 | **313 ns / commit** | 3.13 ms | 6.3× over — fails `scrolling-viewport` and `spreadsheet-100x100` |
| 100 | **156 ns / commit** | 1.564 ms | 3.1× over — fails `scrolling-viewport`; **passes `equality-cutoff`, `batch-commit`, `linear-chain`** |
| 200 | **78 ns / commit** | 0.782 ms | 1.56× over — fails only `scrolling-viewport` |
| **312** | **≈50 ns / commit** | **≈0.5 ms** | **floor met on every cell** (the #1484 §3 kill-threshold) |
| 500 | 31.3 ns / commit | 0.313 ms | passes all cells with 1.6× headroom |
| 1000 | 15.64 ns / commit | 0.156 ms | passes all cells with 3.2× headroom |

### 1.2 Does N=10 cover most adopter workloads?

Map against the six contract-bearing cells from #1484's §3 table.
"Adopter target rate" is the inverse worst-case from §3: how many
commits per second the cell sustains at 60 Hz × 1 commit/frame, then
how many fit in 1 ms of headroom.

| Cell | TS per-op (μs) | Per-frame budget (μs/16.67ms) | N to meet ≤50 ns floor (smallest) | N to break even with TS work | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `equality-cutoff` | 0.202 | 82513 ops | **N ≥ 100** | N ≥ 78 (15.64μs / 0.202μs) | Per-frame fits trivially at N=10 |
| `equality-cutoff-fanout-10k` | 0.386 | 43178 ops | **N ≥ 100** | N ≥ 41 | Fan-out dominates; boundary irrelevant once N≥50 |
| `spreadsheet-100x100` | 0.033 | 505 ops | **N ≥ 312** | N ≥ 475 | Worst cell for boundary tax — the 475× number from #1484 |
| `scrolling-viewport` | 0.011 | 1515 ops | **N ≥ 312** | N ≥ 1418 | Worst cell; needs the biggest batch |
| `batch-commit` | 0.215 | 77530 ops | **N ≥ 100** | N ≥ 73 | Already-coalesced workload; structural match for batched mode |
| `linear-chain` | 0.582 | 28659 ops | **N ≥ 50** | N ≥ 27 | Long fixpoint; engine work dominates |

**Verdict on N=10 vs N=100**:

- **N=10** does **not** meet the #1484 §3 50 ns boundary floor on any
  cell — best case is `linear-chain` at 1.564 μs / 0.582 μs = 2.7×
  the TS work. It meets the "break even with TS work" bar for
  `linear-chain` and `equality-cutoff-fanout-10k` only.
- **N=100** meets the floor on 4 of 6 cells (`equality-cutoff`,
  `equality-cutoff-fanout-10k`, `batch-commit`, `linear-chain`) and
  breaks even with TS work on the other two. **N=100 is the
  "production-grade" target** for batched mode.
- **N=312** meets the floor on **all six** cells — the
  kill-threshold target derived in #1484.

The 60 Hz × 1 commit/frame UI workload (typical `useDispatch` flow)
generates **60 commits/sec**, so at N=100 the **flush latency** is
~1.67 seconds — unacceptable for UI without count-based or
time-based escape hatches (see §2.3).

---

## 2. Adopter-API impact

### 2.1 The "when does my commit land?" question

This is the single load-bearing contract migration of option (c).
SPEC §5 says `graph.commit(intent, run): Commit` returns a frozen
`Commit` synchronously after Phases A–H have run; the Markbåge note
at SPEC line 321 reinforces that "by the time the dispatcher's
`Promise<void>` (it isn't one — it's plain `void`) resolves, every
per-node subscriber and every `subscribeCommits` observer has fired"
— this is the §5 single-pipeline guarantee carried into React.

A naive batched architecture has three possible answers:

**Answer A — `commit()` returns Promise<Commit>**. Resolves after the
batch flush carries it across the FFI and Phase G/H subscribers fire.
Adopter-visible change: every `commit()` call site becomes async;
breaks every existing synchronous adopter (`useDispatch`, `update`
runner, every test). React `useSyncExternalStore` reads the
post-commit value via subscriber-fired snapshot, but the
synchronous-after-dispatch invariant SPEC §3 Theorem 2 forecast for
the FFI boundary breaks.

**Answer B — `commit()` returns Commit synchronously with deferred
apply**. The returned `Commit` is the **predicted** one (engine work
runs JS-side speculatively against the in-memory state); the FFI
flush is a background reconciliation that may detect divergence and
publish a correction event. **Discarded** because (a) it breaks SPEC
§15.1 byte-identity (the wire-format gate would diverge from the
adopter-visible `Commit`), and (b) it requires double-running the
engine — once JS-side to mint the synchronous return value, once
WASM-side at flush. The whole reason for batched mode is to *avoid*
the per-commit FFI; running the engine JS-side defeats it.

**Answer C — `commit()` returns Commit synchronously by routing
through the JS engine when batched mode is active**. The JS engine
is the SSOT; the WASM bridge runs in a "buffered shadow" mode
identical to today's F-marshal.5 / .6 wiring, except the shadow flush
is deferred from per-commit to per-batch-boundary. The cross-backend
determinism gate (#685, 1000 trials × 0 byte differences) fires at
flush time on the accumulated `Vec<Action>`.

**Decision pinned: Answer C**. Rationale:

1. **Zero adopter contract migration**. `commit()` keeps its
   synchronous shape; the SPEC §5 phase A–H ordering runs in the
   JS engine. The only thing that batches is the *wire crossing*,
   not the *commit semantics*.
2. **Preserves SPEC §3 Theorem 2 atomicity** (no microtask between
   Phase E publish and Phase G dispatch — both run JS-side on the
   same tick).
3. **Preserves SPEC §15.1 byte-identity** at flush boundary: the
   batched `Vec<Action>` arrives at the WASM side carrying the same
   action sequence the JS engine just executed, so the gate
   compares post-state byte-equal exactly as it does today, just at
   a coarser tempo.
4. **Defers the kill-threshold benefit** until adopters explicitly
   want the speed. Option (c) under Answer C *does not by itself
   beat today's TS engine on adopter workloads*; it only beats
   today's hypothetical SSOT-swap to a real-Rust marshaler. The
   batched boundary is the **enabling architecture** for a later
   SSOT swap once the Rust engine on the WASM side has incorporated
   capability coverage (the F-marshal track only goes through .7,
   which is snapshot/hydrate, not full SSOT).

The candid framing: **under Answer C, option (c) does not improve
adopter perf at v1.x** — it lays the architectural foundation so a
later cutover can move SSOT to WASM without re-paying the per-commit
boundary tax. The recommendation in §10 weighs this candidly.

### 2.2 Flush triggers

Two triggers, OR'd, plus a manual escape hatch:

| Trigger | Default | Configurable | Rationale |
| --- | --- | --- | --- |
| **Count-based** (`flushAfterN`) | 100 | yes, per-graph | Hits the §1.2 "production-grade" target. Adopters with `scrolling-viewport`-shaped workloads can dial up to 312+. |
| **Time-based** (`flushIntervalMs`) | 16 | yes, per-graph | One animation frame at 60 Hz. Prevents arbitrary latency when commit rate is below `flushAfterN / 16 ms` (≈ 6.25k commits/sec at N=100). |
| **Manual** (`backend.flush()`) | — | always available | Adopter escape hatch for "I need the wire bytes to land NOW" (e.g., before navigation, before `snapshot()`, in tests). |
| **Implicit** (snapshot / read-from-WASM / dispose) | — | always | Any path that needs the WASM-side state to reflect committed work forces a synchronous flush. |

Critically: under **Answer C**, the JS engine is SSOT, so reads,
subscriber dispatch, and `Commit` returns do **not** require a flush.
Only `snapshot()` (which today shadows through the marshaler per
F-marshal.7) and cross-backend determinism gate runs trigger an
implicit flush.

### 2.3 Migration story

For existing adopter code (which assumes sync commit-land):

1. **Default `flushAfterN = 1`**. Behaviour byte-identical to dev
   `336ec6bd`. Zero migration. Zero opt-in flag needed.
2. **Opt-in `createCausl({ batchedFlush: { afterN: 100 } })`**.
   Adopters who want the batched-mode wire amortisation set it
   explicitly. The `Graph` surface returned is unchanged.
3. **Per-graph, not global**. Default and override both live on
   `createCausl(options)` so multi-graph adopters (`@causljs/sync`,
   embedded use-cases) can opt in per graph without cross-graph
   coupling.

The migration story for existing adopter code that assumes sync
commit-land is therefore **trivial**: nothing changes unless the
adopter passes the new option, and even when they do, the
synchronous `commit()` return contract is preserved (the wire-format
flush is the only thing batched).

---

## 3. GraphTime monotonicity

### 3.1 The "does now advance per-batch or per-commit?" question

SPEC §3 Theorem 4 and §5.1 Phase C are unambiguous: `commit` is the
ONLY way `now` advances, by exactly one tick. The four-line
denotational page in §3 rejects "monotone but skipping ticks is
allowed" (line 92: "rejected because batching breaks the §11 liveness
contract that every state change is a commit").

**This pins option (c)'s answer**. Under Answer C from §2:

- The JS engine advances `now` synchronously on every `commit()`
  call. `graph.now` at any synchronous observation point is the
  count of commits issued since graph construction. **One tick per
  commit. Always.**
- When the batch flushes, the WASM-side bridge receives a
  `Vec<Action>` containing N `Action::Commit` envelopes; the Rust
  engine's `transition_phased` body processes them sequentially,
  advancing the WASM-side `state.now` by 1 per action, ending at
  the same `now` the JS engine already advanced to.
- The wire format carries N `CommitRecord` entries with
  `time = now+1, now+2, …, now+N` exactly the way an
  un-batched run of N single-commit envelopes would.

The cross-backend determinism gate (F-marshal.5, 1000 trials × 0
byte differences) fires against the post-flush state and compares
byte-identical: a single `Vec<Action>` containing N actions produces
the same end-state and the same N `CommitRecord` entries as N single
envelopes, by construction of `transition_phased`'s loop body.

### 3.2 SPEC §5.1 Amendment 4 (IndexMap container pin)

Amendment 4 pins the Phase G subscriber container to insertion-order
iteration (`IndexMap<NodeId, …>` on Rust, `Map<NodeId, …>` on JS).
Batched mode preserves this **trivially** because Phase G fires
JS-side per commit (Answer C) before the flush ever happens; the
WASM-side recompute on flush re-runs Phase G against the WASM
engine's own IndexMap, which the F-marshal.5 gate already validates
as byte-identical to the JS Map iteration order.

There is no new container choice introduced by batched mode. The
amendment survives in both engines unchanged.

### 3.3 The hypothetical "WASM-SSOT future" footnote

If a future option-c sub-track promoted WASM to SSOT (the "real-Rust
engine" cutover #1133 originally targeted), the per-commit
`now`-advancement contract would force the Rust side to publish N
intermediate `CommitRecord` entries from the single batch envelope,
fanning them back across the FFI to JS subscribers. The fan-back
cost is roughly **one boundary crossing per fired Phase G observer**
times **N commits** — destroying the amortisation. This is the
hidden cost the JS-engine-SSOT framing in Answer C avoids: by
keeping the JS engine authoritative for subscriber dispatch, batched
mode pays the boundary tax once per batch, not once per commit's
subscriber fan-out.

---

## 4. Subscriber-fire timing

### 4.1 The choice

SPEC §5.1 Phase G fires per-node subscribers synchronously per
commit. SPEC §15.3 (subscriber callback semantics, current) says
fire-per-commit synchronously, in insertion order of `changedNodes`,
inside the same call stack as `commit()`'s synchronous return.

Batched mode introduces two valid SPEC interpretations:

**(i) Per-commit fire (mid-batch)** — each `commit()` call inside
the batch window fires Phase G synchronously. The batch flush is a
background wire reconciliation; subscribers never see the batch
boundary.

**(ii) End-of-batch flush** — Phase G fires N commits' worth of
subscriber notifications coalesced at flush time. Adopters see N
ticks' worth of subscriber callbacks in a single synchronous burst
at the flush boundary.

### 4.2 Decision pinned: (i) per-commit fire

Rationale, with explicit trade-off accounting:

1. **Preserves the §3 single-tick atomicity proof structure**. Each
   commit is its own observable event; the §3 Theorem 2
   uninterruptibility amendment (#1333) bounds *one* envelope
   between Phase E and Phase G — extending the bound across N
   envelopes would require a §3 amendment.
2. **Preserves the §8 MVU contract** (line 321 of SPEC): "by the
   time the dispatcher's `Promise<void>` (it isn't one — it's
   plain `void`) resolves, every per-node subscriber and every
   `subscribeCommits` observer has fired". Choice (ii) breaks this
   sentence and forces a SPEC §8 amendment.
3. **Preserves the §14 frame-budget contract** (≤16 ms p95
   commit-to-paint, ≤5% dropped frames over 30 s). Choice (ii)
   coalesces N commits' subscriber dispatch onto one synchronous
   burst; if N=100 commits each fan out to ~10 subscribers (typical
   `equality-cutoff-fanout-10k` shape) the burst is 1000 subscriber
   callbacks at flush time — guaranteed long task, guaranteed
   dropped frame.
4. **Costs nothing in the boundary math**. The §1 table is unchanged
   between (i) and (ii) because the wire envelope contains the
   same `Vec<Action>` in both cases; the only difference is when
   the JS-side Phase G dispatch fires, and under Answer C that
   dispatch runs from the JS engine's authoritative state
   regardless of batching.

The cost of choice (i): the cross-backend determinism gate's Phase
G assertion (currently fires per-commit on the WASM-side mirror)
needs a minor adjustment to compare batched-aggregate state at flush
boundary rather than per-commit state. This is a one-PR test-harness
change inside `packages/core/test/properties/cross-backend-determinism.property.test.ts`,
not a SPEC amendment.

### 4.3 SPEC §15.3 status

§15.3 says subscriber-fire is per-commit synchronous. Choice (i)
preserves this verbatim. No SPEC amendment needed.

---

## 5. Reuse from #1133's 75 PRs

| Artefact | Reuse | Touch needed |
| --- | --- | --- |
| `tools/engine-rs-core/` (Rust engine port, 1000 trials × 0 byte differences) | **Verbatim** | None — `transition_phased` already loops over arbitrary `Action` sequences; a `commit_batch` extern is a one-line wrapper that calls `transition_phased` N times on a `Vec<Action>`. |
| `tools/engine-rs-bridge-serde/` (serde-json bridge) | **Verbatim** | Add `commit_batch(state, actions: Vec<Action>) -> BridgeResult` extern alongside existing `commit(state, action)`. ~30 lines. Existing `commit` extern stays as the N=1 fast path. |
| `tools/engine-rs-bridge-gc/` (WasmGC bridge) | **Verbatim** | Same one-line additional extern. |
| `packages/core/wasm/marshaler.ts` (JS-side mirror + envelope marshal) | **Verbatim** | `marshalCommitEnvelope` already returns `{state, action}`; a new `marshalBatchEnvelope` returns `{state, actions: Vec<Action>}` reusing the same input-cell resolution loop. ~40 lines. |
| `applyBridgeResult` (Rust→JS post-state projection) | **Verbatim** | A new `applyBatchBridgeResult` iterates N `CommitRecord` entries and projects each into a `Commit`. ~30 lines. |
| Multiplex routing (#1459 decision) | **Verbatim** | The "one bridge per artefact, multiplex on bridge id" decision is orthogonal to commit batching. Both bridges gain the `commit_batch` extern; routing is unchanged. |
| Cross-backend determinism gate (#685, F-marshal.5) | **Verbatim with one adjustment** | The gate's per-commit assertion path becomes per-batch-flush at flush boundary. One-PR test harness change. |
| Test discipline (1000-trial floor, `propertyTrials`) | **Verbatim** | A new `commit_batch.property.test.ts` exercises the N=1, N=10, N=100, N=312 axes against the same property set. |
| SPEC §17.6 host-tier matrix | **Verbatim** | No change — option (c) inherits the WASM substrate; the three-tier bridge matrix and the JS-engine fallback floor are unchanged. |
| SPEC §17 commitment 13 capability-cost residual | **Verbatim** | The 3.0× ≤ ratio ≤ 8.0× band is unchanged at v1.x. Option (c) at Answer C does not move the ratio because the JS engine remains SSOT for adopter workloads. |
| Bench infrastructure (`packages/bench/`) | **Verbatim with additions** | Add `op-rust-batch-boundary-{10,100,312,1000}` cells alongside the existing G.1 probes. |

**What's thrown away**: nothing structural. The only adopter
contract migration is the new opt-in `batchedFlush` option on
`createCausl`. Existing adopter code is byte-source-identical to
the v0.9.0 release.

---

## 6. Effort estimate

Option (c) is the lightest-touch of the three candidates because it
adds capability rather than re-architecting the boundary.

| Phase | Scope | PRs | Weeks |
| --- | --- | --- | ---: |
| **C.1 — Rust-side `commit_batch` extern** | Both bridge crates gain `commit_batch(state, actions) -> BridgeResult` calling `transition_phased` N times. Unit tests at N=1, N=10, N=100, N=312. | 2 | 0.5 |
| **C.2 — JS-side `marshalBatchEnvelope` + `applyBatchBridgeResult`** | New marshaler helpers; reuses input-cell resolution and post-state projection from F-marshal.5/.7. | 2 | 0.5 |
| **C.3 — `BatchedFlush` queue on `WasmBackend`** | The JS-side queue: collect `Action`s in a buffer; flush on count, time, manual, or implicit. Reuses the F-marshal.5 shadow path. | 3 | 1 |
| **C.4 — Adopter API: `createCausl({ batchedFlush })`** | Wire the per-graph option through `createCausl` → `WasmBackend`. Default `afterN=1` preserves byte-identical v0.9.0 behaviour. | 2 | 0.5 |
| **C.5 — Cross-backend determinism gate adjustment** | Gate fires per-flush instead of per-commit on the WASM mirror. One test-harness PR. | 1 | 0.25 |
| **C.6 — Bench probes** | `op-rust-batch-boundary-{10,100,312,1000}` cells; falsify the §1 arithmetic; update SPEC §17.5 if numbers diverge from arithmetic projection. | 2 | 0.5 |
| **C.7 — SPEC trail rows + adopter docs** | §17.6 amendment (none needed at Answer C — record this); `docs/wasm-adoption-guide.md` adds the batched-flush opt-in section. | 1 | 0.5 |
| **Total** | — | **13 PRs** | **≈ 3.75 weeks** |

Compare:

- Option (a) native binary: rebuilds the entire deployment pipeline,
  adds per-platform-binary distribution for the engine (not just
  `causl-check`), and forces a §17.6 amendment for the browser-target
  retirement. Estimated 12–16 weeks per #1485.
- Option (b) in-place mutation: replaces the `commit(state, action)`
  bridge surface with per-write FFI mutator calls, reshapes
  `BackendEngine.commit` away from the `ReadonlyMap` argument
  shape, and forces a cross-backend determinism gate redesign.
  Estimated 6–10 weeks per #1486.

Option (c) is the only candidate that ships in **a single sprint**.

---

## 7. Compatibility window

| Question | Answer | Anchor |
| --- | --- | --- |
| Can N=1 be the default? | **Yes**. At N=1 the queue holds one action and flushes immediately. Byte-identical to dev `336ec6bd` behaviour. | §2.3, §3.1 |
| Do adopters opt in to N>1? | **Yes**, via `createCausl({ batchedFlush: { afterN: N, intervalMs: M } })`. No global opt-in; configuration is per-graph. | §2.3 |
| Per-graph or global? | **Per-graph**. `@causljs/sync` and multi-graph adopters opt in per graph without coupling. | §2.3 |
| Does the existing `auto-adapt` surface need to flip on batched mode? | **No, but it could later**. `shouldMigrate(stats)` (`packages/core/src/auto-adapt.ts`) is the natural seam; v1.x ships explicit opt-in only. A future `AdaptThresholds.batchedFlushAfterN` field could promote workloads automatically. | §1b CONSTRAINTS migratable surface |
| Does `commit()` change shape? | **No**. Returns `Commit` synchronously. The only thing that batches is the wire crossing, not the commit semantics. | §2.1 Answer C |
| Does `graph.now` advance per-commit? | **Yes, always**. SPEC §3 Theorem 4 invariant preserved. | §3.1 |
| Does `subscribeCommits` fire per-commit? | **Yes, per-commit synchronously**, per §15.3 unchanged. | §4.2 |

---

## 8. Constraint rubric checklist (from #1484's §6)

Column "Option (c) batched commit" filled below. Format: **(answer)
— evidence**.

| Constraint | Option (c) batched commit |
| --- | --- |
| **§1a Non-negotiable adopter surface preserved without codemod** | **YES** — Answer C from §2.1 preserves every row of #1484's §1a table. `commit()` keeps sync `Commit` return; `subscribeCommits` keeps per-commit fire; the canonical seven plus second-tier surface are byte-source-identical. |
| **§1b Migratable surface — codemods + lints required** | **NO codemod needed**. Only opt-in `createCausl({ batchedFlush })`; existing adopter code unaffected at default `afterN=1`. The #1484 §1b row "`commit()`-as-synchronous vs `commit()`-as-batched" resolves to "synchronous preserved" — §2.1 Answer C. |
| **§2 Browser deployment** | **YES** — inherits today's WASM bridge artefacts; no change to `loadWasmBackend()` host-detection or CSP posture. §17.6 host-tier matrix unchanged. |
| **§2 Node deployment** | **YES** — inherits. SSR `Hydrate` and bench / determinism / property-suite host paths run today's path. |
| **§2 Native deployment (per-platform binary)** | **N/A** — option (c) does not introduce a native engine. The `@causljs/checker-{darwin,linux,win32}-*` per-platform binaries remain unchanged. |
| **§2 Cloudflare Workers / edge** | **YES** — inherits the universal `serde-json` bridge; Workers run today's path with `commit_batch` added as a peer extern. |
| **§2 Embedded runtimes (RN, Hermes) — TS fallback floor preserved** | **YES** — TS engine remains the SSOT under Answer C; the §17.6 commitment-14 floor is unchanged. |
| **§3 Per-commit perf — ≤ 50 ns per op boundary tax on every contract-bearing cell** | **PARTIAL — depends on N**. At N=312 every cell meets the floor; at N=100 four of six cells meet the floor; at N=1 (default) no cell meets the floor. The architecture *enables* the floor; adopters opt in by configuring N. See §1.2 table. |
| **§3 `equality-cutoff` cell ≤ 2.017 ms / 10k (TS baseline)** | **YES at Answer C** — JS engine is SSOT; the cell runs the TS engine's path unchanged. |
| **§3 `scrolling-viewport` cell ≤ 0.112 ms / 10k (TS baseline)** | **YES at Answer C** — same reasoning. |
| **§3 `spreadsheet-100x100` cell ≤ 0.334 ms / 10k (TS baseline)** | **YES at Answer C** — same reasoning. |
| **§3 SPEC §17.5 band held (3.0× ≤ causl/mobx ≤ 8.0×) on contract-bearing cells** | **YES** — the residual is unchanged at v1.x because the JS engine is SSOT. Option (c) does not move the band in either direction. |
| **§4 TS + new engine coexist for N versions (gradual migration)** | **YES** — both engines coexist today; option (c) adds capability without retiring either. |
| **§4 `createCausl({ backend: 'auto' })` runtime swap surface preserved** | **YES** — `AdaptThresholds` shape unchanged; a future `batchedFlushAfterN` field could promote workloads but is not required at v1.x. |
| **§4 Cross-backend determinism gate green (1000 trials × 0 byte differences)** | **YES** — the gate fires at flush boundary; F-marshal.5's 1000-trial × 0-byte-difference proof carries forward by construction (a single `Vec<Action>` of N actions produces the same end-state as N single-action envelopes via `transition_phased`'s loop). |
| **§4 `Object.is` SameValue parity (incl. NaN / ±0 / lone surrogates)** | **YES** — JS engine SSOT means `Object.is` semantics are TS-engine semantics; no FFI deserialisation on the read path. |
| **§5 SPEC §5.1 Phase A–H named-phase sequencing preserved** | **YES** — Phase A–H runs per-commit in the JS engine; no phase reordering. |
| **§5 SPEC §5.1 Amendment 4 — Phase G IndexMap-shaped container** | **YES** — JS `Map<NodeId, …>` is insertion-order-preserving; the Rust engine's `IndexMap<NodeId, …>` is too. Both sides preserved. §3.2 above. |
| **§5 SPEC §3 Theorem 2 uninterruptibility (no microtask in marshal)** | **YES** — each Phase E publish → Phase G dispatch runs JS-side on a single tick; the FFI envelope at flush time is uninterruptible by construction (a single sync `commit_batch` call). §4.2 above. |
| **§5 SPEC §15.1 value-identity at fixed `GraphTime` (reference identity opt-in)** | **YES** — JS engine SSOT preserves today's reference-identity-trivially behaviour. The §15.1 amendment (#1124) framing applies. |
| **§5 SPEC §17.6 host-tier matrix preserved (no host stranded)** | **YES** — option (c) inherits the matrix verbatim; no §17.6 amendment needed. |
| **Adopter migration cost (codemods needed, deprecation length, RC track)** | **None for default behaviour**. Opt-in `createCausl({ batchedFlush })` is additive; no deprecation cycle; no codemod; no lint. Adopters who want the wire amortisation set one option at graph construction. |
| **What's reused from #1133's 75 PRs (engine-rs-core, marshaler, bridge crates)** | **All of it**. §5 above — engine port verbatim, both bridges verbatim plus one new extern, marshaler verbatim plus one new envelope helper, multiplex routing verbatim, test discipline verbatim. |
| **What's thrown away from #1133's 75 PRs** | **Nothing structural**. |
| **Realistic effort estimate (post-research, weeks)** | **≈ 3.75 weeks, 13 PRs**. §6 above. |
| **Kill-criterion: workload below which this architecture's boundary cost dominates the TS workload** | **None at Answer C** — JS engine is SSOT for adopter workloads, so the boundary cost only applies to the WASM-shadow path (cross-backend determinism gate). The boundary cost dominates only the F-marshal track's shadow validation, never adopter code paths. |

---

## 9. Honest GO / NO-GO recommendation

### 9.1 The candid framing

Option (c) is structurally the most defensible of the three
candidates **and** delivers the least adopter-visible perf benefit
at v1.x. These two facts are not in tension: option (c) is the
*scaffolding* for a future SSOT cutover, not the cutover itself.

Three honest characterisations:

1. **As "the wire-amortisation enabler"**: GO with high confidence.
   The arithmetic in §1 is straightforward; the implementation
   reuses every byte of #1133's 75 PRs; the adopter-API contract is
   preserved without codemod; the SPEC commitments are preserved
   without amendment. Effort estimate ≈ 3.75 weeks, 13 PRs. This is
   the lightest-touch architectural change in the candidate set.

2. **As "the answer to the 78× boundary tax that killed #1133"**:
   PARTIAL GO. Option (c) at Answer C does not move the adopter-
   visible perf because the JS engine remains SSOT. It moves the
   *theoretical* perf ceiling that would obtain if WASM SSOT were
   reactivated at a later epic. Adopters who only see the v1.x ship
   see no perf change.

3. **As "the v1.x ship that the #1483 epic is trying to deliver"**:
   GO if and only if the epic's bar is "preserve the SPEC, ship the
   plumbing for a future cutover, defer the SSOT-swap to a later
   epic". NO-GO if the bar is "deliver adopter-visible perf at v1.x".

### 9.2 Comparison with siblings

- **Option (a) native binary** ships adopter-visible perf at v1.x at
  the cost of a §17.6 SPEC amendment for browser-target retirement
  (or a parallel WASM/JS fallback that doubles the deployment
  matrix). The cost-of-amendment is high; the cost-of-fallback is
  ~12–16 weeks of additional engineering. Recommendation per #1485:
  see that doc.
- **Option (b) in-place mutation** moves the boundary cost off the
  per-commit envelope and onto per-write FFI mutator calls,
  betting that the per-write cost is lower than the per-commit
  cost. The bet is plausible but unproven; the cross-backend
  determinism gate needs a fundamental redesign; the
  `BackendEngine.commit(intent, writes)` shape changes. Estimated
  6–10 weeks per #1486.
- **Option (c)** ships in ≈ 3.75 weeks with zero contract
  migration. It is the only candidate that can ship inside a single
  sprint.

### 9.3 The recommendation

**GO on option (c) as the v1.x ship**, with the following framing
recorded in the SPEC §19 trail row:

> Option (c) ships the wire-amortisation infrastructure that
> enables a future WASM-SSOT cutover without re-paying the per-commit
> boundary tax. At v1.x, the JS engine remains SSOT for adopter
> workloads; the batched-flush capability is opt-in and additive.
> The arithmetic floor required by #1484's §3 perf-floor analysis
> (≤ 50 ns boundary tax per op) is met at N≥312; the adopter API
> contract is preserved without codemod; the SPEC §3, §5.1, §15.1,
> §15.3, §17.6 commitments are preserved without amendment.

**Confidence: HIGH** for the structural feasibility claim.
**Confidence: MEDIUM** for the "this is the right v1.x ship"
recommendation, because the adopter-visible perf benefit is
deferred to a later epic that has not yet been scoped. The honest
answer is that option (c) is the lightest-touch *architectural
preparation* for the boundary problem; the boundary problem itself
is only *resolved* by a later SSOT cutover that this study does not
deliver.

If the #1483 panel reads §9.1 framing #1 ("the wire-amortisation
enabler") as the v1.x bar, this is a clear GO. If they read framing
#3 ("deliver adopter-visible perf at v1.x") as the bar, option (c)
alone is insufficient and one of (a) or (b) is required.

---

## 10. Surprises found during research

1. **The "JS engine SSOT" framing collapses the perf question for
   adopters.** Going into the research, the intuitive read on
   option (c) was "batched commits = N× perf win". The honest read
   is "batched commits = same perf as today, with a tighter ceiling
   for a future SSOT-swap epic". This is the load-bearing surprise.
2. **N=10 does not meet the §3 50 ns floor on any contract-bearing
   cell.** The arithmetic is clean, but the implication is that
   "modest batching" is *not* enough — adopters who opt in need to
   reach N≥100 minimum, N≥312 for full coverage.
3. **The 1.67-second flush latency at 60 Hz × N=100 is a real adopter
   constraint.** Time-based flush (`flushIntervalMs ≤ 16`) is
   non-optional, not an escape hatch.
4. **Subscriber-fire timing is forced by SPEC §3 Theorem 2 and §8 MVU
   line 321** to be per-commit, not end-of-batch. End-of-batch fire
   would require two SPEC amendments and would break the §14
   frame-budget contract. Choice (i) in §4 is structurally pinned,
   not a coin-flip.
5. **`Vec<Action>` is already structurally supported** by the Rust
   engine. `transition_phased` in `tools/engine-rs-core/src/lib.rs`
   takes a single `Action`, but adding a `commit_batch` extern that
   loops over a `Vec<Action>` is mechanical — no engine internals
   change. The `Action` enum's `Commit` variant already carries
   `intent` and `writes`, so a batch is just N envelopes of the same
   shape.
6. **The cross-backend determinism gate adjustment is one PR**, not
   a redesign. The F-marshal.5 proof structure (1000 trials × 0
   byte differences) carries forward by construction because the
   loop body of `transition_phased` over a `Vec<Action>` produces
   the same end-state as N single-action runs. Compare with option
   (b), which forces a fundamental gate redesign.
