/**
 * Per-rule fixture corpus for the S-NN (cross-source / causl-
 * idiomatic) family. These rules fire regardless of the source
 * library and catch common LLM-migration mistakes.
 */

import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

function ids(src: string): string[] {
  return scanFile('src/x.tsx', src).map((f) => f.ruleId)
}

describe('rule S-01 — sequential setters', () => {
  it('fires on two adjacent setX/setY calls', () => {
    expect(
      ids(`function C() { setA(1); setB(2); return null }`),
    ).toContain('S-01')
  })
  it('does not fire on a single setter', () => {
    expect(ids(`function C() { setA(1); return null }`)).not.toContain('S-01')
  })
})

describe('rule S-02 — update returns graph', () => {
  it('fires on update that returns its graph param', () => {
    expect(
      ids(`function update(graph, msg) { return graph }`),
    ).toContain('S-02')
  })
  it('fires on Update<...>-typed const that returns graph', () => {
    expect(
      ids(`const update: Update<Msg, Model> = (graph, msg) => graph`),
    ).toContain('S-02')
  })
  it('does not fire on update that returns a Commit', () => {
    expect(
      ids(`function update(graph, msg) { return { tag: 'commit' } }`),
    ).not.toContain('S-02')
  })
})

describe('rule S-03 — g.read inside commit', () => {
  it('fires on g.read called inside commit tx callback', () => {
    expect(
      ids(`graph.commit('x', (tx) => { const v = g.read(node) })`),
    ).toContain('S-03')
  })
  it('does not fire on tx.get inside commit', () => {
    expect(
      ids(`graph.commit('x', (tx) => { const v = tx.get(node) })`),
    ).not.toContain('S-03')
  })
})

describe('rule S-04 — useEffect cascade', () => {
  it('fires on useEffect that dispatches', () => {
    expect(
      ids(
        `function C() { useEffect(() => { dispatch({ type: 'go', payload: 1 }) }, [v]); return null }`,
      ),
    ).toContain('S-04')
  })
})

describe('rule S-05 — stale-closure dispatch', () => {
  it('fires on dispatch inside setTimeout outside a hook', () => {
    expect(
      ids(`setTimeout(() => { dispatch({ type: 'go', payload: 1 }) }, 100)`),
    ).toContain('S-05')
  })
})

describe('rule S-06 — untyped dispatch', () => {
  it('fires on string-literal dispatch', () => {
    expect(ids(`function C() { dispatch('go'); return null }`)).toContain('S-06')
  })
  it('fires on { type: "x" } only', () => {
    expect(
      ids(`function C() { dispatch({ type: 'go' }); return null }`),
    ).toContain('S-06')
  })
})

describe('rule S-07 — useState shared across components', () => {
  it('fires on useState inside an exported hook function', () => {
    expect(
      ids(
        `export function useShared() { const [x, setX] = useState(0); return [x, setX] }`,
      ),
    ).toContain('S-07')
  })
})

describe('rule S-08 — phantom imports', () => {
  it('fires on useCauslSuspense import', () => {
    expect(
      ids(`import { useCauslSuspense } from '@causljs/react'`),
    ).toContain('S-08')
  })
})

describe('rule S-09 — codemod-style markers', () => {
  it('fires on TODO(causl-migrate) comment', () => {
    expect(
      ids(`// TODO(causl-migrate): finish the migration\nconst x = 0`),
    ).toContain('S-09')
  })
})
