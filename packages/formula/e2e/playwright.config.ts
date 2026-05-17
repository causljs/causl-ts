/**
 * @packageDocumentation
 *
 * Playwright config for the `@causljs/formula` 60fps dropped-frame
 * harness (#226, closing the perceptual-perf slot of #149).
 *
 * Why a separate Playwright project from the vitest unit suite: a 60fps
 * gate is a browser-level observation. It needs a real compositor, a
 * `requestAnimationFrame` clock pinned to vsync, and per-frame budget
 * accounting. Userland `requestAnimationFrame` polyfills inside vitest +
 * happy-dom are `setTimeout` in a costume — they cannot share the
 * main-thread budget with layout/paint and cannot observe
 * compositor-induced drops. The only honest observation is the one
 * Chromium itself emits, so the gate runs in headless Chromium.
 *
 * Why a Python `http.server` `webServer`: the harness page is a static
 * HTML fixture that imports the built `@causljs/core` ESM via a
 * relative path served from the monorepo root. A trivial static server
 * is enough — we are not exercising any backend, only feeding the
 * browser the modules it needs to mount the diamond demo. Python ships
 * on every Ubuntu/macOS runner the rest of CI uses, so adding a Node
 * static-server dep would be pure tax.
 *
 * Discovery: tests live under `tests/`. Fixtures (the harness HTML page)
 * live under `fixtures/`. The split mirrors `packages/bench/e2e/` so
 * future DOM-rendering harnesses (#173) can adopt the same layout.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  /**
   * Single worker because the dropped-frame ratio is sensitive to
   * shared-runner CPU contention. Running specs in parallel inside one
   * runner would let one spec's commit loop steal frame budget from
   * another's, manufacturing flakes that mean nothing about the engine.
   */
  workers: 1,
  /**
   * Two retries on the perceptual-perf gate specifically: the
   * dropped-frame ratio is statistical and CI runners are noisy
   * neighbours. A retry budget here trades a small false-negative risk
   * (a real regression flakes its way to green) for a much larger
   * reduction in false positives. The threshold (10% drop ratio against
   * a 50ms budget) is intentionally loose enough that retries should
   * not be hiding regressions; tightening the threshold and dropping
   * retries is the next iteration once runner variance is characterised.
   */
  retries: 2,
  use: {
    headless: true,
    /**
     * Page URL prefix. The harness page is served at
     * `/packages/formula/e2e/fixtures/diamond.html` from the repo root,
     * which is why the `webServer.cwd` below is the repo root.
     */
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    /**
     * `python3 -m http.server` is the smallest cross-runner static file
     * server I trust. Bound to loopback, fixed port, repo root as cwd.
     */
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    cwd: '../../..',
    port: 4173,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
})
