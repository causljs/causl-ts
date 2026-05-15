/**
 * V2.2 (#1530) → V2.4 (#1534) — per-flush byte-compare guard tests.
 *
 * V2.2 landed the guard as **compare-and-DISCARD**. V2.4 (the
 * F-marshal.5 analog, epic #1515 decomposition #1516; predecessors
 * V2.1 #1522, V2.2 #1530, V2.3 #1532) **FLIPS** it to
 * **compare-and-PROMOTE**: under `engine: 'rust-ssot'` every
 * `commit_batch` flush byte-compares the Rust projection against the
 * JS-engine canonical `Commit[]` and, on a byte-MATCH, the Rust
 * post-state is PROMOTED as canonical for the WASM-side mirror; on a
 * byte-DIVERGENCE it is NOT promoted (the mirror is rolled back to the
 * JS-engine-equivalent post-state — Decision 6 tier 1) and the
 * labelled divergence is recorded into the #1493 C.5
 * `BatchedFlush.#error` seam.
 *
 * The load-bearing properties this file pins (now under V2.4):
 *
 *   1. **Compare RUNS + PROMOTES under rust-ssot.** A flush
 *      increments `shadowCompareCount`; on byte-match it increments
 *      `promotedFlushCount`, leaves `error` undefined, and leaves
 *      `divergedFlushCount === 0`.
 *
 *   2. **Divergence DOES NOT PROMOTE.** On a corrupt Rust record the
 *      flush increments `divergedFlushCount` (NOT `promotedFlushCount`),
 *      routes the labelled `V2.4 promote byte-compare DIVERGED` error
 *      into the C.5 `error` seam WITHOUT throwing to the adopter, and
 *      rolls the mirror back so the divergent Rust post-state is not
 *      promoted.
 *
 *   3. **Default `js-ssot` is byte-for-byte UNCHANGED.** The
 *      compare/promote path is never entered (`shadowCompareCount ===
 *      0`, `promotedFlushCount === 0`), the queue buffers no JS
 *      commits, and flush output is identical to a js-ssot queue — the
 *      load-bearing V2.1 #1522 invariant holds. Promotion is
 *      rust-ssot-only and never leaks into the default.
 *
 * NOTE: v2.x delivers ZERO adopter perf at current WASM maturity and
 * does NOT refute the #1133 falsification. V2.4 is the gated promotion
 * GO/NO-GO; the value prop is large-tree GC-survival (#1525), not a
 * perf win.
 */

import { describe, it, expect } from 'vitest'
import type { GraphTime, NodeId } from '../src/types.js'
import type { Commit } from '../src/types.js'
import { WasmStateMirror } from '../wasm/marshaler.js'
import { BatchedFlush, type BatchedFlushBridge } from '../wasm/index.js'

/**
 * Recording `commit_batch` bridge. `divergeAt` (when set) corrupts the
 * `intent` of the record at that index so the V2.4 compare sees a
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

describe('V2.4 (#1534) — per-flush compare-and-PROMOTE under rust-ssot', () => {
  it('the compare RUNS + PROMOTES on every commit_batch flush (byte-match)', () => {
    const m = mirrorWith('a')
    const bridge = batchBridge()
    // 6th positional arg = engineMode (rust-ssot arms the guard).
    const q = new BatchedFlush(m, bridge, 1, 16, undefined, 'rust-ssot')

    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(bridge.batchCalls).toBe(1)
    expect(q.shadowCompareCount).toBe(1)
    // V2.4 — byte-match ⇒ Rust post-state PROMOTED.
    expect(q.promotedFlushCount).toBe(1)
    expect(q.divergedFlushCount).toBe(0)

    q.enqueue(
      { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'c1'),
    )
    expect(q.shadowCompareCount).toBe(2)
    expect(q.promotedFlushCount).toBe(2)
    expect(q.divergedFlushCount).toBe(0)
  })

  it('byte-MATCH promotes the Rust post-state into the mirror and leaves the C.5 error seam undefined', () => {
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
    // afterN=3 ⇒ one batched flush of 3 ⇒ exactly one compare+promote.
    expect(q.shadowCompareCount).toBe(1)
    expect(q.promotedFlushCount).toBe(1)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
    // The Rust post-state was promoted: mirror.now advanced to the
    // post-batch clock (base 0 + 3 actions).
    expect(m.now).toBe(3 as unknown as GraphTime)
  })

  it('byte-DIVERGENCE does NOT promote: routes the labelled error into the C.5 #error seam, rolls the mirror back, NO throw to the adopter (the V2.4 NO-GO halt mechanism)', () => {
    const m = mirrorWith('a')
    // Bridge corrupts record index 1's intent.
    const q = new BatchedFlush(m, batchBridge(1), 3, 0, undefined, 'rust-ssot')

    // The flush must NOT throw to the caller — the divergence is
    // captured into `#error` (the JS engine is SSOT and already
    // returned its Commit synchronously).
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
    // V2.4 — divergence ⇒ NOT promoted.
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(1)
    expect(q.error).toBeInstanceOf(Error)
    expect(q.error?.message).toContain('V2.4 promote byte-compare DIVERGED')
    expect(q.error?.message).toContain('was NOT promoted')
    expect(q.error?.message).toContain('rolled back')
    expect(q.error?.message).toContain('NO-GO')
    // Mirror rolled back to the pre-flush JS-engine-equivalent
    // post-state (Decision 6 tier 1): the divergent Rust post-state
    // (which would have advanced now to 3) was NOT promoted.
    expect(m.now).toBe(0 as unknown as GraphTime)
  })

  it('the returned Commit[] is the promoted Rust projection on a match, empty on a divergence', () => {
    // On a byte-match the projected `commits` are returned for the
    // C.3 implicit-flush callers (and the mirror is promoted). On a
    // divergence the return is empty (nothing promoted) — the JS
    // engine already returned the adopter-facing SSOT Commit
    // synchronously from `WasmBackend.commit()` (Decision 1.2).
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'rust-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    const out = q.flush() // buffer already drained by afterN=1; no-op
    expect(out).toEqual([])
    expect(q.shadowCompareCount).toBe(1)
    expect(q.promotedFlushCount).toBe(1)
    expect(q.error).toBeUndefined()
  })
})

describe('V2.4 (#1534) — default js-ssot is byte-for-byte UNCHANGED (V2.1 #1522 invariant; promotion never leaks into the default)', () => {
  it('the compare/promote path is NEVER invoked under default js-ssot (shadowCompareCount + promotedFlushCount stay 0)', () => {
    const m = mirrorWith('a')
    const bridge = batchBridge()
    // No 6th arg ⇒ engineMode defaults to 'js-ssot'.
    const q = new BatchedFlush(m, bridge, 1)

    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      // Even if a JS commit is (defensively) passed, js-ssot must
      // ignore it entirely — no buffering, no compare, no promote.
      jsCommit(1, 'c0'),
    )
    q.enqueue(
      { intent: 'c1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'c1'),
    )

    expect(bridge.batchCalls).toBe(2)
    // THE load-bearing default-off assertion: zero compare/promote.
    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })

  it('an explicit js-ssot engineMode is identical to the default (no compare, no promote, no error)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'js-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })

  it('a divergent bridge under js-ssot does NOT fire the guard (inert — proves promotion is flag-gated, never leaks into the default)', () => {
    const m = mirrorWith('a')
    // Bridge WOULD diverge at index 0, but js-ssot never compares /
    // promotes so the error seam must stay clean — the guard is
    // flag-gated, not unconditional.
    const q = new BatchedFlush(m, batchBridge(0), 1, 16, undefined, 'js-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })
})
