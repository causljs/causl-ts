# @causl/core

> The semantic core of [Causl](../../README.md): two primitives, one
> commit, the canonical seven-method API plus the second-tier extensions
> justified individually in SPEC §12.2.

## Install

```bash
pnpm add @causl/core
```

## Quick start — the smallest example that proves the engine is real

Before any cell, any formula, any resource, the engine must support this
shape. The four invariants — atomic commit, dependency tracking,
dynamic-dep cleanup, glitch-free diamond — all fall out of getting it
right; everything downstream depends on it.

```ts
import { createCausl } from '@causl/core'

const graph = createCausl()
const a = graph.input('a', 1)
const b = graph.input('b', 2)
const sum = graph.derived('sum', (get) => get(a) + get(b))
const sumPlusOne = graph.derived('sumPlusOne', (get) => get(sum) + 1)

graph.subscribe(sumPlusOne, (v) => console.log(v)) // 4

graph.commit('bump-a', (tx) => tx.set(a, 10))      // 13
graph.commit('bump-both', (tx) => {
  tx.set(a, 100)
  tx.set(b, 200)
})                                                 // 301 — exactly one fire
```

## API

The `Graph` interface exposes twenty public surface items. The first
seven are SPEC §12.1's canonical load-bearing surface — the rows the
engine cannot exist without one of. The remaining thirteen are SPEC
§12.2 second-tier extensions, each justified individually and
reviewed quarterly. Together with the `createCausl` factory that
is twenty-one callable entry points; the size of that surface is
itself a row in the engine's eight-commitment table, so a
twenty-second `Graph` item demands the same justification as a
twenty-first.

### Canonical seven (SPEC §12.1)

| Method | Purpose |
| --- | --- |
| `createCausl(options?)` | Construct a graph. Options: `commitHistoryCap`, `snapshotRetentionCap`, `onObserverError`. |
| `graph.input<T>(id, initial)` | Register a writable Behavior. Throws `DuplicateNodeError` on a clashing `id`. |
| `graph.derived<T>(id, compute)` | Register a derived Behavior; deps captured by `get()` calls in `compute`, so a derivation that switches branches on an `if` rewires its dependency set on the next evaluation. |
| `graph.commit(intent, tx => …)` | Discrete event — advances GraphTime by exactly 1. The only mutation entry; nested commits throw `CommitInProgressError`. |
| `graph.read(node)` | Read at the current committed time. Per the SPEC §15.1 amendment shipped via PR #1129, the JavaScript *reference* returned across calls is **not** contractually guaranteed; the contractual identity surface is **value identity** at a fixed `GraphTime`. Today's TS engine (and the Phase-1 `WasmBackend` from `@causl/core/wasm`, which wraps it) trivially returns the same reference for object-valued reads, but the real Rust `serde`/`wasmgc` bridges promised by EPIC #680 / §17.6 return a fresh object per call. Adopters who memoise on the read return reference (e.g. `React.memo`, `useMemo([value])`) MUST key on `commit.time` or the per-node version counter exposed by `EngineTelemetry` instead. |
| `graph.subscribe(node, observer)` | Observe value changes; one notification per commit per affected subscriber. Returns `Unsubscribe`. |
| `graph.explain(node)` | Returns a `DerivedNode<Explanation>` of the lineage. Itself subscribable, so devtools render on top of the engine's own primitives instead of a parallel system. |

### Second-tier extensions (SPEC §12.2)

