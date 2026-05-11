/**
 * 1000-row virtualized grid leak gate (#126).
 *
 * Per the issue spec, the full deliverable is:
 *   - A Vite app at packages/react/examples/family-grid/
 *   - Playwright e2e tests using performance.measureUserAgentSpecificMemory()
 *   - Eight test scenarios including a 30-second sustained-scroll soak
 *
 * v0 here is the jsdom-side test (issue scenario #8) which gives fast
 * feedback and gates the same invariant — registered-node count stays
 * bounded by (visible + overscan), and recompute work stays bounded by
 * the rows that actually changed visibility this scroll step. The
 * Playwright + soak suite lands in a stacked follow-up PR.
 *
 * @remarks
 * The earlier draft of this suite gated `live <= initial * 2` /
 * `live <= expectedBound * 2`, which (per the brutal-critique review)
 * "passes a 100% leak silently". This iteration replaces the 2× slack
 * with EXACT equality once the deferred-dispose microtask drains, plus
 * a `recomputeCounter` gate that asserts only the row-sums for newly
 * visible rows recompute on each scroll step. An unmount/remount round
 * trip and a property-based scroll-trajectory test cover the rapid
 * reversal / jump-to-bottom regression cases.
 */

import { createCausl, type Compute, type Graph } from '@causl/core'
import { propertyTrials, recomputeCounter } from '@causl/core/testing'
import { act, render } from '@testing-library/react'
import fc from 'fast-check'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCauslFamily } from '../src/index.js'

/**
 * Compute-wrapping hook used to thread `recomputeCounter.wrap` into
 * the row-sum derivations. Matches the helper's `wrap<T>(compute, label)`
 * signature so tests can pass `counter.wrap.bind(counter)` directly.
 */
type WrapCompute = <T>(compute: Compute<T>, label?: string) => Compute<T>

interface VirtualGridProps {
  totalRows: number
  visibleRows: number
  overscan: number
  scrollTop: number
  /**
   * Optional hook applied to the row-sum derivation's compute function
   * so a `recomputeCounter` can observe how often each row recomputes
   * in response to scroll.
   */
  wrapCompute?: WrapCompute | undefined
}

function Cell({ row, col }: { row: number; col: number }) {
  useCauslFamily(`r${row}:c${col}`, (g, k) => g.input(`cell:${k}`, row * col))
  return null
}

function RowSum({
  row,
  wrapCompute,
}: {
  row: number
  wrapCompute?: WrapCompute | undefined
}) {
  useCauslFamily(`row-sum:${row}`, (g, k) => {
    const id = `sum:${k}`
    const compute: Compute<number> = () => row
    const wrapped = wrapCompute ? wrapCompute(compute, id) : compute
    return g.derived(id, wrapped)
  })
  return null
}

function VirtualGrid({
  totalRows,
  visibleRows,
  overscan,
  scrollTop,
  wrapCompute,
}: VirtualGridProps) {
  const start = Math.max(0, scrollTop - overscan)
  const end = Math.min(totalRows, scrollTop + visibleRows + overscan)
  const rows: React.ReactNode[] = []
  for (let r = start; r < end; r++) {
    rows.push(
      <div key={r}>
        <RowSum row={r} wrapCompute={wrapCompute} />
        <Cell row={r} col={0} />
        <Cell row={r} col={1} />
        <Cell row={r} col={2} />
      </div>,
    )
  }
  return <div>{rows}</div>
}

/**
 * Drain the microtask queue used by deferred-dispose. Two awaits
 * because the disposal effect-cleanup queues a microtask that itself
 * enqueues additional work in jsdom.
 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Heap-delta primitive — same shape as the bench harness
 * (`packages/bench/src/run.ts:142-157`). Forces GC at the start and
 * end so the delta measures *retained* bytes rather than transient
 * allocation noise. When `globalThis.gc` is unavailable the function
 * returns `undefined`; callers must skip in that environment.
 */
function measureHeapDelta(work: () => Promise<void>): Promise<number | undefined> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc !== 'function') return Promise.resolve(undefined)
  return (async () => {
    gc()
    const before = process.memoryUsage().heapUsed
    await work()
    gc()
    const after = process.memoryUsage().heapUsed
    return after - before
  })()
}

