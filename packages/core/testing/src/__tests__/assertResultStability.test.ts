import { describe, it, expect } from 'vitest'
import {
  assertResultStability,
  ResultInstability,
} from '../assertResultStability.js'

describe('assertResultStability', () => {
  it('passes when getSnapshot returns the same primitive twice', () => {
    expect(() =>
      assertResultStability({ getSnapshot: () => 42 }),
    ).not.toThrow()
  })

  it('passes when getSnapshot returns the same object reference twice', () => {
    const obj = { x: 1 }
    expect(() =>
      assertResultStability({ getSnapshot: () => obj }),
    ).not.toThrow()
  })

  it('throws ResultInstability when getSnapshot fabricates a fresh object each call', () => {
    expect(() =>
      assertResultStability({ getSnapshot: () => ({ x: 1 }) }),
    ).toThrow(ResultInstability)
  })

  it('throws when a memoised cache is keyed on a non-stable input', () => {
    let n = 0
    expect(() =>
      assertResultStability({
        getSnapshot: () => ({ n: n++ }), // changes between calls
      }),
    ).toThrow(ResultInstability)
  })

  it('respects a custom structural equals when documented as stable', () => {
    expect(() =>
      assertResultStability({
        getSnapshot: () => ({ x: 1 }),
        equals: (a, b) => a.x === b.x,
      }),
    ).not.toThrow()
  })

  it('error mentions the actual values for diagnosis', () => {
    try {
      assertResultStability({ getSnapshot: () => ({ x: 1 }) })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain('useSyncExternalStore')
      expect((e as Error).message).toMatch(/render loop/)
    }
  })

  it('catches the canonical foot-gun: returning .map(...) without memoisation', () => {
    const items = [1, 2, 3]
    expect(() =>
      assertResultStability({
        getSnapshot: () => items.map((n) => n * 2), // fresh array each call
      }),
    ).toThrow(ResultInstability)
  })
})
