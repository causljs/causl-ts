/**
 * @packageDocumentation
 *
 * Behavioural pinning for the `createCausl({ backend: 'auto' })`
 * auto-adapt wrapper (#1072). The contract being pinned is the
 * integration of three previously-decoupled pieces (`shouldMigrate`
 * predicate from #686 / #1038, `loadWasmBackend()` from #1031 / #1065,
 * and `_migrateFrom` from #1090) into the runtime engine factory.
 *
 * Each suite below either:
 *
 *   1. Demonstrates the wrapper is a working `Graph` (canonical
 *      seven-method surface, time advancement, subscriber dispatch)
 *      when the heuristic does NOT trip — the safety case that no
 *      adopter who flips `backend: 'auto'` on a small-scale workload
 *      gets a different graph than before.
 *   2. Drives the heuristic past its threshold via per-engine
 *      `adaptThresholds` overrides and asserts the wrapper migrates
 *      exactly once, exposes `migrationPaybackCommits`, and stays on
 *      the WASM-wrapped engine for the remainder of the trace.
 *
 * @see #1072 — this issue.
 * @see ../src/auto-adapt-wrapper.ts — the wrapper under test.
 */

import { describe, expect, it } from 'vitest'

import { createCausl } from '../src/index.js'
import { __resetWasmBackendCacheForTests } from '../wasm/index.js'

/**
 * Flush pending microtasks until the auto-adapt wrapper's
 * `await import('../wasm/index.js')` settles. The wrapper kicks off
 * the load fire-and-forget inside `commit()`; the swap then happens
 * on the next commit boundary after the promise resolves. A handful
 * of microtask flushes is enough — the dynamic import resolves
 * synchronously in vitest's resolver (the module graph is in memory),
 * but we yield a few times to leave headroom for the resolver's own
 * microtask scheduling.
 */
async function flushWasmLoad(): Promise<void> {
  // Two `setImmediate` ticks drain Node's microtask queue and any
  // setTimeout(0) the wasm loader's instantiate path enqueues. The
  // wrapper's `await import('../wasm/index.js')` plus
  // `await loadWasmBackend()` chain is ~5 microtasks deep; flushing
  // twice gives comfortable headroom.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe("createCausl({ backend: 'auto' }) — canonical seven-method surface", () => {
  it('returns an object exposing the canonical primitives', () => {
    const g = createCausl({ backend: 'auto' })
    expect(typeof g.input).toBe('function')
    expect(typeof g.derived).toBe('function')
    expect(typeof g.commit).toBe('function')
    expect(typeof g.read).toBe('function')
    expect(typeof g.subscribe).toBe('function')
    expect(typeof g.explain).toBe('function')
  })

  it('starts at GraphTime t₀ = 0 and advances by 1 per commit', () => {
    const g = createCausl({ backend: 'auto' })
    const a = g.input('a', 0)
    expect(g.now).toBe(0)
    g.commit('w1', (tx) => tx.set(a, 1))
    expect(g.now).toBe(1)
    g.commit('w2', (tx) => tx.set(a, 2))
    expect(g.now).toBe(2)
  })

  it('routes read / subscribe / derived through the inner engine', () => {
    const g = createCausl({ backend: 'auto' })
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    expect(g.read(sum)).toBe(3)
    const seen: number[] = []
    const dispose = g.subscribe(sum, (value) => {
      seen.push(value)
    })
    expect(seen).toEqual([3])
    g.commit('bump', (tx) => tx.set(a, 10))
    expect(g.read(sum)).toBe(12)
    expect(seen).toEqual([3, 12])
    dispose()
  })

  it('exposes stats() with migrationPaybackCommits undefined pre-migration', () => {
    const g = createCausl({ backend: 'auto' })
    const a = g.input('a', 0)
    g.commit('w', (tx) => tx.set(a, 1))
    const stats = g.stats()
    expect(stats.migrationPaybackCommits).toBeUndefined()
  })
})

describe("createCausl({ backend: 'auto' }) — heuristic does not trip", () => {
  it('stays on the TS engine on a small steady-state workload', async () => {
    // Defaults are 50k nodes / 500 commits / 1k subscribers — a
    // 10-input / 100-commit trace cannot trip any axis.
    const g = createCausl({ backend: 'auto' })
    const a = g.input('a', 0)
    for (let i = 1; i <= 100; i += 1) {
      g.commit(`w${i}`, (tx) => tx.set(a, i))
    }
    // Allow any async work to settle.
    await flushWasmLoad()
    const stats = g.stats()
    expect(stats.migrationPaybackCommits).toBeUndefined()
  })
})

