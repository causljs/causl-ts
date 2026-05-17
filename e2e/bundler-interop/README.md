# Bundler interop fixtures (#689)

Three minimal fixture apps that import `@causljs/core` (main barrel) and
dynamically import `@causljs/core/wasm` (lazy-load entry point per #684).
CI builds each on every PR; failures attributable to a specific
bundler are labelled by matrix-leg name.

Issue #689 closed via #1058 (initial fixtures + CI gate) with the
size-limit + tier-matrix residuals subsequently retired by #1063
(Sub-E closeout) and #1085 (size-limit cells activated).

| Fixture          | Bundler   | Notes                                                        |
| ---------------- | --------- | ------------------------------------------------------------ |
| `webpack5-app/`  | webpack 5 | `experiments.asyncWebAssembly: true`; default code-split.    |
| `vite5-app/`     | Vite 5    | rollup-based prod build; lazy `import()` produces a chunk.   |
| `esbuild-app/`   | esbuild   | bundle + splitting + ESM output.                             |

## What each fixture asserts

1. **`@causljs/core` main barrel bundles cleanly** — the package exports
   only TypeScript / JS; no native or WASM deps reachable.
2. **`@causljs/core/wasm` lazy import produces a separate chunk** — the
   loader from #684 (`packages/core/wasm/index.ts`) is reachable via a
   `import('@causljs/core/wasm')` call without bundle-time errors. Phase-1
   `loadWasmBackend()` now returns a `WasmBackend` that wraps a TS
   engine (the wasm-pkg artefacts produced by #682/#683/#693 have
   landed; per #1063 Sub-E closeout the runtime path is exercised by
   the Phase-1 implementation, while `WasmBackendUnavailableError` is
   retained for the narrow legacy-detection case described in
   `packages/core/wasm/index.ts`). That runtime behaviour is outside
   the scope of these fixtures — the gate here is still "the bundler
   can resolve the entry point" and "the dynamic import is preserved
   as a code-split rather than inlined" (verified by each fixture's
   `verify.mjs`).
3. **The main entry does not statically pull the loader symbols** —
   each fixture's CI step greps the main bundle output for the
   `WasmBackendUnavailableError` / `loadWasmBackend` sentinels (mirrors
   `packages/core/test/wasm-loader.test.ts`'s in-process check).

## Why these aren't pnpm workspace members

The fixtures install their own deps (webpack / vite / esbuild) on CI to
mirror how an external adopter consumes `@causljs/core`. Pulling them
into the workspace would let them resolve workspace devDependencies
they would not have access to in the wild, defeating the purpose of
the gate.

Each fixture references the workspace `@causljs/core` via a `file:`
specifier in its `package.json`, so the CI step
`pnpm --filter @causljs/core build` runs first and the bundler picks up
the freshly-built `dist/` directly.

## Run locally

```sh
pnpm --filter @causljs/core build
cd e2e/bundler-interop/webpack5-app && npm install && npm run build
cd ../vite5-app && npm install && npm run build
cd ../esbuild-app && npm install && npm run build
```

## Scope deferrals (per #689)

- **Per-bundler-version matrix** (webpack 5 / Vite 5 / esbuild 0.20
  pinned exactly): we pin minor-equivalent floors; CI runs latest
  within the pinned major. Tighter pinning is a follow-up if drift
  hits us.
- **Streaming-instantiate browser smoke tests** (Chromium / Firefox /
  Safari-TP / Node 18/22 / workerd / bun): out of scope here — the
  fixtures gate bundle-time correctness, not runtime
  `WebAssembly.instantiateStreaming` behaviour. Tier-matrix runtime
  smoke landed under #1053 (three-tier host matrix —
  wasmgc-builtins / wasmgc-classic / serde-json — shipped as the
  §17 commitment 14 deliverable).
- **Per-bridge size-limit cells** (`wasm-pkg/{gc-builtins,gc-classic,serde}`):
  activated by #1085 (raw-byte ceilings) and #1063 (Brotli post-step).
  Caps were ratcheted by #1117 once the GC bridge was wired to call
  the real `transition_phased`. See
  `packages/core/wasm-pkg/README.md` for the current per-bridge
  budgets and the SPEC §17.6 aspirational floors tracked in #1085's
  follow-up.

Per #1103 the build driver now emits both `--target bundler` and
`--target nodejs` artefacts per bridge, so the wasm-pkg tree contains
six directories (`<bridge>-bundler/` + `<bridge>-nodejs/` for each of
`serde`, `gc-builtins`, `gc-classic`). These bundler-interop fixtures
exercise only the `bundler` half; the `nodejs` shim is consumed by
the cross-bridge byte-identity property test
(`packages/core/test/properties/bridge-roundtrip.property.test.ts`,
PR #1102 / issue #1071). The fixture-time stub script
(`stub-wasm-pkg.mjs`) still writes the single `pkg/<segment>/`
layout that `loadWasmBackend()`'s `wasmUrlFor()` resolves at
runtime; the source-of-truth `packages/core/wasm-pkg/` directory
holds the dual-target tree.

See `.github/workflows/wasm.yml` job `bundler-interop` for the CI wiring.
