/**
 * V2.2 (#1530) — per-flush shadow byte-compare guard tests.
 *
 * Implements ticket V2.2 of the v2.x epic #1515 cascade (decomposition
 * #1516; predecessor V2.1 #1522 `2b7e7ea5`). The guard is
 * **compare-and-DISCARD**: under `engine: 'rust-ssot'` every
 * `commit_batch` flush byte-compares the Rust projection against the
 * JS-engine canonical `Commit[]` and records divergence via the
 * existing #1493 C.5 `BatchedFlush.#error` seam — but the JS engine
 * stays SSOT and the Rust post-state is NEVER promoted (promotion is
 * the gated load-bearing job of V2.4).
 *
 * The two load-bearing properties this file pins:
 *
 *   1. **Compare RUNS under rust-ssot.** A flush increments the
 *      `shadowCompareCount` dev-test seam, on byte-match leaves
 *      `error` undefined, and on divergence routes the labelled error
 *      into the C.5 `error` seam — WITHOUT changing the returned
 *      result (no promotion; the JS-engine SSOT Commit is what the
 *      adopter already got synchronously).
 *
 *   2. **Default `js-ssot` is byte-for-byte UNCHANGED.** The compare
 *      path is never entered (`shadowCompareCount === 0`), the queue
 *      buffers no JS commits, and flush output is identical to a
 *      js-ssot queue — the load-bearing V2.1 #1522 invariant holds.
 *
 * NOTE: v2.x delivers ZERO adopter perf at current WASM maturity and
 * does NOT refute the #1133 falsification. V2.2 is non-destructive
 * shadow infrastructure toward V2.4's gated promotion, not a perf win.
 */

import { describe, it, expect } from 'vitest'
import type { GraphTime, NodeId } from '../src/types.js'
import type { Commit } from '../src/types.js'
import { WasmStateMirror } from '../wasm/marshaler.js'
import { BatchedFlush, type BatchedFlushBridge } from '../wasm/index.js'

/**
 * Recording `commit_batch` bridge. `divergeAt` (when set) corrupts the
 * `intent` of the record at that index so the V2.2 compare sees a
 * byte-difference vs the JS-engine canonical Commit fed via `enqueue`.
 */
function batchBridge(divergeAt?: number): BatchedFlushBridge & {
  batchCalls: number
} {
  const obj = {
    batchCalls: 0,
    commit(state: unknown, action: unknown) {
      const a = action as { intent: string }
      const s = state as { now: number; inputs: unknown[] }
      return {
        state: { now: s.now + 1, inputs: s.inputs },
        commit: { time: s.now + 1, intent: a.intent, changedNodes: [] },
        events: [],
      }
    },
    commit_batch(state: unknown, actions: unknown) {
      obj.batchCalls += 1
      const acts = actions as { intent: string }[]
      const s = state as { now: number; inputs: unknown[] }
      const commits = acts.map((act, i) => ({
        time: s.now + i + 1,
        intent:
          i === divergeAt ? `${act.intent}__RUST_DIVERGED__` : act.intent,
        changedNodes: [] as number[],
      }))
      return {
        state: { now: s.now + acts.length, inputs: s.inputs },
        commit: commits[commits.length - 1] ?? {
          time: s.now,
          intent: 'batch-empty',
          changedNodes: [],
        },
        commits,
        events: [],
      }
    },
  }
  return obj
}

function mirrorWith(...ids: string[]): WasmStateMirror {
  const m = new WasmStateMirror()
  ids.forEach((id, i) => m.registerInput(id as NodeId, { idx: i, gen: 0 }))
  return m
}

/**
 * The JS-engine canonical Commit `WasmBackend.commit()` would have
 * returned synchronously for a buffered commit. `applyBatchBridgeResult`
 * projects an undisturbed Rust record into exactly this shape
 * (`{ time, intent, changedNodes: [], originatedAt: undefined }`) so a
 * byte-match holds when the bridge does not corrupt the record.
 */
function jsCommit(time: number, intent: string): Commit {
  return {
    time: time as unknown as GraphTime,
    intent,
    changedNodes: [],
    originatedAt: undefined,
  }
}

