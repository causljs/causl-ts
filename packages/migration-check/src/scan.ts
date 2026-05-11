/**
 * IR-driven scanner for drift patterns (#161).
 *
 * Strategy: parse each source file with the TypeScript compiler API
 * to build a real AST, then run per-rule predicates against the AST.
 * Each predicate emits findings tagged with a stable RULE_ID and
 * severity from the catalogue (`docs/migration/RULE_CATALOGUE.md`).
 *
 * Why AST over regex: a regex on source text is defeated by aliases
 * (`import { atom as a } from 'jotai'`), block comments, JSX spread,
 * and minified code; the catalogue's contract is "every drift rule
 * has a stable predicate", and stability requires structural pattern
 * matching, not text matching.
 *
 * Comment-only rules (S-09 codemod marker) deliberately keep a
 * source-text scan because TypeScript discards comments from the
 * AST node graph; the source-text path uses the parsed
 * `SourceFile` so positions are accurate.
 */

import ts from 'typescript'

import type { RuleId, Severity } from './catalogue.js'
import type { DriftCategory, DriftFinding } from './ir.js'

/**
 * Per-rule context passed to every predicate. Pre-computed once per
 * file so predicates can do AST traversal without re-parsing.
 */
interface ScanContext {
  readonly file: string
  readonly source: string
  readonly sourceFile: ts.SourceFile
  /**
   * Set of local names imported from each source module. Filled
   * during a single AST pre-pass so per-rule predicates can resolve
   * aliases (`import { atom as a } from 'jotai'` → predicate sees
   * `a` is the local name for jotai's `atom`).
   */
  readonly imports: ImportIndex
}

/**
 * `module → exportedName → Set<localName>` index built from a
 * file's `ImportDeclaration` nodes. Captures both named and
 * namespace imports so predicates can resolve calls back to their
 * library origin.
 */
interface ImportIndex {
  readonly named: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  /** Namespaces, e.g. `import * as mobx from 'mobx'` → `mobx → {mobx}`. */
  readonly namespaces: ReadonlyMap<string, ReadonlySet<string>>
  /** Default imports, e.g. `import jotai from 'jotai'`. */
  readonly defaults: ReadonlyMap<string, ReadonlySet<string>>
}

/** Wire-up between a rule and its category for back-compat reporting. */
const RULE_TO_CATEGORY: Readonly<Record<RuleId, DriftCategory>> = {
  'J-01': 'jotai-import',
  'J-02': 'jotai-import',
  'J-03': 'jotai-hook',
  'J-04': 'jotai-hook',
  'J-05': 'jotai-hook',
  'J-06': 'jotai-hook',
  'J-07': 'jotai-hook',
  'J-08': 'jotai-import',
  'J-09': 'jotai-hook',
  'M-01': 'mobx-import',
  'M-02': 'mobx-import',
  'M-03': 'mobx-import',
  'M-04': 'mobx-import',
  'M-05': 'mobx-import',
  'M-06': 'mobx-import',
  'R-01': 'redux-import',
  'R-02': 'redux-hook',
  'R-03': 'redux-hook',
  'R-04': 'redux-import',
  'R-05': 'redux-import',
  'R-06': 'redux-import',
  'S-01': 'sequential-dispatch',
  'S-02': 'cross-source',
  'S-03': 'cross-source',
  'S-04': 'cross-source',
  'S-05': 'cross-source',
  'S-06': 'cross-source',
  'S-07': 'cross-source',
  'S-08': 'cross-source',
  'S-09': 'cross-source',
}

/** Severity per rule id, mirrored from catalogue. Cached locally for speed. */
const RULE_SEVERITY: Readonly<Record<RuleId, Severity>> = {
  'J-01': 'critical',
  'J-02': 'critical',
  'J-03': 'critical',
  'J-04': 'important',
  'J-05': 'critical',
  'J-06': 'critical',
  'J-07': 'important',
  'J-08': 'important',
  'J-09': 'nice-to-have',
  'M-01': 'critical',
  'M-02': 'critical',
  'M-03': 'critical',
  'M-04': 'important',
  'M-05': 'important',
  'M-06': 'nice-to-have',
  'R-01': 'critical',
  'R-02': 'critical',
  'R-03': 'critical',
  'R-04': 'important',
  'R-05': 'important',
  'R-06': 'nice-to-have',
  'S-01': 'critical',
  'S-02': 'critical',
  'S-03': 'critical',
  'S-04': 'important',
  'S-05': 'important',
  'S-06': 'important',
  'S-07': 'important',
  'S-08': 'nice-to-have',
  'S-09': 'critical',
}

