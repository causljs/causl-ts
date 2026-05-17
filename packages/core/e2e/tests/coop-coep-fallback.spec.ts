/**
 * COOP/COEP fallback acceptance gate — Playwright spec pinning the
 * epic #1558 boundary rewrite against a non-cross-origin-isolated
 * host.
 *
 * Sub-issue: #1565 (epic #1558).
 * Acceptance gate: when the page is NOT served from a
 *   cross-origin-isolated origin (no COOP/COEP headers,
 *   `crossOriginIsolated === false`, `SharedArrayBuffer` either
 *   unavailable or unusable), `loadWasmBackend()` must still return
 *   a usable backend and `detectBridge()` must pick a non-shared
 *   bridge id (`wasmgc-builtins` or `wasmgc-classic`). The init
 *   path must not construct a `SharedArrayBuffer` — failing-quiet
 *   with a degraded backend is just as bad as throwing.
 *
 * Expected initial state: skipped. The shared-memory variant
 * `loadWasmBackend()` falls back FROM doesn't exist yet (Phase 6 of
 * epic #1558), so the fallback gate is meaningless without the
 * upstream variant. The suite is guarded by `test.describe.skip(...)`
 * so the spec is discoverable on `playwright test --list` — the §14
 * acceptance row is populated and flips live the moment Phase 6
 * lands.
 */
import { expect, test } from '@playwright/test'

interface TestHook {
  readonly loaded: boolean
  readonly bridge: 'wasmgc-builtins' | 'wasmgc-classic' | 'serde-json' | null
  readonly crossOriginIsolated: boolean
  readonly sabAttempts: readonly { readonly size: number; readonly stack: string }[]
  readonly error: string | null
}

declare global {
  interface Window {
    testHook: TestHook
  }
}

test.describe.skip(
  'epic #1558 #1565 COOP/COEP fallback (shared-memory variant not shipped yet — Phase 6)',
  () => {
    test('loadWasmBackend() succeeds on non-isolated origin', async ({
      page,
    }) => {
      page.on('pageerror', (err) => {
        // eslint-disable-next-line no-console
        console.log(`[coop-coep-fallback pageerror] ${err.message}`)
      })

      await page.goto('/packages/core/e2e/fixtures/coop-coep-fallback.html')
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      const hook: TestHook = await page.evaluate(() => window.testHook)

      // Static Python http.server emits no COOP/COEP headers, so the
      // page must report cross-origin-non-isolated.
      expect(hook.crossOriginIsolated).toBe(false)
      // The backend must still have loaded successfully — that's
      // the whole point of the fallback.
      expect(hook.error).toBeNull()
      expect(hook.loaded).toBe(true)
    })

    test('detectBridge() returns a non-shared-memory bridge id', async ({
      page,
    }) => {
      await page.goto('/packages/core/e2e/fixtures/coop-coep-fallback.html')
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      const hook: TestHook = await page.evaluate(() => window.testHook)

      // The bridge id must be one of the non-shared-memory bridges.
      // `serde-json` is the conservative WebAssembly-1.0 fallback;
      // post-Phase-6 the picker should preferentially pick one of
      // the WasmGC bridges when the host supports them but neither
      // option requires SharedArrayBuffer.
      expect(hook.bridge).not.toBeNull()
      expect(['wasmgc-builtins', 'wasmgc-classic']).toContain(hook.bridge)
    })

    test('init path never constructs SharedArrayBuffer', async ({ page }) => {
      await page.goto('/packages/core/e2e/fixtures/coop-coep-fallback.html')
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      const hook: TestHook = await page.evaluate(() => window.testHook)

      // The fixture installed a Proxy on the SharedArrayBuffer
      // constructor that records every `new SharedArrayBuffer(...)`
      // call. Failing-quiet (constructing the SAB, catching the
      // failure, falling back) is just as bad as throwing — the
      // contract is "the fallback path doesn't touch shared
      // memory at all."
      expect(hook.sabAttempts.length).toBe(0)
    })
  },
)
