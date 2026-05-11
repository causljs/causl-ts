/**
 * Spreadsheet demo wiring for SPEC §11 — the engine is its own observer.
 *
 * I take the same 100-cell diamond the vitest acceptance suite already
 * exercises (`packages/formula/test/spreadsheetDemo.test.ts`) and lift it
 * into a developer-runnable page. Column A is plain `graph.input`s a user
 * can type into. Columns B / C / D and the terminal E1 are registered as
 * `liveDerived` derivations, each carrying a slot that holds the current
 * formula text. `replaceMany` rewires the closure inside every targeted
 * slot in a single commit, so downstream observers fire at most once
 * across the batch — the same atomicity guarantee any other commit gives.
 *
 * The demo deliberately does not invent a parallel devtools UI. The
 * grid renders by subscribing to each cell's node; the commit-log panel
 * renders against `commitLog(graph)` — itself a `DerivedNode<readonly
 * Commit[]>`; the "why did this update?" line reads `whyUpdated(graph,
 * cell)` — itself a `DerivedNode<WhyResult>`. Every observation a
 * developer wants is a read or subscribe through the public engine
 * surface ("the engine is its own observer", §11).
 */

import { createCausl } from '@causl/core'
import {
  cellId,
  parseFormula,
  valueOr,
  cellRefToA1,
  a1ToCellRef,
  expandRange,
  FormulaParseError,
} from '@causl/formula'
import {
  liveDerived,
  replaceMany,
  commitLog,
  whyUpdated,
  renderWhy,
} from '@causl/devtools'

// ---------------------------------------------------------------
// 1. Build the graph and the resolver shared across every cell.
// ---------------------------------------------------------------

const graph = createCausl()
const WORKBOOK = 'wb1'
const SHEET = 'Sheet1'

// Map from "col,row" → graph node so the formula evaluator can wire
// dependencies dynamically as it walks the AST.
const knownNodes = new Map()
const resolve = (ref) => knownNodes.get(`${ref.col},${ref.row}`)

// Column A: ten plain inputs. These hold raw numbers a user can type.
const aInputs = []
for (let i = 0; i < 10; i++) {
  const node = graph.input(cellId(WORKBOOK, SHEET, { col: 0, row: i }), i + 1)
  aInputs.push(node)
  knownNodes.set(`0,${i}`, node)
}

// ---------------------------------------------------------------
// 2. Formula evaluator — a stripped-down version of the package's
//    private `evaluate` so the closure I install via `liveDerived`
//    can re-parse and re-interpret the formula text on every read.
//    Returns `valueOr(result, fallback)`-style numbers; tagged
//    errors short-circuit through a sentinel exception.
// ---------------------------------------------------------------

class EvalErr extends Error {
  constructor(message) {
    super(message)
    this.name = 'EvalErr'
  }
}

function readNumber(value, ref) {
  if (typeof value === 'number') return value
  if (value === null || value === undefined) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const t = value.trim()
    if (t === '') return 0
    const n = Number(t)
    if (Number.isFinite(n)) return n
    throw new EvalErr(`${cellRefToA1(ref)} non-numeric: "${value}"`)
  }
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    if (value.kind === 'value' && typeof value.value === 'number') return value.value
    if (value.kind === 'error') throw new EvalErr(`${cellRefToA1(ref)} propagated: ${value.error?.message ?? 'error'}`)
  }
  throw new EvalErr(`${cellRefToA1(ref)} unsupported value`)
}

function evalAst(ast, get) {
  switch (ast.type) {
    case 'num':
      return ast.value
    case 'cell': {
      const node = resolve(ast.ref)
      if (!node) throw new EvalErr(`Unresolved cell ${cellRefToA1(ast.ref)}`)
      return readNumber(get(node), ast.ref)
    }
    case 'range': {
      let s = 0
      for (const ref of expandRange(ast.from, ast.to)) {
        const node = resolve(ref)
        if (!node) continue
        s += readNumber(get(node), ref)
      }
      return s
    }
    case 'binop': {
      const l = evalAst(ast.left, get)
      const r = evalAst(ast.right, get)
      switch (ast.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          if (r === 0) throw new EvalErr('Division by zero')
          return l / r
        default:
          throw new EvalErr(`Unhandled binop ${ast.op}`)
      }
    }
    case 'unary':
      return -evalAst(ast.operand, get)
    case 'call':
      return evalCall(ast.name, ast.args, get)
    default:
      throw new EvalErr(`Unhandled AST node ${ast.type}`)
  }
}

