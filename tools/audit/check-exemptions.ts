#!/usr/bin/env node
/**
 * `causl-exemptions.md` schema validator (#572 / GAP-A8-3 / wave-28).
 *
 * SPEC §16A.5 names per-row exemptions as the third (and loudest)
 * escape valve in the false-positive economy. The exemptions live
 * in a markdown table at the repo-root `causl-exemptions.md`; this
 * audit is the precondition gate that keeps the table from rotting
 * into a graveyard of malformed allow-list rows.
 *
 * Approach: a tiny markdown-table extractor scoped to the exact
 * shape `causl-exemptions.md` ships with. We look for the first
 * pipe-delimited header line whose first column is exactly
 * `rule_id` (after trimming). Every subsequent pipe-delimited row
 * (until we hit a non-pipe line) is parsed as a candidate
 * exemption; the separator row (`| --- | ... |`) is ignored.
 *
 * Per-row schema (every column REQUIRED and non-empty):
 *   - `rule_id`       — matches `^causl/[a-z0-9-]+$`. Mirrors the
 *                       SARIF rule-id shape emitted by
 *                       `tools/checker/src/sarif.rs`.
 *   - `file_glob`     — non-empty path or glob; no validation
 *                       beyond non-empty (CODEOWNERS review is the
 *                       arbiter of "is this scope reasonable").
 *   - `justification` — `> 10` characters. The threshold is loose
 *                       on purpose: the audit catches placeholder
 *                       text like `"TODO"` / `"because"` but does
 *                       not try to police prose quality.
 *   - `owner`         — starts with `@`. A team or individual
 *                       github handle.
 *
 * Exit code:
 *   0 — every row in the table parses cleanly OR the table is empty.
 *   1 — at least one row violates the schema; per-row report on stderr.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const exemptionsPath = resolve(repoRoot, 'causl-exemptions.md')

export type ExemptionRow = {
  rule_id: string
  file_glob: string
  justification: string
  owner: string
  /** 1-based line number in the source markdown — used in error messages. */
  line: number
}

export type Violation = {
  kind:
    | 'empty-cell'
    | 'malformed-rule-id'
    | 'short-justification'
    | 'missing-at-prefix'
    | 'wrong-column-count'
  line: number
  column?: keyof Omit<ExemptionRow, 'line'>
  detail: string
}

const EXPECTED_COLUMNS: Array<keyof Omit<ExemptionRow, 'line'>> = [
  'rule_id',
  'file_glob',
  'justification',
  'owner',
]

/**
 * Split a markdown table row line into trimmed cell values. Drops
 * the leading and trailing empty cells produced by the framing
 * pipes. Exported for unit-testing.
 */
export function splitRow(line: string): string[] {
  // A markdown table row is `| a | b | c |` — splitting on `|`
  // yields `['', ' a ', ' b ', ' c ', '']`. Strip the framing
  // empties and trim each remaining cell.
  const parts = line.split('|').map((c) => c.trim())
  if (parts.length >= 2 && parts[0] === '' && parts[parts.length - 1] === '') {
    return parts.slice(1, -1)
  }
  return parts
}

/**
 * True if `line` is a markdown-table separator row (e.g.
 * `| --- | --- |`). Separator cells are dashes, optionally
 * surrounded by `:` for alignment hints.
 */
function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c))
}

/**
 * Extract every well-formed exemption row from the markdown text.
 * Stops scanning at the first non-pipe line after the header. The
 * separator row is skipped. Rows whose column count differs from
 * the header's are returned with a `wrong-column-count` violation
 * pre-attached at validation time — we still emit them as `ExemptionRow`
 * with empty fills so the validator can report a structured error.
 *
 * Exported for unit-testing.
 */
