/**
 * Default-extension contract for `scanDirectory` (#242).
 *
 * The catalogue's predicate contract is language-level (`docs/migration/
 * RULE_CATALOGUE.md`): a Jotai `atom(0)` is drift regardless of the
 * file extension that wraps it. The walker, however, is the gate
 * that decides which files reach `scanFile`. If the walker's
 * default extension list omits a module-format extension a real
 * codebase actually ships, the report comes back clean for a tree
 * that is provably non-migrated, and the validation procedure's
 * "syntactic clean" axis (`docs/migration-validation.md`) silently
 * fails open.
 *
 * This file exercises the walk-filter contract, not the predicates
 * themselves. The predicates already have rule-class fixtures under
 * `rule-{jotai,mobx,redux,cross}.test.ts`.
 */

import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CATALOGUE_VERSION, scanDirectory } from '../src/index.js'

describe('scanDirectory default extensions', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'migration-check-ext-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function write(rel: string, body: string): Promise<void> {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, body, 'utf8')
  }

  it('scans .mjs files by default and surfaces the catalogue rule', async () => {
    // ESM-only Jotai store — common in pnpm workspaces that emit
    // `.mjs` for the ESM entry point.
    await write(
      'src/store.mjs',
      `import { atom } from 'jotai'\nexport const counter = atom(0)\n`,
    )
    const report = await scanDirectory(root)
    expect(report.stats.filesScanned).toBeGreaterThanOrEqual(1)
    expect(report.findings.some((f) => f.ruleId === 'J-01')).toBe(true)
  })

  it('scans .cjs files by default and surfaces the catalogue rule', async () => {
    // CJS-only Redux reducer — common in mixed-output monorepos.
    await write(
      'src/reducer.cjs',
      `const { createSlice } = require('@reduxjs/toolkit')\nconst slice = createSlice({ name: 'x', initialState: 0, reducers: {} })\nmodule.exports = slice\n`,
    )
    const report = await scanDirectory(root)
    expect(report.stats.filesScanned).toBeGreaterThanOrEqual(1)
    expect(report.findings.some((f) => f.ruleId === 'R-01')).toBe(true)
  })

  it('scans a mixed-format tree (.ts + .mjs + .cjs) in one pass', async () => {
    await write(
      'src/jotai-store.mjs',
      `import { atom } from 'jotai'\nconst c = atom(0)\n`,
    )
    await write(
      'src/redux-slice.cjs',
      `const { createSlice } = require('@reduxjs/toolkit')\nconst s = createSlice({ name: 'a', initialState: 0, reducers: {} })\n`,
    )
    await write(
      'src/clean.ts',
      `import { useCausl } from '@causljs/react'\nconst v = useCausl((g) => g.now)\n`,
    )
    const report = await scanDirectory(root)
    expect(report.stats.filesScanned).toBe(3)
    expect(report.findings.some((f) => f.ruleId === 'J-01')).toBe(true)
    expect(report.findings.some((f) => f.ruleId === 'R-01')).toBe(true)
  })

  it('respects an explicit `extensions` override (narrowing still works)', async () => {
    // Locks override semantics: the new default must not silently
    // override an explicit narrowing.
    await write(
      'src/store.mjs',
      `import { atom } from 'jotai'\nconst c = atom(0)\n`,
    )
    await write(
      'src/clean.ts',
      `import { useCausl } from '@causljs/react'\nconst v = useCausl((g) => g.now)\n`,
    )
    const report = await scanDirectory(root, { extensions: ['.ts'] })
    expect(report.stats.filesScanned).toBe(1)
    expect(report.findings).toHaveLength(0)
  })

  it('extension change does not bump the catalogue schema version', () => {
    // Extension list is a walk-filter contract, not a schema
    // contract. `CATALOGUE_VERSION` is the public schema knob and
    // it must stay pinned across this fix.
    expect(CATALOGUE_VERSION).toBe('0.1')
  })
})
