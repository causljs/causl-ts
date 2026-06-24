# tools/release

Builds the minimum viable per-package npm tree for the TypeScript-only
path of `@causl/*` at the current `RELEASE_VERSION` (the last committed
cut in `release/` is **0.2.0**; the source workspace has since moved to
`@causl/core` `0.3.1`, so a fresh run will carry a newer version once
`RELEASE_VERSION` is bumped — see "Cutting a new release version"
below). Produces the `release/` directory that gets committed to the
`release` branch and is what adopters install from when they want the
smallest possible causl footprint.

## Usage

```sh
pnpm -r build                     # produce the source dist trees
python3 tools/release/release.py  # build ./release/
```

That's it. No dependencies beyond Python 3.10+. The script is
idempotent — `release/packages/` is nuked + rebuilt on every run.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--out <dir>` | `./release` | Output directory. Created if missing. |
| `--full` | off | Keep every `dist/` file (source maps included) and every `package.json#exports` subpath entry. Larger bundle; useful when adopters need `./internal`, `./testing`, or `./wasm`. |
| `--tarballs` | off | Additionally run `npm pack` in each generated package directory and record the resulting `.tgz` (filename, SHA-256, byte size) in `manifest.json`. Requires `npm` on `PATH`. |

## What's bundled

| Package | Slim subpaths | Why |
|---|---|---|
| `@causl/core` | `./` only — `./internal`, `./testing`, `./wasm` dropped | TS-only path; `./wasm` is the lazy-loaded WASM backend, `./internal` is reserved for cross-package internals, `./testing` is test-only |
| `@causl/sync` | `./` only — `./resource`, `./conflict` dropped | Slim default targets the main barrel; the two extra subpath entries (Phase-D resource entries) are opt-in |
| `@causl/react` | `./` only | React bindings; same shape as source |
| `@causl/formula` | `./` only | Formula DSL; same shape as source |

## What's excluded

- All WASM artefacts (`@causl/core/wasm` subpath; `packages/core/wasm-pkg/`).
- `@causl/checker` and its platform-specific native binary shards
  (`@causl/checker-{darwin,linux,win32}-{x64,arm64}`).
- `@causl/devtools`, `@causl/devtools-bridge`, `@causl/hypothesis`,
  `@causl/migration-check`, `@causl/persistence`, `@causl/sync-testing-internal`.
- Source maps (`*.map`) and the `//# sourceMappingURL=...` trailers
  in `.js` files (stripped in place on the copied artefact).
- `scripts`, `devDependencies`, and `publishConfig` fields from the
  rewritten `package.json` files.

For the full surface, install from the source workspace instead.

## Output layout

```
release/
├── README.md             — install instructions + per-package size table
├── manifest.json         — machine-readable index (name, version, bytes, slug)
└── packages/
    ├── causl-core/
    │   ├── package.json  — version bumped to 0.2.0, workspace:* → ^0.2.0,
    │   │                   exports narrowed, scripts + devDeps stripped
    │   ├── README.md
    │   └── dist/         — index.js / index.d.ts / chunks / shared .d.ts
    ├── causl-sync/
    ├── causl-react/
    └── causl-formula/
```

`manifest.json` shape:

```json
{
  "version": "0.2.0",
  "generated_by": "tools/release/release.py",
  "packages": [
    { "name": "@causl/core", "version": "0.2.0", "slug": "causl-core", "bytes": 316416 },
    ...
  ]
}
```

When `--tarballs` is passed, each entry additionally carries
`tarball`, `tarball_sha256`, and `tarball_bytes`.

## How sizes are achieved

The single biggest size win is dropping source maps. For
`@causl/core/dist/` specifically:

- Source: ~1.3 MiB
- After `*.map` removal + source-map-URL stripping: ~452 KiB
- After dropping `wasm.*`, `internal.*`, `testing.*`: ~309 KiB

The script does NOT re-minify or re-bundle. The `dist/` produced by
`tsup` is already minification-aware; further squeezing would require
calling `esbuild --minify` directly and risks breaking the existing
`#1071` cross-bridge byte-identity test infrastructure that pins on
the unmangled JS shape.

## Cutting a new release version

1. Bump `RELEASE_VERSION` at the top of `release.py`.
2. Update the `## What's bundled` table above if the package set
   changes.
3. Run `pnpm -r build && python3 tools/release/release.py`.
4. Eyeball `release/manifest.json` for the new sizes; compare against
   the previous release's `manifest.json` (kept in the `release`
   branch's git history).
5. Commit `release/` and `tools/release/` to the `release` branch.

The script intentionally does NOT bump versions in the source
workspace's `packages/*/package.json` files — the release version
lives only in the generated `release/` tree. Source `package.json`
versions remain `0.0.0` for the duration of the workspace's
changeset-driven publishing flow.

## Why a Python script (not Node)?

- Zero npm install: it runs against a `pnpm`-managed monorepo without
  adding a `package.json` of its own.
- No risk of pulling in a workspace `@causl/*` package transitively
  during its own execution.
- Stable across Node major-version churn; the script depends only on
  `pathlib`, `json`, `re`, `shutil`, `subprocess`, `dataclasses`,
  `hashlib`, and `argparse` — all stdlib since Python 3.10.

## Adding a package to the release

1. Confirm the package is required for the TS-only path (it must run
   without `@causl/core/wasm`, without `@causl/checker`, and without
   any other non-bundled package).
2. Confirm `pnpm -r build` produces a `dist/` for it.
3. Append a `PackageSpec(...)` entry to `PACKAGES` in `release.py`.
   For each entry decide:
   - `keep_subpath_exports` — which `package.json#exports` entries
     survive slim mode (`./` is always kept).
   - `drop_dist_basenames` — files under `dist/` to actively exclude
     even when `--full` is passed.
   - `slim_drop_peer_deps` — peer dependencies whose only consumer is
     a dropped subpath; pruned in slim mode.
4. Re-run; verify the new package's resolved `dependencies` /
   `peerDependencies` don't reference an excluded `@causl/*`.

## Caveats

- `dist/chunk-*.js` files are tsup code-splitting outputs shared
  across multiple entry points. The script keeps all of them rather
  than reachability-walking the imports — safer, and chunk overhead
  is small relative to the entry files.
- The script does NOT verify that the generated `release/` actually
  installs and runs. Use the upcoming `e2e/bundler-interop` harness
  against the `release/` tree to validate that.
- `--tarballs` mode is best-effort: if `npm pack` fails (e.g., the
  package directory is missing required fields), the script logs a
  warning and continues; the per-package directories are still
  usable.
