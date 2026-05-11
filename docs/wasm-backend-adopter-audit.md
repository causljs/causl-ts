# WASM-backend adopter audit (#695, merged)

Phase 0 deliverable for the WASM-backend epic (#680, **closed** —
all 17 Phase-0 + Phase-1 sub-issues merged). This audit walks
the existing public API surface — `packages/core/src/index.ts` exports,
everything `createCausl(...)` returns, the `@causl/react` adapter API,
and the documented adopter hook at `@causl/core/internal` — and lists,
for every adopter-visible symbol, what it currently means under the TS
engine and what (if anything) changes when a WASM-backed engine
implements the same `BackendEngine` interface (#681, **merged**).

> **Current-state note (0.9.0).** The `BackendEngine` interface carved
> in #681 has shipped and the Phase-1 `WasmBackend` returned by
> `loadWasmBackend()` implements it. That implementation is a
> **TS-engine wrapper** — it delegates to the same TS commit pipeline
> the JS engine uses, behind the FFI-shaped interface. The hazards
> H1–H8 below describe the contract surface adopters must hold under
> _any_ `BackendEngine` implementation, including the post-0.9.0 real
> Rust engine port tracked in epic #1133. Several hazards (most
> obviously H1) do not materialise under the Phase-1 wrapper because
> the wrapper reuses the TS engine's reference semantics; they
> materialise the day the Rust port lands. Read the hazards as
> _future-load-bearing_, not as Phase-1 bug surface.

