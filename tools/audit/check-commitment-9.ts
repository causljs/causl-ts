#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 9 audit — §9.1 STATIC subset coverage.
 *
 * Per SPEC §17 commitment 9: the §9.1 STATIC subset is fully
 * covered by `causl-check` lints (eight passes today plus the
 * four §16A.2 additions). The four §16A.2 lift-to-STATIC passes:
 *
 *   - SubscribeWithoutDispose (row 1 — cascading-commit /
 *     subscribe-leak)
 *   - UseAfterDispose (row 11 — use-after-dispose family race)
 *   - CrossGraphRead (row 13 — cross-graph dep without bridge)
 *   - CommitFromSubscribe (row 14 — commit issued from inside
 *     a subscriber callback)
 *
 * Mechanizable as: scan `tools/checker/src/check.rs` for the
 * `PassName` enum and assert all four §16A pass variants are
 * present. A future PR that drops a pass without updating the
 * §9.1 catalogue trips this script.
 *
 * Exit code:
 *   0 — all four §16A passes registered in PassName.
 *   1 — at least one §16A pass missing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const checkPath = resolve(__dirname, '../../tools/checker/src/check.rs')

const text = readFileSync(checkPath, 'utf8')

// Locate the PassName enum body.
const m = text.match(/pub enum PassName\s*\{([\s\S]*?)\}/)
if (!m) {
  process.stderr.write(
    `check-commitment-9: could not locate PassName enum in ${checkPath}\n`,
  )
  process.exit(1)
}
const enumBody = m[1]!

const required = [
  'SubscribeWithoutDispose',
  'UseAfterDispose',
  'CrossGraphRead',
  'CommitFromSubscribe',
]

const missing: string[] = []
for (const variant of required) {
  // Match the variant name as a top-level enum arm (line-anchored
  // to avoid accidental matches inside doc comments).
  const re = new RegExp(`^\\s*${variant}\\b`, 'm')
  if (!re.test(enumBody)) {
    missing.push(variant)
  }
}

if (missing.length > 0) {
  process.stderr.write(
    `check-commitment-9: §16A passes missing from PassName enum: ${missing.join(', ')}. ` +
      `The §9.1 STATIC coverage commitment is broken — at least one row that should ` +
      `be MECHANICAL is no longer covered by a registered pass.\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-9: PASS — all 4 §16A STATIC-lift passes registered (${required.join(', ')})\n`,
)
process.exit(0)
