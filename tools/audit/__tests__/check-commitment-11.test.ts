/**
 * Tests for check-commitment-11 (EPIC-13 / Commitment 11 — race-class
 * audit-of-the-audit).
 *
 * #565: the original v1 implementation had two bugs:
 *
 * 1. The witness-path regex was case-sensitive lowercase only
 *    (`[a-z0-9.-]+`). docs/race-class-audit.md cites the witness
 *    files as `properties/race-row-S-1.property.test.ts` (capital S),
 *    so the script silently dropped S-1 / S-2 / S-3 from the audit
 *    set. A regex that misses uppercase identifiers is not auditing
 *    the rows the team thinks it is.
 *
 * 2. The script was misnamed `check-commitment-12.ts` despite its
 *    docstring naming Commitment 11. The renamed file makes the
 *    audit's identity unambiguous.
 *
 * These tests are the regression-witness for both bugs. They are NOT
 * a test-of-internals — they exercise the external observable
 * behavior (which paths are extracted, what the script reports) so
 * that a future refactor that breaks the regex or renames the script
 * without updating the workflow is caught at PR time.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractWitnessPaths } from '../check-commitment-11.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const auditPath = resolve(repoRoot, 'docs/race-class-audit.md')
const scriptPath = resolve(__dirname, '../check-commitment-11.ts')

describe('extractWitnessPaths (#565 regex fix)', () => {
  test('matches witness paths containing capital letters (race-row-S-N)', () => {
    const md = `
| S-1 stale-async resolution | \`properties/race-row-S-1.property.test.ts\` | row 6 |
| S-2 disposed-mid-load | \`properties/race-row-S-2.property.test.ts\` | row 11 |
`
    const paths = extractWitnessPaths(md)
    assert.ok(
      paths.includes('properties/race-row-S-1.property.test.ts'),
      `expected race-row-S-1 in ${JSON.stringify(paths)}; ` +
        `the v1 regex [a-z0-9.-]+ silently skipped uppercase identifiers — ` +
        `that bug must not regress.`,
    )
    assert.ok(
      paths.includes('properties/race-row-S-2.property.test.ts'),
      `expected race-row-S-2 in ${JSON.stringify(paths)}`,
    )
  })

  test('still matches lowercase witness paths', () => {
    const md = '`properties/single-writer-resolution.property.test.ts`'
    const paths = extractWitnessPaths(md)
    assert.ok(
      paths.includes('properties/single-writer-resolution.property.test.ts'),
    )
  })

  test('deduplicates repeated paths (audit doc cites a witness in multiple sections)', () => {
    const md = `
\`properties/race-row-S-1.property.test.ts\`
\`properties/race-row-S-1.property.test.ts\`
`
    const paths = extractWitnessPaths(md)
    assert.equal(paths.length, 1)
  })

  test('extracts every witness from the actual audit doc', () => {
    const md = readFileSync(auditPath, 'utf8')
    const paths = extractWitnessPaths(md)
    // Sanity floor: the audit doc cites at least one race-row-S-N
    // witness (S-1 stale-async resolution). Pre-#919 the doc cited
    // race-row-S-1 *and* race-row-S-2 under the S-row naming
    // convention; #919 renamed race-row-S-2 to
    // disposed-mid-load.property.test.ts so its name reflects what
    // it actually tests, dropping the S-row count to 1. The floor
    // is intentionally explicit — if the doc is later restructured
    // and even race-row-S-1 disappears, the test fails loudly and
    // the maintainer must update the floor with a written
    // justification — preventing accidental coverage regressions.
    const sRows = paths.filter((p) => /race-row-S-\d/.test(p))
    assert.ok(
      sRows.length >= 1,
      `expected at least 1 S-row witness extracted from race-class-audit.md, ` +
        `got ${sRows.length}: ${JSON.stringify(sRows)}`,
    )
  })
})

describe('check-commitment-11 script integration', () => {
  test('invokes successfully from workspace root regardless of cwd', () => {
    // Regression for the workflow-side bug: the original quarterly-audit.yml
    // ran `pnpm --filter @causljs/core exec tsx "$script"`, which reset cwd
    // to packages/core/. The script SHOULD be cwd-resilient via __dirname
    // resolution. This test exercises that property by invoking from a
    // subdirectory and asserting non-zero S-rows are reported.
    const result = spawnSync(
      'node',
      ['--import', 'tsx', scriptPath],
      {
        cwd: resolve(repoRoot, 'packages'),
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      0,
      `script exited ${result.status} from packages/ cwd; ` +
        `stdout=${result.stdout} stderr=${result.stderr}`,
    )
    // PASS message must mention a non-zero count (otherwise the
    // regex is silently dropping witnesses again, which was the
    // exact #565 bug we are guarding against).
    const match = result.stdout.match(/PASS — (\d+) race-row witness/)
    assert.ok(match, `expected PASS message in stdout; got: ${result.stdout}`)
    const count = Number(match![1])
    assert.ok(
      count >= 2,
      `script reported ${count} witnesses, expected ≥ 2 (S-1, S-2). ` +
        `If this drops to 1 or 0, the regex bug from #565 has regressed.`,
    )
  })

  test('is invokable as check-commitment-11.ts (renamed from check-commitment-12.ts)', () => {
    // The file SHOULD be at check-commitment-11.ts because it audits
    // Commitment 11 (race-class audit), not 12. Renaming it makes the
    // ledger row, the audit script, and the docs/commitment-audit.md
    // entry all line up — the previous mismatch was a confusing trap.
    assert.ok(
      existsSync(scriptPath),
      `expected ${scriptPath} to exist (renamed from check-commitment-12.ts)`,
    )
  })
})
