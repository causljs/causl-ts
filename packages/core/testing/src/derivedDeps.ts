/**
 * derivedDeps — test-only accessor for the live `deps` Set the engine
 * stores on a derived's internal `DerivedEntry`.
 *
 * Returns the engine's own Set instance (not a clone). `setDeps` swaps
 * the reference on every dep-shift rather than mutating in place, so a
 * captured value is the structurally-correct snapshot of the read-set
 * at capture time — the load-bearing invariant for #703 Win 3 (the
 * audit's "skip the `new Set(e.deps)` clone in derivedRollback"
 * optimisation rides on it).
 *
 * Usage (property-test only):
 *
 *   import { derivedDeps } from '@causl/core/testing'
 *
 *   const g = createCausl()
 *   const a = g.input('a', 1)
 *   const b = g.derived('b', (get) => get(a) + 1)
 *   const captured = derivedDeps(g, 'b')!
 *   g.commit('bump', (tx) => tx.set(a, 2))
 *   // captured is the *prior* set; setDeps swapped, did not mutate.
 *   expect(captured.has('a')).toBe(true)
 *
 * Adapter code has no production use for this hook — it sits behind
 * the testing seam because engine-internal `deps` storage is not a
 * contract surface.
 */

import type { Graph, NodeId } from '@causl/core'
import { lookupTestingDispatch } from '../../src/testing-dispatch.js'

/**
 * Returns the live `deps` Set for the derived registered under `id`,
 * or `null` if no derived entry exists for that id (input nodes,
 * unregistered ids, disposed ids all return `null`).
 *
 * @param graph - The handle returned by `createCausl`.
 * @param id - The id of the derived whose deps are inspected.
 * @returns The engine's `deps` Set instance, or `null`.
 * @throws Error when `graph` was not produced by `createCausl`.
 */
export function derivedDeps(graph: Graph, id: NodeId): ReadonlySet<NodeId> | null {
  return lookupTestingDispatch(graph).derivedDeps(id)
}
