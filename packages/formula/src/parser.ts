/**
 * @packageDocumentation
 *
 * Recursive-descent parser for the minimal spreadsheet-formula grammar
 * defined in `./grammar.ts`. The parser turns a formula string such as
 * `=SUM(A1:B5) + 2 * C3` into the {@link Ast} tagged union consumed by
 * the adapter in `./adapter.ts`. Operator precedence follows the
 * grammar: addition/subtraction at expression level, multiplication and
 * division at term level, with unary minus, parenthesised groups,
 * numbers, cell refs, ranges, and function calls handled at factor
 * level.
 *
 * Error reporting is positional: every {@link FormulaParseError}
 * carries the byte offset within the input where the problem was
 * detected, so callers can highlight the offending span. The
 * implementation deliberately avoids regular expressions over the whole
 * input — each parse function consumes at most one structural element
 * so reported positions stay trustworthy even on malformed input.
 */

import { a1ToCellRef } from './grammar.js'
import type { Ast, BinOp, CellRef } from './ir.js'

/**
 * Error raised when a formula source string fails to parse.
 *
 * @remarks
 * The {@link FormulaParseError.position} field is the zero-based index
 * inside the trimmed, leading-`=`-stripped body that the parser was
 * pointing at when the failure was detected.
 */
export class FormulaParseError extends Error {
  override name = 'FormulaParseError'
  /**
   * @param message - Human-readable description of the failure.
   * @param position - Byte offset within the parser body at which the
   *   error occurred (zero-based).
   */
  constructor(message: string, public readonly position: number) {
    super(`${message} at position ${position}`)
  }
}

/**
 * Parse a formula string into an {@link Ast}.
 *
 * The leading `=` is optional, so both `parseFormula('=A1+1')` and
 * `parseFormula('A1+1')` succeed and produce equivalent ASTs.
 *
 * @param text - Raw formula source.
 * @returns The parsed AST.
 * @throws {@link FormulaParseError} on any syntactic failure.
 *
 * @remarks
 * The implementation is a recursive-descent parser with the precedence
 * spelled out in `grammar.ts`. No regular expression scans the entire
 * input — each parse function consumes at most one structural element
 * so the positional information attached to errors stays accurate.
 *
 * @example
 * ```ts
 * const ast = parseFormula('=SUM(A1:A3) + 2')
 * // { type: 'binop', op: '+', left: { type: 'call', ... }, right: { type: 'num', value: 2 } }
 * ```
 */
export function parseFormula(text: string): Ast {
  // Strip surrounding whitespace and the optional leading `=` so the
  // parser body is the pure expression form.
  const trimmed = text.trim()
  const body = trimmed.startsWith('=') ? trimmed.slice(1) : trimmed
  const p = new Parser(body)
  const ast = p.parseExpression()
  // Reject trailing input — anything past the parsed expression is an
  // error, not silently discarded.
  p.expectEnd()
  return ast
}

/**
 * Internal stateful parser holding the cursor into the source body.
 *
 * @internal
 *
 * @remarks
 * The class is intentionally not exported: callers should go through
 * {@link parseFormula}. Parse methods mutate `pos` as they advance and
 * raise {@link FormulaParseError} on malformed input.
 */
class Parser {
  private pos = 0
  /**
   * @param src - Body string with the leading `=` already removed.
   */
  constructor(private readonly src: string) {}

  // --- Precedence level: expression (additive) ---
  /**
   * Parse an additive expression: one or more terms separated by `+` or
   * `-`. Left-associative, lowest precedence.
   *
   * @returns The AST for the parsed expression.
   * @throws {@link FormulaParseError} if a term is malformed.
   */
  parseExpression(): Ast {
    let left = this.parseTerm()
    // Left-associative fold: keep consuming `+`/`-` operators, lifting
    // the previous result into the left subtree of a new binop node.
    for (;;) {
      this.skipWs()
      const ch = this.peek()
      if (ch === '+' || ch === '-') {
        this.pos += 1
        const right = this.parseTerm()
        left = { type: 'binop', op: ch as BinOp, left, right }
      } else {
        return left
      }
    }
  }

