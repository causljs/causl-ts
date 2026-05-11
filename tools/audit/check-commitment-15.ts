#!/usr/bin/env node
/**
 * Adapter Commitment 15 audit — DU + assertNever exhaustiveness on
 * ResourceState and ConflictKind.
 *
 * Per SPEC.async §17 commitment 4 (re-numbered to 15 in the engine
 * + adapter combined ledger), every public closed discriminated
 * union the adapter ships must have a compile-time exhaustiveness
 * fixture pinning the closed-tag set. This audit verifies both
 * fixtures exist and that their lock count matches the expected
 * arm count (5 for ResourceState, 4 for ConflictKind).
 *
 * MECHANICAL: this script + the existing tsd-driven test:types
 * gate together hold the commitment.
 *
 * Exit code:
 *   0 — both fixtures present with the expected lock count.
 *   1 — at least one fixture missing or under-locked.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

interface FixtureSpec {
  path: string
  expectedArms: number
  unionName: string
}

const fixtures: FixtureSpec[] = [
  {
    path: 'packages/sync/test-d/resource-state.exhaustiveness.test-d.ts',
    expectedArms: 5, // idle | loading | loaded | stale | errored
    unionName: 'ResourceState',
  },
  {
    path: 'packages/sync/test-d/conflict-kind.exhaustiveness.test-d.ts',
    expectedArms: 4, // open | resolved | ignored | superseded
    unionName: 'ConflictKind',
  },
]

let allOk = true
for (const f of fixtures) {
  const fullPath = resolve(root, f.path)
  if (!existsSync(fullPath)) {
    process.stderr.write(
      `check-commitment-15: missing fixture ${f.path} for ${f.unionName}\n`,
    )
    allOk = false
    continue
  }
  // Heuristic: count `case '` literals in the assertNever switch
  // plus AssertEquals presence. A fixture that ships with fewer
  // case arms than expected has dropped exhaustiveness coverage.
  const text = readFileSync(fullPath, 'utf8')
  const caseCount = (text.match(/^\s*case '/gm) ?? []).length
  if (caseCount < f.expectedArms) {
    process.stderr.write(
      `check-commitment-15: ${f.path} has ${caseCount} 'case' arms; ` +
        `expected ${f.expectedArms} for ${f.unionName}\n`,
    )
    allOk = false
    continue
  }
  if (!/AssertEquals/.test(text)) {
    process.stderr.write(
      `check-commitment-15: ${f.path} missing AssertEquals lock — ` +
        `closed-tag set is not pinned\n`,
    )
    allOk = false
  }
}

if (allOk) {
  process.stdout.write(
    `check-commitment-15: PASS — ${fixtures.length} adapter exhaustiveness fixtures present\n`,
  )
  process.exit(0)
} else {
  process.exit(1)
}
