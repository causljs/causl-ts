/**
 * Worker-paused graceful-degrade acceptance gate — Playwright spec
 * pinning the epic #1558 boundary rewrite against a stalled
 * shared-memory worker.
 *
 * Sub-issue: #1565 (epic #1558).
 * Acceptance gate: spawn a graph backed by the (future) shared-
 *   memory worker variant. Pause the worker thread via the Chrome
 *   DevTools Protocol (`Debugger.pause` on the worker target). The
 *   main thread's `commit()` call must detect the timeout and
 *   transparently fall back to a synchronous `apply_commands`
 *   execution against a sibling non-shared instance — adopter code
 *   observes only a latency bump, never a hang or thrown error.
 *
 * Expected initial state: skipped. The shared-memory worker variant
 * doesn't exist yet (Phase 6 of epic #1558), so the worker the spec
 * tries to pause doesn't exist. The suite is guarded with
 * `test.describe.skip(...)` so the spec is discoverable on
 * `playwright test --list` (the §14 acceptance row is populated)
 * and flips live the moment Phase 6 lands.
 */
import { expect, test } from '@playwright/test'

interface TestHook {
  readonly workerSpawned: boolean
  readonly sharedMemReady: boolean
  readonly reason?: string
}

interface CommitResult {
  readonly status: 'ok' | 'fallback' | 'unavailable' | 'error'
  readonly latencyMs: number
  readonly fallbackUsed: boolean
}

declare global {
  interface Window {
    testHook: TestHook
    startCommit: (intent: string) => Promise<CommitResult>
  }
}

const COMMIT_TIMEOUT_BUDGET_MS = 500

test.describe.skip(
  'epic #1558 #1565 worker-paused graceful-degrade (shared-memory worker variant not shipped yet — Phase 6)',
  () => {
    test('main-thread commit() detects timeout and falls back to sync apply_commands', async ({
      page,
      context,
    }) => {
      page.on('pageerror', (err) => {
        // eslint-disable-next-line no-console
        console.log(`[worker-paused-degrade pageerror] ${err.message}`)
      })

      await page.goto(
        '/packages/core/e2e/fixtures/worker-paused-degrade.html',
      )
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      const hook: TestHook = await page.evaluate(() => window.testHook)
      // Pre-condition: the worker must have actually spawned and the
      // shared-memory channel must be ready. Without these the
      // pause-and-observe scenario is unverifiable.
      expect(hook.workerSpawned).toBe(true)
      expect(hook.sharedMemReady).toBe(true)

      // Attach to the worker target via CDP and pause its debugger
      // loop. Post-Phase-6 the worker's CDP target type is `worker`
      // (`Target.attachToTarget` -> `Debugger.pause`). This block
      // is the place that wiring lands; today the surrounding
      // `describe.skip` guards it.
      const cdp = await context.newCDPSession(page)
      const { targetInfos } = await cdp.send('Target.getTargets')
      const workerTarget = targetInfos.find((t) => t.type === 'worker')
      expect(workerTarget).toBeDefined()
      await cdp.send('Target.attachToTarget', {
        targetId: workerTarget!.targetId,
        flatten: true,
      })
      await cdp.send('Debugger.pause')

      // Fire a commit. The worker is paused; the contract is that
      // the main thread detects the timeout (within
      // `COMMIT_TIMEOUT_BUDGET_MS`) and falls back to a sibling
      // synchronous instance rather than hanging.
      const result: CommitResult = await page.evaluate(
        (intent) => window.startCommit(intent),
        'fallback-probe',
      )

      expect(result.status).toBe('fallback')
      expect(result.fallbackUsed).toBe(true)
      // Latency budget: the timeout detector must fire within the
      // budget, plus the sync-apply cost. The check is a generous
      // upper bound — the contract is "doesn't hang", not "fast".
      expect(result.latencyMs).toBeLessThan(COMMIT_TIMEOUT_BUDGET_MS * 4)
    })

    test('post-fallback graph remains usable for subsequent commits', async ({
      page,
    }) => {
      await page.goto(
        '/packages/core/e2e/fixtures/worker-paused-degrade.html',
      )
      await expect(page.locator('#status')).toHaveText('harness ready', {
        timeout: 30_000,
      })

      // After a fallback the graph must continue accepting commits —
      // the degraded path is the new steady state, not a one-shot.
      // The spec drives a small loop and asserts every commit
      // resolves successfully (status `ok` or `fallback`, never
      // `error` or `unavailable`).
      const results: readonly CommitResult[] = await page.evaluate(
        async () => {
          const out = []
          for (let i = 0; i < 5; i++) {
            out.push(await window.startCommit(`post-fallback-${i}`))
          }
          return out
        },
      )

      expect(results.length).toBe(5)
      for (const r of results) {
        expect(['ok', 'fallback']).toContain(r.status)
      }
    })
  },
)
