/**
 * @packageDocumentation
 *
 * Tests for the formula dependency analyser: `staticReferences` walks a
 * parsed AST and produces every cell reference the formula reads, while
 * `detectCycle` scans an aggregated formula graph for circular dependency
 * chains. Together they pin down the contract that downstream layers rely
 * on for invalidation and recomputation. Assertions check both the
 * presence and structural shape of returned reference lists, and the
 * presence/closed shape of detected cycle chains.
 */

import { describe, expect, it } from 'vitest'
import {
  addFormula,
  detectCycle,
  emptyFormulaGraph,
  parseFormula,
  staticReferences,
} from '../src/index.js'

/**
 * Suite covering `staticReferences`, the static dependency extractor.
 * Each case verifies a different AST shape: bare references, range
 * expansions, multi-arg function calls, and ref-free literals.
 */
describe('staticReferences', () => {
  /**
   * A formula composed of three plain cell references must yield those
   * three references in left-to-right order, normalised to `CellRef`.
   */
  it('extracts all cell refs from an AST', () => {
    // Three distinct cells appear in the expression; output should be in source order.
    const refs = staticReferences(parseFormula('=A1+B2*C3'))
    expect(refs).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 2 },
    ])
  })

  /**
   * Range arguments to aggregate functions must be expanded into the full
   * set of constituent cells, not left as opaque range nodes.
   */
  it('expands ranges in SUM/AVG/MIN/MAX calls', () => {
    // A1:A3 covers three rows in one column.
    const refs = staticReferences(parseFormula('=SUM(A1:A3)'))
    expect(refs.length).toBe(3)
  })

  /**
   * Each positional argument of a function call is recursively scanned,
   * so a multi-arg `MAX` should surface every embedded reference.
   */
  it('walks function call args', () => {
    // Three independent references passed as separate arguments.
    const refs = staticReferences(parseFormula('=MAX(A1, B2, C3)'))
    expect(refs.length).toBe(3)
  })

  /**
   * A literal-only formula has no dependencies and must return an empty
   * reference list.
   */
  it('returns no refs for a literal', () => {
    // No cell references in the AST: result must be the empty array.
    expect(staticReferences(parseFormula('=42'))).toEqual([])
  })
})

/**
 * Suite covering `detectCycle`, which scans a `FormulaGraph` and either
 * returns `null` for an acyclic graph or a closed reference chain
 * naming the cells participating in the cycle.
 */
describe('detectCycle', () => {
  /**
   * A graph with no back-edges must report no cycle.
   */
  it('returns null for an acyclic graph', () => {
    // A1 depends on B1 and C1; B1 and C1 are leaves.
    const g = emptyFormulaGraph()
    addFormula(g, { col: 0, row: 0 }, parseFormula('=B1+C1'))
    addFormula(g, { col: 1, row: 0 }, parseFormula('=2'))
    addFormula(g, { col: 2, row: 0 }, parseFormula('=3'))
    expect(detectCycle(g)).toBe(null)
  })

  /**
   * A formula referencing its own cell is a degenerate cycle of length
   * one. The returned chain should be closed (first === last).
   */
  it('detects a direct self-cycle', () => {
    // A1 = A1 + 1 induces an immediate self-loop.
    const g = emptyFormulaGraph()
    addFormula(g, { col: 0, row: 0 }, parseFormula('=A1+1'))
    const c = detectCycle(g)
    expect(c).not.toBeNull()
    // Closed chain: must contain at least the start and the repeated terminus.
    expect(c!.length).toBeGreaterThanOrEqual(2)
    expect(c![0]).toBe(c![c!.length - 1])
  })

  /**
   * Mutual references between two cells form the simplest non-trivial
   * cycle and should appear in the reported chain.
   */
  it('detects a 2-cell cycle (A1 → B1 → A1)', () => {
    // A1 reads B1, B1 reads A1.
    const g = emptyFormulaGraph()
    addFormula(g, { col: 0, row: 0 }, parseFormula('=B1'))
    addFormula(g, { col: 1, row: 0 }, parseFormula('=A1'))
    const c = detectCycle(g)
    expect(c).not.toBeNull()
    // Chain must mention both participants by their A1 labels.
    expect(c).toContain('A1')
    expect(c).toContain('B1')
  })

  /**
   * Cycles longer than two cells must still be detected, with all
   * participating cells named in the reported chain.
   */
  it('detects a longer cycle (A1 → B1 → C1 → A1)', () => {
    // Three-cell ring across columns A, B, C in row 1.
    const g = emptyFormulaGraph()
    addFormula(g, { col: 0, row: 0 }, parseFormula('=B1'))
    addFormula(g, { col: 1, row: 0 }, parseFormula('=C1'))
    addFormula(g, { col: 2, row: 0 }, parseFormula('=A1'))
    const c = detectCycle(g)
    expect(c).not.toBeNull()
    // All three labels must appear in the cycle (order may vary by traversal start).
    const set = new Set(c!)
    expect(set.has('A1')).toBe(true)
    expect(set.has('B1')).toBe(true)
    expect(set.has('C1')).toBe(true)
  })

  /**
   * The presence of a non-cyclic side branch must not mask a cycle
   * elsewhere in the graph; detection should still surface the cycle.
   */
  it('returns the cycle even when a side branch is acyclic', () => {
    // A1 depends on B1 (cyclic with C1) and D1 (acyclic literal).
    const g = emptyFormulaGraph()
    addFormula(g, { col: 0, row: 0 }, parseFormula('=B1+D1'))
    addFormula(g, { col: 1, row: 0 }, parseFormula('=C1'))
    addFormula(g, { col: 2, row: 0 }, parseFormula('=B1')) // C1 → B1 → C1
    addFormula(g, { col: 3, row: 0 }, parseFormula('=42'))
    const c = detectCycle(g)
    expect(c).not.toBeNull()
  })
})
