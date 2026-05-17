import { Node, DerivedNode, Graph } from '@causl/core';

/**
 * @packageDocumentation
 *
 * Pure-data intermediate representation (IR) for the formula
 * parser/evaluator pair. This module is the carve-out seam against the
 * future Rust port discussed in issue #697 (sub-task of epic #680): the
 * AST and result types live here as structural, JSON-serialisable
 * shapes, free of methods, closures, classes, and host bindings. The
 * parser writes IR; the evaluator reads IR. Anything else — `cellRefToA1`
 * conversions, range expansion, error constructors, `EvalError`
 * unwinds — stays in the behaviour-bearing modules
 * (`grammar.ts`, `result.ts`, `adapter.ts`) and merely *consumes* the
 * IR re-exported below.
 *
 * **Migration contract.** When the formula parser/evaluator moves to
 * Rust (`engine-rs-core`, behind a future feature flag per the issue),
 * the wire IR is the only thing both sides have to agree on. Adding a
 * field, renaming a tag, or changing the encoding of a variant is a
 * SPEC change that bumps {@link FORMULA_IR_VERSION}; the TS evaluator
 * and the Rust evaluator must be kept structurally identical when they
 * coexist. The cross-bridge determinism contract from #685 also pins
 * the JSON encoding order, so the property test in
 * `test/ir-roundtrip.test.ts` exercises `Ast → JSON.stringify → JSON.parse`
 * byte stability for every variant.
 *
 * **Behaviour boundary — do not add to this module.** Helpers, error
 * constructors, validation, or any function that *interprets* the IR
 * belongs in a sibling module that imports from here. The rule is
 * mechanical: if a symbol would have a body in Rust (a function, a
 * method, a closure), it must not live in `ir.ts`. Types, type
 * aliases, interfaces, and primitive constants only.
 *
 * @see {@link ../README.md} (Section "Wire-IR seam")
 * @see issue #697 — wasm-engine: carve formula IR seam
 * @see epic #680 — WASM-backed engine
 */
/**
 * Discriminated AST union produced by the formula parser.
 *
 * @remarks
 * Variants:
 *
 * - `num` — numeric literal carrying its parsed `value`.
 * - `cell` — single A1 reference resolved to a {@link CellRef}.
 * - `range` — inclusive rectangular range from `from` to `to`.
 * - `binop` — binary arithmetic with operator {@link BinOp} and
 *   `left`/`right` operands.
 * - `unary` — unary minus applied to `operand`.
 * - `call` — function invocation by `name` with positional `args`.
 *
 * The tag field `type` is the discriminator. Every variant is a plain
 * JSON object so the whole tree round-trips through
 * `JSON.stringify` / `JSON.parse` without loss — the property test in
 * `test/ir-roundtrip.test.ts` pins that contract.
 */
type Ast = {
    type: 'num';
    value: number;
} | {
    type: 'cell';
    ref: CellRef;
} | {
    type: 'range';
    from: CellRef;
    to: CellRef;
} | {
    type: 'binop';
    op: BinOp;
    left: Ast;
    right: Ast;
} | {
    type: 'unary';
    op: '-';
    operand: Ast;
} | {
    type: 'call';
    name: string;
    args: Ast[];
};
/**
 * Supported binary arithmetic operators.
 *
 * @remarks
 * Precedence is encoded by the parser, not by this type — addition
 * and subtraction sit at one tier and multiplication / division sit
 * at a higher one. Both the TS parser and the eventual Rust parser
 * must produce identical operator tags so the cross-bridge byte
 * comparison in the IR roundtrip property test holds.
 */
type BinOp = '+' | '-' | '*' | '/';
/**
 * Zero-based column / row pair identifying a single cell.
 *
 * @remarks
 * The A1 form `B3` corresponds to `{ col: 1, row: 2 }`. Storing both
 * components as integers keeps range expansion and arithmetic simple
 * and avoids parsing A1 strings during evaluation. The field order
 * (`col` before `row`) is part of the wire format — `JSON.stringify`
 * preserves insertion order for plain objects, so swapping the
 * declaration order would silently break byte-stability of the IR.
 */