  // --- Precedence level: term (multiplicative) ---
  /**
   * Parse a multiplicative term: one or more factors separated by `*`
   * or `/`. Left-associative, binds tighter than `+`/`-`.
   *
   * @returns The AST for the parsed term.
   * @throws {@link FormulaParseError} if a factor is malformed.
   */
  parseTerm(): Ast {
    let left = this.parseFactor()
    // Mirror of parseExpression's fold but for `*` and `/`.
    for (;;) {
      this.skipWs()
      const ch = this.peek()
      if (ch === '*' || ch === '/') {
        this.pos += 1
        const right = this.parseFactor()
        left = { type: 'binop', op: ch as BinOp, left, right }
      } else {
        return left
      }
    }
  }

  // --- Precedence level: factor (atoms, unary minus, parenthesised groups) ---
  /**
   * Parse a single factor: number literal, cell ref, range, function
   * call, parenthesised expression, or unary minus.
   *
   * @returns The AST for the parsed factor.
   * @throws {@link FormulaParseError} on unexpected end of input,
   *   missing closing parenthesis, or an unrecognised character.
   */
  parseFactor(): Ast {
    this.skipWs()
    const ch = this.peek()
    if (ch === undefined) {
      throw new FormulaParseError('Unexpected end of input', this.pos)
    }
    // Unary minus binds tighter than any binary operator and recurses
    // into another factor so `--A1` parses as `-(-A1)`.
    if (ch === '-') {
      this.pos += 1
      return { type: 'unary', op: '-', operand: this.parseFactor() }
    }
    // Parenthesised sub-expression: defer back to the top of the
    // precedence ladder, then require the matching `)`.
    if (ch === '(') {
      this.pos += 1
      const inner = this.parseExpression()
      this.skipWs()
      if (this.peek() !== ')') {
        throw new FormulaParseError('Expected )', this.pos)
      }
      this.pos += 1
      return inner
    }
    // Numeric literal — digits or a leading decimal point.
    if (this.isDigit(ch) || ch === '.') {
      return this.parseNumber()
    }
    // Letter prefix introduces either a cell ref / range or a function
    // call; the disambiguation lives in parseLetterPrefixed.
    if (this.isLetter(ch)) {
      return this.parseLetterPrefixed()
    }
    throw new FormulaParseError(`Unexpected character '${ch}'`, this.pos)
  }

