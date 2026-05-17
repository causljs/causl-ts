/**
 * @packageDocumentation
 *
 * Phase 3 acceptance demo — 100-cell spreadsheet diamond. The suite wires
 * a 10×10 grid through `@causljs/core` via the formula adapter and
 * exercises diamond dependencies, atomic propagation, observer-fire
 * counting, and a SUM-over-range variant. Together these tests certify
 * that the adapter preserves transactional commit semantics and produces
 * arithmetically correct outputs for non-trivial dependency graphs.
 *
 * Grid layout:
 *   - Column A is 10 input cells (A1..A10).
 *   - Bn := An * 2          (n in 1..10)
 *   - Cn := Bn + 1          (n in 1..10)
 *   - Dn := Cn * Bn         (n in 1..10)         ← non-trivial in A
 *   - E1 := SUM(D1:D10)
 *
 * Total: 10 inputs + 31 derivations = 41 nodes. Critically, D *does*
 * depend on A (through both B and C); the previous incarnation of this
 * demo used `D = Cn - Bn` which is algebraically `1` for all A — a
 * useless glitch test. The current shape exercises the diamond:
 *
 *   D(A=k) = (2k+1) * (2k) = 4k² + 2k
 *   E1     = Σ D(Ai) = 4·Σ Ai² + 2·Σ Ai
 *
 * For A1..A10 = 1..10 (initial):
 *   Σ Ai  = 55
 *   Σ Ai² = 385
 *   E1    = 4·385 + 2·55 = 1540 + 110 = 1650
 */

import { createCausl, type Node } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  cellId,
  createFormulaAdapter,
  parseFormula,
  valueOr,
  type CellRef,
} from '../src/index.js'

/**
 * Constructs the full 10×10 diamond spreadsheet topology used by the
 * primary cases in this suite.
 *
 * The helper returns the underlying reactive graph, the column-A input
 * nodes (so tests can mutate them inside a commit), and the terminal
 * `E1 = SUM(D1:D10)` aggregator node so tests can read or subscribe to
 * the rolled-up result.
 *
 * @returns Object containing the `graph`, the `inputs` array of A-column
 *   nodes (1..10 initial values), and `e1` — the terminal aggregator.
 */
function buildSpreadsheet(): {
  graph: ReturnType<typeof createCausl>
  inputs: ReturnType<ReturnType<typeof createCausl>['input']>[]
  e1: Node<unknown>
} {
  // Fresh reactive graph and namespace coordinates for the demo workbook.
  const graph = createCausl()
  const wb = 'wb1'
  const sheet = 'Sheet1'

  // Seed column A with 10 inputs whose initial values are 1..10.
  const aInputs = Array.from({ length: 10 }, (_, i) =>
    graph.input(cellId(wb, sheet, { col: 0, row: i }), i + 1),
  )

  // Track already-registered nodes by `col,row` so the adapter resolver
  // can wire formula dependencies to the correct upstream graph nodes.
  const knownNodes = new Map<string, Node<unknown>>()
  for (let i = 0; i < 10; i++) {
    knownNodes.set(`0,${i}`, aInputs[i] as Node<unknown>)
  }
  const resolve = (ref: CellRef): Node<unknown> | undefined =>
    knownNodes.get(`${ref.col},${ref.row}`)

  // Build the adapter that converts formula ASTs into graph nodes.
  const adapter = createFormulaAdapter(graph, { workbook: wb, sheet, resolve })

  // Column B := An * 2 for n in 1..10.
  for (let i = 0; i < 10; i++) {
    const node = adapter.registerFormula(
      { col: 1, row: i },
      parseFormula(`=A${i + 1}*2`),
    )
    knownNodes.set(`1,${i}`, node as Node<unknown>)
  }
  // Column C := Bn + 1 for n in 1..10.
  for (let i = 0; i < 10; i++) {
    const node = adapter.registerFormula(
      { col: 2, row: i },
      parseFormula(`=B${i + 1}+1`),
    )
    knownNodes.set(`2,${i}`, node as Node<unknown>)
  }
  // Column D := Cn * Bn (the diamond — D depends on A through both B and C).
  for (let i = 0; i < 10; i++) {
    const node = adapter.registerFormula(
      { col: 3, row: i },
      parseFormula(`=C${i + 1}*B${i + 1}`),
    )
    knownNodes.set(`3,${i}`, node as Node<unknown>)
  }
  // Terminal aggregator: E1 = SUM(D1:D10).
  const e1 = adapter.registerFormula({ col: 4, row: 0 }, parseFormula('=SUM(D1:D10)'))

  return { graph, inputs: aInputs, e1: e1 as Node<unknown> }
}

/**
 * Computes the analytic expected value of `E1` for a given input vector
 * `A1..A10`, derived as `Σ (2k+1)(2k)` over the supplied numbers.
 *
 * @param values - The 10-element vector to plug into the diamond.
 * @returns The closed-form expected `E1` aggregate.
 */
