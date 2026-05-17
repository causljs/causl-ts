// src/ir.ts
var FORMULA_IR_VERSION = "0.1.0";

// src/grammar.ts
function cellRefToA1(ref) {
  return colToLetters(ref.col) + String(ref.row + 1);
}
function a1ToCellRef(a1) {
  const m = /^([A-Z]+)([0-9]+)$/.exec(a1.toUpperCase());
  if (!m) throw new Error(`Invalid A1 reference: ${a1}`);
  const letters = m[1];
  const digits = m[2];
  const col = lettersToCol(letters);
  const row = Number(digits) - 1;
  if (row < 0 || !Number.isInteger(row)) {
    throw new Error(`Invalid A1 row in: ${a1}`);
  }
  return { col, row };
}
function colToLetters(col) {
  if (col < 0 || !Number.isInteger(col)) {
    throw new Error(`Invalid column index: ${col}`);
  }
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + n % 26) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
function lettersToCol(letters) {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}
function expandRange(from, to) {
  const c0 = Math.min(from.col, to.col);
  const c1 = Math.max(from.col, to.col);
  const r0 = Math.min(from.row, to.row);
  const r1 = Math.max(from.row, to.row);
  const out = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      out.push({ col: c, row: r });
    }
  }
  return out;
}

// src/parser.ts
var FormulaParseError = class extends Error {
  /**
   * @param message - Human-readable description of the failure.
   * @param position - Byte offset within the parser body at which the
   *   error occurred (zero-based).
   */
  constructor(message, position) {
    super(`${message} at position ${position}`);
    this.position = position;
  }
  position;
  name = "FormulaParseError";
};
function parseFormula(text) {
  const trimmed = text.trim();
  const body = trimmed.startsWith("=") ? trimmed.slice(1) : trimmed;
  const p = new Parser(body);
  const ast = p.parseExpression();
  p.expectEnd();
  return ast;
}
var Parser = class {
  /**
   * @param src - Body string with the leading `=` already removed.
   */
  constructor(src) {
    this.src = src;
  }
  src;
  pos = 0;
  // --- Precedence level: expression (additive) ---
  /**
   * Parse an additive expression: one or more terms separated by `+` or
   * `-`. Left-associative, lowest precedence.
   *
   * @returns The AST for the parsed expression.
   * @throws {@link FormulaParseError} if a term is malformed.
   */
  parseExpression() {
    let left = this.parseTerm();
    for (; ; ) {
      this.skipWs();
      const ch = this.peek();
      if (ch === "+" || ch === "-") {
        this.pos += 1;
        const right = this.parseTerm();
        left = { type: "binop", op: ch, left, right };
      } else {
        return left;
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
  parseTerm() {
    let left = this.parseFactor();
    for (; ; ) {
      this.skipWs();
      const ch = this.peek();
      if (ch === "*" || ch === "/") {
        this.pos += 1;
        const right = this.parseFactor();
        left = { type: "binop", op: ch, left, right };
      } else {
        return left;
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
  parseFactor() {
    this.skipWs();
    const ch = this.peek();
    if (ch === void 0) {
      throw new FormulaParseError("Unexpected end of input", this.pos);
    }
    if (ch === "-") {
      this.pos += 1;
      return { type: "unary", op: "-", operand: this.parseFactor() };
    }
    if (ch === "(") {
      this.pos += 1;
      const inner = this.parseExpression();
      this.skipWs();
      if (this.peek() !== ")") {
        throw new FormulaParseError("Expected )", this.pos);
      }
      this.pos += 1;
      return inner;
    }
    if (this.isDigit(ch) || ch === ".") {
      return this.parseNumber();
    }
    if (this.isLetter(ch)) {
      return this.parseLetterPrefixed();
    }
    throw new FormulaParseError(`Unexpected character '${ch}'`, this.pos);
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
  parseNumber() {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch && (this.isDigit(ch) || ch === ".")) this.pos += 1;
      else break;
    }
    const token = this.src.slice(start, this.pos);
    const value = Number(token);
    if (Number.isNaN(value)) {
      throw new FormulaParseError(`Invalid number "${token}"`, start);
    }
    return { type: "num", value };
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
  parseLetterPrefixed() {
    const start = this.pos;
    let letters = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch && this.isLetter(ch)) {
        letters += ch;
        this.pos += 1;
      } else break;
    }
    let digits = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch && this.isDigit(ch)) {
        digits += ch;
        this.pos += 1;
      } else break;
    }
    if (digits.length > 0) {
      const a1 = letters + digits;
      const from = a1ToCellRef(a1);
      this.skipWs();
      if (this.peek() === ":") {
        this.pos += 1;
        this.skipWs();
        const toLetters = this.readLetters();
        const toDigits = this.readDigits();
        if (toLetters.length === 0 || toDigits.length === 0) {
          throw new FormulaParseError("Invalid range upper bound", this.pos);
        }
        const to = a1ToCellRef(toLetters + toDigits);
        return { type: "range", from, to };
      }
      return { type: "cell", ref: from };
    }
    if (letters.length === 0) {
      throw new FormulaParseError("Expected identifier", start);
    }
    this.skipWs();
    if (this.peek() === "(") {
      this.pos += 1;
      const args = this.parseArgList();
      if (this.peek() !== ")") {
        throw new FormulaParseError("Expected ) after function args", this.pos);
      }
      this.pos += 1;
      return { type: "call", name: letters.toUpperCase(), args };
    }
    throw new FormulaParseError(`Bare identifier "${letters}" is not allowed`, start);
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
  parseArgList() {
    this.skipWs();
    if (this.peek() === ")") return [];
    const args = [this.parseExpression()];
    for (; ; ) {
      this.skipWs();
      if (this.peek() === ",") {
        this.pos += 1;
        args.push(this.parseExpression());
      } else return args;
    }
  }
  /**
   * Read a contiguous run of letters, advancing the cursor.
   *
   * @returns The captured letters; empty string if the cursor is not
   *   on a letter.
   */
  readLetters() {
    let s = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch && this.isLetter(ch)) {
        s += ch;
        this.pos += 1;
      } else break;
    }
    return s;
  }
  /**
   * Read a contiguous run of digits, advancing the cursor.
   *
   * @returns The captured digits; empty string if the cursor is not on
   *   a digit.
   */
  readDigits() {
    let s = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch && this.isDigit(ch)) {
        s += ch;
        this.pos += 1;
      } else break;
    }
    return s;
  }
  /**
   * Assert that the parser has consumed the entire input.
   *
   * @throws {@link FormulaParseError} when any non-whitespace remains
   *   after the parsed expression.
   */
  expectEnd() {
    this.skipWs();
    if (this.pos !== this.src.length) {
      throw new FormulaParseError(`Unexpected '${this.src.slice(this.pos)}'`, this.pos);
    }
  }
  /**
   * Look at the current character without advancing.
   *
   * @returns The character at the cursor, or `undefined` past end of
   *   input.
   */
  peek() {
    return this.src[this.pos];
  }
  /**
   * Advance the cursor over any inline whitespace (space and tab).
   *
   * @remarks
   * Newlines are not part of the formula grammar; encountering one
   * surfaces as an "Unexpected character" error in the calling parse
   * method rather than being silently swallowed here.
   */
  skipWs() {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === " " || ch === "	") this.pos += 1;
      else break;
    }
  }
  /**
   * Test whether `ch` is an ASCII digit.
   *
   * @param ch - Single character.
   * @returns `true` for `'0'` through `'9'`.
   */
  isDigit(ch) {
    return ch >= "0" && ch <= "9";
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
  isLetter(ch) {
    const u = ch.toUpperCase();
    return u >= "A" && u <= "Z";
  }
};

