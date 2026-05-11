/**
 * 60fps dropped-frame gate (#226, closing the perceptual-perf slot of
 * #149).
 *
 * Why this file exists and the vitest placeholder doesn't:
 *
 * - vitest in-process + `Date.now()` cannot observe dropped frames. No
 *   compositor, no `requestAnimationFrame` loop pinned to vsync, no
 *   per-frame budget. A 16x regression passes the placeholder. A 1.2x
 *   regression is structurally invisible.
 * - This spec drives the 100-cell diamond inside headless Chromium,
 *   samples per-rAF deltas via `performance.now()`, counts frames
 *   whose delta exceeds the 16.6ms budget (with a 3x tolerance for
 *   shared-runner jitter), and asserts the dropped-frame ratio stays
 *   under 10%.
 *
 * The threshold pair (50ms budget, 10% drop ratio) is intentionally
 * loose. The point of the v0 e2e gate is to catch the failure mode
 * the placeholder cannot — perceptible jank, expressed as a rate —
 * not to compete with tinybench (#146) on micro-benchmark precision.
 * Tightening either knob is a follow-up once runner variance is
 * characterised.
 */
import { expect, test } from '@playwright/test'

/**
 * Per-frame budget in milliseconds. 16.6ms is one vsync at 60Hz; the
 * 3x multiplier absorbs scheduler jitter on shared GitHub Actions
 * runners. Frames whose delta exceeds this budget count as dropped.
 */
const FRAME_BUDGET_MS = 50

/**
 * Maximum tolerated dropped-frame ratio. 10% means up to six dropped
 * frames in a 60-frame (one-second) window are acceptable; anything
 * worse fails the gate.
 */
const MAX_DROPPED_RATIO = 0.1

/**
 * Number of frames sampled per run. 60 frames is one second at vsync,
 * which is enough samples for the ratio to be statistically meaningful
 * without lengthening CI time.
 */
const FRAMES = 60

declare global {
  interface Window {
    runHarness(frames: number): Promise<number[]>
  }
}

test('100-cell diamond holds 60fps under per-frame commit load', async ({ page }) => {
  await page.goto('/packages/formula/e2e/fixtures/diamond.html')
  await expect(page.locator('#status')).toHaveText('harness ready')

  // Warm-up: the very first rAF after a fresh navigation is dominated
  // by V8 lazy-compilation and HTML/JS parse cost. Discarding the
  // first run isolates the steady-state engine cost from one-shot
  // boot cost, which is the cost the §14 invariant is about.
  await page.evaluate((frames) => window.runHarness(frames), 10)

  const samples: number[] = await page.evaluate(
    (frames) => window.runHarness(frames),
    FRAMES,
  )

  expect(samples.length).toBeGreaterThanOrEqual(FRAMES)

  let dropped = 0
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i]! - samples[i - 1]!
    if (delta > FRAME_BUDGET_MS) dropped += 1
  }

  const ratio = dropped / (samples.length - 1)
  // Surface the observed numbers in the test report — when the gate
  // fails, a reviewer needs the rate at a glance, not a stack trace.
  // eslint-disable-next-line no-console
  console.log(
    `dropped=${dropped} of ${samples.length - 1} frames; ratio=${ratio.toFixed(3)} budget=${FRAME_BUDGET_MS}ms`,
  )

  expect(ratio).toBeLessThanOrEqual(MAX_DROPPED_RATIO)
})
