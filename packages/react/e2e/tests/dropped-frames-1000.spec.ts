/**
 * 1000-cell cross-library dropped-frames gate (#869, extending the
 * causl-only #765 / PR #800 gate to jotai / redux / mobx).
 *
 * Why this file exists:
 *
 * - PR #800 shipped the original gate against `useCauslNode` only.
 *   #869 extends it to the same React shell × the four canonical
 *   state libraries (causl, jotai, redux, mobx) so the §14
 *   perceptual-perf cell has a cross-library answer to "how does
 *   causl compare to jotai/redux/mobx on a 1000-cell viewport?"
 *   instead of just "causl passes its own gate."
 * - vitest in jsdom cannot observe dropped frames. The unit suite
 *   (`packages/react/test/useCauslNode.test.tsx`) covers the
 *   structural per-node-subscription guarantee for causl; this spec
 *   covers the perceptual-perf gate for all four libraries.
 *
 * What this spec measures (per library variant):
 *
 *   1. **Dropped-frame ratio** — frames whose inter-rAF delta exceeds
 *      the per-frame budget. The budget is 16.6ms × 3 (= 50ms) to
 *      absorb developer-machine jitter. Threshold ≤ 5%.
 *   2. **p95 commit-to-paint** — the 95th percentile of
 *      "commit-issue → next rAF" times. Bounded at 16ms because the
 *      acceptance criterion is "fits in one vsync at 60Hz".
 *
 * Each library variant runs as its own Playwright test inside a
 * `test.describe.parallel` block. The shared `playwright.config.ts`
 * pins `workers: 1`, so "parallel" only affects logical grouping —
 * the runs execute sequentially against a single Chromium instance
 * to avoid cross-test CPU contention that would manufacture flake.
 * The describe.parallel form is preserved so the matrix shows up as
 * four sibling tests in the report rather than four serial cases of
 * one parameterised test (a regression in any one library should be
 * named explicitly in the failure summary).
 */
import { expect, test } from '@playwright/test'

interface HarnessSamples {
  readonly frameTimes: number[]
  readonly commitToPaint: number[]
  readonly committed: number
  readonly lib: LibName
}

declare global {
  interface Window {
    runHarness(durationMs: number, frequencyHz?: number): Promise<HarnessSamples>
  }
}

/**
 * Per-frame budget in milliseconds. 16.6ms is one vsync at 60Hz; the
 * 3x multiplier absorbs scheduler jitter on developer machines (Chrome
 * tabs, Spotlight indexing, virtualization on Apple Silicon). Frames
 * whose inter-rAF delta exceeds this budget count as dropped.
 *
 * Same multiplier as `packages/formula/e2e/tests/dropped-frames.spec.ts`
 * uses (50ms) — the gate is "do we hit vsync within a 3-vsync
 * tolerance band?", not "do we hit vsync to the millisecond?".
 */
const FRAME_BUDGET_MS = 50

/**
 * Maximum tolerated dropped-frame ratio. The 5% threshold matches the
 * §14 perceptual-perf cell's headline number — anything higher means
 * the per-cell-subscription path is regressing back toward the
 * selector-fan-out cost that motivated `useCauslNode` in the first
 * place. The same threshold applies cross-library: a regression in
 * any of the four libraries (or a regression in causl that lets
 * jotai/redux/mobx pass when causl no longer does) should fail this.
 */
const MAX_DROPPED_RATIO = 0.05

/**
 * p95 commit-to-paint ceiling in milliseconds. The acceptance criterion
 * is "one vsync at 60Hz" — 16.6ms — and we round to 16ms for the
 * threshold constant. Same gate cross-library.
 */
const MAX_P95_COMMIT_TO_PAINT_MS = 16

/**
 * Run duration. The acceptance criterion is 30s explicitly; any
 * shorter and the dropped-frame ratio loses statistical meaning, any
 * longer and CI cost balloons without proportionate signal.
 */
const RUN_DURATION_MS = 30_000

/**
 * Warmup duration. The first ~500ms of a fresh page load are
 * dominated by V8 lazy compilation, React's first reconcile of 1000
 * mounted cells, and module-init allocations — none of which are the
 * steady-state cost the gate is measuring. Discarding the warmup
 * isolates the engine cost the §14 invariant is about.
 */
const WARMUP_MS = 1_500