/** Public entry point — tokenises a single file into findings. */
export function scanFile(file: string, source: string): DriftFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') || file.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  )

  const ctx: ScanContext = {
    file,
    source,
    sourceFile,
    imports: buildImportIndex(sourceFile),
  }

  const findings: DriftFinding[] = []
  const emitAt = (ruleId: RuleId, pos: number, token: string, suggestion: string): void => {
    const severity = RULE_SEVERITY[ruleId] ?? 'critical'
    const category = RULE_TO_CATEGORY[ruleId] ?? 'cross-source'
    const { line, column } = positionOf(sourceFile, pos)
    findings.push({
      ruleId,
      severity,
      category,
      file,
      line,
      column,
      token,
      suggestion,
    })
  }
  const emit: Emitter = (ruleId, node, token, suggestion) => {
    emitAt(ruleId, node.pos, token, suggestion)
  }

  // Walk every node once; per-rule predicates inspect kinds they
  // care about. A single pass is cheaper than 30 passes; the
  // dispatch table keeps individual rules readable.
  const visit = (node: ts.Node): void => {
    detectJotaiRules(ctx, node, emit)
    detectMobxRules(ctx, node, emit)
    detectReduxRules(ctx, node, emit)
    detectCrossRules(ctx, node, emit)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  // S-09: comment markers — TS strips comments from the AST node
  // graph, so we run a tokeniser-driven pass for those.
  detectCodemodComments(ctx, emitAt)

  // Stable order: by line, then column, then ruleId.
  findings.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    return a.ruleId.localeCompare(b.ruleId)
  })

  return findings
}

// ---------------------------------------------------------------------------
// Import index — single AST pre-pass.
// ---------------------------------------------------------------------------

function buildImportIndex(sf: ts.SourceFile): ImportIndex {
  const named = new Map<string, Map<string, Set<string>>>()
  const namespaces = new Map<string, Set<string>>()
  const defaults = new Map<string, Set<string>>()

  const addNamed = (mod: string, exported: string, local: string): void => {
    const perMod = named.get(mod) ?? new Map<string, Set<string>>()
    const set = perMod.get(exported) ?? new Set<string>()
    set.add(local)
    perMod.set(exported, set)
    named.set(mod, perMod)
  }
  const addNamespace = (mod: string, local: string): void => {
    const set = namespaces.get(mod) ?? new Set<string>()
    set.add(local)
    namespaces.set(mod, set)
  }
  const addDefault = (mod: string, local: string): void => {
    const set = defaults.get(mod) ?? new Set<string>()
    set.add(local)
    defaults.set(mod, set)
  }

  for (const stmt of sf.statements) {
    // ESM `import` declarations.
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
      const mod = stmt.moduleSpecifier.text
      const clause = stmt.importClause
      if (!clause) continue

      if (clause.name) {
        // `import jotai from 'jotai'`
        addDefault(mod, clause.name.text)
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          addNamespace(mod, clause.namedBindings.name.text)
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const elem of clause.namedBindings.elements) {
            const exported = elem.propertyName?.text ?? elem.name.text
            const local = elem.name.text
            addNamed(mod, exported, local)
          }
        }
      }
      continue
    }

    // CJS `require()` declarations — needed so the catalogue's
    // language-level predicate contract continues to fire on `.cjs`
    // source (#242). Two forms covered, each populating the same
    // `ImportIndex` the ESM path uses, so per-rule predicates need
    // no awareness of the module format:
    //
    //   const { createSlice } = require('@reduxjs/toolkit')
    //   const mobx = require('mobx')
    //
    // Renamed binding (`const { atom: a } = require('jotai')`) is
    // honoured via the `propertyName` path. Anything more exotic —
    // dynamic `require`, `require(...).x`, mutable rebinding — is
    // out of scope for v0; the rule predicates already rely on
    // statically-resolvable bindings.
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue
        const required = extractRequireTarget(decl.initializer)
        if (required === null) continue
        if (ts.isIdentifier(decl.name)) {
          // `const x = require('mod')` — namespace-shaped binding.
          addNamespace(required, decl.name.text)
        } else if (ts.isObjectBindingPattern(decl.name)) {
          for (const elem of decl.name.elements) {
            if (!ts.isIdentifier(elem.name)) continue
            const local = elem.name.text
            const exported =
              elem.propertyName && ts.isIdentifier(elem.propertyName)
                ? elem.propertyName.text
                : local
            addNamed(required, exported, local)
          }
        }
      }
    }
  }
  return { named, namespaces, defaults }
}

