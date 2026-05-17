/**
 * @packageDocumentation
 *
 * Minimal formula grammar and AST shape for Phase 3 of
 * `@causljs/formula`. The grammar covers literal numbers, A1-style
 * cell references, contiguous ranges, parenthesised arithmetic with
 * `+ - * /`, unary negation, and function calls — enough to express
 * common spreadsheet expressions without the complexity of operator
 * precedence ambiguities or cross-sheet syntax. Cell references are
 * stored as 0-based `{ col, row }` pairs and round-tripped through A1
 * notation via {@link cellRefToA1} / {@link a1ToCellRef}; ranges may
 * be expanded into their constituent cells with {@link expandRange}.
 *
 * @remarks
 * Reference grammar (EBNF-ish):
 *
 *   formula      := '=' expression
 *   expression   := term (('+' | '-') term)*
 *   term         := factor (('*' | '/') factor)*
 *   factor       := number | cellref | rangeRef | '(' expression ')'
 *                 | functionCall | '-' factor
 *   cellref      := letter+ digit+               -- A1, BC42
 *   rangeRef     := cellref ':' cellref          -- A1:B5
 *   functionCall := identifier '(' (expression (',' expression)*)? ')'
 *   identifier   := letter (letter | digit)*
 *
 * Numbers are JavaScript number literals (no scientific notation in
 * v0). Cells refer to the active sheet; cross-sheet refs are not in
 * this minimal grammar — a follow-up issue adds `Sheet1!A1` syntax
 * once Cell/Sheet/Workbook types land (#34).
 */

// AST variants — discriminated by `type`. The canonical declarations of
// `Ast`, `BinOp`, and `CellRef` live in `./ir.ts` (the pure-data wire
// IR carved out for the future Rust port — issue #697 / epic #680).
// They are re-exported here so existing adopters that import
// `Ast`/`BinOp`/`CellRef` from `@causljs/formula` or directly from
// `./grammar.js` continue to compile unchanged.

export type { Ast, BinOp, CellRef } from './ir.js'

// Local imports of the same types used by helpers below. Kept separate
// from the re-export so re-exporting types and consuming them in the
// same module file stay readable.
import type { CellRef } from './ir.js'

/**
 * Convert a {@link CellRef} into its A1 string form.
 *
 * @param ref - Cell reference to render.
 * @returns A1-style label such as `"A1"` or `"AB42"`.
 */
export function cellRefToA1(ref: CellRef): string {
  return colToLetters(ref.col) + String(ref.row + 1)
}

/**
 * Parse an A1-style label back into a {@link CellRef}.
 *
 * @param a1 - Label such as `"A1"` or `"bc42"` (case-insensitive).
 * @returns The corresponding zero-based {@link CellRef}.
 * @throws Error when the input does not match `[A-Z]+[0-9]+` or the
 *   row component would resolve to a negative index.
 */
export function a1ToCellRef(a1: string): CellRef {
  const m = /^([A-Z]+)([0-9]+)$/.exec(a1.toUpperCase())
  if (!m) throw new Error(`Invalid A1 reference: ${a1}`)
  const letters = m[1]!
  const digits = m[2]!
  const col = lettersToCol(letters)
  const row = Number(digits) - 1
  if (row < 0 || !Number.isInteger(row)) {
    throw new Error(`Invalid A1 row in: ${a1}`)
  }
  return { col, row }
}

/**
 * Render a 0-based column index as bijective base-26 letters.
 *
 * @remarks
 * Spreadsheet column labels follow a bijective base-26 numbering
 * (`Z` is 25, `AA` is 26, not `BA`), which the loop encodes by
 * subtracting one before each higher-order digit.
 *
 * @param col - Non-negative integer column index.
 * @returns Uppercase letter sequence such as `"A"`, `"Z"`, or `"AA"`.
 * @throws Error when `col` is negative or non-integer.
 */
function colToLetters(col: number): string {
  if (col < 0 || !Number.isInteger(col)) {
    throw new Error(`Invalid column index: ${col}`)
  }
  let n = col
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/**
 * Inverse of {@link colToLetters}: parse a column letter sequence
 * into a 0-based column index.
 *
 * @param letters - Uppercase column letters such as `"AB"`.
 * @returns Zero-based column index.
 */
function lettersToCol(letters: string): number {
  let n = 0
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n - 1
}

/**
 * Enumerate every cell reference inside `[from, to]` (inclusive)
 * in row-major order.
 *
 * @remarks
 * The endpoints may be supplied in either order — the function
 * normalises the bounding box before iterating. Used by `range`
 * evaluation when materialising the full set of dependencies for a
 * `derived` registration.
 *
 * @param from - One corner of the range.
 * @param to - Opposite corner of the range.
 * @returns Array of {@link CellRef} values covering the bounding box.
 */
export function expandRange(from: CellRef, to: CellRef): CellRef[] {
  const c0 = Math.min(from.col, to.col)
  const c1 = Math.max(from.col, to.col)
  const r0 = Math.min(from.row, to.row)
  const r1 = Math.max(from.row, to.row)
  const out: CellRef[] = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      out.push({ col: c, row: r })
    }
  }
  return out
}
