/**
 * C.3 (#1501) — unit tests for the `BatchedFlush` queue.
 *
 * Option (c) batched-commit boundary scaffolding (epic #1493). Per
 * `docs/epic-1483/option-c-batched-boundary.md` §2.1 Answer C the JS
 * engine is SSOT; the queue buffers ONLY the WASM-side wire crossing.
 *
 * NOTE: option (c) delivers ZERO adopter perf at v1.x — these tests
 * assert the queue is correct scaffolding, NOT a perf win. With the
 * default afterN=1 the queue flushes every commit, byte-identical to
 * the pre-C.3 per-commit shadow path (option-c doc §2.3 / §7).
 */

import { describe, it, expect } from 'vitest'
import type { NodeId } from '../src/types.js'
import { WasmStateMirror } from '../wasm/marshaler.js'
import {
  BatchedFlush,
  type BatchedFlushBridge,
  type FlushTimer,
} from '../wasm/index.js'

/**
 * Deterministic fake timer — records the scheduled callback so a test
 * can fire the time-based flush trigger by hand (no real setTimeout,
 * no leaked timers, no flake).
 */
function fakeTimer(): FlushTimer & {
  fire(): void
  scheduled: number
  cancelled: number
} {
  let pending: (() => void) | undefined
  const obj = {
    scheduled: 0,
    cancelled: 0,
    schedule(callback: () => void) {
      obj.scheduled += 1
      pending = callback
      return { id: obj.scheduled }
    },
    cancel() {
      obj.cancelled += 1
      pending = undefined
    },
    fire() {
      const cb = pending
      pending = undefined
      cb?.()
    },
  }
  return obj
}

/**
 * Recording bridge that implements `commit_batch` by deterministically
 * synthesising a BatchBridgeResult from the marshaled envelope (it does
 * not run a real engine — the Rust-side byte-identity is pinned by
 * C.1's tests; here we only exercise the queue's buffering + flush
 * trigger logic + projection wiring).
 */
function recordingBatchBridge(): BatchedFlushBridge & {
  batchCalls: { state: unknown; actions: unknown }[]
  singleCalls: { state: unknown; action: unknown }[]
} {
  const batchCalls: { state: unknown; actions: unknown }[] = []
  const singleCalls: { state: unknown; action: unknown }[] = []
  return {
    batchCalls,
    singleCalls,
    commit(state: unknown, action: unknown) {
      singleCalls.push({ state, action })
      const a = action as { intent: string }
      const s = state as { now: number; inputs: unknown[] }
      return {
        state: { now: s.now + 1, inputs: s.inputs },
        commit: { time: s.now + 1, intent: a.intent, changedNodes: [] },
        events: [],
      }
    },
    commit_batch(state: unknown, actions: unknown) {
      batchCalls.push({ state, actions })
      const acts = actions as { intent: string }[]
      const s = state as { now: number; inputs: unknown[] }
      const commits = acts.map((act, i) => ({
        time: s.now + i + 1,
        intent: act.intent,
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
}

/** A bridge WITHOUT commit_batch — exercises the degrade path. */
function singleOnlyBridge(): BatchedFlushBridge & {
  singleCalls: number
} {
  const obj = {
    singleCalls: 0,
    commit(state: unknown, action: unknown) {
      obj.singleCalls += 1
      const a = action as { intent: string }
      const s = state as { now: number; inputs: unknown[] }
      return {
        state: { now: s.now + 1, inputs: s.inputs },
        commit: { time: s.now + 1, intent: a.intent, changedNodes: [] },
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

describe('BatchedFlush — C.3 (#1501) construction', () => {
  it('rejects afterN < 1', () => {
    const m = mirrorWith('a')
    expect(() => new BatchedFlush(m, recordingBatchBridge(), 0)).toThrow(
      RangeError,
    )
    expect(() => new BatchedFlush(m, recordingBatchBridge(), -1)).toThrow(
      RangeError,
    )
  })

  it('rejects non-integer afterN', () => {
    const m = mirrorWith('a')
    expect(() => new BatchedFlush(m, recordingBatchBridge(), 1.5)).toThrow(
      RangeError,
    )
  })

  it('defaults afterN to 1 (byte-identical to pre-C.3 per-commit path)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, recordingBatchBridge())
    expect(q.afterN).toBe(1)
    expect(q.pending).toBe(0)
  })
})

describe('BatchedFlush — count-based flush', () => {
  it('afterN=1 flushes immediately on every enqueue (one commit_batch per commit)', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const q = new BatchedFlush(m, bridge, 1)

    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(q.pending).toBe(0)
    expect(bridge.batchCalls).toHaveLength(1)

    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 1)
    expect(bridge.batchCalls).toHaveLength(2)
    // Each flush carries exactly one action.
    expect((bridge.batchCalls[0]?.actions as unknown[]).length).toBe(1)
  })

  it('afterN=3 buffers until the 3rd commit then flushes as one batch', () => {
    const m = mirrorWith('a', 'b')
    const bridge = recordingBatchBridge()
    const q = new BatchedFlush(m, bridge, 3)

    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(q.pending).toBe(1)
    expect(bridge.batchCalls).toHaveLength(0)

    q.enqueue({ intent: 'c1', writes: new Map([['b' as NodeId, 2]]) }, 0)
    expect(q.pending).toBe(2)
    expect(bridge.batchCalls).toHaveLength(0)

    q.enqueue({ intent: 'c2', writes: new Map([['a' as NodeId, 3]]) }, 0)
    // Threshold reached — one batch envelope with all 3 actions.
    expect(q.pending).toBe(0)
    expect(bridge.batchCalls).toHaveLength(1)
    expect((bridge.batchCalls[0]?.actions as unknown[]).length).toBe(3)
  })

  it('the batch envelope state.now is the FIRST buffered commit base clock', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const q = new BatchedFlush(m, bridge, 2)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 41)
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 42)
    expect(bridge.batchCalls).toHaveLength(1)
    const state = bridge.batchCalls[0]?.state as { now: number }
    expect(state.now).toBe(41) // first commit's base clock, not 42
  })
})

describe('BatchedFlush — manual flush()', () => {
  it('flushes a partial buffer on demand and returns the projected Commits', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const q = new BatchedFlush(m, bridge, 10)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 0)
    expect(q.pending).toBe(2)

    const commits = q.flush()
    expect(q.pending).toBe(0)
    expect(commits.map((c) => c.intent)).toEqual(['c0', 'c1'])
    expect(bridge.batchCalls).toHaveLength(1)
  })

  it('flush() on an empty buffer is a no-op returning []', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const q = new BatchedFlush(m, bridge, 5)
    expect(q.flush()).toEqual([])
    expect(bridge.batchCalls).toHaveLength(0)
  })
})