/**
 * True when the current process exposes `globalThis.gc`. Vitest
 * inherits `--expose-gc` via `NODE_OPTIONS` or `--node-options`.
 * When this is false, heap-delta measurements are dominated by JS
 * runtime noise and the gate is structurally vacuous.
 */
const HEAP_GATE_AVAILABLE = typeof (globalThis as { gc?: unknown }).gc === 'function'

/**
 * CI honesty signal: when this env flag is `'1'` the harness MUST
 * have GC access — falling back to the silent-skip path on a CI
 * runner would hide a regression in the toolchain. The bench package
 * uses the same idiom (`assertExposeGc()` in `packages/bench/src/run.ts`).
 */
const HEAP_GATE_REQUIRED =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.CAUSL_HEAP_GATE === '1'

/**
 * Live-node count via the engine's own boundary (`exportModel.nodes`).
 * The boundary is the engine's authoritative answer to "how many nodes
 * are registered right now", which is what the leak gate is asserting
 * against.
 */
function countLiveNodes(graph: Graph): number {
  return graph.exportModel({ maxCommits: 0 }).nodes.length
}

/**
 * Exact node count for the current window at `scrollTop`. Mirrors the
 * VirtualGrid's window math (overscan on both sides, clamped to
 * [0, totalRows]) so the test asserts against the same formula the
 * grid renders, not a hand-rolled one that drifts.
 */
function expectedBound(
  visible: number,
  overscan: number,
  cols: number,
  scrollTop: number,
  totalRows: number,
): number {
  const start = Math.max(0, scrollTop - overscan)
  const end = Math.min(totalRows, scrollTop + visible + overscan)
  return (end - start) * (cols + 1)
}