// src/model.ts
function cellId(workbook, sheet, ref) {
  return `cell:${workbook}:${sheet}:${cellRefToA1(ref)}`;
}
function emptyCell(ref) {
  return { ref, value: { state: "empty" } };
}
function literalCell(ref, value) {
  return { ref, value: { state: "literal", value } };
}
function formulaCell(ref, text, ast) {
  return { ref, value: { state: "formula", text, ast } };
}
function emptySheet(id) {
  return { id, cells: /* @__PURE__ */ new Map() };
}
function emptyWorkbook(id) {
  return { id, sheets: /* @__PURE__ */ new Map() };
}

// src/adapter.ts
import { assertNever as assertNever2 } from "@causl/core/internal";

// src/result.ts
import { assertNever } from "@causl/core/internal";
var ok = (value) => ({ kind: "value", value });
var errResult = (error) => ({
  kind: "error",
  error
});
var err = (kind, message, ref) => {
  switch (kind) {
    case "div-by-zero":
      return errResult(
        ref !== void 0 ? { kind: "div-by-zero", message, ref } : { kind: "div-by-zero", message }
      );
    case "unknown-function":
      return errResult({ kind: "unknown-function", message });
    case "argument-error":
      return errResult({ kind: "argument-error", message });
    default:
      return assertNever(kind, "unhandled FormulaError kind in err()");
  }
};
function rootCause(error) {
  let current = error;
  while (current.kind === "propagated") current = current.cause;
  return current;
}
function valueOr(result, fallback) {
  return result.kind === "value" ? result.value : fallback;
}

