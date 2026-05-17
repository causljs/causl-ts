/**
 * recomputeCounter — instrument a derived `compute` function.
 *
 * Returns a `wrap` helper that wraps user `Compute<T>` functions and
 * counts invocations. Lets tests assert the engine's correctness
 * criterion that *a commit producing N derived recomputations should
 * run in O(N) time, not O(graph size)* — dirty marking and dependency
 * walking are bounded by the affected subgraph. That's a correctness
 * criterion, not a benchmark, so we measure it structurally by counting
 * recomputes against a fixture rather than measuring wall-clock time.
 *
 * Why not patch the engine directly? Two reasons. (1) The canonical
 * core API (`createCausl`, `input`, `derived`, `commit`, `read`,
 * `subscribe`, `explain`) is the load-bearing surface defended on every
 * PR review; it does not grow casually, and we are not adding
 * `__onCompute` to the public surface for a test concern. (2) Wrapping
 * the user's `compute` is exactly the correct boundary — it counts
 * what the engine *asks the user* to recompute, which is the unit the
 * O(|affected|) correctness criterion talks about.
 *
 * Usage:
 *
 *   import { recomputeCounter } from '@causljs/core/testing'
 *
 *   const counter = recomputeCounter()
 *   const sum = graph.derived('sum', counter.wrap(get => get(a) + get(b)))
 *   // ... commits happen ...
 *   expect(counter.count('sum')).toBe(1)        // one specific node
 *   expect(counter.total()).toBe(3)             // all instrumented computes
 *   counter.reset()
 */

import type { Compute, Node } from '@causljs/core'

export interface RecomputeCounter {
  /**
   * Wrap a user-supplied `Compute<T>` so each invocation is counted
   * against the supplied label (defaults to the next-derived index when
   * omitted). The returned function preserves the input's signature so
   * the engine sees no behavioural difference.
   */
  wrap<T>(compute: Compute<T>, label?: string): Compute<T>

  /** Count of recomputes for a labelled compute. Unknown label returns 0. */
  count(label: string): number

  /** Sum of every counted recompute since the last `reset`. */
  total(): number

  /**
   * Number of recomputes for a node, when the wrap was given a stable
   * label matching `node.id`. Convenience for the common pattern of
   * `counter.wrap(fn, node.id)` then `counter.byNode(node)`.
   */
  byNode<T>(node: Node<T>): number

  /** Zero every counter. Does not affect the engine. */
  reset(): void

  /**
   * Snapshot the current counts as a frozen record. Useful for
   * `expect(counter.snapshot()).toMatchInlineSnapshot(...)` patterns.
   */
  snapshot(): Readonly<Record<string, number>>
}

export function recomputeCounter(): RecomputeCounter {
  const counts = new Map<string, number>()
  let nextIdx = 0

  const counter: RecomputeCounter = {
    wrap<T>(compute: Compute<T>, label?: string): Compute<T> {
      const lbl = label ?? `__anon_${nextIdx++}`
      // Initialise to zero so the label appears in `snapshot()` even if
      // the engine never invokes the compute.
      if (!counts.has(lbl)) counts.set(lbl, 0)
      return (get) => {
        counts.set(lbl, (counts.get(lbl) ?? 0) + 1)
        return compute(get)
      }
    },

    count(label: string): number {
      return counts.get(label) ?? 0
    },

    total(): number {
      let n = 0
      for (const c of counts.values()) n += c
      return n
    },

    byNode<T>(node: Node<T>): number {
      return counts.get(node.id) ?? 0
    },

    reset(): void {
      for (const k of counts.keys()) counts.set(k, 0)
      nextIdx = 0
    },

    snapshot(): Readonly<Record<string, number>> {
      return Object.freeze(Object.fromEntries(counts))
    },
  }

  return counter
}
