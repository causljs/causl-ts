/**
 * Tests for check-sarif-schema (#584 A17-12).
 *
 * The script's external behavior is "spawn causl-check, parse stdout,
 * validate shape" — but the binary may or may not be built in any
 * given environment. The unit tests here exercise the pure
 * `validateSarif` predicate against hand-crafted positive and
 * negative cases so the shape contract has a regression witness that
 * doesn't depend on the Rust toolchain.
 *
 * The integration test at the bottom only runs when the release
 * binary is present; it is the same code path the CLI takes. It is
 * skipped (not failed) when the binary is missing, mirroring the
 * SKIP behavior of the script itself.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { validateSarif } from '../check-sarif-schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const scriptPath = resolve(__dirname, '../check-sarif-schema.ts')
const binPath = resolve(
  repoRoot,
  'tools/checker/target/release/causl-check',
)

const validSarif = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'causl-check',
          rules: [{ id: 'causl/cycle' }],
        },
      },
      results: [
        {
          ruleId: 'causl/cycle',
          level: 'error',
          message: { text: 'Derivation cycle detected' },
        },
      ],
    },
  ],
}

describe('validateSarif (positive)', () => {
  test('accepts the canonical shape', () => {
    assert.deepEqual(validateSarif(validSarif), [])
  })

  test('accepts an empty results array', () => {
    const doc = {
      ...validSarif,
      runs: [{ ...validSarif.runs[0]!, results: [] }],
    }
    assert.deepEqual(validateSarif(doc), [])
  })
})

describe('validateSarif (negative — required-field gates)', () => {
  test('rejects wrong version (e.g. someone bumps to 2.2.0 without intent)', () => {
    const doc = { ...validSarif, version: '2.2.0' }
    const errors = validateSarif(doc)
    assert.ok(errors.some((e) => e.path === '$.version'))
  })

  test('rejects empty runs array', () => {
    const doc = { ...validSarif, runs: [] }
    const errors = validateSarif(doc)
    assert.ok(errors.some((e) => e.path === '$.runs'))
  })

  test('rejects missing $schema', () => {
    const { $schema, ...rest } = validSarif
    void $schema
    const errors = validateSarif(rest)
    assert.ok(errors.some((e) => e.path === '$.$schema'))
  })

  test('rejects missing tool.driver.name', () => {
    const doc = {
      ...validSarif,
      runs: [
        {
          tool: { driver: { rules: [] } },
          results: [],
        },
      ],
    }
    const errors = validateSarif(doc)
    assert.ok(errors.some((e) => e.path === '$.runs[0].tool.driver.name'))
  })

  test('rejects result with no message.text', () => {
    const doc = {
      ...validSarif,
      runs: [
        {
          ...validSarif.runs[0]!,
          results: [{ ruleId: 'x', level: 'error' }],
        },
      ],
    }
    const errors = validateSarif(doc)
    assert.ok(
      errors.some((e) => e.path === '$.runs[0].results[0].message.text'),
    )
  })

  test('rejects non-object root', () => {
    assert.ok(validateSarif(null).length > 0)
    assert.ok(validateSarif('not-json').length > 0)
  })
})

describe('check-sarif-schema script integration', () => {
  test('script exits 0 against the actual cycle.json fixture (when binary is built)', () => {
    if (!existsSync(binPath)) {
      // SKIP: matches the script's own SKIP-on-missing-binary behavior.
      return
    }
    const result = spawnSync('node', ['--import', 'tsx', scriptPath], {
      encoding: 'utf8',
    })
    assert.equal(
      result.status,
      0,
      `script exited ${result.status}; ` +
        `stdout=${result.stdout} stderr=${result.stderr}`,
    )
    assert.match(result.stdout, /PASS — SARIF 2\.1\.0 shape valid/)
  })
})