// src/adapter.ts
var EvalError = class extends Error {
  /**
   * @param result - The tagged {@link FormulaResult} to surface to the
   *   evaluation boundary. The `Error.message` is filled from the
   *   carried error for compatibility with default error reporters.
   */
  constructor(result) {
    super(result.kind === "error" ? result.error.message : "unexpected");
    this.result = result;
  }
  result;
};
function evaluate(ast, host) {
  try {
    return ok(evalNode(ast, host));
  } catch (e) {
    if (e instanceof EvalError) return e.result;
    const message = e instanceof Error ? e.message : String(e);
    return err("argument-error", message);
  }
}
function createFormulaAdapter(graph, options) {
  const registeredIds = /* @__PURE__ */ new Set();
  const compute = (ast) => {
    return (get) => evaluate(ast, makeGraphHost(options.resolve, get));
  };
  return {
    registerFormula(ref, ast) {
      const id = cellId(options.workbook, options.sheet, ref);
      registeredIds.add(id);
      return graph.derived(id, compute(ast));
    },
    registered() {
      return Array.from(registeredIds);
    }
  };
}
function makeGraphHost(resolve, get) {
  return {
    readNumber(cellLabel) {
      const ref = a1ToCellRef(cellLabel);
      const node = resolve(ref);
      if (!node) {
        return {
          kind: "unresolved-ref",
          message: `Unresolved cell reference ${cellLabel}`,
          ref: cellLabel
        };
      }
      return coerceCellValue(get(node), cellLabel);
    }
  };
}
function evalNode(ast, host) {
  switch (ast.type) {
    case "num":
      return ast.value;
    case "cell": {
      const refLabel = cellRefToA1(ast.ref);
      return readOrThrow(host, refLabel);
    }
    case "range": {
      let sum = 0;
      for (const ref of expandRange(ast.from, ast.to)) {
        sum += rangeReadOrThrow(host, cellRefToA1(ref));
      }
      return sum;
    }
    case "binop": {
      const l = evalNode(ast.left, host);
      const r = evalNode(ast.right, host);
      switch (ast.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0) {
            throw new EvalError(err("div-by-zero", "Division by zero"));
          }
          return l / r;
        default:
          return assertNever2(ast, "unhandled binop");
      }
    }
    case "unary":
      return -evalNode(ast.operand, host);
    case "call":
      return evaluateCall(ast.name, ast.args, host);
    default:
      return assertNever2(ast, "unhandled AST node");
  }
}
function evaluateCall(name, args, host) {
  switch (name) {
    case "SUM": {
      let sum = 0;
      for (const arg of args) sum += sumArg(arg, host);
      return sum;
    }
    case "AVG":
    case "AVERAGE": {
      let total = 0;
      let count = 0;
      for (const arg of args) {
        const [s, n] = sumAndCount(arg, host);
        total += s;
        count += n;
      }
      if (count === 0) {
        throw new EvalError(
          err("argument-error", `${name}() requires at least one numeric argument`)
        );
      }
      return total / count;
    }
    case "MIN":
    case "MAX": {
      const values = collectValues(args, host);
      if (values.length === 0) {
        throw new EvalError(
          err("argument-error", `${name}() requires at least one numeric argument`)
        );
      }
      const cmp = name === "MIN" ? Math.min : Math.max;
      return values.reduce((acc, v) => cmp(acc, v), values[0]);
    }
    default:
      throw new EvalError(err("unknown-function", `Unknown function: ${name}`));
  }
}
function sumArg(arg, host) {
  if (arg.type === "range") {
    let s = 0;
    for (const ref of expandRange(arg.from, arg.to)) {
      s += rangeReadOrThrow(host, cellRefToA1(ref));
    }
    return s;
  }
  return evalNode(arg, host);
}
function sumAndCount(arg, host) {
  if (arg.type === "range") {
    let s = 0;
    let n = 0;
    for (const ref of expandRange(arg.from, arg.to)) {
      const refLabel = cellRefToA1(ref);
      const read = host.readNumber(refLabel);
      if (typeof read === "number") {
        s += read;
        n += 1;
        continue;
      }
      if (read.kind === "unresolved-ref") continue;
      throw new EvalError(errResult(read));
    }
    return [s, n];
  }
  return [evalNode(arg, host), 1];
}
function collectValues(args, host) {
  const out = [];
  for (const arg of args) {
    if (arg.type === "range") {
      for (const ref of expandRange(arg.from, arg.to)) {
        const refLabel = cellRefToA1(ref);
        const read = host.readNumber(refLabel);
        if (typeof read === "number") {
          out.push(read);
          continue;
        }
        if (read.kind === "unresolved-ref") continue;
        throw new EvalError(errResult(read));
      }
    } else {
      out.push(evalNode(arg, host));
    }
  }
  return out;
}
function readOrThrow(host, refLabel) {
  const read = host.readNumber(refLabel);
  if (typeof read === "number") return read;
  throw new EvalError(errResult(read));
}
function rangeReadOrThrow(host, refLabel) {
  const read = host.readNumber(refLabel);
  if (typeof read === "number") return read;
  if (read.kind === "unresolved-ref") return 0;
  throw new EvalError(errResult(read));
}
function coerceCellValue(value, refLabel) {
  if (typeof value === "number") return value;
  if (value === null || value === void 0) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (value.trim() === "") return 0;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return {
      kind: "non-numeric",
      message: `Cell ${refLabel} has non-numeric value: ${value}`,
      ref: refLabel
    };
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    const tagged = value;
    if (tagged.kind === "value" && typeof tagged.value === "number") {
      return tagged.value;
    }
    if (tagged.kind === "error" && tagged.error) {
      const cause = tagged.error;
      const causeRef = cause.kind === "unknown-function" || cause.kind === "argument-error" ? void 0 : cause.ref;
      return causeRef !== void 0 ? { kind: "propagated", message: cause.message, cause, ref: causeRef } : { kind: "propagated", message: cause.message, cause };
    }
  }
  return {
    kind: "non-numeric",
    message: `Cell ${refLabel} has unsupported value type`,
    ref: refLabel
  };
}