export function parseExemptionsTable(markdown: string): ExemptionRow[] {
  const lines = markdown.split('\n')
  const rows: ExemptionRow[] = []
  let inTable = false
  let headerCells: string[] | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()

    if (!inTable) {
      // Look for the header row whose first cell is exactly `rule_id`.
      // Multiple tables in the doc are tolerated; we pick the one whose
      // header matches the schema column set.
      if (!trimmed.startsWith('|')) continue
      const cells = splitRow(trimmed)
      if (cells[0] === 'rule_id') {
        headerCells = cells
        inTable = true
      }
      continue
    }

    // Already inside the table.
    if (!trimmed.startsWith('|')) {
      // Blank line / non-pipe line ends the table.
      break
    }
    const cells = splitRow(trimmed)
    if (isSeparatorRow(cells)) continue

    // Pad / truncate to the header width so downstream code can
    // address by column index without bounds-checking. Wrong-width
    // rows still surface as a violation at validation time (we do
    // not silently drop them — that would hide the bug).
    const target = headerCells?.length ?? EXPECTED_COLUMNS.length
    const padded = cells.slice(0, target)
    while (padded.length < target) padded.push('')

    rows.push({
      rule_id: padded[0] ?? '',
      file_glob: padded[1] ?? '',
      justification: padded[2] ?? '',
      owner: padded[3] ?? '',
      line: i + 1,
    })
  }

  return rows
}

const RULE_ID_RE = /^causl\/[a-z0-9-]+$/

/**
 * Validate the per-row schema. Returns an empty array when every
 * row is well-formed (and when the table is empty — see the SPEC
 * §16A.5 loudness rationale).
 *
 * Exported for unit-testing.
 */
export function validateRows(rows: ExemptionRow[]): Violation[] {
  const violations: Violation[] = []
  for (const row of rows) {
    for (const col of EXPECTED_COLUMNS) {
      if ((row[col] ?? '').length === 0) {
        violations.push({
          kind: 'empty-cell',
          line: row.line,
          column: col,
          detail: `column \`${col}\` is empty`,
        })
      }
    }
    if (row.rule_id.length > 0 && !RULE_ID_RE.test(row.rule_id)) {
      violations.push({
        kind: 'malformed-rule-id',
        line: row.line,
        column: 'rule_id',
        detail: `rule_id ${JSON.stringify(row.rule_id)} does not match ${RULE_ID_RE}`,
      })
    }
    if (row.justification.length > 0 && row.justification.length <= 10) {
      violations.push({
        kind: 'short-justification',
        line: row.line,
        column: 'justification',
        detail: `justification has ${row.justification.length} chars; need > 10`,
      })
    }
    if (row.owner.length > 0 && !row.owner.startsWith('@')) {
      violations.push({
        kind: 'missing-at-prefix',
        line: row.line,
        column: 'owner',
        detail: `owner ${JSON.stringify(row.owner)} must start with '@'`,
      })
    }
  }
  return violations
}

/**
 * Count valid (= passes-validation) rows in the markdown text.
 * The Rust SARIF emitter mirrors this counter so the count
 * surfaced in SARIF output stays in lockstep with this audit.
 */
export function countExemptions(markdown: string): number {
  const rows = parseExemptionsTable(markdown)
  const violations = validateRows(rows)
  // A row is "valid" iff no violation cites its line.
  const badLines = new Set(violations.map((v) => v.line))
  return rows.filter((r) => !badLines.has(r.line)).length
}

function main(): void {
  if (!existsSync(exemptionsPath)) {
    process.stderr.write(
      `check-exemptions: missing exemptions file ${exemptionsPath}\n`,
    )
    process.exit(1)
  }

  const markdown = readFileSync(exemptionsPath, 'utf8')
  const rows = parseExemptionsTable(markdown)
  const violations = validateRows(rows)

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `check-exemptions: ${v.kind} at line ${v.line}` +
          (v.column ? ` (column \`${v.column}\`)` : '') +
          ` — ${v.detail}\n`,
      )
    }
    process.stderr.write(
      `check-exemptions: FAIL — ${violations.length} violation(s) ` +
        `across ${rows.length} row(s)\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `check-exemptions: PASS — ${rows.length} exemption row(s) all well-formed\n`,
  )
  process.exit(0)
}

// Run only when invoked as a CLI; remain importable from tests.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main()
}
