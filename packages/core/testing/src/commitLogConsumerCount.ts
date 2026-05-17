/**
 * commitLogConsumerCount — test-and-introspection accessor for the
 * engine's commitLog consumer counter (#715 follow-up).
 *
 * The counter gates Phase F.4 of the commit pipeline (the per-commit
 * `commitLogEntry.value` rebuild). When zero, the rebuild is skipped
 * — the audit's headline acceptance for #715: a default
 * `commitHistoryCap=1000` adopter who never subscribes to
 * `commitLog`, never registers a `commitMetadataDerived`, and whose
 * plain deriveds never read `commitLog` pays nothing for F.4 on
 * every commit. The bounded ring (Phase F) still appends so a future
 * first subscriber sees recent history.
 *
 * A "consumer" is any one of:
 *
 *   1. A `subscribe(graph.commitLog, …)` registration — the
 *      observer needs the post-commit array on each fire.
 *   2. An ordinary `derived(...)` whose recorded read-set
 *      includes the engine-owned `COMMIT_LOG_ID` — counted via
 *      `setDeps` so dynamic dep flips stay accurate.
 *   3. A `commitMetadataDerived(...)` registration — every
 *      commit-metadata derived reads `commitLog` semantically;
 *      counted unconditionally at registration, decremented on
 *      dispose.
 *
 * Usage (test-only):
 *
 *   import { commitLogConsumerCount } from '@causljs/core-testing-internal'
 *
 *   const g = createCausl()
 *   expect(commitLogConsumerCount(g)).toBe(0)
 *   const unsub = g.subscribe(g.commitLog, () => {})
 *   expect(commitLogConsumerCount(g)).toBe(1)
 *   unsub()
 *   expect(commitLogConsumerCount(g)).toBe(0)
 *
 * The helper resolves the engine's testing-dispatch registry directly,
 * via a relative import into the `@causljs/core` source tree. Adapter
 * code has no production use for this number — it lives here, behind
 * the testing seam, because the underlying counter is engine-internal
 * gating, not a contract surface.
 */

import type { Graph } from '@causljs/core'
import { lookupTestingDispatch } from '../../src/testing-dispatch.js'

/**
 * Returns the current commitLog consumer count for `graph`.
 *
 * @param graph - The handle returned by `createCausl`.
 * @returns The current commitLog consumer count.
 * @throws Error when `graph` was not produced by `createCausl`.
 */
export function commitLogConsumerCount(graph: Graph): number {
  return lookupTestingDispatch(graph).commitLogConsumerCount()
}
