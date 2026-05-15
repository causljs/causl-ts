/**
 * V2.1 (#1519) — LOAD-BEARING byte-identity acceptance test.
 *
 * The single most important correctness property of the v2.x
 * Rust-SSOT cutover opt-in surface (epic #1515, V2-DESIGN §2.2):
 *
 *   With DEFAULT config (no `engine` option, or an explicit
 *   `engine: 'js-ssot'`), a WasmBackend's commit / read / subscribe /
 *   exportModel / now behaviour is BYTE-IDENTICAL to dev `97da8420`
 *   — i.e. to a bare pure-TS `createCausl()` graph running the
 *   identical command sequence, and to the #1493 C.4 default-config
 *   WasmBackend (which IS the dev `97da8420` WASM-path behaviour).
 *
 * V2.1 added the `engine: 'js-ssot' | 'rust-ssot'` discriminant on
 * `WasmBackendOptions` / `createCausl` options + threaded it through
 * `instantiateBackend`. This test proves that adding that opt-in
 * surface did NOT regress existing adopters who never opt in. If
 * this test fails, the V2.1+ cascade halts (per the dispatch brief
 * — the opt-in surface regressed existing adopters).
 *
 * NOTE: v2.x delivers ZERO adopter perf at current WASM maturity —
 * the Rust-engine-in-WASM per-commit execution cost is ~85x the TS
 * engine (#1479 comment 4455257530), a property of today's WASM
 * runtime that #1493's batching provably cannot amortise. The #1133
 * falsification STANDS. This test asserts ZERO behavioural change
 * for the default path, which is the whole point — the cutover
 * surface is inert unless explicitly opted into, and even when
 * opted in v2.x is future-facing infrastructure behind the
 * V2-DESIGN §3 maturity tripwire, not a perf win.
 */

import { describe, it, expect } from 'vitest'
import type { InputNode, NodeId } from '../src/types.js'
import { createCausl } from '../src/index.js'
import {
  __createWasmBackendSyncForTests,
  __resetWasmBackendCacheForTests,
  resolveWasmEngineMode,
  DEFAULT_WASM_ENGINE_MODE,
  RUST_SSOT_DEFAULT_AFTER_N,
} from '../wasm/index.js'

/**
 * The byte-equality capture channels: IR, per-commit reads, the
 * per-node subscription fire trace, and the final clock.
 */
interface Captured {
  /** `JSON.stringify(exportModel())` — the byte-equality channel. */
  ir: string
  /** `read()` of the derived node after each commit. */
  reads: unknown[]
  /** Per-node subscription fire trace (values delivered, in order). */
  subscribeTrace: unknown[]
  /** `graph.now` after the full script. */
  now: number
}

/**
 * Run the canonical script against a bare pure-TS graph — the dev
 * `97da8420` ORACLE behaviour.
 */
function runBaseline(graphName: string): Captured {
  const g = createCausl({ name: graphName })
  const a = g.input('a', 0)
  const b = g.input('b', 10)
  const sum = g.derived('sum', (get) => get(a) + get(b))

  const reads: unknown[] = []
  const subscribeTrace: unknown[] = []
  const unsub = g.subscribe(sum, (v) => subscribeTrace.push(v))

  for (let i = 1; i <= 6; i++) {
    g.commit(`edit-${i}`, (tx) => {
      tx.set(a, i)
      if (i % 2 === 0) tx.set(b, i * 10)
    })
    reads.push(g.read(sum))
  }
  unsub()

  return {
    ir: JSON.stringify(g.exportModel()),
    reads,
    subscribeTrace,
    now: g.now as unknown as number,
  }
}

/**
 * Run the IDENTICAL script against a WasmBackend's wrapped graph.
 * `engine` is forwarded exactly as an adopter would pass it
 * (`undefined` ⇒ default ⇒ byte-identical; `'js-ssot'` ⇒ explicit
 * default ⇒ byte-identical).
 */
