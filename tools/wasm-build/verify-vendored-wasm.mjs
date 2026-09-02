#!/usr/bin/env node
// Byte-level gate on the vendored wasm artefacts (issue #49).
//
// This repository does not build the wasm. The Rust engine and its build
// tooling live in `causljs/causl-wasm`, and `packages/core/wasm-pkg/README.md`
// says so in its opening line. What lands here is the built output, six
// committed `.wasm` files of 214 to 249 KB, consumed by the
// `@causlts/core/wasm` loader, the bundler-interop fixtures and the
// bridge-roundtrip property suite.
//
// Until now nothing read a byte of them. `wasm.yml` carried a six-leg
// `wasm-pack` matrix whose every step hung off `if: steps.detect.outputs.present
// == 'true'`, and the crates it detects have never existed here, so all six legs
// reported green having done nothing. This script is what replaced them, and it
// is deliberately the opposite shape: it opens the files.
//
// What it checks, per variant:
//
//   1. The artefact exists.
//   2. It opens with the 8-byte WASM preamble, `\0asm` magic plus version 1
//      little-endian. An 8-byte stub passes this one and fails the next.
//   3. It is non-trivial, at least MIN_BYTES. The real bridges are ~214 to
//      249 KB; the 8-byte preamble stubs the bundler-interop fixtures write
//      into `dist/pkg/` are four orders of magnitude below the floor.
//   4. For the `-bundler` variants, it sits inside the RAW ceiling declared by
//      the matching `size-limit` cell in the root `package.json`.
//
// Point 4 is worth a note, because it is not what the cell itself does.
// `size-limit` compresses before it compares, so the cell named
// `@causlts/core wasm bridge — serde-json (raw)` actually measures 68 kB
// against its 230 KB ceiling, roughly three times looser than it reads. The
// `//size-limit-wasm` comment beside the cells says "Each cell asserts the raw
// .wasm artefact ceiling", and SPEC §17.6 prosecutes those numbers as raw
// bytes. So I enforce the documented reading here against the real file size,
// and leave the cell alone as the compressed second opinion.
//
// It also checks one invariant across variants: `wasm-pack` emits byte-identical
// `.wasm` for `--target bundler` and `--target nodejs`, which is the stated
// reason the size-limit cells gate the `-bundler` half only. If that ever stops
// being true the cells silently stop covering the `-nodejs` artefacts, so the
// claim is worth a gate rather than a comment.
//
// Usage: node tools/wasm-build/verify-vendored-wasm.mjs [<variant>]
//   With no argument every variant is checked.

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const WASM_PKG = join(repoRoot, 'packages', 'core', 'wasm-pkg')
const WASM_FILE = 'engine_rs_bg.wasm'

export const BRIDGES = ['serde', 'gc-builtins', 'gc-classic']
export const TARGETS = ['bundler', 'nodejs']
export const ALL_VARIANTS = BRIDGES.flatMap((b) => TARGETS.map((t) => `${b}-${t}`))

// The smallest real bridge is ~214 KB. 64 KB is a floor that rejects a stub or
// a truncated download without being brittle to future size-shrink work.
export const MIN_BYTES = 64 * 1024

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]) // \0asm
const WASM_VERSION = Buffer.from([0x01, 0x00, 0x00, 0x00]) // version 1 LE

/** `size-limit` limits are decimal-KB strings, so "230 KB" is 230 * 1000 bytes. */
export function parseSizeLimit(text) {
  const m = String(text).trim().match(/^([\d.]+)\s*(k|m)?b$/i)
  if (!m) return undefined
  const n = Number.parseFloat(m[1])
  const unit = (m[2] || '').toLowerCase()
  const mult = unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1
  return Math.round(n * mult)
}

/** The raw ceiling a `size-limit` cell declares for one vendored artefact. */
export function ceilingFor(cells, variant) {
  const wanted = `packages/core/wasm-pkg/${variant}/${WASM_FILE}`
  const cell = (cells ?? []).find((c) => c && c.path === wanted)
  return cell ? parseSizeLimit(cell.limit) : undefined
}

