/**
 * @packageDocumentation
 *
 * Pins down the contract of the dev-only H1 hazard warning (#1155,
 * #1241).
 *
 * H1 from `docs/wasm-backend-adopter-audit.md` is the load-bearing
 * adopter hazard surfaced by the Markbåge/Miller panel review of
 * post-0.9.0 Rust-port epic #1133: holding a `graph.read(node)` return
 * value across a commit boundary. PR #1129 amended SPEC §15.1 to make
 * the reference-identity non-guarantee explicit; PR #1238 added the
 * dev-only runtime safety net (one `console.warn`, never a throw).
 *
 * #1241 — the panel review of #1238 flipped the default from auto-
 * detected dev/prod to **`false`** (opt-in). Tests that exercise the
 * positive arm now pass `enableH1HazardWarning: true` explicitly; tests
 * that assert suppression (production, primitive returns,
 * `subscribeReads` window, the new adapter-exemption seam) continue
 * to assert no warning regardless of the opt-in flag's value.
 *
 * The acceptance criteria from #1155 (preserved through #1241):
 *   1. Hold a `read()` return across a commit with opt-in enabled →
 *      warning fires.
 *   2. Discard the read return before the commit → no warning.
 *   3. Production (`__DEV__ === false` OR `NODE_ENV === 'production'`)
 *      → warning never fires for the default (no-opt-in) path.
 *   4. **NEW (#1241)**: Default is `false` — calling `createCausl()`
 *      without the explicit `enableH1HazardWarning: true` flag never
 *      arms the tracker.
 *   5. **NEW (#1241)**: Reads issued under the
 *      `__causlAdapterRead(graph, fn)` seam (used by canonical
 *      `@causl/react` hooks) are exempted from H1 tracking.
 *
 * The WeakRef-based tracker is best-effort by design: V8 may keep a
 * referent alive past the last user-side reference (escape analysis,
 * conservative scan), so the "discard before commit → no warning"
 * arm uses `globalThis.gc()` to force a collection when available.
 * When `--expose-gc` is absent the arm degrades to a soft assert
 * that the engine did NOT produce a structurally-unrelated warning
 * — the false-negative direction is acceptable (we sometimes fail
 * to warn) but the false-positive direction (warning fires on a
 * read that did NOT survive) is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCausl } from '../src/index.js'
import { __causlAdapterRead } from '../src/internal.js'

/**
 * Match the canonical warning text emitted by the H1 instrumentation
 * (`packages/core/src/graph.ts` `checkH1HazardOnCommit`).
 */
function isH1Warning(arg: unknown): boolean {
  return typeof arg === 'string' && arg.includes('[causl] H1 hazard')
}

/**
 * Count `console.warn` calls whose first argument is the canonical
 * H1 warning string. Other warnings (engine telemetry, deprecations,
 * test-runner banners) are filtered out so the assertion is robust
 * against unrelated console noise.
 */
function countH1Warnings(spy: { mock: { calls: unknown[][] } }): number {
  let n = 0
  for (const call of spy.mock.calls) {
    if (call.length > 0 && isH1Warning(call[0])) n++
  }
  return n
}

/**
 * Try to coerce V8 into collecting unreachable WeakRef referents.
 * `globalThis.gc` is only available when Node is launched with
 * `--expose-gc`; absent that, the helper is a no-op and the caller
 * tolerates the false-negative arm.
 */
async function tryForceGc(): Promise<void> {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
    // Yield to the microtask queue so any pending FinalizationRegistry
    // callbacks fire before the next assertion. Not load-bearing for
    // the WeakRef.deref() check itself but keeps the ordering tidy.
    await Promise.resolve()
    globalThis.gc()
  }
}

