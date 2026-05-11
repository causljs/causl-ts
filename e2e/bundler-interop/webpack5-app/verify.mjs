#!/usr/bin/env node
// Post-build verification for the webpack 5 bundler-interop fixture.
//
// Gates (all enforced from #689 exit criteria):
//   1. `dist/` contains a `main.*.js` entry chunk.
//   2. The main chunk does NOT contain `loadWasmBackend` or
//      `WasmBackendUnavailableError` sentinels (bundle-no-wasm-leak).
//   3. Some other chunk (the lazy split for @causl/core/wasm) DOES
//      contain those sentinels (proves the dynamic import was
//      preserved and the lazy seam works).
//   4. The main chunk DOES contain `createCausl` body (sanity that
//      the static import didn't get dropped to a no-op).
//
// Exits 0 on success, non-zero with a one-line reason on failure.
// Designed to run after `npm run build`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const distDir = new URL('./dist/', import.meta.url).pathname

function fail(msg) {
  process.stderr.write(`[webpack5 verify] FAIL: ${msg}\n`)
  process.exit(1)
}
function info(msg) {
  process.stdout.write(`[webpack5 verify] ${msg}\n`)
}

let files
try {
  files = readdirSync(distDir)
} catch {
  fail(`no dist/ directory at ${distDir} — did the build run?`)
}

const jsFiles = files
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f, full: join(distDir, f) }))

if (jsFiles.length === 0) {
  fail('dist/ contains no .js files')
}

const mainCandidates = jsFiles.filter((f) => f.name.startsWith('main.'))
if (mainCandidates.length !== 1) {
  fail(
    `expected exactly one main.*.js, found ${mainCandidates.length} (${mainCandidates.map((f) => f.name).join(', ')})`,
  )
}
const main = mainCandidates[0]
const mainText = readFileSync(main.full, 'utf8')

const WASM_SENTINELS = ['loadWasmBackend', 'WasmBackendUnavailableError']
const leaked = WASM_SENTINELS.filter((s) => mainText.includes(s))
if (leaked.length > 0) {
  fail(
    `bundle-no-wasm-leak gate failed — main chunk ${main.name} contains: ${leaked.join(', ')}`,
  )
}

// Sanity: main must actually reference our entry sentinel
// (`__causlHandle` — set by src/index.js, preserved across
// minification because it's a property assignment on the globally
// observable `globalThis`). If webpack shook everything to nothing,
// the bundle-no-leak gate above would trivially pass on an empty
// bundle, so we anchor this from the other side.
if (!mainText.includes('__causlHandle')) {
  fail(
    `main chunk ${main.name} does not reference __causlHandle — entry was tree-shaken to a no-op?`,
  )
}

// Some other chunk must contain the lazy-load symbols.
const otherChunks = jsFiles.filter((f) => f.name !== main.name)
const lazyChunk = otherChunks.find((f) => {
  const text = readFileSync(f.full, 'utf8')
  return WASM_SENTINELS.every((s) => text.includes(s))
})
if (!lazyChunk) {
  fail(
    `no chunk other than ${main.name} contains the wasm-loader sentinels — dynamic import was inlined? Chunks present: ${otherChunks.map((f) => f.name).join(', ') || '(none)'}`,
  )
}

info(`OK — main chunk ${main.name} (${statSync(main.full).size} B)`)
info(`OK — lazy chunk ${lazyChunk.name} contains wasm loader symbols`)
process.exit(0)