describe('BatchedFlush — degrade path (no commit_batch extern)', () => {
  it('replays the buffer as N sequential single-commit calls', () => {
    const m = mirrorWith('a')
    const bridge = singleOnlyBridge()
    const q = new BatchedFlush(m, bridge, 3)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 0)
    q.enqueue({ intent: 'c2', writes: new Map([['a' as NodeId, 3]]) }, 0)
    // No batched extern — N sequential single-commit shadow calls,
    // byte-identical by construction (option-c doc §3.1).
    expect(bridge.singleCalls).toBe(3)
    expect(q.pending).toBe(0)
  })
})

describe('BatchedFlush — error capture (shadow path, TS graph SSOT)', () => {
  it('captures a flush throw in .error without re-throwing', () => {
    const m = mirrorWith('a')
    const throwingBridge: BatchedFlushBridge = {
      commit() {
        throw new Error('single commit boom')
      },
      commit_batch() {
        throw new Error('batch boom')
      },
    }
    const q = new BatchedFlush(m, throwingBridge, 1)
    // Does NOT throw — the TS graph is SSOT; shadow failures are
    // captured for the cross-backend gate's assertion path.
    expect(() =>
      q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0),
    ).not.toThrow()
    expect(q.error).toBeInstanceOf(Error)
    expect(q.error?.message).toBe('batch boom')
  })

  it('clears .error on the next successful flush', () => {
    const m = mirrorWith('a')
    let fail = true
    const flakyBridge: BatchedFlushBridge = {
      commit() {
        throw new Error('unused')
      },
      commit_batch(state: unknown, actions: unknown) {
        if (fail) throw new Error('transient')
        const s = state as { now: number; inputs: unknown[] }
        const acts = actions as { intent: string }[]
        return {
          state: { now: s.now + acts.length, inputs: s.inputs },
          commit: { time: s.now + 1, intent: 'ok', changedNodes: [] },
          commits: acts.map((a, i) => ({
            time: s.now + i + 1,
            intent: a.intent,
            changedNodes: [],
          })),
          events: [],
        }
      },
    }
    const q = new BatchedFlush(m, flakyBridge, 1)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(q.error).toBeInstanceOf(Error)
    fail = false
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 1)
    expect(q.error).toBeUndefined()
  })
})

