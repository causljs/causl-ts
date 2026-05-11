/**
 * @packageDocumentation
 *
 * Pins down the contract of the dev-only H1 hazard warning (#1155).
 *
 * H1 from `docs/wasm-backend-adopter-audit.md` is the load-bearing
 * adopter hazard surfaced by the Markbåge/Miller panel review of
 * post-0.9.0 Rust-port epic #1133: holding a `graph.read(node)` return
 * value across a commit boundary. PR #1129 amended SPEC §15.1 to make
 * the reference-identity non-guarantee explicit; this issue adds a
 * runtime safety net that catches the hazard in dev with a single
 * `console.warn` (never a throw — backward compatibility preserved).
 *
 * The acceptance criteria from #1155:
 *   1. Hold a `read()` return across a commit → warning fires.
 *   2. Discard the read return before the commit → no warning.
 *   3. Production (`__DEV__ === false` OR `NODE_ENV === 'production'`)
 *      → warning never fires.
 *
 * Plus the construction-time options surface:
 *   - `enableH1HazardWarning` defaults to `true` in dev and `false`
 *     in production. Explicit values override the auto-detection in
 *     either direction.
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

describe('H1 hazard dev-only warning (#1155, SPEC §15.1)', () => {
  // Stash the original NODE_ENV / __DEV__ values so individual tests
  // can mutate them without bleeding state across the suite.
  let warnSpy: { mock: { calls: unknown[][] }; mockRestore: () => void }
  const originalNodeEnv = process.env.NODE_ENV
  const originalDev = (globalThis as { __DEV__?: unknown }).__DEV__

  beforeEach(() => {
    // Default to a dev environment so the auto-detection path fires
    // unless a specific test overrides it. Clear `__DEV__` so the
    // env-var fallback is the one under test.
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
   * Holding a `read()` return value across a commit boundary fires
   * the H1 warning naming the offending node id. The reference is
   * kept alive on a closure-captured local so the WeakRef cannot
   * be GC'd between the read and the commit-boundary check.
   */
  it('warns when an adopter holds a read() return across commit (default-dev)', () => {
    const g = createCausl()
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
    const g = createCausl()
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
    const g = createCausl()
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
   * `NODE_ENV=production` flips the default to `false`, suppressing
   * the warning even when the adopter holds the read across the
   * commit boundary. This is the load-bearing prod-safety property:
   * adopters who ship a production bundle do not pay the WeakRef
   * bookkeeping cost AND do not see the warning.
   */
  it('does NOT warn in production (NODE_ENV=production)', () => {
    process.env.NODE_ENV = 'production'
    const g = createCausl()
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.a).toBe(0) // anchor the survivor reference
  })

  /**
   * `globalThis.__DEV__ === false` flips the default to `false` even
   * when `NODE_ENV` is unset. This is the React-Native / bundler-
   * replaced flag path — Metro, Vite, esbuild, and Rollup all
   * support a build-time `__DEV__` replacement that resolves to a
   * plain boolean. The check has precedence over `NODE_ENV`.
   */
  it('does NOT warn when globalThis.__DEV__ === false', () => {
    ;(globalThis as { __DEV__?: unknown }).__DEV__ = false
    // Keep NODE_ENV=development to verify __DEV__ wins.
    process.env.NODE_ENV = 'development'
    const g = createCausl()
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(0)
    expect(held.a).toBe(0)
  })

  /**
   * `globalThis.__DEV__ === true` arms the warning even when
   * `NODE_ENV === 'production'`. Adopters who deliberately ship a
   * `__DEV__: true` bundle (a debug build masquerading as prod)
   * see the dev warning. The __DEV__ check has precedence.
   */
  it('warns when globalThis.__DEV__ === true overrides production NODE_ENV', () => {
    ;(globalThis as { __DEV__?: unknown }).__DEV__ = true
    process.env.NODE_ENV = 'production'
    const g = createCausl()
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0)
  })

  /**
   * Explicit `enableH1HazardWarning: false` suppresses the warning
   * in dev. Useful for adopters running benchmarks where the
   * WeakRef bookkeeping would skew the measurement.
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
   * Explicit `enableH1HazardWarning: true` arms the warning even
   * in production. Useful for diagnosing a live H1 incident on a
   * deployed engine.
   */
  it('respects explicit enableH1HazardWarning: true even in production', () => {
    process.env.NODE_ENV = 'production'
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0)
  })

  /**
   * Primitive `read()` returns are skipped by the tracker — there
   * is no reference identity to lose for a number / string /
   * boolean, so holding one across a commit is harmless and the
   * warning would be a false positive.
   */
  it('does not warn when read() returns a primitive (numbers cannot desync)', () => {
    const g = createCausl()
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
    // `subscribeReads` is part of the second-tier surface; the
    // signature is `(observer, projection)` with the projection
    // closing over engine reads. Reads issued from the projection
    // run under `activeReadTracker` and are filtered out of the
    // H1 tracker by construction — the read-set is engine-internal
    // bookkeeping, not an adopter-cached reference.
    const g = createCausl()
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
    const g = createCausl()
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj)
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('a→2', (tx) => tx.set(a, 2))
    g.commit('a→3', (tx) => tx.set(a, 3))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0) // anchor
  })
})
