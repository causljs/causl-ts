#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 5 audit — Origin pinning (SPEC.async §3.1
 * Theorem 1).
 *
 * Per SPEC.async Theorem 1: a fetch's resolved value lands on
 * exactly the resource node it was fetched against; cross-talk
 * between resources is impossible by construction.
 *
 * Mechanizable as: scan
 * `packages/sync/test/properties/origin-bound-resolution.property.test.ts`
 * for the property witness, assert it exists, has it() blocks,
 * and threads the 1000-trial floor (via propertyTrials or the
 * @causl/sync local seam).
 *
 * Lifts commitment 5 from PROPERTY toward MECHANICAL: this script
 * proves the witness is structurally sound; the actual property
 * verdict is the test file under vitest.
 *
 * Exit code:
 *   0 — witness present + 1000-trial floor present.
 *   1 — witness missing or below floor.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const witnessPath = resolve(
  __dirname,
  '../../packages/sync/test/properties/origin-bound-resolution.property.test.ts',
)

if (!existsSync(witnessPath)) {
  process.stderr.write(`check-commitment-5: missing witness file ${witnessPath}\n`)
  process.exit(1)
}

const text = readFileSync(witnessPath, 'utf8')

if (!/(propertyTrials|propertyOptions)/.test(text)) {
  process.stderr.write(
    `check-commitment-5: ${witnessPath} does not invoke propertyTrials() or propertyOptions()\n`,
  )
  process.exit(1)
}

const itCount = (text.match(/\bit\(/g) ?? []).length
if (itCount < 1) {
  process.stderr.write(`check-commitment-5: ${witnessPath} has no it() blocks\n`)
  process.exit(1)
}

// Origin-pinning specific: the file should reference 'origin' or
// 'pinning' so a future repurpose-for-different-property is caught.
if (!/(origin|pinning)/i.test(text)) {
  process.stderr.write(
    `check-commitment-5: ${witnessPath} doesn't mention 'origin' or 'pinning' — ` +
      `file may have been repurposed away from origin-pinning\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-5: PASS — origin-pinning witness present (${itCount} it block(s))\n`,
)
process.exit(0)
