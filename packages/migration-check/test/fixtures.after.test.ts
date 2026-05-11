/**
 * Fixture-driven harness for the validation procedure's "syntactic
 * clean" axis: every `after/` tree must produce a `DriftReport`
 * with `findings.length === 0` AND must not import any
 * transitional bridge package (the no-holdovers axis).
 *
 * Pairs with `fixtures.before.test.ts` (inverse axis) and
 * `properties/parity.property.test.ts` (behaviour-parity axis).
 *
 * See `docs/migration/validation.md` for the four-axis contract.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { scanDirectory } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = path.join(__dirname, 'fixtures')

/**
 * Bridge-package patterns that indicate a forward-only-violation.
 * The team explicitly committed not to ship transitional bridge
 * packages; an after/ tree that imports one is by definition not
 * migrated, regardless of whether the catalogue's per-rule
 * predicates flag the imports.
 */
const FORBIDDEN_BRIDGE_IMPORTS: readonly RegExp[] = [
  /from\s+['"]@causl\/jotai-bridge['"]/,
  /from\s+['"]@causl\/mobx-bridge['"]/,
  /from\s+['"]@causl\/redux-bridge['"]/,
  /require\(\s*['"]@causl\/[a-z-]+-bridge['"]\s*\)/,
]

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

describe('validation harness — after/ trees are syntactically clean', () => {
  for (const lib of ['jotai', 'mobx', 'redux'] as const) {
    const after = path.join(FIXTURES_ROOT, lib, 'after')

    it(`${lib}/after — DriftReport.findings.length === 0`, async () => {
      const report = await scanDirectory(after)
      expect(report.stats.filesScanned).toBeGreaterThan(0)
      expect(
        report.findings,
        report.findings.map((f) => `${f.file}:${f.line} ${f.ruleId}`).join('\n'),
      ).toEqual([])
      expect(report.stats.findings).toBe(0)
      // No critical findings — the only signal that gates CI red.
      expect(report.stats.bySeverity.critical).toBe(0)
    })

    it(`${lib}/after — no transitional bridge package imports`, async () => {
      const violations: string[] = []
      for await (const file of walk(after)) {
        const source = await fs.readFile(file, 'utf8')
        for (const pattern of FORBIDDEN_BRIDGE_IMPORTS) {
          if (pattern.test(source)) {
            violations.push(`${path.relative(after, file)}: matches ${pattern}`)
          }
        }
      }
      expect(violations, violations.join('\n')).toEqual([])
    })
  }
})
