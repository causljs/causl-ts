#!/usr/bin/env node
// Post-build verification for the Vite 5 bundler-interop fixture.
//
// Same gates as webpack5-app/verify.mjs. See that file for the
// rationale; only the chunk-naming pattern differs (Vite's lib mode
// emits `dist/main.js` plus `dist/chunk.<name>.<hash>.js` per
// vite.config.js).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const distDir = new URL('./dist/', import.meta.url).pathname

function fail(msg) {
  process.stderr.write(`[vite5 verify] FAIL: ${msg}\n`)
  process.exit(1)
}
function info(msg) {
  process.stdout.write(`[vite5 verify] ${msg}\n`)
}

let files
try {
  files = readdirSync(distDir)
} catch {
  fail(`no dist/ directory at ${distDir} — did the build run?`)
}

const jsFiles = files
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  .map((f) => ({ name: f, full: join(distDir, f) }))

if (jsFiles.length === 0) {
  fail('dist/ contains no .js files')
}

const main = jsFiles.find((f) => f.name === 'main.js')
if (!main) {
  fail(
    `expected dist/main.js (lib mode entry), found: ${jsFiles.map((f) => f.name).join(', ')}`,
  )
}
const mainText = readFileSync(main.full, 'utf8')

const WASM_SENTINELS = ['loadWasmBackend', 'WasmBackendUnavailableError']
const leaked = WASM_SENTINELS.filter((s) => mainText.includes(s))
if (leaked.length > 0) {
  fail(
    `bundle-no-wasm-leak gate failed — main chunk ${main.name} contains: ${leaked.join(', ')}`,
  )
}

// Sanity anchor — `__causlHandle` survives minification (property
// assignment on `globalThis`). Without this gate the bundle-no-leak
// check would trivially pass on an empty bundle.
if (!mainText.includes('__causlHandle')) {
  fail(`main chunk ${main.name} does not reference __causlHandle`)
}

const otherChunks = jsFiles.filter((f) => f.name !== main.name)
const lazyChunk = otherChunks.find((f) => {
  const text = readFileSync(f.full, 'utf8')
  return WASM_SENTINELS.every((s) => text.includes(s))
})
if (!lazyChunk) {
  fail(
    `no chunk other than ${main.name} contains the wasm-loader sentinels. Chunks present: ${otherChunks.map((f) => f.name).join(', ') || '(none)'}`,
  )
}

info(`OK — main chunk ${main.name} (${statSync(main.full).size} B)`)
info(`OK — lazy chunk ${lazyChunk.name} contains wasm loader symbols`)
process.exit(0)
