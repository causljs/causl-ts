# ABI A/B microbench — handle vs by-value (issue [#1160][1160])

## Status

**Framework-only.** This doc lands ahead of the bench numbers. It declares the
methodology, scenario design, decision matrix, and acceptance criteria so
reviewers can pre-agree on what the eventual measurement is allowed to
conclude. The measurement itself runs after both harness PRs land:

- **Harness A — by-value** ([#1160a][1160a]) — creates
  `tools/engine-rs-port-bench/` with the `serde_wasm_bindgen::to_value(&commit)`
  variant and benches/handle_vs_byvalue.rs::a_byvalue.
- **Harness B — opaque handle** ([#1160b][1160b]) — adds `handle.rs` + the
  `CommitHandle::read(key)` lazy-getter variant to the same crate and
  benches/handle_vs_byvalue.rs::b_handle.
- **Decision pass (this doc, second commit)** — runs `cargo bench -p
  causl-engine-port-bench` on a quiescent host, fills the result table below,
  applies the tripwire, and updates epic [#1133][1133] + Phase A sub-issue
  [#1147][1147] with the decided ABI shape.

Until the result table is filled, **Phase A ([#1147][1147]) cannot start.** This
is the explicit pre-Phase-A gate the Eich/Horwat panel review surfaced (see
epic [#1133][1133] "ABI shape decision precedes Phase A").

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

## Result table (placeholder — fills when bench actually runs)

> **TODO** (decision pass): fill after `cargo bench -p causl-engine-port-bench`
> on quiescent host. All cells `_` until measured. Once filled, this section
> becomes the canonical anchor numbers for the ABI decision.

### Raw timings

```
harness     scenario    median_ms   p95_ms    cov     alloc_commit   alloc_read
-----------------------------------------------------------------------------------
byvalue     1k_r1       _           _         _       _              _
byvalue     1k_r10      _           _         _       _              _
byvalue     1k_r100     _           _         _       _              _
byvalue     10k_r1      _           _         _       _              _
byvalue     10k_r100    _           _         _       _              _
handle      1k_r1       _           _         _       _              _
handle      1k_r10      _           _         _       _              _
handle      1k_r100     _           _         _       _              _
handle      10k_r1      _           _         _       _              _
handle      10k_r100    _           _         _       _              _
```

### Headline ratios (handle-relative, lower is better for the ratio holder)

| Scenario   | byvalue (ms) | handle (ms) | ratio (byvalue / handle) | tripwire band                  |
| ---------- | ------------ | ----------- | ------------------------ | ------------------------------ |
| `1k_r1`    | _            | _           | _                        | _                              |
| `1k_r10`   | _            | _           | _                        | _                              |
| `1k_r100`  | _            | _           | _                        | _                              |
| `10k_r1`   | _            | _           | _                        | _                              |
| `10k_r100` | _            | _           | _                        | _                              |

### Verdict

**TODO** (decision pass): apply tripwire → one of:

- [ ] **Handle wins** (any cell ratio ≥ 3.0) — re-scope per `decision matrix`.
- [ ] **By-value ships** (all cells in 0.5 ≤ ratio < 3.0) — epic as scoped.
- [ ] **By-value wins confidently** (all cells ratio < 0.5) — epic as scoped, perf headroom.
- [ ] **Re-run** (any cell `cov > 0.10`).

## Reproducing

```bash
# Build both harnesses (post-1160a + post-1160b merge):
cargo bench -p causl-engine-port-bench

# Output is structured stdout — the result table above is built from
# the bench's verbatim output. No post-processing scripts.
```

The harness is fully reproducible: no RNG, deterministic key vocabulary,
fixed `COMMITS` and `N_TRIALS`, fixed compute kernel. The only environmental
input is host load — keep it quiescent (see "Host" above).

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
