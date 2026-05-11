#!/usr/bin/env node
/**
 * Apalache differential-runner mapping validator (#574).
 *
 * Per #574 (apalache differential runner): the runner at
 * `tools/enumerator/diff/src/main.rs` consumes
 * `tools/apalache-diff/mapping.toml` as the join schema between TLA+
 * corpus models and Rust enumerator scenarios. Before the runner
 * actually invokes `apalache-mc`, every `(model, invariant)` pair in
 * the mapping must resolve to a real INVARIANT / PROPERTY clause in
 * the matching `.tla` file — there is no point invoking apalache-mc
 * with `--inv=DoesNotExist`. This audit is that precondition gate.
 *
 * Mechanizable as: parse the TOML, for each `[[scenarios]]` row read
 * the `tla_path` file as text and assert the `invariant` symbol
 * appears either as a top-level `Name ==` definition (the canonical
 * shape every corpus model uses) or as an `INVARIANT Name` /
 * `INVARIANTS == { ..., Name, ... }` directive (Apalache-config
 * shape, accepted for completeness). For each `[[exceptions]]` row,
 * verify a non-empty `tracking_issue` field — permanent allow-list
 * entries are caught at review.
 *
 * Approach: a hand-rolled minimal TOML reader scoped to this exact
 * schema (10 scenarios + 1 exception, all string-valued fields with
 * one multi-line triple-quoted `reason`). Adding a TOML library to
 * the workspace just for this would be disproportionate; the
 * substring/regex check on the .tla side mirrors the same
 * "proportionate, not parser-grade" doctrine the SARIF audit uses.
 *
 * Exit code:
 *   0 — every (tla_path, invariant) pair resolves AND every exception
 *       row carries a tracking_issue.
 *   1 — at least one violation; per-row report on stderr.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const mappingPath = resolve(repoRoot, 'tools/apalache-diff/mapping.toml')

export type ScenarioRow = {
  name: string
  tla_path: string
  invariant: string
  // Other fields exist (rust_path, expected_apalache, etc.) but are
  // not load-bearing for this audit; we keep the type narrow.
  [key: string]: string
}

export type ExceptionRow = {
  scenario?: string
  kind?: string
  reason?: string
  tracking_issue?: string
  [key: string]: string | undefined
}

export type MappingDoc = {
  scenarios: ScenarioRow[]
  exceptions: ExceptionRow[]
}

export type Violation =
  | {
      kind: 'invariant-missing'
      name: string
      tla_path: string
      invariant: string
      reason: string
    }
  | {
      kind: 'tla-file-missing'
      name: string
      tla_path: string
      invariant: string
      reason: string
    }
  | {
      kind: 'exception-missing-tracking-issue'
      scenario: string
      reason: string
    }

/**
 * Minimal TOML reader scoped to the mapping.toml schema. Recognized:
 *
 *   - Comment lines beginning with `#` (after optional whitespace).
 *   - Blank lines.
 *   - Table-array headers `[[name]]` (only `[[scenarios]]` and
 *     `[[exceptions]]` are meaningful here; others are ignored).
 *   - Key-value pairs `key = "value"` with a quoted string value.
 *   - Multi-line triple-quoted strings `key = """ ... """` (the only
 *     multi-line shape used in the seed file, on `reason`).
 *
 * Anything outside this grammar throws. The parser is intentionally
 * strict so a future schema change (e.g. adding integer fields)
 * surfaces as an audit failure rather than silent data loss.
 *
 * Exported for unit-testing.
 */
export function parseMappingToml(text: string): MappingDoc {
  const scenarios: ScenarioRow[] = []
  const exceptions: ExceptionRow[] = []
  let current: Record<string, string> | null = null
  let currentTable: 'scenarios' | 'exceptions' | 'other' | null = null

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    i++

    if (line.length === 0 || line.startsWith('#')) continue

    // Table-array header.
    const headerMatch = line.match(/^\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]$/)
    if (headerMatch) {
      // Flush prior row.
      if (current && currentTable === 'scenarios') {
        scenarios.push(current as ScenarioRow)
      } else if (current && currentTable === 'exceptions') {
        exceptions.push(current as ExceptionRow)
      }
      current = {}
      const tableName = headerMatch[1]
      if (tableName === 'scenarios') currentTable = 'scenarios'
      else if (tableName === 'exceptions') currentTable = 'exceptions'
      else currentTable = 'other'
      continue
    }

    // Standard table header `[name]` is not used by the schema; reject
    // to keep the parser honest.
    if (/^\[[^[].*\]$/.test(line)) {
      throw new Error(
        `parseMappingToml: unexpected single-bracket table header: ${line}`,
      )
    }

    // Key = value.
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!kvMatch) {
      throw new Error(`parseMappingToml: unparseable line: ${JSON.stringify(line)}`)
    }
    const key = kvMatch[1]!
    let value = kvMatch[2]!.trim()

    if (current === null || currentTable === null) {
      throw new Error(
        `parseMappingToml: key/value outside any [[table]]: ${line}`,
      )
    }

    if (value.startsWith('"""')) {
      // Multi-line triple-quoted string.
      let body = value.slice(3)
      // Single-line triple-quoted: """foo"""
      if (body.endsWith('"""')) {
        current[key] = body.slice(0, -3)
        continue
      }
      const parts: string[] = [body]
      while (i < lines.length) {
        const next = lines[i] ?? ''
        i++
        const idx = next.indexOf('"""')
        if (idx >= 0) {
          parts.push(next.slice(0, idx))
          break
        }
        parts.push(next)
      }
      current[key] = parts.join('\n')
      continue
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      current[key] = value.slice(1, -1)
      continue
    }

    throw new Error(
      `parseMappingToml: unsupported value shape for ${key}: ${value}`,
    )
  }

  // Flush trailing row.
  if (current && currentTable === 'scenarios') {
    scenarios.push(current as ScenarioRow)
  } else if (current && currentTable === 'exceptions') {
    exceptions.push(current as ExceptionRow)
  }

  return { scenarios, exceptions }
}