function evalCall(name, args, get) {
  switch (name) {
    case 'SUM': {
      let s = 0
      for (const a of args) {
        if (a.type === 'range') {
          for (const ref of expandRange(a.from, a.to)) {
            const node = resolve(ref)
            if (!node) continue
            s += readNumber(get(node), ref)
          }
        } else {
          s += evalAst(a, get)
        }
      }
      return s
    }
    case 'AVG':
    case 'AVERAGE': {
      let total = 0
      let count = 0
      for (const a of args) {
        if (a.type === 'range') {
          for (const ref of expandRange(a.from, a.to)) {
            const node = resolve(ref)
            if (!node) continue
            total += readNumber(get(node), ref)
            count += 1
          }
        } else {
          total += evalAst(a, get)
          count += 1
        }
      }
      if (count === 0) throw new EvalErr(`${name}() needs at least one numeric argument`)
      return total / count
    }
    case 'MIN':
    case 'MAX': {
      const vals = []
      for (const a of args) {
        if (a.type === 'range') {
          for (const ref of expandRange(a.from, a.to)) {
            const node = resolve(ref)
            if (!node) continue
            vals.push(readNumber(get(node), ref))
          }
        } else {
          vals.push(evalAst(a, get))
        }
      }
      if (vals.length === 0) throw new EvalErr(`${name}() needs at least one numeric argument`)
      return vals.reduce((acc, v) => (name === 'MIN' ? Math.min(acc, v) : Math.max(acc, v)), vals[0])
    }
    default:
      throw new EvalErr(`Unknown function ${name}`)
  }
}

/**
 * Build a `Compute<FormulaResult>`-shaped closure from a parsed AST.
 * Errors during evaluation are surfaced as the same tagged shape the
 * formula adapter would produce, so downstream cells can either unwrap
 * with `valueOr` or pattern-match on `kind: 'error'`.
 */
function computeFor(ast) {
  return (get) => {
    try {
      return { kind: 'value', value: evalAst(ast, get) }
    } catch (e) {
      return {
        kind: 'error',
        error: { kind: 'argument-error', message: e instanceof Error ? e.message : String(e) },
      }
    }
  }
}

// ---------------------------------------------------------------
// 3. Register columns B / C / D and E1 as live derivations.
//    Each cell carries its current formula source text so the
//    "Apply" button can re-render the dropdown options accurately.
// ---------------------------------------------------------------

const liveCells = new Map() // cellName ("B3", "E1") → { handle, ref, formula }

function registerLive(name, ref, formula) {
  const id = cellId(WORKBOOK, SHEET, ref)
  const ast = parseFormula(formula)
  const handle = liveDerived(graph, id, computeFor(ast))
  knownNodes.set(`${ref.col},${ref.row}`, handle.node)
  liveCells.set(name, { handle, ref, formula, name })
}

for (let i = 0; i < 10; i++) {
  registerLive(`B${i + 1}`, { col: 1, row: i }, `=A${i + 1}*2`)
}
for (let i = 0; i < 10; i++) {
  registerLive(`C${i + 1}`, { col: 2, row: i }, `=B${i + 1}+1`)
}
for (let i = 0; i < 10; i++) {
  registerLive(`D${i + 1}`, { col: 3, row: i }, `=C${i + 1}*B${i + 1}`)
}
registerLive('E1', { col: 4, row: 0 }, '=SUM(D1:D10)')

// ---------------------------------------------------------------
// 4. UI — render the grid, wire input editors, render commit log
//    and "why?" line. Every refresh comes from a graph subscription.
// ---------------------------------------------------------------

const gridEl = document.getElementById('grid')
const logEl = document.getElementById('log')
const whyEl = document.getElementById('why')
const errEl = document.getElementById('err')
const cellSelect = document.getElementById('cell-select')
const formulaTextarea = document.getElementById('formula')
const applyBtn = document.getElementById('apply')

function buildGrid() {
  const headers = ['', 'A', 'B', 'C', 'D', 'E']
  let html = '<thead><tr>'
  for (const h of headers) html += `<th>${h}</th>`
  html += '</tr></thead><tbody>'
  for (let r = 0; r < 10; r++) {
    html += `<tr><th>${r + 1}</th>`
    // Column A: editable input.
    html += `<td class="input"><input type="number" data-row="${r}" value="${r + 1}" /></td>`
    // Columns B..D: derived cells.
    for (const col of [1, 2, 3]) {
      const letter = ['B', 'C', 'D'][col - 1]
      html += `<td data-cell="${letter}${r + 1}">--</td>`
    }
    // Column E: only E1 is populated.
    if (r === 0) html += '<td data-cell="E1">--</td>'
    else html += '<td>&nbsp;</td>'
    html += '</tr>'
  }
  html += '</tbody>'
  gridEl.innerHTML = html

  for (const inputEl of gridEl.querySelectorAll('input[type="number"]')) {
    inputEl.addEventListener('change', (ev) => {
      const row = Number(ev.target.dataset.row)
      const next = Number(ev.target.value)
      if (!Number.isFinite(next)) return
      graph.commit(`A${row + 1}=${next}`, (tx) => tx.set(aInputs[row], next))
    })
  }
}

function flashCell(td) {
  td.classList.add('changed')
  setTimeout(() => td.classList.remove('changed'), 700)
}

