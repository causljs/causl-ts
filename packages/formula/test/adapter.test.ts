/**
 * @packageDocumentation
 *
 * Integration tests for `createFormulaAdapter`, the bridge that registers
 * parsed formulas as derived nodes inside a Causl reactive graph. These
 * cases pin down end-to-end behaviour: input edits propagate into formula
 * results, range-based aggregates (SUM/AVG/MIN/MAX) reflect upstream
 * changes, and evaluator failures surface as tagged `FormulaError` values
 * rather than thrown exceptions. Assertions read computed values via
 * `valueOr` and inspect the discriminated `kind` field on error results.
 */

import { createCausl, type Node } from '@causl/core'
import { describe, expect, it } from 'vitest'
import {
  cellId,
  createFormulaAdapter,
  parseFormula,
  valueOr,
  type CellRef,
} from '../src/index.js'

/**
 * Suite covering the public surface of `createFormulaAdapter`: registration
 * of formulas as derived nodes, recomputation on commits, and surfacing of
 * evaluator errors through the result envelope.
 */
describe('createFormulaAdapter', () => {
  /**
   * Registering `=A1+B1` should yield a derived node whose value tracks
   * subsequent input commits. Verifies the adapter wires reactive
   * dependencies correctly through the resolver.
   */
  it('registers a formula as a derived node and recomputes on input changes', () => {
    // Seed two cells (A1, B1) as primary inputs in the reactive graph.
    const graph = createCausl()
    const a = graph.input(cellId('wb1', 'Sheet1', { col: 0, row: 0 }), 1)
    const b = graph.input(cellId('wb1', 'Sheet1', { col: 1, row: 0 }), 2)

    // Resolver maps `CellRef` lookups back to the seeded input nodes.
    const resolve = (ref: CellRef): Node<unknown> | undefined => {
      if (ref.col === 0 && ref.row === 0) return a
      if (ref.col === 1 && ref.row === 0) return b
      return undefined
    }

    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb1',
      sheet: 'Sheet1',
      resolve,
    })

    // Register `=A1+B1` at C1 and confirm its initial value is 1+2.
    const sumNode = adapter.registerFormula(
      { col: 2, row: 0 },
      parseFormula('=A1+B1'),
    )
    expect(valueOr(graph.read(sumNode), -1)).toBe(3)

    // Mutate A1: derived node must follow.
    graph.commit('a→10', (tx) => tx.set(a, 10))
    expect(valueOr(graph.read(sumNode), -1)).toBe(12)

    // Mutate B1: derived node tracks both dependencies.
    graph.commit('b→20', (tx) => tx.set(b, 20))
    expect(valueOr(graph.read(sumNode), -1)).toBe(30)
  })

  /**
   * `SUM(A1:A3)` must aggregate every cell the range expands to, and the
   * total must update when any underlying cell commits a new value.
   */
  it('evaluates SUM over a range', () => {
    // Build a column of three input cells holding 1, 2, 3.
    const graph = createCausl()
    const refs: CellRef[] = [
      { col: 0, row: 0 },
      { col: 0, row: 1 },
      { col: 0, row: 2 },
    ]
    const inputs = refs.map((r, i) =>
      graph.input(cellId('wb1', 'Sheet1', r), i + 1),
    )
    const resolve = (ref: CellRef) => {
      const idx = refs.findIndex((r) => r.col === ref.col && r.row === ref.row)
      return idx >= 0 ? inputs[idx] : undefined
    }
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb1',
      sheet: 'Sheet1',
      resolve,
    })
    // Initial sum of 1+2+3 = 6.
    const total = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=SUM(A1:A3)'),
    )
    expect(valueOr(graph.read(total), -1)).toBe(6) // 1 + 2 + 3
    // After mutating A1 to 10, the aggregate must reflect 10+2+3.
    graph.commit('A1→10', (tx) => {
      const a1 = inputs[0]
      if (a1) tx.set(a1, 10)
    })
    expect(valueOr(graph.read(total), -1)).toBe(15) // 10 + 2 + 3
  })

  /**
   * Verifies the three additional aggregate functions over the same range
   * produce arithmetic-mean, minimum, and maximum respectively.
   */
  it('evaluates AVG, MIN, MAX', () => {
    // Seed inputs with values 10, 20, 30 so each aggregate has a distinct expected output.
    const graph = createCausl()
    const refs: CellRef[] = [
      { col: 0, row: 0 },
      { col: 0, row: 1 },
      { col: 0, row: 2 },
    ]
    const inputs = refs.map((r, i) =>
      graph.input(cellId('wb1', 'Sheet1', r), [10, 20, 30][i] ?? 0),
    )
    const resolve = (ref: CellRef) => {
      const idx = refs.findIndex((r) => r.col === ref.col && r.row === ref.row)
      return idx >= 0 ? inputs[idx] : undefined
    }
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb1',
      sheet: 'Sheet1',
      resolve,
    })
    // Three formulas, each over the same range, exercise distinct reducer paths.
    const avg = adapter.registerFormula({ col: 1, row: 0 }, parseFormula('=AVG(A1:A3)'))
    const min = adapter.registerFormula({ col: 1, row: 1 }, parseFormula('=MIN(A1:A3)'))
    const max = adapter.registerFormula({ col: 1, row: 2 }, parseFormula('=MAX(A1:A3)'))
    expect(valueOr(graph.read(avg), -1)).toBe(20)
    expect(valueOr(graph.read(min), -1)).toBe(10)
    expect(valueOr(graph.read(max), -1)).toBe(30)
  })

  /**
   * Calling a function the evaluator does not know must produce a tagged
   * `unknown-function` error rather than tearing down the commit.
   */
  it('returns unknown-function error rather than throwing', () => {
    // Resolver returning undefined ensures no spurious cell coupling masks the failure path.
    const graph = createCausl()
    const resolve = (_ref: CellRef) => undefined
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb1',
      sheet: 'Sheet1',
      resolve,
    })
    const node = adapter.registerFormula({ col: 0, row: 0 }, parseFormula('=BOGUS()'))
    // Read returns an envelope; the discriminated kind must be 'error'.
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('unknown-function')
  })

  /**
   * A reference to a cell the resolver cannot map must surface as an
   * `unresolved-ref` error rather than throwing.
   */
  it('returns unresolved-ref error rather than throwing', () => {
    // Resolver always returns undefined: every reference is unresolvable.
    const graph = createCausl()
    const resolve = (_ref: CellRef) => undefined
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb1',
      sheet: 'Sheet1',
      resolve,
    })
    const node = adapter.registerFormula({ col: 0, row: 0 }, parseFormula('=A1+1'))
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('unresolved-ref')
  })
})