/**
 * Library variants the matrix covers. The fixture's `?lib=...` query
 * param dispatches to the matching mount path; the spec navigates to
 * the same HTML with a different query string per variant.
 */
type LibName = 'causl' | 'jotai' | 'redux' | 'mobx'
const LIBS: readonly LibName[] = ['causl', 'jotai', 'redux', 'mobx']

/**
 * Compute the p95 of a sample array. Linear-interpolation on the
 * sorted array; the standard textbook definition. Returns 0 for an
 * empty input rather than NaN so the assertion later doesn't trip on
 * a degenerate harness output (the test would have already failed on
 * the sample-count check upstream).
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]!
  const frac = rank - low
  return sorted[low]! * (1 - frac) + sorted[high]! * frac
}

test.describe.parallel('1000-cell viewport holds 60fps under per-cell subscription', () => {
  for (const lib of LIBS) {
    test(`${lib}: 1000-cell viewport @60Hz`, async ({ page }) => {
      // Surface page-side errors (e.g. mount failure of the bundle) into
      // the test log so a regression in the fixture itself fails loudly
      // rather than timing out on `harness ready`.
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          // eslint-disable-next-line no-console
          console.log(`[${lib} page console.${msg.type()}] ${msg.text()}`)
        }
      })
      page.on('pageerror', (err) => {
        // eslint-disable-next-line no-console
        console.log(`[${lib} pageerror] ${err.message}`)
      })

      await page.goto(
        `/packages/react/e2e/fixtures/viewport-1000.html?lib=${lib}`,
      )
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      // Sanity-check the URL param survived the bundle's mount path —
      // the fixture marks the active library on `<html data-lib>`.
      const observedLib = await page.evaluate(
        () => document.documentElement.dataset['lib'],
      )
      expect(observedLib).toBe(lib)

      // Warmup run. Discarding the result isolates steady-state cost
      // from one-shot mount + JIT cost. We use the harness itself rather
      // than a synthetic warmup so the same code path is hot on the
      // measured run.
      await page.evaluate((ms) => window.runHarness(ms), WARMUP_MS)

      const samples: HarnessSamples = await page.evaluate(
        (ms) => window.runHarness(ms),
        RUN_DURATION_MS,
      )

      const { frameTimes, commitToPaint, committed } = samples
      // A 30s run at 60Hz should produce roughly 1800 frames. Allow a
      // generous floor (≥ 600 frames = ~33% of theoretical) so the spec
      // does not pass on a degenerate run that produced no signal.
      expect(frameTimes.length).toBeGreaterThan(600)
      // The commit-to-paint sample count is one fewer than the frame
      // count (no prior commit on the very first rAF). Floor of 599
      // matches the frame floor minus one.
      expect(commitToPaint.length).toBeGreaterThan(599)
      // We should have committed roughly one bump per frame.
      expect(committed).toBeGreaterThan(600)
      expect(samples.lib).toBe(lib)

      let dropped = 0
      for (let i = 1; i < frameTimes.length; i++) {
        const delta = frameTimes[i]! - frameTimes[i - 1]!
        if (delta > FRAME_BUDGET_MS) dropped += 1
      }
      const ratio = dropped / (frameTimes.length - 1)
      const p95 = percentile(commitToPaint, 95)
      const p50 = percentile(commitToPaint, 50)
      const p99 = percentile(commitToPaint, 99)

      // Surface the observed numbers. When the gate fails, a reviewer
      // needs the rate + the p95 at a glance, not a stack trace. When the
      // gate passes, this is the number we paste into the PR body so the
      // §14 cell's measurement provenance is recorded next to the gate it
      // satisfies.
      // eslint-disable-next-line no-console
      console.log(
        `[#869 1000-cell @60Hz, ${RUN_DURATION_MS / 1000}s, lib=${lib}] ` +
          `frames=${frameTimes.length} ` +
          `committed=${committed} ` +
          `dropped=${dropped} ratio=${(ratio * 100).toFixed(2)}% ` +
          `commit→paint p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms ` +
          `(budget=${FRAME_BUDGET_MS}ms drop≤${MAX_DROPPED_RATIO * 100}% p95≤${MAX_P95_COMMIT_TO_PAINT_MS}ms)`,
      )

      expect(ratio).toBeLessThanOrEqual(MAX_DROPPED_RATIO)
      expect(p95).toBeLessThanOrEqual(MAX_P95_COMMIT_TO_PAINT_MS)
    })
  }
})
