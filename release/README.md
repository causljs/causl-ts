# causl 0.2.0 — release bundle

This directory is built by `tools/release/release.py`. It contains the
minimum viable subset of `@causl/*` packages needed to ship a real
TypeScript application against the causl engine — the **TypeScript-only
path**; no WASM artefacts, no native checker binaries.

## Sizes

| Package | Runtime (brotli) | + Types (brotli) | Raw on disk |
| --- | ---: | ---: | ---: |
| **@causl/core** v0.2.0 (`packages/causl-core/`) | 21.43 KiB | 47.50 KiB | 297.0 KiB |
| **@causl/sync** v0.2.0 (`packages/causl-sync/`) | 3.83 KiB | 2.38 KiB | 20.0 KiB |
| **@causl/react** v0.2.0 (`packages/causl-react/`) | 2.27 KiB | 12.73 KiB | 56.2 KiB |
| **@causl/formula** v0.2.0 (`packages/causl-formula/`) | 5.03 KiB | 9.22 KiB | 52.8 KiB |
| **TOTAL** | **32.57 KiB** | 71.83 KiB | 426.0 KiB |

**Runtime (brotli)** is the headline number — the compressed `.js`
that an adopter's browser fetches over the wire after the bundler
tree-shakes its dependency graph. Matches the SPEC §17.6 / size-limit
gate cell definitions in the source workspace.

**+ Types (brotli)** is the install-time-only `.d.ts` payload —
type declarations the TypeScript compiler consumes; never shipped to
the browser at runtime.

**Raw on disk** is every byte under each package's `dist/` directory.
Useful only as a sanity check; not a meaningful "release size" number.

Total runtime payload across the four bundled packages:
**32.57 KiB (brotli)**.

## Install (per package, from this directory)

```sh
pnpm add ./packages/causl-core
pnpm add ./packages/causl-sync       # peer of causl-react
pnpm add ./packages/causl-react      # if you're using React
pnpm add ./packages/causl-formula    # if you're using the formula DSL
```

Or, if `--tarballs` was passed to the build script, install the `.tgz`
files directly:

```sh
pnpm add ./packages/causl-core/causl-core-0.2.0.tgz
```

## What's excluded vs the source workspace

- All WASM artefacts (`@causl/core/wasm` subpath; `@causl/core` exports
  the TypeScript engine only in this bundle).
- `@causl/checker` and its platform-specific native binary shards.
- `@causl/sync`, `@causl/persistence`, `@causl/devtools`,
  `@causl/devtools-bridge`, `@causl/hypothesis`,
  `@causl/migration-check`, `@causl/sync-testing-internal`.
- The `./internal` and `./testing` subpath exports on `@causl/core`
  (these are reserved for cross-package internals and test helpers).
- Source maps (`*.map`) and the `//# sourceMappingURL=...` trailers
  in `.js` files.

If you need any of the above, install from the source workspace
instead — this bundle is deliberately narrow for production app
deployments that want a small dependency footprint.

## Reproducing this bundle

```sh
pnpm -r build           # produce the source dist trees
python3 tools/release.py   # build this directory
```

For the full surface (every subpath export retained, source maps kept):

```sh
python3 tools/release.py --full
```

## Manifest

See `manifest.json` for a machine-readable index — name, version,
per-package size (raw / runtime-compressed / types-compressed /
compression algorithm used), and (when `--tarballs` is passed)
tarball SHA-256.