function expectedE1(values: readonly number[]): number {
  let sum = 0
  for (const a of values) sum += (2 * a + 1) * (2 * a)
  return sum
}

/**
 * Top-level Phase 3 acceptance suite. Each case spins up a fresh
 * spreadsheet via {@link buildSpreadsheet} (or a tailored variant) and
 * verifies a property of the resulting reactive graph.
 */
describe('Phase 3 — 100-cell spreadsheet diamond demo', () => {
  /**
   * Reads the terminal aggregator immediately after construction and
   * confirms it matches the closed-form initial value of 1650 for
   * `A1..A10 = 1..10`.
   */
  it('initial values: E1 = Σ (2A+1)(2A) for A1..A10 = 1..10 → 1650', () => {
    // Build the diamond and pull the terminal aggregator.
    const { graph, e1 } = buildSpreadsheet()
    const result = graph.read(e1)
    // Closed-form check: 4·385 + 2·55 = 1650.
    expect(valueOr(result as never, -1)).toBe(expectedE1([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
  })

  /**
   * Mutates a single column-A input inside a commit and asserts the
   * change propagates atomically through B/C/D to E1, with the observer
   * receiving exactly one post-commit emission.
   */
  it('mutating A5 propagates B5, C5, D5, E1 atomically — observer fires once', () => {
    const { graph, inputs, e1 } = buildSpreadsheet()
    // Capture every emission the subscriber observes for E1.
    const log: number[] = []
    graph.subscribe(e1, (v) => log.push(valueOr(v as never, -1)))

    // Locate the A5 input (zero-based index 4) and update it.
    const a5 = inputs[4]
    if (!a5) throw new Error('A5 missing')
    graph.commit('a5→999', (tx) => tx.set(a5, 999))

    // Recompute the analytic expectation with the mutated A5 value.
    const expected = expectedE1([1, 2, 3, 4, 999, 6, 7, 8, 9, 10])
    expect(valueOr(graph.read(e1) as never, -1)).toBe(expected)
    // Initial fire + one fire from the commit (since E1 actually changed).
    expect(log).toEqual([expectedE1([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), expected])
  })

  /**
   * Mutates all 10 inputs inside a single commit and asserts the
   * subscriber still receives exactly one post-commit emission, proving
   * commit-scoped batching of downstream notifications.
   */
  it('mutating every A in one commit yields exactly one observer fire', () => {
    const { graph, inputs, e1 } = buildSpreadsheet()
    // Track emissions on E1 through the bulk update.
    const log: number[] = []
    graph.subscribe(e1, (v) => log.push(valueOr(v as never, -1)))

    // Bulk-update all A inputs to 1000 inside a single commit.
    graph.commit('bump-all', (tx) => {
      for (const a of inputs) tx.set(a, 1000)
    })
    // Closed-form expectation for an all-1000 input vector.
    const expected = expectedE1(Array(10).fill(1000))
    expect(valueOr(graph.read(e1) as never, -1)).toBe(expected)
    // Initial 1650 + one fire from the commit.
    expect(log).toEqual([1650, expected])
  })

  /**
   * Exercises a smaller variant where the terminal node sums column B
   * directly, confirming the SUM-over-range path also propagates input
   * mutations correctly.
   */
  it('a SUM-over-Bn variant propagates correctly', () => {
    // Stand up a slimmer graph: just column A inputs and column B doublers.
    const graph = createCausl()
    const wb = 'wb1'
    const sheet = 'Sheet1'
    const aInputs = Array.from({ length: 10 }, (_, i) =>
      graph.input(cellId(wb, sheet, { col: 0, row: i }), i + 1),
    )
    // Build the resolver map for the adapter.
    const knownNodes = new Map<string, Node<unknown>>()
    for (let i = 0; i < 10; i++) {
      knownNodes.set(`0,${i}`, aInputs[i] as Node<unknown>)
    }
    const resolve = (ref: CellRef) => knownNodes.get(`${ref.col},${ref.row}`)
    const adapter = createFormulaAdapter(graph, { workbook: wb, sheet, resolve })
    // Column B := An * 2.
    for (let i = 0; i < 10; i++) {
      const b = adapter.registerFormula(
        { col: 1, row: i },
        parseFormula(`=A${i + 1}*2`),
      )
      knownNodes.set(`1,${i}`, b as Node<unknown>)
    }
    // Terminal: SUM over B1:B10. Initial inputs 1..10 yield 2+4+...+20 = 110.
    const total = adapter.registerFormula({ col: 2, row: 0 }, parseFormula('=SUM(B1:B10)'))
    expect(valueOr(graph.read(total) as never, -1)).toBe(110) // 2+4+...+20
    // Bump A1 from 1 to 100; B1 becomes 200, total becomes 200+4+6+...+20 = 308.
    const a1 = aInputs[0]
    if (!a1) throw new Error('A1 missing')
    graph.commit('a1→100', (tx) => tx.set(a1, 100))
    expect(valueOr(graph.read(total) as never, -1)).toBe(308) // 200+4+...+20
  })
})
