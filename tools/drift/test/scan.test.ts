import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

describe('scanFile', () => {
  it('flags Jotai imports', () => {
    const f = scanFile('src/foo.tsx', `import { atom } from 'jotai'\n`)
    expect(f.length).toBe(1)
    expect(f[0]?.category).toBe('jotai-import')
  })

  it('flags Jotai hooks', () => {
    const src = `
      import { useAtom, useAtomValue, useSetAtom } from 'jotai'
      const [a, setA] = useAtom(myAtom)
      const v = useAtomValue(myAtom)
    `
    const f = scanFile('src/c.tsx', src)
    expect(f.filter((x) => x.category === 'jotai-hook').length).toBeGreaterThanOrEqual(3)
  })

  it('flags MobX imports + observer()', () => {
    const f = scanFile(
      'src/store.ts',
      `import { observable, computed } from 'mobx'\nexport default observer(Component)`,
    )
    expect(f.some((x) => x.category === 'mobx-import')).toBe(true)
    expect(f.some((x) => x.category === 'mobx-observer')).toBe(true)
  })

  it('flags Redux Toolkit + react-redux hooks', () => {
    const f = scanFile(
      'src/slice.ts',
      `import { createSlice } from '@reduxjs/toolkit'\nimport { useSelector } from 'react-redux'\nuseSelector(s => s)`,
    )
    expect(f.some((x) => x.category === 'redux-import')).toBe(true)
    expect(f.some((x) => x.category === 'redux-hook')).toBe(true)
  })

  it('returns no findings for clean causl code', () => {
    const f = scanFile(
      'src/clean.ts',
      `import { useCausl } from '@causl/react'\nconst v = useCausl((g) => g.now)`,
    )
    expect(f).toEqual([])
  })

  it('captures line/column position', () => {
    const f = scanFile('src/a.ts', `\n\nimport { atom } from 'jotai'`)
    expect(f[0]?.line).toBe(3)
    expect(f[0]?.column).toBeGreaterThan(0)
  })
})