// src/cycle.ts
import { assertNever as assertNever3 } from "@causl/core/internal";
function staticReferences(ast) {
  const out = [];
  function walk(node) {
    switch (node.type) {
      case "num":
        return;
      case "cell":
        out.push(node.ref);
        return;
      case "range":
        for (const ref of expandRange(node.from, node.to)) out.push(ref);
        return;
      case "binop":
        walk(node.left);
        walk(node.right);
        return;
      case "unary":
        walk(node.operand);
        return;
      case "call":
        for (const a of node.args) walk(a);
        return;
      default:
        return assertNever3(node, "unhandled AST node in staticReferences");
    }
  }
  walk(ast);
  return out;
}
function emptyFormulaGraph() {
  return { deps: /* @__PURE__ */ new Map() };
}
function refKey(ref) {
  return cellRefToA1(ref);
}
function addFormula(g, target, formula) {
  const targetKey = refKey(target);
  const deps = /* @__PURE__ */ new Set();
  for (const r of staticReferences(formula)) deps.add(refKey(r));
  g.deps.set(targetKey, deps);
}
function detectCycle(g) {
  const visited = /* @__PURE__ */ new Set();
  const stack = [];
  const onStack = /* @__PURE__ */ new Set();
  function dfs(node) {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    const deps = g.deps.get(node);
    if (deps) {
      for (const dep of deps) {
        if (!visited.has(dep)) {
          const found = dfs(dep);
          if (found) return found;
        } else if (onStack.has(dep)) {
          const idx = stack.indexOf(dep);
          if (idx >= 0) return [...stack.slice(idx), dep];
        }
      }
    }
    stack.pop();
    onStack.delete(node);
    return null;
  }
  for (const node of g.deps.keys()) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

// src/index.ts
var VERSION = "0.1.0";
export {
  FORMULA_IR_VERSION,
  FormulaParseError,
  VERSION,
  a1ToCellRef,
  addFormula,
  cellId,
  cellRefToA1,
  createFormulaAdapter,
  detectCycle,
  emptyCell,
  emptyFormulaGraph,
  emptySheet,
  emptyWorkbook,
  evaluate,
  expandRange,
  formulaCell,
  err as formulaError,
  errResult as formulaErrorResult,
  ok as formulaOk,
  rootCause as formulaRootCause,
  literalCell,
  parseFormula,
  refKey,
  staticReferences,
  valueOr
};
