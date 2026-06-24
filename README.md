# Causl

> Transactional state for tangled dependency graphs.

> **This is the open-source, pure-TypeScript reference engine — the SPEC §12 conformance floor.**
> For the production / enterprise path the engine is the Rust→WASM core
> ([`causljs/causl-wasm`](https://github.com/causljs/causl-wasm)), reached through the thin TS API
> ([`causljs/causl-client`](https://github.com/causljs/causl-client)), where `rust-ssot` is the
> unconditional default. Use **this** package for the OSS pure-TypeScript path, or as the §12
> conformance reference. The two are conformant implementations of the same §12 public surface; they
> differ only in substrate. Note that within *this* repo the WASM backend is a TS-engine wrapper
> (see [WASM Phase-1 state](#current-state-post-v090-in-this-ts-only-fork) below) — the real Rust
> engine lives in `causljs/causl-wasm`.

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
- **Not yet at 1.0.** Phases 1–4 ship on `main`; **v0.9.0 has shipped** (WASM substrate Phase-0/Phase-1 in; the real Rust engine port is deferred *in this fork* — it shipped org-wide in `causljs/causl-wasm`, see Status below); APIs are stable but not version-locked.

---

## Status

The full specification lives in [the repo-root specification](./SPEC.md). Phased epics and sub-tasks live as GitHub issues. **Phases 1–4 have shipped on `main`, and v0.9.0 is out.** Phase 1 (semantic core), Phase 2 (React surface + spreadsheet demo), and Phase 3 (resources, conflicts, devtools inspection primitives) landed first; Phase 4 (the CI race-detection toolchain) wrapped via the Phase-8 SPEC compliance audit (umbrella #564 closed). Phase-5 perf experiment umbrella #679 closed 22/22 sub-issues (the scrolling-viewport 654× regression is resolved). Phase-6 WASM substrate epic #680 closed: all 17 Phase-0 + Phase-1 sub-issues are merged, including SPEC §17 commitment 13 (capability-cost residual band 3.0×–8.0×, PR #1024) and commitment 14 (three-tier host matrix `wasmgc-builtins` / `wasmgc-classic` / `serde-json`, PR #1053). Both Rust binaries — `causl-check` (static IR linter) and `causl-enumerate` (bounded state-space enumerator) — run in CI against the spreadsheet and async demos. See `.github/workflows/ci.yml` and `.github/workflows/apalache-diff.yml`.

### Current state (post v0.9.0, in this TS-only fork)

`causljs/causl-ts` is the public, pure-TypeScript reference engine that publishes the npm packages. `causljs` is a multi-repo org, not a monorepo: the production Rust→WASM engine (`engine-rs-core` + `engine-rs-bridge`, plus the Python build/package tooling) lives in [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm); the `causl-check` static IR linter lives in [`causljs/causl-check`](https://github.com/causljs/causl-check); the dual-engine differential reference (the TS floor + the cross-backend byte-identity oracle + the benchmark suite) lives in [`causljs/causl-ts-wasm-engine`](https://github.com/causljs/causl-ts-wasm-engine). Within **this** repo:

- **WASM Phase-1 is a TS wrapper, not a Rust engine.** The `WasmBackend` returned by `loadWasmBackend()` is a TS engine wrapped in the FFI shape — the bridge interface and the cross-bridge byte-identity contract are stable, but runtime characteristics match the TS engine. `DEFAULT_WASM_ENGINE_MODE` is `'js-ssot'` here (verified in `packages/core/wasm/index.ts`); the real Rust engine and the `rust-ssot` production default live in `causljs/causl-wasm` (reached via `causljs/causl-client`). The disclosure is repeated at the top of `packages/core/wasm/README.md`.
- **Bundle-budget overage tracked in issue #22.** The post-v0.9.0 size-limit cells were re-tuned in PR #23 (createCausl-only ratcheted from 15 KB to 16 KB to absorb the `invariant` option from PR #2 / issue #1); the `@causl/core/wasm` cell still sits ~2.5 KB over the 13 KB ceiling and is the only known-red gate. PR #21 dropped the dangling bench-fixture cells that were producing six consecutive red CI runs against unrelated PRs.
- **Pre-commit ↔ CI parity landed in PR #25.** The full check union — typecheck, build, lint, size, vendor-manifest — now runs in `.husky/pre-commit`; the bundler-interop matrix moved to `.husky/pre-push`. See the *Pre-commit / pre-push hooks* subsection above.

What that means concretely for adopters:

- The semantic core (atomicity, glitch-freedom, dynamic-deps, replay determinism, cycle detection) is held by 1000-trial property suites under `packages/core/test/properties/`.
- The React surface (`useCausl`, `useDispatch`, `useCauslFamily`, Suspense + SSR) ships and is tested under StrictMode mount/unmount cycles; the `idle`-resource Suspense contract was locked in by PR #17 / issue #7.
- `@causl/core` 0.3.1 carries the runtime `invariant` callback on `graph.input(id, initial, { invariant })` added in PR #2 / issue #1.
- The `causl/no-graph-upcast` ESLint rule (PR #15 / issue #9) is the third gate in the S-3 layering enforcement chain — `as Graph` upcasts that erase capability narrowing are now lint errors, not review notes.
- The cross-backend determinism property test (`packages/core/test/properties/cross-backend-determinism.property.test.ts`) was refreshed by PR #16 / issue #6 to drop the stale Phase-1 TODO and wire World-pairing through the Graph facade.
- The Rust `causl-check` static IR linter ships out of [`causljs/causl-check`](https://github.com/causljs/causl-check); the bounded `causl-enumerate` enumerator and the apalache differential corpus live alongside the Rust engine work. This repo's `tools/apalache-diff/` is the TLA+ differential surface that consumes those enumerator verdicts.

Pre-1.0 caveats remain — public APIs may evolve before a tagged release; published-package tooling is a separate epic. The closing section of the specification enumerates the eight team commitments the repo is held against — semantic foundation lands first; the composite statechart is drawn before conflict and resource code is written; the model/controller/engine layering is enforced at the package boundary; every discriminated union carries an exhaustiveness check; the race-class catalogue is kept current; the worked example is the gate for "the engine is real"; no enum tags ship whose transitions are unspecified; and the Rust race-detection toolchain (`causl-check` + `causl-enumerate`) ships as a required CI gate. CONTRIBUTING.md documents how each commitment is enforced.

---

## Packages

| Path                          | Package                       | Version | Role                                                                                  |
| ----------------------------- | ----------------------------- | :-----: | ------------------------------------------------------------------------------------- |
| `packages/core/`              | `@causl/core`                 | `0.3.1` | Engine — Behaviors, derivations, transactions, snapshot/hydrate, retention, explain. Also exposes the opt-in `/wasm` subpath. |
| `packages/react/`             | `@causl/react`                | `0.2.0` | React bindings — `useCausl`, `useDispatch`, `useCauslFamily`, MVU runner, SSR.        |
| `packages/sync/`              | `@causl/sync`                 | `0.2.0` | Async resources + conflict registry as composed statecharts.                          |
| `packages/formula/`           | `@causl/formula`              | `0.2.0` | Spreadsheet patterns *on top of* the core — formulas, ranges, cycles.                 |
| `packages/persistence/`       | `@causl/persistence`          | `0.1.0` | Persisted-input adapter with structured `PersistenceError` reporting.                 |
| `packages/devtools/`          | `@causl/devtools`             | `0.1.0` | Inspection primitives (explain materialisation, liveDerivation, snapshot, statechart). |
| `packages/devtools-bridge/`   | `@causl/devtools-bridge`      | `0.1.0` | Redux DevTools Extension protocol bridge (zero-cost when absent).                     |
| `packages/migration-check/`   | `@causl/migration-check`      | `0.1.0` | Migration drift detector — flags unmigrated Jotai/MobX/Redux patterns in adopters.    |
| `packages/hypothesis/`        | `@causl/hypothesis`           | `0.1.0` | Temporal-logic hypothesis combinators + shrinkers over enumerator traces. The *authoring/evaluation* half of the Apalache differential surface; the *runner* is `tools/apalache-diff/`. |

`@causl/core` carries the major-zero `0.3.x` line (currently `0.3.1`) because it has absorbed the post-0.2.0 race-class catalogue refinements that the adapter packages have not yet had to chase. The adapter and tooling tier sits at `^0.2.0` / `^0.1.0` until those packages have their own breaking changes to ship.

> **On version numbers.** "v0.9.0" is the repo-level milestone tag (the WASM-substrate Phase-0/Phase-1 line); the per-package npm versions are independent and lower (`@causl/core` `0.3.1`, adapters `^0.2.0`/`^0.1.0`). The committed `release/` bundle is an older cut pinned at `0.2.0` — see the staleness note in [`release/README.md`](./release/README.md) and regenerate it before shipping from that tree. The root `package.json` `version` field (`0.2.0`) is the release-bundle baseline, not the published `@causl/core` version.

Internal-only workspace siblings:

- `packages/core/testing/` — published as `@causl/core-testing-internal`; shared property-test seam helpers.
- `packages/sync-testing-internal/` — `@causl/sync-testing-internal` (currently `0.0.0`); fc.Arbitrary generators for the resource/conflict event vocabulary, consumed by the sync property suites.

The production Rust→WASM engine lives **out of this repo** in [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm) (`engine-rs-core` + `engine-rs-bridge`), where `rust-ssot` is the unconditional production default and is consumed through the thin TS API in [`causljs/causl-client`](https://github.com/causljs/causl-client). The [`causljs/causl-ts-wasm-engine`](https://github.com/causljs/causl-ts-wasm-engine) fork is the dual-engine differential reference — it pairs this TS floor against the real Rust engine in the cross-backend byte-identity oracle and hosts the benchmark suite. The interface and bridge contracts defined in `packages/core/src/bridge.ts` / `packages/core/wasm/index.ts` are the stable surface those repos honour.

See each package's `README.md` for build and run instructions where they exist.

---

## Tools

Build infrastructure, CI gates, lint rules, and release tooling live
under [`tools/`](./tools/). Brief role descriptions below; the
authoritative documentation lives in each tool's own `README.md`
where one ships, otherwise in the module-level header comments.

| Path | Purpose |
| --- | --- |
| [`tools/release/`](./tools/release/) | `release.py` — bundles the minimum-viable per-package npm tree at `RELEASE_VERSION` for the TypeScript-only path. Output ships on the `release` branch. |
| [`tools/apalache-diff/`](./tools/apalache-diff/) | Apalache differential runner that cross-checks the bounded enumerator against the EPIC-7 TLA+ corpus. The Rust `causl-check` linter lives in [`causljs/causl-check`](https://github.com/causljs/causl-check) and the bounded enumerator alongside the Rust engine work; this directory holds the TS-side harness that consumes their verdicts. |
| [`tools/audit/`](./tools/audit/) | Governance / commitment-audit tooling (`pnpm audit:commitments`). |
| [`tools/drift/`](./tools/drift/) | Drift-telemetry helpers consumed by `@causl/migration-check`. |
| [`tools/eslint-plugin-causl/`](./tools/eslint-plugin-causl/) | ESLint plugin for causl-aware lint rules (e.g. `causl/no-graph-upcast` from PR #15 / issue #9). |
| [`tools/lint/`](./tools/lint/) | Project lint helpers (orchestrates `eslint-plugin-causl`, prettier, custom passes). |
| [`tools/lint-fixtures/`](./tools/lint-fixtures/) | Fixture corpus for the lint rules. |
| [`tools/docs-postprocess/`](./tools/docs-postprocess/) | TypeDoc / Markdown post-processing for the docs pipeline. |
| [`tools/migrate-ir-2-to-3.ts`](./tools/migrate-ir-2-to-3.ts) | One-shot CauslModel IR schema-3 migration codemod. |

The Rust engine and its WASM build/package tooling live in [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm); the `causl-check` static IR linter lives in [`causljs/causl-check`](https://github.com/causljs/causl-check); the dual-engine differential reference + benchmarks live in the [`causljs/causl-ts-wasm-engine`](https://github.com/causljs/causl-ts-wasm-engine) fork. This repo (`causljs/causl-ts`) carries the TypeScript packages, the per-PR bundle-budget gate, the TLA+ differential runner, and the lint plugin.

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
pnpm install        # install workspace deps
pnpm build          # tsup builds for every package
pnpm test:run       # vitest --run across every workspace (single pass)
pnpm typecheck      # tsc --noEmit across packages
pnpm lint           # eslint across packages
pnpm size           # size-limit gate (uses the dist/ from `pnpm build`)
pnpm test           # vitest in watch mode (interactive)
pnpm validate       # typecheck + build + test:run + docs:test (pre-publish)
```

Smoke flow for a fresh clone:

```sh
pnpm install && pnpm build && pnpm test:run
```

### Pre-commit / pre-push hooks

Husky is wired up via the root `prepare` script (`husky` install runs on `pnpm install`). PR [#25](https://github.com/causljs/causl-ts/pull/25) replaced the previous "lint-staged only" hook with the **full CI-check union** so passing locally implies passing CI:

- **`.husky/pre-commit`** runs, in order: `lint-staged` (eslint --fix on staged TS) → `pnpm typecheck` → `pnpm build` → `pnpm lint` → `pnpm size` → `scripts/check-vendor-manifest.sh` (paths-filtered, fires only when vendored bytes are staged).
- **`.husky/pre-push`** runs the `e2e/bundler-interop/` matrix (`webpack5-app`, `vite5-app`, `esbuild-app`) — `npm install --no-save` → `npm run build` → `npm run verify`. Mirrors `wasm.yml`'s `bundler-interop` CI job; the gate is the bundle-no-wasm-leak invariant from issue #689.

Escape hatches: `SKIP_PRECOMMIT=1` / `SKIP_PREPUSH=1` env vars, or the standard `git commit --no-verify` / `git push --no-verify`. The `pnpm size` step is known-red on `main` until issue [#22](https://github.com/causljs/causl-ts/issues/22) closes — see the bundle-budget paragraph below.

### Bundle-budget status (post PR #21 + #23)

The `size-limit` cells in the root `package.json` gate dist-bundle ceilings on every PR. Current band:

- `@causl/core` (full import) ≤ **20 KB**.
- `@causl/core` (createCausl-only) ≤ **16 KB** — bumped 1 KB in PR [#23](https://github.com/causljs/causl-ts/pull/23) to absorb the post-`invariant` overage.
- `@causl/core/wasm` ≤ **13 KB** — still over per issue [#22](https://github.com/causljs/causl-ts/issues/22); the gate stays in the hook so the moment the cell goes green new drift starts being caught.
- WASM artefact ceilings (per-bridge, raw + Brotli) are documented in the root `package.json`'s `//size-limit-wasm` comment block. The real `.wasm` artefacts are produced by the Python build tooling in [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm) (`scripts/build_wasm.py` / `scripts/package_wasm.py`); the artefacts committed in this repo are 8-byte stubs (see `packages/core/wasm-pkg/README.md`).

PR [#21](https://github.com/causljs/causl-ts/pull/21) dropped the dangling bench-fixture size-limit cells (closing issue [#19](https://github.com/causljs/causl-ts/issues/19)); PR [#14](https://github.com/causljs/causl-ts/pull/14) re-enabled the per-PR bundle-budget comment workflow.

---

## Try it live

The interactive playground + spreadsheet demos that load `@causl/core` from esm.sh ship out of the docs-site repo [`causljs/causl-org`](https://github.com/causljs/causl-org) (the static-site tree behind `https://causl.org`). The `@causl/core` build this repo publishes is exactly what those demos pull at runtime, so a local `pnpm build` is enough to dogfood adopter-shaped imports.

---

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 Roman Goldmann <roman@iasbuilt.com>.