/**
 * Returns the module specifier of a `require('...')` call, or null
 * if the expression is not a static `require()` call. Handles the
 * common `require('mod')` shape; anything dynamic returns null.
 */
function extractRequireTarget(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'require') {
    return null
  }
  if (expr.arguments.length !== 1) return null
  const arg = expr.arguments[0]
  if (arg && ts.isStringLiteral(arg)) return arg.text
  return null
}

/** True if `name` is a local alias for `module`'s `exported` symbol. */
function isAliasOf(
  imports: ImportIndex,
  module: string,
  exported: string,
  name: string,
): boolean {
  return imports.named.get(module)?.get(exported)?.has(name) === true
}

/** True if any of the given local-name → exported pairs match. */
function importedFrom(
  imports: ImportIndex,
  module: string,
  exported: string,
): boolean {
  return (imports.named.get(module)?.get(exported)?.size ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Position helper.
// ---------------------------------------------------------------------------

function positionOf(
  sf: ts.SourceFile,
  pos: number,
): { line: number; column: number } {
  // Node.pos points at the start of leading trivia (whitespace +
  // comments). Walk forward past whitespace so the user-facing
  // line/column lands on the first significant token.
  const text = sf.text
  let p = pos < 0 ? 0 : Math.min(pos, text.length)
  while (p < text.length) {
    const ch = text.charCodeAt(p)
    // space, tab, vertical tab, form feed, NBSP
    if (ch === 0x20 || ch === 0x09 || ch === 0x0b || ch === 0x0c || ch === 0xa0) {
      p++
      continue
    }
    if (ch === 0x0a || ch === 0x0d) {
      p++
      continue
    }
    break
  }
  const lc = sf.getLineAndCharacterOfPosition(p)
  return { line: lc.line + 1, column: lc.character + 1 }
}

// ---------------------------------------------------------------------------
// Jotai rules J-NN.
// ---------------------------------------------------------------------------

type Emitter = (
  ruleId: RuleId,
  node: ts.Node,
  token: string,
  suggestion: string,
) => void

function detectJotaiRules(ctx: ScanContext, node: ts.Node, emit: Emitter): void {
  // J-01 / J-02: atom() with non-function vs function arg.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text
    if (isAliasOf(ctx.imports, 'jotai', 'atom', name)) {
      const arg = node.arguments[0]
      const isFn =
        arg !== undefined &&
        (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
      if (isFn) {
        emit('J-02', node, name, 'Replace derived atom with graph.derived(id, compute).')
      } else {
        emit('J-01', node, name, 'Replace input atom with graph.input(id, initial).')
      }
      return
    }
    // J-03: atomFamily call.
    if (isAliasOf(ctx.imports, 'jotai', 'atomFamily', name)) {
      emit('J-03', node, name, 'Replace atomFamily with useCauslFamily (Adoption Epic A).')
      return
    }
    if (isAliasOf(ctx.imports, 'jotai/utils', 'atomFamily', name)) {
      emit('J-03', node, name, 'Replace atomFamily with useCauslFamily (Adoption Epic A).')
      return
    }
    // J-04: atomWithStorage.
    if (
      isAliasOf(ctx.imports, 'jotai', 'atomWithStorage', name) ||
      isAliasOf(ctx.imports, 'jotai/utils', 'atomWithStorage', name)
    ) {
      emit('J-04', node, name, 'Replace atomWithStorage with persistedInput(graph, key, initial, opts).')
      return
    }
    // J-05 / J-06: hook calls.
    if (isAliasOf(ctx.imports, 'jotai', 'useAtomValue', name)) {
      emit('J-05', node, name, 'Replace useAtomValue with useCausl((g) => g.read(node)).')
      return
    }
    if (isAliasOf(ctx.imports, 'jotai', 'useSetAtom', name)) {
      emit('J-06', node, name, 'Replace useSetAtom with typed useDispatch<Msg>().')
      return
    }
    // J-07: loadable.
    if (
      isAliasOf(ctx.imports, 'jotai', 'loadable', name) ||
      isAliasOf(ctx.imports, 'jotai/utils', 'loadable', name)
    ) {
      emit('J-07', node, name, 'Replace loadable with useCauslSuspense or useCausl with tag narrowing.')
      return
    }
  }

  // J-08: <Provider> JSX from jotai.
  if (
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    ts.isIdentifier(node.tagName) &&
    isAliasOf(ctx.imports, 'jotai', 'Provider', node.tagName.text)
  ) {
    emit(
      'J-08',
      node,
      node.tagName.text,
      'Replace <Provider> with <CauslProvider graph={...} update={...}>.',
    )
    return
  }

  // J-09: useSetAtom captured outside a component (ref appears
  // inside a non-component arrow assigned to a top-level binding).
  // Heuristic: a CallExpression of the local-name-for-useSetAtom
  // whose return is bound to a module-scope `const`.
  if (
    ts.isVariableStatement(node) &&
    !hasReactComponentAncestor(node) &&
    ts.isSourceFile(node.parent)
  ) {
    for (const decl of node.declarationList.declarations) {
      if (!decl.initializer) continue
      const init = decl.initializer
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        isAliasOf(ctx.imports, 'jotai', 'useSetAtom', init.expression.text)
      ) {
        emit(
          'J-09',
          decl,
          init.expression.text,
          'useSetAtom result captured outside a component — re-bind per-render via useDispatch().',
        )
      }
    }
  }
}

/**
 * Cheap heuristic for "are we inside a React component". A real
 * implementation would resolve types; for J-09 we only need to know
 * whether the binding is at module scope.
 */
function hasReactComponentAncestor(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return true
    }
    cur = cur.parent
  }
  return false
}

