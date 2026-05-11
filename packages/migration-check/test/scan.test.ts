/**
 * Smoke tests for `scanFile` — broad coverage that any rule fires
 * on its canonical positive case. Per-rule-class fixtures live in
 * `rule-jotai.test.ts`, `rule-mobx.test.ts`, `rule-redux.test.ts`,
 * and `rule-cross.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

describe('scanFile', () => {
  it('flags input atoms (J-01)', () => {
    const f = scanFile('src/foo.tsx', `import { atom } from 'jotai'\nconst a = atom(0)\n`)
    expect(f.some((x) => x.ruleId === 'J-01')).toBe(true)
  })

  it('flags Jotai hooks (J-05/J-06)', () => {
    const src = `
      import { useAtomValue, useSetAtom } from 'jotai'
      function C() {
        const v = useAtomValue(myAtom)
        const set = useSetAtom(myAtom)
        return v
      }
    `
    const f = scanFile('src/c.tsx', src)
    expect(f.some((x) => x.ruleId === 'J-05')).toBe(true)
    expect(f.some((x) => x.ruleId === 'J-06')).toBe(true)
  })

  it('flags MobX makeAutoObservable (M-01)', () => {
    const f = scanFile(
      'src/store.ts',
      `import { makeAutoObservable } from 'mobx'\nclass Store { constructor() { makeAutoObservable(this) } }\n`,
    )
    expect(f.some((x) => x.ruleId === 'M-01')).toBe(true)
  })

  it('flags Redux Toolkit createSlice + react-redux hooks (R-01/R-02/R-03)', () => {
    const f = scanFile(
      'src/slice.ts',
      `import { createSlice } from '@reduxjs/toolkit'
       import { useSelector, useDispatch } from 'react-redux'
       const slice = createSlice({ name: 'x', initialState: 0, reducers: {} })
       function C() { useSelector((s) => s); useDispatch(); return null }`,
    )
    expect(f.some((x) => x.ruleId === 'R-01')).toBe(true)
    expect(f.some((x) => x.ruleId === 'R-02')).toBe(true)
    expect(f.some((x) => x.ruleId === 'R-03')).toBe(true)
  })

  it('returns no findings for clean causl code', () => {
    const f = scanFile(
      'src/clean.ts',
      `import { useCausl } from '@causl/react'\nconst v = useCausl((g) => g.now)`,
    )
    expect(f).toEqual([])
  })

  it('captures line/column position', () => {
    const f = scanFile(
      'src/a.ts',
      `\n\nimport { atom } from 'jotai'\nconst a = atom(0)\n`,
    )
    const finding = f.find((x) => x.ruleId === 'J-01')
    expect(finding?.line).toBe(4)
    expect(finding?.column).toBeGreaterThan(0)
  })

  it('every finding carries ruleId + severity matching the catalogue', () => {
    const f = scanFile(
      'src/mix.ts',
      `import { atom } from 'jotai'\nconst a = atom(0)\nconst d = atom((g) => g(a))\n`,
    )
    expect(f.length).toBeGreaterThan(0)
    for (const finding of f) {
      expect(finding.ruleId).toMatch(/^[JMRS]-\d{2}$/)
      expect(['critical', 'important', 'nice-to-have']).toContain(finding.severity)
    }
  })
})
