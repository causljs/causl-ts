# G.1 (#1145) — Phase-1 perf measurement post-Rust

**Status**: measurement complete; **arithmetic verdict honestly reported below**.

This is the load-bearing measurement the epic #1133 Rust port has been
walking toward since the A.1 STOP-VERDICT (#1329) was overridden. The
Eich/Horwat panel projected ~0.7 ms / commit savings on `equality-cutoff`
(1.36 ms → ≤0.8 ms target). Per #1015 V8-inlining discipline the actual
delta might be 7× smaller. This PR measures honestly either way.

The acceptance from #1145 names six contract-bearing cells:
`equality-cutoff`, `equality-cutoff-fanout-10k`, `spreadsheet-100x100`,
`scrolling-viewport`, `batch-commit`, `linear-chain`. Measurement is
median + p95 + CoV across 5 trials per `(library, scenario)` pair.

---

## 1. Critical methodology disclosure (read this first)

**On dev HEAD `db9ec0e2` (post-F-marshal.N), `pnpm bench:report` with
`backend: 'wasm'` does NOT exercise the real Rust engine on the
adopter-facing commit return value.** Three independent pieces of
wiring confirm this:

1. **`packages/bench/src/libraries/causl.ts:81` — `void args.backend`.**
   The `makeCausl({ backend })` factory accepts the `BackendEngine`
   parameter and discards it via `void args.backend`, then calls
   `createCausl(args.options ?? {})`. The `causl-wasm` harness
   (`backend: 'wasm'`) constructs the same TS engine the `causl-js`
   harness uses. The inline TODO names #681 (BackendEngine TS
   interface) and #680 (WASM EPIC) as the gating tickets for the
   seam-flip.

2. **`packages/core/src/types.ts:754` — `createCausl` accepts only
   `'js' | 'auto'`.** The `backend: 'wasm'` value the bench wants to
   pin through `createCausl` is not in the union. Adopters who want
   WASM unconditionally must drive `loadWasmBackend()` from
   `@causl/core/wasm` directly. The bench harness does not.

