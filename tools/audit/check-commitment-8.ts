#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 8 audit — 1000-trial floor on every
 * property suite.
 *
 * Per SPEC §17 commitment 8: every `*.property.test.ts` file in
 * the workspace runs at least 1000 trials per fc.assert. The
 * spec-15.2-conformance walker enforces this at vitest runtime;
 * this audit script is the surface check that the walker file
 * itself is present and active.
 *
 * Mechanizable as: assert
 * `packages/core/test/spec-15.2-conformance.test.ts` exists,
 * has it() blocks, and references the propertyTrials gate or
 * the local propertyOptions seam.
 *
 * Exit code:
 *   0 — walker present and gate-active.
 *   1 — walker missing or no it() blocks.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const walkerPath = resolve(
  __dirname,
  '../../packages/core/test/spec-15.2-conformance.test.ts',
)

if (!existsSync(walkerPath)) {
  process.stderr.write(
    `check-commitment-8: missing 1000-trial floor walker ${walkerPath}\n`,
  )
  process.exit(1)
}

const text = readFileSync(walkerPath, 'utf8')

const itCount = (text.match(/\bit\(/g) ?? []).length
if (itCount < 1) {
  process.stderr.write(
    `check-commitment-8: ${walkerPath} has no it() blocks — walker is empty\n`,
  )
  process.exit(1)
}

// The walker must enforce the 1000-trial floor against every
// property file. Sanity check: it should mention the threshold
// (1000 or '1000') somewhere in the source.
if (!/1000/.test(text)) {
  process.stderr.write(
    `check-commitment-8: ${walkerPath} doesn't mention '1000' — ` +
      `the trial floor may have been silently lowered\n`,
  )
  process.exit(1)
}

// And it should reference propertyTrials or numRuns enforcement.
if (!/(propertyTrials|propertyOptions|numRuns)/.test(text)) {
  process.stderr.write(
    `check-commitment-8: ${walkerPath} doesn't reference propertyTrials, ` +
      `propertyOptions, or numRuns — the gate mechanism is missing\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-8: PASS — 1000-trial floor walker present (${itCount} it block(s), threshold + numRuns enforcement intact)\n`,
)
process.exit(0)
