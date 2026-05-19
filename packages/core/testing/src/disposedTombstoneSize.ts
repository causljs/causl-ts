/**
 * disposedTombstoneSize — test-and-introspection accessor for the
 * engine's disposed-tombstone ring (#251).
 *
 * The ring is the data structure that lets `getEntry` distinguish a
 * released node from one never registered. It is bounded by the engine
 * option `disposedTombstoneCap` (default 1000) so a long-lived process
 * under fresh-id churn does not accumulate tombstones without bound.
 * This accessor exists for the property suite that locks the cap;
 * adapter code has no production use for it, which is why it lives in
 * the dedicated `@causl/core/testing` seam rather than the
 * adapter-facing `@causl/core/internal` entrypoint (#376).
 *
 * Usage:
 *
 *   import { disposedTombstoneSize } from '@causl/core/testing'
 *
 *   const g = createCausl({ disposedTombstoneCap: 4 })
 *   // ... churn fresh ids and dispose them ...
 *   expect(disposedTombstoneSize(g)).toBeLessThanOrEqual(4)
 *
 * The helper resolves the engine's testing-dispatch registry directly,
 * via a relative import into the `@causl/core` source tree. The
 * package surfaces no other path into engine state — the test seam and
 * the adapter seam are deliberately disjoint registries so §12.3's
 * adapter contract does not have to defend test-only entries.
 */

import type { Graph } from '@causl/core'
import { lookupTestingDispatch } from '../../src/testing-dispatch.js'

/**
 * Returns the number of currently-retained tombstones in the
 * engine's disposed-tombstone ring for `graph`.
 *
 * @param graph - The handle returned by `createCausl`.
 * @returns The number of currently-retained tombstones.
 * @throws Error when `graph` was not produced by `createCausl`.
 */
export function disposedTombstoneSize(graph: Graph): number {
  return lookupTestingDispatch(graph).disposedTombstoneSize()
}
