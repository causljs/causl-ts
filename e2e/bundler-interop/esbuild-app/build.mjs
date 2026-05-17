#!/usr/bin/env node
// esbuild bundler-interop fixture build driver (#689).
//
// We invoke esbuild via its JS API rather than the CLI so the config
// (splitting, format, loader for .wasm) is declared in one
// reviewable place, and so future flags can be added without
// re-encoding them in package.json scripts.
//
// Output:
//   - `dist/main.js` (the entry chunk).
//   - `dist/chunk-<hash>.js` (the @causljs/core/wasm split — esbuild's
//     `splitting: true` is mandatory for dynamic-import code-split
//     to land in a separate chunk; without it, esbuild inlines the
//     dynamic import and the bundle-no-leak gate fails).

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(here, 'src/index.js')],
  outdir: resolve(here, 'dist'),
  bundle: true,
  // ESM + splitting is the only combo where esbuild produces a
  // separate chunk per `import()`. CommonJS + splitting is rejected
  // by esbuild itself.
  format: 'esm',
  splitting: true,
  // Code that targets a modern browser is the right shape for
  // adopters loading @causljs/core/wasm — older targets would force
  // esbuild to polyfill `import()` itself.
  target: ['es2022'],
  // Adopters loading raw .wasm via `new URL('./pkg/...', import.meta.url)`
  // need the file loader so the bytes ship as an asset rather than
  // a base64 inline.
  loader: { '.wasm': 'file' },
  minify: false,
  metafile: false,
  // Logging on a failure is more useful than a swallowed stderr.
  logLevel: 'info',
}).catch((err) => {
  process.stderr.write(`[esbuild fixture build] FAILED: ${err.message}\n`)
  process.exit(1)
})

process.stdout.write('[esbuild fixture build] OK\n')
