# #1483 Re-architecture constraint rubric

> Read alongside the [#1483 epic body](https://github.com/iasbuilt/causl/issues/1483).
> Feasibility studies #1485 (native binary), #1486 (in-place mutation), and
> #1487 (batched-commit) fill the rubric in §6 against the constraints
> below so the three architectures are compared on the same axes rather
> than each one against its own most-favourable framing.
>
> Source-of-truth files this rubric reads (anchored at dev `c2db0662`):
>
> - Adopter-API surface: `packages/core/src/index.ts`,
>   `packages/core/src/types.ts`, `packages/core/wasm/index.ts`,
>   `packages/react/src/index.ts`.
> - Deployment: `packages/core/package.json`,
>   `packages/checker-darwin-arm64/package.json` (existing per-platform
>   native-binary distribution pattern), `packages/core/wasm/README.md`
>   host-tier table, SPEC §17.6.
> - Perf: `packages/bench/report/g1-perf-measurement.{json,md}`,
>   `docs/epic-1133/G1-PERF-MEASUREMENT.md`, SPEC §17.5 + §17.6.
> - Parity / determinism:
>   `packages/core/test/properties/cross-backend-determinism.property.test.ts`,
>   SPEC §15.1 amendment (#1124).
> - Semantics: SPEC §3, §5.1 (eight named phases + Amendments 1–4),
>   §15.1, §17.

---

## 1. Adopter-API constraints

### 1a. Non-negotiable (public-surface invariants)

These are the SPEC §12.1 canonical seven plus the §12.2 second-tier
surface defended in `Graph` (`packages/core/src/types.ts:851-1476`).
Any re-architecture must preserve **shape, semantics, and error
catalogue** for every row in this table without a codemod.

| Surface | File:line | Why non-negotiable |
| --- | --- | --- |
| `createCausl(options?): Graph` | `packages/core/src/index.ts:26` (re-export); `types.ts:751-829` | The one constructor; named factory is the §12.1 canonical entry-point. |
| `graph.input<T>(id, initial): InputNode<T>` | `types.ts:865` | §4 two-primitive runtime universe — writable Behavior primitive. |
| `graph.derived<T>(id, compute, options?): DerivedNode<T>` | `types.ts:884-888` | §4 two-primitive — composed Behavior primitive. |
| `graph.commit(intent, run): Commit` | `types.ts:976` | §5 sole mutation API. Returns frozen `Commit` synchronously (no Promise); §5.1 phases A–H plus the `Tx`-closure scope are the contract. |
| `graph.read<T>(node): T` | `types.ts:1050` | §12.1 canonical read primitive. |
| `graph.subscribe<T>(node, observer, options?): Unsubscribe` | `types.ts:1085` | §12.1 canonical subscribe; Phase G fire-once semantics. |
| `graph.explain<T>(node): DerivedNode<Explanation>` | `types.ts:1230` | §11 first-class lineage primitive. |
| `graph.subscribeMany`, `subscribeCommits`, `subscribeReads` | `types.ts:1145, 1164, 1202` | §12.2 second-tier; tracked-deps surface React adapters consume. |
| `graph.simulate(intent, run): SimulateResult` | `types.ts:1038` | §5.4 dry-run; prefix of the commit pipeline. |
| `graph.commitMetadataDerived` | `types.ts:932` | §5.5 Phase F.5 seam (#452 / #455); recompute against just-refreshed `commitLog`. |
| `graph.snapshot(): GraphSnapshot` / `graph.hydrate(snap)` | `types.ts:1342, 1378` | §5.3 SSR / persistence; hydrate is a privileged caller of `commitInternal`. |
| `graph.readAt(node, t)` / `graph.snapshotAt(t)` | `types.ts:1403, 1419` | §12.2 retention-bounded historical reads (gated by `commitHistoryCap > 0` per §5.1 Amendment 1/2). |
| `graph.dependencies` / `graph.dependents` | `types.ts:1274, 1308` | §11 third-bullet inspection primitives. |
| `graph.exportModel`, `graph.commitLog`, `graph.now`, `graph.stats` | `types.ts:1326, 1450, 1424, 1475` | §11 / §12.2 plus the EngineTelemetry audit seam. |
| Race-class error catalogue: `CycleError`, `StaleTxError`, `UnknownNodeError`, `NodeDisposedError`, `NotAnInputNodeError`, `CommitInProgressError`, `DuplicateNodeError`, `HydrationSchemaError`, `DisposalDuringCommitError`, `NonDeterministicComputeError`, `DerivedRegistrationStackOverflowError`, `NodeHasDependentsError`, `InvalidGraphNameError`, `CauslError` | `packages/core/src/errors.ts` via `index.ts:67-82` | §9.1 race-class rows — tagged identity callers branch on. Renames or unwrap-to-strings break adopter `try/catch`. |
| React hooks: `useCausl`, `useDispatch`, `useCauslNode`, `useCauslShallow`, `useCauslSuspense`, `useCauslFamily`, `useCauslTypedArrayNode`, `CauslProvider`, `Hydrate`, `createUpdate`, `defineMsgs`, `assertNever` | `packages/react/src/index.ts:30-128` | §8 MVU surface + §10 worked-example gate. Frame-budget contract (≤16 ms p95 commit-to-paint, ≤5% dropped frames over 30 s) sits on top of these hooks. |
| `Bridge` / `BridgeFeatures` / `detectBridge` / `loadWasmBackend` / `WasmBackendUnavailableError` (structured `code` field) | `packages/core/wasm/index.ts`; `index.ts:128-138` | SPEC §17.6 commitment 14 — host-tier fallback contract. The `code` field is the structured-error dispatch adopters branch on. |
| `GraphTime` monotonicity: every commit advances `graph.now` by exactly one tick | SPEC §3, §5.1 Phase C | The §3 denotational invariant. `hydrate` and `simulate` route through the same pipeline so the invariant holds structurally rather than by hope. |
| `BackendEngine` interface (NodeId-keyed `commit`/`read`/`subscribe`/`snapshot`/`hydrate`/`readAt`/`snapshotAt`/`exportModel`/`dispose`/`evaluateStatechart`/`now`) | `packages/core/wasm/index.ts:177-197` | The cross-backend determinism gate (#685, F-marshal.5) runs against this shape; any new architecture exposes itself to the gate through this interface. |

### 1b. Migratable (with codemod, deprecation cycle, or breaking change)

These are surfaces that may be re-shaped during the re-architecture
provided adopters get a documented migration path (codemod, lint, or
typed deprecation) **and** the timing of the break is named in the SPEC
trail.

| Surface | File:line | Migration path |
| --- | --- | --- |
| `graph.read(node)` **reference identity** across commits | SPEC §15.1 amendment (#1124) | Already non-contractual per the amendment. Adopters memoise on `commit.time` or `EngineTelemetry`'s per-node version counter, NOT the read return reference. The amendment was added so the Rust-engine swap does not break adopters silently; any re-architecture inherits the same affordance. |
| `commit()`-as-synchronous vs `commit()`-as-batched | `types.ts:976` (current sync) | Re-architecture **(c) batched-commit** changes the timing semantics (commit may not land until the batch boundary). Requires explicit `graph.flush()` surface OR a documented "subscribers fire on flush, not on commit-return" contract. ESLint rule + codemod required if `graph.now`-incrementing semantics shift. |
| `commit().changedNodes` set construction | SPEC §17.5 (one of the four contract premiums) | Internal shape (`Set<NodeId>` vs ordered array vs IndexMap) is implementation choice; the *external observable* (`Commit.changedNodes` field on the frozen record) is non-negotiable. Container choice may change but iteration order is pinned by §5.1 Amendment 4. |
| `graph.commitLog` ring-buffer cap default | SPEC §5.1 Amendment 2 (#716) | Already flipped from 1000 to 0 in semver-major. Future caps can change with the same minor-N warn / minor-N+1 flip / minor-N+2 cleanup discipline. |
| `Node<T>` JSON-round-trippable value-type set | SPEC §15.1 + Capabilities cluster review (PLAN.md row "Capabilities") | The set of value types that survive a cross-FFI marshal is narrower than the TS-engine accepts (no functions, no Symbols, no class instances with prototype-bearing fields). A `JsonRoundtrippable` deprecation lint must precede any architecture that crosses an FFI boundary on the read path. |
| `BackendEngine.commit(intent, writes: ReadonlyMap<NodeId, unknown>)` shape | `packages/core/wasm/index.ts:178` | Phase-1 today wraps the TS engine and accepts a map. Architecture **(b) in-place mutation** replaces the map with per-write FFI mutator calls; this is internal to the backend shape and not visible at the `Graph` surface. |
| Bundle-size ceilings per host tier | SPEC §17.6 size table | Re-architecture **(a) native binary** retires the WASM bundle ceilings entirely (no `.wasm` artefact ships); **(b)** and **(c)** continue to honour them. SPEC §17.6 amendment trail row + `packages/core/wasm-pkg/README.md` carry the disposition. |
| Auto-adapt threshold surface (`createCausl({ backend: 'auto' })`) | `packages/core/src/auto-adapt.ts` | The decision shape (`AdaptThresholds`, `shouldMigrate`) is public, but the *backend identifiers* it switches between are migratable. Re-architecture (a) may collapse `'js' | 'wasm' | 'auto'` to `'js' | 'native' | 'auto'`. |

---

## 2. Deployment-target constraints

| Target | Required? | Current support | Rationale |
| --- | --- | --- | --- |
| Browser (Chrome 95+ / Firefox 102+ / Safari 16+) | **YES** | Full — TS engine ships unconditionally; WASM substrate (Phase-1 wrapper) ships per §17.6 host-tier matrix. `useCauslNode` / `useCausl` / `Hydrate` / React 18+ frame-budget contract assume the browser as a first-class target. | The library's positioning (§1 + §8 MVU + §14 perceptual-perf gates) is built around interactive UIs. Adopter-facing docs at `docs/wasm-adoption-guide.md` enumerate browser-CSP `wasm-unsafe-eval` posture, CDN `wasmBaseUrl`, and SSR `Hydrate`. A re-architecture that drops the browser target is a different product. |
| Node.js (22.0+, 22.6+ for GC-builtins) | **YES** | Full — Node is the SSR target (`Hydrate` consumes `GraphSnapshot` produced server-side); also the bench / determinism / property-suite host. | SSR plus the e2e bench / property harness. `@causl/sync` server-side uses Node-as-engine-host. |
| Native (macOS arm64 / macOS x64 / Linux arm64 / Linux x64 / Windows x64) | **MAYBE** (currently only `causl-check`, not the engine) | `packages/checker-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}/` already ship per-platform native binaries for `causl-check` (the Rust IR linter) via `optionalDependencies`. The **engine itself** is JS/WASM today; no native engine binary is produced. | The per-platform-binary distribution pattern is **already in the repo** and proven; adopters install `@causl/checker` and the right binary resolves via `optionalDependencies`. Re-architecture (a) (native engine) reuses this distribution pattern verbatim. |
| Cloudflare Workers / edge | **YES** | Per §17.6 — Workers run the universal `serde-json` bridge today; TS engine is the unconditional fallback. | Adopter-facing contract per `WasmBackendUnavailableError` `code` dispatch. A re-architecture that requires Node-specific APIs (`fs`, `child_process`, `node:worker_threads`) breaks the edge target. |
| Deno (1.30+) | YES (currently) | Per §17.6 — `--allow-net` for WASM fetch. | Tracked in `packages/core/wasm/README.md`; non-critical but documented. |
| Embedded runtimes (React Native, Hermes, etc.) | NO | Documented JS-engine fallback via `WasmBackendUnavailableError` `code: CAUSL_WASM_UNAVAILABLE`. | Per §17.6 commitment 14: "any host that runs JavaScript runs causl." The TS engine is the unconditional floor. Re-architecture (a) breaks this floor unless a JS-engine fallback ships alongside the native binary. |

**Critical framing for the three feasibility studies**: the browser
target is **NOT migratable** — re-architecture (a) (native Rust binary)
must either ship a WASM/JS fallback for the browser path or document a
deliberate scope reduction that strikes the entire `@causl/react` value
proposition. The §17.6 commitment-14 contract ("no supported host is
silently stranded") is the SPEC anchor; any architecture that requires
adopters to choose between "browser-only TS engine" and "Node-only
native engine" must either amend §17.6 or ship both code paths.

---

## 3. Perf-floor needs

**From G.1 measurement** (`docs/epic-1133/G1-PERF-MEASUREMENT.md` and
`packages/bench/report/g1-perf-measurement.md`, generated by
`packages/bench/scripts/g1-perf-measurement.ts`), the TS-engine
baseline for each of the six contract-bearing cells is below. All
medians are 5-trial-of-15-inner-sample medians at scale `× 10000`.

| Cell | TS median (ms / 10k) | TS p95 (ms) | Per-op cost (μs) | Adopter target rate (60 Hz UI workload) | Boundary headroom at G.1 marshal cost (15.64 μs / op) |
| --- | ---: | ---: | ---: | --- | ---: |
| `equality-cutoff` | 2.017 | 2.082 | **0.202** | 60 Hz × 1 commit/frame = 60 commits/sec — full TS workload fits in ~1.2% of one frame | **boundary alone is 78× the entire TS workload** |
| `equality-cutoff-fanout-10k` | 3.861 | 3.954 | 0.386 | 60 Hz × 1 commit/frame; 10k-fanout subscriber dispatch | 41× the TS workload |
| `spreadsheet-100x100` | 0.334 | 0.341 | 0.033 | 10k-cell spreadsheet workload at 60 Hz | **475× the TS workload** |
| `scrolling-viewport` | 0.112 | 0.113 | 0.011 | Scroll at 60 Hz over a 1000-cell viewport | **1418× the TS workload** |
| `batch-commit` | 2.145 | 2.173 | 0.215 | Bulk commits coalesced into a single outer commit | 73× the TS workload |
| `linear-chain` | 5.820 | 6.316 | 0.582 | Worst-case linear-chain recompute | 27× the TS workload |

**The arithmetic perf-floor for any new architecture** (against the
current G.1 boundary tax of 15.64 μs / op from F-marshal.6 PR #1478):

> A re-architecture that re-crosses an FFI / serialise boundary on
> every commit must reduce the per-commit boundary tax to **≤ 50 ns
> per op** (equivalently, the boundary cost summed across 10k commits
> must be **≤ 0.5 ms** — well below the smallest contract-bearing
> cell's median of 0.112 ms × 10k = 1.12 ms total). Architectures that
> can credibly land below this floor on every contract-bearing cell
> deserve consideration; architectures that cannot must show a
> different cost model (amortisation across batches; zero per-op
> crossing; in-place mutation that eliminates the envelope entirely).

**SPEC §17.5 commitment 13 (the capability-cost residual band).** The
canonical-cells `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0`
band remains the live SPEC requirement. The pre-G.1 projection that a
post-Rust port would tighten the band to 1.0×–4.0× is **retired by
the G.1 measurement** (see SPEC §17.5 "Status v0.9.0" callout). The
post-G.1 framing: a future SSOT swap to a real-Rust marshaler under
the current bridge architecture would *widen* the band, not tighten
it, because boundary cost dominates. Any new architecture that claims
to tighten §17.5 must show the boundary-cost line item explicitly.

**SPEC §17.6 commitment 14 (host-tier table).** Bundle-size envelopes
per tier (45 KB / 50 KB / 80 KB Brotli; serde currently at 66 KB
Brotli, 13 KB over the 200 KB raw target — Option C documented per
§17.6 current-state callout / SPEC §19 trail row for #1150). Any new
architecture either inherits the per-tier ceilings (options b/c) or
retires them by removing the WASM artefact entirely (option a).

---

## 4. Parity needs

Constraints derived from the cross-backend determinism gate
(`packages/core/test/properties/cross-backend-determinism.property.test.ts`,
F-marshal.5 PR #1477 — green at 1000 trials × 0 byte differences) and
the post-G.1 honest-framing rules.

| Parity question | Required? | Source / rationale |
| --- | --- | --- |
| Gradual migration: TS engine + new-architecture engine coexist for N versions | **YES** | SPEC §17.6 commitment 14: "any host that runs JavaScript runs causl"; TS engine is the unconditional floor. The new architecture is *acceleration*, not *substitution*, unless §17.6 is amended. |
| Backend swap at runtime (`createCausl({ backend: 'auto' })` flips between engines based on workload) | **YES** (per #686 auto-adapt) | `packages/core/src/auto-adapt.ts` is the public API surface for this; `shouldMigrate(stats)` decides. Any new architecture exposes itself through the same `AdaptThresholds` shape OR explicitly retires it via a SPEC amendment. |
| Wire-format byte-identity across backends (`exportModel()` IR, `snapshot()` envelope, `Commit` serialisation) | **YES** | The cross-backend determinism gate is the CI-blocking contract; F-marshal.5 has 1000 trials × 0 byte differences. Any new architecture exposes itself to the same gate. SPEC §5.1 Amendment 4 (Phase G subscriber container pin) + §15.1 amendment (reference-identity NOT contractual but value-identity at `GraphTime` IS) frame the byte-identity surface. |
| Cross-backend determinism (1000 trials × 0 byte differences) on a shared command alphabet | **YES** | `transition_js(s, a) == transition_new(s, a)` byte-identical, per SPEC §15.1 replay-determinism theorem. The gate is wired today and ready to fire; a new architecture plugs in through `BackendEngine` and the test runs unchanged. |
| `Object.is` semantics for `Object.is(read@t, read@t)` value identity | **YES** | SPEC §15.1 amendment (#1124). Reference identity across commits NOT contractual; value identity at fixed `GraphTime` IS contractual. NaN / ±0 / lone-surrogate parity is the panel-flagged risk (PLAN.md row "Engine semantics" — `Object.is` vs Rust `f64::eq` divergence). |
| SPEC §3 Theorem 2 uninterruptibility (no microtask between Phase E publish and Phase G dispatch across the FFI boundary) | **YES** | SPEC §3 Amendment (#1333, 2026-05-13). Documented standalone-value post-STOP-VERDICT so any future native backend inherits the contract without retro-fit. |
| SPEC §5.1 Amendment 4 (Phase G subscriber container insertion-order pin: `IndexMap` not `HashMap` not `BTreeMap`) | **YES** | Container choice is non-conformant if iteration order depends on hash seed (hashbrown) or sorts by id (BTreeMap). Insertion-order-preserving containers only. |

---

## 5. Semantic constraints (SPEC commitments)

| Commitment | SPEC ref | Survives any architecture? |
| --- | --- | --- |
| §3 denotational equation `derived(t) = f(b₁(t), …, bₙ(t))` | §3 | **YES** — engine-internal; every architecture preserves it or fails the glitch-freedom property test (`packages/core/test/properties/`). |
| §3 monotonicity invariant: `commit` is the ONLY way `now` advances, by exactly one tick | §3, §5.1 Phase C | **YES** — structural via `commitInternal` seam. Any architecture must route hydrate / simulate / future privileged callers through the same single pipeline. |
| §3 Theorem 2 atomicity / single-tick proof | §3 + §3 Amendment (#1333) | **YES** with the §3 Amendment: cross-FFI marshal of `Commit` must be uninterruptible end-to-end (no microtask between engine-side publish and host-side dispatch). |
| §5.1 Phase A–H sequencing (eight named phases plus F.4, F.5, F.6 dotted-suffix preserved) | §5.1 | **YES** — engine-internal; preconditions per §5.1 Amendment 1 may skip phases when work is dead, but the named-phase ordering is the contract. |
| §5.1 Phase F.5 commit-metadata-derived recompute against just-refreshed `commitLogEntry.value` | §5.1 + §5.5 | **YES** — `commitMetadataDerived` is the public seam; any architecture preserves the post-Phase-D-pre-Phase-G slot. |
| §5.1 Amendment 4 — Phase G subscriber-container insertion-order pin | §5.1 Amendment 4 (#1333) | **YES** — `IndexMap`-shaped containers only; hash-iteration and sorted-by-id containers are non-conformant. |
| §5.2 structural atomicity — throw in Phases B–F.6 lands in single catch-arm; engine state byte-identical after rollback | §5.2 | **YES** — every architecture must support byte-identical rollback. The Rust engine port's A.6 PR ported this verbatim into `rollback_on_throw` per SPEC §19 Theorem 3 trail row. |
| §5.4 `simulate` is a prefix of the commit pipeline (Phases A–E, unconditionally roll back) | §5.4 | **YES** — `simulate` is observer-invisible; any architecture preserves the prefix-then-rollback shape. |
| §15.1 cross-backend byte-identity (replay-determinism theorem) | §15.1 | **YES** — already validated by F-marshal.5 cross-backend determinism gate at 1000 trials × 0 byte differences. |
| §15.1 Amendment — `graph.read(node)` reference identity NOT contractual; value identity at fixed `GraphTime` IS | §15.1 Amendment (#1124) | **YES** — adopter contract surface; the amendment was added *ahead* of any backend swap so adopters memoise correctly today. |
| §17 commitment 13 — `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0` on contract-bearing cells | §17.5 (post-G.1 status callout) | **Survives in shape; current numbers DO NOT amend.** The 3.0×–8.0× band is the live SPEC requirement; the pre-G.1 1.0×–4.0× post-Rust projection is retired. A new architecture either holds the current band, widens it (failing), or earns a new lower bound via an architectural breakthrough that amends §17.5. |
| §17 commitment 14 — host-tier substrate compatibility (`wasmgc-builtins` / `wasmgc-classic` / `serde-json` + TS fallback); no host stranded | §17.6 | **DEPENDS on architecture choice.** (a) native: requires §17.6 amendment (the WASM substrate retires; the TS engine remains the unconditional floor for browsers). (b)/(c): inherit §17.6 unchanged. |
| §17.6 current-state divergence (serde bundle 213 KB raw / 66 KB Brotli, 13 KB over 200 KB raw target — Option C documented) | §17.6 current-state callout, §19 #1150 trail row | **DEPENDS.** (a) retires the divergence by retiring the artefact. (b)/(c) inherit it; the re-tightening path defers to the post-STOP-VERDICT outcome (DROP / PIVOT / DEFER per the §19 #1150 row). |
| §17 commitment 4 — every discriminated union in §9 is tagged with exhaustiveness via `assertNever` | §17.1 row 4 | **YES** — TS-side discipline; survives every architecture that ships a TS API surface. |
| §17 commitment 6 — §10 worked-example test as the "engine is real" gate | §17.1 row 6 | **YES** — `packages/core/test/spec-10-worked-example.test.ts` required-green on every PR. |
| §17 commitment 8 — `causl-check` ships as a required CI gate | §17.1 row 8 | **YES** — Rust IR-linter binary; orthogonal to the engine architecture. The per-platform-binary distribution pattern already exists for `@causl/checker-{darwin,linux,win32}-*`. |

---

## 6. Rubric for the three feasibility studies

Each of #1485 (native binary), #1486 (in-place mutation), and #1487
(batched-commit) fills the table below. The check-mark / question
shape is the same; the *evidence* is what each feasibility study
contributes.

| Constraint | Option (a) native binary | Option (b) in-place mutation | Option (c) batched commit |
| --- | --- | --- | --- |
| **§1a Non-negotiable adopter surface preserved without codemod** | ? | ? | ? |
| **§1b Migratable surface — codemods + lints required** | ? | ? | ? |
| **§2 Browser deployment** | ? *(hard requirement — see §2 framing)* | ? | ? |
| **§2 Node deployment** | ? | ? | ? |
| **§2 Native deployment (per-platform binary)** | ? | ? | ? |
| **§2 Cloudflare Workers / edge** | ? | ? | ? |
| **§2 Embedded runtimes (RN, Hermes) — TS fallback floor preserved** | ? | ? | ? |
| **§3 Per-commit perf — ≤ 50 ns per op boundary tax on every contract-bearing cell** | ? | ? | ? |
| **§3 `equality-cutoff` cell ≤ 2.017 ms / 10k (TS baseline)** | ? | ? | ? |
| **§3 `scrolling-viewport` cell ≤ 0.112 ms / 10k (TS baseline)** | ? | ? | ? |
| **§3 `spreadsheet-100x100` cell ≤ 0.334 ms / 10k (TS baseline)** | ? | ? | ? |
| **§3 SPEC §17.5 band held (3.0× ≤ causl/mobx ≤ 8.0×) on contract-bearing cells** | ? | ? | ? |
| **§4 TS + new engine coexist for N versions (gradual migration)** | ? | ? | ? |
| **§4 `createCausl({ backend: 'auto' })` runtime swap surface preserved** | ? | ? | ? |
| **§4 Cross-backend determinism gate green (1000 trials × 0 byte differences)** | ? | ? | ? |
| **§4 `Object.is` SameValue parity (incl. NaN / ±0 / lone surrogates)** | ? | ? | ? |
| **§5 SPEC §5.1 Phase A–H named-phase sequencing preserved** | ? | ? | ? |
| **§5 SPEC §5.1 Amendment 4 — Phase G IndexMap-shaped container** | ? | ? | ? |
| **§5 SPEC §3 Theorem 2 uninterruptibility (no microtask in marshal)** | ? | ? | ? |
| **§5 SPEC §15.1 value-identity at fixed `GraphTime` (reference identity opt-in)** | ? | ? | ? |
| **§5 SPEC §17.6 host-tier matrix preserved (no host stranded)** | ? | ? | ? |
| **Adopter migration cost (codemods needed, deprecation length, RC track)** | ? | ? | ? |
| **What's reused from #1133's 75 PRs (engine-rs-core, marshaler, bridge crates)** | ? | ? | ? |
| **What's thrown away from #1133's 75 PRs** | ? | ? | ? |
| **Realistic effort estimate (post-research, weeks)** | ? | ? | ? |
| **Kill-criterion: workload below which this architecture's boundary cost dominates the TS workload** | ? | ? | ? |

Filling instructions for the three feasibility studies:

1. Each row has a **structural** answer (yes / no / partial) and an
   **evidence link** (file:line, bench number, SPEC §, or named risk
   from PLAN.md row).
2. "?" entries are kill-criteria: if a study cannot answer a row with
   evidence, it has not completed its acceptance.
3. Rows marked with the bold §-prefix come straight from §1–§5 of this
   doc; do not mutate the row text — only mutate the answer column.
4. The "Browser deployment" row is the named hard requirement
   (§2 framing). A "no" answer on this row in study #1485 must be
   accompanied by either a §17.6 SPEC amendment proposal or a
   WASM/JS-fallback bullet that closes the gap.

---

## Appendix — Reading order for the three feasibility studies

When a study author opens this doc, the recommended reading order is:

1. SPEC §3 (Semantic foundation) and §5.1 (the eight named phases) —
   the load-bearing semantic contract.
2. SPEC §15.1 amendment (#1124) — the reference-identity bite that
   any FFI-crossing architecture inherits.
3. SPEC §17.5 (capability-cost residual, post-G.1 status callout) and
   §17.6 (host-tier matrix) — the perf and deployment commitments.
4. `docs/epic-1133/G1-PERF-MEASUREMENT.md` — the 78× boundary
   arithmetic that falsified the #1133 hypothesis. The arithmetic
   floor in §3 of this doc is derived from those numbers.
5. `packages/core/src/types.ts` `Graph` interface block (lines
   851–1476) — the canonical-seven plus second-tier surface adopters
   program against.
6. `packages/core/test/properties/cross-backend-determinism.property.test.ts` —
   the byte-identity gate every new architecture plugs into.
7. `docs/epic-1133/PLAN.md` rows 23–26 (the four panel-cluster
   verdicts on the falsified port) — the cross-functional review
   surface a new architecture must clear.