describe("createCausl({ backend: 'auto' }) — heuristic trips mid-life", () => {
  it('migrates exactly once and exposes migrationPaybackCommits', async () => {
    // Reset the WASM-loader cache so this test gets a fresh
    // BackendEngine instance.
    __resetWasmBackendCacheForTests()

    // Drive the per-node-cost axis: a graph with 21 nodes (above
    // `nodeCount: 20`) trips the OR on every commit; the hysteresis
    // gate fires on the third consecutive commit.
    const g = createCausl({
      backend: 'auto',
      adaptThresholds: {
        nodeCount: 20,
        // Keep the activity gate tight so the payback counter is
        // observable in a short trace.
        commitCount: 5,
      },
    })
    // Register 21 input nodes.
    const inputs: Array<ReturnType<typeof g.input<number>>> = []
    for (let i = 0; i < 21; i += 1) {
      inputs.push(g.input<number>(`n${i}`, 0))
    }
    // Pre-migration: payback counter is undefined.
    expect(g.stats().migrationPaybackCommits).toBeUndefined()
    // Drive past hysteresis: three consecutive trips + an EWMA gate.
    // The EWMA gate of `nodeCount > 20` is trivially satisfied
    // because every snapshot has 21 nodes.
    for (let i = 1; i <= 5; i += 1) {
      g.commit(`w${i}`, (tx) => tx.set(inputs[0]!, i))
    }
    // Yield to let `await import('../wasm/index.js')` resolve.
    await flushWasmLoad()
    // One more commit performs the synchronous swap.
    g.commit('swap-trigger', (tx) => tx.set(inputs[0]!, 99))
    // Post-migration: the payback counter is set.
    const post = g.stats()
    expect(post.migrationPaybackCommits).toBeDefined()
    expect(post.migrationPaybackCommits).toBeGreaterThan(0)
    // Subsequent commits decrement the counter; per-commit decrement
    // bottoms out at 0.
    const before = post.migrationPaybackCommits!
    g.commit('decrement', (tx) => tx.set(inputs[0]!, 100))
    const after = g.stats()
    expect(after.migrationPaybackCommits).toBe(before - 1)
  })

  it('preserves input values across the migration boundary', async () => {
    __resetWasmBackendCacheForTests()
    const g = createCausl({
      backend: 'auto',
      name: 'migration-state-preservation-test',
      adaptThresholds: { nodeCount: 5, commitCount: 1 },
    })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    // Build node count past threshold.
    for (let i = 0; i < 7; i += 1) {
      g.input(`pad${i}`, 0)
    }
    // Three commits to trip hysteresis.
    g.commit('w1', (tx) => {
      tx.set(a, 5)
      tx.set(b, 10)
    })
    g.commit('w2', (tx) => tx.set(a, 7))
    g.commit('w3', (tx) => tx.set(b, 20))
    expect(g.read(sum)).toBe(27)
    await flushWasmLoad()
    // Trigger the swap and verify values flowed through.
    g.commit('swap-trigger', (tx) => tx.set(a, 8))
    expect(g.read(a)).toBe(8)
    expect(g.read(b)).toBe(20)
    expect(g.read(sum)).toBe(28)
  })

  it('keeps subscribers firing after migration (no duplicate initial fire)', async () => {
    __resetWasmBackendCacheForTests()
    const g = createCausl({
      backend: 'auto',
      name: 'migration-subscriber-test',
      adaptThresholds: { nodeCount: 5, commitCount: 1 },
    })
    const a = g.input('a', 0)
    // Pad node count past threshold.
    for (let i = 0; i < 7; i += 1) {
      g.input(`pad${i}`, 0)
    }
    const seen: number[] = []
    g.subscribe(a, (value) => {
      seen.push(value)
    })
    // Initial fire (per subscribe contract).
    expect(seen).toEqual([0])
    // Hysteresis trips on the third consecutive commit. Two writes
    // happen pre-migration; the third triggers the heuristic.
    g.commit('w1', (tx) => tx.set(a, 1))
    g.commit('w2', (tx) => tx.set(a, 2))
    g.commit('w3', (tx) => tx.set(a, 3))
    expect(seen).toEqual([0, 1, 2, 3])
    await flushWasmLoad()
    // Swap on next commit. The re-subscription's initial fire MUST
    // be suppressed (last delivered value was 3; the WASM-wrapped
    // engine after `__migrateFrom` reports 3 as the new initial).
    g.commit('swap-trigger', (tx) => tx.set(a, 4))
    expect(seen).toEqual([0, 1, 2, 3, 4])
    // Post-migration commits continue to fire.
    g.commit('post', (tx) => tx.set(a, 5))
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('post-migration reads match a pure-TS oracle on the same trace', async () => {
    __resetWasmBackendCacheForTests()
    // Build the auto-adapt wrapper alongside a pure-TS oracle.
    // Both engines see the same registration sequence and the same
    // commit trace; after the auto-adapt wrapper migrates, its
    // reads MUST still match the oracle's — `_migrateFrom` is
    // value-byte-identical and the post-migration commits land on a
    // structurally-equivalent TS engine (the Phase-1 WasmBackend
    // wraps a fresh TS engine, so the post-migration sequence is
    // observably identical to the pure-TS baseline).
    const sharedName = 'migration-oracle-test'
    const auto = createCausl({
      backend: 'auto',
      name: sharedName,
      adaptThresholds: { nodeCount: 5, commitCount: 1 },
    })
    const oracle = createCausl({ name: sharedName + '-oracle' })
    const a_auto = auto.input('a', 0)
    const a_or = oracle.input('a', 0)
    const b_auto = auto.input('b', 0)
    const b_or = oracle.input('b', 0)
    const sum_auto = auto.derived('sum', (get) => get(a_auto) + get(b_auto))
    const sum_or = oracle.derived('sum', (get) => get(a_or) + get(b_or))
    // Pad node count past threshold.
    for (let i = 0; i < 7; i += 1) {
      auto.input(`pad${i}`, 0)
      oracle.input(`pad${i}`, 0)
    }
    // Same trace on both.
    const writes: ReadonlyArray<readonly [number, number]> = [
      [1, 1],
      [2, 5],
      [3, 10],
      [4, 20],
      [5, 30],
    ]
    for (const [aval, bval] of writes) {
      auto.commit('w', (tx) => {
        tx.set(a_auto, aval)
        tx.set(b_auto, bval)
      })
      oracle.commit('w', (tx) => {
        tx.set(a_or, aval)
        tx.set(b_or, bval)
      })
    }
    // Trigger swap.
    await flushWasmLoad()
    auto.commit('swap-trigger', (tx) => tx.set(a_auto, 100))
    oracle.commit('swap-trigger', (tx) => tx.set(a_or, 100))
    expect(auto.read(a_auto)).toBe(oracle.read(a_or))
    expect(auto.read(b_auto)).toBe(oracle.read(b_or))
    expect(auto.read(sum_auto)).toBe(oracle.read(sum_or))
    // A handful of post-migration commits — values stay in sync.
    for (let i = 0; i < 10; i += 1) {
      auto.commit(`post-${i}`, (tx) => tx.set(b_auto, 200 + i))
      oracle.commit(`post-${i}`, (tx) => tx.set(b_or, 200 + i))
      expect(auto.read(sum_auto)).toBe(oracle.read(sum_or))
    }
  })

  it('one-way migration: never reverts to TS engine after migrating', async () => {
    __resetWasmBackendCacheForTests()
    const g = createCausl({
      backend: 'auto',
      name: 'migration-one-way-test',
      adaptThresholds: { nodeCount: 5, commitCount: 1 },
    })
    const a = g.input('a', 0)
    for (let i = 0; i < 7; i += 1) {
      g.input(`pad${i}`, 0)
    }
    g.commit('w1', (tx) => tx.set(a, 1))
    g.commit('w2', (tx) => tx.set(a, 2))
    g.commit('w3', (tx) => tx.set(a, 3))
    await flushWasmLoad()
    g.commit('swap-trigger', (tx) => tx.set(a, 4))
    const afterMigration = g.stats().migrationPaybackCommits
    expect(afterMigration).toBeDefined()
    // Run many more commits — the payback counter monotonically
    // decreases (or bottoms at 0); we never re-enter the
    // pre-migration `undefined` state.
    for (let i = 0; i < 20; i += 1) {
      g.commit(`post-${i}`, (tx) => tx.set(a, 100 + i))
      const stats = g.stats()
      expect(stats.migrationPaybackCommits).toBeDefined()
    }
  })
})
