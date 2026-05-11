/**
 * @packageDocumentation
 *
 * Tests for `parseFormula`, the recursive-descent parser that turns
 * spreadsheet source strings into the AST consumed by the formula
 * evaluator. The suite covers literal forms, A1 cell references,
 * arithmetic precedence, parenthesised grouping, unary operators, range
 * notation, function calls with mixed argument types, and structural
 * error reporting via `FormulaParseError`.
 */

import { describe, expect, it } from 'vitest'
import { FormulaParseError, parseFormula } from '../src/index.js'

/**
 * Suite exercising the public `parseFormula` entry point against the
 * grammar described in the package SPEC.
 */
describe('parseFormula', () => {
  /**
   * Confirms numeric literals parse with or without the leading `=`
   * sigil, including integer and decimal forms.
   */
  it('parses a bare number', () => {
    // No leading `=` is tolerated for the literal form.
    expect(parseFormula('1')).toEqual({ type: 'num', value: 1 })
    // Standard formula-prefixed integer literal.
    expect(parseFormula('=42')).toEqual({ type: 'num', value: 42 })
    // Decimal literal must round-trip as a JS number.
    expect(parseFormula('3.14')).toEqual({ type: 'num', value: 3.14 })
  })

  /**
   * Validates A1-style cell references decode into zero-based
   * `{ col, row }` coordinates, including multi-letter columns.
   */
  it('parses cell references in A1 form', () => {
    // A1 maps to col=0, row=0.
    expect(parseFormula('=A1')).toEqual({
      type: 'cell',
      ref: { col: 0, row: 0 },
    })
    // AB10 exercises the multi-letter base-26 column decoding.
    expect(parseFormula('=AB10')).toEqual({
      type: 'cell',
      ref: { col: 27, row: 9 },
    })
  })

  /**
   * Pins the left-associative behaviour of `+` and `-` at the same
   * precedence level so `1+2-3` groups as `(1+2)-3`.
   */
  it('parses additive expressions left-to-right', () => {
    const ast = parseFormula('=1+2-3')
    // Outer node is the `-` with an inner `+` on its left, confirming
    // left-to-right associativity at the additive precedence band.
    expect(ast).toEqual({
      type: 'binop',
      op: '-',
      left: {
        type: 'binop',
        op: '+',
        left: { type: 'num', value: 1 },
        right: { type: 'num', value: 2 },
      },
      right: { type: 'num', value: 3 },
    })
  })

  /**
   * Verifies multiplicative operators bind tighter than additive ones
   * so `1+2*3` groups as `1+(2*3)`.
   */
  it('honours * / over + -', () => {
    const ast = parseFormula('=1+2*3')
    // Outer node is `+`; the right side is the higher-precedence `*`.
    expect(ast).toEqual({
      type: 'binop',
      op: '+',
      left: { type: 'num', value: 1 },
      right: {
        type: 'binop',
        op: '*',
        left: { type: 'num', value: 2 },
        right: { type: 'num', value: 3 },
      },
    })
  })

  /**
   * Confirms parentheses promote the enclosed expression so
   * `(1+2)*3` flips the natural precedence.
   */
  it('parses parens overriding precedence', () => {
    const ast = parseFormula('=(1+2)*3')
    // Outer `*` now wraps the parenthesised additive subtree.
    expect(ast).toEqual({
      type: 'binop',
      op: '*',
      left: {
        type: 'binop',
        op: '+',
        left: { type: 'num', value: 1 },
        right: { type: 'num', value: 2 },
      },
      right: { type: 'num', value: 3 },
    })
  })

  /**
   * Validates the prefix-`-` operator emits a `unary` AST node wrapping
   * its operand.
   */
  it('parses unary minus', () => {
    const ast = parseFormula('=-A1')
    // Unary node wraps the cell reference operand.
    expect(ast).toEqual({
      type: 'unary',
      op: '-',
      operand: { type: 'cell', ref: { col: 0, row: 0 } },
    })
  })

  /**
   * Confirms range syntax `A1:B3` parses to a `range` node carrying
   * the corner coordinates as zero-based refs.
   */
  it('parses range references', () => {
    const ast = parseFormula('=A1:B3')
    // Inclusive range from top-left A1 to bottom-right B3.
    expect(ast).toEqual({
      type: 'range',
      from: { col: 0, row: 0 },
      to: { col: 1, row: 2 },
    })
  })

  /**
   * Exercises function-call parsing with a heterogeneous argument list:
   * a range, a literal number, and a single cell reference.
   */
  it('parses function calls with mixed arg types', () => {
    const ast = parseFormula('=SUM(A1:A3, 5, B2)')
    // Top-level node must be a call.
    expect(ast.type).toBe('call')
    if (ast.type !== 'call') throw new Error('unreachable')
    // Call name and arity are surfaced verbatim.
    expect(ast.name).toBe('SUM')
    expect(ast.args.length).toBe(3)
    // Per-argument shape: range, literal number, single cell ref.
    expect(ast.args[0]?.type).toBe('range')
    expect(ast.args[1]).toEqual({ type: 'num', value: 5 })
    expect(ast.args[2]).toEqual({ type: 'cell', ref: { col: 1, row: 1 } })
  })

  /**
   * Ensures structural errors surface as `FormulaParseError` rather
   * than silently parsing or throwing a generic error.
   */
  it('rejects malformed input with FormulaParseError', () => {
    // Empty body after `=`.
    expect(() => parseFormula('=')).toThrow(FormulaParseError)
    // Trailing operator with no right operand.
    expect(() => parseFormula('=1+')).toThrow(FormulaParseError)
    // Stray non-grammar character.
    expect(() => parseFormula('=A1+@')).toThrow(FormulaParseError)
    // Unclosed function-call paren.
    expect(() => parseFormula('=fn(')).toThrow(FormulaParseError)
    // Trailing comma in arg list.
    expect(() => parseFormula('=fn(1,)')).toThrow(FormulaParseError)
    // Bare identifier with no call form.
    expect(() => parseFormula('=foo')).toThrow(FormulaParseError)
  })

  /**
   * Asserts the parser refuses input where extra tokens follow a
   * complete expression rather than silently dropping them.
   */
  it('rejects trailing junk', () => {
    // `=1 2` parses `1` then encounters an unexpected `2`.
    expect(() => parseFormula('=1 2')).toThrow(FormulaParseError)
  })
})
