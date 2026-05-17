/**
 * @packageDocumentation
 *
 * Public barrel for `@causljs/formula`. Re-exports the formula
 * grammar / AST types, parser entry point, domain model
 * (Cell / Sheet / Workbook), engine adapter that wires formulas into
 * the reactive graph, tagged result type for evaluation, and the
 * static cycle-detection helpers used at registration time. The
 * causl core deliberately does not ship a spreadsheet engine — it
 * supports spreadsheet *patterns* on top of the core, and this package
 * is that layer. The exported surface is intentionally narrow: only
 * symbols re-exported from this module are part of the package's
 * stability contract.
 */

// Wire-IR seam (issue #697 / epic #680): the pure-data AST / result
// types live in `./ir.js`; `./grammar.js` and `./result.js` re-export
// them so the legacy import paths keep working. Both paths surface
// the identical type identity — `Ast` from `@causljs/formula` is the
// same `Ast` as the future Rust enum will mirror byte-for-byte.
export type { Ast, BinOp, CellRef } from './ir.js'
export { FORMULA_IR_VERSION } from './ir.js'
export { a1ToCellRef, cellRefToA1, expandRange } from './grammar.js'
export { FormulaParseError, parseFormula } from './parser.js'
export type {
  Cell,
  CellId,
  CellValue,
  Sheet,
  SheetId,
  Workbook,
  WorkbookId,
} from './model.js'
export {
  cellId,
  emptyCell,
  emptySheet,
  emptyWorkbook,
  formulaCell,
  literalCell,
} from './model.js'
export type {
  CellNode,
  FormulaAdapter,
  FormulaAdapterOptions,
  FormulaHost,
} from './adapter.js'
export { createFormulaAdapter, evaluate } from './adapter.js'
export type { FormulaError, FormulaErrorKind, FormulaResult } from './ir.js'
export {
  err as formulaError,
  errResult as formulaErrorResult,
  ok as formulaOk,
  rootCause as formulaRootCause,
  valueOr,
} from './result.js'
export type { FormulaGraph } from './cycle.js'
export {
  addFormula,
  detectCycle,
  emptyFormulaGraph,
  refKey,
  staticReferences,
} from './cycle.js'

/**
 * Package version string.
 *
 * @remarks
 * Bumped manually on release; kept in sync with `package.json`.
 */
export const VERSION = '0.1.0'
