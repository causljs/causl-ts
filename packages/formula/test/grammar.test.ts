/**
 * @packageDocumentation
 *
 * Grammar-layer tests covering the A1 ⇄ `CellRef` conversions and range
 * enumeration helpers. The conversions must be exact inverses across the
 * single- and multi-letter column space, must reject malformed input
 * (rather than coercing), and must reject impossible cell coordinates.
 * Range expansion must produce row-major sequences and tolerate inverted
 * corner ordering. Assertions check both equality of structured refs and
 * the throwing behaviour of validation paths.
 */

import { describe, expect, it } from 'vitest'
import { a1ToCellRef, cellRefToA1, expandRange } from '../src/index.js'

/**
 * Suite verifying A1 string ⇄ `CellRef` round-trip equivalence and the
 * validation behaviour of both directions.
 */
describe('A1 ⇄ CellRef round-trips', () => {
  /**
   * Parametrised cases pinning the exact column/row indices for a
   * representative slice of the A1 grammar: single-letter columns,
   * the boundary at Z/AA, two-letter columns, and large rows.
   *
   * @param a1 - the A1 string fixture
   * @param ref - the expected zero-based `CellRef` form
   */
  it.each([
    ['A1', { col: 0, row: 0 }],
    ['B2', { col: 1, row: 1 }],
    ['Z9', { col: 25, row: 8 }],
    ['AA1', { col: 26, row: 0 }],
    ['AZ100', { col: 51, row: 99 }],
    ['BA10', { col: 52, row: 9 }],
    ['ZZ999', { col: 701, row: 998 }],
  ])('%s ↔ %j', (a1, ref) => {
    // Forward: parse the A1 string into a structured CellRef.
    expect(a1ToCellRef(a1)).toEqual(ref)
    // Reverse: render the CellRef back to its canonical A1 form.
    expect(cellRefToA1(ref)).toBe(a1)
  })

  /**
   * Malformed A1 strings (digit-first, empty, missing row, zero row)
   * must throw rather than coerce to a default ref.
   */
  it('rejects malformed A1 strings', () => {
    // Each input violates a different rule: digit-first, empty, no row, zero row.
    expect(() => a1ToCellRef('1A')).toThrow()
    expect(() => a1ToCellRef('')).toThrow()
    expect(() => a1ToCellRef('A')).toThrow()
    expect(() => a1ToCellRef('A0')).toThrow()
  })

  /**
   * Reverse rendering must reject coordinates that cannot map to a
   * legal A1 column: negative indices and non-integer values.
   */
  it('cellRefToA1 rejects negative or non-integer columns', () => {
    // Negative column has no A1 representation.
    expect(() => cellRefToA1({ col: -1, row: 0 })).toThrow()
    // Fractional column is structurally invalid.
    expect(() => cellRefToA1({ col: 0.5, row: 0 })).toThrow()
  })
})

/**
 * Suite covering `expandRange`, which enumerates every cell within a
 * rectangular range defined by two corner refs.
 */
describe('expandRange', () => {
  /**
   * A range whose corners coincide must enumerate exactly that single
   * cell.
   */
  it('enumerates a 1×1 range as a single cell', () => {
    // Same corner for from/to: result is a singleton sequence.
    const r = expandRange({ col: 0, row: 0 }, { col: 0, row: 0 })
    expect(r).toEqual([{ col: 0, row: 0 }])
  })

  /**
   * The 2×2 block A1:B2 must expand row-major: A1, B1, A2, B2.
   */
  it('enumerates A1:B2 in row-major order', () => {
    // Ordering matters: row-major means rows are the outer loop.
    const r = expandRange({ col: 0, row: 0 }, { col: 1, row: 1 })
    expect(r).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
    ])
  })

  /**
   * Passing the corners in reverse (bottom-right, top-left) must still
   * yield the full rectangle, normalised by the helper.
   */
  it('handles inverted from/to order', () => {
    // Inverted corners must be normalised before enumeration.
    const r = expandRange({ col: 1, row: 1 }, { col: 0, row: 0 })
    expect(r.length).toBe(4)
  })
})
