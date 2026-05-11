/**
 * @packageDocumentation
 *
 * Domain types for the spreadsheet information layer — the things the
 * user actually thinks exist (workbooks, sheets, cells with formulas)
 * named in the user's language. Models a `Workbook → Sheet → Cell`
 * hierarchy with immutable read-only maps so the structure can be
 * safely shared across the engine and consumers. Identifiers belong to
 * the information-model namespace and deliberately exclude UI selection
 * state, drag-in-progress, and fetch-in-flight concerns; those live in
 * a separate editor-controller namespace. The {@link cellId} helper
 * composes a stable, human-readable form (`cell:${workbook}:${sheet}:${A1}`)
 * matching the convention used elsewhere in Causl for information-
 * model identifiers (alongside e.g. `asset:property-1:HVAC-3`).
 */

import type { Ast, CellRef } from './grammar.js'
import { cellRefToA1 } from './grammar.js'

/**
 * Opaque identifier for a workbook (e.g. `"wb1"`).
 */
export type WorkbookId = string

/**
 * Opaque identifier for a sheet within a workbook (e.g. `"Sheet1"`).
 */
export type SheetId = string

/**
 * Composite cell identifier produced by {@link cellId}.
 *
 * @remarks
 * Encodes workbook, sheet, and A1 cell reference into a single
 * `cell:wb:sheet:A1` string suitable as an engine node key.
 */
export type CellId = string

// CellValue variants — discriminated by `state`. Each tag corresponds
// to a distinct authoring mode for a cell.

/**
 * Discriminated union describing the contents of a {@link Cell}.
 *
 * @remarks
 * Variants:
 *
 * - `empty` — cell has been instantiated but holds no value.
 * - `literal` — primitive value entered directly by the user.
 * - `formula` — formula text together with its parsed {@link Ast},
 *   re-evaluated by the engine when dependencies change.
 */
export type CellValue =
  | { state: 'empty' }
  | { state: 'literal'; value: number | string | boolean | null }
  | { state: 'formula'; text: string; ast: Ast }

/**
 * A single spreadsheet cell at a fixed location.
 *
 * @remarks
 * Pairs a {@link CellRef} position with its current {@link CellValue}.
 * Both fields are immutable — updates produce a new `Cell` rather
 * than mutating in place.
 */
export interface Cell {
  readonly ref: CellRef
  readonly value: CellValue
}

/**
 * A single sheet within a workbook.
 *
 * @remarks
 * `cells` is keyed by A1 string (see {@link cellRefToA1}) and is
 * sparse: only cells with non-empty values are stored.
 */
export interface Sheet {
  readonly id: SheetId
  /** Sparse — only cells with non-empty values are present. */
  readonly cells: ReadonlyMap<string, Cell>
}

/**
 * A workbook holding one or more sheets.
 */
export interface Workbook {
  readonly id: WorkbookId
  readonly sheets: ReadonlyMap<SheetId, Sheet>
}

/**
 * Compose a stable {@link CellId} from its workbook, sheet, and ref.
 *
 * @param workbook - Identifier of the enclosing workbook.
 * @param sheet - Identifier of the enclosing sheet.
 * @param ref - Cell location within the sheet.
 * @returns Engine-friendly key of the form `cell:wb:sheet:A1`.
 */
export function cellId(workbook: WorkbookId, sheet: SheetId, ref: CellRef): CellId {
  return `cell:${workbook}:${sheet}:${cellRefToA1(ref)}`
}

/**
 * Construct an empty {@link Cell} at the given location.
 *
 * @param ref - Position of the new cell.
 * @returns Cell whose value is in the `empty` state.
 */
export function emptyCell(ref: CellRef): Cell {
  return { ref, value: { state: 'empty' } }
}

/**
 * Construct a literal-valued {@link Cell}.
 *
 * @param ref - Position of the new cell.
 * @param value - Primitive value entered by the user.
 * @returns Cell whose value is in the `literal` state.
 */
export function literalCell(
  ref: CellRef,
  value: number | string | boolean | null,
): Cell {
  return { ref, value: { state: 'literal', value } }
}

/**
 * Construct a formula-bearing {@link Cell}.
 *
 * @param ref - Position of the new cell.
 * @param text - Original formula source text (with leading `=`).
 * @param ast - Parsed AST corresponding to `text`.
 * @returns Cell whose value is in the `formula` state.
 */
export function formulaCell(ref: CellRef, text: string, ast: Ast): Cell {
  return { ref, value: { state: 'formula', text, ast } }
}

/**
 * Construct an empty {@link Sheet} with no cells.
 *
 * @param id - Identifier for the new sheet.
 * @returns Sheet with an empty cell map.
 */
export function emptySheet(id: SheetId): Sheet {
  return { id, cells: new Map<string, Cell>() }
}

/**
 * Construct an empty {@link Workbook} with no sheets.
 *
 * @param id - Identifier for the new workbook.
 * @returns Workbook with an empty sheet map.
 */
export function emptyWorkbook(id: WorkbookId): Workbook {
  return { id, sheets: new Map<SheetId, Sheet>() }
}
