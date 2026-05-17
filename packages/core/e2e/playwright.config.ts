/**
 * @packageDocumentation
 *
 * Playwright config for the `@causljs/core` boundary-rewrite e2e
 * suite (epic #1558 sub-issue #1565 — COOP/COEP fallback +
 * worker-paused-degrade acceptance).
 *
 * Mirrors `packages/bench/e2e/playwright.config.ts` (which itself
 * mirrors the React harness) — same Python static-server layout,
 * loopback bind, single-worker discipline. Differences vs. the
 * bench config:
 *
 *   - Different port (4176) so a developer running the formula,
 *     react, bench, and core e2e suites in adjacent terminals does
 *     not hit a port collision (4173 / 4174 / 4175 / 4176).
 *   - The webServer's `cwd` is the repo root — the harness pages
 *     are served at `/packages/core/e2e/fixtures/*.html` and the
 *     WASM artifacts at `/packages/core/wasm-pkg/...`, both
 *     reachable from a single static-server root.
 *   - 60s test timeout — these specs are correctness gates, not
 *     perceptual-perf gates, so the long-tail allowance the
 *     viewport-1000 mirror needs (90s) is not required here.
 *   - `globalSetup` ensures `@causljs/core`'s `dist/index.js` exists
 *     before any test runs. On a fresh checkout `dist/` may not
 *     have been built yet; the setup defensively runs `pnpm
 *     --filter @causljs/core build` rather than expecting the
 *     adopter to have run the workspace build first.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  /**
   * Single worker because the COOP/COEP probe spins a fresh
   * Chromium context per spec and the worker-paused-degrade case
   * uses CDP to pin/resume a real thread — both are sensitive to
   * shared-context contention and would manufacture flakes under
   * a parallel runner.
   */
  workers: 1,
  /**
   * One retry. Same reasoning as the bench config — a real
   * regression should not survive a single retry on a quiet runner;
   * the retry absorbs developer-machine noise (browser tabs,
   * macOS Spotlight indexing).
   */
  retries: 1,
  /**
   * 60s test timeout per case. These are correctness gates rather
   * than perf gates; the long tail comes from WASM module fetch +
   * compile, not from a 30s sustained-perf harness.
   */
  timeout: 60_000,
  /**
   * Ensure `@causljs/core`'s `dist/` is built before any test runs.
   * Fresh checkouts don't have `dist/index.js` yet.
   */
  globalSetup: './global-setup.ts',
  use: {
    headless: true,
    /**
     * Page URL prefix. Harness pages are served at
     * `/packages/core/e2e/fixtures/*.html` from the repo root,
     * which is why `webServer.cwd` is the repo root.
     */
    baseURL: 'http://127.0.0.1:4176',
  },
  webServer: {
    /**
     * `python3 -m http.server` is the smallest cross-runner static
     * file server I trust. Bound to loopback, fixed port, repo
     * root as cwd. Importantly: this server emits NO COOP/COEP
     * headers, which is *exactly* what the #1565 fallback case
     * needs to assert against (the non-isolated origin path must
     * still load a usable WASM bridge).
     */
    command: 'python3 -m http.server 4176 --bind 127.0.0.1',
    cwd: '../../..',
    port: 4176,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
})
