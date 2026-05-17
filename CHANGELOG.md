# Changelog

All notable changes to this repository land here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/) once the
first stable release ships.

## [0.2.0] - 2026-05-16

First versioned release of the `@causl/*` TypeScript-only bundle.
Ships as a GitHub Release (`v0.2.0`) with four `.tgz` tarball assets
attached, plus the unminified per-package tree committed under
`release/` at this tag for audit traceability.

### Added

- `tools/release/release.py` — Python script that bundles the minimum
  viable per-package npm tree, narrows `package.json#exports` to the
  main barrel, resolves `workspace:*` cross-deps to `^0.2.0`, strips
  source maps + map-URL trailers, and optionally re-minifies each
  emitted `.js` via `esbuild --minify` (`--minify` flag) and emits a
  `.tgz` per package (`--tarballs` flag).
- `tools/release/README.md` — detailed build-pipeline docs.
- `## Tools` section in the root `README.md` — repo-wide tool
  inventory with one-line role descriptions linking to per-tool
  READMEs.
- `release/` tree at the v0.2.0 tag — committed un-minified copy
  matching the source `packages/*/dist/`. Lets reviewers diff the
  shipped tarballs against a known reference.
- `"sideEffects": false` on `@causl/core`, `@causl/sync`,
  `@causl/react`, `@causl/formula` package.json files. Enables
  bundler tree-shaking; downstream apps that import a subset of the
  barrel pay only for what they use.
- Root `.gitignore` carve-out for `release/packages/*/dist/` so script
  re-runs can re-stage cleanly with plain `git add release/` (the
  global `dist/` rule otherwise blocks parent-excluded re-inclusion).

### Changed

- Source `packages/{core,sync,react,formula}/package.json` versions
  bumped from `0.0.0` / `0.1.0` → `0.2.0`. Root `package.json`
  bumped from `0.0.0` → `0.2.0`. Source-of-truth versions now align
  with the published v0.2.0 release.

### Release contents

| Package | Runtime (brotli q11, minified) | + Types | npm tarball |
| --- | ---: | ---: | ---: |
| `@causl/core` | **14.36 KiB** | 47.50 KiB | 76 KiB |
| `@causl/sync` | 2.40 KiB | 2.38 KiB | 9 KiB |
| `@causl/react` | 1.75 KiB | 12.73 KiB | 20 KiB |
| `@causl/formula` | 2.96 KiB | 9.22 KiB | 16 KiB |
| **TOTAL** | **21.46 KiB** | 71.83 KiB | 121 KiB |

### Excluded from v0.2.0