  /**
   * Parse a numeric literal — a contiguous run of digits and decimal
   * points.
   *
   * @returns A `{ type: 'num' }` AST node.
   * @throws {@link FormulaParseError} if the captured token cannot be
   *   converted to a finite JavaScript number.
   *
   * @remarks
   * The lexer accepts multiple decimal points to keep the loop simple;
   * the resulting `Number()` conversion produces `NaN` for malformed
   * tokens, which then triggers the error branch.
   */
  private parseNumber(): Ast {
    const start = this.pos
    // Greedy digit/dot consumer — validation happens after via Number().
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch && (this.isDigit(ch) || ch === '.')) this.pos += 1
      else break
    }
    const token = this.src.slice(start, this.pos)
    const value = Number(token)
    if (Number.isNaN(value)) {
      throw new FormulaParseError(`Invalid number "${token}"`, start)
    }
    return { type: 'num', value }
  }

  /**
   * Parse a letter-prefixed token into a cell reference, a range, or a
   * function call.
   *
   * @returns One of `{ type: 'cell' }`, `{ type: 'range' }`, or
   *   `{ type: 'call' }`.
   * @throws {@link FormulaParseError} on a bare identifier (no
   *   following digits and no opening parenthesis), a missing closing
   *   parenthesis on a function call, or a malformed range upper bound.
   *
   * @remarks
   * The lookahead-free disambiguation works as follows: read letters,
   * then read digits. Any digits at all means the prefix is an A1 cell
   * reference, possibly followed by `:` to upgrade it to a range. With
   * no digits, the only valid continuation is `(` opening a function
   * argument list; otherwise the bare identifier is rejected.
   */
  private parseLetterPrefixed(): Ast {
    const start = this.pos

    // Consume the letter run (column letters or function name).
    let letters = ''
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch && this.isLetter(ch)) {
        letters += ch
        this.pos += 1
      } else break
    }

    // Consume any trailing digits — their presence flips us into
    // cell-reference territory.
    let digits = ''
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch && this.isDigit(ch)) {
        digits += ch
        this.pos += 1
      } else break
    }

    // Letters + digits → A1 reference, optionally upgraded to a range.
    if (digits.length > 0) {
      const a1 = letters + digits
      const from = a1ToCellRef(a1)
      this.skipWs()
      if (this.peek() === ':') {
        // Range form: parse the upper bound the same way.
        this.pos += 1
        this.skipWs()
        const toLetters = this.readLetters()
        const toDigits = this.readDigits()
        if (toLetters.length === 0 || toDigits.length === 0) {
          throw new FormulaParseError('Invalid range upper bound', this.pos)
        }
        const to: CellRef = a1ToCellRef(toLetters + toDigits)
        return { type: 'range', from, to }
      }
      return { type: 'cell', ref: from }
    }

    // No digits → identifier — function call or bare identifier (error)
    if (letters.length === 0) {
      throw new FormulaParseError('Expected identifier', start)
    }
    this.skipWs()
    if (this.peek() === '(') {
      // Function call: read argument list and require matching `)`.
      this.pos += 1
      const args = this.parseArgList()
      if (this.peek() !== ')') {
        throw new FormulaParseError('Expected ) after function args', this.pos)
      }
      this.pos += 1
      // Function names are normalised to upper case so the adapter's
      // dispatch table can stay case-insensitive.
      return { type: 'call', name: letters.toUpperCase(), args }
    }
    throw new FormulaParseError(`Bare identifier "${letters}" is not allowed`, start)
  }

  /**
   * Parse a comma-separated function argument list (without the
   * enclosing parentheses).
   *
   * @returns The array of argument ASTs; empty when the next character
   *   is the closing `)`.
   *
   * @remarks
   * The caller is responsible for consuming the opening `(` before and
   * the closing `)` after this method.
   */
  private parseArgList(): Ast[] {
    this.skipWs()
    if (this.peek() === ')') return []
    // First argument seeds the list; subsequent ones follow `,`.
    const args: Ast[] = [this.parseExpression()]
    for (;;) {
      this.skipWs()
      if (this.peek() === ',') {
        this.pos += 1
        args.push(this.parseExpression())
      } else return args
    }
  }

  /**
   * Read a contiguous run of letters, advancing the cursor.
   *
   * @returns The captured letters; empty string if the cursor is not
   *   on a letter.
   */
  private readLetters(): string {
    let s = ''
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch && this.isLetter(ch)) {
        s += ch
        this.pos += 1
      } else break
    }
    return s
  }

  /**
   * Read a contiguous run of digits, advancing the cursor.
   *
   * @returns The captured digits; empty string if the cursor is not on
   *   a digit.
   */
  private readDigits(): string {
    let s = ''
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch && this.isDigit(ch)) {
        s += ch
        this.pos += 1
      } else break
    }
    return s
  }

  /**
   * Assert that the parser has consumed the entire input.
   *
   * @throws {@link FormulaParseError} when any non-whitespace remains
   *   after the parsed expression.
   */
  expectEnd(): void {
    this.skipWs()
    if (this.pos !== this.src.length) {
      throw new FormulaParseError(`Unexpected '${this.src.slice(this.pos)}'`, this.pos)
    }
  }

  /**
   * Look at the current character without advancing.
   *
   * @returns The character at the cursor, or `undefined` past end of
   *   input.
   */
  private peek(): string | undefined {
    return this.src[this.pos]
  }

  /**
   * Advance the cursor over any inline whitespace (space and tab).
   *
   * @remarks
   * Newlines are not part of the formula grammar; encountering one
   * surfaces as an "Unexpected character" error in the calling parse
   * method rather than being silently swallowed here.
   */
  private skipWs(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch === ' ' || ch === '\t') this.pos += 1
      else break
    }
  }

  /**
   * Test whether `ch` is an ASCII digit.
   *
   * @param ch - Single character.
   * @returns `true` for `'0'` through `'9'`.
   */
  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9'
  }

  /**
   * Test whether `ch` is an ASCII letter (case-insensitive).
   *
   * @param ch - Single character.
   * @returns `true` for `'A'`–`'Z'` and `'a'`–`'z'`.
   *
   * @remarks
   * Implemented by upper-casing first so a single comparison covers
   * both letter cases.
   */
  private isLetter(ch: string): boolean {
    const u = ch.toUpperCase()
    return u >= 'A' && u <= 'Z'
  }
}
