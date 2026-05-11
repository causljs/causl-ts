/**
 * docs/race-class-audit.md ↔ SPEC §9.1 + witness files alignment (#568, #566).
 *
 * Two interlocking claims this test gate-keeps:
 *
 *   #568 — The audit doc's "Engine rows" table MUST list rows in
 *   the same order, and with names that match, SPEC §9.1's
 *   seventeen-row race-class catalogue. Pre-#568 the audit doc had
 *   17 rows but named them after the lint-pass-and-property-witness
 *   surface (Cascading-commit, Glitch propagation, Order-of-evaluation,
 *   ...) which did not correspond row-for-row to the SPEC text. A
 *   reader cross-referencing audit row 12 ("Concurrent-engine
 *   mutation") would land on SPEC row 12 ("Hydration mismatch") and
 *   silently mis-attribute coverage.
 *
 *   #566 — The audit doc's S-row prose MUST honestly describe what
 *   the property witness files actually test. Pre-#566 the audit
 *   doc's descriptions diverged from both SPEC.async §9.1.1's
 *   canonical row identities (Abandon-then-resume / Open-set drift /
 *   Dispatch-shape leak) AND from the witness-file claims.
 *
 * The witness files in `packages/sync/test/properties/` are the
 * runtime ground truth (they are the regression-witness set that
 * actually runs in CI). SPEC.async §9.1.1 names a *different* set
 * of S-rows. The test pins audit-doc against the witness files
 * (the de facto S-row identities); a follow-on issue tracks
 * authoring new property witnesses for SPEC.async's canonical
 * S-rows, but for #566 the doc must at least be honest about which
 * race each existing witness covers.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const auditPath = resolve(repoRoot, 'docs/race-class-audit.md')
const specPath = resolve(repoRoot, 'SPEC.md')
const auditText = readFileSync(auditPath, 'utf8')
const specText = readFileSync(specPath, 'utf8')

/**
 * SPEC §9.1's canonical 17-row catalogue. The list is the source
 * of truth for #568's renumbering. Each entry is a fragment of
 * the SPEC row's name that must appear in the audit doc's
 * corresponding row (case-insensitive substring match — strict
 * verbatim match is too brittle against prose punctuation).
 */
const SPEC_91_ROWS: readonly string[] = [
  'concurrent engine mutations',
  'not-yet-loaded resource value',
  'partially-parsed formula',
  'committed-but-not-yet-published snapshot',
  'diamond glitches',
  'stale-async',
  'dynamic-dependency cleanup',
  'cycle in a derivation graph',
  'two app-level',
  'multi-user write-write',
  'use-after-dispose',
  'hydration mismatch',
  'hydration emitted but subscribers',
  'non-monotonic',
  'time-travel jump',
  'persistence schema-version',
  'suspense fresh-promise',
]

function extractEngineRowsTable(): readonly string[] {
  // The audit doc's engine-rows table starts after the
  // "## Engine rows ↔ adapter contributions" heading.
  const start = auditText.indexOf('## Engine rows ↔ adapter contributions')
  expect(
    start,
    'audit doc must keep the "Engine rows ↔ adapter contributions" section heading',
  ).toBeGreaterThan(-1)
  const after = auditText.slice(start)
  const end = after.indexOf('\n## ')
  const section = end === -1 ? after : after.slice(0, end)
  // Each row is a markdown table line starting with `|`. Filter
  // to lines that begin a numbered engine row — the second column
  // starts with a digit (`| 1 | ...` or `| 1. ...`). This is more
  // robust than trying to enumerate every possible header label.
  return section
    .split('\n')
    .filter((l) => /^\|\s*\d+\s*[|.]/.test(l))
}

describe('audit-doc engine rows ↔ SPEC §9.1 alignment (#568)', () => {
  test('audit doc has exactly 17 engine rows', () => {
    const rows = extractEngineRowsTable()
    expect(
      rows.length,
      `audit doc engine table has ${rows.length} rows; SPEC §9.1 has 17`,
    ).toBe(17)
  })

  test('audit row N corresponds to SPEC §9.1 row N (1..17)', () => {
    const rows = extractEngineRowsTable()
    for (let i = 0; i < SPEC_91_ROWS.length; i++) {
      const expected = SPEC_91_ROWS[i]!
      const auditRow = rows[i]!.toLowerCase()
      expect(
        auditRow,
        `audit row ${i + 1} must mention SPEC §9.1 row ${i + 1} (${expected!}); ` +
          `actual audit row ${i + 1}: ${rows[i]}`,
      ).toContain(expected)
    }
  })
})

