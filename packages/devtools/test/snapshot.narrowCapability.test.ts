/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link exportSnapshot} /
 * {@link exportSnapshotJson} — closes #364.
 *
 * The export side is read-only by definition: it freezes the requested
 * input values at the current GraphTime and emits an envelope. `read`
 * (to capture each input value) and `now` (to stamp the envelope) is
 * the entire surface; `commit`, `input`, `derived`, `hydrate`, the
 * time-travel readers, and the admin handles are unreachable.
 *
 * `importSnapshot` legitimately needs `commit` (it opens a single
 * commit to reapply every recognised input), so its parameter stays as
 * `Graph` and is *not* part of this narrowing.
 *
 * Narrowing is type-level: the `graph` parameter on the export-side
 * accessors is a `Pick` subset of `Graph`. `// @ts-expect-error`
 * directives lock forbidden methods out of reach; if a future change
 * re-broadens the parameter, the directives stop being errors and this
 * file fails to type-check.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type {
  SnapshotReadGraph,
  exportSnapshot,
  exportSnapshotJson,
} from '../src/index.js'

describe('exportSnapshot / exportSnapshotJson — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must keep `read` and `now` reachable —
   * those two methods are the entire export path.
   */
  it('keeps the read + now surface reachable', () => {
    type ExportParam = Parameters<typeof exportSnapshot>[0]
    type ExportJsonParam = Parameters<typeof exportSnapshotJson>[0]
    type Required = Pick<Graph, 'read' | 'now'>
    const _exportSufficient: (g: Required) => ExportParam = (g) => g
    const _exportJsonSufficient: (g: Required) => ExportJsonParam = (g) => g
    void _exportSufficient
    void _exportJsonSufficient
  })

  /**
   * Authority leak surface — none of these methods belong on a
   * read-only export. Each `// @ts-expect-error` is a structural lock.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, registration, subscription, and admin authority', () => {
    const graph = null as unknown as SnapshotReadGraph
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is the import-side capability; export must not reach it.
      graph.commit('hack', () => undefined)
      // @ts-expect-error input registration belongs to authoring code.
      graph.input('x', 0)
      // @ts-expect-error derived registration belongs to authoring code.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate is the SSR seam.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/persistence — exportSnapshot reads inputs by hand.
      graph.snapshot()
      // @ts-expect-error exportModel belongs to the model-checker bridge.
      graph.exportModel()
      // @ts-expect-error explain belongs to the inspector.
      graph.explain(null as never)
      // @ts-expect-error per-node subscribe is not the export's surface.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error subscribeCommits is the persistence/commit-log seam.
      graph.subscribeCommits(() => undefined)
      // @ts-expect-error clearCommitHistory is an admin operation.
      graph.clearCommitHistory()
      // @ts-expect-error commitLog derived belongs to the bounded-buffer consumer.
      void graph.commitLog
      // @ts-expect-error readAt is time-travel; export captures at "now".
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
    type Param = Parameters<typeof exportSnapshot>[0]
    const _accepts: (g: Graph) => Param = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — SnapshotReadGraph is a proper subset of Graph.
    const _widensBack: (g: SnapshotReadGraph) => Graph = (g) => g
    void _widensBack
  })
})
