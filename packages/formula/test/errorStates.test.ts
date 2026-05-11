/**
 * @packageDocumentation
 *
 * Conformance tests for the "make impossible states impossible" design
 * commitment: every evaluator failure must surface as a tagged
 * `FormulaError` carried inside the result envelope, never as a silent
 * zero and never as a thrown exception that aborts the engine commit.
 * The previous formula representation allowed "has a value AND an error"
 * as a representable state; replacing it with a discriminated union
 * means a caller has to inspect the tag before reaching for a payload,
 * and these tests pin that contract on every error category. Cases
 * cover division-by-zero, non-numeric coercion, unknown functions,
 * argument errors, unresolved references, downstream propagation, and
 * recovery once an upstream input becomes valid again. Assertions
 * inspect `result.kind === 'error'` and the discriminated
 * `result.error.kind` tag on each evaluator outcome.
 */

import { createCausl, type Node } from '@causl/core'
import { describe, expect, it } from 'vitest'
import {
  cellId,
  createFormulaAdapter,
  formulaRootCause,
  parseFormula,
  type CellRef,
  type FormulaError,
} from '../src/index.js'

/**
 * Constructs a fresh test sheet: an empty Causl graph, a backing
 * `Map<string, Node>` of registered inputs keyed by `"col,row"`, and a
 * resolver that consults the map when the adapter requests a `CellRef`.
 *
 * Each test populates the map directly to control resolver outcomes.
 *
 * @returns the graph, the resolver, and the inputs map for in-place mutation
 */
function buildSheet(): {
  graph: ReturnType<typeof createCausl>
  resolve: (ref: CellRef) => Node<unknown> | undefined
  inputs: Map<string, Node<unknown>>
} {
  const graph = createCausl()
  const inputs = new Map<string, Node<unknown>>()
  const resolve = (ref: CellRef): Node<unknown> | undefined =>
    inputs.get(`${ref.col},${ref.row}`)
  return { graph, resolve, inputs }
}

/**
 * Suite verifying the full taxonomy of evaluator error kinds together
 * with error propagation and recovery semantics. The discriminant tag is
 * the only legal entry point to the result, so each case both produces a
 * failure and asserts that its specific `error.kind` arrived intact.
 */
