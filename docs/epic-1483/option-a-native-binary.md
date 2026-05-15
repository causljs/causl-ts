# #1485 — Option (a): native Rust binary deployment

> Feasibility study for re-architecture epic [#1483](https://github.com/iasbuilt/causl/issues/1483).
> Reads against the constraint rubric at
> [`docs/epic-1483/CONSTRAINTS.md`](./CONSTRAINTS.md) (predecessor
> #1484, PR #1489, dev `336ec6bd`). Fills the option-(a) column of the
> §6 rubric. Pure research + doc; no engine or bridge code changes
> in this PR.
>
> **Reading order recommended by CONSTRAINTS Appendix** — SPEC §3,
> §5.1, §15.1 amendment, §17.5 status callout, §17.6 host-tier matrix,
> `docs/epic-1133/G1-PERF-MEASUREMENT.md` (the 78× boundary
> arithmetic), `packages/core/src/types.ts` `Graph` interface block,
> `packages/core/test/properties/cross-backend-determinism.property.test.ts`,
> `docs/epic-1133/PLAN.md` rows 23–26.

---

## 0. TL;DR

Option (a) ships a native Rust engine binary per platform — same
distribution shape as `@causl/checker-{darwin,linux,win32}-*` today —
and loads it from `@causl/core` through either an **N-API in-process**
or **IPC out-of-process** Node binding.

- **Boundary tax projection.** N-API in-process at the per-commit
  granularity used by F-marshal.6 (15.64 μs / op WASM today): best
  case **~0.5–1.5 μs / op** (~10–30× improvement over WASM); worst
  case **~3–8 μs / op** when the marshal envelope dominates and the
  JS↔napi-rs side still serialises through serde. IPC variant:
  **~25–80 μs / op** on a `child_process` or `worker_threads` socket
  hop; not viable at the per-commit granularity.
- **Floor compliance.** SPEC §3 perf-floor from CONSTRAINTS §3
  requires **≤ 50 ns / op**. **Neither N-API nor IPC reaches this
  floor.** Same kill criterion that fired against #1133. Option (a)'s
  pitch is therefore *not* "boundary cost gone" but "boundary cost
  10–30× smaller than WASM and rounded into a Node-native distribution
  story." The Node SSR path benefits; the browser path does not, because
  Option (a) does not help the browser at all (see §5).
- **Browser bite.** SPEC §17.6 commitment 14 "no host stranded" is
  **non-migratable** per CONSTRAINTS §2. Option (a) either ships a
  WASM/JS fallback alongside the native binary (Path A1 — F-marshal
  infrastructure becomes the maintained browser path) or files a
  §17.6 amendment dropping the browser as a target (Path A2 —
  collapses the `@causl/react` value proposition). Recommended:
  **Path A1**, with the framing that native is acceleration for the
  Node tier and WASM stays the browser floor.
- **Reuse from #1133.** ~12 k LOC of `tools/engine-rs-core/` carries
  verbatim; ~4 k LOC of tests across `engine-rs-core` and the cross-
  backend gate carry verbatim; SPEC §3, §5.1, §15.1, §17.5, §17.6
  amendments stand.
- **Throws away.** ~2 k LOC across both bridge crates (`engine-rs-
  bridge-serde`, `engine-rs-bridge-gc`), 725 LOC of `wasm/marshaler.ts`,
  the F-marshal sub-cascade gains beyond the LOC, the `wasm-build`
  toolchain (557 LOC), and the `wasm-pkg` distribution surface — *if*
  Path A2; *kept as the browser fallback* if Path A1.
- **Effort.** 9–15 PRs (~6–10 weeks at a steady cadence), assuming
  napi-rs is adopted off the shelf and the cross-backend determinism
  gate passes byte-identically on the native engine on first wiring.
  An additional 2–4 weeks if napi-rs surfaces a serde-incompatibility
  with the SPEC §15.1 byte-identity contract.
- **GO/NO-GO.** **NO-GO at the SPEC §3 50 ns / op perf-floor**;
  **CONDITIONAL-GO at a relaxed floor of "10× WASM"** if the team
  amends CONSTRAINTS §3 to recognise that no boundary-crossing
  architecture clears the strict 50 ns floor and the relevant
  comparison is "Node tier acceleration" rather than "browser tier
  acceleration." Confidence: medium-high (the napi-rs numbers are
  public; the arithmetic transposes cleanly from the F-marshal.6
  measurement; the browser bite is a SPEC question, not an engineering
  one).

---

## 1. Boundary cost projection

### 1.1. N-API in-process call overhead

The N-API binding ecosystem in Node has two production-grade Rust
options:

- **napi-rs** (https://napi.rs) — the de facto standard. Used by
  `@swc/core`, `@parcel/source-map`, `@node-rs/argon2`, `@prisma/
  client-engine` for its Node binding, and most of the JS-tooling
  ecosystem's Rust bindings. Macro-driven (`#[napi]` on Rust
  functions), generates the `.node` C-addon entry-points and the
  TS-side `.d.ts` automatically. Underlies the same N-API stable ABI
  as Node's C addon surface — works across Node 14+ without rebuild.
- **neon-bindings** (https://neon-bindings.com) — older, requires
  more manual juggling, still alive but less momentum. The shape it
  produces is the same N-API stable ABI; the developer ergonomics
  are worse.

For this study, the assumption is **napi-rs**; neon is a fallback if
napi-rs hits a serde incompatibility with the SPEC §15.1 byte-identity
contract.

**Per-call overhead breakdown** (from napi-rs benchmarks, public
data, plus inference from the F-marshal.6 measurement):

| Cost component | Best case (μs / call) | Worst case (μs / call) | Notes |
| --- | ---: | ---: | --- |
| JS → C addon entry (N-API `napi_create_function` thunk) | 0.05 | 0.20 | Empirical from napi-rs `bench` (no-op function call). |
| Rust-side `Env` setup (Tsfn / Reference allocation) | 0.05 | 0.30 | Per-call when using `ThreadsafeFunction`; lower when using sync calls. |
| Argument unmarshal (JS → Rust via `napi::FromNapiValue`) | 0.10 | 1.5 | Depends on argument shape. `commit(intent, writes: Map<NodeId, JsonValue>)` is the relevant shape; the writes map dominates. Worst case is when napi-rs serialises through serde-json on the JS side; best case is a direct `napi_get_property` walk into a `Vec<(SmolStr, JsonValue)>` Rust-side. |
| Engine work (`transition_phased`) | (variable) | (variable) | Out of scope for boundary tax — same Rust kernel as WASM today. |
| Return value marshal (Rust → JS via `napi::ToNapiValue`) | 0.20 | 3.0 | The `Commit` envelope (`changedNodes`, `commitLog` entry, `EngineTelemetry` snapshot). Dominates the worst case. F-marshal.6's 156 μs total — half on the return — suggests ~3 μs / op is reachable if napi-rs can avoid the full serde-json round-trip. |
| Sub-total (boundary tax) | **0.5** | **5.0** | Round-trip excluding engine work. |
| Plus: subscriber-fire path (Phase G IndexMap walk, observer dispatch back into JS) | 0.5 | 3.0 | Per-subscriber callback through N-API thunk. Real workloads (10k-fanout cells) inflate this end of the cost; F-marshal.6 was a single-subscriber probe and so under-counts this row. |
| **Total per-commit boundary tax** | **~1.0 μs** | **~8.0 μs** | Best/worst spread. |

**Comparison to WASM (F-marshal.6 measurement, 15.64 μs / op)**:

- N-API best case: ~16× improvement.
- N-API worst case: ~2× improvement.

**Versus SPEC §3 perf-floor (≤ 50 ns / op)**: still **20–160× over the
floor.** The 50 ns / op floor was derived from the smallest contract-
bearing cell (`scrolling-viewport`, 0.011 μs / op TS); no boundary-
crossing architecture has demonstrated this floor in any published
benchmark. The honest framing in this study: N-API moves the boundary
tax from "boundary is 78× the TS workload" (WASM) to "boundary is
~9× the TS workload" (best case N-API on `scrolling-viewport`).

The 50 ns / op floor in CONSTRAINTS §3 is a kill-criterion for *any*
re-crossing architecture, not specifically WASM. If Option (a) is to
GO, that floor either has to be amended (recognising that no FFI-
crossing architecture meets it) or the comparison axis has to shift
(per-batch amortised cost, not per-commit). Option (b) in-place
mutation and option (c) batched commit are the architectures that
have a path to the strict floor; option (a) does not.

### 1.2. IPC out-of-process variant

For completeness, the IPC variant — Node `child_process` /
`worker_threads` / Unix-domain socket — is included so the rubric is
filled honestly. The IPC variant is **not viable at the per-commit
granularity** but is included because some adopters may have a use
case (sandboxing, untrusted code, language-server-like remote engine).

| Cost component | Best case (μs / call) | Worst case (μs / call) | Notes |
| --- | ---: | ---: | --- |
| JS → process boundary (Node `worker_threads` postMessage, structured-clone serialise) | 5 | 30 | Structured clone walks the entire `writes` map. |
| OS-level context switch (kernel-side schedule of the worker thread) | 2 | 20 | Tail dominated by other-process CPU pressure. |
| Engine work | (variable) | (variable) | Same as N-API. |
| Process → JS return (postMessage back, structured-clone deserialise) | 5 | 30 | Worse than the outbound because of the `Commit` envelope shape. |
| Sub-total | **~12 μs** | **~80 μs** | Per round-trip. |

**Not viable for the per-commit granularity** (commit is the hot path
and the worst case is 5× the WASM boundary, not better). Could be
viable for a future "remote engine" surface where the boundary is
amortised across many commits (a per-session handshake; commits
queued and round-tripped in batches). That hybrid converges with
Option (c) (batched commit) and is out of scope for Option (a) as
filed.

### 1.3. Side-by-side

| Architecture | Boundary tax (best, μs / op) | Boundary tax (worst, μs / op) | Versus G.1 floor (50 ns / op) |
| --- | ---: | ---: | --- |
| TS engine (no boundary) | 0 | 0 | Trivially passes. |
| WASM (F-marshal.6, on record) | 15.64 | 15.64 | **313× over floor.** |
| **Option (a) N-API** | **~0.5–1.0** | **~5–8** | **10–160× over floor.** |
| Option (a) IPC | ~12 | ~80 | 240–1600× over floor; **worse than WASM.** |
| Option (b) in-place mutation (target) | 0 (no per-op marshal) | 0 (no per-op marshal) | Trivially passes if achieved. |
| Option (c) batched commit (target) | (amortised) | (amortised) | Depends on batch size. |

---

## 2. Reuse from #1133

The #1133 epic produced ~75 PRs across the Rust-port workstream. The
portion that carries over to Option (a) is the engine kernel and the
SPEC compliance work; the portion that does not is the WASM-specific
bridges and toolchain.

### 2.1. Carries over verbatim

| Artefact | Path | LOC | Notes |
| --- | --- | ---: | --- |
| Engine core crate | `tools/engine-rs-core/` (lib + transition/) | ~12,000 | The `State` / `Action` / `Event` / `Commit` / `PhaseStep` surface + `transition_phased` + all eight named phases (A–H) + Phase F.5 / F.6 + Phase G IndexMap subscriber container. Zero changes required for Option (a); napi-rs links this crate as a Rust dependency the same way the bridges link it today. |
| Engine-core tests | `tools/engine-rs-core/tests/` | ~4,000 | `transition_phased` property tests, NodeId-disposal property tests (#1151), JSON-value round-trip tests (#1078). All target the kernel, not the bridge; carries over verbatim. |
| Cross-backend determinism gate | `packages/core/test/properties/cross-backend-determinism.property.test.ts` | ~500 | F-marshal.5 1000-trials × 0-byte-differences gate. Plugs into Option (a) through a new `NativeBackend` shape that implements `BackendEngine`; runs unchanged. |
| SPEC §3 / §5.1 / §15.1 / §17.5 / §17.6 amendments | `SPEC.md` (multiple) | (text) | Every amendment that names the FFI-boundary contract (Theorem 2 uninterruptibility, Phase G IndexMap pin, reference-identity-not-contractual, §17.5 residual band, §17.6 host-tier matrix) stands; Option (a) inherits them by construction. |
| `@causl/checker-{darwin,linux,win32}-*` distribution pattern | `packages/checker-*` | (model) | Per-platform binary published as `optionalDependencies` of the npm wrapper. Five packages (darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64) — proven, in production. Option (a)'s native engine reuses this pattern verbatim. |
| `@causl/core` adopter API surface | `packages/core/src/index.ts`, `types.ts` | (no change) | The §1a non-negotiable surface (`createCausl`, `graph.input` / `derived` / `commit` / `read` / `subscribe` / `explain` / `simulate` / `snapshot` / `hydrate`, the React hooks, the error catalogue) is unchanged. Option (a) plugs in beneath the `BackendEngine` interface. |
| `BackendEngine` plug-in interface | `packages/core/wasm/index.ts:177-197` | (no change) | The cross-backend determinism gate (#685) runs against this shape. Option (a) implements it with a new `NativeBackend` adapter (~150 LOC, see §3.2). |

**Total reuse: ~16,500 LOC of engine code + 4,500 LOC of tests + ~50
SPEC commitments + the entire adopter API surface.**

### 2.2. Carries over with modification

| Artefact | Path | Modification |
| --- | --- | --- |
| `auto-adapt.ts` backend identifiers | `packages/core/src/auto-adapt.ts` | The `'js' \| 'wasm' \| 'auto'` literal type extends to `'js' \| 'wasm' \| 'native' \| 'auto'`; `shouldMigrate(stats)` gains a `'native'` arm. Per CONSTRAINTS §1b, this is migratable with a deprecation. |
| `WasmBackendUnavailableError` code field | `packages/core/src/errors.ts` | Add `CAUSL_NATIVE_UNAVAILABLE` to the structured `code` field for platform-mismatch (`optionalDependencies` not resolved on aarch64-FreeBSD or similar unsupported triple). |
| Host-tier matrix | `packages/core/wasm/README.md` + SPEC §17.6 table | New row for the native tier (Node 22+, per-platform binary resolved); same fallback chain (`native` → `wasm` tier-2/3 → `js` floor). |

---

## 3. Throws away

| Artefact | Path | LOC | Disposition |
| --- | --- | ---: | --- |
| WASM bridge crates (both) | `tools/engine-rs-bridge-serde/`, `tools/engine-rs-bridge-gc/` | ~2,100 (813 serde + 1,281 gc) | **Path A2 (drop browser): delete.** **Path A1 (keep browser fallback): maintained as the browser path; no further investment but kept on the shelf.** |
| TS-side marshaler | `packages/core/wasm/marshaler.ts` | 725 | Same as bridges: Path A2 delete; Path A1 keep maintained. |
| WASM build toolchain | `tools/wasm-build/build.mjs` | 557 | Same as bridges. |
| `@causl/core/wasm` substrate distribution | `packages/core/wasm-pkg/` | (build artefact) | Same as bridges. |
| F-marshal sub-cascade gains (LOC + perf engineering hours, F-marshal.0 through F-marshal.N) | `docs/epic-1133/F-MARSHAL-*.md` | (work effort) | The 715-test post-F-marshal.5 1000-trial-clean determinism gate is **kept** (it's the test, not the bridge). The *engineering investment* in the F-marshal sub-cascade — getting from F-marshal.0 to F-marshal.6's 15.64 μs / op figure — is **sunk cost.** No further marshal-tax-reduction work makes sense for Option (a) because N-API replaces the marshal envelope. |
| `wasm-pack` and `wasm-bindgen` build-time dependencies | `Cargo.toml`, root `package.json` `wasm:build` script | (toolchain) | Path A2 delete; Path A1 frozen at the current version (no further wasm-bindgen upgrades). |
| Bundle-size CI gates for `wasm-pkg` (cells in root `package.json` `size-limit`) | root `package.json` | (cells) | Path A2 delete; Path A1 keep. |

**Path A2 cumulative discard: ~3,400 LOC + the entire wasm toolchain
+ size-limit CI surface.**
**Path A1 cumulative discard: 0 LOC (everything kept as maintained
fallback); the F-marshal effort still becomes a sunk cost relative to
the project trajectory, since future marshal-tax-reduction work would
no longer be on the critical path.**

---

## 4. Deployment story

### 4.1. The `@causl/checker-{platform}-{arch}` model — proven, reused

The repo already ships per-platform binaries for `causl-check` (the
Rust IR linter) via `optionalDependencies`. The model:

- One npm wrapper package (`@causl/checker`) declares the platform-
  binary packages as `optionalDependencies`. npm/pnpm/yarn resolve
  only the binary matching the current `process.platform` +
  `process.arch`; the others fail their `os` / `cpu` gate in the
  per-binary package's `package.json` and are silently skipped.
- Each per-platform package contains a single prebuilt binary
  (`bin/causl-check`) declared in `bin`, files-listed in `files`.
- The npm wrapper's `bin/causl-check.js` shim resolves the actual
  binary at runtime via `require.resolve('@causl/checker-darwin-
  arm64/bin/causl-check')` and execs it.

**Concrete shapes from the repo today** (anchored at dev `336ec6bd`):

```json
// packages/checker-darwin-arm64/package.json (excerpt)
{
  "name": "@causl/checker-darwin-arm64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "bin": { "causl-check": "./bin/causl-check" },
  "files": ["bin", "README.md"]
}
```

```json
// packages/checker/package.json (excerpt)
{
  "name": "@causl/checker",
  "optionalDependencies": {
    "@causl/checker-linux-x64": "workspace:*",
    "@causl/checker-linux-arm64": "workspace:*",
    "@causl/checker-darwin-x64": "workspace:*",
    "@causl/checker-darwin-arm64": "workspace:*",
    "@causl/checker-win32-x64": "workspace:*"
  }
}
```

Option (a)'s engine reuses this **verbatim**, with one substitution:
the `bin/causl-check` artefact becomes `lib/causl-engine.node` (a
`.node` C-addon, which is the napi-rs output shape), and the runtime
resolver in `@causl/core`'s native loader does
`require('@causl/engine-darwin-arm64/lib/causl-engine.node')` rather
than spawning a child process.

### 4.2. Prebuilt-binary install path (the hot path)

Adopter does `npm i @causl/core`. npm walks
`optionalDependencies`; only the matching platform resolves; one
~2–5 MB `.node` artefact ends up on disk per project. Install time:
sub-second post-fetch. No `cargo`, no `rustc`, no `wasm-pack` on the
adopter's machine.

This is the ergonomics target: **the experience is "I `npm install`
and the native engine just works."** It is the same experience as
`@swc/core`, `esbuild`, `sharp`, `@parcel/source-map`, `@prisma/
client` — all production-grade Rust-via-N-API packages with hundreds
of millions of weekly downloads. The pattern is well-understood;
there are no novel failure modes.

### 4.3. Source-compile fallback (the cold path)

For platforms not in the prebuilt matrix (FreeBSD-x64, illumos, NixOS
on exotic glibc versions, embedded systems with Node), napi-rs
supports a `napi build` source-compile fallback. The adopter needs:

- Rust toolchain (`rustup`).
- A platform that napi-rs's N-API target supports — anywhere Node
  itself builds.
- ~30–60 seconds of cargo build time on first install.

This is gated behind an `optionalDependencies` miss: if no per-
platform package resolves, `@causl/core`'s install script
(`postinstall`) attempts `napi build` from a vendored source tree
shipped inside `@causl/core`. If that fails (no `rustup`, no
network), `@causl/core` falls through to the WASM/JS path (Path A1)
or surfaces `CAUSL_NATIVE_UNAVAILABLE` (Path A2).

**Path A1's source-compile is non-load-bearing** because the WASM/JS
path is a fully-supported fallback. **Path A2's source-compile is
load-bearing** because it's the only fallback for unsupported
platforms — which sharpens the §17.6 amendment requirement.

### 4.4. Cross-platform matrix

Same five rows as `@causl/checker-*` today:

| Triple | Status | Notes |
| --- | --- | --- |
| `aarch64-apple-darwin` (macOS arm64, M-series) | Prebuilt | The dev machine for most modern macOS users. |
| `x86_64-apple-darwin` (macOS x64, Intel) | Prebuilt | Intel Macs, CI runners. |
| `aarch64-unknown-linux-gnu` (Linux arm64) | Prebuilt | Graviton, Raspberry Pi 4+, modern ARM cloud. |
| `x86_64-unknown-linux-gnu` (Linux x64) | Prebuilt | The default Linux server target. |
| `x86_64-pc-windows-msvc` (Windows x64) | Prebuilt | Windows desktop + WSL host. |

**Not in the matrix** (source-compile via napi-rs, or WASM/JS
fallback): aarch64-windows (Windows ARM), Linux x32, FreeBSD, illumos,
musl variants beyond Alpine x64 (Alpine ships its own musl glibc).
napi-rs can produce musl builds; for v1 we follow `@causl/checker`
exactly (no musl prebuilt; source-compile path covers it).

### 4.5. GitHub Actions release pipeline cost estimate

The `@causl/checker` pipeline today runs a per-platform matrix on
release. Option (a) needs the same shape:

| Workflow | Matrix | Estimated CI cost per release |
| --- | --- | --- |
| `release-native-engine.yml` (new) | 5 platforms × 1 build + 1 test job each | ~30–45 min × 5 = 2.5–3.75 runner-hours |
| `publish-native-engine.yml` (new) | Single job, post-build artefact aggregation | ~10 min |
| Existing `release.yml` (`@causl/core`, `@causl/react`, etc.) | unchanged | unchanged |

**Per-release CI cost**: an additional ~3.5–4 runner-hours, roughly
equivalent to the existing `@causl/checker` release. On GitHub-hosted
Linux runners (free for public repos) this is zero direct cost; on
macOS runners (10× billing rate vs Linux) it's the load-bearing line
in the budget. macOS arm64 GHA runners are now first-class and the
existing `@causl/checker` pipeline already prebuilds for both Apple
arches, so the marginal cost of adding the engine target is purely
the longer cargo build (the kernel + napi-rs is bigger than the IR
linter).

**Per-PR CI cost**: only the host platform (Linux x64) builds the
native engine on PR; the other four arches are gated behind the
release tag. This keeps the PR-time CI under 15 min added.

### 4.6. Resolved-binary loading

`@causl/core/native/index.ts` (new) does:

```ts
// Pseudocode — actual implementation TBD.
const platformPkg = `@causl/engine-${process.platform}-${process.arch}`;
let bindings: NativeEngineBindings;
try {
  bindings = require(`${platformPkg}/lib/causl-engine.node`);
} catch (e) {
  // Fall through to wasm (Path A1) or throw NativeUnavailableError (Path A2).
  bindings = await loadWasmBackend();  // Path A1
  // throw new NativeUnavailableError({ code: 'CAUSL_NATIVE_UNAVAILABLE' }); // Path A2
}
```

Browser path: `@causl/core/native/index.ts` is gated by a
`typeof process !== 'undefined' && process.versions?.node` check;
browsers go straight to the WASM tier-chain.

---

## 5. Browser-target trade-off — §17.6 commitment 14

The §17.6 commitment-14 row (SPEC.md line 2722) reads in full:

> The opt-in `@causl/core/wasm` substrate ships against a documented
> three-tier host compatibility matrix (`wasmgc-builtins`,
> `wasmgc-classic`, `serde-json`) with a fall-through fallback to the
> TS engine; **no adopter is ever stranded on an unsupported host
> because every supported host either runs at least one tier or hits
> the documented JS-engine fallback path** per §17.6.

The matrix is enumerated in `packages/core/wasm/README.md` and the
§17.6 host-tier table. **The browser target is non-migratable per
CONSTRAINTS §2** (CONSTRAINTS.md:90-97):

> The browser target is **NOT migratable** — re-architecture (a)
> (native Rust binary) must either ship a WASM/JS fallback for the
> browser path or document a deliberate scope reduction that strikes
> the entire `@causl/react` value proposition.

Two paths follow, both legitimate in principle. The doc commits to
**A1** as the recommended path (rationale at §5.3).

### 5.1. Path A1 — ship WASM/JS fallback alongside native

The native binary is the Node-tier acceleration; the WASM/JS stack
remains the browser tier and the unconditional embedded-runtime
floor.

**What this keeps**:

- All of `tools/engine-rs-bridge-{serde,gc}/`, `wasm/marshaler.ts`,
  `tools/wasm-build/`, `wasm-pkg/`.
- Three-tier host matrix (`wasmgc-builtins` → `wasmgc-classic` →
  `serde-json` → JS fallback) **plus** the new native tier above
  WasmGC tier 1 for Node.
- Cross-backend determinism gate runs across all four backends (JS,
  WASM, native, plus the existing tier-2/3 split).

**What this costs**:

- Maintenance: the WASM bridges continue to need security updates
  (Rust toolchain bumps, `wasm-bindgen` advisories) and bundle-size
  vigilance (the §17.6 213 KB / 66 KB current-state callout per
  #1150 carries over unchanged; no further reduction work since the
  bridge is no longer the hot path).
- CI surface: the existing WASM CI gates stay green; the native CI
  gates land alongside; the cross-backend determinism gate grows from
  2 backends to 3 (JS + WASM + native), which is a 50% time increase
  on that test but still well under the 60s budget.
- Bundle-size: no change for the WASM path; the native path adds
  per-binary disk-space cost (per §4.2 ~2–5 MB per platform), which
  is irrelevant for browsers (they never download the .node).
- Documentation: the host-tier table grows a row; adopter checklist
  gains a Node-tier row.

**This is the conservative path.** The framing is "native is
acceleration for the Node tier; the existing WASM stack is the
browser tier and unconditional embedded-runtime floor."

### 5.2. Path A2 — file §17.6 amendment dropping browser as a target

The native binary is the only engine; the WASM/JS substrate is
deleted. `@causl/react` becomes Node-only (SSR-only); browser users
have no engine.

**What this requires**:

- SPEC §17.6 amendment striking commitment 14 (or amending it to
  "no Node-tier adopter is stranded"). The amendment trail at §19 has
  precedent for substrate-shape amendments (#690 added commitment 14;
  this amendment retires it).
- Community acceptance. The library's positioning is interactive UIs
  with React; the value proposition collapses if browsers cannot run
  the engine. Per CONSTRAINTS §2 framing: "A re-architecture that
  drops the browser target is a different product."
- Deprecation cycle: at least one minor version of warning on
  `@causl/react`'s browser entry, codemod for adopters to migrate to
  a server-only architecture (Hydrate-only on the browser, all
  commits server-side).

**What this strikes**:

- The `@causl/react` value proposition per CONSTRAINTS §2 framing.
- The `useCauslNode` / `useCausl` / interactive-frame-budget contract
  per SPEC §8 + §14.
- Cloudflare Workers per CONSTRAINTS §2 row (Workers don't run
  native; the WASM substrate is what supports the edge tier).
- Deno (without WASM, Deno can't run the native binary either).
- React Native, Hermes, embedded JS runtimes — all stranded.

**This is the aggressive path.** It is honest if the team's read of
the library's positioning has shifted toward server-side state
management (i.e., the framing-shift would precede the SPEC amendment).
It is dishonest if filed merely to retire maintenance burden.

### 5.3. Recommendation: Path A1

**Path A1 preserves the SPEC §17.6 commitment-14 invariant** and adds
Option (a) as an *acceleration tier* for Node-side workloads (SSR,
`@causl/sync`, bench harness, property-test host). The WASM stack
remains the browser floor with no degradation. The 213 KB / 66 KB
serde-bridge current-state callout (#1150) is frozen in place; no
further re-tightening work is on the critical path; the bridge
becomes the documented browser-tier fallback rather than the
performance target.

**Path A2 is on the table only if the team agrees that the library's
positioning has shifted from "interactive UIs" to "server-side state
management."** That is a product question, not an engineering
question, and it is not this study's place to make it.

---

## 6. Effort estimate

Post-research, the work decomposes into PR-shaped chunks roughly the
same size as the F-marshal sub-cascade phases:

| PR group | Scope | Estimate (PR count) | Notes |
| --- | --- | ---: | --- |
| **A. napi-rs scaffold** | `tools/engine-rs-napi/` new crate; minimal `#[napi]` surface (`new_graph`, `dispose`); CI wiring for one platform (linux-x64). | 1–2 | Lowest-risk; napi-rs scaffold is well-documented. |
| **B. `BackendEngine` shape over N-API** | Wire `commit`, `read`, `subscribe`, `snapshot`, `hydrate`, `readAt`, `snapshotAt`, `exportModel`, `dispose`, `evaluateStatechart`, `now`. Each method gets a napi binding + the TS-side `NativeBackend` adapter. | 3–4 | The 11-method `BackendEngine` interface from `wasm/index.ts:177-197`. Each method is a discrete PR; some can be batched (read + subscribe; snapshot + hydrate). |
| **C. Cross-backend determinism gate green** | The 1000-trial × 0-byte-difference gate runs against the native backend. Expected first-run failures: serde number-format divergence (napi-rs vs serde-json), `Object.is`-versus-`f64::eq` NaN handling. | 1–2 | The same surface F-marshal.5 hardened (#1124, #1077, #1078). Most of the byte-identity work is already paid; what's left is the N-API marshal-shape work. |
| **D. Per-platform CI prebuild matrix** | New `release-native-engine.yml` workflow; per-platform GHA matrix; artefact bundling; per-platform npm publish hooks. | 1–2 | Pattern duplicates `@causl/checker` release pipeline. |
| **E. `@causl/core` native loader** | `packages/core/src/native/index.ts`; `detectBackend()` extension for native tier; fallback chain wiring (native → wasm tier 1 → tier 2 → tier 3 → JS). | 1 | The fallback chain pattern is established; this is essentially a tier-prepend. |
| **F. Bench harness — perf measurement on native tier** | `packages/bench/scripts/g1-perf-measurement-native.ts`; run the six contract-bearing cells under native; produce the projection-vs-measurement table. | 1 | Validates the §1 projections. Required to commit to GO. |
| **G. SPEC §17.6 row update + adopter migration guide** | Update the host-tier table; new `docs/native-adoption-guide.md`; CHANGELOG entry; codemod for `'wasm'` → `'native'` in `createCausl({ backend })`. | 1–2 | Path A1 only; Path A2 would expand this to the §17.6 amendment + deprecation. |
| **Total** | | **9–14 PRs** | Plus 1–2 buffer PRs for unanticipated napi-rs incompatibilities, byte-identity divergences, or platform-specific build failures. |

**Wall-clock estimate**: 6–10 weeks at one PR every 3–4 days,
assuming napi-rs has no serde incompatibility blocker. If group C
surfaces a number-format or NaN divergence that requires custom
N-API marshaling (a hand-rolled `JsonValue` ↔ `napi::Value` shim
rather than serde-json round-trip), add **2–4 weeks** for that
work (precedent: F-marshal.5 byte-identity hardening took
approximately that long).

**Best case**: 6 weeks, 9 PRs. **Worst case**: 14 weeks, 15 PRs
(with a serde divergence surfacing in group C).

---

## 7. Adopter migration story

Existing adopters today consume `@causl/core` against either:

1. **The default TS engine** — `createCausl()` with no backend, or
   `createCausl({ backend: 'js' })`.
2. **The opt-in WASM engine** — `createCausl({ backend: 'wasm' })`,
   or `createCausl({ backend: 'auto' })` with `auto-adapt` flipping
   to WASM based on workload.

**With Option (a) Path A1**, the migration is purely additive:

| Adopter shape | Pre-Option-(a) | Post-Option-(a) Path A1 |
| --- | --- | --- |
| Pure-Node SSR adopter | TS engine | `createCausl({ backend: 'native' })` — runs through napi-rs into the prebuilt `.node` binary. **5–30× faster** on contract-bearing cells (per §1 projection) than WASM. |
| Browser-only adopter | TS engine or WASM tier-1/2/3 | unchanged — native does not affect the browser tier. |
| Auto-adapt adopter | `'js' \| 'wasm' \| 'auto'` | `'js' \| 'wasm' \| 'native' \| 'auto'` — `auto` now flips between three engines based on `process.platform`-aware thresholds. **Migratable surface per CONSTRAINTS §1b** (the literal type changes, requires a typed deprecation cycle or a codemod). |
| Cloudflare Workers adopter | WASM tier-3 | unchanged — Workers don't run native. |
| React Native / Hermes adopter | JS fallback | unchanged. |

**With Option (a) Path A2** (drop browser), the migration is
**breaking** for browser-side adopters:

| Adopter shape | Pre-Option-(a) | Post-Option-(a) Path A2 |
| --- | --- | --- |
| Browser-only adopter | TS engine | **broken** — no engine. Adopter must rewrite to server-side state management. |
| Cloudflare Workers adopter | WASM tier-3 | **broken**. |
| Pure-Node SSR adopter | TS engine | `createCausl({ backend: 'native' })`. |

**Codemod surface** (Path A1 only — Path A2 is a different product):

- `pnpm causl codemod backend-native` — flips `backend: 'auto'` to
  `backend: 'native'` for adopters who want to commit to native and
  skip the auto-detect overhead.
- `pnpm causl lint backend-platform-mismatch` — ESLint rule warning
  when `backend: 'native'` is hardcoded and the build target includes
  the browser (via `vite.config.ts` `build.target` introspection or
  package.json `browser` field).

**Adopter checklist** (new `docs/native-adoption-guide.md`):

- Are you running in Node? Yes → `'native'` is faster.
- Are you running in a browser? Yes → `'wasm'` (or auto-fallback)
  is the only path.
- Are you running in Cloudflare Workers / Deno / React Native? Same
  as browser.
- Are you running an internal CI bench harness or property-test
  suite? `'native'` is the recommended target.

---

## 8. Constraint rubric checklist (fills option-(a) column of `CONSTRAINTS.md` §6 rubric)

| Constraint | Option (a) native binary | Evidence |
| --- | --- | --- |
| **§1a Non-negotiable adopter surface preserved without codemod** | YES (Path A1) / NO (Path A2 — `Bridge` / `BridgeFeatures` / `WasmBackendUnavailableError` retire under A2) | `packages/core/src/types.ts:851-1476` unchanged; `packages/core/wasm/index.ts:177-197` `BackendEngine` interface plugged into by `NativeBackend` adapter under A1. |
| **§1b Migratable surface — codemods + lints required** | YES — backend literal type extends; `'wasm'` codepath kept (A1) or deprecated (A2); ESLint rule `backend-platform-mismatch`. | `packages/core/src/auto-adapt.ts` `'js' \| 'wasm' \| 'auto'` becomes `'js' \| 'wasm' \| 'native' \| 'auto'`. Deprecation cycle per CONSTRAINTS §1b. |
| **§2 Browser deployment** | A1: YES (via WASM/JS fallback); A2: NO (requires §17.6 amendment) | CONSTRAINTS §2 row "Browser (Chrome 95+ / Firefox 102+ / Safari 16+)" + SPEC §17.6 commitment 14 (SPEC.md:2722). |
| **§2 Node deployment** | YES — prebuilt `.node` artefact resolved via `optionalDependencies`. | §4.2 / §4.4; mirrors `@causl/checker-{darwin,linux,win32}-*` model. |
| **§2 Native deployment (per-platform binary)** | YES — five-row platform matrix per §4.4. | `packages/checker-*/package.json` model reused verbatim. |
| **§2 Cloudflare Workers / edge** | A1: YES (WASM tier-3 unchanged); A2: NO. | CONSTRAINTS §2 row + SPEC §17.6. |
| **§2 Embedded runtimes (RN, Hermes) — TS fallback floor preserved** | A1: YES (JS fallback untouched); A2: NO. | CONSTRAINTS §2 row + SPEC §17.6 commitment 14 "no host stranded." |
| **§3 Per-commit perf — ≤ 50 ns per op boundary tax on every contract-bearing cell** | **NO** — N-API best case is 0.5–1.0 μs, 10–20× over the floor. | §1.1 projection vs CONSTRAINTS §3 perf-floor arithmetic. |
| **§3 `equality-cutoff` cell ≤ 2.017 ms / 10k (TS baseline)** | LIKELY YES at the cell-total level — N-API boundary tax × 10k = 5–80 ms vs TS workload 2.0 ms, so the native engine still loses on this cell if it has to make a per-commit crossing. **Native wins only when the engine work it accelerates is bigger than the boundary tax it adds.** | §1.1 + G.1 cell numbers. |
| **§3 `scrolling-viewport` cell ≤ 0.112 ms / 10k (TS baseline)** | **NO** — boundary tax × 10k = 5–80 ms vs TS workload 0.112 ms. Native loses on the smallest cell. Same kill criterion that fired #1133. | §1.1 + G.1 cell numbers (CONSTRAINTS §3 table row). |
| **§3 `spreadsheet-100x100` cell ≤ 0.334 ms / 10k (TS baseline)** | **NO** — same arithmetic. | §1.1 + G.1. |
| **§3 SPEC §17.5 band held (3.0× ≤ causl/mobx ≤ 8.0×) on contract-bearing cells** | UNKNOWN — depends on actual measurement after group F. Projection: tightens by 5–30× on large-workload cells; **widens** on small-workload cells (scrolling-viewport, spreadsheet). | §1.1 + SPEC §17.5 status callout (post-G.1 retirement of the 1.0×–4.0× pre-measurement projection). |
| **§4 TS + new engine coexist for N versions (gradual migration)** | YES (A1 — three engines coexist) / YES with deprecation (A2 — WASM retires). | §7 migration table; CONSTRAINTS §4 row. |
| **§4 `createCausl({ backend: 'auto' })` runtime swap surface preserved** | YES — `'native'` is added to the literal union; `auto-adapt.ts` gains a native arm. | CONSTRAINTS §4 row + `packages/core/src/auto-adapt.ts`. |
| **§4 Cross-backend determinism gate green (1000 trials × 0 byte differences)** | LIKELY YES — same engine kernel as WASM; serde-shape divergence is the named risk. Hardening precedent: F-marshal.5 PR #1477. | `packages/core/test/properties/cross-backend-determinism.property.test.ts`; #1124 amendment hardening. |
| **§4 `Object.is` SameValue parity (incl. NaN / ±0 / lone surrogates)** | YES — inherited from the engine-rs-core hardening (#1077, #1078); napi-rs marshal layer must preserve. PLAN.md row "Engine semantics" risk applies. | SPEC §15.1 + #1124; PLAN.md rows 23–26. |
| **§5 SPEC §5.1 Phase A–H named-phase sequencing preserved** | YES — engine-internal; same kernel as WASM. | SPEC §5.1; `tools/engine-rs-core/src/transition/`. |
| **§5 SPEC §5.1 Amendment 4 — Phase G IndexMap-shaped container** | YES — `tools/engine-rs-core/Cargo.toml` already pins `indexmap`. | `Cargo.toml` line `indexmap = { version = "2", default-features = false, features = ["serde"] }`. |
| **§5 SPEC §3 Theorem 2 uninterruptibility (no microtask in marshal)** | YES — N-API synchronous calls are uninterruptible at the marshal boundary; same as WASM. | SPEC §3 Amendment (#1333). |
| **§5 SPEC §15.1 value-identity at fixed `GraphTime` (reference identity opt-in)** | YES — already softened by the §15.1 amendment ahead of any backend swap. | SPEC §15.1 amendment (#1124). |
| **§5 SPEC §17.6 host-tier matrix preserved (no host stranded)** | A1: YES (matrix extends with a native tier); A2: NO (requires §17.6 amendment). | SPEC §17.6; §5.1 / §5.2 above. |
| **Adopter migration cost (codemods needed, deprecation length, RC track)** | A1: low — additive; one minor-N deprecation if `'auto'` literal changes shape. A2: high — browser adopters fully rewrite. | §7. |
| **What's reused from #1133's 75 PRs (engine-rs-core, marshaler, bridge crates)** | engine-rs-core verbatim (~12k LOC); tests verbatim (~4k LOC); SPEC amendments verbatim; bridge crates kept under A1, discarded under A2. | §2.1. |
| **What's thrown away from #1133's 75 PRs** | A1: nothing (bridges become maintained fallback); F-marshal sub-cascade engineering investment becomes sunk-cost. A2: ~3.4k LOC + wasm toolchain. | §3. |
| **Realistic effort estimate (post-research, weeks)** | 6–10 weeks (best) / 10–14 weeks (with serde divergence). | §6. |
| **Kill-criterion: workload below which this architecture's boundary cost dominates the TS workload** | `scrolling-viewport` × 10k (TS 0.112 ms, native boundary 5–80 ms): native loses by 50–700×. **Native engine wins only on workloads where engine-work × 10k > 5–80 ms** — i.e., 10k+ commits where each commit does ≥ 0.5 μs of work in the kernel. Most contract-bearing cells don't clear this bar with current measurements. | §1.1 + CONSTRAINTS §3. |

---

## 9. Honest GO/NO-GO recommendation

**NO-GO at the SPEC §3 50 ns / op perf-floor as written in
CONSTRAINTS.md §3.** Option (a)'s best-case boundary tax is
~0.5–1.0 μs / op — 10–20× over the floor — and the floor was set
precisely to falsify any architecture that doesn't beat it (it's the
arithmetic that retired #1133). N-API is faster than WASM by a factor
of 5–30 on the boundary, but the boundary is still there.

**CONDITIONAL-GO if CONSTRAINTS §3 is amended** to recognise that no
boundary-crossing architecture clears the strict floor, and the
comparison axis shifts to "Node-tier acceleration where engine-work
amortises the boundary." The honest framing is:

- Option (a) is **the right answer for the Node tier** if the bench
  measurement (group F PR) confirms a 5–30× speedup on the contract-
  bearing cells that have non-trivial engine work (`linear-chain`,
  `batch-commit`, `equality-cutoff-fanout-10k`).
- Option (a) is **not the right answer for the browser tier** (no
  effect there) and is **a regression on small-workload cells**
  (`scrolling-viewport`, `spreadsheet-100x100` per-commit), where
  the boundary tax dominates.
- Option (a) is **strictly inferior to options (b) and (c) at the
  arithmetic floor** — they have credible paths to ≤ 50 ns / op
  (in-place mutation eliminates the per-op marshal; batched commit
  amortises across batches). Option (a) does not.

**Preferred sub-path for browser-deployment**: **Path A1** — keep the
WASM/JS fallback as the browser tier; native is acceleration for
Node. Path A2 (drop browser) is a product question and out of scope
for this engineering feasibility.

**Confidence**: medium-high.

- The napi-rs numbers are public and reproducible (https://napi.rs,
  benchmarks across `@swc/core`, `@parcel/source-map`, `@node-rs/*`).
- The boundary tax arithmetic transposes cleanly from F-marshal.6's
  15.64 μs / op WASM measurement and the napi-rs no-op-call benchmark
  (~0.05 μs).
- The browser bite is a SPEC question (Path A1 vs A2), not an
  engineering one; the engineering answer is unambiguous.
- The remaining uncertainty is in group C — whether napi-rs's serde
  marshal preserves the byte-identity contract (#1124, F-marshal.5
  1000-trial gate). If napi-rs needs a hand-rolled `JsonValue` shim,
  add 2–4 weeks.

**Recommendation to #1483 epic body**: file Option (a) **alongside**
options (b) and (c), not in competition with them. Option (a) is the
"if we're doing Rust at all, this is the Node-tier story" answer; it
does not address the browser-tier perf bite that the §17.5 residual
band names. The full answer to #1483 is most likely a hybrid —
(a) for Node, (b) or (c) for the browser tier — and the three
feasibility studies should be read as complementary, not as a
three-way bake-off.
