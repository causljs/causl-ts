/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link statechart} — closes #364.
 *
 * The statechart capture is a snapshot of the current Engine-region
 * configuration computed from `graph.now` alone. That single property
 * is the entire surface; `commit`, `input`, `derived`, `hydrate`,
 * `snapshot`, `exportModel`, `read`, `subscribe`, `subscribeCommits`,
 * `clearCommitHistory`, `commitLog`, and the time-travel readers are
 * unreachable. A getter that can mutate the engine ceases to be a
 * getter and becomes a parallel writer, breaking the §13 "engine is
 * inspectable through its own primitives, not a parallel system"
 * commitment.
 *
 * Narrowing is type-level: the `graph` parameter is a `Pick` subset of
 * `Graph`. `// @ts-expect-error` directives lock forbidden methods out
 * of reach; if a future change re-broadens the parameter, the
 * directives stop being errors and this file fails to type-check.
 */

import type { Graph } from '@causl/core'
import { describe, it } from 'vitest'
import type { StatechartGraph, statechart } from '../src/index.js'

describe('statechart — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep `now` reachable — that single
   * property is the entire statechart input.
   */
  it('keeps now reachable', () => {
    type Param = Parameters<typeof statechart>[0]
    type Required = Pick<Graph, 'now'>
    const _sufficient: (g: Required) => Param = (g) => g
    void _sufficient
  })

  /**
   * Authority leak surface — none of these methods belong on a
   * statechart getter. Each `// @ts-expect-error` is a structural lock.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, subscription, and admin authority', () => {
    const graph = null as unknown as StatechartGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a getter capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate is the SSR seam.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/persistence.
      graph.snapshot()
      // @ts-expect-error exportModel belongs to the model-checker bridge.
      graph.exportModel()
      // @ts-expect-error read is not used; the chart is computed from `now` alone.
      graph.read(null as never)
      // @ts-expect-error explain belongs to the inspector.
      graph.explain(null as never)
      // @ts-expect-error per-node subscribe is not the chart's surface.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error subscribeCommits is the persistence/commit-log seam.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error clearCommitHistory is an admin operation.
      graph.clearCommitHistory()
      // @ts-expect-error commitLog derived belongs to the bounded-buffer consumer.
      void graph.commitLog
      // @ts-expect-error readAt is time-travel.
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (existing call sites keep working) but the parameter type is a
   * strict subset and cannot be widened back to `Graph` without an
   * explicit cast.
   */
  it('is structurally narrower than Graph', () => {
    type Param = Parameters<typeof statechart>[0]
    const _accepts: (g: Graph) => Param = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — StatechartGraph is a proper subset of Graph.
    const _widensBack: (g: StatechartGraph) => Graph = (g) => g
    void _widensBack
  })
})