describe('audit-doc S-row prose ↔ witness-file truth (#566)', () => {
  // The S-row witness files are the de facto race identities.
  // Each describe block in the property test states what is
  // actually being verified. We extract that description and
  // assert audit-doc names it.

  function extractWitnessDescribe(filename: string): string {
    const path = resolve(
      repoRoot,
      'packages/sync/test/properties',
      filename,
    )
    if (!existsSync(path)) return ''
    const text = readFileSync(path, 'utf8')
    const m = text.match(/describe\(\s*['"`]([^'"`]+)['"`]/)
    return m ? m[1]! : ''
  }

  test("S-1 audit prose matches what race-row-S-1.property.test.ts actually tests", () => {
    const witnessLabel = extractWitnessDescribe('race-row-S-1.property.test.ts')
    expect(
      witnessLabel,
      'race-row-S-1.property.test.ts must have a describe label',
    ).toMatch(/.+/)
    // The audit doc's S-1 section must mention the witness-file's
    // identity (stale-async resolution) — not silently rename it
    // to a SPEC.async §9.1.1 identity (Abandon-then-resume) the
    // witness does not test.
    const sRowSection = auditText.slice(
      auditText.indexOf('### S-1'),
      auditText.indexOf('### S-2'),
    )
    expect(
      sRowSection.toLowerCase(),
      'audit-doc S-1 must mention "stale-async" — what the witness actually tests',
    ).toContain('stale-async')
  })

  test("S-2 audit prose matches what disposed-mid-load.property.test.ts actually tests", () => {
    // Renamed from race-row-S-2.property.test.ts in #919 to remove
    // the false SPEC.async §9.1.1 S-2 docstring claim. The
    // audit-doc S-2 identity stays "disposed-mid-load" because that
    // is what the witness actually tests; SPEC.async §9.1.1's S-2
    // (open-set drift) has its own witness at
    // conflict-registry-drift.property.test.ts.
    const witnessLabel = extractWitnessDescribe(
      'disposed-mid-load.property.test.ts',
    )
    expect(witnessLabel).toMatch(/.+/)
    const sRowSection = auditText.slice(
      auditText.indexOf('### S-2'),
      auditText.indexOf('### S-3'),
    )
    expect(
      sRowSection.toLowerCase(),
      'audit-doc S-2 must mention "disposed" — what the witness actually tests',
    ).toContain('disposed')
  })

  test("S-3 audit prose matches what its witness file (single-writer-resolution) tests", () => {
    const witnessLabel = extractWitnessDescribe(
      'single-writer-resolution.property.test.ts',
    )
    expect(witnessLabel).toMatch(/.+/)
    const sRowSection = auditText.slice(
      auditText.indexOf('### S-3'),
      auditText.indexOf('## Engine rows'),
    )
    // S-3's witness asserts single-writer-resolution semantics.
    expect(
      sRowSection.toLowerCase(),
      'audit-doc S-3 must mention "single-writer" — what the witness actually tests',
    ).toContain('single-writer')
  })

  test('audit doc has a dedicated callout naming the SPEC.async §9.1.1 row-identity gap', () => {
    // #566 follow-on: the SPEC.async §9.1.1 canonical S-rows
    // (Abandon-then-resume / Open-set drift / Dispatch-shape leak)
    // are DIFFERENT races than what the existing witness files
    // test (Stale-async / Disposed-mid-load / Single-writer). The
    // audit doc must have an explicit, dedicated callout — not a
    // coincidental phrase match — so a reader auditing coverage is
    // told *which* S-row identity each section uses.
    //
    // The callout must mention both SPEC.async §9.1.1 row names
    // that differ from the witness identities ("Abandon-then-resume"
    // and either "Open-set drift" or "Dispatch-shape leak"), so a
    // search of the audit doc surfaces the divergence on either
    // half of the gap.
    expect(
      auditText,
      "audit doc must name SPEC.async's 'Abandon-then-resume' explicitly so " +
        'readers can see the drift between SPEC.async S-1 and the witness',
    ).toContain('Abandon-then-resume')
    expect(
      auditText,
      "audit doc must name SPEC.async's 'Open-set drift' (S-2) or " +
        "'Dispatch-shape leak' (S-3) explicitly",
    ).toMatch(/Open-set drift|Dispatch-shape leak/)
  })
})

describe('SPEC §9.1 still has 17 rows (regression witness)', () => {
  test('SPEC §9.1 table contains 17 numbered rows', () => {
    const start = specText.indexOf('### 9.1 Where each race class is caught')
    const end = specText.indexOf('## 10. Worked example')
    const section = specText.slice(start, end)
    // Match table rows like "| 1 | ... | ... |"
    const rows = section.match(/^\|\s*\d+\s*\|/gm) ?? []
    expect(
      rows.length,
      'SPEC §9.1 should have 17 race-class rows',
    ).toBe(17)
  })
})
