/**
 * @packageDocumentation
 *
 * Pinning tests for the `@causl/core/wasm` lazy-load entry point
 * (issue #684, evolved by #1065). Three contracts are exercised:
 *
 *   1. **Out-of-bundle.** Importing the main `@causl/core` barrel
 *      must not pull `@causl/core/wasm` into the loaded module
 *      graph. The §14.2 bundle ceiling depends on this — a
 *      regression here means every adopter pays the WASM cost
 *      whether they want it or not.
 *
 *   2. **Real `BackendEngine` returned on supported hosts.** Post
 *      #1065, `loadWasmBackend()` resolves to a real
 *      `BackendEngine` instance (the Phase-1 `WasmBackend` class)
 *      rather than throwing `WasmBackendUnavailableError`. The
 *      `WasmBackendUnavailableError` class is retained for future
 *      bridges whose host preconditions are not met (e.g. WasmGC
 *      requested on a non-GC host).
 *
 *   3. **Concurrent calls share a compile.** Two parallel
 *      `loadWasmBackend()` calls must reach the same module
 *      promise — a regression here would compile the WASM twice
 *      under React Strict Mode's double-render contract.
 */

import { afterEach, describe, expect, it } from 'vitest'

/**
 * Module-level bundling regression guard.
 *
 * Reads the freshly-built `dist/index.js` artifact as text and
 * asserts none of the wasm-loader-specific symbols leak in. The
 * §14.2 size-limit check covers the byte ceiling; this test
 * covers the qualitative property — "the wasm module graph must
 * not be reachable from the main barrel".
 */
describe('@causl/core barrel does not pull in @causl/core/wasm', () => {
  it('main bundle text contains no wasm-loader sentinels', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const dist = path.resolve(here, '../dist/index.js')
    let bundle: string
    try {
      bundle = await fs.readFile(dist, 'utf8')
    } catch {
      // The build hasn't run in this checkout — skip rather than
      // fail. CI runs `pnpm build` before `pnpm test:run` so this
      // path is dead in CI; local-dev runs may hit it.
      return
    }
    expect(bundle).not.toContain('WasmBackendUnavailableError')
    expect(bundle).not.toContain('loadWasmBackend')
    // `detectBridge` / `detectFeatures` are host-feature-detection
    // helpers from #691 (`bridge.ts`); they are intentionally
    // re-exported by the main barrel (see `packages/core/src/index.ts`
    // §"Pluggable WASM bridge interface" comment) so adopters can
    // probe the host BEFORE deciding whether to call
    // `loadWasmBackend()` from `@causl/core/wasm`. Their presence in
    // the main bundle does NOT pull in `loadWasmBackend()` or any
    // WASM artefact loader; the gate rows above already lock the
    // load-side surface out of the main bundle. (The pre-#1014 draft
    // of this assertion bucketed `detectBridge` with the loader
    // sentinels, which contradicted the #691 export contract; aligned
    // here as a CI-greenness fix while #1014 was rebasing through
    // the WASM landings.)
    // Also ensure we never accidentally reference one of the wasm
    // artifact filenames from the main bundle.
    expect(bundle).not.toContain('engine_rs_bg.wasm')
  })
})