// ---------------------------------------------------------------------------
// MobX rules M-NN.
// ---------------------------------------------------------------------------

function detectMobxRules(ctx: ScanContext, node: ts.Node, emit: Emitter): void {
  // M-01: makeAutoObservable(this) call.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    isAliasOf(ctx.imports, 'mobx', 'makeAutoObservable', node.expression.text)
  ) {
    emit(
      'M-01',
      node,
      'makeAutoObservable',
      'Replace makeAutoObservable with explicit graph.input/derived registrations.',
    )
    return
  }

  // M-02: computed(...) call OR @computed decorator.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    isAliasOf(ctx.imports, 'mobx', 'computed', node.expression.text)
  ) {
    emit('M-02', node, 'computed', 'Replace computed(...) with graph.derived.')
    return
  }
  if (ts.isDecorator(node)) {
    const name = decoratorIdentifier(node)
    if (name && isAliasOf(ctx.imports, 'mobx', 'computed', name)) {
      emit('M-02', node, '@computed', 'Replace @computed getter with graph.derived.')
      return
    }
    if (name && isAliasOf(ctx.imports, 'mobx', 'observable', name)) {
      emit('M-03', node, '@observable', 'Replace @observable field with graph.input.')
      return
    }
    if (name && isAliasOf(ctx.imports, 'mobx-react', 'observer', name)) {
      // @observer decorator — surfaces as M-... we keep a back-compat
      // category but tag under J-08-equivalent? Not in catalogue;
      // surface as none of the catalogue rules but keep coarse
      // category for v0 dashboards. (Intentionally not emitted —
      // observer() is not in the catalogue.)
    }
  }

  // M-04: runInAction(() => { x; y; })
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    isAliasOf(ctx.imports, 'mobx', 'runInAction', node.expression.text)
  ) {
    const arg = node.arguments[0]
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
      const body = arg.body
      const assigns = ts.isBlock(body)
        ? body.statements.filter((s) => isAssignmentStatement(s)).length
        : 0
      if (assigns >= 2) {
        emit(
          'M-04',
          node,
          'runInAction',
          'Replace runInAction with a single graph.commit(intent, tx => { ... }).',
        )
        return
      }
    }
  }

  // M-05 / M-06: reaction / autorun calls.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const n = node.expression.text
    if (isAliasOf(ctx.imports, 'mobx', 'reaction', n)) {
      emit('M-05', node, 'reaction', 'Replace reaction with graph.subscribe(node, observer).')
      return
    }
    if (isAliasOf(ctx.imports, 'mobx', 'autorun', n)) {
      emit('M-06', node, 'autorun', 'Replace autorun with graph.subscribe or a derived node observed once.')
      return
    }
  }
}

