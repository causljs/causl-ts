/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link FamilyFactory} — closes #257.
 *
 * The animating principle (SPEC §12.3) is "hand consumers the smallest
 * interface they need." A family factory exists to register a single
 * node per key; it has no business calling `commit`, `hydrate`,
 * `snapshot`, `exportModel`, or `subscribeCommits`. Today's `(graph:
 * Graph, key: string) => Node<T>` lets the factory reach for the full
 * engine surface — an authority leak that the type system can close
 * structurally rather than by hope.
 *
 * These assertions are type-level: the factory parameter must accept
 * the registration capability (`input`, `derived`) and reject every
 * other method on `Graph`. `// @ts-expect-error` directives lock the
 * narrowing in place — if a future edit re-broadens the parameter
 * type, the directives stop being errors and the file fails to
 * type-check.
 */

import type { Graph, Node } from '@causl/core'
import { describe, it } from 'vitest'
import type { FamilyFactory } from '../src/useCauslFamily.js'

describe('FamilyFactory — narrowed capability (compile-time)', () => {
  /**
   * The factory must still accept calls to `input` and `derived` —
   * those are the registration primitives the entire family pattern
   * is built on. If either disappears from the parameter type, every
   * existing factory in the codebase fails to compile.
   */
  it('accepts input and derived registration', () => {
    const factory: FamilyFactory<number> = (graph, key) => {
      // Both registration primitives must remain reachable.
      const node: Node<number> = graph.input(`in:${key}`, 0)
      void graph.derived(`d:${key}`, () => 0)
      return node
    }
    void factory
  })

  /**
   * Authority leak surface — none of these methods should be reachable
   * from inside a factory body. The `// @ts-expect-error` directives
   * fail to type-check if the narrowing ever regresses.
   *
   * `read` is intentionally on the rejected list: a factory that reads
   * outside a derived's `get`-tracked accessor observes a snapshot at
   * the wrong time and breaks dynamic-dependency tracking. The
   * derived's compute body is the only legal read site at registration
   * time.
   */
  it('rejects mutation, read, and lifecycle authority', () => {
    const factory: FamilyFactory<number> = (graph, key) => {
      const node = graph.input(`n:${key}`, 0)
      // @ts-expect-error commit is not part of the factory's capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error read at registration time bypasses the derived `get` tracker.
      graph.read(node)
      // @ts-expect-error hydrate must not be reachable from a factory.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot must not be reachable from a factory.
      graph.snapshot()
      // @ts-expect-error exportModel must not be reachable from a factory.
      graph.exportModel()
      // @ts-expect-error subscribeCommits is the persistence/devtools seam, not a factory's.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error readAt belongs to time-travel consumers, not factories.
      graph.readAt(node, 0)
      // @ts-expect-error snapshotAt belongs to time-travel consumers, not factories.
      graph.snapshotAt(0)
      // @ts-expect-error commitLog is the devtools seam.
      void graph.commitLog
      // @ts-expect-error now is not part of the factory's capability — registration is time-agnostic.
      void graph.now
      return node
    }
    void factory
  })

  /**
   * Structural narrowing — the factory parameter must be assignable
   * from `Graph` (so call sites still pass a real engine handle) but
   * must NOT be assignable to `Graph` (so the parameter cannot be
   * widened back inside the factory body without an explicit cast).
   * Type-level only; never invoked.
   */
  it('is structurally narrower than Graph', () => {
    type FactoryGraph = Parameters<FamilyFactory<unknown>>[0]
    // A full Graph satisfies the narrowed parameter (the call site keeps
    // working when the engine hands the factory a real graph).
    const _accepts: (g: Graph) => FactoryGraph = (g) => g
    void _accepts
    // The parameter type itself must NOT be the full Graph — narrowing
    // is strict, the consumer cannot reach the engine's mutating surface.
    // @ts-expect-error narrowing must be strict — FactoryGraph is a proper subset of Graph.
    const _widensBack: (g: FactoryGraph) => Graph = (g) => g
    void _widensBack
  })
})