describe('BatchedFlush — C.3 PR 2 time-based trigger', () => {
  it('rejects negative / non-finite intervalMs', () => {
    const m = mirrorWith('a')
    expect(
      () => new BatchedFlush(m, recordingBatchBridge(), 1, -1),
    ).toThrow(RangeError)
    expect(
      () => new BatchedFlush(m, recordingBatchBridge(), 1, NaN),
    ).toThrow(RangeError)
  })

  it('defaults intervalMs to 16 (one 60 Hz frame, option-c doc §2.2)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, recordingBatchBridge())
    expect(q.intervalMs).toBe(16)
  })

  it('arms the timer on the first buffered commit (afterN large)', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 16, t)
    expect(q.timerArmed).toBe(false)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(q.timerArmed).toBe(true)
    expect(t.scheduled).toBe(1)
    expect(bridge.batchCalls).toHaveLength(0) // count threshold not hit
  })

  it('firing the timer flushes the buffered window', () => {
    const m = mirrorWith('a', 'b')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 16, t)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    q.enqueue({ intent: 'c1', writes: new Map([['b' as NodeId, 2]]) }, 0)
    expect(q.pending).toBe(2)
    t.fire()
    expect(q.pending).toBe(0)
    expect(bridge.batchCalls).toHaveLength(1)
    expect((bridge.batchCalls[0]?.actions as unknown[]).length).toBe(2)
    expect(q.timerArmed).toBe(false)
  })

  it('a count-flush cancels the pending time trigger (no double-flush)', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 2, 16, t)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(t.scheduled).toBe(1)
    expect(q.timerArmed).toBe(true)
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 0)
    // count threshold (2) flushed; timer cancelled.
    expect(bridge.batchCalls).toHaveLength(1)
    expect(t.cancelled).toBe(1)
    expect(q.timerArmed).toBe(false)
    // Firing the (now cancelled) timer is a no-op — buffer empty.
    t.fire()
    expect(bridge.batchCalls).toHaveLength(1)
  })

  it('re-arms the timer for the NEXT window after a flush', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 16, t)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    t.fire() // flush window 1
    expect(bridge.batchCalls).toHaveLength(1)
    q.enqueue({ intent: 'c1', writes: new Map([['a' as NodeId, 2]]) }, 1)
    expect(q.timerArmed).toBe(true) // re-armed for window 2
    expect(t.scheduled).toBe(2)
  })

  it('intervalMs=0 disables the time trigger (count/manual only)', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 0, t)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    expect(q.timerArmed).toBe(false)
    expect(t.scheduled).toBe(0)
    expect(q.pending).toBe(1) // buffered, no time flush
  })

  it('cancelTimer() releases the timer without flushing the buffer', () => {
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 16, t)
    q.enqueue({ intent: 'c0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    q.cancelTimer()
    expect(q.timerArmed).toBe(false)
    expect(q.pending).toBe(1) // buffer NOT drained
    expect(bridge.batchCalls).toHaveLength(0)
  })
})

describe('WasmBackend.flush() — C.3 PR 2 manual escape hatch', () => {
  it('returns [] when no BatchedFlush queue is installed', async () => {
    const wasmMod = await import('../wasm/index.js')
    const backend = wasmMod.__createWasmBackendSyncForTests(
      'causl.test.c3pr2.nobf',
    )
    // No __primeBatchedFlushForTests — default config.
    expect(
      (backend as unknown as { flush(): unknown[] }).flush(),
    ).toEqual([])
  })

  it('drains a primed queue and returns the projected Commits', async () => {
    const wasmMod = await import('../wasm/index.js')
    const backend = wasmMod.__createWasmBackendSyncForTests(
      'causl.test.c3pr2.bf',
    ) as unknown as {
      __primeBatchedFlushForTests(q: BatchedFlush): void
      flush(): { intent: string }[]
    }
    const m = mirrorWith('a')
    const bridge = recordingBatchBridge()
    const t = fakeTimer()
    const q = new BatchedFlush(m, bridge, 100, 16, t)
    backend.__primeBatchedFlushForTests(q)
    q.enqueue({ intent: 'manual0', writes: new Map([['a' as NodeId, 1]]) }, 0)
    q.enqueue({ intent: 'manual1', writes: new Map([['a' as NodeId, 2]]) }, 0)
    const commits = backend.flush()
    expect(commits.map((c) => c.intent)).toEqual(['manual0', 'manual1'])
    expect(q.pending).toBe(0)
  })
})
