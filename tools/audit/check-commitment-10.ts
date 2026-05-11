#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 10 audit — schema lockstep.
 *
 * Mechanizable as: assert that `CAUSL_MODEL_SCHEMA` in
 * `packages/core/src/ir.ts` matches `causl_model_schema` in
 * `tools/checker/Cargo.toml`. Mirrors the lockstep job in
 * `.github/workflows/release-checker.yml` so a developer skipping
 * the workflow run locally still catches the drift.
 *
 * Exit code:
 *   0 — commitment holds.
 *   1 — commitment violated; diagnostic on stderr.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tsPath = resolve(__dirname, '../../packages/core/src/ir.ts')
const cargoPath = resolve(__dirname, '../../tools/checker/Cargo.toml')

const ts = readFileSync(tsPath, 'utf8')
const cargo = readFileSync(cargoPath, 'utf8')

const tsMatch = ts.match(/CAUSL_MODEL_SCHEMA\s*=\s*(\d+)/)
const cargoMatch = cargo.match(/causl_model_schema\s*=\s*"(\d+)"/)
if (!tsMatch || !cargoMatch) {
  process.stderr.write(
    'check-commitment-10: could not parse schema constants\n',
  )
  process.exit(1)
}
const tsVal = tsMatch[1]
const cargoVal = cargoMatch[1]
if (tsVal !== cargoVal) {
  process.stderr.write(
    `check-commitment-10: TS CAUSL_MODEL_SCHEMA=${tsVal} != Cargo causl_model_schema=${cargoVal}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  `check-commitment-10: PASS — schema ${tsVal} pinned across both surfaces\n`,
)
process.exit(0)
