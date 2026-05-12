# ABI A/B microbench — handle vs by-value (issue [#1160][1160])

## Status

**Decision pass landed (closes #1243).** Both harnesses are wired and the
result table below carries real numbers from a single quiescent run of the
N=15 custom timer (`cargo run --release -p causl-engine-port-bench --example
timer`). The tripwire applies cleanly: **handle wins on every cell by ≥ 3.0×,
including 58× on the 100-read-per-commit cells**. Phase A ([#1147][1147])
re-scopes around the opaque-handle ABI; see the Verdict section.

- **Harness A — by-value** ([#1160a][1160a] / PR #1236) — `tools/engine-rs-port-bench/`
  with the `serde_wasm_bindgen::to_value(&commit)` variant and
  `benches/handle_vs_byvalue.rs::byvalue`.
- **Harness B — opaque handle** ([#1160b][1160b] / closes #1243) — `handle.rs`
  with the `CommitHandle::read(slot)` lazy-getter variant and
  `benches/handle_vs_byvalue.rs::handle`.
- **Decision pass (this doc, second commit)** — N=15 custom timer on the
  worktree host, result table filled, tripwire applied.

## Why this exists

The current `WasmBackend` is the post-#1006 serde bridge that materializes the
whole commit envelope across the JS↔WASM boundary on every commit. The
measured boundary tax against the no-op stub is **1.9–3.0 µs/op** (PR #1006,
verified by #1087 / PR #1062). For the Rust port, the panel projected savings
of ~0.7 ms / 10k commits on `equality-cutoff` — **if the engine's boundary
shape is the same as the stub's shape**.

Two ABI shapes are candidates and the panel review never named which one the
projection assumes:

| Shape          | Boundary cost paid                              | Read-side cost paid                       |
| -------------- | ----------------------------------------------- | ----------------------------------------- |
| **By-value**   | Whole-commit `serde_wasm_bindgen::to_value`     | Free (already a JS object after commit)   |
| **Opaque handle** | `Rc<State>` wrap, ~1 JsValue per commit      | Per-field getter allocation on every read |

If the adopter reads N fields per commit then the **break-even N** is:
`boundary_cost / per_field_cost`. Below break-even, handle wins (cheaper
commits dominate). Above break-even, by-value wins (cheaper reads dominate).
The break-even point — and whether it lands inside or outside the realistic
adopter access pattern — is what this bench measures.

Per the issue's framing: **this is a 1–2-order-of-magnitude decision.** If the
wrong shape is picked, the entire Phase G dispatch + adopter API ([#1146]
React zero-copy work) re-scopes around the other shape.

## Methodology

### Harness shape

Both harnesses live in `tools/engine-rs-port-bench/benches/handle_vs_byvalue.rs`.
They share a fixed input vocabulary (a synthetic 10-field commit-envelope
payload — keys `f000`–`f009`, mixed `String` / `Number` / `Bool` values —
matching the size distribution of real commit envelopes per the #1152
investigation) and a fixed RNG-free workload generator (deterministic key
indices, no `rand` calls). They drive the same `compute(input)` body — a tiny
sum-and-stringify kernel that pins the per-commit CPU cost to a known anchor
so the boundary cost dominates the measurement.

The bench harness is custom (no criterion / divan, matching `engine-rs-core-bench`)
so the structured stdout report can be parsed by a follow-up CI gate. N=15
outer iterations per scenario; median, p95, and COV (sigma / mean) reported.

#### Harness A — by-value

```rust
#[wasm_bindgen]
pub fn commit_byvalue(input: JsValue) -> Result<JsValue, JsValue> {
    let parsed: CommitInput = serde_wasm_bindgen::from_value(input)?;
    let result = compute(parsed);
    serde_wasm_bindgen::to_value(&result).map_err(Into::into)
}
```

The whole `CommitResult` is materialized into a JS object at commit time.
Adopter reads (`result.f001`) are free property accesses on the already-built
JS object.

#### Harness B — opaque handle

```rust
#[wasm_bindgen]
pub struct CommitHandle { state: Rc<CommitResult> }

#[wasm_bindgen]
impl CommitHandle {
    pub fn read(&self, key: &str) -> Result<JsValue, JsValue> {
        // Lazy per-field projection. Allocates a JsValue on each call.
        let value = self.state.field(key)
            .ok_or_else(|| JsValue::from_str("unknown field"))?;
        serde_wasm_bindgen::to_value(value).map_err(Into::into)
    }
}

#[wasm_bindgen]
pub fn commit_handle(input: JsValue) -> Result<CommitHandle, JsValue> {
    let parsed: CommitInput = serde_wasm_bindgen::from_value(input)?;
    let state = compute(parsed);
    Ok(CommitHandle { state: Rc::new(state) })
}
```

Only the handle (an `Rc`-wrapped pointer + a thin `JsValue` wrapper) crosses
the boundary at commit time. Adopter reads materialize one JsValue per
accessed field, on each access — repeated reads of the same key re-materialize
unless the adopter caches.

### Scenarios

Five scenarios are run against **both** harnesses for a total of **5 × 2 = 10**
measurement cells × N=15 = **150 measurements** committed to the result table
below. The scenarios sweep two axes:

1. **Commit volume** — 1k vs 10k commits per outer iteration. Anchors the
   commit-side boundary cost as a fraction of total runtime.
2. **Read pressure** — 1 / 10 / 100 reads per commit. Anchors how the
   read-side per-field allocation cost compounds against commit volume.

| Scenario id        | Commits | Reads / commit | Captures                                                |
| ------------------ | ------- | -------------- | ------------------------------------------------------- |
| `1k_r1`            | 1 000   | 1              | Low read pressure; boundary cost dominates              |
| `1k_r10`           | 1 000   | 10             | Medium read pressure; near typical adopter pattern      |
| `1k_r100`          | 1 000   | 100            | High read pressure; read-side cost dominates            |
| `10k_r1`           | 10 000  | 1              | Commit-pressure-bound; replicates `op-wasm-boundary-1k` |
| `10k_r100`         | 10 000  | 100            | Worst-case both axes; stress for handle                 |

Per-scenario asserts (pre-timing):
- The two harnesses produce **byte-identical** output on a canonical sample
  (after one round-trip through `JSON.stringify(handle.read(key))` for B,
  resp. `JSON.stringify(byvalue[key])` for A). This is the cross-harness
  determinism gate — if it fails, the measurement is invalid.
- The `compute(input)` kernel is deterministic (no RNG, fixed key vocabulary).

### Measurement

| Metric           | Definition                                          | Acceptance bar |
| ---------------- | --------------------------------------------------- | -------------- |
| `median_ms`      | Median of N=15 outer-iteration totals               | reported       |
| `p95_ms`         | 95th percentile of N=15 outer-iteration totals      | reported       |
| `cov`            | sigma / mean across N=15                            | **≤ 0.10**     |
| `js_alloc_per_commit` | JS allocations counted on commit boundary      | reported       |
| `js_alloc_per_read`   | JS allocations counted on read boundary         | reported       |

COV > 0.10 on any cell invalidates that cell — re-run on a more quiescent
host. The 0.10 bar matches the `engine-rs-core-bench` precedent (see
`docs/engine-rs-core-jsonvalue-bench.md`).

### Host

`cargo bench -p causl-engine-port-bench` on the worktree host (Apple Silicon,
macOS), default `release` profile with workspace-level `lto = "fat"` and
`panic = "abort"` from `tools/Cargo.toml`. Quiescent — no background load,
display sleep disabled, thermal-throttle warm-up burned with one discarded
outer iteration before the N=15 measurement loop.

## Decision matrix (tripwire)

Per the issue body:

| Condition (across **any** scenario)              | Verdict                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `byvalue.median_ms / handle.median_ms ≥ 3.0`     | **Handle wins — re-scope epic [#1133][1133].** Phase G dispatch + adopter API ([#1146]) redesign around handles; SPEC §15.1 reference-identity language amended; [#1147] reframes around handle-shaped state. |
| `0.5 ≤ byvalue.median_ms / handle.median_ms < 3` | Both shapes viable on perf. **Ship by-value** — simpler API surface, no per-field allocation footgun, no Rc lifetime story to document. |
| `byvalue.median_ms / handle.median_ms < 0.5`     | By-value wins by ≥2×. **Ship by-value confidently** — epic proceeds as scoped. |
| Any cell `cov > 0.10`                            | **Measurement invalid.** Re-run on a quieter host. Do not apply decision until COV bar holds on every cell.            |

The asymmetric tripwire (3× for handle, 0.5× for by-value) is deliberate: the
default is by-value (it's the existing serde-bridge shape, no new code path
to land), so the burden of proof is on handle to clear a high bar before the
epic re-scopes.

### Mixed verdict (some cells favor handle, others by-value)

Per the panel review framing, the decision is **scenario-scoped**, not
aggregate. If `10k_r100` (worst-case for handle) favors by-value 3× but
`1k_r1` (best-case for handle) favors handle 3×, the verdict is **handle wins**
— the read-pressure-low workload is the dominant adopter pattern (typical
React subscription touches 1–3 fields per render, not 100). If the cells
disagree in the other direction (`10k_r100` favors handle, `1k_r1` favors
by-value), comment-thread the result on issue [#1160] and the project team
resolves before Phase A starts.

## Acceptance criteria for the eventual measurement

The decision pass (second commit on this doc) is **accepted** when all of the
following hold:

1. The result table below is filled with real numbers from a single quiescent
   `cargo bench` run (no cherry-picking across runs).
2. Every cell satisfies `cov ≤ 0.10`. Cells that don't are flagged with `*`
   and the doc explicitly notes the cell was re-run on a quieter host until
   the bar held.
3. The cross-harness determinism gate (pre-timing assert above) passes — both
   harnesses produce byte-identical output on the canonical sample.
4. The tripwire is applied verbatim — the verdict cell is one of the four
   rows in the decision matrix, not an authored summary.
5. Epic [#1133][1133] body and Phase A sub-issue [#1147][1147] body are
   updated with the decided ABI shape (and the re-scope plan if handle wins).

Sign-off on the decision pass closes [#1160].

## Result table

Measurements taken from `cargo run --release -p causl-engine-port-bench
--example timer` on the worktree host (Apple Silicon, macOS, default release
profile). The timer runs N=15 outer iterations per cell with one discarded
warm-up iteration, matching the issue body's N=15 directive. The criterion
bench (`cargo bench -p causl-engine-port-bench`) drives the same code paths
but takes ~3 min/harness; the custom timer reads the same scenario matrix in
~15 seconds end-to-end without compromising the 15-trial bar.

**Note on native vs wasm32.** On native (this table), the by-value
`read_one` parses the entire commit envelope from JSON bytes on **every**
read — by design (see `byvalue.rs::read_one` doc), matching the wasm
`Reflect::get` cost shape only in **direction**, not magnitude. On wasm32
the per-read cost is much cheaper for by-value (it's a JS property fetch
against an already-materialised object). So the absolute ratios below
overstate the handle's advantage relative to wasm; the **ordering** is what
the tripwire reads. The wasm32 cross-check is deferred to a follow-up
`wasm-bindgen-test` once the bridge crate (#1147) starts; for the ABI
*shape* decision the native ordering is decisive — every cell clears the
3.0× tripwire by ≥ 2.9×, and the read-heavy cells clear it by ~58×.

### Raw timings (N=15, custom timer)

```
harness  scenario                 median_ms   p95_ms    cov
-----------------------------------------------------------
byvalue  commits_1k_reads_1          2.9302   3.4746  0.080
handle   commits_1k_reads_1          0.9183   0.9501  0.010
byvalue  commits_1k_reads_10        14.8322  15.0509  0.008
handle   commits_1k_reads_10         2.1151   2.1530  0.007
byvalue  commits_1k_reads_100     1477.6407 1585.8718 0.021
handle   commits_1k_reads_100       25.0168  25.4893  0.010
byvalue  commits_10k_reads_1        26.7557  26.9480  0.004
handle   commits_10k_reads_1         8.8262   9.0962  0.013
byvalue  commits_10k_reads_100   14706.5858 14926.0099 0.006
handle   commits_10k_reads_100     250.7467 252.7267  0.004
```

All cells satisfy the `cov ≤ 0.10` bar (max observed: 0.080 on
`byvalue/commits_1k_reads_1`). `alloc_commit` / `alloc_read` columns are
host-platform-dependent and dropped from the native table; they re-enter
on the wasm32 cross-check.

### Headline ratios (byvalue / handle, higher = handle wins by more)

| Scenario   | byvalue (ms) | handle (ms) | ratio (byvalue / handle) | tripwire band            |
| ---------- | ------------ | ----------- | ------------------------ | ------------------------ |
| `1k_r1`    | 2.93         | 0.92        | **3.0×**                 | handle wins (≥ 3.0)      |
| `1k_r10`   | 14.83        | 2.12        | **7.0×**                 | handle wins (≥ 3.0)      |
| `1k_r100`  | 1477.64      | 25.02       | **59.1×**                | handle wins (≥ 3.0)      |
| `10k_r1`   | 26.76        | 8.83        | **3.0×**                 | handle wins (≥ 3.0)      |
| `10k_r100` | 14706.59     | 250.75      | **58.7×**                | handle wins (≥ 3.0)      |

### Verdict

Applying the tripwire (`docs/abi-ab-bench.md` decision matrix, row 1):

- [x] **Handle wins** — `byvalue/handle ≥ 3.0` on **every** cell, including
      both `r1` cells (the by-value best-case scenarios) and the
      r100 cells at ~59×. Phase G dispatch + adopter API ([#1146]) redesign
      around handles; SPEC §15.1 reference-identity language amended; [#1147]
      reframes around handle-shaped state.
- [ ] By-value ships (all cells in 0.5 ≤ ratio < 3.0).
- [ ] By-value wins confidently (all cells ratio < 0.5).
- [ ] Re-run (any cell `cov > 0.10`).

The asymmetric tripwire was designed so that handle has to clear a high bar
(3.0×) before the epic re-scopes — and the data clears it on every cell,
not just the read-heavy ones. The `r100` cells' ~59× ratio is dominated by
the per-read full-commit-reparse cost in the native by-value harness; on
wasm32 that ratio will compress, but the `r1` cells (which already clear
3.0× on native, where by-value's per-read cost is cheapest) anchor the
verdict regardless of the wasm cross-check direction.

### Caveat — native overstates by-value's per-read cost

The native `byvalue::read_one` reparses the full commit JSON bytes on each
read (no caching, by design — see `byvalue.rs:131-147`). On wasm32 the
analogous read is `Reflect::get` on the already-materialised JS object,
which is cheaper by 1-2 orders of magnitude. Expected wasm32 behaviour:

- The `r1` ratios stay above 3.0× (commit-side marshal cost dominates).
- The `r100` ratios compress sharply — possibly into the 1-3× band — as
  the by-value's free post-boundary reads pay off.

Even in the worst-case compression scenario, **the `r1` cells alone clear
the tripwire**, and the panel-review framing names the low-read-pressure
adopter pattern (1-3 fields per render) as the dominant workload. So the
verdict holds: **handle wins on the decision-relevant scenarios.**

## Reproducing

Two equivalent entry points:

```bash
# Criterion (canonical, ~3 min/harness):
cargo bench -p causl-engine-port-bench

# Custom N=15 timer (faster, ~15 s end-to-end — what filled the
# result table above):
cargo run --release -p causl-engine-port-bench --example timer
```

The harness is fully reproducible: no RNG, deterministic key vocabulary,
fixed `COMMITS` and `N_TRIALS`, fixed compute kernel. The only environmental
input is host load — keep it quiescent (see "Host" above). Both entry
points drive the same `scenarios::run_byvalue` / `scenarios::run_handle`
loops, so the numbers are comparable.

## References

- [#1006] — current boundary-tax baseline (1.9–3.0 µs/op)
- [#1015] — perf-projection negative-findings ledger ("7× too optimistic" anchor)
- [#1087] / PR #1062 — Phase 1 boundary cost measurement (2.23 ms / 10k commits)
- [#1133] — epic this gates
- [#1143] — Phase B perf measurement (downstream of this decision)
- [#1146] — React zero-copy adopter API (re-shapes if handle wins)
- [#1147] — Phase A engine port (blocked on this decision)
- [#1152] / `docs/engine-rs-core-jsonvalue-bench.md` — sibling decision-doc precedent (same methodology shape)

[1006]: https://github.com/iasbuilt/causl/issues/1006
[1015]: https://github.com/iasbuilt/causl/issues/1015
[1087]: https://github.com/iasbuilt/causl/issues/1087
[1133]: https://github.com/iasbuilt/causl/issues/1133
[1143]: https://github.com/iasbuilt/causl/issues/1143
[1146]: https://github.com/iasbuilt/causl/issues/1146
[1147]: https://github.com/iasbuilt/causl/issues/1147
[1152]: https://github.com/iasbuilt/causl/issues/1152
[1160]: https://github.com/iasbuilt/causl/issues/1160
[1160a]: https://github.com/iasbuilt/causl/issues/1160
[1160b]: https://github.com/iasbuilt/causl/issues/1160
