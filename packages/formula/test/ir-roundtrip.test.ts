/**
 * @packageDocumentation
 *
 * Property test pinning the JSON-roundtrip stability of the formula
 * wire-IR exported from `@causl/formula` (canonically declared in
 * `src/ir.ts`). The carve-out from issue #697 promises that the AST
 * shape is a pure-data structure encoded as plain JSON objects with
 * no methods, no closures, no symbols — meaning
 * `Ast → JSON.stringify → JSON.parse` must reproduce a structurally
 * equivalent tree byte-for-byte. The same contract holds for
 * `FormulaResult`. When the future Rust port of the parser/evaluator
 * lands (epic #680), this test is the cross-bridge equivalence guard
 * — both sides must serialise to the same bytes for the same input.
 *
 * The property tests use `fast-check` to generate arbitrary trees
 * across every variant of `Ast` and `FormulaError` so a new variant
 * added without thinking about the wire shape surfaces immediately as
 * a roundtrip failure rather than as a silent encoding drift.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Ast, BinOp, CellRef, FormulaError, FormulaResult } from '../src/ir.js'
import { FORMULA_IR_VERSION } from '../src/ir.js'

/**
 * Arbitrary for a {@link CellRef} producing only non-negative integer
 * coordinates inside a tractable range — the wire IR allows the full
 * non-negative integer space but tests don't gain coverage from very
 * large indices and the assertion budget pays for shape, not scale.
 *
 * @returns A fast-check arbitrary yielding valid CellRef values.
 */
const cellRefArb = (): fc.Arbitrary<CellRef> =>
  fc.record({
    col: fc.integer({ min: 0, max: 1000 }),
    row: fc.integer({ min: 0, max: 1000 }),
  })

/**
 * Arbitrary for {@link BinOp} — one of `'+'`, `'-'`, `'*'`, `'/'`.
 *
 * @returns A fast-check arbitrary picking uniformly from the four
 *   supported binary operators.
 */
const binOpArb = (): fc.Arbitrary<BinOp> =>
  fc.constantFrom<BinOp>('+', '-', '*', '/')

/**
 * Recursive arbitrary for {@link Ast} covering every variant.
 *
 * @remarks
 * The recursion budget is bounded by `fc.letrec`'s built-in depth
 * limiter, which keeps generated trees shallow enough that test runs
 * complete in tens of milliseconds even at the default 100-run
 * `fast-check` count. `JSON.stringify` is well-defined on every leaf
 * here — no NaN/Infinity in the numeric literal arbitrary, so the
 * roundtrip cannot fail on a non-JSON-representable value.
 *
 * @returns Arbitrary producing valid `Ast` trees.
 */
const astArb = (): fc.Arbitrary<Ast> =>
  fc.letrec<{ ast: Ast }>((tie) => ({
    ast: fc.oneof(
      // num: finite JS numbers only — JSON.stringify maps NaN/±Infinity
      // to `null`, which would break round-tripping equivalence.
      // Also exclude `-0`: `JSON.stringify(-0)` is `"0"` which then
      // parses to `+0`, so `toEqual(-0)` fails the structural-equality
      // round-trip. fast-check's `double` generator includes `-0` in
      // its sample space by default — filter it explicitly to keep the
      // round-trip property honest about the JSON wire contract.
      fc.record({
        type: fc.constant('num' as const),
        value: fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Object.is(n, -0)),
      }),
      // cell: structured reference to a single cell.
      fc.record({
        type: fc.constant('cell' as const),
        ref: cellRefArb(),
      }),
      // range: two corner refs, inclusive rectangle.
      fc.record({
        type: fc.constant('range' as const),
        from: cellRefArb(),
        to: cellRefArb(),
      }),
      // binop: recursive on both branches.
      fc.record({
        type: fc.constant('binop' as const),
        op: binOpArb(),
        left: tie('ast'),
        right: tie('ast'),
      }),
      // unary: only `-` is in the grammar.
      fc.record({
        type: fc.constant('unary' as const),
        op: fc.constant('-' as const),
        operand: tie('ast'),
      }),
      // call: function name and positional args.
      fc.record({
        type: fc.constant('call' as const),
        name: fc.constantFrom('SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX'),
        args: fc.array(tie('ast'), { maxLength: 4 }),
      }),
    ),
  })).ast

/**
 * Recursive arbitrary for {@link FormulaError} covering every variant.
 *
 * @remarks
 * The `propagated` variant nests another `FormulaError` as `cause`,
 * which is itself an arbitrary node — `fc.letrec` handles the
 * recursion the same way it does for `Ast`. The `ref` field is
 * structurally optional on `div-by-zero` and `propagated` but
 * required on `unresolved-ref` and `non-numeric`; the arbitrary
 * mirrors that to keep generated values type-valid.
 *
 * @returns Arbitrary producing valid `FormulaError` trees.
 */