/**
 * Returns true when `text` declares `invariant` either as a top-level
 * `Invariant ==` definition, or via an `INVARIANT Invariant` /
 * `INVARIANTS == { ..., Invariant, ... }` apalache-mc directive.
 *
 * The check is intentionally textual (substring + simple regex). A
 * full TLA+ parser would be wildly disproportionate for a precondition
 * gate; the audit's job is to catch typos and stale references, not
 * to verify the model's well-formedness.
 *
 * Exported for unit-testing.
 */
export function tlaDeclaresInvariant(text: string, invariant: string): boolean {
  // Escape regex metachars in the invariant name (defence-in-depth;
  // the seed file's symbols are all bare identifiers).
  const esc = invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Shape A: `Name ==` at the start of a line (the canonical TLA+
  // operator/invariant definition shape; a leading whitespace-only
  // prefix is allowed for nested-but-still-top-level cases).
  const defRe = new RegExp(`(^|\\n)\\s*${esc}\\s*==`, 'm')
  if (defRe.test(text)) return true

  // Shape B: `INVARIANT Name` (singular) or `PROPERTY Name`.
  const directiveRe = new RegExp(`\\b(INVARIANT|PROPERTY)\\s+${esc}\\b`)
  if (directiveRe.test(text)) return true

  // Shape C: `INVARIANTS == { Name, ... }` (apalache-mc cfg shape).
  const invariantsListRe = new RegExp(
    `INVARIANTS\\s*==[\\s\\S]*?\\b${esc}\\b`,
  )
  if (invariantsListRe.test(text)) return true

  return false
}

/**
 * Validate every (tla_path, invariant) pair in `doc.scenarios`
 * against the on-disk corpus, and verify every `doc.exceptions` row
 * has a non-empty `tracking_issue`.
 *
 * Returns an array of structured violations (empty array means
 * everything checks out). `readTla` is injected so tests can run
 * without touching the filesystem.
 */
export function validateMapping(
  doc: MappingDoc,
  readTla: (relPath: string) => string | null,
): Violation[] {
  const violations: Violation[] = []

  for (const row of doc.scenarios) {
    const text = readTla(row.tla_path)
    if (text === null) {
      violations.push({
        kind: 'tla-file-missing',
        name: row.name,
        tla_path: row.tla_path,
        invariant: row.invariant,
        reason: 'tla file does not exist on disk',
      })
      continue
    }
    if (!tlaDeclaresInvariant(text, row.invariant)) {
      violations.push({
        kind: 'invariant-missing',
        name: row.name,
        tla_path: row.tla_path,
        invariant: row.invariant,
        reason: 'invariant not found in tla file',
      })
    }
  }

  for (const row of doc.exceptions) {
    const tracking = (row.tracking_issue ?? '').trim()
    if (tracking.length === 0) {
      violations.push({
        kind: 'exception-missing-tracking-issue',
        scenario: row.scenario ?? '<unnamed>',
        reason: 'exception row missing non-empty tracking_issue',
      })
    }
  }

  return violations
}

function main(): void {
  if (!existsSync(mappingPath)) {
    process.stderr.write(
      `check-apalache-mapping: missing mapping file ${mappingPath}\n`,
    )
    process.exit(1)
  }

  let doc: MappingDoc
  try {
    doc = parseMappingToml(readFileSync(mappingPath, 'utf8'))
  } catch (e) {
    process.stderr.write(
      `check-apalache-mapping: failed to parse ${mappingPath}: ${(e as Error).message}\n`,
    )
    process.exit(1)
  }

  const violations = validateMapping(doc, (relPath) => {
    const abs = resolve(repoRoot, relPath)
    if (!existsSync(abs)) return null
    return readFileSync(abs, 'utf8')
  })

  if (violations.length > 0) {
    for (const v of violations) {
      if (v.kind === 'invariant-missing' || v.kind === 'tla-file-missing') {
        process.stderr.write(
          `check-apalache-mapping: ${v.kind} — ` +
            `name=${v.name} tla_path=${v.tla_path} ` +
            `invariant=${v.invariant} reason="${v.reason}"\n`,
        )
      } else {
        process.stderr.write(
          `check-apalache-mapping: ${v.kind} — ` +
            `scenario=${v.scenario} reason="${v.reason}"\n`,
        )
      }
    }
    process.stderr.write(
      `check-apalache-mapping: FAIL — ${violations.length} violation(s) ` +
        `across ${doc.scenarios.length} scenario(s) + ${doc.exceptions.length} exception(s)\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `check-apalache-mapping: PASS — ${doc.scenarios.length} scenario(s) ` +
      `+ ${doc.exceptions.length} exception(s) all resolve\n`,
  )
  process.exit(0)
}

// Run only when invoked as a CLI; remain importable from tests.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main()
}