function runWasmBackend(
  graphName: string,
  engine?: 'js-ssot' | 'rust-ssot',
  batchedFlush?: { afterN?: number; intervalMs?: number },
): Captured {
  const backend = __createWasmBackendSyncForTests(
    graphName,
    'serde-json',
    batchedFlush,
    engine,
  ) as unknown as {
    __graph(): ReturnType<typeof createCausl>
    __engineModeForTests(): string
    __batchedFlushConfigForTests(): unknown
  }
  // The engine mode is resolved + stored; the default resolves to
  // 'js-ssot' (the load-bearing default-off invariant).
  expect(backend.__engineModeForTests()).toBe(
    engine ?? DEFAULT_WASM_ENGINE_MODE,
  )

  const g = backend.__graph()
  const a = g.input('a', 0)
  const b = g.input('b', 10)
  const sum = g.derived('sum', (get) => get(a) + get(b))

  const reads: unknown[] = []
  const subscribeTrace: unknown[] = []
  const unsub = g.subscribe(sum, (v) => subscribeTrace.push(v))

  for (let i = 1; i <= 6; i++) {
    g.commit(`edit-${i}`, (tx) => {
      tx.set(a as InputNode<number>, i)
      if (i % 2 === 0) tx.set(b as InputNode<number>, i * 10)
    })
    reads.push(g.read(sum))
  }
  unsub()

  return {
    ir: JSON.stringify(g.exportModel()),
    reads,
    subscribeTrace,
    now: g.now as unknown as number,
  }
}

describe('V2.1 (#1519) — LOAD-BEARING default-config byte-identity', () => {
  it('default-config (no engine option) WasmBackend IR is byte-identical to the pure-TS 97da8420 oracle', () => {
    // Shared graphName so exportModel()'s graphId field is identical
    // (a synthesised UUID would make the IR byte-different for an
    // unrelated reason — the cross-backend determinism gate's #685
    // discipline).
    const NAME = 'causl.v21.byteid.ir'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    // THE load-bearing assertion: literal IR byte-equality. If this
    // fails, the V2.1 opt-in surface regressed existing adopters and
    // the cascade halts.
    expect(wasmDefault.ir).toBe(baseline.ir)
  })

  it('default-config commit/read results are identical to the oracle', () => {
    const NAME = 'causl.v21.byteid.reads'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    expect(wasmDefault.reads).toEqual(baseline.reads)
    // Pin concrete values so a silent drift in BOTH paths can't pass
    // vacuously: i=1 a=1 b=10 →11 | i=2 a=2 b=20 →22 | i=3 a=3 b=20
    // →23 | i=4 a=4 b=40 →44 | i=5 a=5 b=40 →45 | i=6 a=6 b=60 →66.
    expect(baseline.reads).toEqual([11, 22, 23, 44, 45, 66])
  })

  it('default-config per-node subscription fire trace is identical to the oracle', () => {
    const NAME = 'causl.v21.byteid.sub'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    expect(wasmDefault.subscribeTrace).toEqual(baseline.subscribeTrace)
    expect(JSON.stringify(wasmDefault.subscribeTrace)).toBe(
      JSON.stringify(baseline.subscribeTrace),
    )
  })

  it('default-config graph.now advances identically to the oracle', () => {
    const NAME = 'causl.v21.byteid.now'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    expect(wasmDefault.now).toBe(baseline.now)
  })

  it('FULL capture is byte-identical (IR + reads + subscribe + now) — the consolidated halt gate', () => {
    // Belt-and-braces: the entire Captured record must match. If ANY
    // channel drifts, the V2.1+ cascade halts (the opt-in surface
    // regressed existing adopters).
    const NAME = 'causl.v21.byteid.full'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    expect(JSON.stringify(wasmDefault)).toBe(JSON.stringify(baseline))
  })

  it('explicit engine:"js-ssot" is byte-identical to omitting engine (explicit default)', () => {
    // Passing the default value explicitly must be exactly the same
    // as omitting it — V2-DESIGN §2.2 (the load-bearing default-off
    // property holds for both the implicit and explicit default).
    const NAME = 'causl.v21.byteid.jsssot'
    const baseline = runBaseline(NAME)
    const wasmExplicitDefault = runWasmBackend(NAME, 'js-ssot')
    expect(JSON.stringify(wasmExplicitDefault)).toBe(
      JSON.stringify(baseline),
    )
  })

  it('the C.4 default-config byte-identity property still holds under V2.1 (no regression of the predecessor invariant)', () => {
    // V2.1 must not regress the #1493 C.4 load-bearing property: the
    // default-config WasmBackend (no batchedFlush, no engine) is
    // byte-identical to a bare pure-TS graph. This is the dev
    // `97da8420` WASM-path behaviour anchor V2.1 builds on.
    const NAME = 'causl.v21.byteid.c4anchor'
    const baseline = runBaseline(NAME)
    const wasmDefault = runWasmBackend(NAME)
    expect(wasmDefault.ir).toBe(baseline.ir)
    expect(JSON.stringify(wasmDefault)).toBe(JSON.stringify(baseline))
  })
})

