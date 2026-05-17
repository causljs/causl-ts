# Causl

> Transactional state for tangled dependency graphs.

---

## Quickstart

The example in [SPEC §10](./SPEC.md#10-the-smallest-worked-example-i-will-support) is the gate for "the engine is real" — two inputs, one derived value, one diamond derivation, one subscriber, two commits, three observed propagations. Everything else in the engine is downstream of getting this right.

```ts
import { createCausl } from '@causl/core'

const graph = createCausl()
const a = graph.input('a', 1)
const b = graph.input('b', 2)
const sum = graph.derived('sum', (get) => get(a) + get(b))
const sumPlusOne = graph.derived('sumPlusOne', (get) => get(sum) + 1)

graph.subscribe(sumPlusOne, (v) => console.log(v))
// 4

graph.commit('bump-a', tx => tx.set(a, 10))
// 13

graph.commit('bump-both', tx => { tx.set(a, 100); tx.set(b, 200) })
// 301  — exactly one notification, not two
```

The four invariants — atomic commit, dependency tracking, dynamic-dep cleanup, glitch-free diamond — fall out of this example. It is pinned as an acceptance test at [`packages/core/test/spec-10-worked-example.test.ts`](./packages/core/test/spec-10-worked-example.test.ts).

---

## Why does this need to exist?

The TypeScript / React ecosystem already has Redux, MobX, Jotai, Recoil, Zustand, Valtio, TanStack Query, XState, and a long tail of hooks-shaped variants. Each one is well engineered for the slice it owns. None of them — **none** — solves the problem causl is built for.

The problem is this: an application whose state is not a tree of values but a **live graph of facts whose derivations cascade**, where:

- A single user action invalidates dozens or hundreds of dependent values.
- Some dependencies change *which* inputs they depend on as state changes (dynamic dependencies).
- Async fetches can return after the dependency they were fetching against has already moved.
- Wrong update ordering produces visible-but-inconsistent intermediate UI states (glitches).
- The user is editing one part of the model while three other parts are recomputing from external feeds, server pushes, and other users' edits.
- A bug that corrupts dependent state is not a render bug — it's data corruption that ships to disk and to other users.

Real systems that look like this: spreadsheets, CMMS, capital-planning tools, BIM-style asset graphs, configuration editors, scheduling/Gantt systems, scenario planning, dashboard composers, and large operational consoles. The author of this library has shipped several. Every one of them ran into the same wall.

If you have ever written this and watched it fire in the wrong order:

```ts
useEffect(() => { setHighlights(deriveFromSelection(selection, plan)); }, [selection, plan])
useEffect(() => { setActiveAttachments(forSelection(selection)); }, [selection])
useEffect(() => { setPlanPings(forHighlights(highlights)); }, [highlights])
```

— or written this and wondered if the result is still relevant:

```ts
const fetched = await fetchAssetStatus(activeAssetId)
setStatus(fetched) // is activeAssetId still the same as when we started?
```

— or watched a 100-row tabular UI re-render the entire grid because a single cell's formula changed — you have hit the wall this library is for.

The existing libraries each handle a *piece*. Redux gives you transactional commits but no dependency tracking. MobX gives you dependency tracking but no transactional commits and no semantic glitch-freedom guarantee. TanStack Query gives you async safety but only for HTTP state. XState gives you statecharts but not a dependency engine. Jotai gives you fine-grained atoms but no story for cross-atom transactions or stale-async protection.

Causl is the library you reach for when *more than one of those concerns is true at the same time*. It is not a replacement for the others; it is a different shape of tool.

---

## What causl does differently

Eight commitments shape the library:

1. **A denotational semantic foundation.** A derived value's meaning is a mathematical function of its inputs at a given commit time: `Behavior a = GraphTime → a`. Glitch-freedom is then a *theorem*, not a scheduler trick. Most JS reactive libraries cannot define what their own values mean precisely enough to disagree with another implementation.
2. **Transactions as the only mutation boundary.** All writes happen inside `graph.commit(intent, tx => …)`. Outside, the graph is read-only. There is no concurrent-write API to misuse.
3. **Automatic dependency tracking with deterministic dynamic-dep cleanup.** A derivation that today reads `assetA` and tomorrow reads `assetB` no longer fires on `assetA` writes — proven by property-based tests, not promised by docs.
4. **One composite statechart for every lifecycle in the system.** Resource fetch, conflict status, transaction phases, and interaction modes share one chart with shared event vocabulary. No more parallel string enums sprinkled across object fields.
5. **Strict layering** between the user's information model, the editor's controller state (selection, drag-in-progress), and the engine's substrate. They live in separate identifier namespaces and separate packages.
6. **Discriminated-union state** everywhere optional fields would otherwise hide state machines. Impossible states cannot be represented; the type checker is the first reviewer.
7. **MVU-shaped application surface.** A typed `Msg` union dispatched through `update : Msg → Model → Commit`. Transactions are the engine room; messages are the front door.
8. **Pre-runtime race detection in CI/CD.** Two Rust-backed CI tools, both shipping today: `causl-check` is the static IR linter — twelve passes against the `CauslModel` IR (cycle, monotonic, glitch-propagation, subscribe-without-dispose, use-after-dispose, cross-graph-read, commit-from-subscribe, plus structural gates). `causl-enumerate` is the SPEC §16.4 bounded state-space enumerator — BFS over the §16.4.1 type surface (10-field `State`, 8-arm `Action`, phased `transition_phased` with per-step `events: Vec<Event>` and `phases: Vec<PhaseStep>`) with `Oracle::check(s, prev, a)` plugged into Tier-1/2/3 `Bound` presets. The Apalache differential runner (`tools/enumerator/diff/`) cross-checks the enumerator's verdicts against TLA+ counterexamples on the EPIC-7 corpus.

The public surface anchored by these commitments — the `Graph` interface — is the canonical seven-method API (`createCausl`, `graph.input`, `graph.derived`, `graph.commit`, `graph.read`, `graph.subscribe`, `graph.explain`) plus the in-flight extensions that have earned a slot by naming an unavoidable engine concept: `subscribeCommits` (a narrow per-fire notification capability for adapters that don't need the full log), `exportModel` (the bridge to the Rust race-detection toolchain — feeds both `causl-check` static IR linting and `causl-enumerate` bounded state-space enumeration), `simulate` (the §5 dry-run API — predict a commit's effect without advancing time, appending to the log, or firing subscribers; observer-invisible by construction), `snapshot`/`hydrate` (single-call SSR transfer that emits a `Commit` with `intent: 'hydrate'` so consumers wake), `readAt`/`snapshotAt` (time-travel devtools and replay-determinism testing, returning a `Retained | Evicted` discriminated union per the bounded retention contract), `commitLog` (realising the "transaction log is a `Behavior [Commit]`" promise as a subscribable derived node), and the `now` getter. Memory hygiene for long-lived processes is the `commitHistoryCap` knob (default 1000; pass `0` or `1` for zero retention) — there is no runtime flush, because firing `commitLog` subscribers outside a commit boundary would violate §5. Every addition is justified one-by-one against the rule "name the unavoidable concept the engine cannot express without it, or take the cost of growing every README and every consumer's mental model." The bar for a fifteenth surface item is the same as the bar for the first eleven.

---

## How causl compares

This table is honest about where the existing libraries are *strictly better* (✓), where they cover the concern in some form (~), and where the concern is missing (✗). The Causl column uses ✓ for what currently ships on `main` and `*` for in-flight or planned future work — see Status below.

| Concern                                                  | Redux + RTK | MobX | Jotai | Recoil | Zustand | Valtio | TanStack Query | XState | Causl |
| -------------------------------------------------------- | :---------: | :--: | :---: | :----: | :-----: | :----: | :------------: | :----: | :------: |
| Transactional commits (atomic write boundary)            |      ✓      |  ~   |   ✗   |   ✗    |    ✗    |   ✗    |       ~        |   ~    |    ✓     |
| Automatic dependency tracking on reads                   |      ✗      |  ✓   |   ✓   |   ✓    |    ✗    |   ~    |       ~        |   ✗    |    ✓     |
| Dynamic dependency cleanup proven correct                |      n/a    |  ~   |   ~   |   ~    |   n/a   |   ~    |      n/a       |  n/a   |    ✓     |
| Glitch-free diamond as a *guarantee* (not best-effort)   |      ✗      |  ~   |   ~   |   ~    |    ✗    |   ✗    |       ✗        |   ✗    |    ✓     |
| Denotational semantic specification                      |      ✗      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ~    |    ✓     |
| Composite statechart for *all* lifecycles                |      ✗      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ✓    |    ✓     |
| Stale-async protection by version, not by abort-only     |      ~      |  ✗   |   ✗   |   ~    |    ✗    |   ✗    |       ✓        |   ✗    |    ✓     |
| Conflict records as first-class queryable state          |      ✗      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ~        |   ✗    |    ✓     |
| Discriminated-union state ("impossible states")          |      ~      |  ✗   |   ~   |   ~    |    ~    |   ✗    |       ~        |   ✓    |    ✓     |
| Strict model / controller / engine layering              |      ~      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ~    |    ✓     |
| MVU-shaped typed Msg dispatch                            |      ✓      |  ✗   |   ✗   |   ✗    |    ~    |   ✗    |       ✗        |   ✓    |    ✓     |
| Pre-runtime race detection in CI/CD (static IR linter + bounded enumerator + Apalache differential) |      ✗      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ~    |    ✓     |
| Live derivation editing in devtools                      |      ~      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ~    |    ✓     |
| Spreadsheet-grade dependency cascades (formulas, ranges) |      ✗      |  ~   |   ~   |   ~    |    ✗    |   ✗    |       ✗        |   ✗    |    ✓     |
| Excellent at: small global state                         |      ~      |  ✓   |   ✓   |   ~    |    ✓    |   ✓    |      n/a       |   ~    |    ~     |
| Excellent at: server cache / fetch dedupe                |      ~      |  ✗   |   ~   |   ~    |    ~    |   ✗    |       ✓        |   ✗    |    ~     |
| Excellent at: hierarchical UI state machines             |      ✗      |  ✗   |   ✗   |   ✗    |    ✗    |   ✗    |       ✗        |   ✓    |    ~     |
| Bundle size (smaller is better)                          |      ~      |  ~   |   ✓   |   ~    |    ✓    |   ✓    |       ~        |   ~    |    ~     |

**Reading the table:**

- **Redux + RTK** is excellent for transactional commits and time-travel debugging. It has no automatic dependency tracking; you write selectors by hand and remember to memoize them. Stale async is partly addressed by RTK Query for HTTP cache only.
- **MobX** is excellent for ergonomic reactive objects. Glitch-free is best-effort; semantic glitch-freedom isn't a stated property. Mutations are not bounded by atomic transactions, so multi-write cascades have observable intermediate states.
- **Jotai** and **Recoil** are excellent for fine-grained atomic state. They lack a transaction boundary, lack a model-checker, and conflict/stale-async stories are application-level concerns.
- **Zustand** and **Valtio** prioritize ergonomics and small bundle size. Neither addresses dependency cascades, conflicts, or async safety as first-class concerns.
- **TanStack Query** is the gold standard for server-state cache. It is not a general state engine; for client-side dependency graphs, you still need one of the others alongside it. Causl's `@causl/sync` is *complementary*, not a replacement.
- **XState** is the closest peer in spirit. It nails statecharts. It is not a dependency-graph engine; cell formulas, range dependencies, and value-derived-from-other-values are not its model. Causl treats the statechart as the *lifecycle layer* and adds the dependency engine on top.

The concerns where causl is currently `~` rather than `✓` (small global state, server cache, hierarchical UI state machines) are honest: for those problems alone, a smaller, more focused library is the right answer. Causl is for the case where you need *several* of those concerns at once and you are tired of stitching libraries together.

---

## When to use causl

Reach for this library when **two or more** of these are true:

- Your state is a graph of facts where one user action cascades through dozens of derived values.
- Your derived values change *what they depend on* as the user navigates.
- You have async fetches whose results may be stale by the time they return.
- You need an audit trail of every state change with a typed intent.
- You need conflict records that survive the transaction that created them — not exceptions, *data*.
- You have spreadsheet-like cells with formula references, or asset hierarchies with reference-based dependencies.
- You want to catch race conditions in CI before they reach production.
- A bug in your state propagation is data corruption, not a UI glitch.

## When **not** to use causl

Reach for something else when:

- Your state is a flat object with maybe twenty fields and no cross-field derivations. Use Zustand or Jotai.
- Your state is mostly cached HTTP responses. Use TanStack Query (or Apollo / Relay if GraphQL).
- Your problem is "one giant form with validation." Use React Hook Form.
- Your problem is "a wizard with five steps and a back button." Use XState directly.
- You want a library you can adopt incrementally without thinking about your model layer. Causl asks you to commit to a layered approach (information model vs editor controllers vs engine substrate). That is a feature for the problems above and overhead for the problems below.

The honest summary: causl is over-engineered for simple apps and the only way to ship the complex ones without losing your mind. Pick the right tool.

---

## What causl is *not*

I want this in writing too, because the spec used to promise too much:

- **Not a spreadsheet engine.** `@causl/formula` is a small package that demonstrates spreadsheet patterns on top of the core. It does not ship VLOOKUP.
- **Not a CRDT.** Multi-user merge semantics belong in a layer above this one.
- **Not a database, message bus, workflow engine, or rules engine.**
- **Not a competitor to Redux/MobX/etc.** for problems they already handle well.
- **Not yet at 1.0.** Phases 1–4 ship on `main`; **v0.9.0 has shipped** (WASM substrate Phase-0/Phase-1 in, Rust engine port deferred — see Status below); APIs are stable but not version-locked.

---

## Status

The full specification lives in [the repo-root specification](./SPEC.md). Phased epics and sub-tasks live as GitHub issues. **Phases 1–4 have shipped on `main`, and v0.9.0 is out.** Phase 1 (semantic core), Phase 2 (React surface + spreadsheet demo), and Phase 3 (resources, conflicts, devtools inspection primitives) landed first; Phase 4 (the CI race-detection toolchain) wrapped via the Phase-8 SPEC compliance audit (umbrella #564 closed). Phase-5 perf experiment umbrella #679 closed 22/22 sub-issues (the scrolling-viewport 654× regression is resolved). Phase-6 WASM substrate epic #680 closed: all 17 Phase-0 + Phase-1 sub-issues are merged, including SPEC §17 commitment 13 (capability-cost residual band 3.0×–8.0×, PR #1024) and commitment 14 (three-tier host matrix `wasmgc-builtins` / `wasmgc-classic` / `serde-json`, PR #1053). Both Rust binaries — `causl-check` (static IR linter) and `causl-enumerate` (bounded state-space enumerator) — run in CI against the spreadsheet and async demos. See `.github/workflows/ci.yml` and `.github/workflows/apalache-diff.yml`.

### Current state (as of v0.9.0)

- **WASM Phase-1 is a TS wrapper, not a Rust engine.** The `WasmBackend` returned by `loadWasmBackend()` is a TS engine wrapped in the FFI shape — the interface and the cross-bridge byte-identity gate are stable, but runtime characteristics match the TS engine (~0% delta vs `backend: 'js'`). The disclosure is repeated at the top of `packages/core/wasm/README.md`. Tracked by #1126.
- **Rust engine port is deferred behind GO/NO-GO criteria.** Post-0.9.0 epic [#1133](https://github.com/iasbuilt/causl/issues/1133) is filed but explicitly deferred — the epic body documents the GO/NO-GO criteria the team will evaluate before opening the implementation track. 15 implementation sub-issues (#1134–#1148) and 7 panel-review sub-issues (#1154–#1160) stay open under the deferral; 4 current-code defect issues #1150–#1153 (bundle ceiling SPEC amendment, NodeId generational disposal, JsonValue bench harness, property-test tier sweep) **merged in v0.9.0 via PRs #1161–#1164** and do not depend on the Rust port landing. `tools/engine-rs-core/` already carries real types — `NodeId` is generational `{ slot: u32, gen: u32 }` (post-#1151), `JsonValue::Object` uses `BTreeMap<SmolStr, _>` (post-#1078; an IndexMap swap is under investigation per #1152's bench harness), and the 7-named-struct cell shape ships from #1077/#1080.
- **Serde Tier-3 bundle ceiling divergence is documented.** §17.6 commitment-14 names a 200 KB raw / 80 KB Brotli target ceiling on the serde bridge; the v0.9.0 artefact ships at 213 KB raw / 66 KB Brotli (Brotli inside cap, raw exceeds by 13 KB). The SPEC text was amended (PR #1161 / issue #1150) to document the divergence; resolution is tied to the Rust engine port and wasm-opt invocation per #1085.

What that means concretely:

- The semantic core (atomicity, glitch-freedom, dynamic-deps, replay determinism, cycle detection) is held by 1000-trial property suites — `packages/core/test/properties/`.
- The React surface (`useCausl`, `useDispatch`, `useCauslFamily`, Suspense + SSR) ships and is tested under StrictMode mount/unmount cycles.
- The spreadsheet demo (`packages/bench/scenarios/spreadsheet/`) runs through the static linter on every CI build; failures block merge.
- The bounded enumerator's full SPEC §16.4.1 type surface is implemented — 10-field `State` backed by `im::*` collections, 8-arm `Action` with every variant wired through `transition()` and `transition_phased()`, `Oracle::check(s, prev, a) -> Vec<RaceClass>` as the canonical surface, `Trace.steps: im::Vector<Step>` for cheap structural-shared clones, `Step.phases` and `Step.events` populated from the per-action phase walker, the `enumerate_with_script(model, bound, script, oracles)` SPEC entry point, and 43 enumerator test binaries' worth of regression coverage.
- The Apalache differential runner (`tools/enumerator/diff/`) cross-checks BFS verdicts against the EPIC-7 TLA+ corpus; `docs/apalache-diff-report.md` is regenerated on every CI run.
- BFS memory ceilings are configurable via `CAUSL_BFS_FRONTIER_CAP` / `CAUSL_BFS_TRACES_CAP` / `CAUSL_BFS_RACES_CAP` env vars; the wave-32 conservative defaults stay until adopter empirical data supports retuning (#646).

Pre-1.0 caveats remain — public APIs may evolve before a tagged release; published-package tooling is a separate epic. The closing section of the specification enumerates the eight team commitments the repo is held against — semantic foundation lands first; the composite statechart is drawn before conflict and resource code is written; the model/controller/engine layering is enforced at the package boundary; every discriminated union carries an exhaustiveness check; the race-class catalogue is kept current; the worked example is the gate for "the engine is real"; no enum tags ship whose transitions are unspecified; and the Rust race-detection toolchain (`causl-check` + `causl-enumerate`) ships as a required CI gate. CONTRIBUTING.md documents how each commitment is enforced.

---

## Packages

| Path                          | Package                       | Role                                                                                  |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/`              | `@causl/core`              | Engine — Behaviors, derivations, transactions, snapshot/hydrate, retention, explain   |
| `packages/react/`             | `@causl/react`             | React bindings — `useCausl`, `useDispatch`, `useCauslFamily`, MVU runner, SSR   |
| `packages/formula/`           | `@causl/formula`           | Spreadsheet patterns *on top of* the core — formulas, ranges, cycles                  |
| `packages/sync/`              | `@causl/sync`              | Async resources + conflict registry as composed statecharts                           |
| `packages/devtools/`          | `@causl/devtools`          | Inspection primitives (explain materialisation, liveDerivation, snapshot, statechart) |
| `packages/devtools-bridge/`   | `@causl/devtools-bridge`   | Redux DevTools Extension protocol bridge (zero-cost when absent)                      |
| `packages/persistence/`       | `@causl/persistence`       | Persisted-input adapter with structured `PersistenceError` reporting                  |
| `packages/checker/`           | `@causl/checker`           | npm wrapper for `causl-check` (Rust-backed static IR linter — twelve passes against the IR)               |
| `packages/bench/`             | `@causl/bench`             | Benchmarks — Jotai / RTK / MobX comparisons across the canonical scenario taxonomy    |
| `packages/migration-check/`   | `@causl/migration-check`   | Migration drift detector — flags unmigrated Jotai/MobX/Redux patterns in adopters     |

Internal-only `packages/core/testing/` (published as `@causl/core-testing-internal`) provides shared property-test seam helpers.

See each package's `README.md` for build and run instructions where they exist.

---

## Tools

Build infrastructure, Rust crates, CI gates, and release tooling live
under [`tools/`](./tools/). Brief role descriptions below; the
authoritative documentation lives in each tool's own `README.md`.

### Release

| Path | Purpose | Detailed docs |
| --- | --- | --- |
| [`tools/release/`](./tools/release/) | `release.py` — bundles the minimum viable per-package npm tree at `RELEASE_VERSION` for the TypeScript-only path. Output ships on the `release` branch. | [`tools/release/README.md`](./tools/release/README.md) |

### Rust engine + WASM bridges

| Path | Purpose | Detailed docs |
| --- | --- | --- |
| [`tools/engine-rs-core/`](./tools/engine-rs-core/) | Pure-algorithm core (`no_std + alloc`). SPEC §16.4.1 `State` / `Action` / `Event` / `Commit` types + `transition_phased`. | [`tools/engine-rs-core/README.md`](./tools/engine-rs-core/README.md) |
| [`tools/engine-rs-bridge-serde/`](./tools/engine-rs-bridge-serde/) | Universal-fallback `serde-wasm-bindgen` bridge cdylib. | — |
| [`tools/engine-rs-bridge-gc/`](./tools/engine-rs-bridge-gc/) | WasmGC + `wasm:js-string` bridge cdylib (two artefacts: `js-string-builtins`, `classic-strings`). | — |
| [`tools/engine-rs-core-bench/`](./tools/engine-rs-core-bench/) | Criterion microbenches against the pure-algorithm core. | — |
| [`tools/engine-rs-port-bench/`](./tools/engine-rs-port-bench/) | Cross-port perf comparison harness. | [`tools/engine-rs-port-bench/README.md`](./tools/engine-rs-port-bench/README.md) |
| [`tools/wasm-build/`](./tools/wasm-build/) | `build.mjs` — drives `wasm-pack` + external binaryen `wasm-opt -Oz` for all bridge × target combinations; enforces SPEC §17.6 bundle-size caps. | [`tools/wasm-build/README.md`](./tools/wasm-build/README.md) |

### Static checking + enumeration

| Path | Purpose | Detailed docs |
| --- | --- | --- |
| [`tools/checker/`](./tools/checker/) | `causl-check` Rust crate — twelve-pass static IR linter (cycle, monotonic, glitch-propagation, use-after-dispose, cross-graph-read, commit-from-subscribe, …). Per-site `// @causl-allow:RuleId — reason: ...` magic-comment suppressions via the `--source <path>` flag; `--replay <report>` is the §16A.2 verdict-determinism gate. | [`tools/checker/README.md`](./tools/checker/README.md) |
| [`tools/enumerator/`](./tools/enumerator/) | `causl-enumerate` — SPEC §16.4 bounded state-space enumerator. Tier-1/2/3 `Bound` presets cap exploration; Node worker-pool RPC sandboxes compute bodies (`Date.now` / `Math.random` / `crypto.randomUUID` / `performance.now`) with a 1% double-check sampler. | — |
| [`tools/apalache-diff/`](./tools/apalache-diff/) | Apalache differential runner against the EPIC-7 TLA+ corpus. | — |

### Bench, telemetry, audit, lint

| Path | Purpose | Detailed docs |
| --- | --- | --- |
| [`tools/bench/`](./tools/bench/) | Python launcher + reproducer for the cross-library benchmark suite in `packages/bench/`; pinned-Docker runs with a typed exit-code contract. | — |
| [`tools/drift/`](./tools/drift/) | Drift telemetry helpers. | — |
| [`tools/audit/`](./tools/audit/) | Audit + governance tooling. | — |
| [`tools/eslint-plugin-causl/`](./tools/eslint-plugin-causl/) | ESLint plugin for causl-aware lint rules. | — |
| [`tools/lint/`](./tools/lint/) | Project lint helpers (orchestrates `eslint-plugin-causl`, prettier, custom passes). | — |
| [`tools/lint-fixtures/`](./tools/lint-fixtures/) | Fixture corpus for the lint rules. | — |
| [`tools/docs-postprocess/`](./tools/docs-postprocess/) | TypeDoc/Markdown post-processing for the docs pipeline. | — |
| [`tools/causl-org-srv/`](./tools/causl-org-srv/) | Static-site server for the `causl-org/` demos. | [`tools/causl-org-srv/README.md`](./tools/causl-org-srv/README.md) |

Tools without a per-tool `README.md` document themselves through the
module-level header comments in their primary entry file (`build.mjs`,
`src/lib.rs`, `release.py`, etc.). When a tool grows past that scale
its dedicated `README.md` lands alongside.

---

## Development setup

### Prerequisites

| Tool        | Version          | How to install                                |
| ----------- | ---------------- | --------------------------------------------- |
| Node.js     | 24.x (LTS Krypton) | Use [`nvm`](https://github.com/nvm-sh/nvm) — `nvm install` reads `.nvmrc` |
| pnpm        | 10.x             | `corepack enable` (Node ships Corepack), or `npm i -g pnpm@10` |
| Rust        | stable           | [`rustup`](https://rustup.rs) — only required to work on `tools/checker/` |

The repository pins Node via `.nvmrc` and pnpm via `packageManager` in the root `package.json`. With `nvm` and Corepack on, switching into the directory and running `pnpm install` is enough.

```sh
# one-time setup
nvm install        # installs Node 24 from .nvmrc
nvm use            # activates it for this shell
corepack enable    # makes the pinned pnpm available

# install workspace dependencies
pnpm install
```

### Common commands

```sh
pnpm validate       # typecheck + build + test (run before committing)
pnpm typecheck      # tsc --noEmit across packages
pnpm build          # tsup builds for every package
pnpm test           # vitest in watch mode
pnpm test:run       # vitest --run (single pass)
pnpm lint           # eslint across packages
```

A Husky pre-commit hook runs `pnpm typecheck` and `pnpm test:run` against staged code; it picks up the same toolchain the CI workflows use.

---

## Try it live

The demos ship as static HTML pages under [`causl-org/`](./causl-org) — no build step, no framework install. Both load `@causl/core` at runtime from esm.sh so they exercise exactly what an adopter installs.

- **[`causl-org/playground/`](./causl-org/playground/index.html)** (`https://causl.org/playground`) — the Quickstart example above in a Monaco editor wired to a live `@causl/core` graph. Edit `derived`, watch the value update.
- **[`causl-org/spreadsheet/`](./causl-org/spreadsheet/index.html)** (`https://causl.org/spreadsheet`) — the Phase 3 100-cell diamond demo. Type into column A; columns B/C/D and `E1` recompute through the engine. Supports live `replaceMany` formula edits, `whyUpdated` introspection, and a commit log. Same fixture as the dropped-frame Playwright gate in CI.

Both demos are React 19 apps rendered via `createRoot`; React is loaded from esm.sh alongside the causl packages.

---

## License

TBD.
