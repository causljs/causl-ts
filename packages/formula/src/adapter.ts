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

import type { Compute, DerivedNode, Graph, Node } from '@causl/core'
import { assertNever } from '@causl/core/internal'
import { a1ToCellRef, cellRefToA1, expandRange } from './grammar.js'
import type { Ast, CellRef, FormulaError, FormulaResult } from './ir.js'
import {
  cellId,
  type CellId,
  type SheetId,
  type WorkbookId,
} from './model.js'
import { err, errResult, ok } from './result.js'

/**
 * Convenience alias for an arbitrary causl graph node carrying an
 * unknown payload. Cell nodes registered through this adapter are erased
 * to `unknown` because the adapter accepts any upstream value type and
 * narrows it at read time via the host's {@link FormulaHost.readNumber}.
 */
export type CellNode = Node<unknown>

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
export interface FormulaHost {
  /**
   * Resolve and coerce the numeric value of a cell.
   *
   * @param cellId - A1 reference string identifying the cell.
   * @returns A finite `number` on success; otherwise a tagged
   *   {@link FormulaError} describing the failure.
   */
  readNumber(cellId: string): number | FormulaError
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
export interface FormulaAdapterOptions {
  /** Identifier of the workbook the registered cells belong to. */
  readonly workbook: WorkbookId
  /** Identifier of the sheet the registered cells belong to. */
  readonly sheet: SheetId
  /**
   * Lookup hook from a parsed cell reference to a registered graph node.
   *
   * @param ref - Column/row reference parsed from the formula source.
   * @returns The underlying {@link CellNode}, or `undefined` if no cell
   *   has been registered at that reference.
   */
  readonly resolve: (ref: CellRef) => CellNode | undefined
}

/**
 * Public surface of the adapter returned from {@link createFormulaAdapter}.
 *
 * @remarks
 * The adapter is stateful only in that it tracks the set of cell ids it
 * has registered with the underlying graph; the graph itself owns the
 * derived nodes once {@link FormulaAdapter.registerFormula} returns.
 */
export interface FormulaAdapter {
  /**
   * Register a formula AST as a derived node in the graph.
   *
   * @param ref - Cell reference at which the formula lives.
   * @param ast - Parsed formula expression.
   * @returns The derived node carrying the tagged {@link FormulaResult}.
   */
  registerFormula(ref: CellRef, ast: Ast): DerivedNode<FormulaResult>
  /**
   * Snapshot of every {@link CellId} registered through this adapter so
   * far, in insertion order. Useful for diagnostics and tests.
   */
  registered(): readonly CellId[]
}

/**
 * Internal sentinel exception used to short-circuit evaluation when a
 * structured {@link FormulaResult} error is discovered deep inside the
 * recursive evaluator.
 *
 * @remarks
 * Throwing escapes the recursion without threading an explicit result
 * through every helper; the outer {@link evaluate} boundary catches it
 * and surfaces the carried result. JavaScript's runtime exception
 * channel is the cleanest available unwind mechanism for the recursive
 * walk.
 */
class EvalError extends Error {
  /**
   * @param result - The tagged {@link FormulaResult} to surface to the
   *   evaluation boundary. The `Error.message` is filled from the
   *   carried error for compatibility with default error reporters.
   */
  constructor(public readonly result: FormulaResult) {
    super(result.kind === 'error' ? result.error.message : 'unexpected')
  }
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
export function evaluate(ast: Ast, host: FormulaHost): FormulaResult {
  try {
    return ok(evalNode(ast, host))
  } catch (e) {
    if (e instanceof EvalError) return e.result
    const message = e instanceof Error ? e.message : String(e)
    return err('argument-error', message)
  }
}

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
export function createFormulaAdapter(
  graph: Graph,
  options: FormulaAdapterOptions,
): FormulaAdapter {
  // Track every cell id we hand to the graph; exposed via `registered()`.
  const registeredIds = new Set<CellId>()

  // AST → derived compute factory. Each formula gets its own closure so
  // the AST is captured once and evaluated lazily on every `get` cycle.
  // The host is rebuilt per compute call so the engine-supplied `get`
  // hook records dynamic dependencies on the surrounding derived node.
  const compute = (ast: Ast): Compute<FormulaResult> => {
    return (get) => evaluate(ast, makeGraphHost(options.resolve, get))
  }

  return {
    registerFormula(ref, ast) {
      // Translate ref → stable CellId, remember the registration, and
      // delegate dependency tracking to the underlying graph.
      const id = cellId(options.workbook, options.sheet, ref)
      registeredIds.add(id)
      return graph.derived<FormulaResult>(id, compute(ast))
    },
    registered() {
      return Array.from(registeredIds)
    },
  }
}

/**
 * Construct a {@link FormulaHost} backed by a graph reader.
 *
 * @param resolve - Lookup from {@link CellRef} to a registered graph
 *   node, mirroring {@link FormulaAdapterOptions.resolve}.
 * @param get - Engine-supplied read function that records dynamic
 *   dependencies on the enclosing derived node.
 * @returns A host whose `readNumber(a1)` resolves the cell, reads its
 *   value through `get`, and coerces the result to a number or a
 *   tagged {@link FormulaError}.
 *
 * @remarks
 * The returned host is the bridge between the engine-bound compute
 * closure and the host-agnostic {@link evaluate} entry. Keeping the
 * binding local to this helper means {@link evaluate} stays free of
 * graph types and can be satisfied by a non-graph host in tests or
 * by the future Rust port.
 */
function makeGraphHost(
  resolve: (ref: CellRef) => CellNode | undefined,
  get: <U>(node: Node<U>) => U,
): FormulaHost {
  return {
    readNumber(cellLabel: string): number | FormulaError {
      // The evaluator hands the host A1 strings produced from parsed
      // CellRefs; the host translates back to the resolver's CellRef
      // form so the underlying graph lookup stays index-based.
      const ref = a1ToCellRef(cellLabel)
      const node = resolve(ref)
      if (!node) {
        return {
          kind: 'unresolved-ref',
          message: `Unresolved cell reference ${cellLabel}`,
          ref: cellLabel,
        }
      }
      // The host owns coercion AND upstream propagation: an upstream
      // formula that already errored is wrapped here in a `propagated`
      // envelope so the original chain survives the relay hop and the
      // evaluator can forward the host's FormulaError unchanged.
      return coerceCellValue(get(node), cellLabel)
    },
  }
}

/**
 * Recursively interpret an AST node against a {@link FormulaHost}.
 *
 * @param ast - The AST node currently being evaluated.
 * @param host - Host that resolves cell IDs to numbers or errors.
 * @returns The numeric value produced by the AST sub-tree.
 * @throws {@link EvalError} when a structured failure is encountered
 *   (unresolved ref outside a range, division by zero, non-numeric
 *   upstream value, propagated upstream error, unknown function,
 *   empty aggregation).
 */
function evalNode(ast: Ast, host: FormulaHost): number {
  // Discriminate on AST tag — the grammar guarantees one of these arms.
  switch (ast.type) {
    case 'num':
      return ast.value
    case 'cell': {
      // Direct cell reference: any host-reported error short-circuits.
      const refLabel = cellRefToA1(ast.ref)
      return readOrThrow(host, refLabel)
    }
    case 'range': {
      // Bare range outside a function call is treated as a sum;
      // missing cells are skipped silently to match common spreadsheets.
      let sum = 0
      for (const ref of expandRange(ast.from, ast.to)) {
        sum += rangeReadOrThrow(host, cellRefToA1(ref))
      }
      return sum
    }
    case 'binop': {
      // Binary arithmetic — evaluate both sides eagerly, then dispatch.
      const l = evalNode(ast.left, host)
      const r = evalNode(ast.right, host)
      switch (ast.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          // Divide-by-zero is a structured error rather than NaN/Infinity.
          if (r === 0) {
            throw new EvalError(err('div-by-zero', 'Division by zero'))
          }
          return l / r
        default:
          // After exhausting every BinOp value, TS narrows `ast`
          // itself to `never`; the cast is the explicit handoff to
          // the runtime guard.
          return assertNever(ast as never, 'unhandled binop')
      }
    }
    case 'unary':
      // Only unary minus is in the grammar today.
      return -evalNode(ast.operand, host)
    case 'call':
      // Function calls go through the named-call dispatcher.
      return evaluateCall(ast.name, ast.args, host)
    default:
      return assertNever(ast, 'unhandled AST node')
  }
}

/**
 * Dispatch a parsed function call to its built-in implementation.
 *
 * @param name - Upper-cased function name as parsed.
 * @param args - Argument expressions, possibly containing ranges.
 * @param host - Host through which cell values are read.
 * @returns The function's numeric result.
 * @throws {@link EvalError} for unknown functions, empty aggregations,
 *   or any structured error raised while evaluating arguments.
 *
 * @remarks
 * Built-ins implemented today: `SUM`, `AVG`/`AVERAGE`, `MIN`, `MAX`.
 * Range arguments are expanded by the helpers
 * {@link sumArg}/{@link sumAndCount}/{@link collectValues} so the
 * dispatcher does not need to special-case them.
 */
function evaluateCall(
  name: string,
  args: Ast[],
  host: FormulaHost,
): number {
  switch (name) {
    case 'SUM': {
      // SUM accepts mixed scalars and ranges; ranges are flattened.
      let sum = 0
      for (const arg of args) sum += sumArg(arg, host)
      return sum
    }
    case 'AVG':
    case 'AVERAGE': {
      // Averaging requires both a running total and a count of
      // contributing cells; ranges contribute one count per cell.
      let total = 0
      let count = 0
      for (const arg of args) {
        const [s, n] = sumAndCount(arg, host)
        total += s
        count += n
      }
      if (count === 0) {
        throw new EvalError(
          err('argument-error', `${name}() requires at least one numeric argument`),
        )
      }
      return total / count
    }
    case 'MIN':
    case 'MAX': {
      // MIN/MAX need every individual value, not a running aggregate.
      const values = collectValues(args, host)
      if (values.length === 0) {
        throw new EvalError(
          err('argument-error', `${name}() requires at least one numeric argument`),
        )
      }
      const cmp = name === 'MIN' ? Math.min : Math.max
      return values.reduce((acc, v) => cmp(acc, v), values[0]!)
    }
    default:
      throw new EvalError(err('unknown-function', `Unknown function: ${name}`))
  }
}

/**
 * Sum a single argument expression, flattening ranges and skipping
 * unresolved cells.
 *
 * @param arg - Argument AST; if it is a `range` node every cell inside
 *   the rectangle is read.
 * @param host - Host through which cell values are read.
 * @returns The argument's numeric contribution to the surrounding sum.
 */
function sumArg(arg: Ast, host: FormulaHost): number {
  if (arg.type === 'range') {
    let s = 0
    for (const ref of expandRange(arg.from, arg.to)) {
      s += rangeReadOrThrow(host, cellRefToA1(ref))
    }
    return s
  }
  return evalNode(arg, host)
}

/**
 * Sum a single argument expression and count its contributing cells.
 *
 * @param arg - Argument AST; ranges contribute one count per resolved
 *   cell, scalar expressions contribute exactly one count.
 * @param host - Host through which cell values are read.
 * @returns A `[sum, count]` tuple used by AVG/AVERAGE.
 */
function sumAndCount(arg: Ast, host: FormulaHost): [number, number] {
  if (arg.type === 'range') {
    let s = 0
    let n = 0
    for (const ref of expandRange(arg.from, arg.to)) {
      const refLabel = cellRefToA1(ref)
      const read = host.readNumber(refLabel)
      if (typeof read === 'number') {
        s += read
        n += 1
        continue
      }
      // unresolved cells skip in range aggregations; other errors propagate.
      if (read.kind === 'unresolved-ref') continue
      throw new EvalError(errResult(read))
    }
    return [s, n]
  }
  return [evalNode(arg, host), 1]
}

/**
 * Flatten every argument expression into a list of numeric values.
 *
 * @param args - Mixed scalar/range arguments.
 * @param host - Host through which cell values are read.
 * @returns A flat array used by {@link evaluateCall}'s MIN/MAX branches.
 */
function collectValues(args: Ast[], host: FormulaHost): number[] {
  const out: number[] = []
  for (const arg of args) {
    if (arg.type === 'range') {
      // Flatten the rectangle while preserving row-major order.
      for (const ref of expandRange(arg.from, arg.to)) {
        const refLabel = cellRefToA1(ref)
        const read = host.readNumber(refLabel)
        if (typeof read === 'number') {
          out.push(read)
          continue
        }
        if (read.kind === 'unresolved-ref') continue
        throw new EvalError(errResult(read))
      }
    } else {
      out.push(evalNode(arg, host))
    }
  }
  return out
}

/**
 * Read a cell via the host, returning the numeric value or short-
 * circuiting through an {@link EvalError} on any host-reported error.
 *
 * @param host - Evaluation host.
 * @param refLabel - A1 reference string passed to the host.
 * @returns The numeric value produced by the host.
 */
function readOrThrow(host: FormulaHost, refLabel: string): number {
  const read = host.readNumber(refLabel)
  if (typeof read === 'number') return read
  // The host owns error categorisation (unresolved / non-numeric /
  // propagated): the evaluator forwards the FormulaError unchanged so
  // a non-numeric raw value stays `non-numeric` and an upstream
  // formula error stays `propagated`.
  throw new EvalError(errResult(read))
}

/**
 * Like {@link readOrThrow} but treats `unresolved-ref` as a skip
 * (returning `0` so the caller's running sum is unaffected). Used by
 * bare-range evaluation.
 *
 * @param host - Evaluation host.
 * @param refLabel - A1 reference string passed to the host.
 * @returns The cell's contribution to the surrounding sum; `0` if the
 *   cell is unresolved.
 */
function rangeReadOrThrow(host: FormulaHost, refLabel: string): number {
  const read = host.readNumber(refLabel)
  if (typeof read === 'number') return read
  if (read.kind === 'unresolved-ref') return 0
  throw new EvalError(errResult(read))
}

/**
 * Coerce a raw cell value to a number or a tagged {@link FormulaError}.
 *
 * @param value - Raw value read from the upstream graph node. May be a
 *   primitive literal or a tagged {@link FormulaResult} from another
 *   formula cell.
 * @param refLabel - A1 reference string used purely for error
 *   diagnostics.
 * @returns Either the coerced numeric value or a {@link FormulaError}.
 *
 * @remarks
 * Coercion rules:
 *   - `number` is returned unchanged.
 *   - `null` / `undefined` / empty string become `0` (spreadsheet idiom).
 *   - `boolean` becomes `1` / `0`.
 *   - String literals parseable as finite numbers are accepted.
 *   - Tagged `{ kind: 'value', value }` results are unwrapped.
 *   - Tagged `{ kind: 'error' }` results return the upstream
 *     {@link FormulaError} unchanged — the evaluator wraps it in a
 *     `propagated` envelope at the relay hop via
 *     {@link propagatedFromHost}.
 *   - Anything else returns a `non-numeric` error.
 */
function coerceCellValue(
  value: unknown,
  refLabel: string,
): number | FormulaError {
  if (typeof value === 'number') return value
  if (value === null || value === undefined) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    if (value.trim() === '') return 0
    const n = Number(value)
    if (Number.isFinite(n)) return n
    return {
      kind: 'non-numeric',
      message: `Cell ${refLabel} has non-numeric value: ${value}`,
      ref: refLabel,
    }
  }
  // Tagged FormulaResult arriving from an upstream formula cell:
  // unwrap success values; wrap upstream errors in a `propagated`
  // envelope that carries the original chain forward so an N-hop
  // relay yields an N-deep `cause` chain that `rootCause` can walk.
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const tagged = value as Partial<FormulaResult>
    if (tagged.kind === 'value' && typeof tagged.value === 'number') {
      return tagged.value
    }
    if (tagged.kind === 'error' && tagged.error) {
      const cause = tagged.error
      // Variants without a `ref` field (`unknown-function`,
      // `argument-error`) propagate without one; the rest carry the
      // cause's ref forward. `exactOptionalPropertyTypes` requires
      // omitting the field rather than setting it to `undefined`.
      const causeRef =
        cause.kind === 'unknown-function' || cause.kind === 'argument-error'
          ? undefined
          : cause.ref
      return causeRef !== undefined
        ? { kind: 'propagated', message: cause.message, cause, ref: causeRef }
        : { kind: 'propagated', message: cause.message, cause }
    }
  }
  return {
    kind: 'non-numeric',
    message: `Cell ${refLabel} has unsupported value type`,
    ref: refLabel,
  }
}
