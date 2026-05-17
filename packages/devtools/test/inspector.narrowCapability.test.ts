/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link inspect} / {@link watchInspect}
 * — closes #257.
 *
 * The node inspector is the canonical "read-only inspection" consumer:
 * it reads explanation lineage, subscribes to its updates, and stamps
 * each view with `graph.now`. It must never call `commit`, `input`,
 * `derived`, `hydrate`, `snapshot`, or `exportModel` — devtools that
 * can mutate the engine cease to be devtools and become a parallel
 * writer, breaking the SPEC §13
 * "engine is inspectable through its own primitives, not a parallel
 * system" commitment.
 *
 * Narrowing is type-level: the `graph` parameter is a `Pick` subset of
 * `Graph`. `// @ts-expect-error` directives lock forbidden methods out
 * of reach; if a future change re-broadens the parameter, the
 * directives stop being errors and this file fails to type-check.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type { inspect, watchInspect } from '../src/inspector.js'

describe('inspect / watchInspect — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep `read`, `explain`, `now`, and
   * `subscribe` reachable — those are the four methods the
   * implementation calls. Removing any breaks the inspector;
   * locking them in keeps the surface honest.
   */
  it('keeps the inspection methods reachable', () => {
    type InspectGraph = Parameters<typeof inspect>[0]
    type WatchGraph = Parameters<typeof watchInspect>[0]
    type Required = Pick<Graph, 'read' | 'explain' | 'now' | 'subscribe'>
    const _inspectSufficient: (g: Required) => InspectGraph = (g) => g
    const _watchSufficient: (g: Required) => WatchGraph = (g) => g
    void _inspectSufficient
    void _watchSufficient
  })

  /**
   * Authority leak surface — none of these methods should be reachable
   * from inside an inspector. Each `// @ts-expect-error` is a
   * structural lock.
   */
  it('rejects mutation, registration, and lifecycle authority', () => {
    type InspectGraph = Parameters<typeof inspect>[0]
    const graph = null as unknown as InspectGraph
    // The `if (false)` gate keeps this body unreachable at runtime so
    // `graph` is never dereferenced; TypeScript still type-checks every
    // line, which is the point of the `// @ts-expect-error` directives.
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a devtools-inspector capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate is the SSR seam, not the inspector's.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/persistence.
      graph.snapshot()
      // @ts-expect-error exportModel belongs to the model-checker bridge.
      graph.exportModel()
      // @ts-expect-error subscribeCommits is the persistence/commit-log seam.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error commitLog is consumed by the commit-log panel, not the node inspector.
      void graph.commitLog
      // @ts-expect-error readAt is time-travel; the inspector reads "now".
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (call sites keep working), but the parameter type is a strict
   * subset and cannot be widened back to `Graph` without an explicit
   * cast.
   */
  it('is structurally narrower than Graph', () => {
    type InspectGraph = Parameters<typeof inspect>[0]
    const _accepts: (g: Graph) => InspectGraph = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — InspectGraph is a proper subset of Graph.
    const _widensBack: (g: InspectGraph) => Graph = (g) => g
    void _widensBack
  })
})