function subscribeCellRender(name) {
  const td = gridEl.querySelector(`[data-cell="${name}"]`)
  if (!td) return
  const cell = liveCells.get(name)
  const render = (raw) => {
    const v = valueOr(raw, NaN)
    if (Number.isFinite(v)) {
      td.textContent = Number.isInteger(v) ? String(v) : v.toFixed(2)
    } else if (raw && raw.kind === 'error') {
      td.textContent = '#ERR'
      td.title = raw.error?.message ?? 'error'
    } else {
      td.textContent = '--'
    }
  }
  // Initial render uses graph.read; subsequent updates come from subscribe.
  render(graph.read(cell.handle.node))
  graph.subscribe(cell.handle.node, (raw) => {
    render(raw)
    flashCell(td)
  })
}

// ---------------------------------------------------------------
// 5. Commit log + whyUpdated panel.
// ---------------------------------------------------------------

// `commitLog` returns a `DerivedNode<readonly Commit[]>` per §11 —
// itself subscribable, capped to capacity, reverse-chronological.
// `whyUpdated` similarly returns a `DerivedNode<WhyResult>`.
const log = commitLog(graph, { capacity: 50 })

function renderLogAndWhy() {
  const entries = graph.read(log)
  if (entries.length === 0) {
    logEl.textContent = '(no commits yet)'
    whyEl.textContent = '(no commits yet)'
    return
  }
  logEl.textContent = entries
    .slice(0, 20)
    .map((c, i) => `#${entries.length - i}  t=${c.time}  intent="${c.intent}"  changed=[${c.changedNodes.join(', ')}]`)
    .join('\n')

  // Whichever cell is selected in the dropdown gets a fresh whyUpdated read.
  const selected = cellSelect.value
  const cell = liveCells.get(selected)
  if (cell) {
    const w = graph.read(whyUpdated(graph, cell.handle.node))
    whyEl.textContent = `${selected}: ${renderWhy(w)}`
  }
}

graph.subscribeCommits(() => renderLogAndWhy())

// ---------------------------------------------------------------
// 6. Apply button — the §11 act. Replace the live closure of the
//    selected cell, watch every downstream cell that depends on it
//    update inside a single commit. Uses replaceMany even for one
//    edit so the demo's call site matches the batched API.
// ---------------------------------------------------------------

function applyEdit() {
  errEl.textContent = ''
  const name = cellSelect.value
  const text = formulaTextarea.value
  const cell = liveCells.get(name)
  if (!cell) {
    errEl.textContent = `Unknown cell: ${name}`
    return
  }
  let ast
  try {
    ast = parseFormula(text)
  } catch (e) {
    errEl.textContent = e instanceof FormulaParseError ? `Parse error: ${e.message}` : String(e)
    return
  }
  replaceMany(graph, [{ handle: cell.handle, next: computeFor(ast) }])
  cell.formula = text
  refreshDropdown()
}

applyBtn.addEventListener('click', applyEdit)
formulaTextarea.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault()
    applyEdit()
  }
})

cellSelect.addEventListener('change', () => {
  const cell = liveCells.get(cellSelect.value)
  if (cell) formulaTextarea.value = cell.formula
  renderLogAndWhy()
})

function refreshDropdown() {
  for (const opt of cellSelect.options) {
    const cell = liveCells.get(opt.value)
    if (cell) opt.textContent = `${opt.value}  (currently ${cell.formula})`
  }
}

// ---------------------------------------------------------------
// 7. Boot.
// ---------------------------------------------------------------

buildGrid()
for (const name of liveCells.keys()) subscribeCellRender(name)
refreshDropdown()
formulaTextarea.value = liveCells.get(cellSelect.value).formula
renderLogAndWhy()

// Console-friendly handles. These are deliberate: a developer reading
// SPEC §11 should be able to open the console and exercise every
// primitive the spec promises without hunting for them.
window.demo = {
  graph,
  replaceMany,
  commitLog: log,
  whyUpdated: (cellName) => {
    const cell = liveCells.get(cellName)
    if (!cell) return null
    return graph.read(whyUpdated(graph, cell.handle.node))
  },
  cells: liveCells,
  inputs: aInputs,
  /**
   * Shorthand: re-parse a formula string and replace the closure for
   * the named cell in a single commit. Returns the new value.
   */
  edit: (name, formula) => {
    const cell = liveCells.get(name)
    if (!cell) throw new Error(`Unknown cell ${name}`)
    const ast = parseFormula(formula)
    replaceMany(graph, [{ handle: cell.handle, next: computeFor(ast) }])
    cell.formula = formula
    refreshDropdown()
    return graph.read(cell.handle.node)
  },
  // Cell-ref helpers re-exported so console exploration matches the demo.
  parseFormula,
  cellRefToA1,
  a1ToCellRef,
}
console.info(
  '[causl §11 demo] window.demo is wired. Try:\n' +
    '  demo.edit("E1", "=AVG(D1:D10)")\n' +
    '  demo.whyUpdated("E1")\n' +
    '  demo.graph.read(demo.commitLog).slice(0, 3)',
)
