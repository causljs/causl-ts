/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link whyUpdated} /
 * {@link whyNotUpdated}.
 *
 * The lineage explainers ship as `DerivedNode<WhyResult>` values
 * registered through `graph.commitMetadataDerived`. They consume four
 * methods on the engine surface:
 *
 *  - `commitMetadataDerived` — to register the live derivation;
 *  - `commitLog` — read inside the compute through `get(...)` so the
 *    derivation's lineage points at the engine's transaction log;
 *  - `read` — accepted on the type signature for ergonomic call sites
 *    that pass a full `Graph` (the implementation only reads through
 *    `get(...)` inside the compute, but the public type tolerates
 *    `read` so consumers do not have to cast a `Graph` down);
 *  - `explain` — read inside the compute through `get(...)` to
 *    resolve the target node's current dependency set.
 *
 * `commit`, `input`, `derived`, `hydrate`, `snapshot`, `exportModel`,
 * `clearCommitHistory`, the per-node `subscribe`, the global
 * `subscribeCommits`, and the time-travel readers are unreachable —
 * an explainer that can mutate the engine ceases to be inspection
 * and becomes a parallel writer, breaking the §11 "engine is its
 * own observer" commitment.
 *
 * Narrowing is type-level: the `graph` parameter is a `Pick` subset
 * of `Graph`. `// @ts-expect-error` directives lock forbidden methods
 * out of reach; if a future change re-broadens the parameter, the
 * directives stop being errors and this file fails to type-check.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type { WhyGraph, whyNotUpdated, whyUpdated } from '../src/index.js'

describe('whyUpdated / whyNotUpdated — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep exactly the four methods the
   * implementation needs reachable. Removing any breaks the
   * explainers; locking them in keeps the surface honest.
   */
  it('keeps the commitMetadataDerived + commitLog + read + explain surface reachable', () => {
    type WhyUpdatedParam = Parameters<typeof whyUpdated>[0]
    type WhyNotUpdatedParam = Parameters<typeof whyNotUpdated>[0]
    type Required = Pick<
      Graph,
      'commitMetadataDerived' | 'commitLog' | 'read' | 'explain'
    >
    const _whyUpdatedSufficient: (g: Required) => WhyUpdatedParam = (g) => g
    const _whyNotUpdatedSufficient: (g: Required) => WhyNotUpdatedParam = (g) => g
    void _whyUpdatedSufficient
    void _whyNotUpdatedSufficient
  })

  /**
   * Authority leak surface — none of these methods belong on a
   * lineage explainer. Each `// @ts-expect-error` is a structural
   * lock.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, and admin authority', () => {
    const graph = null as unknown as WhyGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a lineage-inspection capability.
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
      // @ts-expect-error per-node subscribe is reached via the returned DerivedNode, not the surface.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error subscribeCommits is the persistence/commit-log seam.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error clearCommitHistory is an admin operation.
      graph.clearCommitHistory()
      // @ts-expect-error readAt is time-travel; the explainer reads through `get` inside the compute.
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
    type Param = Parameters<typeof whyUpdated>[0]
    const _accepts: (g: Graph) => Param = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — WhyGraph is a proper subset of Graph.
    const _widensBack: (g: WhyGraph) => Graph = (g) => g
    void _widensBack
  })
})
