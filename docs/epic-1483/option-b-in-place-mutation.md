# #1486 — Feasibility study (b): in-place State mutation surface

> Re-architecture epic #1483; predecessor #1484 (constraint rubric at
> [`CONSTRAINTS.md`](./CONSTRAINTS.md)). Anchored at dev `336ec6bd`
> (post-#1484). Pure research; no engine / bridge code is touched by
> this PR.

---

## 0. Premise & framing

**The (b) hypothesis:** redesign the engine FFI so the JS side never
sends or receives a full `State`. The bridge owns the canonical state
in WASM linear memory and exposes per-write **mutator methods**. A
commit becomes a sequence of FFI calls — `beginCommit` / `stage(node,
value)` / `commit()` / (`rollback()` on the catch arm) — rather than
the current `commit(state: JsValue, action: JsValue) → JsValue` shape
([`tools/engine-rs-bridge-serde/src/lib.rs:476-537`](../../tools/engine-rs-bridge-serde/src/lib.rs)).

**The arithmetic this is built on** comes from G.1
([`docs/epic-1133/G1-PERF-MEASUREMENT.md`](../epic-1133/G1-PERF-MEASUREMENT.md)
and SPEC §17.6 Phase-G.1 callout):

- `op-rust-bridge-floor-1k`: **1.687 μs** per FFI round-trip
  (`floor_only_transition`, no engine work).
- `op-wasm-boundary-1k`: **2.575 μs** per round-trip with a no-op
  `Action::Tick` body — the closest analogue to a single mutator call.
- F-marshal.6 full commit envelope: **15.64 μs / commit** end-to-end
  (the cost option (b) is trying to *replace*, not pay).

Per-commit cost projection under option (b):

> `cost = N_writes × ~2.5 μs (per-mutator FFI) + 1 × ~2.5 μs (commit
> FFI)`

The full `Vec<InputCell>` ser/deser disappears — that's the 13 μs
delta between `op-wasm-boundary-1k` (2.575 μs) and F-marshal.6
(15.64 μs). What replaces it is *N* extra round-trips, one per staged
write. Whether that's a win depends entirely on `N`.

---

## 1. Boundary cost projection at varying write-counts

Per-commit cost under option (b), with the **TS-engine baseline** from
[`CONSTRAINTS.md` §3](./CONSTRAINTS.md) for comparison.

The TS baseline column is the median **per-commit** cost (the median
`× 10000` cell divided by 10k). It is the *real engine work* cost the
JS engine pays today, with no FFI tax.

| Cell | Writes / commit | (b) boundary cost / commit | TS engine median / commit | (b) overhead vs TS |
| --- | ---: | ---: | ---: | ---: |
| `equality-cutoff` | 1 | 1 × 2.5 + 2.5 = **5.0 μs** | 0.202 μs | **25× TS work** |
| `equality-cutoff-fanout-10k` | 1 | 5.0 μs | 0.386 μs | **13× TS work** |
| `spreadsheet-100x100` | ~100 | 100 × 2.5 + 2.5 ≈ **252.5 μs** | 0.033 μs | **7651× TS work** |
| `scrolling-viewport` | 1 | 5.0 μs | 0.011 μs | **454× TS work** |
| `batch-commit` | ~10 | 10 × 2.5 + 2.5 = **27.5 μs** | 0.215 μs | **128× TS work** |
| `linear-chain` | 1 | 5.0 μs | 0.582 μs | **9× TS work** |

(Write-count column: `equality-cutoff` / `scrolling-viewport` /
`linear-chain` / `equality-cutoff-fanout-10k` stage one input per
commit; `batch-commit` bulks ~10 writes into one outer commit;
`spreadsheet-100x100` re-stages all 100 visible cells per scroll-tick
in the bench shape — the worst-case write-count cell.)

**The §3 perf-floor** from [`CONSTRAINTS.md` §3](./CONSTRAINTS.md) is
**≤ 50 ns per op** of boundary tax. Translating per-commit costs to
per-op (dividing by 10k, since the bench runs 10k commits):

| Cell | (b) per-op boundary tax | ≤ 50 ns floor held? |
| --- | ---: | --- |
| `equality-cutoff` | 0.5 ns / op (within one commit) — **but 5.0 μs / commit** | Per-op floor: **no**, per-commit floor 50 ns × 1 write × 10k = 0.5 ms; (b) costs 50 ms. **fails by 100×**. |
| `spreadsheet-100x100` | per-commit 252.5 μs → 2525 ms / 10k commits | **fails by 7651×** vs TS work |
| `scrolling-viewport` | 5.0 μs / commit → 50 ms / 10k commits | **fails by 446×** (TS is 0.112 ms / 10k) |

**Comparison to the current F-marshal.6 envelope** (15.64 μs /
commit):

| Cell | F-marshal.6 (current) | Option (b) | (b) win? |
| --- | ---: | ---: | --- |
| 1-write cells (4 of 6) | 15.64 μs | 5.0 μs | **3.1× faster** |
| `batch-commit` (~10 writes) | 15.64 μs | 27.5 μs | **1.8× slower** |
| `spreadsheet-100x100` (~100 writes) | 15.64 μs | 252.5 μs | **16× slower** |

**Crossover point.** Option (b) beats F-marshal.6 when
`N_writes × 2.5 + 2.5 < 15.64`, i.e. `N_writes < 5.3`. Above ~5 writes
per commit, in-place mutation is *worse* than the current envelope
marshal. The win-region is bounded to the small-write-set cells.

**Even in the win-region** (1-write commits), option (b) still costs
**~25× the TS-engine work** for `equality-cutoff`. The 78× boundary
arithmetic from G.1 that falsified #1133 is reduced to ~25× — better
but still well above the kill-criterion floor.

---

## 2. Engine surface redesign scope

### 2.1 What loses the single-step contract

SPEC §16.4.1 lines 1686–1689
([`SPEC.md:1686`](../../SPEC.md)) pins the current contract:

```rust
pub fn transition_phased(
    s: &State, a: &Action,
) -> Result<(State, Vec<(PhaseStep, State)>), RaceClass>;
```

`(s, a) → s'` is single-step: one Rust call, one full State in, one
full State out. Option (b) **breaks this shape**. The engine surface
becomes:

```rust
pub fn begin_commit(intent: &str) -> CommitToken;
pub fn stage_input(token: &mut CommitToken, node: NodeId, value: JsonValue) -> Result<(), RaceClass>;
pub fn commit(token: CommitToken) -> Result<CommitRecord, (RollbackData, RaceClass)>;
pub fn read(node: NodeId) -> JsonValue;
pub fn subscribe(node: NodeId, observer_id: &str);
```

Of the **eight named §5.1 phases** in
[`SPEC.md:143-160`](../../SPEC.md):

- **Phase A (Validate / stage)** — fragmented across N `stage_input`
  FFI calls; the "stage the entire run(tx) callback as one transient
  map" framing collapses. The TS-side `run(tx)` body becomes a *driver*
  that emits stage_input calls, not a body whose throw structurally
  rolls back unstarted phases.
- **Phases B–H** — still single-shot inside `commit()`. The bulk of
  the typestate chain (PhaseB through PhaseH in
  [`tools/engine-rs-core/src/transition/typestate.rs:432-572`](../../tools/engine-rs-core/src/transition/typestate.rs))
  survives.
- **Phase G (subscriber dispatch)** — survives shape but the fire
  timing question (mid-commit vs end-of-commit FFI callback) becomes
  a *new* SPEC question (see §6, new risks).

### 2.2 Typestate machine evolution

Current chain
([`tools/engine-rs-core/src/transition/typestate.rs:432-572`](../../tools/engine-rs-core/src/transition/typestate.rs)):

```
CommitInProgress<PhaseA>
  → PhaseB → PhaseC → PhaseCDot5 → PhaseD
  → PhaseE → PhaseF → PhaseF4 → PhaseF5 → PhaseF6
  → PhaseG → PhaseH → (State, changed_nodes, GraphTime, Vec<PhaseStep>)
```

Under (b), the typestate splits into two regimes:

- **Open-staging regime** (FFI-visible, multi-call): a `CommitToken`
  carries an opaque handle, exposes `stage_input(node, value)`
  callable an unbounded number of times. The Rust-side
  `CommitInProgress<PhaseA>` is *held across FFI calls* in linear
  memory — a fundamental new lifetime shape. This is the hard part:
  the typestate machine's per-phase guarantees today rely on
  `consume self → return next phase`; you cannot consume a handle
  across an FFI boundary, you can only mutate it through a pointer.

- **Closed-execution regime** (single-call, B–H): once `commit(token)`
  fires, the PhaseB→PhaseH chain runs to completion in a single FFI
  call. This part is reusable verbatim.

**Concretely:** PhaseA stops being a typestate phase; it becomes a
**mutable opaque struct held in linear memory** with `&mut self`
methods. The compile_fail doctests at
[`tools/engine-rs-core/src/transition/typestate.rs:162-421`](../../tools/engine-rs-core/src/transition/typestate.rs)
(11 compile_fail blocks) **still work for PhaseB onward** but
**break for PhaseA** — there is no longer a "PhaseA → PhaseB
consume" the type system can refuse to call out-of-order, because
PhaseA is now a mutable handle, not a consume-and-return value.

### 2.3 New test discipline

- **Compile_fail doctests** at the typestate phase boundaries: 11 of
  them survive verbatim (PhaseB onward). The PhaseA→PhaseB boundary
  doctest needs a rewrite: the test would have to assert that the FFI
  surface refuses to accept `stage_input` after `commit(token)` has
  consumed the token. This is no longer a type-system property; it's
  a runtime check.
- **Token-state validity gate** — a new test class. The FFI surface
  must validate that `stage_input(token)` after `commit(token)` is
  rejected (token consumed) and that `commit(token)` twice is
  rejected. Today the type system handles these by `self`-consume;
  under (b) they're runtime errors.
- **Re-entrancy guard** — `stage_input` invoked from inside a
  subscriber callback (during a previous commit's Phase G) must be
  rejected with a `CommitInProgressError` analogue. This is *new
  test surface* without a current analogue, because today commits
  don't have an open-staging window subscribers can see.

---

## 3. Reuse from #1133

Anchored at `tools/engine-rs-core/src/transition/`:

| File | LOC (approx) | Reuse under (b) | Notes |
| --- | ---: | --- | --- |
| `validate.rs` | ~150 | **Verbatim** — precondition gate runs at `commit(token)` entry, identical to today. |
| `clock.rs` | ~80 | **Verbatim** — `advance_clock(&mut State)` is already in-place; no change. |
| `mutate.rs` | ~250 | **Surface-rewrite** — `StagingBuffer` becomes the body of the open-staging token; the per-write FFI calls populate it directly. Internal logic preserved. |
| `publish.rs` | ~300 | **Verbatim** — Phase B publish loop walks the staging buffer; doesn't care how it was populated. |
| `rollback.rs` | ~200 | **Verbatim** — A.6 rollback walker. Triggered by `rollback(token)` FFI on the catch arm OR by `commit(token)` returning `Err`. |
| `compact.rs` | ~150 | **Verbatim** — A.8 fast-path compaction. |
| `stamp.rs` | ~100 | **Verbatim** — A.9 last-write-time stamp. |
| `recompute.rs` / `kahn.rs` / `cutoff.rs` / `cycle.rs` / `atomicity.rs` | ~800 total | **Verbatim** — Phase D Kahn drain, runs entirely inside `commit(token)`. |
| `assemble.rs` / `dispatch.rs` | ~200 | **Verbatim for assembly**; **fire-timing question for dispatch** (see §6). |
| `typestate.rs` | ~2700 | **Surface-rewrite for PhaseA**; **verbatim for PhaseB-H**. The `CommitInProgress<P: Phase>` shape stays for the inner chain; PhaseA's `new()` / `stage()` body becomes the body of the open-staging token. |
| `phase_step.rs` | ~580 | **Surface-rewrite** — the public `transition_phased(s, a)` signature retires. Phase walks are still emitted, but they're recorded into the token's commit-trace buffer and surfaced at `commit(token)`-return, not threaded through the (s, a) signature. |

**Net reuse estimate:** ~80% of `engine-rs-core/src/transition/` is
verbatim. The rewrite is concentrated in the public surface
(`phase_step.rs` + PhaseA half of `typestate.rs`) — call it ~600 LOC
out of ~3000.

The **bridge crates** absorb most of the new code:
`tools/engine-rs-bridge-serde/src/lib.rs:476-537` (the `commit(state,
action)` extern) is **deleted** and replaced with five new externs
(`begin_commit` / `stage_input` / `commit` / `rollback` / `read`).
That's ~150 LOC retired, ~400 LOC added.

---

## 4. Throws away

| Artefact | LOC (approx) | Disposition |
| --- | ---: | --- |
| `transition_phased` / `transition` public API surface | ~100 (signatures + delegators in `transition/mod.rs` and `phase_step.rs`) | **Retired.** Replaced by `begin_commit` / `stage_input` / `commit` token API. |
| Decision 1c hybrid marshaler design | — (design artefact, not code) | **Retired.** F-marshal's whole premise — JS-side state mirror + per-commit envelope shipment — collapses. The mirror remains as a *read cache*; the commit-time marshal is gone. |
| `marshalCommitEnvelope` (~250 LOC, [`packages/core/wasm/marshaler.ts:399-531`](../../packages/core/wasm/marshaler.ts)) | ~250 | **Retired.** The envelope is the artefact (b) eliminates. The `WasmStateMirror` class (lines 110-397) stays as a slot dictionary for `read()` cache + slot allocation; the bulk envelope marshal goes. |
| `applyBridgeResult` (~80 LOC, marshaler.ts:533-614) | ~80 | **Retired.** No more bridge-return envelope to apply. Subscriber fires drive cache invalidation per-node via Phase G's callback. |
| Cross-backend determinism gate semantics | — (test, not code) | **Asymmetric.** TS engine has no `begin_commit` / `stage_input` API; the gate can no longer compare `transition_phased(s, a)` byte-for-byte across backends. Either (i) the gate becomes commit-by-commit at the `Graph.commit()` boundary (degrades the granularity — internal divergences masked by a stable end-state), or (ii) the TS engine grows a parallel mutator API surface purely to satisfy the gate (~400 LOC TS-side write-amplification). Neither option is clean. |
| `BridgeResult` Rust struct + serialisation | ~50 | **Retired.** No more single-shot result envelope. |
| `roundtrip_stub` / `floor_only_transition` benches | ~100 | **Replaced.** New benches needed for per-mutator latency, not single-envelope latency. |

---

## 5. Test rewrite scope

### 5.1 Cargo tests (`tools/engine-rs-core/tests/`, 38 `.rs` files)

| Test file | Disposition |
| --- | --- |
| `transition.rs` | **Full rewrite.** Post-D.-1 wraps `transition_phased`; the (s, a)→s' shape is gone. Replace assertions with `begin_commit` / `stage_input` / `commit` sequences. ~200 assertions. |
| `transition_phased.rs` | **Full rewrite.** Same shape change. ~150 assertions. |
| `typestate_byte_identity.rs` | **Surface-update.** PhaseA boundary is now a mutable handle, not a typestate phase; the byte-identity assertion on the post-PhaseA state moves to "post-commit-call". |
| `ffi_smoke.rs` | **Full rewrite.** ABI smoke test runs the new 5-extern surface. |
| `multiplex_dispatch.rs` | **Surface-update.** Engine-id multiplex still works; subscriber-callback shape unchanged. |
| `observer_error_routing.rs` | **Surface-update.** Phase G dispatch shape unchanged. |
| `reentrant_commit_rejection.rs` | **Expand.** Re-entrancy gate now must guard `stage_input` mid-Phase-G in addition to `commit`. |
| `rollback.rs` / `kahn_drain.rs` / `cycle_detection.rs` / `cutoff.rs` / `glitch_freedom.rs` / `dynamic_dep_flip.rs` / `recompute.rs` (proxy) | **Verbatim.** Internal Phase D logic unchanged. |
| `staging.rs` | **Surface-update.** Staging buffer is now populated FFI-side. |
| Rest (~22 files) | **Mostly verbatim.** Phase-specific tests that don't reach for `transition_phased` directly. |

**Cargo test count under (b): ~38 files; ~12-15 require surface
rewrite, ~23 verbatim.** Of the ~170 cargo test assertions, estimate
**~60–80 need surface update**, the rest verbatim.

### 5.2 TS tests (`packages/core/test/`, ~100 files; `packages/*` total ~277)

| Test surface | Files | Disposition |
| --- | ---: | --- |
| `packages/core/test/properties/cross-backend-determinism.property.test.ts` | 1 | **Full redesign** — gate becomes commit-by-commit not transition-by-transition. See §4 trade-off. |
| `packages/core/test/properties/glitch-freedom.property.test.ts` and siblings | ~6 | **Verbatim** — properties hold at the `Graph` level, unchanged. |
| `packages/core/test/spec-10-worked-example.test.ts` | 1 | **Verbatim** — public Graph surface only. |
| Adopter-API tests against `Graph.commit/read/subscribe` | ~80 | **Verbatim** — public surface preserved per §1a. |
| WASM-backend probes (`packages/bench/test/wasm-marshaler-boundary-tax.test.ts` etc.) | ~6 | **Full rewrite** — they measure the *artefact (b) retires*. New probes needed for per-mutator latency. |
| React adapter tests (`packages/react/test/`) | ~60 | **Verbatim** — hook surfaces unchanged. |

**TS test count under (b): of ~277 total test files, estimate
~10–15 require surface update**, the rest verbatim. The
overwhelming majority of TS tests are at the public `Graph` surface,
which §1a non-negotiables protect.

### 5.3 Total surface-update count

| Surface | Files needing rewrite | Files verbatim |
| --- | ---: | ---: |
| Rust | ~12–15 | ~23 |
| TS | ~10–15 | ~260 |
| **Total** | **~22–30** | **~283** |

---

## 6. New risks

### 6.1 SPEC §5.1 single-step contract violation

The §5.1 phase table ([`SPEC.md:143-160`](../../SPEC.md)) describes
each phase as a "contiguous block in `packages/core/src/graph.ts`'s
commit body." Under (b), Phase A (Validate) is **no longer a
contiguous block** — it is a stream of FFI calls. This is a SPEC
amendment.

**Proposed amendment scope:** add §5.1 Amendment 5 acknowledging
that Phase A may be implemented as an open-staging window for FFI
backends. The contiguous-block property is preserved at the *commit
boundary*: `commit()` returning to the caller observes a single tick
advance, byte-identical post-state, and atomic visibility. The
internal multi-FFI-call shape is implementation detail. The
amendment would parallel §5.1 Amendments 1–4 in scope (~1
paragraph plus a worked example).

### 6.2 Cross-backend determinism gate redesign

The gate today
([`packages/core/test/properties/cross-backend-determinism.property.test.ts`](../../packages/core/test/properties/cross-backend-determinism.property.test.ts))
runs `transition_js(s, a) == transition_rust(s, a)` byte-for-byte
across the shared command alphabet (F-marshal.5 PR #1477: 1000 trials
× 0 byte differences). Under (b):

- The TS engine has no `stage_input(node, value)` extern. The shared
  alphabet must collapse to **commit-level**: `commit_js(intent,
  writes) == commit_rust(intent, writes)` end-to-end.
- **Loss of resolution:** an internal divergence (e.g. a Phase D
  cutoff propagation bug) that produces the same end-state would
  pass the new gate but fail the old gate.
- **Mitigation cost:** to preserve the old gate's resolution, the
  TS engine grows a mutator-by-mutator API purely for the gate.
  ~400 LOC TS-side write-amplification, paid forever.

### 6.3 Subscriber-fire timing

Today Phase G runs inside `commit()` and fires every subscriber
in a single Rust function call. The JS bridge marshals the firings
back via a single callback per commit
([`tools/engine-rs-bridge-serde/src/lib.rs:292-435`](../../tools/engine-rs-bridge-serde/src/lib.rs),
the `setSubscriberCallback` + `JsSubscriberCallback` shape).

Under (b) the **fire-once-per-commit** invariant is intact, but
the *timing question* re-opens: does the JS subscriber callback
fire *during* `commit()`-FFI-call (mid-call, callback re-entering
into JS) or *after* `commit()`-FFI returns (the bridge buffers
firings and dispatches on return)? Current behaviour is mid-call
(synchronous callback per the E.3 callback shape). The mid-call
shape **introduces re-entrancy** every time a subscriber commits a
new transaction — Subscriber-fired-callback → JS handler → graph.commit
→ FFI back into Rust, all on a single stack.

SPEC §9.1 row 7 (commit-inside-subscribe reentry,
[`SPEC.md:2654`](../../SPEC.md)) covers re-entrant commit; **option
(b) does not change the contract**, but the implementation surface
needs explicit re-entrancy guards on the open-staging token (see
§6.4) which today's single-call shape avoids by construction.

### 6.4 Re-entrancy semantics inside mutator callbacks

A pathological adopter could re-enter `stage_input(token)` from a
subscriber callback fired during a previous commit's Phase G. This
is a new failure mode without a single-call analogue:

- Today: subscriber re-entry calls `graph.commit()` again, which
  hits the SPEC §9.1 row 7 `CommitInProgressError` precondition
  gate and is rejected cleanly. The current-commit's State is
  frozen by `&State` ownership.
- Under (b): subscriber re-entry could call `stage_input(token)`
  on a *different* token, OR on the *current* token if the
  application code leaked a reference. The token's runtime gate
  must distinguish:
  - `token.state == StagingOpen` → accept stage_input
  - `token.state == CommitInFlight` → reject (Phase D running)
  - `token.state == Consumed` → reject (already committed)

This is **net new test surface** with no current analogue. Estimate
~20 additional assertions.

---

## 7. Effort estimate

Anchored against #1133's 75-PR baseline (frozen post-STOP-VERDICT).

| Workstream | Size | Justification |
| --- | --- | --- |
| Engine surface rewrite (`phase_step.rs` + PhaseA half of `typestate.rs`) | ~3 PRs | ~600 LOC focused rewrite; the new FFI surface is well-bounded. |
| Bridge crate rewrite (both `engine-rs-bridge-serde` and `engine-rs-bridge-gc`) | ~4 PRs (2 per crate) | New extern surface × 2 bridges; thread the token through both ABIs. |
| TS-side `WasmStateMirror` → mutator-driver rewrite | ~4 PRs | The driver replaces `marshalCommitEnvelope` (250 LOC retired); the new driver streams stage_input calls. ~500 LOC net. |
| Cross-backend gate redesign | ~2 PRs | One PR to drop transition-by-transition gate, one to land commit-by-commit gate; OR (alt) ~5 PRs to grow TS-side mutator API for parity. |
| Test rewrite (22–30 files) | ~5 PRs | Batched by surface (Rust core, bridge, TS adapter). |
| Re-entrancy + token-state runtime gates | ~2 PRs | Plus new test class. |
| SPEC §5.1 Amendment 5 | ~1 PR | Documentation; no code. |
| Bench + perf-floor probes | ~2 PRs | New per-mutator latency bench; verify ≤2.5 μs / call holds at scale. |
| Buffer for surprises | ~3 PRs | Re-entrancy edge cases, token-leak failure modes. |

**Total: ~26 PRs over ~6–10 weeks** with a single engineer
working through it. For comparison, #1133's 75-PR Phase A–E plus
F-marshal took ~6 months of focused work, but most of that was
greenfield Rust port effort that (b) inherits verbatim. The
incremental cost of (b) on top of dev `336ec6bd` is roughly the
F-marshal sub-epic's size again (~22 PRs landed there) with the
new gate-redesign and re-entrancy work added.

---

## 8. Constraint rubric checklist

Filling the rubric table from
[`CONSTRAINTS.md` §6](./CONSTRAINTS.md#6-rubric-for-the-three-feasibility-studies)
for option (b):

| Constraint | Option (b) | Evidence |
| --- | --- | --- |
| **§1a Non-negotiable adopter surface preserved without codemod** | **Yes** | Public `Graph.commit(intent, run)` shape (types.ts:976) unchanged; the open-staging API is *internal* between TS adapter and bridge. The TS adapter's body (`commit` impl in `graph.ts`) changes; the surface adopters import does not. |
| **§1b Migratable surface — codemods + lints required** | **No codemods needed.** `BackendEngine.commit(intent, writes: ReadonlyMap)` shape ([`packages/core/wasm/index.ts:178`](../../packages/core/wasm/index.ts)) is explicitly migratable per CONSTRAINTS.md §1b row "BackendEngine.commit" — already documented as the option-(b) escape hatch. |
| **§2 Browser deployment** | **Yes** | WASM substrate preserved; only the bridge ABI shape changes. SPEC §17.6 host-tier matrix unchanged. |
| **§2 Node deployment** | **Yes** | Same WASM substrate; SSR-`Hydrate` unchanged. |
| **§2 Native deployment (per-platform binary)** | **N/A** | Option (b) is a WASM-substrate variant; doesn't ship native engine binary. (a) is the native-binary path. |
| **§2 Cloudflare Workers / edge** | **Yes** | WASM-supported; no Node-specific APIs introduced. |
| **§2 Embedded runtimes — TS fallback floor preserved** | **Yes** | TS engine remains the unconditional floor per §17.6 commitment 14. |
| **§3 Per-commit perf — ≤ 50 ns per op boundary tax** | **No.** | Cell projection §1: per-op tax 0.5 μs for 1-write cells, much worse for multi-write cells. **Fails the floor by 10–7000× depending on write-count.** |
| **§3 `equality-cutoff` cell ≤ 2.017 ms / 10k** | **No.** | (b) cost: 5.0 μs × 10k = 50 ms boundary alone. **25× the TS workload.** |
| **§3 `scrolling-viewport` cell ≤ 0.112 ms / 10k** | **No.** | (b) cost: 5.0 μs × 10k = 50 ms vs 1.12 ms TS. **446× over.** |
| **§3 `spreadsheet-100x100` cell ≤ 0.334 ms / 10k** | **No.** | (b) cost: 252.5 μs × 10k = 2.5 s vs 3.3 ms TS. **758× over.** |
| **§3 §17.5 band held (3.0× ≤ causl/mobx ≤ 8.0×)** | **No.** | Boundary cost dominates; band widens, not tightens. Same failure mode as #1133's measurement against current bridge. |
| **§4 TS + new engine coexist for N versions** | **Yes** | TS engine unchanged; (b) only changes the WASM bridge surface. Backend selector flips between them per §17.6 commitment 14. |
| **§4 `createCausl({ backend: 'auto' })` runtime swap preserved** | **Yes** | `AdaptThresholds` shape unchanged; selector logic unchanged. |
| **§4 Cross-backend determinism gate green (1000 trials × 0 byte differences)** | **Asymmetric / degraded.** See §6.2 — gate must downgrade from transition-by-transition to commit-by-commit, losing resolution. |
| **§4 `Object.is` SameValue parity (NaN / ±0 / lone surrogates)** | **Yes** | Same `is_same_value` oracle on both sides; per-write FFI does not introduce new value-marshal paths beyond what stage_input(node, value) carries — same JsonValue shape. |
| **§5 SPEC §5.1 Phase A–H named-phase sequencing preserved** | **Yes (with §5.1 Amendment 5).** Phases B–H sequencing preserved verbatim; Phase A becomes an open-staging window with the same semantic contract at the commit boundary. |
| **§5 SPEC §5.1 Amendment 4 — Phase G IndexMap-shaped container** | **Yes** | Container choice unchanged; Phase G dispatch logic verbatim. |
| **§5 SPEC §3 Theorem 2 uninterruptibility (no microtask in marshal)** | **Yes** | The single FFI call into `commit(token)` runs Phases B–H synchronously; subscriber callback fires within that single call boundary. Same uninterruptibility shape as today. |
| **§5 SPEC §15.1 value-identity at fixed GraphTime (reference identity opt-in)** | **Yes** | Reads still go through the same `read(node)` path; value-identity contract independent of mutation shape. |
| **§5 SPEC §17.6 host-tier matrix preserved (no host stranded)** | **Yes** | WASM substrate stays; host-tier table unchanged. |
| **Adopter migration cost** | **Zero codemods.** `Graph` surface unchanged; only `BackendEngine.commit` internal shape changes per §1b. |
| **What's reused from #1133's 75 PRs** | **~80% of `engine-rs-core/src/transition/`** (validate/clock/mutate/publish/rollback/compact/stamp/recompute/Phase D suite/PhaseB–H typestate). See §3. |
| **What's thrown away from #1133's 75 PRs** | **`marshalCommitEnvelope` (~250 LOC) + `BridgeResult` + transition_phased public surface (~100 LOC) + F-marshal hybrid-marshaler design.** See §4. |
| **Realistic effort estimate (post-research, weeks)** | **~6–10 weeks (~26 PRs)** on top of dev `336ec6bd`. See §7. |
| **Kill-criterion: workload below which architecture's boundary cost dominates TS workload** | **All workloads.** Even at 1 write per commit (the win-region vs F-marshal.6), (b) is 9–454× over TS work depending on cell. There is **no cell** in the contract-bearing six where (b)'s boundary cost is below the TS-engine work. |

---

## 9. Honest GO/NO-GO recommendation

**NO-GO.**

**Confidence: high.**

**Three load-bearing reasons:**

1. **Boundary arithmetic still fails the §3 floor.** The G.1 result
   (78× over TS work) was the reason #1133 was stopped. Option (b)
   reduces the multiple from 78× to ~25× on the best cell (1-write
   `equality-cutoff`) — better, but still ~500× over the
   ≤ 50 ns / op floor [`CONSTRAINTS.md` §3](./CONSTRAINTS.md#3-perf-floor-needs)
   set. On multi-write cells (`spreadsheet-100x100`), (b) is
   **worse** than the current envelope marshal by ~16×. The
   win-region is bounded to `N_writes < 5.3`, which excludes
   exactly the cells that pay the most boundary tax today.

2. **Cross-backend determinism gate degrades or doubles in cost.**
   The gate is one of the only things working in #1133's
   F-marshal closeout — 1000 trials × 0 byte differences. Option (b)
   forces either degraded resolution (commit-by-commit, not
   transition-by-transition) or ~400 LOC of TS-side mutator
   write-amplification *purely* to satisfy the gate. Neither option
   is paid back by the perf win, because there is no perf win.

3. **SPEC §5.1 Amendment 5 introduces a non-load-bearing
   complexity tax.** Phase A losing its "contiguous block" property
   is the kind of amendment that sits in §19 forever as a
   curiosity, but every reader of §5.1 has to learn the carve-out.
   Future epics that touch the commit pipeline pay an attention
   tax forever. We accept that cost when there is a benefit; here
   there is not.

**What option (b) *does* improve over F-marshal.6:** it eliminates
the bulk envelope ser/deser on the single-write hot path (3× faster
on 4 of 6 cells). If we believed adopter workloads are dominated
by single-write commits, this would be worth considering. The G.1
cell shapes are explicitly designed to cover the real bench
geometry, and the multi-write cells (`spreadsheet-100x100`,
`batch-commit`) are where adopters land the heavy work — and
those are exactly where (b) regresses.

**The honest framing**: option (b) is a refinement of #1133's
falsified architecture, not an alternative to it. The hard
boundary is the FFI tax itself; reshaping when you pay it does
not change how much you pay. To clear the §3 floor, you need
either:

- **Option (a)** — retire the FFI boundary entirely (native binary;
  paid for in deployment complexity).
- **Option (c)** — amortise the FFI boundary across a batch (paid
  for in `commit()`-timing changes; SPEC §1b row "commit-as-sync
  vs commit-as-batched").

This is consistent with [`CONSTRAINTS.md` §3](./CONSTRAINTS.md#3-perf-floor-needs)
closing paragraph: *"Architectures that cannot [land below the
floor] must show a different cost model (amortisation across
batches; zero per-op crossing; in-place mutation that eliminates
the envelope entirely)."* Option (b) was the "in-place mutation
that eliminates the envelope" entry on that list. This study
finds: it does eliminate the envelope, but the per-call FFI tax
that replaces it dominates equally.

---

## 10. Appendix — read order

1. [`CONSTRAINTS.md`](./CONSTRAINTS.md) §3 + §6 — the perf floor +
   rubric this doc fills.
2. [`SPEC.md:143-160`](../../SPEC.md) — §5.1 phase table.
3. [`SPEC.md:1686-1689`](../../SPEC.md) — `transition_phased`
   single-step contract.
4. [`tools/engine-rs-core/src/transition/typestate.rs:432-572`](../../tools/engine-rs-core/src/transition/typestate.rs)
   — current typestate phase chain.
5. [`tools/engine-rs-core/src/phase_step.rs`](../../tools/engine-rs-core/src/phase_step.rs)
   — `transition_phased_with_callbacks` driver.
6. [`tools/engine-rs-bridge-serde/src/lib.rs:476-537`](../../tools/engine-rs-bridge-serde/src/lib.rs)
   — bridge `commit()` extern that option (b) deletes.
7. [`packages/core/wasm/marshaler.ts:399-531`](../../packages/core/wasm/marshaler.ts)
   — `marshalCommitEnvelope` that option (b) retires.
8. [`docs/epic-1133/G1-PERF-MEASUREMENT.md`](../epic-1133/G1-PERF-MEASUREMENT.md)
   — the 78× / 15.64 μs measurement option (b) reduces to ~25× /
   5 μs on best cells.