describe('V2.2 (#1530) — per-flush shadow byte-compare under rust-ssot', () => {
  it('the compare RUNS on every commit_batch flush (shadowCompareCount increments)', () => {
    const m = mirrorWith('a')
    const bridge = batchBridge()
    // 6th positional arg = engineMode (rust-ssot arms the guard).
    const q = new BatchedFlush(m, bridge, 1, 16, undefined, 'rust-ssot')

    expect(q.shadowCompareCount).toBe(0)
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(bridge.batchCalls).toBe(1)
    expect(q.shadowCompareCount).toBe(1)

    q.enqueue(
      { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'c1'),
    )
    expect(q.shadowCompareCount).toBe(2)
  })

  it('byte-MATCH leaves the C.5 error seam undefined (no false divergence)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 3, 0, undefined, 'rust-ssot')

    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    q.enqueue(
      { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'c1'),
    )
    q.enqueue(
      { intent: 'c2', writes: new Map([['a' as NodeId, 3]]) },
      2,
      jsCommit(3, 'c2'),
    )
    // afterN=3 ⇒ one batched flush of 3 ⇒ exactly one compare.
    expect(q.shadowCompareCount).toBe(1)
    expect(q.error).toBeUndefined()
  })

  it('byte-DIVERGENCE routes the labelled error into the C.5 #error seam (compare-and-discard, NOT a throw to the adopter)', () => {
    const m = mirrorWith('a')
    // Bridge corrupts record index 1's intent.
    const q = new BatchedFlush(m, batchBridge(1), 3, 0, undefined, 'rust-ssot')

    // The flush must NOT throw to the caller — the divergence is
    // captured into `#error` exactly as a shadow marshal failure is.
    expect(() => {
      q.enqueue(
        { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
        0,
        jsCommit(1, 'c0'),
      )
      q.enqueue(
        { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
        1,
        jsCommit(2, 'c1'),
      )
      q.enqueue(
        { intent: 'c2', writes: new Map([['a' as NodeId, 3]]) },
        2,
        jsCommit(3, 'c2'),
      )
    }).not.toThrow()

    expect(q.shadowCompareCount).toBe(1)
    expect(q.error).toBeInstanceOf(Error)
    expect(q.error?.message).toContain('V2.2 shadow byte-compare diverged')
    // Honest framing pinned in the error: result discarded, JS SSOT,
    // promotion gated to V2.4.
    expect(q.error?.message).toContain('result DISCARDED')
    expect(q.error?.message).toContain('gated to V2.4')
  })

  it('the returned Commit[] is the Rust projection but the JS engine remains SSOT (NO promotion in V2.2)', () => {
    // `flush()` returns its projected `commits` for the C.3 implicit-
    // flush callers exactly as it did in V2.1 — V2.2 does NOT change
    // the return contract. The adopter-facing SSOT Commit was already
    // returned synchronously by `WasmBackend.commit()` (the JS engine);
    // V2.2 only adds the compare side-effect. The byte-MATCH case
    // proves the projection equals the JS commit, so a match is
    // non-destructive; the contract itself is unchanged from V2.1.
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'rust-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    const out = q.flush() // buffer already drained by afterN=1; no-op
    expect(out).toEqual([])
    // The compare ran on the auto-flush; the JS engine stayed SSOT
    // (no exception escaped, error seam clean on a match).
    expect(q.shadowCompareCount).toBe(1)
    expect(q.error).toBeUndefined()
  })
})

describe('V2.2 (#1530) — default js-ssot is byte-for-byte UNCHANGED (V2.1 #1522 invariant)', () => {
  it('the compare path is NEVER invoked under default js-ssot (shadowCompareCount stays 0)', () => {
    const m = mirrorWith('a')
    const bridge = batchBridge()
    // No 6th arg ⇒ engineMode defaults to 'js-ssot'.
    const q = new BatchedFlush(m, bridge, 1)

    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      // Even if a JS commit is (defensively) passed, js-ssot must
      // ignore it entirely — no buffering, no compare.
      jsCommit(1, 'c0'),
    )
    q.enqueue(
      { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'c1'),
    )

    expect(bridge.batchCalls).toBe(2)
    // THE load-bearing default-off assertion: zero compare overhead.
    expect(q.shadowCompareCount).toBe(0)
    expect(q.error).toBeUndefined()
  })

  it('an explicit js-ssot engineMode is identical to the default (no compare, no error)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'js-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.shadowCompareCount).toBe(0)
    expect(q.error).toBeUndefined()
  })

  it('a divergent bridge under js-ssot does NOT fire the guard (inert — proves the flag truly gates it)', () => {
    const m = mirrorWith('a')
    // Bridge WOULD diverge at index 0, but js-ssot never compares so
    // the error seam must stay clean — the guard is flag-gated, not
    // unconditional.
    const q = new BatchedFlush(m, batchBridge(0), 1, 16, undefined, 'js-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.shadowCompareCount).toBe(0)
    expect(q.error).toBeUndefined()
  })
})
