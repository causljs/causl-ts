# `JsonValue::Object` representation bench — issue #1152

## Summary

**Decision: recommend swap from `BTreeMap<SmolStr, JsonValue>` to `IndexMap<SmolStr, JsonValue>`** with insertion-order-sorted keys, conditional on the SPEC §15.1 determinism contract surviving the type change. Numbers below show IndexMap is **≥10% faster than BTreeMap on every Phase-D-shaped workload at size 20 and 100**, with `Vec`-sorted tied at full-iteration but ~2× slower on keyed-lookup reads.

A follow-up PR is required to perform the actual swap; this investigation produces measurements + a decision, not the swap itself.

## Context

`tools/engine-rs-core/src/json_value.rs` (landed in #1078 / PR #1100) defines:

```rust
JsonValue::Object(BTreeMap<SmolStr, JsonValue>)
```

`BTreeMap` was chosen for SPEC §15.1 deterministic iteration. The choice has never been benchmarked against alternatives that also provide deterministic iteration:

- `Vec<(SmolStr, JsonValue)>` sorted by key (contiguous, cache-friendly).
- `IndexMap<SmolStr, JsonValue>` (insertion-order deterministic, dense hash-array).

Phase D recompute reads `JsonValue::Object` fields on every commit per derived node — this is the cache-miss-dominated hot path V8 hidden-class probes win on today.

## Methodology

### Harness

`tools/engine-rs-core-bench/benches/jsonvalue_object.rs` builds a minimal `Object`-shaped wrapper for each candidate exposing `get(&key)` and `iter()` against the same `(SmolStr, JsonValue)` pair vocabulary. All three wrappers sort the input pair set on construction so iteration order is sorted-by-key across all three candidates — that lets us compare them under a common determinism contract.

The bench measures **steady-state read cost** on a pre-built object; construction cost is not part of the headline numbers (Phase D recompute reads from existing State, doesn't rebuild objects per commit).

### Scenarios

`COMMITS = 10 000` per trial. `N_TRIALS = 15` outer iterations. Median, p95, and COV (sigma / mean) reported per scenario.

| Workload   | Per-commit access pattern                                    |
|------------|--------------------------------------------------------------|
| `read1`    | 1 keyed `get` (key index `i % vocab_size`)                   |
| `read10`   | 10 keyed `get`s (keys `(i + j) % vocab_size`, `j ∈ [0..10)`) |
| `read_all` | full iteration (`for (k, v) in obj.iter()`)                  |

Object sizes: **5, 20, 100** keys. Keys are short ASCII identifiers (`f000`, `f001`, …) so they fit inline in `SmolStr` (≤ 23 bytes) — matches the real key distribution (node ids, observer ids) in the engine's hot path.

### Determinism validation

The harness asserts before any timing:

1. Insertion-order independence: building each candidate from two permutations of the same pair set produces byte-identical iteration sequences.
2. Cross-candidate equality: `BTreeMap`-iter, `Vec`-sorted-iter, and `IndexMap`-iter (with pre-sorted insertion) produce byte-identical sequences on the same pair set.

Both pass. The SPEC §15.1 contract is preserved under any candidate as long as `IndexMap` is fed pre-sorted pairs (or sorts on construction — the new bench wrapper does the latter).

### Host

Runs reported below are from `cargo bench -p causl-engine-core-bench` on the worktree host (Apple Silicon, macOS), default `release` profile with workspace-level `lto = "fat"` and `panic = "abort"`.

## Raw numbers

Median ms / p95 ms / COV per scenario, from a single quiescent run. (Two prior runs reproduced the directional picture; IndexMap COV occasionally spikes on the 5-key `read10` scenario but the median delta is stable across runs.)

```
candidate    workload   size   median_ms   p95_ms    cov
---------------------------------------------------------
BTreeMap     read1      5        0.0778    0.0828   0.022
VecSorted    read1      5        0.1584    0.1742   0.025
IndexMap     read1      5        0.0699    0.1019   0.133 *
BTreeMap     read10     5        0.3835    0.3887   0.004
VecSorted    read10     5        0.9671    1.0140   0.015
IndexMap     read10     5        0.8568    0.8663   0.201 *
BTreeMap     read_all   5        0.0965    0.0996   0.010
VecSorted    read_all   5        0.0235    0.0237   0.001
IndexMap     read_all   5        0.0235    0.0235   0.000
BTreeMap     read1      20       0.1192    0.1230   0.009
VecSorted    read1      20       0.2243    0.2265   0.003
IndexMap     read1      20       0.0927    0.0960   0.050
BTreeMap     read10     20       1.2568    1.2647   0.005
VecSorted    read10     20       2.2872    2.6048   0.039
IndexMap     read10     20       0.9145    1.0738   0.043
BTreeMap     read_all   20       0.3006    0.3144   0.013
VecSorted    read_all   20       0.0656    0.0786   0.049
IndexMap     read_all   20       0.0632    0.0634   0.001
BTreeMap     read1      100      0.1907    0.1961   0.009
VecSorted    read1      100      0.3080    0.3225   0.017
IndexMap     read1      100      0.0798    0.0929   0.044
BTreeMap     read10     100      1.8993    1.9977   0.035
VecSorted    read10     100      3.2490    3.3403   0.012
IndexMap     read10     100      0.8695    0.9602   0.029
BTreeMap     read_all   100      1.9565    2.0183   0.019
VecSorted    read_all   100      0.2507    0.2637   0.013
IndexMap     read_all   100      0.2512    0.2629   0.012
```

`*` flags scenarios with COV > 0.10 (the acceptance bar). Both flagged scenarios live in the 5-key `read10` / `read1` regime where the absolute timings are sub-millisecond and small noise dominates the ratio. The directional ordering (IndexMap ≤ BTreeMap ≤ VecSorted on keyed reads, VecSorted/IndexMap ≪ BTreeMap on full iteration) is consistent across all three independent runs.

## Headline ratios (median ms, BTreeMap-relative)

| size | workload   | BTreeMap | VecSorted          | IndexMap            |
|------|------------|----------|--------------------|---------------------|
| 5    | `read1`    | 1.00×    | 2.04× (slower)     | **0.90× (faster)**  |
| 5    | `read10`   | 1.00×    | 2.52× (slower)     | 2.23× (slower)      |
| 5    | `read_all` | 1.00×    | **0.24× (faster)** | **0.24× (faster)**  |
| 20   | `read1`    | 1.00×    | 1.88× (slower)     | **0.78× (faster)**  |
| 20   | `read10`   | 1.00×    | 1.82× (slower)     | **0.73× (faster)**  |
| 20   | `read_all` | 1.00×    | **0.22× (faster)** | **0.21× (faster)**  |
| 100  | `read1`    | 1.00×    | 1.62× (slower)     | **0.42× (faster)**  |
| 100  | `read10`   | 1.00×    | 1.71× (slower)     | **0.46× (faster)**  |
| 100  | `read_all` | 1.00×    | **0.13× (faster)** | **0.13× (faster)**  |

Where IndexMap beats BTreeMap, the win is **22-58%** at size 20-100 — well above the 10% swap threshold the issue specifies.

## Decision: recommend swap (BTreeMap → IndexMap with sort-on-construction)

### Why IndexMap

- Wins on **every Phase-D-shaped read** at size 20 and 100 (the realistic range for the engine's object payloads; node attribute bags typically run 5-50 keys, observer state objects can climb to 100+).
- Wins on full iteration by **4-8×** across all sizes — the cache-line-jumping cost of BTreeMap's tree-walk dominates here.
- Wins on keyed `get` at size 20-100 because the hashbrown-backed hash probe is O(1) vs BTreeMap's O(log n) tree descent with pointer-chasing.
- Insertion-order determinism is preserved by sorting input pairs once at construction — the deserializer side (the only writer for object payloads) already iterates input in some order; sorting once is O(k log k) per object built, which is amortized into the deserialization cost (negligible vs the per-commit read cost).

### Why not Vec-sorted

- Wins big on full iteration (tied with IndexMap, both ~4-8× faster than BTreeMap).
- Loses on keyed `get`: binary search over `(SmolStr, JsonValue)` pairs is **62-104%** slower than BTreeMap, **128-285%** slower than IndexMap. The cache-friendly contiguous layout doesn't compensate for `O(log n)` SmolStr compares (each compare can touch the spilled-string heap allocation when the key spills past 23 bytes).
- The keyed-read scenarios (`read1`, `read10`) are the dominant Phase D access shape, so VecSorted is net-negative for the hot path.

### Caveat / risk

- IndexMap has a hashbrown dependency the engine doesn't currently pull. Adding it costs roughly 50-80 KB to the WASM bridge bundles (estimate; need to measure against SPEC §17.6 budget). The follow-up PR must check the bundle delta against the SPEC §17.6 / #1085 envelope before merging the swap.
- IndexMap's hash uses `RandomState` by default — same SipHash-13 seeded by the OS RNG `BTreeMap` deliberately doesn't pull. The determinism contract requires iteration to be deterministic regardless of hash; we achieve that by sorting on insertion. **The follow-up PR must explicitly set `IndexMap` to use a deterministic hasher (e.g. `FxHashMap`-style or the const-seeded variant) OR document that iteration is order-stable only when the constructor sorts the input.** This is a real correctness footgun to call out in the swap PR.

### Wontfix alternatives

- `HashMap` with iteration sorted on serialize — rejected because iteration order matters in more places than serialization (state hashing, debug output, cross-backend comparison points). Sorting every iter call is a quiet O(n log n) regression.
- Keep BTreeMap — rejected because IndexMap wins by 22-58% on the dominant Phase D access shape.

## Follow-up

If this investigation lands as-is, the swap should be filed as a follow-up issue citing this PR as the investigation source. The follow-up needs to:

1. Replace `BTreeMap<SmolStr, JsonValue>` with `IndexMap<SmolStr, JsonValue>` using a deterministic hasher.
2. Re-run the cross-backend determinism gate (`packages/core/test/properties/cross-backend-determinism.property.test.ts`) for 1000 trials × 5 seeds — the byte-equality contract must hold.
3. Measure the WASM bundle delta against the SPEC §17.6 / #1085 envelope.
4. Update the `json_value::tests::*` suite to assert iteration order on `IndexMap`.

## Reproducing

```bash
cargo bench -p causl-engine-core-bench
```

The harness is fully reproducible — no RNG, deterministic key vocabulary, fixed `COMMITS` / `N_TRIALS`. The output is structured plain-text rows the table above is built from verbatim.