- All WASM artefacts (`@causl/core/wasm` subpath; the `gc-builtins`,
  `gc-classic`, and `serde` bridge cdylibs under
  `packages/core/wasm-pkg/`). Tracked separately under the
  Zero-boundary WASM engine epic (#1558).
- `@causl/checker` (+ native Linux/macOS/Windows x64/arm64 binary
  shards).
- `@causl/devtools`, `@causl/devtools-bridge`, `@causl/hypothesis`,
  `@causl/migration-check`, `@causl/persistence`,
  `@causl/sync-testing-internal`.
- The `./internal` and `./testing` subpath exports on `@causl/core`;
  the `./resource` and `./conflict` exports on `@causl/sync`.

Adopters who need any of the above install from the source workspace.

## [Unreleased]

### Known limitations

- **`@causl/core/wasm` Phase-1 is a TS wrapper, NOT a Rust engine
  (#1126).** The `WasmBackend` returned by `loadWasmBackend()` in
  0.9.0 is a TS engine wrapped in the FFI shape — the interface is
  stable and the cross-bridge byte-identity gate is enforced (#1071),
  but the runtime characteristics are equivalent to the TS engine.
  Adopters who pin `backend: 'wasm'` today should expect ~0% runtime
  delta vs `backend: 'js'`; the `backend: 'auto'` path stays on TS
  until `commitTimings` cross threshold, at which point the same TS
  engine semantics run inside the FFI wrapper. Real Rust engine port
  is tracked in WASM epic #680 (closed) and follow-up issues
  #1077 / #1078 / #1079 / #1080 (all merged — type shape ready) plus
  a future "transition body port" track. The wrapper-not-Rust state
  is also called out at the top of `packages/core/wasm/README.md`
  above the host-tier table so adopters see the disclosure before
  reading the host-compatibility matrix. If you need the structural
  Rust perf win, wait for the post-0.9.0 "real engine" release.

### Breaking changes (this release)

- **`docs-site/` removed (#666, breaking).** The Vue/VitePress doc site
  (`docs-site/`) is deleted. Adopters who bookmarked `docs-site`-served
  URLs (playground, spreadsheet, rendered SPEC docs) need to update
  bookmarks:
  - `/playground` → `causl-org/playground/index.html` (same URL on
    causl.org once deployed)
  - `/spreadsheet` → `causl-org/spreadsheet/index.html`
  - `/docs/*` → the `docs/` directory in the repo root; rendered SPEC
    docs are no longer hosted by the static site package.

  `pnpm-workspace.yaml` no longer includes the `docs-site` entry, so
  `pnpm install` no longer installs Vue, Vitepress, or the Mermaid plugin.

### Added

- **`JsonValue` tagged union in `engine-rs-core` (#1078).** The SPEC
  §16.4.1 / WASM epic #680 canonical six-arm closed enum
  (`Null` / `Bool(bool)` / `Number(f64)` / `String(SmolStr)` /
  `Array(Vec<Self>)` / `Object(BTreeMap<SmolStr, Self>)`) replaces the
  pre-#1078 `serde_json::Value` alias that PR #1076 (Sub-A) deferred
  pending the cross-backend determinism gate (#1065). `Object` uses
  `BTreeMap` so field iteration is sorted-by-key — the SPEC §15.1
  replay-determinism invariant. `String(SmolStr)` provides
  small-string optimisation (up to 23 bytes inline, no heap traffic)
  for the hot transition / commit path. Custom Serialize/Deserialize
  impls preserve the integer-vs-float wire discrimination
  (`1` round-trips as `1`, not `1.0`) and emit `null` for non-finite
  `f64` (`NaN`, `±Inf`) matching JS `JSON.stringify` rules. The
  cross-backend determinism gate at
  `packages/core/test/properties/cross-backend-determinism.property.test.ts`
  passes 5 canonical seeds × 1000 trials × 2 backends = 10 000
  trial-comparisons with **zero byte differences** before AND after
  the swap. `From<serde_json::Value>` and `From<JsonValue>` interop
  impls keep call-site migration mechanical (`.into()` on the
  existing `serde_json::json!` literals). `Action::DispatchMsg::payload`,
  `ResolutionKind::Settle::value`, and the `feature = "future"`-gated
  `ConflictResolutionRecord` / `ResourceState<T>` / `ConflictEvent` /
  `ResourceEvent` value slots all carry the new type.
- **WASM-backed engine EPIC #680 — Phase-1 closeout (#1063, closes
  #1061, #689, #680).** The keystone substrate work is in. Every
  TS-side scaffolding piece (BackendEngine interface #681, pluggable
  Bridge #691, lazy-load loader #684, cross-backend determinism gate
  #685, migration round-trip #687, bundle hygiene #689, host-tier
  matrix #690, auto-adapt heuristic #686, React typed-array hook
  #688, statechart reducers #698, formula IR #697) plus Phase-1's
  engine work (engine-rs-core types #1067 Sub-A, serde bridge
  wiring #1062 Sub-B, GC bridge wiring #1064 Sub-C, real
  `BackendEngine` loader + cross-backend gate firing #1065 Sub-D)
  ships in a single integrated stack. Sub-E closeout adds:
    1. **Full canonical-seed parity at 10 000 trials.** 5 canonical
       seeds × 1000 trials × 2 backends = 10 000 cross-backend
       determinism trial-comparisons, 0 byte differences. The new
       `Sub-E closeout` describe block in
       `packages/core/test/properties/cross-backend-determinism.property.test.ts`
       runs each canonical seed through 1000 hermetic
       (graphName-distinct) JS/WASM engine pairs and asserts
       byte-equal IR after every command. `transition_js(s, a) ==
       transition_wasm(s, a)` byte-identical on every cell.
    2. **Per-bridge size-limit cells activated.** Three new entries
       in `package.json#size-limit` gate the wasm-pkg artefacts:
       `serde-json` ≤ 200 KB raw, `gc-builtins` ≤ 110 KB raw,
       `gc-classic` ≤ 120 KB raw. 8-byte WASM-preamble stubs ship
       at `packages/core/wasm-pkg/<bridge>/engine_rs_bg.wasm` so
       the cells gate today; `pnpm wasm:build` replaces the stubs
       with real artefacts and the caps bite from that point on.
       Closes the residual scope of #689.
    3. **Phase-1 perf measurement captured.** New
       `docs/wasm/phase-1-perf.md` reports pre vs post-Phase-1
       numbers on `causl × equality-cutoff × 10000` plus the 9
       microbench cells, anchored against the Eich/Horwat panel
       projection (`~0.7 ms addressable → ~3.0× post-WASM gap`)
       with honest framing: the TS-side wave (#669 / #907 / #905 /
       #1036) closed most of the EPIC-opening 1.24 ms gap before a
       single byte of WASM shipped, the Phase-1 wrapper is
       semantic-preserving (~0% delta vs TS-only — the correct
       result), and the real perf win lands when a Rust-driven
       commit pipeline replaces the wrapper. SPEC §17 commitment
       13's 3.0×–8.0× band stays the contract; "projection held"
       on commitment 14's host-tier matrix.
    4. **Epic #680 closed.** All sub-tasks (#681, #682, #683, #684,
       #685, #686, #687, #688, #689, #690, #691, #692, #693, #694,
       #695, #696, #697, #698, #1006, #1061, #1062, #1063, #1064,
       #1065, #1067) are MERGED. The WASM-backed engine substrate
       is shipped; the next perf wave that swaps the wrapper for a
       Rust commit pipeline opens under a fresh EPIC.

- **SPEC §17 commitment 14 + WASM adoption guide (#690).** Adds the
  fourteenth SPEC §17 commitment (host-tier substrate compatibility,
  DESIGN-DISCIPLINE) and the SPEC §17.6 elaboration: a three-tier
  host-substrate matrix (`wasmgc-builtins` for Chromium 131+ /
  Firefox 130+ / Node 22.6+; `wasmgc-classic` for Safari 18.2+;
  `serde-json` universal baseline) plus a documented fall-through
  fallback to the TS engine via `WasmBackendUnavailableError`. No
  supported host is silently stranded. Adds the adopter-facing guide
  `docs/wasm-adoption-guide.md` covering preload + Subresource
  Integrity (SRI) posture, dynamic-import patterns for vendoring the
  WASM artefacts from a self-hosted CDN, the five structured `code`
  values on `WasmBackendUnavailableError`, and short-circuit paths
  for SSR / `backend: 'js'` callers. Cross-links the new commitment
  from §17.5's closing-paragraph forecast and appends the row to the
  SPEC §19 amendment trail. Documentation only — no behavioural
  change; the loader skeleton from PR #1031 already implements the
  contract §17.6 names.

- **React playground (`causl-org/playground/`) (#666).** Ports the
  Vue/Monaco REPL to a React 19 `createRoot` app embedded in a static
  HTML page under `causl-org/`. Loads Monaco `0.52.2` and `@causl/core`
  from CDN at runtime — no build step. The SPEC §10 worked example is
  pre-loaded; supports run, reset, and a console shim that captures
  `console.log` / `error` / `warn` to the output pane.

- **React spreadsheet demo (`causl-org/spreadsheet/`) (#666).** Ports
  the Vue §16 Phase 3 100-cell diamond demo to React 19. Loads
  `@causl/core`, `@causl/formula`, and `@causl/devtools` from esm.sh.
  Columns A–D with 10 rows plus E1 summary; editable column A inputs;
  live `replaceMany` formula editing; `whyUpdated` introspection; commit
  log (most recent 20 entries). Exposes `window.demo` for console
  experimentation, matching the original Vue version.

### Breaking changes

- **`commitHistoryCap` default flipped from 1000 to 0** (#716,
  semver-major). `createCausl()` (no options) now constructs an
  engine with `commitHistoryCap: 0` and `snapshotRetentionCap: 0`;
  Phases F / F.4 / F.6 are skipped per §5.1 Amendment 1 (#715), so
  `graph.commitLog` stays empty and `graph.readAt` / `graph.snapshotAt`
  resolve only at genesis. Adopters who depend on the prior 1000-row
  in-memory log must opt back in:

  ```ts
  createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
  ```

  The change is observably equivalent to the prior cap=1000 default
  for any engine without a `commitLog` consumer, by construction of
  the §5.1 Amendment 1 gates. `subscribeCommits` is unaffected — it
  fires through Phase H independently of the cap. Long-run-1M heap
  evidence (#710) was gathered with the heap-slope helper added in
  PR #728. Migration recipe: see
  [`docs/migration/cap-zero-default.md`](./docs/migration/cap-zero-default.md).
  SPEC §5.1 Amendment 2 ships in the same change.

### Changed — type surface

- **`Commit.originatedAt` typing tightened from optional to explicit
  `GraphTime | undefined`** (#760, #703 Win 5 follow-up). The field
  was previously declared `originatedAt?: GraphTime` and conditionally
  spread onto the published `Commit` record at four sites in
  `graph.ts` (Phase E commit assembly, Phase F history append, the
  `simulate` prediction, and the #704 empty-derivation freeze fast
  path), plus a fifth site in the `subscribeReads` initial-fire
  fabrication. The conditional spread produced two V8 hidden classes
  the moment the first `hydrate` landed, sending every commit
  subscriber's `c.originatedAt` access megamorphic and rippling
  through `subscribeCommits` / `commitLog` consumers. The field is
  now always-set on the assembled record (the explicit `| undefined`
  admits the no-tag case under `exactOptionalPropertyTypes: true`),
  so regular and hydrate-issued commits share one hidden class. The
  parallel adjustment to `IRCommit.originatedAt` (`number | undefined`,
  still optional on the wire) keeps the in-memory `commitHistory`
  rows on the same monomorphic shape; serialized exports continue
  to omit the key on regular commits. **This is a typing-only shift
  for adopters reading `commit.originatedAt`** — the runtime value is
  byte-identical (still `GraphTime` on hydrate-issued commits, still
  `undefined` on regular commits); only consumers that constructed
  `Commit` literals in tests need to add an explicit
  `originatedAt: undefined` slot. The prior `c.originatedAt !== undefined`
  branching pattern still distinguishes the two at the call site.
  This is the public-API counterpart to the `DerivedEntry.tag`
  monomorphization shipped in PR #735 (deferred from #703 Win 5
  when both changes were the same revision).

### Added — `causl-enumerator` SPEC §16.4.1 follow-ons (Phase 8 wave-41..50)

This stanza captures the second wave of `causl-enumerator` work,
landed after the `wave-31..40` closeout below. After this wave,
**every** named §16.4.1 type and surface has a real implementation;
the Phase-8 audit umbrella (#564) is closed.

- **`NodeId` / `ObserverId` / `ResourceId` newtypes** (#648 closes
  #642). Replaces three `pub type X = String` aliases with
  `#[serde(transparent)]` newtypes carrying `From<String>` /
  `From<&str>` / `Display` / `AsRef<str>` / `Borrow<str>` impls.
  Wire format unchanged. Type-discipline at API boundaries: a
  function taking `&NodeId` cannot be passed an `ObserverId` by
  mistake.
- **`Bound.linter` widens from `bool` to `causl_check::Bounds`**
  (#650 closes #644). The placeholder bool is replaced with the
  actual bounds-record (`max_nodes` / `max_commits` / etc.). Wire-
  format compat via untagged-enum deserializer: legacy
  `linter: true` payloads map to `Bounds::spec_defaults()`,
  `linter: false` to `Bounds::unbounded()`.
- **`VisitedKey` superseded** (#649 closes #645). SPEC §16.4.1's
  three-coordinate `VisitedKey { state_hash, pending_signature,
  msg_queue_depth }` predates wave-29's full-State hash. The
  bare `StateHash` already captures `pending_signature` and
  `msg_queue_depth` implicitly. SPEC.md updated to match the
  shipped implementation; documentation close, no code change.
- **`transition_phased` SPEC signature alignment + per-action
  bodies + BFS integration** (#652–#656 closes #643). Five
  sequenced slices:
  1. **Slice 1** (#652) — signature alignment from `(prev,
     action, phases) -> Result<State, TransitionError>` to SPEC's
     `(s, a) -> Result<(State, Vec<(PhaseStep, State)>),
     RaceClass>` plus the Tick body (`[RetentionTick,
     ResolveUnblocked]`). `TransitionError` removed.
  2. **Slice 2** (#653) — Subscribe / Unsubscribe / Dispose
     bodies (each one phase: `NotifyObservers` /
     `NotifyObserversObserved` / `RetentionTick` respectively).
  3. **Slice 3** (#654) — BeginFetch / ResolvePending /
     DispatchMsg bodies.
  4. **Slice 4** (#655) — Commit body (three-phase walk:
     `StageWrites → AppendCommit → ResolveUnblocked`).
  5. **Slice 5** (#656) — BFS integration: both
     `enumerate_with_script` call sites route through
     `transition_phased`, populating `Step.phases` from the
     walker output.

  The load-bearing contract `transition_phased(s, a).0 ==
  transition(s, a, &model)` is verified per-arm so the
  visited-set hash and BFS branching are byte-identical to the
  pre-#643 BFS.
- **`retention_buf` push on every Commit** (#658 closes #657).
  Pre-this-PR the field was defined per SPEC §16.4.1 line 1581
  but never written. Both `transition` (one-shot) and
  `transition_phased` (during AppendCommit) now push the commit
  id to `retention_buf` with K=1024 drop-oldest cap.
- **`Step.events` populated from typed `Event` emissions** (#661
  closes #659). `transition_phased` extends to return
  `(State, Vec<(PhaseStep, State)>, Vec<Event>)`. Per-arm
  emissions: `Commit` → `Event::CommitAppended { time, intent }`;
  `BeginFetch` → `Event::ResourcePhase { resource, phase: "loading" }`;
  `ResolvePending` → `Event::ResourcePhase { resource, phase:
  "loaded" }`. Other arms emit empty Vec. BFS plumbs through to
  `Step.events`. Subscribe's `Event::Notify` is deferred until
  v2 derived-recompute integration.
- **#646 partial: high-branching tier3 wall-clock regression
  gate** (#651). A regression test exercising tier3 with 8-input
  branching factor 9, asserting termination inside a 60s budget.
  The full #646 scope (empirical RSS measurement → cap retuning)
  is deferred per the research-agent recommendation pending
  adopter feedback.
- **Module-level docs refresh** (#662). `transition.rs` and
  `lib.rs` top-level docstrings refreshed from "v1 skeleton" to
  current state. No code change.

After this wave, `cargo test -p causl-enumerator --no-fail-fast`
runs **42 binaries green, 0 failures**. The only open Phase-8
follow-on is #646 (perf-tuning, optional).

### Added — `causl-enumerator` SPEC §16.4.1 closeout (Phase 8 wave-31..40)

This stanza summarizes the bounded-enumerator's SPEC §16.4.1 type-
fidelity closeout. After it, `State` carries all 10 SPEC fields
backed by `im::*` for cheap structural-shared clones, every
`Action` arm in `transition.rs` writes the field SPEC names for it,
the BFS calls the canonical `Oracle::check(s, prev, a)` surface
instead of the deprecated `evaluate(state, trace)` adapter, and
adopters can pass a deterministic `Script` prefix to drive the BFS
through a recorded counterexample.

- **`State` 7-field expansion + `im::*`** (#633). `State` was 3
  fields (`now`, `inputs`, `pending`); now ten per SPEC §16.4.1
  lines 1575–1587: `derived_cache`, `last_write_time`,
  `retention_buf`, `commit_log`, `observers`, `disposed`,
  `resource_fleet`, `pending_pipeline`. The new collection-typed
  fields use `im::OrdMap` / `im::OrdSet` / `im::Vector` so BFS
  successor `State::clone()` is O(log n) shared-structure instead
  of an O(n) deep copy. `State::hash()` participates over every new
  field; serde round-trips byte-stably.
- **`transition.rs` action arms wired** (#635, #636). Every
  `Action` variant now mutates the SPEC field it owns:
  `Commit` → `commit_log` + `last_write_time`; `Dispose` →
  `disposed`; `Subscribe` → `observers`; `Unsubscribe` →
  removes the observer from every set; `BeginFetch` →
  `resource_fleet[r] = Loading`; `ResolvePending` →
  `resource_fleet[r] = Loaded`; `DispatchMsg` → `pending_pipeline`.
  The wave-32 BFS diagnostic now reflects real per-state collection
  growth instead of always-zero.
- **BFS migrates to `Oracle::check`** (#637). The BFS in
  `lib.rs::enumerate` previously called the deprecated
  `Oracle::evaluate(state, trace) -> Option<RaceClass>` adapter.
  Per SPEC §16.4.1 lines 1722–1725 the canonical surface is
  `check(s, prev: Option<&State>, a) -> Vec<RaceClass>`. The BFS
  now calls `check` directly: `prev=None` for the s_0 evaluation,
  `prev=Some(&pre_state)` for transitions. Result: oracles see
  the real pre-transition `State` (impossible via the adapter)
  and a single transition can surface multiple `RaceClass` arms.
  `Step.races` is populated from the check result.
- **`Trace.steps: im::Vector<Step>`** (#639). Closes the BFS-clone
  cost at the data-structure level. `trace.clone()` was O(depth);
  with `im::Vector`'s persistent RRB-tree backbone it's O(log
  depth). The wave-32 frontier cap (#634) becomes belt-and-braces
  rather than load-bearing. Wire format unchanged — `im::Vector`
  serializes as a JSON array.
- **`Step.events: Vec<Event>` + `Step.state_after: Option<StateHash>`**
  (#632, #638). Two SPEC type closeouts: `events` widens from
  string discriminator to the typed three-arm `Event` enum
  (`Notify` / `CommitAppended` / `ResourcePhase`); `state_after`
  becomes optional so a future phased walker can record `None`
  when a transition errors mid-pipeline.
- **`enumerate_with_script(model, bound, script, oracles)`**
  (#640). The SPEC §16.4.1 canonical entry point lands as a new
  function; legacy `enumerate(model, bound, oracles)` becomes a
  sugar wrapper passing `Script::default()`. Adopters who want to
  pin the BFS to a deterministic action prefix (the
  hypothesis-replay surface, the apalache differential's recorded
  counterexample) call the canonical function with their `Script`.
  The script-walk fires oracles on every step and seeds the BFS
  frontier with the post-script `(state, trace)` pair.
- **`Script` + `PendingResolution` + `ResolutionKind`** (#628).
  Three SPEC §16.4.1 types absent from the Rust crate after nine
  prior #570 waves. Pure additive; no signature breakage.
- **wave-32 BFS memory ceilings + `log4rs` diagnostics** (#634).
  Hard caps on `frontier`, `traces_recorded`, and `races` — every
  cap fires `bounded_out: true` for the §16.4.1 honesty contract.
  `causl-enumerate` initializes `log4rs` at startup, writing
  `causl_enumerator::bfs` diagnostics to stderr (every 100k
  transitions + on every termination, with `reason=` field).
  Reapplied cleanly on top of the State expansion after the
  pre-State original was reverted (#626) for breaking `main`.
- **`#570a` mapping invariant validation + Apalache CI workflow**
  (#627). `tools/enumerator/diff/tests/mapping_invariants_resolve.rs`
  is the regression gate that every `(model, invariant)` tuple in
  `mapping.toml` resolves to a real INVARIANT/THEOREM definition.
  `.github/workflows/apalache-diff.yml` runs the differential
  binary on PR + nightly cron and uploads
  `docs/apalache-diff-report.md` as an artifact.
- **`causl-check --source <path>` per-site comment suppression CLI**
  (#629). The wave-24 library API
  (`parse_suppressions` / `SuppressionTable` /
  `apply_suppression_table`) had no operator-facing knob.
  `--source <path>` (repeatable) reads the file, runs the per-site
  `// @causl-allow:RuleId — reason: ...` magic-comment parser, and
  applies the resulting suppression table to the report before
  exit-code computation and SARIF emission. Two arg forms:
  `--source <path>` (URI = path) and `--source <path>=<uri>`
  (alias). A missing path is exit 2; malformed magic comments
  surface as `causl/missing-suppression-reason` violations.
- **`causl-check` cycle-pass determinism fix** (#631). The cycle
  detector's DFS root was picked by iterating `HashMap::keys()`,
  which Rust randomizes per-process. Same model produced
  `Violation.node = "c"` ~60% of runs and `"d"` ~40%, false-
  positiving the SPEC §16A.2 `--replay` verdict-determinism gate.
  Fix: sort `derived_ids` lexicographically before iterating.
  `replay_compares_set_not_order` previously flaked at 40%; now
  0/30 across loop runs.
- **`#589` worker-pool acceptance gate** (#630). Pins the five
  SPEC §16.4 contracts (persistent JSON-RPC pool, compute-body
  registry, `Date.now`/`Math.random`/`crypto.randomUUID`/
  `performance.now` sandbox, no silent `MockWorkerPool` fallback,
  1% double-check sampler) at the public-API level so a future
  wave that breaks any one fails this gate before the per-feature
  test does.

### Added — tooling consumers (Phase 8)

This section calls out changes that affect downstream tooling
consumers — IR readers, SARIF pipelines, audit script authors, CLI
integrators — separately from end-user-facing engine and adapter
changes. Per #584's A17-8 audit recommendation, these are the
changes a consumer of the IR / checker / audit machinery
specifically needs to know about.

- **CauslModel IR — SPEC §16.2.1.1/2 documented** (#569). The
  shipped Schema-3 IR shape is now codified in SPEC.md verbatim:
  six IREvent variants (subscribe, subscribe-callback, unsubscribe,
  dispose, read, tx-set), seven-field CauslModel top-level
  (`schema | time | nodes | commits | events | scopes | bridges`),
  full IRSubscribe / IRDispose / IRRead / IRTxSet field shapes
  with serde rename rules. The `spec-ir-parity.test.ts` gate
  (`@causl/core`) trips at PR time when SPEC text drifts from
  source.
- **`@causl/sync`: `whyUpdated` / `whyNotUpdated` decoders +
  `RESOURCE_UPDATE_REASONS`** (#577). Closed seven-arm enumeration
  per SPEC.async §11.1: `fetch-begin | fetch-resolved | fetch-stale
  | fetch-rejected | invalidated | failed | dep-changed`. Decode
  a `CommitForDecoding` + pre/post-state pair into the matching
  reason. `whyNotUpdated` returns `'no-dep-overlap' |
  'object-is-deduped' | null`.
- **`@causl/hypothesis`: SPEC §16.5.1 surface expanded** (#571).
  New: `hypothesis(name, body)` factory returning
  `NamedHypothesis<S>`; `holds(p).until(q)` / `holds(p).weakUntil(q)`
  builder; `fromPredicate(name, p)` factory. Semantic fixes:
  `afterCommit` now evaluates at the immediate successor of each
  commit (was: every step after first commit); `eventually` returns
  three-valued `'unknown'` when the trace was truncated by a bound
  (new optional `Trace.bounded` field).
- **`tools/checker` Rust public surface — new types** (#591).
  Added `PhysicalLocation`, `Region`, `SuppressionStatus`, and
  `rule_id_for_kind` exports. `Violation` gains three optional
  fields (`physical_location`, `suggested_fix`, `suppression_status`)
  flowing through to SARIF as `locations[]`/`fixes[]`/`suppressions[]`.
  All serde-skipped when unset — pre-#591 wire format preserved.
- **`causl-check` CLI — new flags** (#572, #592). Adds
  `--suppress <rule-id>=<reason>` (repeatable) for programmatic
  per-rule suppression and `--replay <report-path>` for verdict-
  determinism. Suppressions surface in SARIF and don't fail the
  exit-code gate. Replay exits 3 on divergence (vs 1 active or 2
  CLI error). Justification is required on every suppression.
- **Audit infrastructure — `pnpm audit:commitments`** (#565, #579).
  Five MECHANICAL audit predicates now run on every PR (was 1
  silently broken pre-#565): commitment 1 (two-primitive IrNode),
  10 (schema lockstep), 11 (race-row witness presence — regex
  widened to match uppercase identifiers), 15 (adapter exhaustiveness
  fixtures), 17 (§10 worked-example fixtures). The 20-row
  commitment ledger lives at `docs/commitment-audit.md`.

### Added
- `@causl/core`: `graph.simulate(intent, run): SimulateResult` — the
  SPEC §5 dry-run API. Predicts what `commit(intent, run)` would do
  without committing: runs the staging + recompute pipeline against a
  transient view, captures the would-be `Commit` plus the staged-input
  / derived-recompute diffs, then unconditionally restores every byte
  the pipeline mutated. `now` does not advance, the commit log is not
  appended to, no per-node or per-commit subscriber fires; engine state
  after return is byte-identical to the pre-call moment. Errors that
  would have escaped `commit` (`NotAnInputNodeError`,
  `UnknownNodeError`, `NodeDisposedError`, `StaleTxError`, plus
  user-thrown exceptions out of the `run` callback or from inside a
  derivation compute) surface on the `'failed'` arm of the
  discriminated `SimulateResult` rather than throw — the only throw is
  `CommitInProgressError` on re-entry. Closes #367.

### Added — review-fix sweep
- `@causl/core`: `subscribeCommits(observer)` (SPEC §11), an
  `onObserverError` hook on `createCausl({...})`, a configurable
  `commitHistoryCap`, and `exportModel()` returning the CauslModel
  IR.
- `@causl/formula`: `FormulaResult` discriminated union (`value` |
  `error`); `FormulaError` with kinds `div-by-zero`, `unresolved-ref`,
  `non-numeric`, `unknown-function`, `argument-error`, `propagated`.
- `@causl/sync`: full `Conflict` lifecycle — `resolve(id, payload)`,
  `ignore(id)`, `supersede(id, by)` with subscriber-visible status flips.
- `@causl/devtools`: `WhyResult.reason` tagged enum; `replaceMany()`
  for batched live-derivation edits.
- `@causl/react`: `useCauslShallow(selector)` — shallow-equality
  hook for object/array selectors; `shallowEqual` helper.
- Property-test seed reproduction: `CAUSL_FUZZ_SEED=<n> pnpm test:run`.
- Husky pre-commit + GitHub Actions CI shape adapted from webapp.

### Changed
- **Engine scheduler** — replaced the O(graph_size) dirty walk with an
  O(|affected|) topological recompute backed by a maintained reverse-dep
  graph (SPEC §14 correctness).
- **Spreadsheet diamond demo** — D = C × B (was C − B, which was
  algebraically constant in A and therefore a useless glitch test).
- **`whyUpdated` / `whyNotUpdated`** — primary output is the structured
  `reason` tag; the human `because` string is now derived rather than
  authoritative.
- **Property test atomicity** — replaced impl-self-compare assertion
  with an external oracle (independent sum recomputation).
- **TypeScript paths** — hoisted into `tsconfig.base.json`, removed
  from per-package configs.
- **`Provider.update`** — typed `Update<Msg, Graph> | undefined` to
  cooperate with `exactOptionalPropertyTypes`.

### Fixed
- Observer thrown errors are no longer silently swallowed — they fire
  through `onObserverError` (default: `console.error`).
- Formula divide-by-zero now produces a tagged `div-by-zero` error
  rather than silently returning 0.
- Formula non-numeric coercion no longer throws inside a `compute`
  (which used to tear down the entire commit) — it surfaces as a
  tagged `non-numeric` error.

### Removed
- `void X` lint silencers across tests and `parser.ts` (replaced with
  no-capture form `g.derived(...)` or removed dead variables).
- `commitHistory` undocumented hard-coded 10k cap (now `commitHistoryCap`,
  default 1000).
- `graph.clearCommitHistory()` — fired `commitLog` subscribers outside a
  commit boundary (§5 violation, #387) and had no production caller
  (#401). Long-lived processes that want zero retention pass
  `commitHistoryCap: 0` (or `1`) at construction; the cap is the only
  memory-hygiene knob.

## Phase 0 — Spec & monorepo bootstrap

The 53 implementation PRs landing the SPEC.md commitments. See the
PR list in the GitHub repo for the per-issue history.
