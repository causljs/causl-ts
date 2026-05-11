/**
 * DriftReport JSON contract — every consumer (CI dashboards,
 * #197's guides cross-references, #199 validation procedure) reads
 * this envelope, so the schema/catalogueVersion/severity-mapping
 * fields are tested independently of the per-rule predicates.
 */

import { describe, expect, it } from 'vitest'

import {
  buildReport,
  CATALOGUE_VERSION,
  scanFile,
  severityToExitCode,
} from '../src/index.js'

describe('DriftReport envelope', () => {
  it('stamps the catalogue version and schema number', () => {
    const r = buildReport([], 0)
    expect(r.schema).toBe(2)
    expect(r.catalogueVersion).toBe(CATALOGUE_VERSION)
    expect(typeof r.generatedAt).toBe('string')
    expect(new Date(r.generatedAt).getTime()).not.toBeNaN()
  })

  it('aggregates byRuleId and bySeverity correctly', () => {
    const findings = scanFile(
      'src/x.tsx',
      `import { atom, useAtomValue } from 'jotai'
       function C() { return useAtomValue(a) }
       const x = atom(0)`,
    )
    const r = buildReport(findings, 1)
    expect(r.stats.findings).toBe(findings.length)
    expect(r.stats.byRuleId['J-01']).toBeGreaterThanOrEqual(1)
    expect(r.stats.byRuleId['J-05']).toBeGreaterThanOrEqual(1)
    expect(r.stats.bySeverity.critical).toBeGreaterThanOrEqual(2)
  })

  it('keeps stable per-finding fields', () => {
    const findings = scanFile(
      'src/x.tsx',
      `import { atom } from 'jotai'\nconst a = atom(0)`,
    )
    const f = findings.find((x) => x.ruleId === 'J-01')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('critical')
    expect(f!.line).toBeGreaterThan(0)
    expect(f!.column).toBeGreaterThan(0)
    expect(typeof f!.suggestion).toBe('string')
  })

  it('orders findings by line then column then ruleId', () => {
    const findings = scanFile(
      'src/x.tsx',
      `import { atom } from 'jotai'
       const a = atom(0)
       const b = atom((g) => g(a))`,
    )
    for (let i = 1; i < findings.length; i++) {
      const a = findings[i - 1]!
      const b = findings[i]!
      const aKey = a.line * 100000 + a.column
      const bKey = b.line * 100000 + b.column
      expect(aKey).toBeLessThanOrEqual(bKey)
    }
  })
})

describe('severityToExitCode', () => {
  it('maps critical → 1 and the rest → 0 (RULE_CATALOGUE.md §Severity)', () => {
    expect(severityToExitCode('critical')).toBe(1)
    expect(severityToExitCode('important')).toBe(0)
    expect(severityToExitCode('nice-to-have')).toBe(0)
  })
})
