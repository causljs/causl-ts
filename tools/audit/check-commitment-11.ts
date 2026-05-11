#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 11 (race-class audit) audit-of-the-audit —
 * verify every named race row in `docs/race-class-audit.md` has a
 * matching property witness file under `packages/sync/test/properties/`.
 *
 * Lifts commitment 11 from REVIEW towards MECHANICAL: this script
 * proves the witnesses exist; a follow-on PR scans them for the
 * 1000-trial floor.
 *
 * Renamed from check-commitment-12.ts to check-commitment-11.ts in
 * #565 so the ledger row, audit script, and commitment-audit doc
 * all line up. The previous mismatch was a confusing trap when
 * reading test failures.
 *
 * The witness-path regex was widened from `[a-z0-9.-]+` to
 * `[a-zA-Z0-9.-]+` in #565 — the original silently dropped
 * `race-row-S-1.property.test.ts` and `race-row-S-2.property.test.ts`
 * (capital S) from the audit set, leaving the team unaware that the
 * audit was reporting PASS while skipping its actual targets.
 *
 * In #919, `race-row-S-2.property.test.ts` was renamed to
 * `disposed-mid-load.property.test.ts` (its docstring claimed
 * SPEC.async §9.1.1 / row S-2 but its content tested
 * disposed-mid-load); a new property witness for SPEC.async §9.1.1
 * row S-2 (open-set drift) was authored at
 * `conflict-registry-drift.property.test.ts`. The regex still
 * matches both — the `[a-zA-Z0-9.-]+` cover both naming styles.
 *
 * Exit code:
 *   0 — every row has its witness.
 *   1 — at least one row is missing its witness.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Extract every `properties/<name>.property.test.ts` witness path
 * cited in the given audit-doc markdown, deduplicated.
 *
 * The regex includes uppercase letters because the S-row witnesses
 * are conventionally named `race-row-S-1.property.test.ts` (capital
 * S, per the EPIC-12 audit anchor convention). A lowercase-only
 * regex silently skipped them — that bug is the subject of #565 and
 * the regression test in `__tests__/check-commitment-11.test.ts`.
 */
export function extractWitnessPaths(markdown: string): string[] {
  const matches =
    markdown.match(/properties\/[a-zA-Z0-9.-]+\.property\.test\.ts/g) ?? []
  return Array.from(new Set(matches))
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const auditPath = resolve(__dirname, '../../docs/race-class-audit.md')
const propertiesDir = resolve(
  __dirname,
  '../../packages/sync/test/properties',
)

function main(): void {
  const audit = readFileSync(auditPath, 'utf8')
  const witnessPaths = extractWitnessPaths(audit)
  let allOk = true
  for (const w of witnessPaths) {
    const filename = w.replace(/^properties\//, '')
    const fullPath = resolve(propertiesDir, filename)
    if (!existsSync(fullPath)) {
      process.stderr.write(`check-commitment-11: missing witness ${fullPath}\n`)
      allOk = false
    }
  }
  if (allOk) {
    process.stdout.write(
      `check-commitment-11: PASS — ${witnessPaths.length} race-row witness file(s) present\n`,
    )
    process.exit(0)
  } else {
    process.exit(1)
  }
}

// Run only when invoked as a CLI; remain importable from tests.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main()
}
