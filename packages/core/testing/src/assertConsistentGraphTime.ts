/**
 * assertConsistentGraphTime — the §3 invariant in test form.
 *
 * Given a trace of (selector, value, time) tuples — typically captured
 * across a React render tree by the `renderSpy` helper, or across a
 * concurrent-render harness like `useDeferredValue` — assert that every
 * tuple in *one render frame* resolves at the *same* GraphTime.
 *
 * This is the property Sebastian Markbåge cares about: even if the
 * scheduler tears mid-render, the values React commits to the DOM must
 * agree on what time it is.
 *
 * Trace semantics: tuples sharing a `frameId` are one render. The helper
 * groups by `frameId`, then asserts unique `time` within each group.
 *
 * Usage:
 *
 *   const trace = renderSpy.collect()
 *   assertConsistentGraphTime(trace)
 *
 *   // Or as a fast-check property:
 *   fc.assert(fc.property(genCommits, (commits) => {
 *     const trace = harness.run(commits)
 *     assertConsistentGraphTime(trace)
 *   }), { numRuns: 1000 })
 */

import type { GraphTime } from '@causljs/core'

export interface TraceEntry {
  /** Identifier for the render frame this tuple was captured in. */
  readonly frameId: number | string
  /** Identifier for the selector / hook / component that produced the tuple. */
  readonly selector: string
  /** Observed value (only used in error messages). */
  readonly value: unknown
  /** GraphTime at which the value was observed. */
  readonly time: GraphTime
}

export class GraphTimeInconsistency extends Error {
  readonly frameId: number | string
  readonly observed: ReadonlyMap<GraphTime, readonly TraceEntry[]>

  constructor(
    frameId: number | string,
    observed: ReadonlyMap<GraphTime, readonly TraceEntry[]>,
  ) {
    const summary = [...observed.entries()]
      .map(([t, entries]) => `t=${t}: ${entries.map((e) => e.selector).join(', ')}`)
      .join(' | ')
    super(
      `Inconsistent GraphTime in render frame ${String(frameId)} — ` +
        `selectors disagreed across times: ${summary}`,
    )
    this.name = 'GraphTimeInconsistency'
    this.frameId = frameId
    this.observed = observed
  }
}

export function assertConsistentGraphTime(trace: readonly TraceEntry[]): void {
  // Group by frameId.
  const byFrame = new Map<number | string, TraceEntry[]>()
  for (const e of trace) {
    const list = byFrame.get(e.frameId) ?? []
    list.push(e)
    byFrame.set(e.frameId, list)
  }

  // Within each frame, every entry must share one GraphTime.
  for (const [frameId, entries] of byFrame) {
    const byTime = new Map<GraphTime, TraceEntry[]>()
    for (const e of entries) {
      const list = byTime.get(e.time) ?? []
      list.push(e)
      byTime.set(e.time, list)
    }
    if (byTime.size > 1) {
      throw new GraphTimeInconsistency(frameId, byTime)
    }
  }
}
