/**
 * @packageDocumentation
 *
 * EPIC-4 / TASK 4.5 — Apalache differential pairing tests.
 */

import { describe, expect, it } from 'vitest'
import {
  always,
  collectPairings,
  pairWithApalacheModel,
} from '../src/index.js'

interface S {
  readonly value: number
}

describe('TASK 4.5 — Apalache differential pairing', () => {
  it('tags a hypothesis with a TLA+ model path', () => {
    const tagged = pairWithApalacheModel(
      'glitch-freedom',
      always<S>((s) => s.value >= 0),
      'corpus/apalache/glitch_propagation_minimal.tla',
    )
    expect(tagged.name).toBe('glitch-freedom')
    expect(tagged.tlaPath).toBe('corpus/apalache/glitch_propagation_minimal.tla')
    expect(typeof tagged.run).toBe('function')
  })

  it('the tagged hypothesis behaves identically to the wrapped one', () => {
    const wrapped = always<S>((s) => s.value > 0)
    const tagged = pairWithApalacheModel('positive', wrapped, 'corpus/apalache/x.tla')
    const trace = { start: { value: 1 }, steps: [] }
    expect(tagged.run(trace)).toBe('holds')
  })

  it('collectPairings extracts the (name, tlaPath) tuples', () => {
    const a = pairWithApalacheModel('a', always<S>(() => true), 'a.tla')
    const b = pairWithApalacheModel('b', always<S>(() => true), 'b.tla')
    const pairings = collectPairings([a, b])
    expect(pairings).toEqual([
      { hypothesisName: 'a', tlaPath: 'a.tla' },
      { hypothesisName: 'b', tlaPath: 'b.tla' },
    ])
  })
})
