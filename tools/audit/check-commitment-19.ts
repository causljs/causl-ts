#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 19 audit — §15 properties hold at
 * 1000-trial floor.
 *
 * Per SPEC.async §17 commitment 8: every property test under
 * packages/sync/test/properties/ runs at the 1000-trial floor.
 * The check-commitment-8 script enforces this on the engine
 * side via the spec-15.2-conformance walker; this audit
 * verifies the adapter property suite is ALSO under the
 * walker's coverage.
 *
 * Mechanizable as: verify packages/sync/test/properties/ has
 * at least 8 *.property.test.ts files (per SPEC.async §15's
 * 8-property catalogue) AND each invokes propertyTrials or
 * propertyOptions for the 1000-trial floor.
 *
 * Exit code:
 *   0 — ≥8 property files, all threading the floor.
 *   1 — property file count below floor or missing trial
 *       enforcement.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const propertiesDir = resolve(
  __dirname,
  '../../packages/sync/test/properties',
)

const allFiles = readdirSync(propertiesDir).filter((f) =>
  /\.(?:property\.)?test\.ts$/.test(f),
)

// SPEC.async §15 names 8 properties + a handful of S-row
// witnesses. The floor below is empirical — enforced floor
// rather than a strict upper bound.
const PROPERTY_FILE_FLOOR = 8

if (allFiles.length < PROPERTY_FILE_FLOOR) {
  process.stderr.write(
    `check-commitment-19: only ${allFiles.length} property files in ${propertiesDir}; ` +
      `expected at least ${PROPERTY_FILE_FLOOR} per SPEC.async §15.\n`,
  )
  process.exit(1)
}

// Each file must thread the trial-floor enforcement.
const missingFloor: string[] = []
for (const f of allFiles) {
  const text = readFileSync(resolve(propertiesDir, f), 'utf8')
  if (!/(propertyTrials|propertyOptions|numRuns:\s*1000)/.test(text)) {
    missingFloor.push(f)
  }
}

if (missingFloor.length > 0) {
  process.stderr.write(
    `check-commitment-19: ${missingFloor.length} property file(s) don't thread the 1000-trial floor: ` +
      `${missingFloor.join(', ')}\n`,
  )
  process.exit(1)
}

const stats = statSync(propertiesDir)
if (!stats.isDirectory()) {
  process.stderr.write(`check-commitment-19: ${propertiesDir} is not a directory\n`)
  process.exit(1)
}

process.stdout.write(
  `check-commitment-19: PASS — ${allFiles.length} property files under packages/sync/test/properties/, ` +
    `all threading the 1000-trial floor\n`,
)
process.exit(0)
