/**
 * Light fuzz / property-style coverage for the rule predicates.
 *
 * The catalogue's stability claim is that AST-driven predicates
 * survive aliasing, comment camouflage, and reformatting. Because
 * `@causl/migration-check` does not yet depend on `fast-check`
 * (and the `@causl/core/testing` `propertyTrials` helper itself
 * is a thin fast-check wrapper that we'd need to add as a dev
 * dep), this file uses a hand-rolled deterministic generator over
 * a small shape grammar — sufficient to catch the classes of
 * regex-bypass that defeated the v0 scanner.
 */

import { describe, expect, it } from 'vitest'

import { scanFile } from '../src/index.js'

const ALIASES = ['atom', 'a', 'jotaiAtom', '$atom', '_atom']

function gen(template: (alias: string) => string): string[] {
  return ALIASES.map((alias) => template(alias))
}

describe('predicate fuzz — alias resilience', () => {
  it('J-01 fires for any local alias of jotai.atom', () => {
    for (const src of gen(
      (a) => `import { atom as ${a} } from 'jotai'\nconst x = ${a}(0)`,
    )) {
      const f = scanFile('src/x.ts', src)
      expect(f.some((x) => x.ruleId === 'J-01')).toBe(true)
    }
  })

  it('J-02 fires for derived atoms regardless of alias', () => {
    for (const src of gen(
      (a) => `import { atom as ${a} } from 'jotai'\nconst x = ${a}((g) => g(y))`,
    )) {
      const f = scanFile('src/x.ts', src)
      expect(f.some((x) => x.ruleId === 'J-02')).toBe(true)
    }
  })

  it('R-02 fires for any local alias of react-redux.useSelector', () => {
    for (const src of gen(
      (a) => `import { useSelector as ${a} } from 'react-redux'\nfunction C(){ return ${a}((s)=>s) }`,
    )) {
      const f = scanFile('src/x.ts', src)
      expect(f.some((x) => x.ruleId === 'R-02')).toBe(true)
    }
  })

  it('M-01 fires for any local alias of mobx.makeAutoObservable', () => {
    for (const src of gen(
      (a) =>
        `import { makeAutoObservable as ${a} } from 'mobx'\nclass S { constructor() { ${a}(this) } }`,
    )) {
      const f = scanFile('src/x.ts', src)
      expect(f.some((x) => x.ruleId === 'M-01')).toBe(true)
    }
  })

  it('does not false-positive on identically-named symbol from a different module', () => {
    const f = scanFile(
      'src/x.ts',
      `import { atom } from 'not-jotai'\nconst x = atom(0)`,
    )
    expect(f.some((x) => x.ruleId === 'J-01' || x.ruleId === 'J-02')).toBe(false)
  })

  it('survives commented-out imports of the source library', () => {
    const f = scanFile(
      'src/x.ts',
      `// import { atom } from 'jotai'\nconst x = atom(0)`,
    )
    expect(f.some((x) => x.ruleId === 'J-01')).toBe(false)
  })
})