interface CellRef {
    /** Column index, 0-based (A=0, B=1, …, Z=25, AA=26, AB=27, …). */
    readonly col: number;
    /** Row index, 0-based (1 → 0, 2 → 1). */
    readonly row: number;
}
/**
 * Result of evaluating a formula AST.
 *
 * @remarks
 * Discriminated on `kind`. Use the constructors in `result.ts`
 * ({@link ../result.ts | ok}, {@link ../result.ts | err},
 * {@link ../result.ts | errResult}) rather than building literals by
 * hand at call sites — the constructors enforce that every required
 * field of each variant is present and live in the behaviour-bearing
 * module so the IR boundary here stays data-only.
 *
 * Both branches are structurally JSON-safe: `kind: 'value'` carries a
 * single `number`; `kind: 'error'` nests a {@link FormulaError} whose
 * variants are themselves plain objects.
 */
type FormulaResult = {
    readonly kind: 'value';
    readonly value: number;
} | {
    readonly kind: 'error';
    readonly error: FormulaError;
};
/**
 * Closed set of error category tags carried by {@link FormulaError}
 * variants.
 *
 * @remarks
 * Derived from the union itself so adding a variant to
 * {@link FormulaError} automatically widens the kind alias without
 * a second source of truth.
 *
 * Members:
 *
 * - `div-by-zero` — division or modulo with a zero divisor.
 * - `unresolved-ref` — referenced cell could not be located.
 * - `non-numeric` — arithmetic applied to a non-numeric operand.
 * - `unknown-function` — call site names a function the evaluator
 *   does not recognise.
 * - `argument-error` — function call received the wrong number or
 *   shape of arguments.
 * - `propagated` — error originated upstream and was forwarded by
 *   this node; the variant carries `cause: FormulaError` so the
 *   original chain survives every relay hop.
 */
type FormulaErrorKind = FormulaError['kind'];
/**
 * Structured error payload accompanying an `error` {@link FormulaResult}.
 *
 * @remarks
 * Discriminated on `kind`. The `propagated` variant nests another
 * `FormulaError` as `cause`, so an error chain is a finite tree of
 * IR nodes — the same encoding survives a JSON round-trip and, in
 * the future Rust port, maps to a recursive enum behind a `Box`.
 *
 * The `unresolved-ref` and `non-numeric` variants make `ref` required
 * because a reference error without the offending cell label is not a
 * useful diagnostic and its representability is exactly the kind of
 * §9 hole the discriminated union closes.
 */
type FormulaError = {
    readonly kind: 'div-by-zero';
    readonly message: string;
    readonly ref?: string;
} | {
    readonly kind: 'unresolved-ref';
    readonly message: string;
    readonly ref: string;
} | {
    readonly kind: 'non-numeric';
    readonly message: string;
    readonly ref: string;
} | {
    readonly kind: 'unknown-function';
    readonly message: string;
} | {
    readonly kind: 'argument-error';
    readonly message: string;
} | {
    readonly kind: 'propagated';
    readonly message: string;
    readonly cause: FormulaError;
    readonly ref?: string;
};
/**
 * Wire-IR version string for the formula AST + result shapes exported
 * from this module.
 *
 * @remarks
 * Bumping this constant is a SPEC change: the cross-bridge contract
 * with the eventual Rust port (issue #697 deliverable #1) requires
 * both sides to agree on the encoded shape. Any structural rename,
 * variant addition, or field-order change increments the version and
 * triggers a coordinated update on both the TS and Rust evaluators.
 *
 * The version is intentionally a string rather than a number so that
 * pre-1.0 deliberation (`'0.1.0'`, `'0.2.0-rc'`) and post-1.0 SemVer
 * (`'1.0.0'`) share the same field shape.
 */
declare const FORMULA_IR_VERSION = "0.1.0";