function decoratorIdentifier(d: ts.Decorator): string | undefined {
  const expr = d.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text
  }
  return undefined
}

function isAssignmentStatement(node: ts.Node): boolean {
  if (!ts.isExpressionStatement(node)) return false
  return (
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
}

// ---------------------------------------------------------------------------
// Redux rules R-NN.
// ---------------------------------------------------------------------------

function detectReduxRules(ctx: ScanContext, node: ts.Node, emit: Emitter): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const n = node.expression.text
    if (isAliasOf(ctx.imports, '@reduxjs/toolkit', 'createSlice', n)) {
      emit('R-01', node, 'createSlice', 'Replace createSlice with a typed Msg union and update : Msg → Model → Commit.')
      return
    }
    if (isAliasOf(ctx.imports, 'react-redux', 'useSelector', n)) {
      emit('R-02', node, 'useSelector', 'Replace useSelector with useCausl((g) => g.read(node)).')
      return
    }
    if (isAliasOf(ctx.imports, 'react-redux', 'useDispatch', n)) {
      emit('R-03', node, 'useDispatch', 'Replace useDispatch with typed useDispatch<Msg>() from @causl/react.')
      return
    }
    if (isAliasOf(ctx.imports, '@reduxjs/toolkit', 'createAsyncThunk', n)) {
      emit('R-04', node, 'createAsyncThunk', 'Replace createAsyncThunk with @causl/sync resource(graph, key, loader).')
      return
    }
    if (
      isAliasOf(ctx.imports, '@reduxjs/toolkit', 'createSelector', n) ||
      isAliasOf(ctx.imports, 'reselect', 'createSelector', n)
    ) {
      emit('R-05', node, 'createSelector', 'Replace createSelector with graph.derived (engine memoizes by default).')
      return
    }
  }

  // R-06: extraReducers builder w/ addCase pending. Detect via
  // PropertyAssignment named `extraReducers` whose builder body
  // calls `.addCase(thunk.pending, ...)`.
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'extraReducers') {
    const text = node.getText(ctx.sourceFile)
    if (/\.addCase\(\s*[\w.]+\.pending\b/.test(text)) {
      emit('R-06', node, 'extraReducers', 'Replace extraReducers pending|fulfilled|rejected with resource state-tag narrowing.')
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-source rules S-NN.
// ---------------------------------------------------------------------------

function detectCrossRules(ctx: ScanContext, node: ts.Node, emit: Emitter): void {
  // S-01: two or more sequential setX(...); setY(...); calls in the
  // same Block, where the calls' callees come from a useState
  // setter naming pattern (`setIdent`). Heuristic but effective.
  if (ts.isBlock(node)) {
    const setters: ts.ExpressionStatement[] = []
    for (const stmt of node.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        ts.isIdentifier(stmt.expression.expression) &&
        /^set[A-Z]/.test(stmt.expression.expression.text)
      ) {
        setters.push(stmt)
      } else {
        if (setters.length >= 2) {
          emit(
            'S-01',
            setters[0]!,
            'sequential setters',
            'Multiple sequential setters — wrap in a single graph.commit(intent, tx => { ... }).',
          )
        }
        setters.length = 0
      }
    }
    if (setters.length >= 2) {
      emit(
        'S-01',
        setters[0]!,
        'sequential setters',
        'Multiple sequential setters — wrap in a single graph.commit(intent, tx => { ... }).',
      )
    }
  }

  // S-02: `update` function that returns its `graph` argument.
  // Detect: a FunctionDeclaration / ArrowFunction named `update`
  // (or annotated `Update<...>`) whose return statement returns the
  // first parameter.
  if (
    (ts.isFunctionDeclaration(node) ||
      (ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)))) &&
    isUpdateFunction(node)
  ) {
    const fn = ts.isFunctionDeclaration(node)
      ? node
      : (node.initializer as ts.ArrowFunction | ts.FunctionExpression)
    const firstParam = fn.parameters[0]
    if (firstParam && ts.isIdentifier(firstParam.name)) {
      const paramName = firstParam.name.text
      const body = fn.body
      if (body && ts.isBlock(body)) {
        for (const s of body.statements) {
          if (
            ts.isReturnStatement(s) &&
            s.expression &&
            ts.isIdentifier(s.expression) &&
            s.expression.text === paramName
          ) {
            emit('S-02', s, 'update returns graph', 'update must return a Commit (new model), not the graph argument.')
          }
        }
      } else if (body && !ts.isBlock(body) && ts.isIdentifier(body) && body.text === paramName) {
        emit('S-02', fn, 'update returns graph', 'update must return a Commit (new model), not the graph argument.')
      }
    }
  }

  // S-03: g.read(...) inside a commit callback's tx => { ... } body.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'commit'
  ) {
    const cb = node.arguments[1] ?? node.arguments[0]
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.body) {
      const txParam = cb.parameters[0]
      const txName =
        txParam && ts.isIdentifier(txParam.name) ? txParam.name.text : undefined
      if (txName) {
        const visit = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === 'read'
          ) {
            const obj = n.expression.expression
            if (ts.isIdentifier(obj) && obj.text !== txName) {
              emit(
                'S-03',
                n,
                'g.read inside commit',
                "Use tx.get inside commit's tx callback — g.read sees pre-commit values.",
              )
            }
          }
          ts.forEachChild(n, visit)
        }
        ts.forEachChild(cb.body, visit)
      }
    }
  }

  // S-04: useEffect cascade — useEffect whose body sets a causl
  // input AND whose deps include a causl read.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'useEffect'
  ) {
    const deps = node.arguments[1]
    const body = node.arguments[0]
    if (
      deps &&
      ts.isArrayLiteralExpression(deps) &&
      deps.elements.length > 0 &&
      body &&
      (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
    ) {
      const text = body.getText(ctx.sourceFile)
      if (/\b(graph|g)\.commit\b|\bdispatch\(/.test(text)) {
        emit(
          'S-04',
          node,
          'useEffect cascade',
          'A useEffect that reads then writes a causl node is a derived in disguise — lift it.',
        )
      }
    }
  }

  // S-05: a `dispatch` reference (top-level or stable) used inside
  // a closure passed to setTimeout/setInterval/Promise.then where
  // the dispatch was captured *outside* the closure's defining
  // function. Heuristic: a CallExpression of an Identifier `dispatch`
  // inside a setTimeout/Promise.then callback declared outside any
  // useCallback/useEffect.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'setTimeout' ||
      node.expression.text === 'setInterval')
  ) {
    const cb = node.arguments[0]
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.body) {
      const text = cb.body.getText(ctx.sourceFile)
      if (/\bdispatch\(/.test(text) && !inHookCallback(node)) {
        emit('S-05', node, 'stale-closure dispatch', 'Re-bind dispatch via useDispatch each render — the captured one will be stale.')
      }
    }
  }

  // S-06: dispatch('foo') or dispatch({ type: 'foo' }) without a
  // discriminated-union type. We surface every call-site of a
  // `dispatch` identifier whose argument is a string literal or an
  // object literal with a string-typed `type` property; the Msg
  // type isn't visible without a TypeChecker, so we emit a
  // nice-to-have-style hint at `important` severity.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'dispatch') {
    const arg = node.arguments[0]
    if (arg && ts.isStringLiteral(arg)) {
      emit('S-06', node, 'untyped dispatch', "dispatch('foo') is untyped — use a discriminated Msg union.")
    } else if (arg && ts.isObjectLiteralExpression(arg)) {
      // dispatch({ type: 'foo' }) without a `satisfies Msg` annotation we can see —
      // detect string-only `type` property.
      for (const p of arg.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'type' &&
          ts.isStringLiteral(p.initializer) &&
          arg.properties.length === 1
        ) {
          emit('S-06', node, 'untyped dispatch', "dispatch({ type: 'foo' }) is untyped — use a discriminated Msg union.")
        }
      }
    }
  }

  // S-07: useState whose result is destructured and exported, or
  // returned from a function whose name is exported (a strong
  // proxy for "shared via context or prop-drilling"). Conservative.
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    ts.isCallExpression(node.initializer) &&
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === 'useState' &&
    isExportedFromEnclosingFunction(node, ctx.sourceFile)
  ) {
    emit('S-07', node, 'shared useState', 'A useState shared across components belongs in graph.input.')
  }

  // S-08: imports of phantom symbols. Catalogue lists
  // useCauslSuspense, persistedInput, useCauslFamily as the
  // common ones. We only flag them when imported from a causl
  // package whose adoption epic hasn't shipped — currently we surface
  // useCauslSuspense and persistedInput unconditionally.
  if (ts.isSourceFile(node)) {
    const phantoms = ['useCauslSuspense', 'persistedInput']
    for (const phantom of phantoms) {
      if (
        importedFrom(ctx.imports, '@causl/react', phantom) ||
        importedFrom(ctx.imports, '@causl/persistence', phantom) ||
        importedFrom(ctx.imports, '@causl/core', phantom)
      ) {
        emit('S-08', node, phantom, `${phantom} is a phantom symbol — its Adoption epic has not shipped.`)
      }
    }
  }
}