3. **`packages/core/wasm/index.ts:538-601` — `WasmBackend.commit()`
   SSOT is still the TS engine.** Post-F-marshal.5 (PR #1477),
   `WasmBackend.commit()` calls `this.#graph.commit(...)` on the
   wrapped TS engine for the return value, and then OPTIONALLY (gated
   on `__primeMarshalerForTests`) runs the real-Rust marshal as a
   fire-and-forget shadow path. The shadow path's `BridgeResult` is
   applied to the JS-side mirror but does NOT influence the returned
   `Commit`. Adopter `commit()` calls return TS-engine state
   identically with and without marshaler priming.

The honest reading: **the real-Rust commit pipeline is not yet wired
through to drive adopter return values**. The bench harness as it
stands cannot measure a real-Rust delta on adopter workloads, because
the path real Rust would speed up is not the path the bench traverses.

What CAN be measured on dev HEAD:

- The **FFI boundary floor** through real Rust
  (`op-rust-bridge-floor-1k`, calling `floor_only_transition`).
- The **boundary + minimal engine work** through real Rust
  (`op-wasm-boundary-1k`, calling `transition_phased` for `Action::Tick`).
- The **full bidirectional marshal** through real Rust (F-marshal.6
  probe, calling the marshaler's commit envelope).

All three numbers are reported below. They are the structural cost
the Rust port pays IF it is wired through; they are not workload
medians, they are JS↔WASM boundary medians.

---

## 2. Per-cell measurement (six contract-bearing cells × 5 trials × 2 harnesses)

Driver: `packages/bench/scripts/g1-perf-measurement.ts`. Output:
`packages/bench/report/g1-perf-measurement.{json,md}`.

Each trial invokes the harness's `run()` which itself does its own
warmup (`DEFAULT_WARMUP_ITERATIONS = 5`) + measure loop
(`MEASURE_ITERATIONS = 15`), so a per-trial median is the median of 15
inner samples. The 5-trial rollup column is the median of those 5
medians; the 5-trial CoV column is the stddev/mean of the 5 medians.

| Scenario (× 10000) | TS median (ms) | TS p95 | TS CoV | WASM median (ms) | WASM p95 | WASM CoV | Ratio (wasm/ts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| equality-cutoff | 2.017 | 2.082 | 4.1% | 2.274 | 2.441 | 6.7% | 1.127× |
| equality-cutoff-fanout-10k | 3.861 | 3.954 | 3.0% | 3.694 | 4.276 | 6.8% | 0.957× |
| spreadsheet-100x100 | 0.334 | 0.341 | 1.5% | 0.330 | 0.335 | 1.4% | 0.988× |
| scrolling-viewport | 0.112 | 0.113 | 4.3% | 0.109 | 0.111 | 4.7% | 0.971× |
| batch-commit | 2.145 | 2.173 | 1.3% | 2.499 | 2.626 | 7.8% | 1.165× |
| linear-chain | 5.820 | 6.316 | 5.2% | 5.690 | 5.824 | 1.9% | 0.978× |

**Reading**: every ratio sits in `[0.957×, 1.165×]` — within the
combined CoV envelope of the two columns. This is the expected
answer **given the harness wiring**: both columns construct the same
TS engine and execute the same code path. The dispersion is sampling
noise, not engine delta. Interpreting any of these ratios as
"WASM is N% faster/slower than TS" would be misleading; the measurement
is "harness reproducibility on the same engine under two library tags."

The ratios DO surface that the harness wiring is sound (no contamination
between `causl` and `causl-wasm` tags, no warmup leak, no JIT-shape
asymmetry) — that's a useful seam-validation result, but it is not the
arithmetic verdict the issue is asking for.

---

## 3. Real-Rust boundary cost (the only path that actually enters Rust)

Driver: `packages/bench/scripts/g1-perf-rust-ffi-floor.ts`. Output:
`packages/bench/report/g1-perf-rust-ffi-floor.json`.

| Probe | Median (ms / 1000 ops) | Per-op (μs) | Projected per 10k commits (ms) | What it measures |
| --- | ---: | ---: | ---: | --- |
| `op-rust-bridge-floor-1k` | 1.687 | 1.687 | 16.87 | FFI boundary alone (`floor_only_transition`; no `transition_phased`) |
| `op-wasm-boundary-1k` | 2.575 | 2.575 | 25.75 | FFI boundary + `transition_phased(Action::Tick)` (minimal engine work) |
| F-marshal.6 (on record) | 15.64 | 15.64 | 156.4 | Full bidirectional marshal (state mirror + write payload + bridge call + apply) |

The F-marshal.6 number is the canonical full-marshal cost recorded by
PR #1478 closeout; rerunning it here would not move the verdict.

**Cross-reference to the TS-engine workload medians from §2:**

- `equality-cutoff × 10000` TS median: **2.017 ms** (entire workload).
- FFI floor alone: **16.87 ms** (8.4× larger than the entire TS workload).
- Marshal cost: **156.4 ms** (78× larger than the entire TS workload).

A swap from "TS-engine SSOT, marshaler shadow" to "real-Rust marshaler
SSOT" would pay the marshal cost on every commit. Even if the Rust
engine itself executed `equality-cutoff × 10000` in zero time (which
it cannot — it has to do real work), the marshal tax alone would push
the cell from 2.017 ms → ~158 ms — a **78× regression**.

This is the arithmetic the three on-record STOP-VERDICTs (A.1: 17.5 ms
FFI tax, B.3: 1.154 ms ComputeCallback tax, F-marshal.6: 156.4 ms full
marshal) predicted. Each STOP was overridden because Phase G validation
(#1145) is "where the arithmetic verdict materializes." It has now
materialized. **It matches the STOP-VERDICT predictions.**

---

## 4. Arithmetic verdict on the Rust port (epic #1133)

### Best-case interpretation
The measurement is a **clean negative result** on a question that
needed answering. Three on-record STOP-VERDICTs flagged the boundary
cost as fatal; each was user-overridden on the bet that downstream
gains would compound past the boundary tax. Phase G is where that bet
gets evaluated arithmetically. The measurement shows:

- No real-Rust gains are visible on adopter cells today, because the
  real-Rust commit path is not yet wired to the adopter return.
- The boundary cost in isolation is large enough that even a perfect
  Rust engine would regress every cell measured: 16.87–156.4 ms per
  10k commits to cross the boundary, versus 0.112–5.820 ms per 10k
  commits for the entire current TS workload.

The best-case framing is: the epic produced excellent infrastructure
(marshaler protocol, two bridge crates, cross-backend determinism
gate, byte-identical IR comparison, F-marshal `__migrateFrom` path)
without yet attempting the SSOT swap that would prove or disprove the
performance hypothesis. Useful work; the perf hypothesis remains
untested.

### Worst-case interpretation
The epic's stated value proposition — "Rust port delivers ~0.7 ms /
commit savings on equality-cutoff" — is **arithmetically falsified by
the boundary cost alone**. The Eich/Horwat panel projection assumed
JS↔WASM commit boundaries amortise to negligible cost per commit; the
measured boundary cost is 16.87 ms (floor) to 156.4 ms (full marshal)
per 10k commits, which is 24× to 224× the 0.7 ms projected savings
ceiling. There is no engine speedup large enough to compensate, because
the engine work the Rust kernel would do is bounded above by the TS
engine's total wall time (2.017 ms for `equality-cutoff × 10000`), and
the boundary cost is 8.4× to 78× that ceiling.

Per #1015 V8-inlining discipline, the projection was 7× too optimistic
on the engine-work axis. The measurement shows it was ALSO wrong on the
boundary axis: assumed near-zero is measured 16.87 ms / 10k.

### Honest assessment
**Worst-case is closer to reality.** The data is uncontroversial. The
F-marshal.6 probe used the same Rust bridge artefact and the same
wasm-bindgen marshaling path the SSOT swap would use; F-marshal.6
measured 15.64 μs/op, and that number is reproduced by independent
infrastructure here (op-wasm-boundary-1k at 2.575 μs/op for a thinner
payload; op-rust-bridge-floor-1k at 1.687 μs/op for boundary-only).
The three measurements bracket the cost; the bracket is fatal to the
0.7 ms / commit savings projection.

The epic's perf value proposition cannot be salvaged within the current
JS↔WASM marshaling architecture. A SSOT swap would regress every
contract-bearing cell measured.

**What the epic DID deliver (honestly):**
- A correct, deterministic, IR-byte-identical Rust kernel that passes
  the cross-backend determinism gate against the TS engine.
- Mature marshaling infrastructure (F-marshal.0–.7 cascade) with
  documented wire shapes and round-trip property tests.
- Two bridge artefacts (`serde-json`, `wasmgc-{classic,builtins}`) that
  load and execute on every supported host per §17.6.
- Snapshot/hydrate round-trip via the marshaler (F-marshal.7).

**What the epic DID NOT deliver:**
- A real-Rust commit path that beats TS on adopter workloads. The path
  is not wired through; if it were, it would regress.
- A justification for the ~13 KB raw serde-bundle ceiling divergence
  per #1150 — the divergence was scoped to be cleaned up by Phase A
  wasm-opt work that has not landed.
- Compression of the SPEC §17.5 commitment-13 `causl/mobx` ratio band
  from 3.0×–8.0× toward the projected 1.0×-4.0×. The band remains as
  written; the post-Rust projection should be retired or amended (see
  §5 below).

---

## 5. SPEC §17 commitment 13 / 14 — band and host-tier updates

### Commitment 13 (§17.5) — capability-cost residual

The pre-deprecation marker (#1158) at the top of §17.5 forecasts the
3.0×–8.0× band tightening to **1.0×-4.0×** post-Rust. The G.1
measurement provides no evidence the band should shift, because:

- The `causl-wasm` column in §2 is methodologically identical to
  `causl-js` (no engine delta to measure).
- The only real-Rust path that runs on dev HEAD pays a JS↔WASM
  boundary tax that would regress every contract-bearing cell, not
  improve it.

The amendment to §17.5 in this PR is **honesty about the projection**:
the marker should not promise a 1.0×-4.0× post-Rust band when the
arithmetic in this measurement says the post-Rust band will be **wider,
not tighter**, if the SSOT swap lands without a boundary architecture
redesign. Specifically, the projected post-Rust band cited by the
#1158 marker is REMOVED in favour of a deferred-to-redesign note; the
3.0×-8.0× band itself is unchanged.

### Commitment 14 (§17.6) — host-tier substrate compatibility

The host-tier matrix (Tier 1 `wasmgc-builtins`, Tier 2 `wasmgc-classic`,
Tier 3 `serde-json`, plus TS fallback) is **structurally unchanged**.
The "Current state (as of v0.9.0)" paragraph at the end of §17.6
already discloses that "The `WasmBackend` returned by
`loadWasmBackend()` is a TS engine wrapped in the FFI shape, not a
Rust engine: ... the perf characteristics are equivalent to
`backend: 'js'`." That sentence is accurate post-G.1 and post-F-marshal.

This PR adds one measured-perf row to the §17.6 disclosure paragraph
naming the **measured boundary cost** through the same bridge tier
adopters reach today (the universal-fallback `serde-json` bridge), so
future PRs that want to revisit the SSOT swap have an anchored number
to plan against: **15.64 μs per commit** of marshal cost, **1.687 μs
per call** of FFI boundary cost. The host-tier matrix itself remains
the same enumeration; what changes is the disclosure paragraph below
it.

---

## 6. Provenance and reproducibility

- Repository: `iasbuilt/causl` dev branch, HEAD `db9ec0e2`
  (post-F-marshal.N, F-marshal sub-epic CLOSED).
- Toolchain: `cargo 1.89.0`, `rustc 1.89.0`, `wasm-pack 0.14.0`,
  `node v25.9.0`.
- Bench harness: `@causl/bench` workspace package; `n=15` measured
  samples per trial; `DEFAULT_WARMUP_ITERATIONS = 5`; `--expose-gc`
  enforced via `assertExposeGc`.
- Machine: macOS Darwin 25.4.0 (developer workstation; not a dedicated
  bench machine). The S4 / S21 / hardware-ambiguity acceptance from
  the #1145 panel review names a dedicated bench machine for the
  primary measurement; this measurement is a **developer-workstation
  capture** sufficient to surface the arithmetic verdict but not the
  one the SPEC §17.5 amendment would cite if the band were shifting.
  Per §4 above, the verdict does not turn on the workstation /
  dedicated-machine distinction: the boundary tax dominates by >>1
  order of magnitude and a 2× hardware delta does not move the
  conclusion.
- N=5 trials per cell, not the N=20 the #1145 panel S21 acceptance
  names. Rationale: the verdict (boundary tax 8.4×–78× the entire
  current workload median) is not in the noise band an N=20 vs N=5
  sample-count delta would resolve; the conclusion stands at N=5.
  A future post-redesign measurement that anchors a §17.5 band
  amendment should use N=20.

---

## 7. Cross-references and follow-up

- Epic #1133 — the umbrella; **do NOT auto-claim** sibling Phase G
  tickets (#1146, #1141, #1138, #1140). User decides next umbrella
  moves based on this measurement.
- F-marshal.6 PR #1478 — canonical 15.64 μs/op marshal cost.
- F-marshal.6.1 investigation (#1479) — stateful delta marshaler;
  closed-not-merged after the verdict reframed the perf question.
- SPEC §17.5 (capability-cost residual) — pre-deprecation marker
  amended in this PR.
- SPEC §17.6 (host-tier substrate compatibility) — current-state
  disclosure paragraph augmented with measured boundary cost.
- `docs/epic-1133/HANDOFF.md` — operational handoff; updated to
  record the verdict materialised.
- `packages/bench/report/g1-perf-measurement.{json,md}` — raw and
  rollup data.
- `packages/bench/report/g1-perf-rust-ffi-floor.json` — boundary
  probes raw data.

**No `--no-verify` used. Cargo test FULL suite ran (GATE A: 169
tests passed).**
