/**
 * Per-rule fixture corpus for the J-NN (Jotai → causl) family.
 * Each rule has at least one true-positive and one true-negative
 * case; aliased imports (`import { atom as a }`) verify the AST
 * pass survives a regex-on-source bypass.
 */

import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

function ids(src: string): string[] {
  return scanFile('src/x.tsx', src).map((f) => f.ruleId)
}

describe('rule J-01 — atom(initial)', () => {
  it('fires on atom() with literal arg', () => {
    expect(ids(`import { atom } from 'jotai'\nconst a = atom(0)`)).toContain('J-01')
  })
  it('fires on aliased import', () => {
    expect(ids(`import { atom as a } from 'jotai'\nconst x = a(0)`)).toContain('J-01')
  })
  it('does not fire on identically-named function from a different module', () => {
    expect(ids(`import { atom } from 'unrelated'\nconst a = atom(0)`)).not.toContain('J-01')
  })
})

describe('rule J-02 — atom(get => ...)', () => {
  it('fires on derived atom', () => {
    expect(
      ids(`import { atom } from 'jotai'\nconst d = atom((get) => get(a))`),
    ).toContain('J-02')
  })
  it('does not fire on input atom', () => {
    expect(ids(`import { atom } from 'jotai'\nconst d = atom(0)`)).not.toContain('J-02')
  })
})

describe('rule J-03 — atomFamily', () => {
  it('fires on atomFamily call', () => {
    expect(
      ids(`import { atomFamily } from 'jotai/utils'\nconst f = atomFamily((id) => atom(id))`),
    ).toContain('J-03')
  })
})

describe('rule J-04 — atomWithStorage', () => {
  it('fires on atomWithStorage call', () => {
    expect(
      ids(`import { atomWithStorage } from 'jotai/utils'\nconst a = atomWithStorage('k', 0)`),
    ).toContain('J-04')
  })
})

describe('rule J-05 — useAtomValue', () => {
  it('fires on useAtomValue call', () => {
    expect(
      ids(`import { useAtomValue } from 'jotai'\nfunction C() { return useAtomValue(a) }`),
    ).toContain('J-05')
  })
})

describe('rule J-06 — useSetAtom', () => {
  it('fires on useSetAtom call', () => {
    expect(
      ids(`import { useSetAtom } from 'jotai'\nfunction C() { const s = useSetAtom(a); return null }`),
    ).toContain('J-06')
  })
})

describe('rule J-07 — loadable', () => {
  it('fires on loadable call', () => {
    expect(
      ids(`import { loadable } from 'jotai/utils'\nconst l = loadable(a)`),
    ).toContain('J-07')
  })
})

describe('rule J-08 — <Provider>', () => {
  it('fires on jotai Provider JSX', () => {
    expect(
      ids(`import { Provider } from 'jotai'\nfunction A() { return <Provider><X/></Provider> }`),
    ).toContain('J-08')
  })
  it('does not fire on react Provider', () => {
    expect(
      ids(`function A() { return <Provider><X/></Provider> }`),
    ).not.toContain('J-08')
  })
})

describe('rule J-09 — useSetAtom captured outside a component', () => {
  it('fires on module-scope useSetAtom binding', () => {
    expect(
      ids(`import { useSetAtom } from 'jotai'\nconst set = useSetAtom(a)`),
    ).toContain('J-09')
  })
})
