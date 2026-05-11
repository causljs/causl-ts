/**
 * @packageDocumentation
 *
 * Behavioural pinning for the pluggable WASM-bridge interface and the
 * `detectBridge()` feature-detection harness landed in #691.
 *
 * The contract being pinned in this PR (TS-only; concrete bridge
 * implementations land in #692 and #693):
 *
 * 1. `detectBridge()` always resolves to *some* `Bridge` — feature
 *    detection failures never crash and never return `undefined`.
 *    The exit criterion in #691 names this assertion explicitly.
 * 2. The placeholder returned today identifies as `serde-json` with
 *    `abiVersion: 0`, all `BridgeFeatures` flags `false`, and throws
 *    on every cross-boundary primitive — making it visually distinct
 *    from the real `serde-json` bridge that ships in #693 at
 *    `abiVersion: 1`.
 * 3. The `release()` primitive on the placeholder is a no-op so that
 *    disposal code running after a failed instantiation does not
 *    itself throw.
 * 4. `CAUSL_WASM_BRIDGE=serde` pins the choice — the env override
 *    bypasses host capability detection entirely.
 * 5. `detectFeatures()` returns a frozen object with the four
 *    capability flags surfaced on `BridgeFeatures`. The probes are
 *    runtime, so on Node we expect at minimum a frozen object — not
 *    a particular flag pattern, since CI hosts vary.
 *
 * When #692 / #693 land, the assertions pinning `id === 'serde-json'`
 * and `abiVersion === 0` will move into a dedicated test for the
 * placeholder fallback path; the harness-level assertions stay.
 */

import { describe, expect, it } from 'vitest'

import { detectBridge, detectFeatures } from '../src/bridge.js'

describe('detectFeatures', () => {
  it('returns a frozen BridgeFeatures object with all four flags', async () => {
    const features = await detectFeatures()
    expect(Object.isFrozen(features)).toBe(true)
    expect(typeof features.gc).toBe('boolean')
    expect(typeof features.jsStringBuiltins).toBe('boolean')
    expect(typeof features.sharedMemory).toBe('boolean')
    expect(typeof features.stringView).toBe('boolean')
  })
})

describe('detectBridge', () => {
  it('always resolves to some Bridge — feature-detection failures never crash', async () => {
    const bridge = await detectBridge()
    expect(bridge).toBeDefined()
    expect(typeof bridge.id).toBe('string')
    expect(typeof bridge.abiVersion).toBe('number')
    expect(bridge.features).toBeDefined()
  })

  it('returns the placeholder serde-json bridge until #692/#693 land', async () => {
    const bridge = await detectBridge()
    // STUB-PIN: this assertion is the contract for *this* PR. The
    // assertion will be replaced when the real bridges ship; failing
    // it on a future PR is the expected signal that the placeholder
    // is being retired.
    expect(bridge.id).toBe('serde-json')
    expect(bridge.abiVersion).toBe(0)
    expect(bridge.features.gc).toBe(false)
    expect(bridge.features.jsStringBuiltins).toBe(false)
    expect(bridge.features.sharedMemory).toBe(false)
    expect(bridge.features.stringView).toBe(false)
  })

  it('placeholder cross-boundary primitives throw, release is a no-op', async () => {
    const bridge = await detectBridge()
    expect(() => bridge.toWasmObject({})).toThrow(/placeholder/)
    expect(() =>
      bridge.fromWasmObject({ __kind: 'WasmObjectHandle' } as Parameters<typeof bridge.fromWasmObject>[0]),
    ).toThrow(/placeholder/)
    expect(() => bridge.toWasmString('hello')).toThrow(/placeholder/)
    expect(() =>
      bridge.fromWasmString({ __kind: 'WasmStringHandle' } as Parameters<typeof bridge.fromWasmString>[0]),
    ).toThrow(/placeholder/)
    // The release() no-op contract: idempotent disposal must not
    // throw, even on an unknown handle, so post-failure cleanup
    // paths stay safe.
    expect(() =>
      bridge.release({ __kind: 'WasmObjectHandle' } as Parameters<typeof bridge.release>[0]),
    ).not.toThrow()
  })

  it('honours CAUSL_WASM_BRIDGE=serde override', async () => {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    if (!proc?.env) {
      // In a host without process.env (browser) the override has no
      // effect and the harness still returns the universal fallback;
      // the assertion above already covers that case.
      return
    }
    const prior = proc.env.CAUSL_WASM_BRIDGE
    proc.env.CAUSL_WASM_BRIDGE = 'serde'
    try {
      const bridge = await detectBridge()
      expect(bridge.id).toBe('serde-json')
    } finally {
      if (prior === undefined) {
        delete proc.env.CAUSL_WASM_BRIDGE
      } else {
        proc.env.CAUSL_WASM_BRIDGE = prior
      }
    }
  })
})
