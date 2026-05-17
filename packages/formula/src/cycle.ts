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

import { assertNever } from '@causljs/core/internal'
import { cellRefToA1, expandRange } from './grammar.js'
import type { Ast, CellRef } from './ir.js'

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
export function staticReferences(ast: Ast): CellRef[] {
  const out: CellRef[] = []
  /**
   * Recursive AST visitor that pushes referenced cells into the
   * enclosing `out` list.
   *
   * @param node - Subtree under examination.
   */
  function walk(node: Ast): void {
    switch (node.type) {
      case 'num':
        return
      case 'cell':
        out.push(node.ref)
        return
      case 'range':
        for (const ref of expandRange(node.from, node.to)) out.push(ref)
        return
      case 'binop':
        walk(node.left)
        walk(node.right)
        return
      case 'unary':
        walk(node.operand)
        return
      case 'call':
        for (const a of node.args) walk(a)
        return
      default:
        return assertNever(node, 'unhandled AST node in staticReferences')
    }
  }
  walk(ast)
  return out
}

/**
 * Adjacency-list representation of a formula dependency graph.
 *
 * @remarks
 * Edges are directed from a target cell to each cell it reads.
 * Reference keys are the A1 string produced by {@link refKey}.
 */
export interface FormulaGraph {
  /** Adjacency: refKey → set of refKeys it depends on. */
  readonly deps: Map<string, Set<string>>
}

/**
 * Construct a fresh, empty {@link FormulaGraph}.
 *
 * @returns A graph with no nodes or edges.
 */
export function emptyFormulaGraph(): FormulaGraph {
  return { deps: new Map() }
}

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
export function refKey(ref: CellRef): string {
  return cellRefToA1(ref)
}

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
export function addFormula(g: FormulaGraph, target: CellRef, formula: Ast): void {
  const targetKey = refKey(target)
  const deps = new Set<string>()
  for (const r of staticReferences(formula)) deps.add(refKey(r))
  g.deps.set(targetKey, deps)
}

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
export function detectCycle(g: FormulaGraph): readonly string[] | null {
  // Three-colour bookkeeping: `visited` is the union of grey + black
  // nodes; `onStack` plus `stack` together represent the grey set
  // (currently in the active DFS path).
  const visited = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  /**
   * Depth-first traversal from a single seed node.
   *
   * @param node - Reference key currently being explored.
   * @returns Cycle path when a back-edge is found, otherwise `null`.
   */
  function dfs(node: string): readonly string[] | null {
    visited.add(node)
    stack.push(node)
    onStack.add(node)
    const deps = g.deps.get(node)
    if (deps) {
      // Walk each outgoing edge; recurse into unseen nodes, otherwise
      // check whether the neighbour is currently on the active path.
      for (const dep of deps) {
        if (!visited.has(dep)) {
          const found = dfs(dep)
          if (found) return found
        } else if (onStack.has(dep)) {
          // Found a back-edge to `dep` — extract the cycle by slicing
          // the path stack from its earlier appearance forward.
          const idx = stack.indexOf(dep)
          if (idx >= 0) return [...stack.slice(idx), dep]
        }
      }
    }
    // Backtrack: leaving this node turns it from grey to black.
    stack.pop()
    onStack.delete(node)
    return null
  }

  // Outer loop seeds DFS from every node so disconnected components
  // are also covered.
  for (const node of g.deps.keys()) {
    if (!visited.has(node)) {
      const cycle = dfs(node)
      if (cycle) return cycle
    }
  }
  return null
}
