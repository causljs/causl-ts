/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link commitLog}.
 *
 * The devtools `commitLog` registers a `commitMetadataDerived` whose
 * compute reads `graph.commitLog`. Those two methods are the entire
 * surface the implementation touches; `commit`, `input`, `derived`,
 * `hydrate`, `snapshot`, `exportModel`, `clearCommitHistory`, the
 * per-node `subscribe`, the global `subscribeCommits`, and the
 * time-travel readers are unreachable. A bounded projection that can
 * mutate the engine ceases to be a projection and becomes a parallel
 * writer, breaking the §11 "engine is its own observer" commitment.
 *
 * Narrowing is type-level: the `graph` parameter is a `Pick` subset
 * of `Graph`. `// @ts-expect-error` directives lock forbidden methods
 * out of reach; if a future change re-broadens the parameter, the
 * directives stop being errors and this file fails to type-check.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type { CommitLogGraph, commitLog } from '../src/index.js'

describe('commitLog — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep `commitMetadataDerived` and
   * `commitLog` reachable — the two methods the implementation calls.
   * Removing either breaks the projection; locking them in keeps the
   * surface honest.
   */
  it('keeps commitMetadataDerived + commitLog reachable', () => {
    type Param = Parameters<typeof commitLog>[0]
    type Required = Pick<Graph, 'commitMetadataDerived' | 'commitLog'>
    const _sufficient: (g: Required) => Param = (g) => g
    void _sufficient
  })

  /**
   * Authority leak surface — none of these methods belong on the
   * commit-log projection. Each `// @ts-expect-error` is a structural
   * lock: removing the narrowing makes the directive unused and breaks
   * the type-check.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, and admin authority', () => {
    const graph = null as unknown as CommitLogGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a projection capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate is the SSR seam, not the projection's.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/persistence.
      graph.snapshot()
      // @ts-expect-error exportModel belongs to the model-checker bridge.
      graph.exportModel()
      // @ts-expect-error read is consumed only via `get(...)` inside the registered compute.
      graph.read(null as never)
      // @ts-expect-error per-node subscribe is reached via the returned DerivedNode, not the surface.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error explain belongs to the inspector and the `whyUpdated` explainers.
      graph.explain(null as never)
      // @ts-expect-error subscribeCommits is a separate per-fire capability.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error clearCommitHistory is an admin operation.
      graph.clearCommitHistory()
      // @ts-expect-error readAt is time-travel.
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
      // @ts-expect-error now belongs to time-stamping consumers.
      void graph.now
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (existing call sites keep working) but the parameter type is a
   * strict subset and cannot be widened back to `Graph` without an
   * explicit cast.
   */
  it('is structurally narrower than Graph', () => {
    type Param = Parameters<typeof commitLog>[0]
    const _accepts: (g: Graph) => Param = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — CommitLogGraph is a proper subset of Graph.
    const _widensBack: (g: CommitLogGraph) => Graph = (g) => g
    void _widensBack
  })
})