const errorArb = (): fc.Arbitrary<FormulaError> =>
  fc.letrec<{ err: FormulaError }>((tie) => ({
    err: fc.oneof(
      fc.record({
        kind: fc.constant('div-by-zero' as const),
        message: fc.string(),
      }),
      fc.record({
        kind: fc.constant('unresolved-ref' as const),
        message: fc.string(),
        ref: fc.string({ minLength: 1 }),
      }),
      fc.record({
        kind: fc.constant('non-numeric' as const),
        message: fc.string(),
        ref: fc.string({ minLength: 1 }),
      }),
      fc.record({
        kind: fc.constant('unknown-function' as const),
        message: fc.string(),
      }),
      fc.record({
        kind: fc.constant('argument-error' as const),
        message: fc.string(),
      }),
      fc.record({
        kind: fc.constant('propagated' as const),
        message: fc.string(),
        cause: tie('err'),
      }),
    ),
  })).err

/**
 * Arbitrary for {@link FormulaResult} — either a `'value'` success
 * carrying a finite number or an `'error'` carrying any
 * {@link FormulaError}.
 *
 * @returns Arbitrary producing valid `FormulaResult` values.
 */
const formulaResultArb = (): fc.Arbitrary<FormulaResult> =>
  fc.oneof(
    fc.record({
      kind: fc.constant('value' as const),
      // Exclude `-0` for the same reason as `astArb`'s `num` arbitrary:
      // `JSON.stringify(-0) === "0"` parses back to `+0`, breaking the
      // structural-equality round-trip.
      value: fc
        .double({ noNaN: true, noDefaultInfinity: true })
        .filter((n) => !Object.is(n, -0)),
    }),
    fc.record({
      kind: fc.constant('error' as const),
      error: errorArb(),
    }),
  )

/**
 * Suite verifying that the wire IR survives a JSON round-trip with
 * structural equality intact. The same property is the cross-bridge
 * contract the eventual Rust port (issue #697 deliverable #4) will
 * have to satisfy.
 */
describe('formula IR JSON round-trip', () => {
  /**
   * Every `Ast` variant — including deeply nested `binop`/`call`
   * trees — must reproduce structurally after `JSON.stringify` →
   * `JSON.parse`.
   */
  it('Ast survives JSON.stringify → JSON.parse with structural equality', () => {
    fc.assert(
      fc.property(astArb(), (ast) => {
        // Encode → decode and compare for structural equality. The
        // toEqual matcher walks both trees recursively so nested
        // binop/call/range structures are compared field-by-field.
        const encoded = JSON.stringify(ast)
        const decoded = JSON.parse(encoded) as Ast
        expect(decoded).toEqual(ast)
      }),
    )
  })

  /**
   * Encoding the same `Ast` twice must produce byte-identical JSON.
   * The wire-IR contract pins encoding determinism because the future
   * Rust port has to compare-by-bytes against the TS encoder.
   */
  it('Ast JSON encoding is deterministic (byte-stable across encodings)', () => {
    fc.assert(
      fc.property(astArb(), (ast) => {
        // Two independent `JSON.stringify` calls on the same plain
        // object must yield identical bytes — field order in plain
        // object literals is preserved by V8 / SpiderMonkey, and the
        // arbitrary builds variants with a fixed field order.
        const a = JSON.stringify(ast)
        const b = JSON.stringify(ast)
        expect(a).toBe(b)
      }),
    )
  })

  /**
   * `FormulaResult` (including nested `propagated` error chains) must
   * round-trip with structural equality intact.
   */
  it('FormulaResult survives JSON round-trip with structural equality', () => {
    fc.assert(
      fc.property(formulaResultArb(), (result) => {
        // Same property as above but exercising the result-IR surface
        // — including the recursive `cause` chain on `propagated`.
        const encoded = JSON.stringify(result)
        const decoded = JSON.parse(encoded) as FormulaResult
        expect(decoded).toEqual(result)
      }),
    )
  })
})

/**
 * Suite covering the version envelope contract — the constant must be
 * stable, non-empty, and shaped like SemVer or a pre-release tag.
 */
describe('FORMULA_IR_VERSION', () => {
  /**
   * The version constant must be present and non-empty so the cross-
   * bridge envelope can include it without a defensive fallback.
   */
  it('is a non-empty string', () => {
    expect(typeof FORMULA_IR_VERSION).toBe('string')
    expect(FORMULA_IR_VERSION.length).toBeGreaterThan(0)
  })

  /**
   * The string must parse as a coarse SemVer-shaped tag so adopters
   * comparing across versions can rely on a familiar format.
   */
  it('matches a coarse SemVer shape', () => {
    // Major.minor.patch with optional pre-release suffix — the regex is
    // intentionally permissive so `'0.1.0'` and `'1.0.0-rc.1'` both
    // satisfy it without requiring a SemVer parser dependency.
    expect(FORMULA_IR_VERSION).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/)
  })
})