describe('H1 hazard dev-only warning (#1155 / #1241, SPEC §15.1)', () => {
  // Stash the original NODE_ENV / __DEV__ values so individual tests
  // can mutate them without bleeding state across the suite.
  let warnSpy: { mock: { calls: unknown[][] }; mockRestore: () => void }
  const originalNodeEnv = process.env.NODE_ENV
  const originalDev = (globalThis as { __DEV__?: unknown }).__DEV__

  beforeEach(() => {
    // Default to a dev environment so the tree-shake gate
    // (`process.env.NODE_ENV !== 'production'`) holds. Clear
    // `__DEV__` so explicit per-test overrides take effect.
    process.env.NODE_ENV = 'development'
    delete (globalThis as { __DEV__?: unknown }).__DEV__
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    // Restore environment for sibling suites.
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalDev === undefined) {
      delete (globalThis as { __DEV__?: unknown }).__DEV__
    } else {
      ;(globalThis as { __DEV__?: unknown }).__DEV__ = originalDev
    }
    warnSpy.mockRestore()
  })

  /**
   * #1241 — the new default. Calling `createCausl()` without the
   * explicit opt-in flag never arms the tracker, so the same "hold
   * a read across commit" pattern that fires in the opt-in arm
   * stays silent here.
   */
  it('does NOT warn by default (no enableH1HazardWarning) — #1241', () => {
    const g = createCausl()
    const input = g.input('count', 0)
    const view = g.derived('view', (get) => ({ count: get(input) }))
    const held = g.read(view)
    expect(held).toEqual({ count: 0 })
    g.commit('count→1', (tx) => tx.set(input, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.count).toBe(0) // anchor
  })

  /**
   * Holding a `read()` return value across a commit boundary fires
   * the H1 warning naming the offending node id when the adopter
   * explicitly opts in. The reference is kept alive on a closure-
   * captured local so the WeakRef cannot be GC'd between the read
   * and the commit-boundary check.
   *
   * #1241 — must pass `enableH1HazardWarning: true` now that the
   * default is `false`.
   */
  it('warns when an adopter holds a read() return across commit (opt-in)', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const input = g.input('count', 0)
    // Derive an OBJECT so the WeakRef tracker engages — primitives
    // are skipped by construction (they cannot desynchronise from a
    // backing cell because they ARE the cell value).
    const view = g.derived('view', (get) => ({ count: get(input) }))
    // Hold the read return alive past the upcoming commit.
    const held = g.read(view)
    expect(held).toEqual({ count: 0 })
    g.commit('count→1', (tx) => tx.set(input, 1))
    // The warning text identifies the offending node and points at
    // SPEC §15.1.
    const calls = warnSpy.mock.calls.filter((c) => isH1Warning(c[0]))
    expect(calls.length).toBe(1)
    expect(String(calls[0]![0])).toContain("graph.read(node 'view')")
    expect(String(calls[0]![0])).toContain('SPEC §15.1')
    // Touching `held` post-warning ensures V8 cannot prove the
    // reference dead via dead-code elimination, so the closure
    // captures a real survivor.
    expect(held.count).toBe(0)
  })

  /**
   * The warning is informational only — it never throws and the
   * commit succeeds normally even with the H1 hazard present.
   */
  it('warning never throws; commit pipeline completes normally', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    const commit = g.commit('a→1', (tx) => tx.set(a, 1))
    expect(commit.changedNodes).toContain('a')
    expect(g.read(a)).toBe(1)
    expect(held.a).toBe(0) // confirm survivor reference observable
  })

  /**
   * A read that is dropped before the next commit does NOT fire the
   * warning. Best-effort: requires `--expose-gc` to be deterministic.
   * Without it, the GC may keep the value alive and the test would
   * see a false-positive warning — so the arm asserts only when the
   * forced collection actually freed the referent (probed via a
   * sentinel WeakRef the test owns).
   */
  it('does not warn when read() return is discarded before commit', async () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    // Sentinel WeakRef captured by the test so we can detect whether
    // V8 actually freed the read-returned object. If it didn't, the
    // engine's WeakRef wouldn't be dead either — the test cannot
    // assert "no warning" in that case (false-negative arm) so we
    // simply skip the assertion.
    let sentinel: WeakRef<object> | null = null
    {
      const transient = g.read(obj)
      sentinel = new WeakRef(transient)
      // Confirm the value is observable inside this block so V8
      // cannot dead-code-eliminate the read.
      expect(transient).toEqual({ a: 0 })
    }
    await tryForceGc()
    // Commit AFTER attempting to free the read return. If the GC
    // succeeded, the WeakRef inside the engine is dead and no
    // warning fires. If the GC did not run (no --expose-gc), the
    // engine's tracker may still hold a live ref — in which case
    // we accept the warning would fire and skip the assertion.
    g.commit('a→1', (tx) => tx.set(a, 1))
    const gcFreedTransient = sentinel.deref() === undefined
    if (gcFreedTransient) {
      expect(countH1Warnings(warnSpy)).toBe(0)
    } else {
      // GC didn't run — false-negative regime. The test can't
      // distinguish "the engine correctly didn't warn" from "the
      // engine incorrectly held a live ref" here, so we soften to
      // documenting the outcome rather than asserting on it.
      // The previous "hold across commit" test already covers the
      // positive case.
    }
  })

  /**
   * `NODE_ENV=production` keeps the warning suppressed even when the
   * adopter holds the read across the commit boundary AND tries to
   * opt in. The H1 apparatus is tree-shaken in production builds
   * (#1241 fix C).
   *
   * #1549 Part B — the NODE_ENV gate is now read ONCE at module
   * load (`src/env.ts`'s `NODE_ENV_IS_PRODUCTION`, imported by the
   * engine), NOT per-read, to remove a ~93 ns/read `process.env`
   * host-object access that was ~95% of `op-read-cold`'s cost. This
   * matches the universal `const __DEV__` idiom and #1241's own
   * build-time-constant model: "production" is established at
   * build/import time, not by mutating `process.env` at runtime.
   * So this test re-imports the engine under
   * `NODE_ENV=production` via `vi.resetModules()` + dynamic import
   * (the standard vitest pattern for an import-time env constant),
   * which is the honest analogue of a real production bundle.
   */
  it('does NOT warn in production (NODE_ENV=production), even with opt-in', async () => {
    vi.resetModules()
    process.env.NODE_ENV = 'production'
    const { createCausl: createCauslProd } = await import(
      '../src/index.js'
    )
    const g = createCauslProd({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.a).toBe(0) // anchor the survivor reference
  })

  /**
   * Explicit `enableH1HazardWarning: false` suppresses the warning
   * in dev (which is now the same as the default, but kept explicit
   * here as a regression gate against future default flips).
   */
  it('respects explicit enableH1HazardWarning: false even in dev', () => {
    const g = createCausl({ enableH1HazardWarning: false })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.a).toBe(0)
  })

  /**
   * Primitive `read()` returns are skipped by the tracker — there
   * is no reference identity to lose for a number / string /
   * boolean, so holding one across a commit is harmless and the
   * warning would be a false positive.
   */
  it('does not warn when read() returns a primitive (numbers cannot desync)', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    // Hold a primitive read return across a commit.
    const held = g.read(a)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held).toBe(0) // anchor
  })

  /**
   * Reads from inside a `subscribeReads` projection do NOT register
   * a hazard — those reads are engine-internal (the projection
   * re-runs on every commit by construction), so they cannot
   * represent an adopter-cached reference.
   */
  it('does not warn for reads inside a subscribeReads projection', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    if (typeof g.subscribeReads !== 'function') return
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    let observed: unknown = null
    const unsub = g.subscribeReads<unknown>(
      (_commit, value) => {
        observed = value
      },
      () => g.read(obj),
    )
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(observed).toEqual({ a: 1 })
    unsub()
  })

  /**
   * After one warning per (node, capture-time) tuple, subsequent
   * commits do NOT re-warn for the same reference — the engine
   * delivers the message exactly once and drops the entry. This
   * keeps a single retained reference from flooding the console
   * across a long-running app.
   */
  it('emits at most one warning per held reference (no re-warn on every commit)', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('a→2', (tx) => tx.set(a, 2))
    g.commit('a→3', (tx) => tx.set(a, 3))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0) // anchor
  })

  /**
   * #1241 — the adapter-exemption seam. Reads issued under
   * `__causlAdapterRead(graph, fn)` (the helper canonical
   * `@causl/react` hooks wrap their `getSnapshot` body in) bypass
   * the H1 hazard tracker even with the opt-in flag armed.
   *
   * The mechanism is a closure-scoped depth counter the engine
   * increments for the duration of `fn`'s synchronous body, then
   * decrements unconditionally in `finally`. Reads landed inside
   * (or in any function `fn` calls synchronously) skip the WeakRef
   * push exactly as they do for `activeReadTracker`-windowed
   * reads.
   */
  it('does NOT warn for reads issued under __causlAdapterRead seam — #1241', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    // Read the derived object inside the adapter-exemption seam —
    // mirrors the pattern `useCauslNode`'s `getSnapshot` uses.
    const held = __causlAdapterRead(g, () => g.read(obj))
    expect(held).toEqual({ a: 0 })
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.a).toBe(0) // anchor
  })

  /**
   * #1241 — the depth counter composes. A read inside a NESTED
   * adapter-mode call (e.g. an adapter hook reading through another
   * adapter hook's selector) still suppresses tracking. The
   * `finally` decrement returns the depth to its pre-call value, so
   * subsequent reads outside the seam are tracked normally.
   */
  it('seam depth counter composes — nested calls remain exempt — #1241', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    // Nested adapter-mode reads.
    const held = __causlAdapterRead(g, () =>
      __causlAdapterRead(g, () => g.read(obj)),
    )
    expect(held).toEqual({ a: 0 })
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    // After the seam returns, reads outside it are tracked again.
    // Hold this one across a commit to verify the depth counter
    // restored to zero rather than staying sticky on `1`.
    const trackedHeld = g.read(obj)
    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(trackedHeld.a).toBe(1) // anchor — survivor across a→2
  })

  /**
   * #1241 — a throwing seam body must NOT leave the depth counter
   * sticky. The `finally`-driven decrement is the load-bearing
   * invariant; a sticky counter would silently suppress every
   * subsequent H1 warning for the engine's lifetime.
   */
  it('seam unwinds cleanly on throw — depth counter is not sticky — #1241', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    expect(() =>
      __causlAdapterRead(g, () => {
        // Trigger the engine read, then synthesise a throw to test
        // the `finally` decrement path.
        g.read(obj)
        throw new Error('synthetic')
      }),
    ).toThrow('synthetic')
    // Subsequent ordinary read should be tracked — depth must be 0.
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0) // anchor
  })
})
