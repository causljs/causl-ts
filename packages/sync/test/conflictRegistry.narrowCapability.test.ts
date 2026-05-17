/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link ConflictRegistry} —
 * closes #371.
 *
 * The conflict registry is the user-facing API for one of the
 * engine's first-class state-classes. Per SPEC §7 / §12.3 the read
 * and write halves of that API must hand callers only the engine
 * authority each method actually exercises:
 *
 * - `read` and `subscribe` are pure read-side accessors —
 *   `read` + `subscribe` is the entire surface they need.
 * - `resolve`, `ignore`, `supersede` patch the resolution Input —
 *   `read` (statechart guard) + `commit` (patch) + `now` (GraphTime
 *   stamp) is the entire surface they need.
 *
 * Only {@link createConflictRegistry} keeps the full `Graph`; the
 * registration pass legitimately needs `input` and `derived`.
 *
 * The narrowing is type-level: each instance method's parameter is a
 * `Pick` subset of `Graph`, and `// @ts-expect-error` directives lock
 * forbidden methods (`commit`, `derived`, `input`, `hydrate`,
 * `snapshot`, `exportModel`, …) out of reach. If a future change
 * broadens any parameter, the directives stop being errors and this
 * file fails to type-check — the same lock pattern #257 introduced for
 * `persistedInput`, `useCauslFamily`, and the inspector seam.
 *
 * No runtime behaviour is asserted here; that is the job of the
 * existing conflict suites. This file is a compile-time gate.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type {
  ConflictRegistry,
  ConflictRegistryReadGraph,
  ConflictRegistryWriteGraph,
} from '../src/index.js'

describe('ConflictRegistry — narrowed capability (compile-time)', () => {
  /**
   * The read parameter must still expose `read` and `subscribe` — the
   * implementation calls both. Asserting assignability in this
   * direction proves the slice is sufficient for the method to do its
   * job.
   */
  it('keeps the read + subscribe surface reachable on the read slice', () => {
    type ReadParam = Parameters<ConflictRegistry<unknown>['read']>[0]
    type SubscribeParam = Parameters<ConflictRegistry<unknown>['subscribe']>[0]
    type RequiredRead = Pick<Graph, 'read' | 'subscribe'>
    const _readSufficient: (g: RequiredRead) => ReadParam = (g) => g
    const _subscribeSufficient: (g: RequiredRead) => SubscribeParam = (g) => g
    void _readSufficient
    void _subscribeSufficient
  })

  /**
   * The write parameter must still expose `read`, `commit`, and `now`
   * — the mutators read for the statechart guard, commit a single
   * patch, and stamp GraphTime. Removing any breaks the
   * implementation; locking them in keeps the surface honest.
   */
  it('keeps the read + commit + now surface reachable on the write slice', () => {
    type ResolveParam = Parameters<ConflictRegistry<unknown>['resolve']>[0]
    type IgnoreParam = Parameters<ConflictRegistry<unknown>['ignore']>[0]
    type SupersedeParam = Parameters<ConflictRegistry<unknown>['supersede']>[0]
    type RequiredWrite = Pick<Graph, 'read' | 'commit' | 'now'>
    const _resolveSufficient: (g: RequiredWrite) => ResolveParam = (g) => g
    const _ignoreSufficient: (g: RequiredWrite) => IgnoreParam = (g) => g
    const _supersedeSufficient: (g: RequiredWrite) => SupersedeParam = (g) => g
    void _resolveSufficient
    void _ignoreSufficient
    void _supersedeSufficient
  })

  /**
   * Authority leak surface on the read slice — none of these methods
   * belong on a registry read accessor. Each `// @ts-expect-error` is
   * a structural lock: removing the narrowing makes the directive
   * unused and breaks the type-check.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, and admin authority on the read slice', () => {
    const graph = null as unknown as ConflictRegistryReadGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a read-accessor capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code, not a read accessor.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code, not a read accessor.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate must not be reachable from a registry read accessor.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/devtools, not the registry read accessor.
      graph.snapshot()
      // @ts-expect-error exportModel must not be reachable from a registry read accessor.
      graph.exportModel()
      // @ts-expect-error explain belongs to devtools.
      graph.explain(null as never)
      // @ts-expect-error readAt is time-travel.
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
      // @ts-expect-error commitLog is the devtools seam.
      void graph.commitLog
      // @ts-expect-error subscribeCommits is not used by the read accessor — only per-node subscribe.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error now is a write-side concern (GraphTime stamping); the read accessor must not reach for it.
      void graph.now
    }
  })

  /**
   * Authority leak surface on the write slice — the mutators
   * legitimately need `read` + `commit` + `now`, and nothing else.
   * `subscribe`, `subscribeCommits`, `derived`, `input`, `hydrate`,
   * `snapshot`, `exportModel`, the time-travel readers, and the
   * admin handles must remain unreachable through this parameter.
   */
  it('rejects subscribe, registration, hydration, and admin authority on the write slice', () => {
    const graph = null as unknown as ConflictRegistryWriteGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error per-node subscribe is not a mutator capability.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error subscribeCommits belongs to persistence/devtools, not a registry mutator.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error input registration belongs to authoring code, not a registry mutator.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code, not a registry mutator.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate must not be reachable from a registry mutator.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/devtools, not the registry mutator.
      graph.snapshot()
      // @ts-expect-error exportModel must not be reachable from a registry mutator.
      graph.exportModel()
      // @ts-expect-error explain belongs to devtools.
      graph.explain(null as never)
      // @ts-expect-error readAt is time-travel.
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
      // @ts-expect-error commitLog is the devtools seam.
      void graph.commitLog
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (existing call sites keep working) but the parameter type is a
   * strict subset and cannot be widened back to `Graph` without an
   * explicit cast. This is the lock that prevents a refactor from
   * silently re-broadening the surface.
   */
  it('is structurally narrower than Graph on both slices', () => {
    // A full Graph satisfies both narrowed parameters.
    const _acceptsRead: (g: Graph) => ConflictRegistryReadGraph = (g) => g
    const _acceptsWrite: (g: Graph) => ConflictRegistryWriteGraph = (g) => g
    void _acceptsRead
    void _acceptsWrite
    // @ts-expect-error narrowing must be strict — the read slice is a proper subset of Graph.
    const _readWidensBack: (g: ConflictRegistryReadGraph) => Graph = (g) => g
    void _readWidensBack
    // @ts-expect-error narrowing must be strict — the write slice is a proper subset of Graph.
    const _writeWidensBack: (g: ConflictRegistryWriteGraph) => Graph = (g) => g
    void _writeWidensBack
    // The read and write slices are deliberately incomparable — each
    // omits a method the other requires. A registry caller cannot
    // route a read-graph value into a mutator parameter, and vice
    // versa, without an explicit cast.
    // @ts-expect-error read slice has no `commit`; cannot satisfy the write slice.
    const _readToWrite: (g: ConflictRegistryReadGraph) => ConflictRegistryWriteGraph = (g) => g
    void _readToWrite
    // @ts-expect-error write slice has no `subscribe`; cannot satisfy the read slice.
    const _writeToRead: (g: ConflictRegistryWriteGraph) => ConflictRegistryReadGraph = (g) => g
    void _writeToRead
  })
})