| Surface | Purpose |
| --- | --- |
| `graph.subscribeCommits(observer)` | Observe every commit. Narrow per-fire notification capability — one `Commit` per fire, no log read — for devtools, persistence, and SSR-hydrate listeners that want "wake me on any change" without access to the full log. |
| `graph.commitLog` (getter) | The transaction log surfaced as a `DerivedNode<readonly Commit[]>` — `read`able, `subscribe`able, and visible in `explain(node)` lineage views. Bounded by `commitHistoryCap` (default 1000); failed commits never append. There is no separate "log API" because the log is just another node. |
| `graph.exportModel(options?)` | CauslModel IR for `causl-check`, the bounded model checker. The IR is a public contract; this method is its only producer. |
| `graph.snapshot()` | Capture the current input set + GraphTime as a serialisable `GraphSnapshot` (SSR transfer, persistence, time-travel). Derived nodes are intentionally omitted — they are pure functions of inputs and recompute on first read. |
| `graph.hydrate(snap)` | Bulk-apply a `GraphSnapshot`: writes the snapshotted inputs, advances `now` to `snap.time`, fires per-node subscribers whose values changed, and emits a single `Commit` with `intent: 'hydrate'`. Throws `HydrationSchemaError` on a `schemaHash` mismatch — the structural defence against the hydration-mismatch race class. |
| `graph.readAt<T>(node, t)` | Read `node` at a past committed time `t ≤ now`. Returns a `RetentionResult<T>` discriminated `Retained \| Evicted` per SPEC §9; bounded by `snapshotRetentionCap` (default 50). The `Evicted` arm is the engine's honesty about bounded retention — a tag check at the call site rather than `undefined` or a throw. |
| `graph.snapshotAt(t)` | Project a whole-graph `GraphSnapshot` at a historical GraphTime `t`, sourced from the bounded retention buffer. Returns a `RetentionResult<GraphSnapshot>`. The bridge consumes this on JUMP / IMPORT_STATE / ROLLBACK so time travel is observed *as a read* on a `Behavior`, not as a mutation — preserving the contract that the only way time advances is through `commit`. |
| `graph.simulate(intent, run)` | The §5 dry-run API: predict what `commit(intent, run)` would do *without* committing. Returns a discriminated `SimulateResult` carrying the would-be `Commit` and the staged-input / derived-recompute diffs on the `'clean'` arm, or the typed engine error on the `'failed'` arm. After the call returns, engine state is byte-identical to the pre-call moment — `now` unchanged, no commit-log append, no subscriber fires. The only throw is `CommitInProgressError` on re-entry. |
| `graph.dependencies<T>(node)` | Realises the §11 third-bullet liveness primitive: direct (depth-1) dependency ids of `node` at the current committed time, projected as a frozen `readonly NodeId[]` and lex-sorted for stable iteration. Inputs return `[]`; derivations return the dep-set captured by the most recent compute. Same `getEntry` gate as `read`/`subscribe`/`explain` — throws `UnknownNodeError` for fabricated ids and `NodeDisposedError` for released ones. Ships as a one-shot snapshot rather than a `DerivedNode`-valued handle: the commit pipeline cannot host derived nodes whose value is metadata about the commit pipeline itself without breaking the §5 single-tick invariant (#383). |
| `graph.dependents<T>(node)` | Sister primitive: direct (depth-1) reverse-dep ids of `node` at the current committed time, sourced from the same adjacency map the commit pipeline already maintains for invalidation. Same snapshot semantics, same error surface. The spreadsheet question — *what depends on this cell?* — is answerable through engine primitives instead of by walking every other node's `explain`. |
| `graph.commitMetadataDerived<T>(id, compute)` | Register a derived Behavior whose compute reads commit metadata — `graph.commitLog`, the just-completed commit's stamp, or values produced by other commit-metadata-tagged deriveds — and whose value reflects the *just-completed* commit, not the previous one. Internally a `DerivedNode` like any other; it participates in `read` / `subscribe` / `explain` / `readAt` uniformly with `derived(...)`. The seam this factory adds is scheduling: tagged nodes recompute in Phase F.5 (post-`commitLog` refresh, pre-Phase-G subscriber dispatch), so subscribers see the post-commit value on the same commit that produced it. Ordinary `derived(...)` is unaffected — its Phase D atomicity is the §3 invariant. Closes #452 and unblocks #383's `whyUpdated` / `whyNotUpdated` / `commitLog` derived rewrites. |
| `graph.now` (getter) | Current `GraphTime`. A getter, not a method — the §3 vocabulary needs an external observer to ask "what time is it?" without firing a commit. |

### `RetentionResult<T>` — the discriminated read

`graph.readAt` and `graph.snapshotAt` both return a `RetentionResult<T>`:

```ts
type RetentionResult<T> =
  | { readonly status: 'retained'; readonly value: T; readonly time: GraphTime }
  | { readonly status: 'evicted'; readonly oldestRetainedTime: GraphTime }
```

The `evicted` arm carries the oldest still-retained time so callers can
clamp future requests into the bounded window. The tag check is the
SPEC §9 "make impossible states impossible" pattern — a read for a time
outside the retention window cannot silently return `undefined`.

## Guarantees

- **Atomicity** — `graph.commit` is the only mutation entry, and it
  produces exactly one new `GraphTime`. Outside a commit the graph is
  read-only; there is no fractional time and no "concurrent mutation"
  question because there is no concurrent mutation API. Observers wake
  at most once per commit per observed value change.
- **Glitch-freedom** — a derived value at time `t` is a pure function
  of its inputs at the same time `t`: `derived(t) = f(b₁(t), …, bₙ(t))`.
  There is no intermediate "B updated but C did not" state because
  there is no intermediate time. Diamond observations never see
  interleaved deps regardless of what the scheduler does.
- **Determinism** — `derived(t) = f(b₁(t), …, bₙ(t))` is a function, so
  two implementations either agree or one of them is wrong. A recorded
  commit sequence replayed on a fresh graph produces a byte-identical
  state.
- **O(|affected|) recomputation** — a commit producing N derived
  recomputations runs in O(N) time, not O(graph size). Dirty marking
  and dependency walking are bounded by the affected subgraph. This is
  a correctness criterion phrased as performance, not a benchmark.

## Errors

Every public throw is a typed subclass of `CauslError`:

- `DuplicateNodeError`, `UnknownNodeError`, `NotAnInputNodeError`,
  `CommitInProgressError`, `CycleError`, `StaleTxError`,
  `HydrationSchemaError`, `DisposalDuringCommitError`,
  `NodeDisposedError`, `NodeHasDependentsError`.

Observer exceptions are reported via `options.onObserverError`
(default: `console.error`). They never tear down the engine.

## Testing

```bash
pnpm test:run    # full suite (incl. ≥1000 fast-check trials)
CAUSL_FUZZ_SEED=42 pnpm test:run   # reproduce a failure
```

The 1000-trial floor is the SPEC §15.2 default tier. Routing through the
tier resolver shipped by PR #1097 (issue #1073) lets PR and nightly CI
widen the budget without code changes:

```bash
CAUSL_FUZZ_TIER=pr      pnpm test:run   #   5 000 trials
CAUSL_FUZZ_TIER=nightly pnpm test:run   # 100 000 trials
CAUSL_FUZZ_TRIALS=20000 pnpm test:run   # numeric override
```

Property suites that opt into the tier system go through
`tieredPropertyTrials` (published from `@causl/core/testing`) or
`tieredPropertyOptions` (internal to `packages/core/test/properties/`);
the post-#1153 sweep routed every callsite through one of those wrappers
so the env vars actually fire end-to-end.

## WASM backend

`@causl/core` itself stays on the deterministic TS engine. The
WebAssembly substrate landed by EPIC #680 (Phase-0 + Phase-1 scaffolding,
17 sub-issues merged) is reached through the opt-in `@causl/core/wasm`
subpath:

```ts
import { loadWasmBackend } from '@causl/core/wasm'

const backend = await loadWasmBackend()
```

As of v0.9.0, `loadWasmBackend()` returns a `WasmBackend` whose commit
pipeline routes through an internal TS engine — the SPEC-faithful
reference. The real Rust-driven engine (full port) is deferred to the
post-0.9.0 epic #1133 with documented GO/NO-GO criteria; the public
shape this loader returns does not change when the swap lands.
