/**
 * Tests for check-exemptions (#572 / GAP-A8-3 / wave-28).
 *
 * The script gates SPEC §16A.5's third escape valve: per-row exemptions
 * recorded in `causl-exemptions.md`. The tests below exercise the
 * pure parser/validator predicates against synthetic inputs (so the
 * regression witness is independent of any future row growth) AND a
 * happy-path against the real seed file (so the gate cannot silently
 * drift away from the on-disk schema).
 *
 * The negative cases pin the four schema rules SPEC §16A.5 names:
 *   - non-empty justification (the "no lies" rule);
 *   - rule_id matches the SARIF rule-id shape (`causl/<kebab-name>`);
 *   - owner is a `@` handle so CODEOWNERS-routing is mechanical;
 *   - every column is present (no silent column drops).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  countExemptions,
  parseExemptionsTable,
  splitRow,
  validateRows,
} from '../check-exemptions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const scriptPath = resolve(__dirname, '../check-exemptions.ts')
const realExemptionsPath = resolve(repoRoot, 'causl-exemptions.md')

describe('splitRow', () => {
  test('strips framing pipes and trims cells', () => {
    assert.deepEqual(splitRow('| a | b | c |'), ['a', 'b', 'c'])
  })

  test('handles empty cells', () => {
    assert.deepEqual(splitRow('| a |  | c |'), ['a', '', 'c'])
  })
})

describe('parseExemptionsTable', () => {
  test('parses the real seed file (zero or more rows, all well-formed)', () => {
    const text = readFileSync(realExemptionsPath, 'utf8')
    const rows = parseExemptionsTable(text)
    // The seed ships with an empty active-exemptions table; tolerate
    // 0+ rows so this test does not regress the day a real exemption
    // lands. The validator test below pins the well-formedness floor.
    const violations = validateRows(rows)
    assert.deepEqual(
      violations,
      [],
      `expected zero violations; got ${JSON.stringify(violations, null, 2)}`,
    )
  })

  test('skips the separator row', () => {
    const md = `
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** | reason that is plenty long | @team |
`
    const rows = parseExemptionsTable(md)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.rule_id, 'causl/foo')
  })

  test('stops at the first non-pipe line after the header', () => {
    const md = `
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** | reason that is plenty long | @team |

| not-this | this-table | is-after-blank | @nope |
`
    const rows = parseExemptionsTable(md)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.rule_id, 'causl/foo')
  })

  test('ignores prose lines before the rule_id header', () => {
    const md = `
# Active exemptions

Some preamble text describing the file.

| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/x | a/** | a long enough reason | @team |
`
    const rows = parseExemptionsTable(md)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.rule_id, 'causl/x')
  })
})

describe('validateRows (happy path)', () => {
  test('a single well-formed row passes', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/subscribe-without-dispose | packages/legacy/** | Pre-#220 callsites, removal in flight | @core-team |
`)
    assert.deepEqual(validateRows(rows), [])
  })
})

describe('validateRows (negative cases)', () => {
  test('empty justification fails the check', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** |  | @team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some(
        (v) => v.kind === 'empty-cell' && v.column === 'justification',
      ),
      `expected an empty-cell violation on justification; got ${JSON.stringify(violations)}`,
    )
  })

  test('short justification (<=10 chars) fails the check', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** | because | @team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some((v) => v.kind === 'short-justification'),
      `expected a short-justification violation; got ${JSON.stringify(violations)}`,
    )
  })

  test('malformed rule_id fails the check', () => {
    // Wrong namespace — must be `causl/...`.
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| eslint/no-unused-vars | a/** | this is a fine reason really | @team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some((v) => v.kind === 'malformed-rule-id'),
      `expected a malformed-rule-id violation; got ${JSON.stringify(violations)}`,
    )
  })

  test('rule_id with uppercase letters fails the check', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/SubscribeWithoutDispose | a/** | this is a fine reason really | @team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some((v) => v.kind === 'malformed-rule-id'),
      `expected a malformed-rule-id violation; got ${JSON.stringify(violations)}`,
    )
  })

  test('owner without `@` prefix fails the check', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** | this is a fine reason really | core-team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some((v) => v.kind === 'missing-at-prefix'),
      `expected a missing-at-prefix violation; got ${JSON.stringify(violations)}`,
    )
  })

  test('empty file_glob fails the check', () => {
    const rows = parseExemptionsTable(`
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo |  | this is a fine reason really | @team |
`)
    const violations = validateRows(rows)
    assert.ok(
      violations.some(
        (v) => v.kind === 'empty-cell' && v.column === 'file_glob',
      ),
      `expected an empty-cell violation on file_glob; got ${JSON.stringify(violations)}`,
    )
  })
})

describe('countExemptions', () => {
  test('returns 0 for an empty table', () => {
    const md = `
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
`
    assert.equal(countExemptions(md), 0)
  })

  test('counts only well-formed rows', () => {
    // One good, one bad — count is 1.
    const md = `
| rule_id | file_glob | justification | owner |
| ------- | --------- | ------------- | ----- |
| causl/foo | a/** | a long enough reason | @team |
| causl/bar | b/** | short | @team |
`
    assert.equal(countExemptions(md), 1)
  })
})

describe('check-exemptions script integration', () => {
  test('end-to-end script exits 0 against the real seed file', () => {
    // Invoke from a non-root cwd to confirm the script is cwd-resilient
    // (same #565 lesson the other audit scripts learned the hard way).
    const result = spawnSync('node', ['--import', 'tsx', scriptPath], {
      cwd: resolve(repoRoot, 'tools'),
      encoding: 'utf8',
    })
    assert.equal(
      result.status,
      0,
      `script exited ${result.status}; ` +
        `stdout=${result.stdout} stderr=${result.stderr}`,
    )
    assert.match(result.stdout, /PASS — \d+ exemption row\(s\) all well-formed/)
  })
})
