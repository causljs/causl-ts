// Unit cover for the vendored-wasm verifier.
//
// The point of this gate is to catch a stub sitting where a real bridge should
// be, so the tests that matter are the negative ones. The 8-byte buffer below
// is the exact preamble `e2e/bundler-interop/stub-wasm-pkg.mjs` writes, and it
// is valid WebAssembly, so a checker that only looks at the magic would wave it
// through.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSizeLimit, ceilingFor, inspect, MIN_BYTES, ALL_VARIANTS } from '../verify-vendored-wasm.mjs'

const PREAMBLE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const stub = () => Buffer.from(PREAMBLE)
const real = (bytes = MIN_BYTES + 1) => Buffer.concat([Buffer.from(PREAMBLE), Buffer.alloc(bytes - 8, 0x42)])

test('parseSizeLimit reads size-limit decimal-KB strings', () => {
  assert.equal(parseSizeLimit('230 KB'), 230000)
  assert.equal(parseSizeLimit('6 KB'), 6000)
  assert.equal(parseSizeLimit('1.5 MB'), 1500000)
  assert.equal(parseSizeLimit('512 B'), 512)
  assert.equal(parseSizeLimit('not a size'), undefined)
})

test('ceilingFor finds the cell that points at the artefact', () => {
  const cells = [
    { name: 'js', path: 'packages/core/dist/index.js', limit: '20 KB' },
    { name: 'serde', path: 'packages/core/wasm-pkg/serde-bundler/engine_rs_bg.wasm', limit: '230 KB' },
  ]
  assert.equal(ceilingFor(cells, 'serde-bundler'), 230000)
  assert.equal(ceilingFor(cells, 'gc-classic-bundler'), undefined)
  assert.equal(ceilingFor([], 'serde-bundler'), undefined)
})

test('inspect rejects the 8-byte stub even though it is valid WebAssembly', () => {
  const problems = inspect('serde-bundler', stub(), 230000)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /only 8 B/)
  assert.match(problems[0], /stubbed or truncated/)
})

test('inspect rejects bytes that are not WebAssembly at all', () => {
  // All-zero bytes miss both the magic and the version word, and I want both
  // complaints rather than the first one, so a broken artefact is described in
  // full on one run.
  const notWasm = Buffer.alloc(MIN_BYTES + 1, 0x00)
  const problems = inspect('serde-bundler', notWasm, 230000)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /does not start with the \\0asm magic/)
  assert.match(problems[1], /unexpected version word/)
})

test('inspect rejects an artefact over its declared ceiling', () => {
  const problems = inspect('serde-bundler', real(240000), 230000)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /240000 raw B, over the 230000 B ceiling/)
})

test('inspect rejects a truncated file below the preamble', () => {
  const problems = inspect('serde-bundler', Buffer.from([0x00, 0x61]), 230000)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /shorter than the 8-byte WASM preamble/)
})

test('inspect passes a real-shaped artefact', () => {
  assert.deepEqual(inspect('serde-bundler', real(219599), 230000), [])
})

test('the variant list covers every bridge on both wasm-pack targets', () => {
  assert.deepEqual(ALL_VARIANTS, [
    'serde-bundler',
    'serde-nodejs',
    'gc-builtins-bundler',
    'gc-builtins-nodejs',
    'gc-classic-bundler',
    'gc-classic-nodejs',
  ])
})