describe('@causl/core/wasm — loader skeleton', () => {
  afterEach(async () => {
    // Drop the module-level cache between tests so the
    // concurrent-share assertion is hermetic.
    const mod = await import('../wasm/index.js')
    mod.__resetWasmBackendCacheForTests()
  })

  it('exports the documented public surface', async () => {
    const mod = await import('../wasm/index.js')
    expect(typeof mod.loadWasmBackend).toBe('function')
    expect(typeof mod.detectBridge).toBe('function')
    expect(typeof mod.loadStreaming).toBe('function')
    expect(typeof mod.WasmBackendUnavailableError).toBe('function')
    expect(typeof mod.wasmUrlFor).toBe('function')
  })

  it('detectBridge() resolves to a stable placeholder until #691', async () => {
    const { detectBridge } = await import('../wasm/index.js')
    await expect(detectBridge()).resolves.toBe('serde-json')
  })

  it('loadWasmBackend() resolves to a real BackendEngine post-#1065', async () => {
    const { loadWasmBackend } = await import('../wasm/index.js')
    const backend = await loadWasmBackend()
    // The Phase-1 implementation returns a `WasmBackend` instance —
    // shape check covers the BackendEngine interface methods.
    expect(backend).toBeDefined()
    expect(typeof backend.commit).toBe('function')
    expect(typeof backend.read).toBe('function')
    expect(typeof backend.subscribe).toBe('function')
    expect(typeof backend.subscribeCommits).toBe('function')
    expect(typeof backend.snapshot).toBe('function')
    expect(typeof backend.hydrate).toBe('function')
    expect(typeof backend.exportModel).toBe('function')
    expect(typeof backend.readAt).toBe('function')
    expect(typeof backend.snapshotAt).toBe('function')
    expect(typeof backend.dispose).toBe('function')
    // `now` is a getter — accessing it should produce a GraphTime,
    // initialised to whatever the wrapped engine's start time is.
    expect(typeof backend.now).toBe('number')
  })

  it('WasmBackendUnavailableError class is still exported for future bridge gating', async () => {
    const { WasmBackendUnavailableError } = await import('../wasm/index.js')
    expect(typeof WasmBackendUnavailableError).toBe('function')
    const err = new WasmBackendUnavailableError('serde-json')
    expect(err.code).toBe('CAUSL_WASM_NOT_BUILT')
    expect(err.name).toBe('WasmBackendUnavailableError')
  })

  it('honours an explicit bridge override (serde-json)', async () => {
    const { loadWasmBackend } = await import('../wasm/index.js')
    const backend = await loadWasmBackend({ bridge: 'serde-json' })
    expect(backend).toBeDefined()
    expect(typeof backend.commit).toBe('function')
  })

  it('returns the same module promise for concurrent callers', async () => {
    const { loadWasmBackend } = await import('../wasm/index.js')
    const [a, b] = await Promise.all([loadWasmBackend(), loadWasmBackend()])
    // Same bridge id → same cached promise → same resolved engine.
    expect(a).toBe(b)
  })

  it('wasmUrlFor() respects an explicit baseUrl override', async () => {
    const { wasmUrlFor } = await import('../wasm/index.js')
    const u = wasmUrlFor('serde-json', 'https://cdn.example.com/causl/wasm/')
    expect(u.href).toBe(
      'https://cdn.example.com/causl/wasm/serde/engine_rs_bg.wasm',
    )
    // Lenient on trailing slash.
    const u2 = wasmUrlFor('serde-json', 'https://cdn.example.com/causl/wasm')
    expect(u2.href).toBe(
      'https://cdn.example.com/causl/wasm/serde/engine_rs_bg.wasm',
    )
  })

  it('wasmUrlFor() routes the three known bridges to the documented segments', async () => {
    const { wasmUrlFor } = await import('../wasm/index.js')
    const base = 'https://cdn.example.com/'
    expect(wasmUrlFor('wasmgc-builtins', base).href).toBe(
      'https://cdn.example.com/gc-builtins/engine_rs_bg.wasm',
    )
    expect(wasmUrlFor('wasmgc-classic', base).href).toBe(
      'https://cdn.example.com/gc-classic/engine_rs_bg.wasm',
    )
    expect(wasmUrlFor('serde-json', base).href).toBe(
      'https://cdn.example.com/serde/engine_rs_bg.wasm',
    )
  })

  it('wasmUrlFor() forwards-compats unknown bridge ids by mirroring the segment', async () => {
    const { wasmUrlFor } = await import('../wasm/index.js')
    // A future bridge (e.g. shared-memory) ships a directory whose
    // name matches its id verbatim. The loader resolves it without
    // a code change.
    const u = wasmUrlFor('shared-memory-future', 'https://cdn.example.com/')
    expect(u.href).toBe(
      'https://cdn.example.com/shared-memory-future/engine_rs_bg.wasm',
    )
  })
})
