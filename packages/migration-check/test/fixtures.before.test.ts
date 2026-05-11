/**
 * Fixture-driven harness for the validation procedure's first axis
 * — "syntactic clean" applied in reverse: every `before/` tree
 * must surface the rule IDs catalogued in its sibling
 * `expected-drift.json`. This is the regression net that prevents
 * the catalogue from silently losing a predicate.
 *
 * Pairs with `fixtures.after.test.ts` (forward axis) and
 * `properties/parity.property.test.ts` (behaviour-parity axis).
 *
 * See `docs/migration/validation.md` for the four-axis contract.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CATALOGUE_VERSION, scanDirectory, type RuleId } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = path.join(__dirname, 'fixtures')

interface ExpectedDrift {
  readonly catalogueVersion: string
  readonly schema: number
  readonly expectedRuleIds: readonly RuleId[]
  readonly minCriticalFindings: number
  readonly expectClean: boolean
}

async function readExpected(libDir: string): Promise<ExpectedDrift> {
  const json = await fs.readFile(
    path.join(FIXTURES_ROOT, libDir, 'expected-drift.json'),
    'utf8',
  )
  return JSON.parse(json) as ExpectedDrift
}

describe('validation harness — before/ trees surface every catalogued rule', () => {
  for (const lib of ['jotai', 'mobx', 'redux'] as const) {
    it(`${lib}/before — drift report matches expected-drift.json`, async () => {
      const expected = await readExpected(lib)
      const before = path.join(FIXTURES_ROOT, lib, 'before')
      const report = await scanDirectory(before)

      // Schema-stable axis: catalogue version + report schema must
      // match the contract pinned in expected-drift.json. A schema
      // bump here is a required-action signal, never silent.
      expect(report.catalogueVersion).toBe(expected.catalogueVersion)
      expect(report.schema).toBe(expected.schema)
      expect(report.catalogueVersion).toBe(CATALOGUE_VERSION)

      // Drift axis (inverted): the before/ tree must NOT be clean.
      expect(expected.expectClean).toBe(false)
      expect(report.findings.length).toBeGreaterThan(0)

      // Every rule the contract names must fire at least once. We
      // do not assert exact equality on findings.length because a
      // catalogue extension can legitimately surface more rules
      // (the contract is a lower bound on coverage, not an upper
      // bound on noise).
      const seenRuleIds = new Set(report.findings.map((f) => f.ruleId))
      for (const ruleId of expected.expectedRuleIds) {
        expect(seenRuleIds.has(ruleId), `${lib}/before missed ${ruleId}`).toBe(true)
      }

      // CI-gating axis: at least one critical finding is required
      // for the gate to fail red on the before/ tree (exit 1).
      expect(report.stats.bySeverity.critical).toBeGreaterThanOrEqual(
        expected.minCriticalFindings,
      )
    })
  }
})
