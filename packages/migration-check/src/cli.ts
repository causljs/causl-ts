#!/usr/bin/env node
/**
 * causl-migration-check CLI — `npx @causl/migration-check [path]`
 *
 * Exit-code contract (RULE_CATALOGUE.md §Severity meanings):
 *
 *   1 — at least one `critical` finding (CI gating).
 *   0 — only `important` or `nice-to-have` findings (with summary).
 *   0 — clean (no findings).
 *   2 — internal error.
 *
 * Rule contract: docs/migration/RULE_CATALOGUE.md.
 */

import process from 'node:process'

import { scanDirectory } from './index.js'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const target = args[0] ?? process.cwd()
  const report = await scanDirectory(target)
  process.stdout.write(JSON.stringify(report, null, 2))
  process.stdout.write('\n')
  // Exit 1 only when at least one critical finding appears; otherwise
  // important/nice-to-have remain visible in the report but do not
  // gate CI (matches RULE_CATALOGUE.md §Severity meanings).
  return report.stats.bySeverity.critical > 0 ? 1 : 0
}

main().then(
  (code) => {
    process.exit(code)
  },
  (err) => {
    process.stderr.write(`causl-migration-check: ${err}\n`)
    process.exit(2)
  },
)