> **Status update (v0.9.0) — post-0.9.0 panel-review wave.** A wave of
> sub-issues derived from the panel review of epic #1133 has landed
> _parity gates and dev-time instrumentation_ for several hazards in
> the H1–H10 table below. Crucially, none of these changes alter the
> contract surface — they pin the existing TS-engine behaviour into
> the property-test tier so the future Rust port is gated against
> regression. Adopters do **not** need to change application code; the
> notes here are migration-prose so you can locate the new gates and
> opt-in flags when reading the codebase.
>
> Parity-gate wave (newly shipped):
>
> - **#1154 — H3 parity gate.** A new property test in
>   `packages/core/test/properties/cross-backend-determinism.property.test.ts`
>   (plus a unit-level companion at
>   `packages/core/test/h3-subscribe-inside-compute.test.ts`)
>   pins the H3 contract: calling `graph.subscribe(...)` inside a
>   `compute` closure trips `CommitInProgressError` on both the JS
>   engine and the Phase-1 WASM wrapper. The gate stands for the
>   future Rust port — if a Rust commit pipeline ever fails to fire
>   the re-entrancy gate on mid-compute `subscribe`, this property
>   test goes red.
> - **#1155 — H1 dev warning (opt-in).** `createCausl(...)` accepts a
>   new `enableH1HazardWarning: true` option. When set,
>   `graph.read(node)` instruments the returned value with a dev-only
>   `WeakRef` watch and emits a one-shot `console.warn` if the same
>   reference is observed across a commit boundary. The warning is
>   **off by default** to keep the production hot-path crossing-free
>   and to avoid noise for adopters whose memoisation is keyed on
>   `commit.time` / `EngineTelemetry.nodeVersion(node)` (the
>   recommended migration target — see H1 below). Adopters
>   considering a future WASM-backed engine should enable the flag in
>   their development environment to surface H1-shaped code paths now,
>   while the Phase-1 wrapper's dormant reference semantics still let
>   the dormant case look benign.
> - **#1156 — `EngineTelemetry.nodeVersion` semantic-invariance gate.**
>   A new property test at
>   `packages/core/test/properties/node-version.property.test.ts`
>   pins the contract that `EngineTelemetry.nodeVersion(node)` is a
>   strictly-monotonic-per-node counter whose increments correspond
>   1:1 with commits that change the node's value. This is the
>   recommended H1 mitigation primitive — memoise on
>   `nodeVersion(node)` instead of reference identity — and the
>   gate ensures the primitive's semantics hold across backends.
> - **#1157 — H6 subscriber-order parity gate.** A new property test
>   at `packages/core/test/properties/subscriber-order.property.test.ts`
>   sweeps N=100 subscriptions across a multi-write commit and asserts
>   that Phase G dispatch fires them in registration order on both
>   backends. This is the gate that catches a Rust `HashMap`
>   regression the day the real Rust port lands (see H6 below for the
>   `IndexMap` recommendation).
> - **#1157 — H9 `memory.grow` scaffolding (deferred to Rust port).**
>   A new scaffold test at `packages/react/test/h9-memory-grow.test.ts`
>   carries `it.skipIf(!realRustBackend)` on every case. The file
>   stands as the gate definition; assertions activate when epic
>   #1133's Rust port enables the zero-copy typed-array path (see H7
>   for the contract). Adopters who hold a typed-array view across a
>   `subscribeCommits` fire today are safe under the Phase-1 wrapper
>   (which never hands one out) but should track this test file as
>   the canary that goes live on the Rust port.
>
> Current-code defect PRs (newly merged, same session):
>
> - **#1161** — `SPEC.md` §17.6 amendment documenting the 213 KB
>   serde bridge gap (#1150). Pure SPEC prose; no contract change.
> - **#1162** — `tools/engine-rs-core` `JsonValue::Object`
>   representation bench harness (#1152). Decides the open
>   question raised in H6's current-state note (BTreeMap vs IndexMap
>   for the changed-nodes set).
> - **#1163** — property tests now route through the tier resolver
>   instead of hardcoded `numRuns` (#1153). The H3 / H6 / nodeVersion
>   gates above all benefit — they automatically run at the
>   high-trial count on CI's nightly tier without further wiring.
> - **#1164** — `tools/engine-rs-core` generational `NodeId` disposal
>   (#1151). Pre-requisite for the Rust port's `dispose` semantics
>   matching the JS engine's tombstone model; lands the structural
>   change ahead of the commit-pipeline port.
>
> None of the above changes the H1–H10 table below. The hazards are
> still _future-load-bearing_ under the Phase-1 wrapper; the new gates
> just pin the contract so the Rust port has a fixture to clear.

This document gated #681 historically; both #695 and #681 are now
closed. The carve in #681 exposes every "adopter-visible Y" symbol
below on `BackendEngine`; symbols marked "Adopter-visible? N" stayed
TS-engine-only and do not appear on the interface seam.

The recommendations section at the bottom records the `BackendEngine`
shape that #681 ultimately landed.

## How to read the table

- **Symbol** — exported name (or a `graph.*` member of the value
  returned by `createCausl(...)`).
- **Type** — `value`, `function`, `class`, `interface/type`, or
  `getter`. Values without a runtime presence (pure types) are flagged
  `type` and have no WASM-side concern of their own — they describe
  the wire shape only.
- **Category** — broad role: `construct`, `register`, `commit`,
  `read`, `subscribe`, `inspect`, `persist`, `time-travel`,
  `lifecycle`, `error`, `ir`, `flag`, `react`, `mvu`.
- **TS-side semantics** — one-line summary of what the TS engine
  guarantees today (with a SPEC §-cite when load-bearing).
- **WASM-side concern** — what crosses the JS↔WASM bridge, the
  determinism contract, and any specific hazard the WASM port must
  reproduce. `(no boundary)` flags symbols that never cross the bridge
  (pure types, error classes constructed JS-side, IR which is JS-side
  output of `exportModel`).
- **Adopter-visible?** — `Y` if the symbol is part of the documented
  surface adopters consume; `N` if it is an internal seam reachable
  only via the deep-import contract `@causl/core/internal`. The N
  rows still ship in this audit because they bear on the BackendEngine
  carve, but they do not need to hold the same compatibility bar
  across backends.

## The catalogue

| Symbol                                                                                                          | Type              | Category    | TS-side semantics                                                                                                                                                        | WASM-side concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Adopter-visible? |
| --------------------------------------------------------------------------------------------------------------- | ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `createCausl`                                                                                                   | function          | construct   | Returns a `Graph` over a fresh TS-engine instance. Accepts `CreateCauslOptions`.                                                                                         | `backend: 'auto'\|'js'\|'wasm'` selector lands in #686. Construction may be **synchronous** for the TS path and **lazy-async** for WASM (module fetch + instantiation). The signature must stay synchronous and cold-start on JS so default callers keep their bundle budget; migration is post-construction (see #687).                                                                                                                                                             | Y                |
| `Graph`                                                                                                         | interface         | construct   | Public engine handle: 25-ish methods/getters covered individually below.                                                                                                 | The interface itself is type-only — the runtime question is whether each member's value shape is reproducible on the WASM side. See per-row entries.                                                                                                                                                                                                                                                                                                                                 | Y                |
| `GRAPH_ID_REGEX`                                                                                                | value (regex)     | construct   | Source of truth for the `name` / `graphId` validity rule. JS-side validation.                                                                                            | (no boundary) — ID validation is JS-side before any WASM call.                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `VERSION`                                                                                                       | value (string)    | construct   | Package-version literal pinned at `'0.0.0'`.                                                                                                                             | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `Graph.input<T>(id, initial)`                                                                                   | function          | register    | Registers a writable Behavior; throws `DuplicateNodeError` on collision. `T` is type-system only.                                                                        | `initial: T` crosses the boundary as a `JsValue`. **Must be JSON-serialisable through the active bridge** (serde / wasmgc-builtins / wasmgc-classic — see #680 bridge table). Functions, symbols, BigInt, Date, regex etc. break determinism across backends. The duplicate-id race is caught WASM-side by the same id-set guard.                                                                                                                                                    | Y                |
| `Graph.derived<T>(id, compute, options?)`                                                                       | function          | register    | Registers a composed Behavior; `compute` is a JS closure invoked under the engine's tracking `get` accessor. SPEC §4.                                                    | The compute closure **stays JS-side**. The WASM engine schedules recompute, but the closure runs in the host runtime; each `get(node)` round-trips into WASM (one crossing per dep read). The `tag: 'live' \| 'commit-metadata'` option must be honoured by the WASM scheduler — `commit-metadata` requires Phase F.5 ordering (SPEC §5.5). Closures carrying captured non-serialisable state are fine because they never cross.                                                     | Y                |
| `Graph.commitMetadataDerived<T>(id, compute)`                                                                   | function          | register    | Sugar for `derived(id, compute, { tag: 'commit-metadata' })` — recomputes in Phase F.5 against the just-refreshed `commitLogEntry.value`.                                | WASM engine **must implement Phase F.5** (commit-metadata recompute _after_ Phase D's regular fixpoint settles, _before_ Phase G subscriber fanout). This is non-trivial because it requires the WASM-side commit pipeline to expose the freshly-stamped commit before fanout. Bridge-agnostic.                                                                                                                                                                                      | Y                |
| `Graph.commit(intent, run)`                                                                                     | function          | commit      | The single mutation pipeline. SPEC §5. Throws `CommitInProgressError`/`CycleError`/`StaleTxError`/`NotAnInputNodeError`/`NodeDisposedError`/`UnknownNodeError`.          | `run` callback receives a `Tx` whose `set` calls cross the boundary — staged values must be JSON-serialisable. Re-entrancy gate must fire **before** any WASM round-trip so a nested-commit error matches TS-side semantics byte-for-byte. The returned `Commit` record (time/intent/changedNodes/originatedAt) is built on the WASM side and marshalled out — `changedNodes` ordering must be stable across backends (sort key = registration order or lexicographic; pin in #685). | Y                |
| `Graph.simulate(intent, run)`                                                                                   | function          | commit      | Dry-run prefix of the same pipeline. SPEC §5.4. Returns `SimulateResult`; throws only `CommitInProgressError`.                                                           | WASM port must support the §5.4 prefix-of-pipeline contract — runs Phase A–E, materialises the would-be Commit, then **rolls back byte-identical engine state** before returning. Mid-simulate `tx.set` write values cross the boundary and must roll back without leaving WASM-side residue. The caveat in #685 is that a simulate that allocates WASM memory but rolls back the values still leaves the high-water-mark — hosts should not assume zero-cost.                       | Y                |
| `Graph.read<T>(node)`                                                                                           | function          | read        | Reads committed value at `now`. Throws `UnknownNodeError`.                                                                                                               | One JS↔WASM crossing per call; return value crosses out as `JsValue`. Hot path — the `wasmgc-builtins` bridge gets the biggest speedup here (no UTF-8 round-trip for string-typed nodes). The `serde-json` bridge pays serialise+parse per read. **Adopters who hold a return value across commits**: the value is a _snapshot copy_ under serde, but may be a _zero-copy typed-array view_ under #688's optimisation — see hazards section.                                         | Y                |
| `Graph.subscribe<T>(node, observer, options?)`                                                                  | function          | subscribe   | Per-node observer. Initial-fire synchronous; subsequent fires in Phase G. SPEC §11.1. `options.transient` (#766) one-shot.                                               | The observer **stays JS-side**; the WASM engine maintains the subscriber index in linear memory and triggers a JS-side dispatch in Phase G. The dispatch is the costly crossing — values for changed nodes cross the boundary on every Phase G fire. The transient one-shot must auto-dispose **inside** the same commit pass on both backends.                                                                                                                                      | Y                |
| `Graph.subscribeMany<Ts>(nodes, observer, options?)`                                                            | function          | subscribe   | Group observer; fires once per commit when any group member changes. #766.                                                                                               | Same crossing model as `subscribe` × N nodes. The per-commit dedupe marker must be implemented WASM-side; otherwise a multi-write commit fires the group N times instead of once.                                                                                                                                                                                                                                                                                                    | Y                |
| `Graph.subscribeCommits(observer)`                                                                              | function          | subscribe   | Per-commit observer; SPEC §11. Returns the narrow capability.                                                                                                            | One Commit object per fire crosses out. `Commit` is small and structurally fixed (#760 hidden-class monomorphisation) — cheap on every bridge.                                                                                                                                                                                                                                                                                                                                       | Y                |
| `Graph.subscribeReads<T>(observer, projection)`                                                                 | function          | subscribe   | Projection-driven observer with engine-tracked read-set; SPEC §11.1 amended (#701).                                                                                      | The projection closure stays JS-side and is re-run on every fire under the engine's tracking accessor. Each re-run round-trips into WASM per `get`. The recorded read-set lives JS-side; the engine asks for a `commit.changedNodes ∩ read-set` predicate per commit — implementable as a JS-side intersection on the marshalled `changedNodes` array.                                                                                                                               | Y                |
| `Graph.explain<T>(node)`                                                                                        | function          | inspect     | Returns a `DerivedNode<Explanation>` — the engine-as-its-own-observer (SPEC §11).                                                                                        | The explanation tree is materialised on demand from the WASM-side dependency adjacency. Each node's lineage frame crosses the boundary as a serialised tree; recursion depth is bounded by `D = 32` per the IR contract.                                                                                                                                                                                                                                                             | Y                |
| `Graph.dependencies<T>(node)`                                                                                   | function          | inspect     | One-shot frozen `readonly NodeId[]` of depth-1 deps at `now`.                                                                                                            | Crosses the boundary as a string array; cheap. Must reflect post-Phase-D state — querying mid-commit is forbidden by the `CommitInProgressError` gate.                                                                                                                                                                                                                                                                                                                               | Y                |
| `Graph.dependents<T>(node)`                                                                                     | function          | inspect     | One-shot frozen `readonly NodeId[]` of depth-1 dependents at `now`.                                                                                                      | Same as `dependencies`. The reverse-dep map is maintained WASM-side.                                                                                                                                                                                                                                                                                                                                                                                                                 | Y                |
| `Graph.exportModel(options?)`                                                                                   | function          | ir          | Returns a `CauslModel` IR document for `causl-check`.                                                                                                                    | The IR is constructed JS-side — the WASM engine exposes registered nodes / dep edges / commit log via cheap getters and the JS shim assembles the document. Determinism: the IR must be byte-identical given byte-identical engine state. The `captureCallGraph` bit is JS-only (stack-walk is host-side); WASM never sees it.                                                                                                                                                       | Y                |
| `Graph.snapshot()`                                                                                              | function          | persist     | Returns `GraphSnapshot` (schema 1, `time`, `inputs`, optional `schemaHash`).                                                                                             | Serialises every input value through the active bridge. Schema-hash is computed JS-side over the registered id-set — backend-agnostic. **Hazard**: bridge choice does not affect snapshot wire-format (always JSON via `JSON.stringify` on the JS side after marshall-out), so a JS-engine snapshot hydrates a WASM-engine graph without renegotiation.                                                                                                                              | Y                |
| `Graph.hydrate(snap)`                                                                                           | function          | persist     | Bulk-applies a `GraphSnapshot` through the same Phase A–H pipeline. SPEC §5.3. Throws `HydrationSchemaError` on mismatch.                                                | The schema-hash gate runs JS-side **before** entering the commit pipeline; on mismatch the WASM engine never sees the hydrate. Cross-backend hydrate (snapshot taken on JS, hydrated on WASM, or vice versa) is the §5.3 invariant the WASM port must preserve byte-for-byte.                                                                                                                                                                                                        | Y                |
| `Graph.readAt<T>(node, t)`                                                                                      | function          | time-travel | Reads node value at past time `t`; bounded by `snapshotRetentionCap`. Returns `RetentionResult<T>`.                                                                      | Retention buffer lives WASM-side; the `Retained \| Evicted` discriminator crosses out. **Determinism**: derived recomputes against the retained input snapshot must be wavefront-memoised on both backends (a diamond DAG resolves each join exactly once) — pinned by #685.                                                                                                                                                                                                         | Y                |
| `Graph.snapshotAt(t)`                                                                                           | function          | time-travel | Whole-graph snapshot at past time `t`; same retention bound.                                                                                                             | Bulk variant of `readAt`; same hazard.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Y                |
| `Graph.now`                                                                                                     | getter            | read        | Current committed `GraphTime`.                                                                                                                                           | One u32/u53 crossing; cheap. The `now` value is the canonical clock — mismatched JS-side and WASM-side clocks would be a determinism violation. WASM holds the clock; JS reads it.                                                                                                                                                                                                                                                                                                   | Y                |
| `Graph.commitLog`                                                                                               | getter            | inspect     | Engine-owned `DerivedNode<readonly Commit[]>` exposing the bounded ring buffer.                                                                                          | The log lives WASM-side as a compact ring buffer. JS-side `read(commitLog)` materialises the array on demand (one crossing per `read` call). Phase F.4 refresh ordering (SPEC §5.5) is gated by `commitLogConsumerCount` — that counter must be maintained WASM-side.                                                                                                                                                                                                                | Y                |
| `Graph.stats()`                                                                                                 | function          | inspect     | Snapshot of seven engine-internal counters (#757).                                                                                                                       | Each counter is sourced from a WASM-side collection size; one crossing per call producing a flat `EngineTelemetry` object. **#695 amends this surface** — the `EngineTelemetry` interface in #696 is the richer event-channel surface; `stats()` is the orthogonal point-in-time leak gate. Both must work on both backends.                                                                                                                                                         | Y                |
| `Tx.set<T>(node, value)`                                                                                        | function          | commit      | Stages a write inside `commit`/`simulate` callback. Throws `NotAnInputNodeError`/`StaleTxError`.                                                                         | Each `set` is a crossing — staged values cross individually so a multi-write commit pays N crossings. Optimisation seam: a future `Tx.setBatch(entries)` could amortise to one crossing, but is out of scope for #681. The `StaleTxError` gate is JS-side (the Tx handle's `_active` flag) so escaped-handle writes are caught before WASM is touched.                                                                                                                               | Y                |
| `NodeId`                                                                                                        | type              | (type)      | `string` brand.                                                                                                                                                          | (no boundary) — strings cross via the bridge's `toWasmString`/`fromWasmString` pair.                                                                                                                                                                                                                                                                                                                                                                                                 | Y                |
| `GraphTime`                                                                                                     | type              | (type)      | `number` (u32-safe integer).                                                                                                                                             | (no boundary). Must stay JS-number-safe so `now`/`originatedAt`/`commit.time` round-trip without precision loss.                                                                                                                                                                                                                                                                                                                                                                     | Y                |
| `InputNode<T>` / `DerivedNode<T>` / `Node<T>`                                                                   | type              | (type)      | `{ readonly id: NodeId }` plus phantom brand.                                                                                                                            | (no boundary) — handles are JS-side objects; only the `id` string matters to the engine.                                                                                                                                                                                                                                                                                                                                                                                             | Y                |
| `Compute<T>`                                                                                                    | type              | (type)      | `(get: <U>(node: Node<U>) => U) => T`.                                                                                                                                   | (no boundary as a type). The closure runs JS-side; the `get` accessor is the round-trip primitive (see `Graph.derived` row).                                                                                                                                                                                                                                                                                                                                                         | Y                |
| `Observer<T>` / `SubscribeReadsObserver<T>`                                                                     | type              | (type)      | Observer callback signatures.                                                                                                                                            | (no boundary as types). The callback bodies run JS-side.                                                                                                                                                                                                                                                                                                                                                                                                                             | Y                |
| `Unsubscribe`                                                                                                   | type              | (type)      | `() => void` disposer.                                                                                                                                                   | (no boundary as a type); disposing flips a flag in the WASM-side subscriber index (one crossing).                                                                                                                                                                                                                                                                                                                                                                                    | Y                |
| `SubscribeOptions`                                                                                              | interface         | (type)      | `{ transient?: boolean }`. #766.                                                                                                                                         | (no boundary as a type). The boolean lands in the registration record on the WASM side.                                                                                                                                                                                                                                                                                                                                                                                              | Y                |
| `Commit`                                                                                                        | interface         | (type)      | `{ time, intent, changedNodes, originatedAt }`. #760 hidden-class pinned.                                                                                                | (no boundary as a type). Constructed WASM-side and marshalled out per Phase H fire — the four-field shape is deliberately small to keep the crossing cheap.                                                                                                                                                                                                                                                                                                                          | Y                |
| `Tx`                                                                                                            | interface         | (type)      | Mutation handle scoped to a commit callback.                                                                                                                             | (no boundary as a type); the runtime handle is a JS-side wrapper that calls into WASM on each `set`.                                                                                                                                                                                                                                                                                                                                                                                 | Y                |
| `SimulateResult` / `SimulateResultClean` / `SimulateResultFailed`                                               | type              | (type)      | `'clean' \| 'failed'` discriminated result of `simulate`.                                                                                                                | (no boundary as types). Constructed JS-side from the WASM-engine's prefix-of-pipeline output.                                                                                                                                                                                                                                                                                                                                                                                        | Y                |
| `Explanation` / `InputExplanation` / `DerivedExplanation` / `LiveExplanation` / `CycleExplanation` / `DepFrame` | type              | (type)      | Recursive lineage view. SPEC §11.                                                                                                                                        | (no boundary as types); the tree is materialised JS-side from WASM-side dep frames.                                                                                                                                                                                                                                                                                                                                                                                                  | Y                |
| `ExportModelOptions`                                                                                            | interface         | (type)      | `{ maxCommits?, captureCallGraph? }`.                                                                                                                                    | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `RetentionResult<T>`                                                                                            | type              | (type)      | `{ status: 'retained', value, time } \| { status: 'evicted', oldestRetainedTime }` for `readAt`/`snapshotAt`.                                                            | (no boundary as a type); the discriminator is constructed JS-side from the WASM-side retention-buffer probe.                                                                                                                                                                                                                                                                                                                                                                         | Y                |
| `CreateCauslOptions`                                                                                            | interface         | (type)      | Engine knobs: `commitHistoryCap`, `snapshotRetentionCap`, `disposedTombstoneCap`, `onObserverError`, `name`, `experimentalFlags`, deprecated `strictCycles`.             | (no boundary as a type). The `onObserverError` hook stays JS-side; observer throws are caught JS-side at the dispatch boundary. The `experimentalFlags` map is captured at construction and snapshot-frozen — must be passed through to the WASM engine constructor for flags that affect engine semantics.                                                                                                                                                                          | Y                |
| `CauslFlags`                                                                                                    | type              | (type)      | Snapshot of `CAUSL_*` env-var protocol (#706).                                                                                                                           | (no boundary as a type).                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Y                |
| `EngineTelemetry`                                                                                               | interface         | (type)      | `{ subscribersTotal, subscribersByNodeKeys, commitObservers, commitMetadataDeriveds, commitLogConsumerCount, entries, retainedCommits }` — #757 retained-state counters. | (no boundary as a type); the values are derived from WASM-side collection sizes. **#695 amendment**: this is the _current_ `Graph.stats()` shape; #696 carves a richer streaming `EngineTelemetry` over event channels and is a _new_ concern, not a replacement. Both will coexist.                                                                                                                                                                                                 | Y                |
| `GraphSnapshot`                                                                                                 | interface         | (type)      | `{ schema: 1, time, inputs, schemaHash? }` SSR-transferable envelope.                                                                                                    | (no boundary as a type). The `inputs` map's _values_ are bridge-affected (see `Graph.snapshot()` row).                                                                                                                                                                                                                                                                                                                                                                               | Y                |
| `ObserverErrorContext` / `ObserverErrorHandler`                                                                 | type              | (type)      | Hook signatures for observer-throw attribution.                                                                                                                          | (no boundary as types).                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Y                |
| `ValueMap<Ts>`                                                                                                  | type              | (type)      | Tuple-mapped value type for `subscribeMany`.                                                                                                                             | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `CommitInProgressError`                                                                                         | class             | error       | Thrown on nested `commit`/`simulate`/`hydrate`.                                                                                                                          | Constructed and thrown JS-side; the re-entrancy flag is JS-side so the WASM engine never sees the nested call.                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `CycleError`                                                                                                    | class             | error       | Thrown by Phase D's augmented Kahn pass when a commit closes a cycle. SPEC §9.1 row 8.                                                                                   | The cycle path is detected WASM-side; the path (a `NodeId[]`) crosses the boundary and JS reconstructs the typed error. **Cross-backend determinism**: identical input sequences must produce identical cycle-path orderings (canonical = lex-sort of the SCC's nodes).                                                                                                                                                                                                              | Y                |
| `DerivedRegistrationStackOverflowError`                                                                         | class             | error       | Thrown when a derivation's registration recursion exceeds the engine cap.                                                                                                | WASM-side recursion runs on the WASM stack (much higher cap than V8). The engine should still throw at the same logical depth as TS — pin in #685.                                                                                                                                                                                                                                                                                                                                   | Y                |
| `DisposalDuringCommitError`                                                                                     | class             | error       | Thrown when `dispose` is called inside an in-flight commit.                                                                                                              | Same JS-side re-entrancy gate as `CommitInProgressError`.                                                                                                                                                                                                                                                                                                                                                                                                                            | N                |
| `DuplicateNodeError`                                                                                            | class             | error       | Thrown by `input`/`derived` on id collision.                                                                                                                             | Detected WASM-side at registration; surfaced JS-side via the bridge.                                                                                                                                                                                                                                                                                                                                                                                                                 | Y                |
| `HydrationSchemaError`                                                                                          | class             | error       | Thrown by `hydrate` when schema/`schemaHash` mismatch.                                                                                                                   | Schema-hash check runs JS-side before WASM is entered.                                                                                                                                                                                                                                                                                                                                                                                                                               | Y                |
| `InvalidGraphNameError`                                                                                         | class             | error       | Thrown by `createCausl` when `name` violates `GRAPH_ID_REGEX`.                                                                                                           | JS-side, pre-WASM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Y                |
| `NodeDisposedError`                                                                                             | class             | error       | Thrown when accessing a disposed node.                                                                                                                                   | Tombstone map lives WASM-side; `dispose` (the `@causl/core/internal` adopter hook) writes the tombstone.                                                                                                                                                                                                                                                                                                                                                                             | Y                |
| `NodeHasDependentsError`                                                                                        | class             | error       | Thrown when disposing a node with live dependents.                                                                                                                       | The dependents check runs WASM-side at `dispose` time.                                                                                                                                                                                                                                                                                                                                                                                                                               | N                |
| `NonDeterministicComputeError`                                                                                  | class             | error       | Thrown when a derivation's compute is detected as non-deterministic across two evaluations of the same `t`.                                                              | **Hazard**: the canary check sometimes runs JS-side (per #679 surgical fixes), so cross-backend equivalence depends on whether the WASM engine reproduces the canary. Must be in #685's parity fuzz.                                                                                                                                                                                                                                                                                 | Y                |
| `NotAnInputNodeError`                                                                                           | class             | error       | Thrown by `Tx.set` when target is a derived node.                                                                                                                        | Polarity check is JS-side (the Tx wrapper) so the WASM engine never sees a derived-as-input write.                                                                                                                                                                                                                                                                                                                                                                                   | Y                |
| `CauslError`                                                                                                    | class             | error       | Base class for all engine errors.                                                                                                                                        | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `StaleTxError`                                                                                                  | class             | error       | Thrown when a Tx handle escapes its callback.                                                                                                                            | JS-side; the Tx's `_active` flag is JS-side.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Y                |
| `UnknownNodeError`                                                                                              | class             | error       | Thrown by every read-side primitive on unregistered ids.                                                                                                                 | Detected at the JS-side `getEntry` gate or, when the JS shim defers to WASM, surfaced via the bridge with the offending id.                                                                                                                                                                                                                                                                                                                                                          | Y                |
| `CauslModel` / `IR*` types                                                                                      | type              | ir          | Schema-3 IR for `causl-check`.                                                                                                                                           | (no boundary as types). The IR is JS-side output of `exportModel`.                                                                                                                                                                                                                                                                                                                                                                                                                   | Y                |
| `CAUSL_MODEL_SCHEMA`                                                                                            | value             | ir          | Schema version constant.                                                                                                                                                 | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `parseCauslModel`                                                                                               | function          | ir          | Parses an IR document; returns `ParseResult`.                                                                                                                            | JS-side parser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Y                |
| `causlModelJsonSchema`                                                                                          | value             | ir          | JSON Schema document for the IR.                                                                                                                                         | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `CauslModelJsonSchema`                                                                                          | type              | (type)      | Type for the JSON Schema document.                                                                                                                                       | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| **`@causl/core/internal`**                                                                                      |                   |             |                                                                                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                  |
| `INTERNAL_ENTRYPOINT`                                                                                           | value             | flag        | The literal entry-point string.                                                                                                                                          | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N                |
| `dispose(graph, node)`                                                                                          | function          | lifecycle   | Adopter-hook lifecycle: tombstone an id and free its slot. Used by `useCauslFamily`.                                                                                     | Hits WASM-side: deletes the id from the entries map, writes the tombstone, fires the `NodeHasDependentsError` gate. The dependents check **must** be atomic with the deletion or a concurrent `subscribe` could observe a half-disposed node — implementation gate, not a contract change.                                                                                                                                                                                           | N (deep import)  |
| `assertNever(value, hint)`                                                                                      | function          | (utility)   | Exhaustiveness probe.                                                                                                                                                    | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N (deep import)  |
| `ReadOnlyGraph`                                                                                                 | type              | (type)      | `Pick<Graph, 'read' \| 'subscribe' \| 'subscribeCommits' \| 'now'>`.                                                                                                     | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N (deep import)  |
| `CapabilityViolation`                                                                                           | class             | error       | Thrown when a narrowed capability is misused.                                                                                                                            | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N (deep import)  |
| `narrowCapability(graph)`                                                                                       | function          | (utility)   | Returns a `ReadOnlyGraph`.                                                                                                                                               | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N (deep import)  |
| **`@causl/react`**                                                                                              |                   |             |                                                                                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                  |
| `CauslProvider` / `CauslProviderProps`                                                                          | component / props | react       | React context provider; holds a `Graph` reference.                                                                                                                       | (no boundary at the React layer); the underlying graph is whichever backend it was constructed with.                                                                                                                                                                                                                                                                                                                                                                                 | Y                |
| `CauslContext` / `CauslContextValue`                                                                            | context / type    | react       | Underlying context object.                                                                                                                                               | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `useCausl(selector)`                                                                                            | hook              | react       | `useSyncExternalStore`-backed selector hook; subscribes via `subscribeCommits` + per-commit re-evaluation.                                                               | The selector closure runs JS-side and re-reads through `graph.read` on each fire. Each `read` is one crossing under WASM. The optimisation seam #688 (zero-copy typed-array views) lives below this hook; for this audit, `useCausl` is bridge-agnostic.                                                                                                                                                                                                                             | Y                |
| `Selector`                                                                                                      | type              | (type)      | `(graph: Graph) => T` selector signature.                                                                                                                                | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `useCauslShallow` / `shallowEqual`                                                                              | hook / function   | react       | Selector hook that uses shallow-equal for re-render gating.                                                                                                              | Same crossing model as `useCausl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Y                |
| `useCauslNode(node)`                                                                                            | hook              | react       | Per-node hook that subscribes via `graph.subscribe(node, …)` directly — only re-renders on this node's change. #677 / #738.                                              | The Phase G dispatch crosses once per change with the new value. The dropped-frames gate (`packages/react/e2e/tests/dropped-frames-1000.spec.ts`) must hold on both backends — pin in #685.                                                                                                                                                                                                                                                                                          | Y                |
| `useDispatch` / `Dispatch`                                                                                      | hook / type       | react       | Returns the typed `Msg` dispatcher bound to the provider's `Update`.                                                                                                     | (no boundary at the hook layer). The dispatched `Msg` lands in `runMessages` which calls `graph.commit` — see commit row.                                                                                                                                                                                                                                                                                                                                                            | Y                |
| `useCauslFamily(factory)` / `FamilyFactory` / `FamilyGraph`                                                     | hook / types      | react       | Per-key node identity within a provider; refcount-driven `dispose` via `@causl/core/internal`.                                                                           | Disposal hits WASM-side (see `dispose` row). The refcount lives JS-side.                                                                                                                                                                                                                                                                                                                                                                                                             | Y                |
| `useCauslSuspense(selector)` / `SuspendableResource<T>`                                                         | hook / type       | react       | Suspense projection of a `SuspendableResource<T>`.                                                                                                                       | The Suspense throw is JS-side; the underlying read is one crossing.                                                                                                                                                                                                                                                                                                                                                                                                                  | Y                |
| `Hydrate` / `HydrateProps`                                                                                      | component / props | react       | SSR hydrate; calls `graph.hydrate(snap)` on first mount. #130.                                                                                                           | One `hydrate` call per first-mount; see `Graph.hydrate` row.                                                                                                                                                                                                                                                                                                                                                                                                                         | Y                |
| `createUpdate` / `runMessages` / `Update`                                                                       | function / type   | mvu         | MVU `Update<Msg, Graph>` runner factory.                                                                                                                                 | (no boundary at the MVU layer); the runner calls `graph.commit`.                                                                                                                                                                                                                                                                                                                                                                                                                     | Y                |
| `defineMsgs` / `payload` / `MsgBuilder` / `MsgOf` / `MsgSpec` / `Msg` / `PayloadMarker`                         | function / type   | mvu         | Typed `Msg` discriminated-union helper. #369.                                                                                                                            | (no boundary). Type-system only.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Y                |
| `assertNever` (re-exported)                                                                                     | function          | (utility)   | Exhaustiveness probe surfaced from `@causl/react`.                                                                                                                       | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |
| `VERSION` (`@causl/react`)                                                                                      | value             | construct   | Pinned `'0.0.0'`.                                                                                                                                                        | (no boundary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Y                |

### Symbol counts

- Adopter-visible Y rows (excluding the section markers): **76**.
  The Y count is the bar #681's `BackendEngine` interface should
  clear: every Y-row symbol must be reproducible across backends
  without an adopter code change.
- Internal (N) rows: 8 — three core internals (`DisposalDuringCommitError`,
  `NodeHasDependentsError`, `INTERNAL_ENTRYPOINT`) and five
  `@causl/core/internal` deep-import hooks.

## Pre-existing adopter contracts that must hold across both backends

These are the contracts adopters depend on today and that the WASM
backend MUST reproduce. Each cites the SPEC section that pins the
contract.

1. **Atomicity** (SPEC §3 — Theorem 3, "Atomicity"; SPEC §5
   "Commit boundary" and §5.2 "Atomicity is structural, not
   aspirational"). A commit either creates exactly one new
   `GraphTime` with the full transitive recompute applied, or it
   creates none at all. A failed commit leaves no trace in the commit
   log, no per-node observer fires, and the engine clock does not
   advance. The Phase-1 wrapper inherits atomicity from the TS engine
   by delegation. The real Rust commit pipeline (epic #1133) must
   roll back linear-memory state byte-identically to the pre-commit
   moment — `derivedRollback` carries through the throw-restore path
   on the TS engine, and the Rust engine needs the equivalent. The
   `tools/engine-rs-core` crate (landed via #682) already exposes the
   generational `NodeId` (post-#1151), 7-named-struct cell shape,
   and `JsonValue` tree (post-#1078) the commit-path port will build
   on.

2. **Glitch-freedom** (SPEC §3 — Theorem 2). A derived value at
   time `t` is a pure function of its inputs at the same time `t`;
   no observer ever sees `f(B(t), C(t-1))`. The Phase D fixpoint on
   either backend must settle before any Phase G/H subscriber fire.
   The WASM port's scheduler must NOT optimise by interleaving Phase D
   recompute with Phase G dispatch.

3. **Replay determinism** (SPEC §15.1 — "Properties as the §3
   theorems made executable"). A recorded commit sequence replayed on
   a fresh graph must produce a byte-identical model state.
   _Cross-backend amendment_: the same recorded commit sequence
   replayed on JS, on WASM, and across a JS→WASM migration boundary
   must produce a byte-identical `commitLog`. JSON serialisation
   order, hash iteration order, and float NaN handling are the three
   known boundaries where backends can drift; #685 pins each.

4. **Inspection primitives are first-class** (SPEC §11.1 —
   "Inspection primitives"). `explain(node)` returns a `DerivedNode`,
   `commitLog` is a `DerivedNode`, `subscribeReads(observer,
projection)` tracks reads automatically. The WASM engine must
   ship the same inspection-primitive shape; _not_ a side-channel
   devtools API, _not_ a one-shot JSON dump. The Rust engine in
   `tools/engine-rs-core` already exposes the dependency adjacency
   the JS shim needs to materialise these views; under the Phase-1
   wrapper, inspection primitives delegate to the TS engine and the
   shape is preserved trivially.

5. **Single mutation pipeline** (SPEC §5.3 — "`hydrate` is a
   privileged caller, not a parallel pipeline"; §5.4 — "`simulate` is
   the dry-run, and it is a _prefix_ of the same pipeline"). There is
   exactly one Phase A–H pipeline on each backend, and `hydrate` /
   `simulate` reuse it. The WASM port must NOT implement a parallel
   "fast path" for hydrate.

6. **Phase F.5 ordering for commit-metadata deriveds** (SPEC §5.5
   — "The three options for Phase F.5"). Commit-metadata-tagged
   deriveds recompute _after_ Phase D's regular fixpoint settles and
   Phase F.4 has refreshed `commitLogEntry.value`, but _before_ Phase
   G fires per-node subscribers. The WASM port must implement the
   same three-stage ordering — this is the only ordering that lets
   `whyUpdated` / `whyNotUpdated` / `commitLog` ship as live derived
   nodes rather than one-shot snapshots.

7. **Bounded retention** (SPEC §11 implicit; `RetentionResult<T>`
   discriminator). `commitHistoryCap`, `snapshotRetentionCap`, and
   `disposedTombstoneCap` are caller-tunable bounds, defaulting to
   1000 / 50 / 1000. A read for a time outside the retention window
   returns `{ status: 'evicted', oldestRetainedTime }` rather than
   `undefined` or a throw. The WASM-side ring buffer must honour the
   same caps; **eviction order must be FIFO on insertion order on
   both backends** so two engines run with the same cap evict the
   same `t`s.

## Known compatibility hazards

Hazards are bug-shaped questions that the WASM port must answer
explicitly, not implicitly.

### H1 — Long-held value references across commits

The TS engine returns inputs and derived values **by reference** from
`graph.read(node)`. Adopters routinely hold a returned object across
commits and rely on referential equality for memoisation
(`React.memo`, `useMemo` cache invalidation). Under a real WASM
backend (epic #1133):

- The `serde-json` bridge produces a **fresh JS object on every
  read** (the serialiser allocates anew each call). Adopters who
  rely on `prev === next` will re-render on every `read`, even when
  the underlying value did not change.
- The `wasmgc-builtins` and `wasmgc-classic` bridges _can_ hand out
  stable references via `externref`, but only if the engine
  internally caches the JS-side object across reads — and that
  caching cost is non-trivial.
- The #688 zero-copy typed-array views break referential equality
  on every `memory.grow()` call.

**Mitigation (status: ratified via PR #1129)**: SPEC §15.1 was
amended to remove referential identity of `read` return values from
the contract. The amendment shipped under Issue #1124. Adopters who
need identity must use the engine's `Object.is` equality cutoff at
the subscribe layer (which is preserved across backends), or
memoise on `commit.time` / `EngineTelemetry.nodeVersion(node)`. See
`docs/wasm-adoption-guide.md` § H1 for the adopter-facing right-vs-
wrong code example, and the H1 callout above the host-tier table in
`packages/core/wasm/README.md`. Under the Phase-1 wrapper the
hazard is **dormant** (the wrapper delegates to the TS engine and
inherits its reference behaviour); the day epic #1133 lands real
Rust serde / wasmgc bridges, this becomes a live migration hazard.

### H2 — Long-lived Tx handle references

`StaleTxError` already structurally rules out using a `Tx` outside
its callback. The WASM port preserves this because the JS-side `Tx`
wrapper carries the `_active` flag and the gate runs JS-side. **No
hazard** — listed for completeness because the original adopter
audit asked the question.

### H3 — Subscribe inside a derivation's compute closure

The TS engine permits `graph.subscribe(...)` inside a `compute`
closure (it is unwise but not throw-on-detect). Under WASM the
`compute` runs JS-side; calling `graph.subscribe` would round-trip
into WASM mid-tracking-walk and could corrupt the dep-set capture.
**Mitigation**: the `CommitInProgressError` gate already fires on
re-entry; verify that calling `subscribe` mid-compute trips the gate
on both backends (probably already does because the commit is in
progress). Pin a parity test in #685.

### H4 — Custom `onObserverError` hook timing

The hook fires on observer-throw during Phase G/H dispatch. The TS
engine fires it **synchronously** from inside the dispatch loop. The
WASM engine must do the same — a deferred fire (via
`queueMicrotask`) would change the observable timing for adopters
who use the hook to e.g. mark a commit as "tainted" before the
dispatch loop continues. The `subscribe-reads-projection` source
arm specifically requires the registration be preserved and the
recorded read-set left intact after a throw — that's a non-trivial
WASM-side commitment.

### H5 — IR `captureCallGraph` cross-backend

`exportModel({ captureCallGraph: true })` walks the synchronous JS
call stack at commit-issue time. This is **inherently JS-side** —
WASM cannot capture a JS stack. The current shim already treats this
as JS-side post-processing of the commit record; the contract is
preserved trivially. **No hazard** — listed because the §16.2.1.3
contract reads load-bearing.

### H6 — Subscriber-fire ordering across nodes in one Phase G

Phase G fires subscribers grouped by node id. The TS engine iterates
the `changedNodes` array in **registration order** (insertion order
of the `Set<NodeId>` populated during Phase D). The WASM port must
match this order — Rust's default `HashMap` iteration is _not_
stable across runs, so the engine must use an `IndexMap` (or
equivalent insertion-preserving collection) on the WASM side.
Pinned in #685's cross-backend parity fuzz; if it drifts, adopters
who write `subscribe(a, …)` and `subscribe(b, …)` and rely on
"the `a` observer fires before `b`" will see different ordering on
WASM.

**Current-state note.** `tools/engine-rs-core` post-#1078 holds the
JSON value tree as `JsonValue::Object(BTreeMap<SmolStr, JsonValue>)`,
giving lexicographic-stable iteration for object-shaped values. The
open question of whether the _changed-nodes set_ itself should swap
to `IndexMap` (insertion-stable) is tracked in Issue #1152; the
property-test tier sweep (PR #1164) is the gate that decides.

### H7 — `useCauslNode` and `memory.grow()` mid-render

The #688 zero-copy typed-array path hands React a `Float64Array`
view into WASM linear memory. The view is invalidated on the next
`memory.grow()` call. React renders run between commits, so views
are stable _during_ a render — but a long-running render that spans
a microtask boundary is theoretically vulnerable. The current
engine pre-allocates worst-case buffers and doesn't grow mid-render
(#687 nails this down); the audit flag is to **document** the
contract: views are stable until the next commit, callers must NOT
keep a view across a `subscribeCommits` fire.

**Current-state note.** Phase-1 ships the wrapper backend, which
never hands out typed-array views into WASM linear memory — the
hazard is dormant until epic #1133's Rust port enables the
zero-copy path.

### H8 — Migration boundary `originatedAt`

A commit produced on the JS engine, then replayed on the WASM
engine after migration, must carry the same `originatedAt` value
(`undefined` for non-hydrate commits, the snapshot's `t` for
hydrates). This is an obvious determinism gate but easy to miss
because `originatedAt` is the only `Commit` field that is
sometimes-undefined. #687 carries the migration envelope; the
parity test pinned in #685's cross-backend fuzz is green at
10 000 trials per `docs/wasm/phase-1-perf.md`. Under the Phase-1
wrapper this is byte-trivial (same TS pipeline either side); the
test stands for the real Rust port (epic #1133).

## Recommendations for #681 (`BackendEngine` interface) — landed

#681 has merged; the `BackendEngine` interface this audit recommended
shipped substantially as drafted below. The shape is preserved here
for historical reference and because adopters reading this audit
benefit from a one-stop catalogue of the seam. Where the merged
interface diverges from the draft, the prose under the block notes
the change.

The following symbols MUST appear on `BackendEngine` (one method per
row; the JS-side `Graph` is the user-visible facade and delegates):

```ts
interface BackendEngine {
  // Construct / lifecycle
  dispose(node: NodeId): void // from @causl/core/internal
  readonly now: GraphTime

  // Register
  registerInput(id: NodeId, initial: unknown): void
  registerDerived(
    id: NodeId,
    compute: (get: <U>(node: Node<U>) => U) => unknown,
    options?: { readonly tag?: 'live' | 'commit-metadata' },
  ): void

  // Commit pipeline
  commit(intent: string, writes: ReadonlyMap<NodeId, unknown>): Commit
  simulate(intent: string, writes: ReadonlyMap<NodeId, unknown>): SimulateResult

  // Read
  read(node: NodeId): unknown
  readAt(node: NodeId, t: GraphTime): RetentionResult<unknown>
  snapshot(): GraphSnapshot
  snapshotAt(t: GraphTime): RetentionResult<GraphSnapshot>
  hydrate(snap: GraphSnapshot): void

  // Subscribe (observers stay JS-side; the engine fires them on Phase G/H)
  subscribe(node: NodeId, observer: Observer<unknown>, opts?: SubscribeOptions): Unsubscribe
  subscribeMany(
    nodes: readonly NodeId[],
    observer: (values: readonly unknown[]) => void,
    opts?: SubscribeOptions,
  ): Unsubscribe
  subscribeCommits(observer: (commit: Commit) => void): Unsubscribe
  subscribeReads<T>(observer: SubscribeReadsObserver<T>, projection: () => T): Unsubscribe

  // Inspect
  explain(node: NodeId): DerivedNode<Explanation>
  dependencies(node: NodeId): readonly NodeId[]
  dependents(node: NodeId): readonly NodeId[]
  exportModel(options?: ExportModelOptions): CauslModel
  stats(): EngineTelemetry // §757 retained-state counters
  readonly commitLog: DerivedNode<readonly Commit[]>

  // Telemetry (lands with #696)
  readonly telemetry: import('./telemetry.ts').EngineTelemetry // streaming surface
}
```

### Symbols that MAY stay TS-engine-only (not on `BackendEngine`)

- **The Tx wrapper.** The `Tx` interface is the JS-side staging
  helper that batches `set` calls into a `ReadonlyMap<NodeId,
unknown>` for the backend's `commit(intent, writes)` method. Keep
  it JS-side; a backend should never see a Tx.

- **Error classes.** All `CauslError` subclasses are constructed and
  thrown JS-side; backends report errors structurally (e.g. a
  `{ kind: 'cycle', path: NodeId[] }` payload) and the JS shim wraps
  them. This is what lets the same JS error surface across backends
  without each backend re-implementing the class hierarchy.

- **`Tx.set`'s polarity gate.** `NotAnInputNodeError` is caught by
  the JS-side `Tx` wrapper before any crossing.

- **`StaleTxError`'s `_active` flag.** JS-side per-call wrapper.

- **`exportModel` options' `captureCallGraph`.** The stack-walk is
  inherently JS-side (per H5).

- **`onObserverError` hook plumbing.** The hook itself is JS-side;
  backends only need to surface the throw to the JS dispatch loop.

- **Schema-hash gate in `hydrate`.** Runs JS-side before the backend
  is entered (per H4).

- **The IR document construction.** `exportModel` materialises the
  `CauslModel` JS-side from the backend's cheap getters
  (`registeredNodes`, `dependencyEdges`, `commitLogSlice`); a future
  tiny addition to `BackendEngine` could be `getDependencyEdges():
ReadonlyMap<NodeId, readonly NodeId[]>` if the JS-side `dependencies`
  method-loop is too crossing-heavy on a 100k-node graph. Defer to
  perf evidence in #694.

- **`@causl/core/internal` capability narrowing
  (`narrowCapability`).** Pure JS-side `Pick<Graph, …>`. Backends do
  not see it.

### Open question: `subscribeReads` projection ergonomics under WASM

`subscribeReads` re-runs the projection on every fire. Under WASM,
each `get(node)` inside the projection is a crossing — a projection
that reads 50 nodes pays 50 crossings per fire. This is fine for
small projections but could dominate cost on large ones. **Options**:

1. **Status quo** — projection runs on the JS side; pay the
   crossings. Simplest; matches the TS-engine model.
2. **Read-set caching** — cache the recorded read-set across fires
   and only re-run the projection when `commit.changedNodes ∩
read-set` is non-empty. Already the §11.1-amended behaviour;
   nothing changes.
3. **Projection-on-WASM** — compile a sub-language of projections
   to WASM (the formula IR carved in #697). Out of scope for #681
   but aligned with #697's seam.

**Recommendation for #681**: pursue option 2 (the existing
contract) and document the per-crossing cost in the adopter docs in
#690. Defer option 3 to #697.

### Future seams to preserve in the #681 carve

- **`BackendEngine.exportSnapshotAsJson()`**: a crossing-light path
  for SSR transfer. Under WASM, the JSON serialisation runs WASM-side
  and a single string crosses out. Not load-bearing for #681; carve
  the seam with a TODO so the JS path is the implementation today.
- **`BackendEngine.commitBatch(intents: readonly { intent, writes
}[])`**: amortises the per-commit envelope cost across N commits.
  Out of scope for #681 (it's #674 territory) but worth noting that
  the carve should not preclude it.

## Validation summary

This document cites SPEC §3, §5 (and §5.1–§5.5), §11.1, §15.1
explicitly. All four are present in `docs/SPEC.md` (or rather the
top-level `SPEC.md` — the repository's canonical SPEC location):

- §3 Semantic foundation — line 62
- §5 Commit boundary — line 129 (with §5.1–§5.6 sub-sections)
- §11.1 Inspection primitives — line 615
- §15.1 Properties as the §3 theorems made executable — line 933

Cross-references verified by `grep -n "^## " SPEC.md` at audit time.

## What this audit does NOT change

- No code in `packages/core/src/` or `packages/react/src/` changes.
- No SPEC text changes.
- No bench changes.

This is a research deliverable that gates #681. The interface in #681
is the next step; this audit's recommendations are inputs to it, not
prescriptions on it.
