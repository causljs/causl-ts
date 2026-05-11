#!/usr/bin/env node
/**
 * Adapter Commitment 17 audit — §10 worked example as adapter
 * acceptance gate.
 *
 * Per SPEC.async §17 commitment 6 (re-numbered to 17 in the engine
 * + adapter combined ledger), the §10 worked example is the
 * required-green PR gate for the adapter. This audit verifies that
 * the four §10 fixture files plus the #576 corrections file all
 * exist and contain at least one `it(` block each (a non-empty
 * test).
 *
 * MECHANICAL: this script + CI's standard `pnpm run test:run`
 * exercise of the fixture files together hold the commitment.
 *
 * Exit code:
 *   0 — all five fixture files present with at least one test.
 *   1 — at least one missing or empty.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const fixtures = [
  'packages/sync/test/spec-async-10-1-direct-commit.test.ts',
  'packages/sync/test/spec-async-10-2-mvu-front-door.test.ts',
  'packages/sync/test/spec-async-10-3-conflict-registry.test.ts',
  'packages/sync/test/spec-async-10-4-disposed-mid-load.test.ts',
  'packages/sync/test/spec-async-10-fixture-corrections.test.ts',
]

let allOk = true
for (const f of fixtures) {
  const fullPath = resolve(root, f)
  if (!existsSync(fullPath)) {
    process.stderr.write(`check-commitment-17: missing ${f}\n`)
    allOk = false
    continue
  }
  const text = readFileSync(fullPath, 'utf8')
  const itCount = (text.match(/^\s*it\(/gm) ?? []).length
  if (itCount < 1) {
    process.stderr.write(
      `check-commitment-17: ${f} has no it() blocks — empty test file\n`,
    )
    allOk = false
  }
}

if (allOk) {
  process.stdout.write(
    `check-commitment-17: PASS — all ${fixtures.length} §10 worked-example fixtures present and non-empty\n`,
  )
  process.exit(0)
} else {
  process.exit(1)
}
