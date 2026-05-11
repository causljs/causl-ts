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

// ---------------------------------------------------------------------------
// Grammar IR — parser output, evaluator input.
// Mirror of the original `grammar.ts` AST surface; the canonical
// definitions now live here and `grammar.ts` re-exports them for
// backwards compatibility with existing adopters.
// ---------------------------------------------------------------------------

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
export type Ast =
  | { type: 'num'; value: number }
  | { type: 'cell'; ref: CellRef }
  | { type: 'range'; from: CellRef; to: CellRef }
  | { type: 'binop'; op: BinOp; left: Ast; right: Ast }
  | { type: 'unary'; op: '-'; operand: Ast }
  | { type: 'call'; name: string; args: Ast[] }

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
export type BinOp = '+' | '-' | '*' | '/'

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
export interface CellRef {
  /** Column index, 0-based (A=0, B=1, …, Z=25, AA=26, AB=27, …). */
  readonly col: number
  /** Row index, 0-based (1 → 0, 2 → 1). */
  readonly row: number
}

// ---------------------------------------------------------------------------
// Result IR — evaluator output.
// Mirror of the original `result.ts` payload surface; the canonical
// definitions now live here and `result.ts` re-exports them along with
// the (behaviour-bearing) constructors and helpers.
// ---------------------------------------------------------------------------

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
export type FormulaResult =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'error'; readonly error: FormulaError }

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
export type FormulaErrorKind = FormulaError['kind']

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
export type FormulaError =
  | {
      readonly kind: 'div-by-zero'
      readonly message: string
      readonly ref?: string
    }
  | {
      readonly kind: 'unresolved-ref'
      readonly message: string
      readonly ref: string
    }
  | {
      readonly kind: 'non-numeric'
      readonly message: string
      readonly ref: string
    }
  | { readonly kind: 'unknown-function'; readonly message: string }
  | { readonly kind: 'argument-error'; readonly message: string }
  | {
      readonly kind: 'propagated'
      readonly message: string
      readonly cause: FormulaError
      readonly ref?: string
    }

// ---------------------------------------------------------------------------
// Version envelope — bumping this is a SPEC change.
// ---------------------------------------------------------------------------

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
export const FORMULA_IR_VERSION = '0.1.0'