describe('V2.1 (#1519) — engine discriminant validation + resolution', () => {
  it('resolveWasmEngineMode(undefined) ⇒ the default js-ssot constant', () => {
    expect(resolveWasmEngineMode(undefined)).toBe('js-ssot')
    expect(DEFAULT_WASM_ENGINE_MODE).toBe('js-ssot')
  })

  it('resolveWasmEngineMode accepts both valid discriminant values', () => {
    expect(resolveWasmEngineMode('js-ssot')).toBe('js-ssot')
    expect(resolveWasmEngineMode('rust-ssot')).toBe('rust-ssot')
  })

  it('an unrecognised engine value throws a RangeError (fail-closed, not a silent fallback)', () => {
    // Fail-closed: a typo'd `engine` must NOT silently fall through to
    // the default and mask an adopter's intent to opt into rust-ssot.
    expect(() =>
      resolveWasmEngineMode('rustssot' as unknown as 'rust-ssot'),
    ).toThrow(RangeError)
    expect(() =>
      resolveWasmEngineMode('js' as unknown as 'js-ssot'),
    ).toThrow(/engine must be 'js-ssot' or 'rust-ssot'/)
    expect(() =>
      __createWasmBackendSyncForTests(
        'causl.v21.bad',
        'serde-json',
        undefined,
        'nope' as unknown as 'rust-ssot',
      ),
    ).toThrow(RangeError)
  })

  it('engine:"rust-ssot" is stored on the backend (surface only; flush behaviour unchanged in V2.1)', () => {
    const backend = __createWasmBackendSyncForTests(
      'causl.v21.rustssot',
      'serde-json',
      undefined,
      'rust-ssot',
    ) as unknown as { __engineModeForTests(): string }
    expect(backend.__engineModeForTests()).toBe('rust-ssot')
  })

  it('the rust-ssot default-window constant is the #1484 §3 / C.6 crossing floor (N=312)', () => {
    // V2-DESIGN §2.2: rust-ssot rides the batched-flush queue and, if
    // the adopter does not pass an explicit batchedFlush, defaults the
    // window to N=312 (the C.6-confirmed <= 50 ns crossing floor).
    // This amortises the *crossing* tax, NOT the *engine-exec* tax —
    // V2-DESIGN §0 (NOT a perf win).
    expect(RUST_SSOT_DEFAULT_AFTER_N).toBe(312)
  })

  it('engine:"rust-ssot" without explicit batchedFlush installs the N=312 default window via instantiateBackend', async () => {
    // This exercises the `instantiateBackend` threading path
    // (loadWasmBackend), not just the sync test helper — proving the
    // V2-DESIGN §2.2 "rust-ssot implies batchedFlush@312" wiring.
    // `loadWasmBackend` caches per-bridge; reset so each cached-load
    // assertion below sees a fresh instantiate with its own options.
    __resetWasmBackendCacheForTests()
    const mod = await import('../wasm/index.js')
    const backend = (await mod.loadWasmBackend({
      graphName: 'causl.v21.rustssot.window',
      engine: 'rust-ssot',
    })) as unknown as {
      __engineModeForTests(): string
      __batchedFlushConfigForTests(): { afterN: number } | undefined
    }
    expect(backend.__engineModeForTests()).toBe('rust-ssot')
    expect(backend.__batchedFlushConfigForTests()?.afterN).toBe(
      RUST_SSOT_DEFAULT_AFTER_N,
    )
  })

  it('engine:"rust-ssot" WITH explicit batchedFlush honours the adopter window (no override)', async () => {
    __resetWasmBackendCacheForTests()
    const mod = await import('../wasm/index.js')
    const backend = (await mod.loadWasmBackend({
      graphName: 'causl.v21.rustssot.explicitwindow',
      engine: 'rust-ssot',
      batchedFlush: { afterN: 100 },
    })) as unknown as {
      __batchedFlushConfigForTests(): { afterN: number } | undefined
    }
    expect(backend.__batchedFlushConfigForTests()?.afterN).toBe(100)
  })

  it('default (js-ssot) path does NOT auto-install a batched-flush window (C.4 default-off preserved)', async () => {
    __resetWasmBackendCacheForTests()
    const mod = await import('../wasm/index.js')
    const backend = (await mod.loadWasmBackend({
      graphName: 'causl.v21.jsssot.noqueue',
    })) as unknown as {
      __engineModeForTests(): string
      __batchedFlushConfigForTests(): unknown
    }
    expect(backend.__engineModeForTests()).toBe('js-ssot')
    // The C.4 load-bearing invariant: no engine + no batchedFlush ⇒
    // no queue ⇒ byte-identical to dev `97da8420`.
    expect(backend.__batchedFlushConfigForTests()).toBeUndefined()
  })
})
