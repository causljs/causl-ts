# `packages/core/wasm-pkg/` — bridge artefact tree

> **Build driver not present in this TS-only repo.** There is **no**
> `tools/wasm-build/build.mjs` in this checkout and `pnpm wasm:build`
> is not wired here — this repo is the pure-TypeScript reference. The
> committed `.wasm` artefacts described below are the **real built
> binaries** (~214 KB serde / ~249 KB gc-builtins / ~246 KB gc-classic
> raw), produced by the Python build/package tooling in
> [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm)
> (`scripts/build_wasm.py` runs `wasm-pack` + `wasm-opt`;
> `scripts/package_wasm.py` places the `.wasm` + glue + typings at a
> consumer's `--dest`) and vendored here so the size-limit cells and
> bundler-resolution fixtures gate against real bytes. The
> `pnpm wasm:build` / `tools/wasm-build` references below are retained
> as the **historical layout** these artefacts were modelled against;
> treat them as describing the artefact tree shape, not a command
> runnable from this repo.

Per-bridge `.wasm` artefacts (in `causljs/causl-wasm`, produced by its
Python build tooling — see the note above). Per issue #1103 each
bridge ships TWO subdirectories — one per wasm-pack target:

  - `<bridge>-bundler/` — `--target bundler` shim. Consumed by the
    `@causl/core/wasm` loader (resolves the artefact via
    `new URL('./pkg/<bridge>/engine_rs_bg.wasm', import.meta.url)`) +
    the bundler-interop fixtures under `e2e/bundler-interop/`. Needs
    a host bundler (webpack 5 / Vite 5 / esbuild) to rewrite the
    asset reference.
  - `<bridge>-nodejs/`  — `--target nodejs` shim. Consumed by Node-
    side test runners (notably the cross-bridge byte-identity property
    suite in `packages/core/test/properties/bridge-roundtrip.property.test.ts`,
    PR #1102 / issue #1071) that need to `import()` the shim directly
    from Node's ESM loader without a bundler step. The shim uses
    `fs.readFileSync` + `WebAssembly.instantiate` synchronously.

The three bridges are:

  - `serde-{bundler,nodejs}/`       — universal WebAssembly 1.0 baseline.
    Ships against the serde-json bridge in
    `tools/engine-rs-bridge-serde/`. Adopters on any host that runs
    WASM at all get this artefact.
  - `gc-builtins-{bundler,nodejs}/` — WasmGC + `wasm:js-string` direct
    imports. Ships against the GC bridge in
    `tools/engine-rs-bridge-gc/` compiled with the
    `js-string-builtins` cargo feature.
  - `gc-classic-{bundler,nodejs}/`  — WasmGC without `wasm:js-string`
    (UTF-16 fallback). Ships against the same GC bridge compiled with
    the `classic-strings` cargo feature.

The size-limit budgets at the root `package.json#size-limit` cells
gate each bridge (per-bridge, not per-target — wasm-pack emits
byte-identical `.wasm` regardless of the `--target` flag, so the
`-bundler/` cells are the canonical raw-byte gate):

  - serde       ≤ 230 KB raw / 70 KB Brotli q11
  - gc-builtins ≤ 260 KB raw / 80 KB Brotli q11
  - gc-classic  ≤ 260 KB raw / 80 KB Brotli q11

  (SPEC §17.6 / #692 targets — 200/80, 110/45, 120/50 KB — remain the
  aspirational floor pending the `engine-rs-core` slim tracked in the
  #1085 follow-up. The gc caps were ratcheted by #1117 once the gc
  bridge was wired to call the real `transition_phased`.)

(The Brotli ceilings are enforced in the `pnpm wasm:build` post-step;
the raw ceilings are the `size-limit` cell budgets activated by
Sub-E (#1063) closeout.)

## Committed artefacts

The six `engine_rs_bg.wasm` files committed alongside this README
(one per `<bridge>-<target>/` directory) are the **real built
WebAssembly binaries** — valid WASM 1.0 modules carrying the
`\0asm\x01\x00\x00\x00` preamble followed by the full compiled engine
body. Their raw sizes are:

  - `serde-{bundler,nodejs}/`       — 219,599 bytes (~214 KB)
  - `gc-builtins-{bundler,nodejs}/` — 254,604 bytes (~249 KB)
  - `gc-classic-{bundler,nodejs}/`  — 252,117 bytes (~246 KB)

(wasm-pack emits byte-identical `.wasm` from `--target bundler` and
`--target nodejs`, so the two subdirectories per bridge hold the same
bytes.) They satisfy:

  1. Bundler resolution: `new URL('./pkg/<segment>/engine_rs_bg.wasm',
     import.meta.url)` resolves to an existing file at build time so
     webpack 5 / Vite 5 / esbuild's static-analysis pass produces a
     valid asset reference. The bundler-interop fixtures under
     `e2e/bundler-interop/` resolve against these committed binaries.

  2. `size-limit` cell activation: the per-bridge cells in the root
     `package.json#size-limit` array gate against the file at each
     path. Because the committed artefacts are the real bytes, the
     caps bite today — a PR that pushes the `serde-json` artefact past
     its raw ceiling fails the gate. (The current serde body sits at
     ~214 KB raw against the 230 KB cell; see the `//size-limit-wasm`
     comment in the root `package.json` for the §17.6 divergence note.)

The artefacts are NOT loaded at runtime on the current Phase-1 path —
`loadWasmBackend()` in `packages/core/wasm/index.ts` resolves the URL
via `wasmUrlFor()` but the Phase-1 path constructs a `WasmBackend`
that wraps a TS engine without calling `WebAssembly.instantiate`. The
URL resolution itself is preserved so a future PR that wires the real
engine in gets a working code path on the first compile.

## Refreshing the artefacts

The artefacts are **not** built from this repo. They are produced
in [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm) by its
Python build tooling — `scripts/build_wasm.py` (needs the Rust
toolchain; runs `wasm-pack build` per bridge crate + `wasm-opt -Oz`)
and `scripts/package_wasm.py` (stdlib-only CPython; places the
`engine_rs_bg.wasm` + generated TypeScript bindings at a consumer's
`--dest` and emits a version + sha256 manifest). When a refreshed
build is vendored over the binaries in the directories above, the
size-limit cells gate against the produced bytes; a PR that pushes a
bridge past its cap fails the `size` job until the cap is renegotiated
under the SPEC §14.2.1 written-team-consensus rule.

## See also

  - `packages/core/wasm/README.md` — adopter-facing loader docs +
    Tier-1/2/3 host-substrate compatibility matrix (SPEC §17.6).
  - `tools/engine-rs-bridge-serde/`, `tools/engine-rs-bridge-gc/` —
    Rust crates that compile to the artefacts here.
  - `docs/wasm-adoption-guide.md` — adopter checklist + CSP /
    preload / SRI posture for the loaded `.wasm` artefacts.
  - Issues #680 (EPIC), #683 (build pipeline), #689 (bundle hygiene),
    #1063 (Phase-1 closeout — this README's authoring change),
    #1103 (per-bridge dual-target layout: `-bundler/` + `-nodejs/`).