function isUpdateFunction(
  node: ts.FunctionDeclaration | ts.VariableDeclaration,
): boolean {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text === 'update'
  }
  // VariableDeclaration: name === 'update' OR type annotation Update<...>.
  if (ts.isIdentifier(node.name) && node.name.text === 'update') return true
  const typeAnn = node.type
  if (typeAnn && ts.isTypeReferenceNode(typeAnn) && ts.isIdentifier(typeAnn.typeName)) {
    return typeAnn.typeName.text === 'Update'
  }
  return false
}

function inHookCallback(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      ts.isIdentifier(cur.expression) &&
      (cur.expression.text === 'useCallback' ||
        cur.expression.text === 'useEffect' ||
        cur.expression.text === 'useMemo')
    ) {
      return true
    }
    cur = cur.parent
  }
  return false
}

function isExportedFromEnclosingFunction(
  node: ts.Node,
  sf: ts.SourceFile,
): boolean {
  // Walk up to the *immediate* enclosing function declaration or
  // module-scope `const fn = (...) => {}`. If that container is
  // exported (either via an `export` modifier or via a trailing
  // `export { name }`), we treat the inner useState as shared.
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isFunctionDeclaration(cur)) {
      const mods = ts.getModifiers(cur)
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true
      const name = cur.name?.text
      if (name && namedExports(sf).has(name)) return true
      return false
    }
    // Module-scope `const useShared = () => { ... }` (or function
    // expression). Only consider VariableStatements whose parent is
    // the SourceFile — inner `const`s are skipped.
    if (
      ts.isVariableStatement(cur) &&
      ts.isSourceFile(cur.parent) &&
      cur.declarationList.declarations.some(
        (d) =>
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer)),
      )
    ) {
      const mods = ts.getModifiers(cur)
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true
      const exports = namedExports(sf)
      for (const decl of cur.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && exports.has(decl.name.text)) return true
      }
      return false
    }
    cur = cur.parent
  }
  return false
}

function namedExports(sf: ts.SourceFile): Set<string> {
  const set = new Set<string>()
  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const e of stmt.exportClause.elements) set.add(e.name.text)
    }
  }
  return set
}

// ---------------------------------------------------------------------------
// S-09 — codemod-style transformation comments.
// ---------------------------------------------------------------------------

const CODEMOD_MARKERS = [
  /TODO\(causl-migrate\)/,
  /TODO\(causl\)/,
  /FIXME\(causl-migrate\)/,
] as const

function detectCodemodComments(
  ctx: ScanContext,
  emitAt: (ruleId: RuleId, pos: number, token: string, suggestion: string) => void,
): void {
  const text = ctx.source
  for (const marker of CODEMOD_MARKERS) {
    const re = new RegExp(marker.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      emitAt(
        'S-09',
        m.index,
        m[0],
        'Codemod-style marker — finish the manual migration step before merging.',
      )
    }
  }
}
