/**
 * @packageDocumentation
 *
 * EPIC-1 PR-B1 / TASK 1.B1.5 — schema discipline tests.
 *
 * The schema-3 wire-format break is held by four invariants and these
 * tests pin each:
 *
 *   1. The schema constant in `@causl/core` (TypeScript) and the Cargo
 *      metadata pin in `tools/checker/Cargo.toml` are equal. A
 *      one-sided bump trips the lockstep workflow at CI time and trips
 *      this test at PR time.
 *   2. `parseCauslModel` rejects schema-2 documents with a structured
 *      error naming the offending field. No silent migration inside
 *      the validator.
 *   3. Every JSON fixture under `tools/checker/tests/fixtures/` is
 *      schema 3 — migration drift is caught at PR time.
 *   4. The migration codemod is byte-stable across the fixture tree:
 *      running it twice produces identical bytes (idempotence at the
 *      directory level).
 *
 * Wirfs-Brock's framing: the wire-format authority owns the gates.
 * These tests are the structural defense against a future PR that
 * loosens any of the four invariants.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CAUSL_MODEL_SCHEMA, parseCauslModel } from '../src/index.js'
import { migrateOne } from '../../../tools/migrate-ir-2-to-3.js'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const CARGO_TOML = path.join(REPO_ROOT, 'tools/checker/Cargo.toml')
const FIXTURE_DIR = path.join(REPO_ROOT, 'tools/checker/tests/fixtures')

describe('TASK 1.B1.5 / schema-3 discipline', () => {
  /**
   * Test 1 — `CAUSL_MODEL_SCHEMA` is exactly 3 under PR-B1. The
   * constant is the wire-format authority's source of truth; the
   * Rust Cargo metadata pin and the lockstep workflow both consume
   * it. A future bump must coordinate across all three sites.
   */
  it('CAUSL_MODEL_SCHEMA === 3 (PR-B1 baseline)', () => {
    expect(CAUSL_MODEL_SCHEMA).toBe(3)
  })

  /**
   * Test 2 — `tools/checker/Cargo.toml` pins
   * `causl_model_schema = "3"` in `[package.metadata]`. The lockstep
   * workflow asserts equality between this value and the TS
   * constant; we mirror the assertion here so the discipline holds
   * even if a developer skips the workflow run locally.
   */
  it('Cargo.toml pin causl_model_schema === "3"', async () => {
    const cargo = await fs.readFile(CARGO_TOML, 'utf8')
    const m = cargo.match(/causl_model_schema\s*=\s*"([^"]+)"/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(String(CAUSL_MODEL_SCHEMA))
  })

  /**
   * Test 3 — `parseCauslModel` rejects a schema-2 document with a
   * `path: ['schema']` error. The validator is the structural gate
   * before the linter runs; mismatched-schema documents fail loudly
   * rather than silently round-trip.
   */
  it('parseCauslModel rejects schema 2 with a structured error', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      scopes: [],
      bridges: [],
    }
    const result = parseCauslModel(v2)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toEqual(['schema'])
      expect(result.reason).toContain('expected schema 3')
    }
  })

  /**
   * Test 4 — every JSON fixture under `tools/checker/tests/fixtures/`
   * is schema 3, with the *deliberate* exception of fixtures whose
   * name contains `schema_mismatch` (used by the Rust Schema pass
   * tests to drive the rejection path). A new fixture committed at
   * schema 2 outside that whitelist fails this test before the Rust
   * checker ever runs.
   */
  it('every JSON fixture under tools/checker/tests/fixtures is schema 3 (modulo schema_mismatch)', async () => {
    const files = await collectJsonFixtures(FIXTURE_DIR)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as { schema?: unknown }
      const isMismatchProbe = path.basename(file).includes('schema_mismatch')
      if (isMismatchProbe) {
        expect(
          parsed.schema,
          `mismatch probe ${path.relative(REPO_ROOT, file)}`,
        ).not.toBe(3)
      } else {
        expect(
          parsed.schema,
          `fixture ${path.relative(REPO_ROOT, file)}`,
        ).toBe(3)
      }
    }
  })

  /**
   * Test 5 — the migration codemod is byte-stable across the
   * fixture tree. Running `migrateOne` on every fixture produces
   * output that, when fed back through `migrateOne`, is byte-equal.
   * Idempotence at the directory level is the property that lets
   * the codemod run as a CI safety net without worrying about
   * double-application.
   */
  it('migration codemod is byte-stable across the fixture tree', async () => {
    const files = await collectJsonFixtures(FIXTURE_DIR)
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      const once = migrateOne(parsed, { seed: '0xdeadbeef' })
      const twice = migrateOne(once, { seed: '0xdeadbeef' })
      expect(
        JSON.stringify(twice),
        `fixture ${path.relative(REPO_ROOT, file)}`,
      ).toBe(JSON.stringify(once))
    }
  })

  /**
   * Test 6 — the Cargo metadata pin lives in the same `[package]`
   * block the lockstep workflow grep regex hits. A future PR that
   * relocates the metadata to a different table breaks the grep
   * silently; this test catches it.
   */
  it('Cargo.toml metadata block is present and structured', async () => {
    const cargo = await fs.readFile(CARGO_TOML, 'utf8')
    expect(cargo).toMatch(/\[package\.metadata\]/)
    expect(cargo).toMatch(/causl_model_schema\s*=\s*"3"/)
  })
})

/**
 * Walk a directory and return every `.json` path. Used by the fixture
 * tests to enumerate the migration targets.
 */
async function collectJsonFixtures(root: string): Promise<readonly string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await visit(full)
      else if (e.isFile() && full.endsWith('.json')) out.push(full)
    }
  }
  await visit(root)
  return out
}