/**
 * @packageDocumentation
 *
 * Minimal formula grammar and AST shape for Phase 3 of
 * `@causl/formula`. The grammar covers literal numbers, A1-style
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

/**
 * Convert a {@link CellRef} into its A1 string form.
 *
 * @param ref - Cell reference to render.
 * @returns A1-style label such as `"A1"` or `"AB42"`.
 */
declare function cellRefToA1(ref: CellRef): string;
/**
 * Parse an A1-style label back into a {@link CellRef}.
 *
 * @param a1 - Label such as `"A1"` or `"bc42"` (case-insensitive).
 * @returns The corresponding zero-based {@link CellRef}.
 * @throws Error when the input does not match `[A-Z]+[0-9]+` or the
 *   row component would resolve to a negative index.
 */
declare function a1ToCellRef(a1: string): CellRef;
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
declare function expandRange(from: CellRef, to: CellRef): CellRef[];

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

/**
 * Error raised when a formula source string fails to parse.
 *
 * @remarks
 * The {@link FormulaParseError.position} field is the zero-based index
 * inside the trimmed, leading-`=`-stripped body that the parser was
 * pointing at when the failure was detected.
 */
declare class FormulaParseError extends Error {
    readonly position: number;
    name: string;
    /**
     * @param message - Human-readable description of the failure.
     * @param position - Byte offset within the parser body at which the
     *   error occurred (zero-based).
     */
    constructor(message: string, position: number);
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
declare function parseFormula(text: string): Ast;

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

/**
 * Opaque identifier for a workbook (e.g. `"wb1"`).
 */
type WorkbookId = string;
/**
 * Opaque identifier for a sheet within a workbook (e.g. `"Sheet1"`).
 */
type SheetId = string;
/**
 * Composite cell identifier produced by {@link cellId}.
 *
 * @remarks
 * Encodes workbook, sheet, and A1 cell reference into a single
 * `cell:wb:sheet:A1` string suitable as an engine node key.
 */
type CellId = string;
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
type CellValue = {
    state: 'empty';
} | {
    state: 'literal';
    value: number | string | boolean | null;
} | {
    state: 'formula';
    text: string;
    ast: Ast;
};
/**
 * A single spreadsheet cell at a fixed location.
 *
 * @remarks
 * Pairs a {@link CellRef} position with its current {@link CellValue}.
 * Both fields are immutable — updates produce a new `Cell` rather
 * than mutating in place.
 */
interface Cell {
    readonly ref: CellRef;
    readonly value: CellValue;
}
/**
 * A single sheet within a workbook.
 *
 * @remarks
 * `cells` is keyed by A1 string (see {@link cellRefToA1}) and is
 * sparse: only cells with non-empty values are stored.
 */
interface Sheet {
    readonly id: SheetId;
    /** Sparse — only cells with non-empty values are present. */
    readonly cells: ReadonlyMap<string, Cell>;
}
/**
 * A workbook holding one or more sheets.
 */
interface Workbook {
    readonly id: WorkbookId;
    readonly sheets: ReadonlyMap<SheetId, Sheet>;
}
/**
 * Compose a stable {@link CellId} from its workbook, sheet, and ref.
 *
 * @param workbook - Identifier of the enclosing workbook.
 * @param sheet - Identifier of the enclosing sheet.
 * @param ref - Cell location within the sheet.
 * @returns Engine-friendly key of the form `cell:wb:sheet:A1`.
 */
declare function cellId(workbook: WorkbookId, sheet: SheetId, ref: CellRef): CellId;
/**
 * Construct an empty {@link Cell} at the given location.
 *
 * @param ref - Position of the new cell.
 * @returns Cell whose value is in the `empty` state.
 */
declare function emptyCell(ref: CellRef): Cell;
/**
 * Construct a literal-valued {@link Cell}.
 *
 * @param ref - Position of the new cell.
 * @param value - Primitive value entered by the user.
 * @returns Cell whose value is in the `literal` state.
 */
declare function literalCell(ref: CellRef, value: number | string | boolean | null): Cell;
/**
 * Construct a formula-bearing {@link Cell}.
 *
 * @param ref - Position of the new cell.
 * @param text - Original formula source text (with leading `=`).
 * @param ast - Parsed AST corresponding to `text`.
 * @returns Cell whose value is in the `formula` state.
 */
declare function formulaCell(ref: CellRef, text: string, ast: Ast): Cell;
/**
 * Construct an empty {@link Sheet} with no cells.
 *
 * @param id - Identifier for the new sheet.
 * @returns Sheet with an empty cell map.
 */
declare function emptySheet(id: SheetId): Sheet;
/**
 * Construct an empty {@link Workbook} with no sheets.
 *
 * @param id - Identifier for the new workbook.
 * @returns Workbook with an empty sheet map.
 */
declare function emptyWorkbook(id: WorkbookId): Workbook;

/**
 * @packageDocumentation
 *
 * Formula-to-derived-node adapter for `@causl/formula`. Causl
 * commits to two primitives — `InputNode` and `DerivedNode` — and treats
 * everything previous drafts called a "kind" as a *role* a node plays.
 * A `formula` is "a derived whose compute function happens to interpret
 * an expression string"; this adapter is the place that translation
 * actually happens. Each spreadsheet formula cell is registered as a
 * derived node whose compute closure interprets a parsed AST against the
 * current values of the cells it references at evaluation time, returning
 * a tagged {@link FormulaResult} so callers pattern-match on success or
 * structured failure rather than reading optional fields whose
 * combinations would otherwise let "has a value AND an error AND no AST
 * AND no dependencies" be representable.
 *
 * The translation step keeps spreadsheet semantics out of the core engine
 * — the core does not parse expressions, does not know about `=SUM(...)`,
 * does not know about cell references, and spreadsheet support is a
 * deliberate *use* of the engine rather than something built into it.
 * Cycle detection, dependency tracking, and topological recompute remain
 * the responsibility of the `@causl/core` graph; this module merely
 * supplies a {@link Compute} that delegates to the public
 * {@link evaluate} entry point against a {@link FormulaHost} bound to the
 * graph at compute time.
 *
 * **Host abstraction (issue #1081 / #697 d3).** Evaluation does not
 * know about the underlying graph. It consumes a {@link FormulaHost}
 * whose `readNumber(cellId)` returns either a coerced numeric value or
 * a tagged {@link FormulaError}. The TS adapter builds a host that
 * binds a graph reader; a future Rust evaluator can satisfy the same
 * contract from a different backing store. Errors discovered
 * mid-evaluation (division by zero, unresolved refs, non-numeric
 * upstream values, unknown functions, propagated upstream errors) flow
 * through a private {@link EvalError} short-circuit and are surfaced
 * at the compute boundary as a single {@link FormulaResult}.
 */

/**
 * Convenience alias for an arbitrary causl graph node carrying an
 * unknown payload. Cell nodes registered through this adapter are erased
 * to `unknown` because the adapter accepts any upstream value type and
 * narrows it at read time via the host's {@link FormulaHost.readNumber}.
 */
type CellNode = Node<unknown>;
/**
 * Evaluation-time host abstraction for the formula evaluator.
 *
 * @remarks
 * The host is the only thing {@link evaluate} talks to. Every cell
 * read goes through {@link FormulaHost.readNumber}; the evaluator
 * itself contains no graph, no resolver, no coercion table. This is
 * the public surface that the eventual Rust evaluator port must
 * satisfy — both implementations consume the same {@link Ast} and
 * produce the same {@link FormulaResult}, differing only in how the
 * host resolves cell IDs to numeric values.
 *
 * **Error semantics.** A host may return a {@link FormulaError} for
 * any failure: missing cell, non-numeric upstream value, propagated
 * upstream error, or backing-store-specific I/O failure. The
 * evaluator treats `unresolved-ref` specially inside range
 * aggregations (skipped silently to match spreadsheet idiom) and
 * surfaces every other error category by short-circuiting evaluation
 * and returning an `error` {@link FormulaResult}. Outside range
 * contexts every error short-circuits.
 *
 * **A1 keys.** The `cellId` argument is the A1 reference string
 * (`"A1"`, `"BC42"`) produced from the AST's {@link CellRef} via
 * {@link cellRefToA1}. The host is responsible for any further
 * translation into its backing-store identifier.
 */
interface FormulaHost {
    /**
     * Resolve and coerce the numeric value of a cell.
     *
     * @param cellId - A1 reference string identifying the cell.
     * @returns A finite `number` on success; otherwise a tagged
     *   {@link FormulaError} describing the failure.
     */
    readNumber(cellId: string): number | FormulaError;
}
/**
 * Construction options for {@link createFormulaAdapter}.
 *
 * @remarks
 * The {@link FormulaAdapterOptions.resolve} callback maps a parsed
 * {@link CellRef} to its underlying graph node, returning `undefined`
 * for cells that have not been registered. Returning `undefined`
 * triggers an `unresolved-ref` error for direct cell references and
 * silently skips the missing cell inside range aggregations, matching
 * traditional spreadsheet semantics.
 */
interface FormulaAdapterOptions {
    /** Identifier of the workbook the registered cells belong to. */
    readonly workbook: WorkbookId;
    /** Identifier of the sheet the registered cells belong to. */
    readonly sheet: SheetId;
    /**
     * Lookup hook from a parsed cell reference to a registered graph node.
     *
     * @param ref - Column/row reference parsed from the formula source.
     * @returns The underlying {@link CellNode}, or `undefined` if no cell
     *   has been registered at that reference.
     */
    readonly resolve: (ref: CellRef) => CellNode | undefined;
}
/**
 * Public surface of the adapter returned from {@link createFormulaAdapter}.
 *
 * @remarks
 * The adapter is stateful only in that it tracks the set of cell ids it
 * has registered with the underlying graph; the graph itself owns the
 * derived nodes once {@link FormulaAdapter.registerFormula} returns.
 */
interface FormulaAdapter {
    /**
     * Register a formula AST as a derived node in the graph.
     *
     * @param ref - Cell reference at which the formula lives.
     * @param ast - Parsed formula expression.
     * @returns The derived node carrying the tagged {@link FormulaResult}.
     */
    registerFormula(ref: CellRef, ast: Ast): DerivedNode<FormulaResult>;
    /**
     * Snapshot of every {@link CellId} registered through this adapter so
     * far, in insertion order. Useful for diagnostics and tests.
     */
    registered(): readonly CellId[];
}
/**
 * Evaluate a parsed formula AST against a {@link FormulaHost}.
 *
 * @param ast - Parsed formula expression.
 * @param host - Host that resolves cell IDs to numbers or structured
 *   {@link FormulaError} values.
 * @returns The {@link FormulaResult} produced by the evaluator.
 *
 * @remarks
 * This is the public entry point that any future Rust evaluator must
 * also satisfy. The TS implementation is a recursive interpreter over
 * the {@link Ast} discriminated union; structured failures short-
 * circuit through an internal exception channel and are normalised to
 * an `error` {@link FormulaResult} at this boundary. Unexpected
 * exceptions thrown from the host are surfaced as `argument-error`.
 *
 * @example
 * ```ts
 * const host: FormulaHost = {
 *   readNumber: (id) => values.get(id) ?? { kind: 'unresolved-ref', message: `${id} missing`, ref: id },
 * }
 * const result = evaluate(parseFormula('=A1+B1'), host)
 * ```
 */
declare function evaluate(ast: Ast, host: FormulaHost): FormulaResult;
/**
 * Build a {@link FormulaAdapter} bound to a specific graph, workbook,
 * and sheet.
 *
 * @param graph - The causl graph that will own the derived nodes.
 * @param options - Workbook/sheet identifiers and the cell-ref resolver.
 * @returns A {@link FormulaAdapter} ready to register parsed formulas.
 *
 * @example
 * ```ts
 * const adapter = createFormulaAdapter(graph, {
 *   workbook: 'wb1',
 *   sheet: 'Sheet1',
 *   resolve: (ref) => cellsByA1.get(cellRefToA1(ref)),
 * })
 * adapter.registerFormula({ col: 2, row: 0 }, parseFormula('=A1+B1'))
 * ```
 *
 * @see {@link FormulaResult}
 * @see {@link evaluate}
 */
declare function createFormulaAdapter(graph: Graph, options: FormulaAdapterOptions): FormulaAdapter;

/**
 * Construct a successful numeric {@link FormulaResult}.
 *
 * @param value - Numeric value produced by the evaluator.
 * @returns Result with `kind: 'value'`.
 */
declare const ok: (value: number) => FormulaResult;
/**
 * Construct an error {@link FormulaResult} from a fully built
 * {@link FormulaError} variant.
 *
 * @remarks
 * Preferred constructor for variants that require extra fields beyond
 * `kind` and `message` — `unresolved-ref`, `non-numeric`, and
 * `propagated`. Building the variant object explicitly forces every
 * required field (the `ref` on the reference variants, the `cause` on
 * `propagated`) to be present at the call site, surfacing missing
 * data as a compile error rather than as a silent runtime hole.
 *
 * @param error - The {@link FormulaError} to wrap in an `error`
 *   {@link FormulaResult}.
 * @returns Result with `kind: 'error'` carrying `error`.
 */
declare const errResult: (error: FormulaError) => FormulaResult;
/**
 * Convenience constructor for an error {@link FormulaResult} restricted
 * to the no-extra-field error variants.
 *
 * @remarks
 * Variants requiring extra fields beyond `kind`/`message`
 * (`unresolved-ref`, `non-numeric`, `propagated`) cannot be expressed
 * through this helper without losing the type-level guarantee that
 * those fields are present. Callers needing those variants must build
 * the {@link FormulaError} object directly and use {@link errResult}.
 *
 * @param kind - One of the no-extra-field error tags.
 * @param message - Human-readable description for diagnostics.
 * @param ref - Optional A1 reference for the `div-by-zero` variant
 *   only; `unknown-function`/`argument-error` shapes do not carry one
 *   and the parameter is ignored for those tags.
 * @returns Result with `kind: 'error'` carrying a {@link FormulaError}.
 */
declare const err: (kind: "div-by-zero" | "unknown-function" | "argument-error", message: string, ref?: string) => FormulaResult;
/**
 * Walk a {@link FormulaError} chain and return the originating
 * non-`propagated` variant.
 *
 * @remarks
 * Diagnostics — error reporters, devtool overlays, tests — frequently
 * want to know where a failure actually started, not the relay hop
 * that surfaced it. The walk is bounded by the depth of the dependency
 * chain that produced the error, which is itself bounded by the cycle
 * detector, so unbounded recursion is not representable here.
 *
 * @param error - Any {@link FormulaError}, possibly wrapped in any
 *   number of `propagated` layers.
 * @returns The deepest non-`propagated` variant reachable through
 *   `cause`. If `error` is itself non-`propagated`, it is returned
 *   unchanged.
 */
declare function rootCause(error: FormulaError): FormulaError;
/**
 * Extract a numeric value from a {@link FormulaResult}, falling back
 * to a caller-supplied default when the result is an error.
 *
 * @remarks
 * Convenient for tests that exercise success paths and treat errors
 * as out-of-scope.
 *
 * @param result - Result to inspect.
 * @param fallback - Number returned when `result.kind === 'error'`.
 * @returns Either `result.value` or `fallback`.
 */
declare function valueOr(result: FormulaResult, fallback: number): number;

/**
 * @packageDocumentation
 *
 * Static cycle detection over the formula dependency graph. The engine
 * itself catches cycles at the first commit that closes one and emits a
 * structured error naming the cycle path; that runtime guarantee is the
 * baseline, with static cycle detection treated as a stretch goal at the
 * engine layer. Formula edges happen to be derivable from the AST, so
 * this module performs a pre-flight DFS at registration time — before
 * the formula is ever handed to the engine — letting host applications
 * reject a doomed formula before it would otherwise advance graph time.
 * The graph is a simple adjacency map keyed by A1-style reference
 * strings, with ranges materialised into individual cell refs so
 * `SUM(A1:A3)` participates correctly in cycle search.
 */

/**
 * Collect every cell reference an AST touches statically.
 *
 * @remarks
 * Range nodes are expanded via {@link expandRange} so each cell inside
 * `A1:B5` is reported individually. Numeric literals and unknown node
 * shapes contribute no references.
 *
 * @param ast - Parsed formula AST to inspect.
 * @returns Flat list of {@link CellRef} values, in encounter order
 *   (left-to-right, depth-first).
 */
declare function staticReferences(ast: Ast): CellRef[];
/**
 * Adjacency-list representation of a formula dependency graph.
 *
 * @remarks
 * Edges are directed from a target cell to each cell it reads.
 * Reference keys are the A1 string produced by {@link refKey}.
 */
interface FormulaGraph {
    /** Adjacency: refKey → set of refKeys it depends on. */
    readonly deps: Map<string, Set<string>>;
}
/**
 * Construct a fresh, empty {@link FormulaGraph}.
 *
 * @returns A graph with no nodes or edges.
 */
declare function emptyFormulaGraph(): FormulaGraph;
/**
 * Canonical string key for a {@link CellRef}.
 *
 * @remarks
 * The key is the A1 form (`{ col: 0, row: 0 }` becomes `"A1"`), which
 * keeps debug output readable and matches the engine's identifier
 * scheme.
 *
 * @param ref - Cell reference to encode.
 * @returns A1-style reference string.
 */
declare function refKey(ref: CellRef): string;
/**
 * Register or replace the dependency edges for a single target cell.
 *
 * @remarks
 * Existing edges for `target` are overwritten — call this once per
 * registration so the graph reflects the current formula text.
 *
 * @param g - Graph to mutate in place.
 * @param target - Cell whose formula is being recorded.
 * @param formula - Parsed formula AST whose static refs become edges.
 */
declare function addFormula(g: FormulaGraph, target: CellRef, formula: Ast): void;
/**
 * Search the graph for a directed cycle and return its path.
 *
 * @remarks
 * Implements the classic three-colour DFS: `visited` records nodes
 * that have ever been entered, `onStack` (paired with the explicit
 * `stack` array) tracks the current recursion path, and a back-edge
 * to a node currently on the stack signals a cycle. The returned path
 * starts and ends at the same node so callers can render it as
 * `A1 → B2 → A1`.
 *
 * @param g - Graph produced by {@link addFormula}.
 * @returns Cycle path as A1 keys, or `null` when the graph is acyclic.
 */
declare function detectCycle(g: FormulaGraph): readonly string[] | null;

/**
 * @packageDocumentation
 *
 * Public barrel for `@causl/formula`. Re-exports the formula
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

/**
 * Package version string.
 *
 * @remarks
 * Bumped manually on release; kept in sync with `package.json`.
 */
declare const VERSION = "0.1.0";

export { type Ast, type BinOp, type Cell, type CellId, type CellNode, type CellRef, type CellValue, FORMULA_IR_VERSION, type FormulaAdapter, type FormulaAdapterOptions, type FormulaError, type FormulaErrorKind, type FormulaGraph, type FormulaHost, FormulaParseError, type FormulaResult, type Sheet, type SheetId, VERSION, type Workbook, type WorkbookId, a1ToCellRef, addFormula, cellId, cellRefToA1, createFormulaAdapter, detectCycle, emptyCell, emptyFormulaGraph, emptySheet, emptyWorkbook, evaluate, expandRange, formulaCell, err as formulaError, errResult as formulaErrorResult, ok as formulaOk, rootCause as formulaRootCause, literalCell, parseFormula, refKey, staticReferences, valueOr };
