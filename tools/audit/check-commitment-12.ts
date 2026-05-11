#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 12 audit — Semantic-foundation
 * page lands first.
 *
 * Per SPEC.async §17 commitment 1 (re-numbered to 12 in the
 * combined ledger): the SPEC.async §3 semantic-foundation page
 * + docs/semantics-async.md MUST exist as the authoritative
 * reference every later decision points at.
 *
 * Mechanizable as: assert SPEC.async.md exists with a §3
 * heading, AND docs/semantics-async.md exists as the
 * standalone reference (#583).
 *
 * Exit code:
 *   0 — both files present.
 *   1 — at least one missing.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const specAsyncPath = resolve(root, 'SPEC.async.md')
const semanticsPath = resolve(root, 'docs/semantics-async.md')

if (!existsSync(specAsyncPath)) {
  process.stderr.write(`check-commitment-12: missing ${specAsyncPath}\n`)
  process.exit(1)
}
const specText = readFileSync(specAsyncPath, 'utf8')
if (!/^## 3\./m.test(specText)) {
  process.stderr.write(
    `check-commitment-12: SPEC.async.md does not have a level-2 §3 heading\n`,
  )
  process.exit(1)
}

if (!existsSync(semanticsPath)) {
  process.stderr.write(
    `check-commitment-12: missing standalone reference ${semanticsPath} (per #583)\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-12: PASS — SPEC.async §3 + docs/semantics-async.md both present\n`,
)
process.exit(0)