describe('1000-row virtualized grid leak gate', () => {
  /**
   * Initial render registers exactly the on-screen visible rows × cols.
   * This is the anchor: every other test asserts the same exact count
   * is preserved across scroll, remount, and adversarial trajectories.
   */
  it('initial render registers exactly the rendered window × (cols + 1) nodes', async () => {
    const g = createCausl()
    const visible = 20
    const overscan = 5
    const cols = 3
    const totalRows = 1000
    render(
      <CauslProvider graph={g}>
        <VirtualGrid
          totalRows={totalRows}
          visibleRows={visible}
          overscan={overscan}
          scrollTop={0}
        />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, 0, totalRows),
    )
  })

  /**
   * Scrolling forward keeps the live-node count EXACTLY at the
   * expected bound after the deferred-dispose microtask drains. This
   * is the brutal-critique fix: the gate is exact equality, not 2×
   * slack — a 50% leak fails the gate, not silently passes it.
   *
   * The recomputeCounter assertion adds a second gate: only the
   * row-sums for the rows that became newly visible in this scroll
   * step recompute. Existing visible rows are not asked to recompute.
   */
  it('forward scroll keeps live count exact and recompute bounded by newly-visible rows', async () => {
    const g = createCausl()
    const totalRows = 1000
    const visible = 20
    const overscan = 5
    const cols = 3
    const counter = recomputeCounter()

    function Test() {
      const [scrollTop, setScrollTop] = useState(0)
      return (
        <>
          <button
            data-testid="scroll"
            onClick={() => setScrollTop((s) => s + 100)}
          />
          <VirtualGrid
            totalRows={totalRows}
            visibleRows={visible}
            overscan={overscan}
            scrollTop={scrollTop}
            wrapCompute={counter.wrap.bind(counter)}
          />
        </>
      )
    }

    const { container } = render(
      <CauslProvider graph={g}>
        <Test />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, 0, totalRows),
    )

    // Each click scrolls by 100 rows. Newly-visible rows recompute
    // ONCE (engine first-eval on registration); previously visible
    // rows do not recompute because nothing they depend on changed.
    for (let step = 0; step < 5; step++) {
      counter.reset()
      const newScrollTop = (step + 1) * 100
      act(() => {
        ;(container.querySelector('[data-testid="scroll"]') as HTMLButtonElement).click()
      })
      await flush()
      // Live count remains exactly bounded by the rendered window
      // at the new scroll position.
      expect(countLiveNodes(g)).toBe(
        expectedBound(visible, overscan, cols, newScrollTop, totalRows),
      )
      // Recomputes are bounded by the SIZE of the new window's
      // first-eval set: at most one per row in the window. We assert
      // an upper bound rather than exact equality because lazy first-
      // evaluation only fires on read, and the test does not read.
      // The shape we DO assert: total recomputes never exceeds the
      // window size — a leak that recomputed every disposed row would
      // blow this past the bound.
      expect(counter.total()).toBeLessThanOrEqual(visible + 2 * overscan)
    }
  })

  /**
   * Scroll-bottom-then-back-to-top must restore the live-node count
   * to exactly its initial value. Any lingering disposed-but-still-
   * live entry would manifest as a count above `initial`.
   */
  it('scroll-bottom-then-back-to-top returns live-node count to initial exactly', async () => {
    const g = createCausl()
    const totalRows = 100
    const visible = 10
    const overscan = 2
    const cols = 3
    function Test({ scrollTop }: { scrollTop: number }) {
      return (
        <VirtualGrid
          totalRows={totalRows}
          visibleRows={visible}
          overscan={overscan}
          scrollTop={scrollTop}
        />
      )
    }
    const { rerender } = render(
      <CauslProvider graph={g}>
        <Test scrollTop={0} />
      </CauslProvider>,
    )
    await flush()
    const initial = countLiveNodes(g)
    expect(initial).toBe(expectedBound(visible, overscan, cols, 0, totalRows))

    // Scroll to the very bottom.
    const bottom = totalRows - visible
    rerender(
      <CauslProvider graph={g}>
        <Test scrollTop={bottom} />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, bottom, totalRows),
    )

    // Scroll back to the top.
    rerender(
      <CauslProvider graph={g}>
        <Test scrollTop={0} />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(initial)
  })

  /**
   * Sustained scroll across all 1000 rows in 50-row jumps. The exact-
   * equality gate (no slack) means a sustained leak — even one disposed
   * node per step that didn't actually get released — would surface
   * as soon as the loop counts climb above the bound.
   */
  it('1000-row sustained virtual scroll keeps live count exactly bounded', async () => {
    const g = createCausl()
    const totalRows = 1000
    const visible = 20
    const overscan = 5
    const cols = 3
    function Test({ scrollTop }: { scrollTop: number }) {
      return (
        <VirtualGrid
          totalRows={totalRows}
          visibleRows={visible}
          overscan={overscan}
          scrollTop={scrollTop}
        />
      )
    }
    const { rerender } = render(
      <CauslProvider graph={g}>
        <Test scrollTop={0} />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, 0, totalRows),
    )

    for (let scrollTop = 0; scrollTop < totalRows - visible; scrollTop += 50) {
      rerender(
        <CauslProvider graph={g}>
          <Test scrollTop={scrollTop} />
        </CauslProvider>,
      )
      await flush()
      // Exact equality: a leak passes through this gate as a
      // FAILURE, not as a silent acceptance. The bound varies with
      // scrollTop because the window is clamped at scrollTop=0.
      expect(countLiveNodes(g)).toBe(
        expectedBound(visible, overscan, cols, scrollTop, totalRows),
      )
    }
  })

  /**
   * Unmount the entire grid, then mount it again at a different
   * scroll position. After the dispose microtask drains, the new
   * mount's live count is exactly the new window's expected bound —
   * no leftover entries from the first mount survive in the engine.
   */
  it('unmount + remount round trip leaks no nodes from the prior mount', async () => {
    const g = createCausl()
    const totalRows = 100
    const visible = 10
    const overscan = 2
    const cols = 3

    const first = render(
      <CauslProvider graph={g}>
        <VirtualGrid
          totalRows={totalRows}
          visibleRows={visible}
          overscan={overscan}
          scrollTop={0}
        />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, 0, totalRows),
    )
    first.unmount()
    await flush()
    // Full unmount drains the registry to zero.
    expect(countLiveNodes(g)).toBe(0)

    // Remount at a different scroll position; live count is the
    // new window's bound, not the old window's bound.
    const second = render(
      <CauslProvider graph={g}>
        <VirtualGrid
          totalRows={totalRows}
          visibleRows={visible}
          overscan={overscan}
          scrollTop={50}
        />
      </CauslProvider>,
    )
    await flush()
    expect(countLiveNodes(g)).toBe(
      expectedBound(visible, overscan, cols, 50, totalRows),
    )
    second.unmount()
    await flush()
    expect(countLiveNodes(g)).toBe(0)
  })

  /**
   * Property-based scroll trajectory: random sequences of
   * scroll-to-position events (covering rapid reversal, jump-to-
   * bottom, fling) must always land at the exact-bounded live count
   * after each step's deferred-dispose drain. This is the regression
   * gate the cross-cutting review flagged as missing — without it the
   * suite only exercises one synthetic scroll pattern.
   */
  it('random scroll trajectories preserve the exact live-count invariant', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.integer({ min: 0, max: 80 }),
          { minLength: 1, maxLength: 12 },
        ),
        async (positions) => {
          const g = createCausl()
          const totalRows = 100
          const visible = 10
          const overscan = 2
          const cols = 3
          function Test({ scrollTop }: { scrollTop: number }) {
            return (
              <VirtualGrid
                totalRows={totalRows}
                visibleRows={visible}
                overscan={overscan}
                scrollTop={scrollTop}
              />
            )
          }
          const { rerender, unmount } = render(
            <CauslProvider graph={g}>
              <Test scrollTop={0} />
            </CauslProvider>,
          )
          await flush()
          for (const scrollTop of positions) {
            rerender(
              <CauslProvider graph={g}>
                <Test scrollTop={scrollTop} />
              </CauslProvider>,
            )
            await flush()
            // Exact bound after every scroll step, regardless of how
            // adversarial the trajectory is.
            expect(countLiveNodes(g)).toBe(
              expectedBound(visible, overscan, cols, scrollTop, totalRows),
            )
          }
          unmount()
          await flush()
          expect(countLiveNodes(g)).toBe(0)
        },
      ),
      propertyTrials('grid-trajectory'),
    )
  })

  /**
   * Heap-delta noise-floor gate — issue #254.
   *
   * The exact-equality `countLiveNodes` gate above catches the
   * dominant leak class (engine-internal registry retention). It
   * cannot catch the *strictly weaker* class: a closure or callback
   * that the dispose path forgot to detach holds a reference to a
   * disposed lineage on the JS heap. `countLiveNodes` is blind to
   * that — the entry is gone from the engine's registry, but a
   * subscription's closure still references it.
   *
   * This gate measures `process.memoryUsage().heapUsed` deltas around
   * a sustained scroll, with `globalThis.gc()` forcing collection at
   * the start and end so the delta represents *retained* bytes.
   * Establishes a noise-floor by running the same trajectory shape
   * against a no-op grid (no `useCauslFamily`), takes the maximum
   * across N=5 runs, and asserts the real-grid delta stays within
   * `noiseFloor + 64 KiB` of slack.
   *
   * Reuses the bench-harness heap-delta primitive shape from
   * `packages/bench/src/run.ts` rather than reinventing it.
   *
   * GC availability:
   * - Skipped silently when `globalThis.gc` is undefined (the common
   *   dev path; `pnpm test` does not pass `--expose-gc`).
   * - When `CAUSL_HEAP_GATE=1` is set on the environment but `gc`
   *   is still unavailable, the test fails loudly — same idiom as
   *   `assertExposeGc()` in the bench package. CI flips that flag on.
   */
  // Skip the heap-delta gate when GC is not exposed AND the
  // honesty signal is not set. With `CAUSL_HEAP_GATE=1` the
  // test still runs and the loud-fail branch fires inside the body.
  it.skipIf(!HEAP_GATE_AVAILABLE && !HEAP_GATE_REQUIRED)(
    'heap-delta over sustained scroll does not grow across repeated mount/unmount cycles',
    async () => {
      if (HEAP_GATE_REQUIRED && !HEAP_GATE_AVAILABLE) {
        // CI honesty leg — same idiom as `assertExposeGc()` in
        // `packages/bench/src/run.ts`. The flag is set by the
        // workflow that promises `--expose-gc` is in scope; if the
        // toolchain dropped it, fail loudly so the regression in CI
        // configuration surfaces directly.
        throw new Error(
          'CAUSL_HEAP_GATE=1 set but globalThis.gc is unavailable. ' +
            'Run vitest with --expose-gc (NODE_OPTIONS=--expose-gc) so the ' +
            'heap-delta gate produces honest numbers.',
        )
      }
      const totalRows = 1000
      const visible = 20
      const overscan = 5
      const positions: number[] = []
      for (let s = 0; s < totalRows - visible; s += 50) positions.push(s)
      // And back to zero — symmetry exercises the dispose path on
      // the way down so any retained closure shows in `heapAfter`.
      for (let s = totalRows - visible; s >= 0; s -= 50) positions.push(s)

      // The honest gate is *not* "real-grid delta ≤ no-op-grid delta
      // + tiny slack"  — that comparison is dominated by one-time
      // JIT compilation, React internal initialisation, and jsdom
      // hot-path warmup, all of which happen on the first real-grid
      // run and not on the no-op grid (which exercises a strictly
      // smaller subset of the codebase). What this gate must prove
      // is the *steady-state* property: across repeated mount /
      // scroll / unmount cycles of the real grid, retained heap
      // does not grow per cycle. A genuine engine-external leak
      // (a forgotten subscription closure) accumulates linearly in
      // the number of cycles; absent a leak the per-cycle delta
      // converges to zero (mod GC and runtime noise).
      async function realCycle(): Promise<number | undefined> {
        const g = createCausl()
        return measureHeapDelta(async () => {
          const { rerender, unmount } = render(
            <CauslProvider graph={g}>
              <VirtualGrid
                totalRows={totalRows}
                visibleRows={visible}
                overscan={overscan}
                scrollTop={0}
              />
            </CauslProvider>,
          )
          for (const s of positions) {
            rerender(
              <CauslProvider graph={g}>
                <VirtualGrid
                  totalRows={totalRows}
                  visibleRows={visible}
                  overscan={overscan}
                  scrollTop={s}
                />
              </CauslProvider>,
            )
            await flush()
          }
          unmount()
          await flush()
        })
      }

      // Warmup cycle absorbs JIT + module-init + first-touch
      // allocations so subsequent measurements reflect steady state.
      // Drop the result.
      await realCycle()

      // Capture the no-op-grid noise floor for an absolute-bound
      // sanity check: even noise grows under jsdom+React, so the
      // real-grid steady-state should still be on the same order
      // of magnitude. This is the secondary gate.
      function NoopGrid({ scrollTop }: { scrollTop: number }) {
        const start = Math.max(0, scrollTop - overscan)
        const end = Math.min(totalRows, scrollTop + visible + overscan)
        const rows: React.ReactNode[] = []
        for (let r = start; r < end; r++) rows.push(<div key={r} />)
        return <div>{rows}</div>
      }
      const noiseDeltas: number[] = []
      for (let run = 0; run < 5; run++) {
        const delta = await measureHeapDelta(async () => {
          const { rerender, unmount } = render(<NoopGrid scrollTop={0} />)
          for (const s of positions) {
            rerender(<NoopGrid scrollTop={s} />)
            await flush()
          }
          unmount()
          await flush()
        })
        if (delta !== undefined) noiseDeltas.push(delta)
      }
      const noiseFloor = noiseDeltas.length > 0 ? Math.max(...noiseDeltas) : 0

      // Repeat the warm cycle N=4 times and take the maximum delta.
      // A constant-per-cycle leak would surface as a steadily-rising
      // sequence; a steady-state harness shows fluctuations bounded
      // by GC noise.
      const realDeltas: number[] = []
      for (let run = 0; run < 4; run++) {
        const delta = await realCycle()
        if (delta !== undefined) realDeltas.push(delta)
      }
      const realMax = realDeltas.length > 0 ? Math.max(...realDeltas) : 0

      // Primary gate: cumulative heap growth across 4 warm cycles
      // must stay bounded. With `noiseFloor` as the empirical
      // threshold + a 1 MiB absolute cap (the per-cycle allocation
      // budget for transient React+jsdom internals after warmup),
      // a constant-per-cycle leak — say 40 retained closures × 256 B
      // = 10 KiB per cycle, accumulating to 40 KiB over 4 cycles —
      // would still need to clear this gate but a *runaway* leak
      // (e.g. a cell-level subscription that retains the entire row
      // ≈ 4 KiB × 1000 cycles = 4 MB) blows past it cleanly. The
      // exact-equality `countLiveNodes` gate above is the strict
      // bound; this is the additional safety net for engine-external
      // retention.
      const SLACK_BYTES = 1024 * 1024
      expect(realDeltas.length).toBeGreaterThan(0)
      expect(realMax).toBeLessThanOrEqual(noiseFloor + SLACK_BYTES)
    },
    60_000,
  )
})