describe('FormulaResult error states', () => {
  /**
   * Division by a literal zero must yield a `div-by-zero` error rather
   * than silently producing `0` or throwing.
   */
  it('=A1/0 evaluates to a div-by-zero error, not silently 0', () => {
    // Seed A1 with a numeric value so the failure originates in the divisor, not the dividend.
    const { graph, resolve, inputs } = buildSheet()
    inputs.set('0,0', graph.input(cellId('wb', 's', { col: 0, row: 0 }), 5))
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const node = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=A1/0'),
    )
    // Read the result envelope and assert the tagged failure path.
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('div-by-zero')
  })

  /**
   * A non-numeric upstream cell used in arithmetic must yield a
   * `non-numeric` error tagged with the offending cell's A1 label.
   */
  it('=A1+1 with non-numeric A1 returns non-numeric error, not throw', () => {
    // Seed A1 with a string to force the coercion failure on the addition operand.
    const { graph, resolve, inputs } = buildSheet()
    inputs.set('0,0', graph.input(cellId('wb', 's', { col: 0, row: 0 }), 'hello'))
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const node = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=A1+1'),
    )
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('non-numeric')
    if (result.error.kind !== 'non-numeric') throw new Error('unreachable')
    // Error must name the specific cell whose value failed coercion;
    // `ref` is required on the `non-numeric` variant so this access is
    // type-safe without an optional check.
    expect(result.error.ref).toBe('A1')
  })

  /**
   * Calls to functions the evaluator does not register must produce an
   * `unknown-function` error.
   */
  it('=BOGUS() yields unknown-function error', () => {
    // No inputs needed: the failure is at function lookup time, not value time.
    const { graph, resolve } = buildSheet()
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const node = adapter.registerFormula(
      { col: 0, row: 0 },
      parseFormula('=BOGUS()'),
    )
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('unknown-function')
  })

  /**
   * An aggregate over a range whose cells cannot be resolved must yield
   * an `argument-error` rather than treating missing cells as zeros.
   */
  it('=AVG() with no resolvable cells yields argument-error', () => {
    // Empty resolver: AVG receives an empty operand list.
    const { graph, resolve } = buildSheet()
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const node = adapter.registerFormula(
      { col: 0, row: 0 },
      parseFormula('=AVG(A1:A3)'),
    )
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('argument-error')
  })

  /**
   * A bare reference to a cell the resolver does not know must surface
   * as an `unresolved-ref` error tagged with the missing cell's label.
   */
  it('=A1 with unresolved A1 yields unresolved-ref error', () => {
    // Empty resolver: A1 cannot be mapped to any node.
    const { graph, resolve } = buildSheet()
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const node = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=A1'),
    )
    const result = graph.read(node)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('unresolved-ref')
    if (result.error.kind !== 'unresolved-ref') throw new Error('unreachable')
    // `ref` is required on the `unresolved-ref` variant so the access
    // narrows cleanly without optional chaining.
    expect(result.error.ref).toBe('A1')
  })

  /**
   * An error in an upstream formula must travel through the dependency
   * chain as a distinct `propagated` error so downstream readers can
   * distinguish primary failures from inherited ones, and the upstream
   * `FormulaError` must be carried as `cause` so the original chain is
   * recoverable rather than rewritten in place.
   */
  it('errors propagate through downstream formulas with cause preserved', () => {
    // Seed A1 = 0; B1 will produce div-by-zero from it.
    const { graph, resolve, inputs } = buildSheet()
    inputs.set('0,0', graph.input(cellId('wb', 's', { col: 0, row: 0 }), 0))
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    // B1 = A1/0 → div-by-zero
    const b1 = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=A1/0'),
    )
    // Register B1 as a resolvable cell so C1 picks it up via the resolver.
    inputs.set('1,0', b1)
    // C1 = B1 + 1 → propagated
    const c1 = adapter.registerFormula(
      { col: 2, row: 0 },
      parseFormula('=B1+1'),
    )
    // C1 must report 'propagated', not the original 'div-by-zero'.
    const result = graph.read(c1)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.error.kind).toBe('propagated')
    // The original failure must survive the relay as `cause` rather
    // than being overwritten in place; rootCause walks back to it.
    if (result.error.kind !== 'propagated') throw new Error('unreachable')
    expect(result.error.cause.kind).toBe('div-by-zero')
    expect(formulaRootCause(result.error).kind).toBe('div-by-zero')
  })

  /**
   * Three-hop propagation must preserve the entire `cause` chain:
   * each relay wraps the previous error rather than collapsing it.
   * This is the regression test for the lossy in-place rewrite that
   * replaced `kind` with `'propagated'` and dropped every other field.
   */
  it('propagation through three layers preserves the original cause chain', () => {
    // A1 = 0 (literal divisor source)
    // B1 = A1 / 0      → div-by-zero
    // C1 = B1 + 1      → propagated(cause: div-by-zero)
    // D1 = C1 + 1      → propagated(cause: propagated(cause: div-by-zero))
    // E1 = D1 + 1      → propagated^3(cause chain ends in div-by-zero)
    const { graph, resolve, inputs } = buildSheet()
    inputs.set('0,0', graph.input(cellId('wb', 's', { col: 0, row: 0 }), 0))
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const b1 = adapter.registerFormula({ col: 1, row: 0 }, parseFormula('=A1/0'))
    inputs.set('1,0', b1)
    const c1 = adapter.registerFormula({ col: 2, row: 0 }, parseFormula('=B1+1'))
    inputs.set('2,0', c1)
    const d1 = adapter.registerFormula({ col: 3, row: 0 }, parseFormula('=C1+1'))
    inputs.set('3,0', d1)
    const e1 = adapter.registerFormula({ col: 4, row: 0 }, parseFormula('=D1+1'))
    const result = graph.read(e1)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    // Walk three propagated layers manually so the test fails loudly
    // if any layer is collapsed.
    const layer0 = result.error
    expect(layer0.kind).toBe('propagated')
    if (layer0.kind !== 'propagated') throw new Error('unreachable')
    const layer1 = layer0.cause
    expect(layer1.kind).toBe('propagated')
    if (layer1.kind !== 'propagated') throw new Error('unreachable')
    const layer2 = layer1.cause
    expect(layer2.kind).toBe('propagated')
    if (layer2.kind !== 'propagated') throw new Error('unreachable')
    const root = layer2.cause
    expect(root.kind).toBe('div-by-zero')
    // rootCause must agree with the manual walk so consumers do not
    // need to know the chain depth to find the originating failure.
    expect(formulaRootCause(result.error).kind).toBe('div-by-zero')
  })

  /**
   * The typed error chain must round-trip through `JSON.stringify` /
   * `JSON.parse` without losing structure. The `propagated` variant's
   * `cause` is a plain object (not a class instance), so serialization
   * is a property the type already supports; this test pins it so a
   * future shape change cannot silently break devtools / persistence
   * paths that ship errors across an IPC boundary.
   */
  it('propagated chain survives JSON round-trip', () => {
    // A1 = 0; B1 = A1/0 (div-by-zero); C1 = B1+1 (propagated).
    const { graph, resolve, inputs } = buildSheet()
    inputs.set('0,0', graph.input(cellId('wb', 's', { col: 0, row: 0 }), 0))
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const b1 = adapter.registerFormula({ col: 1, row: 0 }, parseFormula('=A1/0'))
    inputs.set('1,0', b1)
    const c1 = adapter.registerFormula({ col: 2, row: 0 }, parseFormula('=B1+1'))
    const result = graph.read(c1)
    if (result.kind !== 'error') throw new Error('unreachable')
    // Serialize and parse; cast back via the public type to confirm
    // the parsed object still satisfies the discriminated union shape.
    const wire = JSON.parse(JSON.stringify(result.error)) as FormulaError
    expect(wire.kind).toBe('propagated')
    if (wire.kind !== 'propagated') throw new Error('unreachable')
    expect(wire.cause.kind).toBe('div-by-zero')
    expect(formulaRootCause(wire).kind).toBe('div-by-zero')
    // Message text must survive the round-trip too — devtools surface
    // it verbatim and a regression here would silently blank out UI.
    expect(wire.message).toBe('Division by zero')
  })

  /**
   * Once an upstream input transitions back to a valid value, the
   * downstream formula must clear its error state and report a
   * successful value envelope.
   */
  it('a recovered upstream value flips downstream out of error', () => {
    // Start A1 with a string so B1 = A1+10 is initially a non-numeric error.
    const { graph, resolve, inputs } = buildSheet()
    const a = graph.input<unknown>(cellId('wb', 's', { col: 0, row: 0 }), 'oops')
    inputs.set('0,0', a as Node<unknown>)
    const adapter = createFormulaAdapter(graph, {
      workbook: 'wb',
      sheet: 's',
      resolve,
    })
    const b = adapter.registerFormula(
      { col: 1, row: 0 },
      parseFormula('=A1+10'),
    )
    // Initial state: B1 is an error because A1 is non-numeric.
    expect(graph.read(b).kind).toBe('error')
    // Commit a numeric value to A1; the downstream formula must recover.
    graph.commit('a→5', (tx) => tx.set(a, 5))
    const result = graph.read(b)
    expect(result.kind).toBe('value')
    if (result.kind !== 'value') throw new Error('unreachable')
    expect(result.value).toBe(15)
  })
})
