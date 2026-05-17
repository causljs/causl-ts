/**
 * @packageDocumentation
 *
 * Tests for the core domain model exposed by `@causljs/formula`: `Cell`,
 * `Sheet`, `Workbook`, and the `cellId` namespacing helper. The suite
 * pins two design commitments. First, the information-model namespace
 * is its own thing — identifiers like `cell:wb1:Sheet1:A1` belong to
 * the user's mental world (the things the user thinks exist) and never
 * mix with editor-controller selection or fetch state. Second, the
 * `CellValue` union is a tagged discriminated union, so "X may or may
 * not have Y" optional fields are surfaced as a state-machine tag the
 * type system can enforce. The tests confirm the factories produce
 * correctly-tagged states and that empty containers start empty.
 */

import { describe, expect, it } from 'vitest'
import {
  cellId,
  emptyCell,
  emptySheet,
  emptyWorkbook,
  formulaCell,
  literalCell,
  parseFormula,
} from '../src/index.js'

/**
 * Suite covering the cell / sheet / workbook value constructors and the
 * `cellId` keying scheme that ties them to the reactive graph.
 */
describe('Cell / Sheet / Workbook types', () => {
  /**
   * Verifies `cellId` emits the canonical `cell:<wb>:<sheet>:<A1>` shape
   * — the information-model identifier convention shared with other
   * causl domains (e.g. `asset:property-1:HVAC-3`) — so identifiers
   * round-trip through the graph.
   */
  it('cellId follows SPEC §7.1 — `cell:${wb}:${sheet}:${A1}`', () => {
    // Build an id for the top-left cell of Sheet1 in workbook wb1.
    const id = cellId('wb1', 'Sheet1', { col: 0, row: 0 })
    // Expected shape pins workbook, sheet and A1-style coordinate.
    expect(id).toBe('cell:wb1:Sheet1:A1')
  })

  /**
   * Confirms identical coordinates yield distinct ids when either the
   * sheet or workbook component differs, ensuring proper namespacing.
   */
  it('cellId distinguishes by workbook and sheet', () => {
    const ref = { col: 0, row: 0 }
    // Same coordinates but different sheets must not collide.
    expect(cellId('wb1', 'Sheet1', ref)).not.toBe(cellId('wb1', 'Sheet2', ref))
    // Same coordinates but different workbooks must not collide either.
    expect(cellId('wb1', 'Sheet1', ref)).not.toBe(cellId('wb2', 'Sheet1', ref))
  })

  /**
   * Sanity-checks the three cell factories produce the expected discriminant
   * tag on the `value.state` field of the `CellValue` union.
   */
  it('emptyCell, literalCell, formulaCell return discriminated unions', () => {
    // emptyCell is tagged 'empty'.
    expect(emptyCell({ col: 0, row: 0 }).value.state).toBe('empty')
    // literalCell is tagged 'literal' and carries a primitive payload.
    expect(literalCell({ col: 0, row: 0 }, 42).value.state).toBe('literal')
    // formulaCell is tagged 'formula' and carries source + parsed AST.
    expect(formulaCell({ col: 0, row: 0 }, '=1+1', parseFormula('=1+1')).value.state).toBe('formula')
  })

  /**
   * Demonstrates the "make impossible states impossible" invariant:
   * only states that carry a payload expose a `.value` property, and
   * the runtime tag narrows the union so impossible accesses become
   * unreachable. The optional-field shape that previously let "has a
   * value AND an error" be representable cannot be expressed here.
   */
  it('CellValue makes impossible states impossible (per SPEC §9)', () => {
    // The compiler enforces this — accessing `.value` on an `empty` state
    // is a type error. We assert the runtime tag check works.
    const c = literalCell({ col: 0, row: 0 }, 'hello')
    if (c.value.state === 'literal') {
      // Narrowed branch: payload is exposed.
      expect(c.value.value).toBe('hello')
    } else {
      // Any other branch must be unreachable for a literal cell.
      throw new Error('unreachable')
    }
  })

  /**
   * Asserts the empty constructors yield zero-sized cell/sheet maps so
   * downstream consumers can rely on a clean starting state.
   */
  it('emptySheet and emptyWorkbook produce empty maps', () => {
    // A fresh sheet has no cells.
    expect(emptySheet('Sheet1').cells.size).toBe(0)
    // A fresh workbook has no sheets.
    expect(emptyWorkbook('wb1').sheets.size).toBe(0)
  })
})
