/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link connectDevtools} —
 * closes #364.
 *
 * The bridge is a *view*, not an editor. The `connect.ts` doc-block
 * argues at length that time travel must be a *read* through
 * `snapshotAt`, never a mutation through `commit`, because a
 * panel-driven mutation would forge a fractional or out-of-order
 * time. The full `Graph` parameter that #257 left in place
 * contradicted that comment: it let a future bridge edit silently
 * call `graph.commit(...)`, `graph.input(...)`, `graph.hydrate(...)`,
 * or `graph.derived(...)` and reduced the discipline to a code-review
 * hope.
 *
 * The methods the bridge actually calls are exactly four:
 * `subscribeCommits` (forward each commit as an action),
 * `snapshot` (initial state and per-commit state hand-off),
 * `snapshotAt` (time-travel projection), and
 * `now` (baseline-time stamp). `commit`, `input`, `derived`,
 * `hydrate`, `read`, `subscribe`, `explain`, `exportModel`,
 * `clearCommitHistory`, `commitLog`, and `readAt` are unreachable.
 *
 * Narrowing is type-level: the `graph` parameter is a `Pick` subset of
 * `Graph`. `// @ts-expect-error` directives lock forbidden methods out
 * of reach; if a future change re-broadens the parameter, the
 * directives stop being errors and this file fails to type-check.
 */

import type { Graph } from '@causl/core'
import { describe, it } from 'vitest'
import type { BridgeGraph, connectDevtools } from '../src/index.js'

describe('connectDevtools — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep
   * `subscribeCommits | snapshot | snapshotAt | now` reachable —
   * those are the four methods the bridge actually calls.
   * Removing any breaks the bridge; locking them in keeps the
   * surface honest.
   */
  it('keeps the bridge surface reachable', () => {
    type Param = Parameters<typeof connectDevtools>[0]
    type Required = Pick<Graph, 'subscribeCommits' | 'snapshot' | 'snapshotAt' | 'now'>
    const _sufficient: (g: Required) => Param = (g) => g
    void _sufficient
  })

  /**
   * Authority leak surface — none of these methods belong on a
   * read-only bridge. The set is the §17 "panel must not edit" list
   * the doc-block calls out: `commit`, `input`, `derived`, `hydrate`
   * head it, but `read`, `subscribe`, `explain`, `exportModel`,
   * `clearCommitHistory`, `commitLog`, and `readAt` are equally
   * out of bounds — the bridge consumes the global commit stream and
   * `snapshot` / `snapshotAt`, never per-node primitives.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, hydration, and per-node read authority', () => {
    const graph = null as unknown as BridgeGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit would forge an out-of-order GraphTime — see #213.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate would mutate the live engine; the bridge re-inits the panel instead.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error read is per-node; the bridge consumes the global snapshot/commit stream.
      graph.read(null as never)
      // @ts-expect-error per-node subscribe is not the bridge's surface.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error explain belongs to the inspector.
      graph.explain(null as never)
      // @ts-expect-error exportModel belongs to the model-checker bridge.
      graph.exportModel()
      // @ts-expect-error clearCommitHistory is an admin operation.
      graph.clearCommitHistory()
      // @ts-expect-error commitLog derived belongs to the bounded-buffer consumer.
      void graph.commitLog
      // @ts-expect-error readAt is per-node time-travel; the bridge uses snapshotAt.
      graph.readAt(null as never, 0)
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (existing call sites keep working) but the parameter type is a
   * strict subset and cannot be widened back to `Graph` without an
   * explicit cast. This is the lock that prevents a refactor from
   * silently re-broadening the surface.
   */
  it('is structurally narrower than Graph', () => {
    type Param = Parameters<typeof connectDevtools>[0]
    const _accepts: (g: Graph) => Param = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — BridgeGraph is a proper subset of Graph.
    const _widensBack: (g: BridgeGraph) => Graph = (g) => g
    void _widensBack
  })
})
