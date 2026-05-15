/**
 * C.4 (#1505) — LOAD-BEARING byte-identity acceptance test.
 *
 * The single most important correctness property of the #1493
 * batched-commit boundary scaffolding cascade (option-c
 * implementation):
 *
 *   With DEFAULT config (no `batchedFlush` option), a WasmBackend's
 *   commit / read / subscribe / exportModel / now behaviour is
 *   BYTE-IDENTICAL to dev `b15069fa` — i.e. to a bare pure-TS
 *   `createCausl()` graph running the identical command sequence.
 *
 * The dev `b15069fa` reference behaviour for the WASM path is exactly
 * "a WasmBackend that wraps a pure-TS Graph with no batched-flush
 * queue installed". C.1–C.4 added the queue + the `batchedFlush`
 * option; this test proves that adding that scaffolding did NOT
 * regress existing adopters who never opt in. If this test fails, the
 * cascade halts (per the #1493 cascade brief — the scaffolding
 * regressed existing adopters).
 *
 * NOTE: option (c) delivers ZERO adopter perf at v1.x. This test
 * asserts ZERO behavioural change, which is the whole point — the
 * scaffolding is inert unless explicitly opted into.
 */

import { describe, it, expect } from 'vitest'
import type { InputNode, NodeId } from '../src/types.js'
import { createCausl } from '../src/index.js'
import { __createWasmBackendSyncForTests } from '../wasm/index.js'

/**
 * A deterministic command script exercising the canonical adopter
 * surface: input + derived registration, a sequence of commits with
 * writes, reads, and a per-node subscription whose fire trace is
 * captured. Run identically against the baseline graph and the
 * default-config WasmBackend's wrapped graph.
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
 * `b15069fa` ORACLE behaviour.
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
 * Run the IDENTICAL script against a default-config WasmBackend's
 * wrapped graph (no `batchedFlush` option supplied). The wrapped
 * `Graph` is the same surface the baseline uses, so byte-equality is
 * the contract.
 */
function runDefaultWasmBackend(
  graphName: string,
  batchedFlush?: { afterN?: number; intervalMs?: number },
): Captured {
  const backend = __createWasmBackendSyncForTests(
    graphName,
    'serde-json',
    batchedFlush,
  ) as unknown as {
    __graph(): ReturnType<typeof createCausl>
    __getBatchedFlushForTests(): unknown
    __batchedFlushConfigForTests(): unknown
  }
  // Default config ⇒ NO queue installed (the load-bearing invariant).
  if (batchedFlush === undefined) {
    expect(backend.__batchedFlushConfigForTests()).toBeUndefined()
    expect(backend.__getBatchedFlushForTests()).toBeUndefined()
  }

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

describe('C.4 (#1505) — LOAD-BEARING default-config byte-identity', () => {
  it('default-config WasmBackend IR is byte-identical to the pure-TS b15069fa oracle', () => {
    // Shared graphName so exportModel()'s graphId field is identical
    // (a synthesised UUID would make the IR byte-different for an
    // unrelated reason — the cross-backend determinism gate's #685
    // discipline).
    const NAME = 'causl.c4.byteid.ir'
    const baseline = runBaseline(NAME)
    const wasmDefault = runDefaultWasmBackend(NAME)
    // THE load-bearing assertion: literal IR byte-equality.
    expect(wasmDefault.ir).toBe(baseline.ir)
  })

  it('default-config commit/read results are identical to the oracle', () => {
    const NAME = 'causl.c4.byteid.reads'
    const baseline = runBaseline(NAME)
    const wasmDefault = runDefaultWasmBackend(NAME)
    expect(wasmDefault.reads).toEqual(baseline.reads)
    // The script is deterministic: sum after edit-i = a + b where
    // a := i and b := (i even ? i*10 : last b). b starts at 10 and is
    // re-set to i*10 only on even i. Pin the concrete values so a
    // silent drift in BOTH paths can't pass vacuously:
    //   i=1 a=1 b=10 →11 | i=2 a=2 b=20 →22 | i=3 a=3 b=20 →23
    //   i=4 a=4 b=40 →44 | i=5 a=5 b=40 →45 | i=6 a=6 b=60 →66
    expect(baseline.reads).toEqual([11, 22, 23, 44, 45, 66])
  })

  it('default-config per-node subscription fire trace is identical to the oracle', () => {
    const NAME = 'causl.c4.byteid.sub'
    const baseline = runBaseline(NAME)
    const wasmDefault = runDefaultWasmBackend(NAME)
    expect(wasmDefault.subscribeTrace).toEqual(baseline.subscribeTrace)
    expect(JSON.stringify(wasmDefault.subscribeTrace)).toBe(
      JSON.stringify(baseline.subscribeTrace),
    )
  })

  it('default-config graph.now advances identically to the oracle', () => {
    const NAME = 'causl.c4.byteid.now'
    const baseline = runBaseline(NAME)
    const wasmDefault = runDefaultWasmBackend(NAME)
    expect(wasmDefault.now).toBe(baseline.now)
  })

  it('FULL capture is byte-identical (IR + reads + subscribe + now)', () => {
    // Belt-and-braces: the entire Captured record must match. This is
    // the consolidated load-bearing gate — if ANY channel drifts, the
    // cascade halts (scaffolding regressed existing adopters).
    const NAME = 'causl.c4.byteid.full'
    const baseline = runBaseline(NAME)
    const wasmDefault = runDefaultWasmBackend(NAME)
    expect(JSON.stringify(wasmDefault)).toBe(JSON.stringify(baseline))
  })

  it('explicit batchedFlush:{afterN:1} is ALSO byte-identical (option-c doc §2.3)', () => {
    // afterN=1 flushes every commit, so even an explicit opt-in at
    // N=1 is behaviourally byte-identical to the per-commit path —
    // the option-c doc §2.3 / §7 invariant. (The queue's shadow path
    // is dormant here because no real wasm bridge is primed in
    // Phase-1; the adopter-facing commit/read/subscribe is the TS
    // graph's regardless — Answer C, JS engine SSOT.)
    const NAME = 'causl.c4.byteid.n1'
    const baseline = runBaseline(NAME)
    const wasmN1 = runDefaultWasmBackend(NAME, { afterN: 1 })
    expect(JSON.stringify(wasmN1)).toBe(JSON.stringify(baseline))
  })

  it('explicit batchedFlush:{afterN:100} does NOT change adopter-visible behaviour', () => {
    // Even a large batch window must not change commit/read/subscribe
    // (Answer C — only the WASM-side WIRE crossing batches; the
    // adopter-facing surface is the TS graph's synchronous Commit).
    // In Phase-1 with no real bridge primed, the queue never installs
    // (it needs __installBatchedFlushFromConfig + a primed bridge), so
    // this is byte-identical too — proving the opt-in is inert on the
    // adopter surface by construction.
    const NAME = 'causl.c4.byteid.n100'
    const baseline = runBaseline(NAME)
    const wasmN100 = runDefaultWasmBackend(NAME, { afterN: 100 })
    expect(JSON.stringify(wasmN100)).toBe(JSON.stringify(baseline))
  })
})