/**
 * Everything that can be decided from the bytes alone.
 *
 * Returns the list of complaints rather than throwing, so one run reports every
 * broken artefact instead of the first.
 */
export function inspect(variant, buf, ceiling) {
  const problems = []
  if (buf.length < 8) {
    problems.push(`${variant}: ${WASM_FILE} is ${buf.length} B, shorter than the 8-byte WASM preamble`)
    return problems
  }
  if (!buf.subarray(0, 4).equals(WASM_MAGIC)) {
    problems.push(`${variant}: ${WASM_FILE} does not start with the \\0asm magic, so it is not a WebAssembly module`)
  }
  if (!buf.subarray(4, 8).equals(WASM_VERSION)) {
    problems.push(`${variant}: ${WASM_FILE} has an unexpected version word, expected 01 00 00 00`)
  }
  if (buf.length < MIN_BYTES) {
    problems.push(
      `${variant}: ${WASM_FILE} is only ${buf.length} B, under the ${MIN_BYTES} B floor, ` +
        'so it looks stubbed or truncated rather than a real bridge',
    )
  }
  if (ceiling !== undefined && buf.length > ceiling) {
    problems.push(
      `${variant}: ${WASM_FILE} is ${buf.length} raw B, over the ${ceiling} B ceiling its ` +
        'size-limit cell declares, and a raw-byte bump needs the SPEC §14.2.1 written consensus',
    )
  }
  return problems
}

function main() {
  const require = createRequire(import.meta.url)
  const cells = require(join(repoRoot, 'package.json'))['size-limit']

  const arg = process.argv[2]
  const variants = arg ? [arg] : ALL_VARIANTS
  const problems = []
  const bytes = new Map()

  for (const variant of variants) {
    if (!ALL_VARIANTS.includes(variant)) {
      problems.push(`unknown variant '${variant}', expected one of: ${ALL_VARIANTS.join(', ')}`)
      continue
    }
    const path = join(WASM_PKG, variant, WASM_FILE)
    if (!existsSync(path)) {
      problems.push(`${variant}: committed artefact missing at ${path}`)
      continue
    }
    const buf = readFileSync(path)
    bytes.set(variant, buf)

    // Only the `-bundler` half carries a size-limit cell; the `-nodejs` half is
    // covered by the byte-identity check below.
    const ceiling = ceilingFor(cells, variant)
    if (variant.endsWith('-bundler') && ceiling === undefined) {
      problems.push(
        `${variant}: no size-limit cell in the root package.json points at ` +
          `packages/core/wasm-pkg/${variant}/${WASM_FILE}, so this artefact has no declared ceiling`,
      )
    }
    const found = inspect(variant, buf, ceiling)
    problems.push(...found)
    if (found.length === 0) {
      process.stdout.write(
        `[verify-vendored-wasm] OK — ${variant}/${WASM_FILE} ${statSync(path).size} raw B` +
          (ceiling === undefined ? '' : ` inside its ${ceiling} B ceiling`) +
          ', valid WASM preamble\n',
      )
    }
  }

  for (const bridge of BRIDGES) {
    const a = bytes.get(`${bridge}-bundler`)
    const b = bytes.get(`${bridge}-nodejs`)
    if (!a || !b) continue
    if (!a.equals(b)) {
      problems.push(
        `${bridge}: the bundler and nodejs artefacts differ (${a.length} B vs ${b.length} B). ` +
          'The size-limit cells gate the bundler half only because wasm-pack emits identical ' +
          'bytes for both targets, so a difference here means the nodejs artefact is ungated.',
      )
    } else {
      process.stdout.write(`[verify-vendored-wasm] OK — ${bridge} bundler and nodejs are byte-identical\n`)
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`::error::[verify-vendored-wasm] ${problem}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`[verify-vendored-wasm] ${variants.length} artefacts checked, all good\n`)
}

// The tests import this file rather than run it, so the guard keeps a unit test
// from firing the CLI. I compare resolved real paths because the workflow may
// invoke the script through a path that differs from `import.meta.url` by a
// symlink.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
