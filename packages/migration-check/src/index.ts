/**
 * @causl/migration-check — migration drift detector. Finds
 * unmigrated patterns and emits a DriftReport JSON for CI /
 * dashboards. Rule contract: docs/migration/RULE_CATALOGUE.md.
 *
 * Every emitted finding carries a stable `RULE_ID` from the
 * catalogue plus a `severity` that maps to the CLI exit code.
 * Every report carries a `catalogueVersion` so consumers can
 * refuse a report produced under an unrecognised schema.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CATALOGUE_VERSION, type RuleId, type Severity } from './catalogue.js'
import type { DriftCategory, DriftFinding, DriftReport } from './ir.js'
import { scanFile } from './scan.js'

export type {
  DriftCategory,
  DriftFinding,
  DriftReport,
} from './ir.js'
export { scanFile } from './scan.js'
export {
  CATALOGUE_VERSION,
  RULES,
  getRule,
  severityToExitCode,
} from './catalogue.js'
export type {
  RuleDescriptor,
  RuleId,
  RuleSource,
  Severity,
} from './catalogue.js'

/**
 * Caller options for {@link scanDirectory}.
 *
 * @remarks
 * The directory walker has only two adopter-visible knobs: which file
 * extensions to consume, and which path fragments to skip. Both have
 * deliberate defaults that reflect "what an adopter actually wants" —
 * see {@link scanDirectory} for the defaults and the rule-catalogue
 * rationale for including `.mjs` / `.cjs` out of the box.
 */
export interface ScanOptions {
  /**
   * File extensions to scan; default
   * `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`. `.mjs` and `.cjs` are
   * included by default because the rule catalogue's predicate
   * contract is language-level, not module-format-level
   * (`docs/migration/RULE_CATALOGUE.md`): a Jotai `atom(0)` is
   * drift regardless of which extension wraps it. Pass an explicit
   * `extensions: ['.ts']` to narrow the walk.
   */
  readonly extensions?: readonly string[]
  /** Path globs to skip. v0: simple substring matches. */
  readonly skip?: readonly string[]
}

/**
 * Default walk-filter extensions. Includes `.mjs` and `.cjs` so the
 * scanner sees ESM-only entry points (common in pnpm workspaces) and
 * CJS-only modules (common in mixed-output monorepos) by default —
 * otherwise a non-migrated reducer in `reducer.cjs` slips past the
 * `findings.length === 0` axis of the validation procedure
 * (`docs/migration-validation.md`). Extending this list is *not* a
 * `CATALOGUE_VERSION` bump: the rule schema is unchanged, only the
 * walker's reach is.
 */
const DEFAULT_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const DEFAULT_SKIP = ['node_modules', 'dist', '.git', '.next', 'coverage']

const ZERO_BY_SEVERITY: Record<Severity, number> = {
  critical: 0,
  important: 0,
  'nice-to-have': 0,
}

/**
 * Recursively scan a directory tree for migration drift.
 *
 * @param root - Absolute or relative path to the directory to scan. Used
 *   as the base for the `relative` path stored on each finding.
 * @param options - Optional {@link ScanOptions} overriding the default
 *   extension set and skip list.
 * @returns A {@link DriftReport} carrying the union of every per-file
 *   finding plus the aggregated `byCategory` / `byRuleId` / `bySeverity`
 *   counts and the `filesScanned` total.
 *
 * @remarks
 * Each file is read once and dispatched through {@link scanFile} so the
 * rule catalogue stays the single source of truth. Symbolic links are
 * not followed beyond what `fs.readdir` returns; the entry-name match
 * against {@link ScanOptions.skip} is substring-based, not glob-based.
 */
export async function scanDirectory(
  root: string,
  options: ScanOptions = {},
): Promise<DriftReport> {
  const exts = options.extensions ?? DEFAULT_EXT
  const skip = options.skip ?? DEFAULT_SKIP
  const findings: DriftFinding[] = []
  let filesScanned = 0

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (skip.some((s) => entry.name === s || entry.name.includes(s))) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        const source = await fs.readFile(full, 'utf8')
        findings.push(...scanFile(path.relative(root, full), source))
        filesScanned++
      }
    }
  }
  await walk(root)

  return buildReport(findings, filesScanned)
}

/**
 * Pure helper that wraps a flat findings array in the public
 * `DriftReport` envelope. Exposed for tests that want to assert on
 * the report shape without touching the file system.
 */
export function buildReport(
  findings: readonly DriftFinding[],
  filesScanned: number,
): DriftReport {
  const byCategory: Partial<Record<DriftCategory, number>> = {}
  const byRuleId: Partial<Record<RuleId, number>> = {}
  const bySeverity: Record<Severity, number> = { ...ZERO_BY_SEVERITY }
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
    byRuleId[f.ruleId] = (byRuleId[f.ruleId] ?? 0) + 1
    bySeverity[f.severity] += 1
  }
  return {
    schema: 2,
    catalogueVersion: CATALOGUE_VERSION,
    generatedAt: new Date().toISOString(),
    stats: {
      filesScanned,
      findings: findings.length,
      byCategory,
      byRuleId,
      bySeverity,
    },
    findings,
  }
}
