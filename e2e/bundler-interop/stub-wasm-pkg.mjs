#!/usr/bin/env node
// Stub WASM artifacts for the bundler-interop fixtures (#689).
//
// `packages/core/wasm/index.ts` resolves its `.wasm` artifact URL via
// `new URL('./pkg/<segment>/engine_rs_bg.wasm', import.meta.url)`.
// Bundlers (webpack 5 / Vite 5 / esbuild) statically analyse that
// pattern at build time and resolve the directory on disk to produce
// asset references. In a production build the artifacts exist
// (committed or produced by `pnpm wasm:build`). In CI for #689 the
// crates are still landing, so we stub minimal-valid `.wasm` files
// next to the built `wasm.js` so the bundler-interop gates can run.
//
// The stubs are NEVER loaded — `loadWasmBackend()` throws
// `WasmBackendUnavailableError` before reaching the fetch path. The
// only purpose is to satisfy build-time URL resolution.
//
// Layout (after running):
//   packages/core/dist/pkg/serde/engine_rs_bg.wasm        (8 bytes)
//   packages/core/dist/pkg/gc-builtins/engine_rs_bg.wasm  (8 bytes)
//   packages/core/dist/pkg/gc-classic/engine_rs_bg.wasm   (8 bytes)
//
// Each is the minimal valid WASM module — the 8-byte preamble:
//   `\0asm` magic (4 B) + version 1 little-endian (4 B).
// Real WASM modules add type/function/export sections after this; the
// bundler doesn't care about the body, only the magic + version, and
// even that is only checked if the bundler tries to instantiate it
// (which none of our fixtures do).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const pkgRoot = resolve(repoRoot, 'packages/core/dist/pkg')

const SEGMENTS = ['serde', 'gc-builtins', 'gc-classic']

// 8-byte minimal-valid WASM preamble.
const WASM_PREAMBLE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
])

for (const seg of SEGMENTS) {
  const dir = resolve(pkgRoot, seg)
  mkdirSync(dir, { recursive: true })
  const wasmPath = resolve(dir, 'engine_rs_bg.wasm')
  writeFileSync(wasmPath, WASM_PREAMBLE)
  process.stdout.write(`[stub-wasm-pkg] wrote ${wasmPath}\n`)
}

process.stdout.write('[stub-wasm-pkg] OK\n')
