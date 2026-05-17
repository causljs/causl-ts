/**
 * @packageDocumentation
 *
 * Playwright config for the `@causl/react` 1000-cell `useCauslNode`
 * dropped-frames gate (#765, deferred from #677 / PR #737).
 *
 * Mirrors `packages/formula/e2e/playwright.config.ts` — same single-
 * worker discipline (the dropped-frame ratio is sensitive to
 * shared-runner CPU contention, so parallel specs would manufacture
 * flake), same Python static-server layout (no Node static-server tax),
 * same loopback bind. The differences vs. the formula config:
 *
 *   - Different `baseURL` port (4174 instead of 4173) so a developer
 *     running both suites in adjacent terminals doesn't get a port
 *     collision.
 *   - `globalSetup` script that bundles `viewport-1000.tsx` into the
 *     fixture's `viewport-1000.js` before the test runs, so the
 *     harness fetches a hermetic ESM module that doesn't depend on an
 *     importmap or UMD shim.
 *   - 90s test timeout — the run itself is 30s plus warmup plus React
 *     mount of 1000 cells, so the default 30s timeout is too tight.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  /**
   * Single worker because the dropped-frame ratio is sensitive to
   * shared-runner CPU contention. Same reasoning as the formula
   * harness.
   */
  workers: 1,
  /**
   * One retry on the perceptual-perf gate. The ≤ 5% threshold on a
   * 1000-cell viewport is tighter than the formula harness' 10% / 50ms
   * pair, so retries are smaller (one, not two) — a real regression
   * should not survive a single retry on a quiet runner. CI is offline
   * (#725); the retries cover developer-machine noise (browser tabs,
   * macOS Spotlight indexing, etc.).
   */
  retries: 1,
  /**
   * 90s test timeout. The harness runs for 30s, plus warmup and React
   * mount of 1000 cells. The default 30s timeout would race the run
   * itself; 90s leaves a comfortable margin.
   */
  timeout: 90_000,
  /**
   * Build the fixture bundle before any tests run. The bundle is
   * deterministic — `viewport-1000.tsx` does not depend on test
   * inputs — so building once at globalSetup is enough; the fixture
   * does not need a watch loop.
   */
  globalSetup: './global-setup.ts',
  use: {
    headless: true,
    /**
     * Page URL prefix. The harness page is served at
     * `/packages/react/e2e/fixtures/viewport-1000.html` from the repo
     * root, which is why the `webServer.cwd` below is the repo root.
     */
    baseURL: 'http://127.0.0.1:4174',
  },
  webServer: {
    /**
     * `python3 -m http.server` is the smallest cross-runner static
     * file server I trust, same idiom as the formula harness. Bound
     * to loopback, fixed port, repo root as cwd.
     */
    command: 'python3 -m http.server 4174 --bind 127.0.0.1',
    cwd: '../../..',
    port: 4174,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
})
