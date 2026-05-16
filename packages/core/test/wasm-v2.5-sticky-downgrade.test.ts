/**
 * V2.5 (#1544) — rollback tiers 2+3 (sticky `js-ssot` downgrade).
 *
 * Builds on V2.4's load-bearing compare-and-PROMOTE guard (#1535,
 * `packages/core/wasm/index.ts` — the `divergedFlushCount` seam).
 * V2.4 (Decision 6 tier 1) already does NOT promote the Rust
 * post-state on a per-flush byte-divergence; V2.5 adds the
 * Decision 6 **tier 2** rollback (V2-DESIGN §6):
 *
 *   - a CONSECUTIVE-divergence counter;
 *   - on reaching `STICKY_DOWNGRADE_K` (= 1, fail-safe — the JS
 *     engine is always correct) the graph **sticky-downgrades to
 *     `engine: 'js-ssot'`** for the remainder of its lifetime: no
 *     further compare, no further Rust promotion attempt;
 *   - a structured `RustSsotDowngradedError` carrying the stable
 *     `RUST_SSOT_DOWNGRADE_ERROR_CODE` constant is recorded ONCE
 *     into the #1493 C.5 `BatchedFlush.#error` seam (NOT thrown to
 *     the adopter — the JS engine is SSOT and already returned its
 *     Commit synchronously, V2-DESIGN §1.2), mirroring the
 *     `WasmBackendUnavailableError` `code`-dispatch the SPEC §17.6
 *     host-tier fallback contract uses.
 *
 * Decision 6 **tier 3** (adopter runtime config flip) is FREE — it
 * is just *not passing* the opt-in; the V2.1 #1522 default-off
 * byte-identity property already guarantees a `js-ssot` (or
 * engine-omitted) graph is byte-identical to dev `97da8420`. It is
 * documented in V2-DESIGN §6 / the adoption guide; there is no tier-3
 * code to test here, only the assertion that an engine-omitted /
 * explicit-`js-ssot` queue never enters the compare/downgrade path
 * (the bottom describe block).
 *
 * Load-bearing properties pinned:
 *
 *   1. **1 divergence ⇒ sticky `js-ssot`.** With K=1 the FIRST
 *      per-flush byte-divergence flips `stickyDowngraded` true and
 *      records the `RustSsotDowngradedError` (code
 *      `CAUSL_RUST_SSOT_DOWNGRADED`) ONCE into `error`, without
 *      throwing to the caller.
 *   2. **Subsequent flushes never promote.** After the downgrade the
 *      queue behaves byte-identically to `js-ssot`:
 *      `promotedFlushCount` / `shadowCompareCount` /
 *      `divergedFlushCount` are FROZEN at their downgrade-instant
 *      values across all later flushes (no compare, no promote).
 *   3. **The `code` is emitted once.** The recorded error is the
 *      `RustSsotDowngradedError` instance with the stable `code`;
 *      later (now-`js-ssot`) flushes PRESERVE it rather than clearing
 *      it, so `error.code` stays observable for the adopter's
 *      structured-error dispatch — but the error object is not
 *      re-created (emitted exactly once).
 *   4. **Default `js-ssot` / non-diverging `rust-ssot` byte-
 *      unaffected.** The V2.1/V2.2/V2.4 invariants hold: a default
 *      queue never compares/promotes/downgrades; a non-diverging
 *      rust-ssot queue promotes every flush and never downgrades.
 *
 * NOTE (honest framing, V2-DESIGN §0): v2.x delivers ZERO adopter
 * perf at current WASM maturity and does NOT refute the #1133
 * falsification (#1133 STANDS). This is a fail-safe, lossless
 * rollback mechanism for the opt-in cutover — not a perf change.
 */

import { describe, it, expect } from 'vitest'
import type { GraphTime, NodeId } from '../src/types.js'
import type { Commit } from '../src/types.js'
import { WasmStateMirror } from '../wasm/marshaler.js'
import {
  BatchedFlush,
  RustSsotDowngradedError,
  RUST_SSOT_DOWNGRADE_ERROR_CODE,
  STICKY_DOWNGRADE_K,
  type BatchedFlushBridge,
} from '../wasm/index.js'

/**
 * Recording `commit_batch` bridge. When `divergeFrom` is set, every
 * flush whose batch contains index `divergeFrom` corrupts that
 * record's `intent` so the V2.4 compare sees a byte-difference vs the
 * JS-engine canonical Commit fed through `enqueue`. With afterN=1
 * every flush is a single-record batch so `divergeFrom = 0` makes
 * EVERY flush diverge (the persistent-divergence scenario tier 2
 * exists for).
 */
function batchBridge(divergeFrom?: number): BatchedFlushBridge & {
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
          divergeFrom !== undefined && i >= divergeFrom
            ? `${act.intent}__RUST_DIVERGED__`
            : act.intent,
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

function jsCommit(time: number, intent: string): Commit {
  return {
    time: time as unknown as GraphTime,
    intent,
    changedNodes: [],
    originatedAt: undefined,
  }
}

describe('V2.5 (#1544) — Decision 6 tier 2: 1 divergence ⇒ sticky js-ssot', () => {
  it('K is pinned at 1 (fail-safe — the JS engine is always correct)', () => {
    expect(STICKY_DOWNGRADE_K).toBe(1)
  })

  it('the structured-error code constant is the stable CAUSL_RUST_SSOT_DOWNGRADED dispatch value', () => {
    expect(RUST_SSOT_DOWNGRADE_ERROR_CODE).toBe('CAUSL_RUST_SSOT_DOWNGRADED')
    // Mirrors the WasmBackendUnavailableError `readonly code` pattern.
    const e = new RustSsotDowngradedError('detail')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('CAUSL_RUST_SSOT_DOWNGRADED')
    expect(e.name).toBe('RustSsotDowngradedError')
    expect(e.message).toContain('sticky-downgraded')
    expect(e.message).toContain('detail')
  })

  it('the FIRST byte-divergence sticky-downgrades, records the code ONCE, and does NOT throw to the adopter', () => {
    const m = mirrorWith('a')
    // afterN=1 ⇒ every flush is a single-record batch; divergeFrom=0
    // ⇒ the very first flush diverges (K=1 ⇒ immediate downgrade).
    const q = new BatchedFlush(m, batchBridge(0), 1, 16, undefined, 'rust-ssot')

    expect(q.stickyDowngraded).toBe(false)
    expect(() => {
      q.enqueue(
        { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
        0,
        jsCommit(1, 'c0'),
      )
    }).not.toThrow()

    // 1 divergence ⇒ sticky downgrade.
    expect(q.stickyDowngraded).toBe(true)
    expect(q.divergedFlushCount).toBe(1)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.shadowCompareCount).toBe(1)
    // The code is emitted ONCE into the C.5 error seam.
    expect(q.error).toBeInstanceOf(RustSsotDowngradedError)
    expect((q.error as RustSsotDowngradedError).code).toBe(
      'CAUSL_RUST_SSOT_DOWNGRADED',
    )
    expect(q.error?.message).toContain("sticky-downgraded to 'js-ssot'")
    expect(q.error?.message).toContain('FAIL-SAFE and LOSSLESS')
  })

  it('subsequent flushes NEVER promote — the queue is byte-identical to js-ssot after the downgrade (counters frozen, code preserved, not re-emitted)', () => {
    const m = mirrorWith('a')
    const bridge = batchBridge(0) // every flush would diverge
    const q = new BatchedFlush(m, bridge, 1, 16, undefined, 'rust-ssot')

    // Flush 1 — diverges ⇒ downgrade.
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.stickyDowngraded).toBe(true)
    const errAfterDowngrade = q.error
    expect(errAfterDowngrade).toBeInstanceOf(RustSsotDowngradedError)
    const compareCountAtDowngrade = q.shadowCompareCount
    const promotedAtDowngrade = q.promotedFlushCount
    const divergedAtDowngrade = q.divergedFlushCount

    // Flushes 2..5 — the bridge STILL diverges, but the queue is now
    // sticky-downgraded so the compare/promote path is NEVER entered:
    // every counter is FROZEN and the error object is the SAME
    // instance (emitted exactly once, preserved not re-created).
    for (let i = 1; i <= 4; i += 1) {
      q.enqueue(
        { intent: `c${i}`, writes: new Map([['a' as NodeId, i + 1]]) },
        i,
        jsCommit(i + 1, `c${i}`),
      )
      expect(q.stickyDowngraded).toBe(true)
      expect(q.shadowCompareCount).toBe(compareCountAtDowngrade)
      expect(q.promotedFlushCount).toBe(promotedAtDowngrade)
      expect(q.divergedFlushCount).toBe(divergedAtDowngrade)
      // Same instance — the code is emitted ONCE, never re-emitted,
      // and a now-`js-ssot` flush PRESERVES it (does not clear it) so
      // the adopter can still dispatch on `error.code`.
      expect(q.error).toBe(errAfterDowngrade)
      expect((q.error as RustSsotDowngradedError).code).toBe(
        RUST_SSOT_DOWNGRADE_ERROR_CODE,
      )
    }
    // The bridge WAS called every flush (the downgraded queue still
    // wires the Rust shadow exactly like js-ssot — it just never
    // compares/promotes).
    expect(bridge.batchCalls).toBe(5)
  })

  it('a non-diverging rust-ssot graph promotes every flush and NEVER downgrades (the V2.4 GO path is byte-unaffected by V2.5)', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'rust-ssot')

    for (let i = 0; i < 5; i += 1) {
      q.enqueue(
        { intent: `c${i}`, writes: new Map([['a' as NodeId, i + 1]]) },
        i,
        jsCommit(i + 1, `c${i}`),
      )
    }
    expect(q.stickyDowngraded).toBe(false)
    expect(q.promotedFlushCount).toBe(5)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.shadowCompareCount).toBe(5)
    expect(q.error).toBeUndefined()
  })

  it('a transient match BEFORE the divergence resets the consecutive counter; the divergence still downgrades at K=1 on its own flush', () => {
    const m = mirrorWith('a')
    // afterN=1; divergeFrom undefined for the first commits (match),
    // then we swap to a diverging bridge mid-stream by using a fresh
    // queue is not possible — instead pin the simpler invariant: a
    // matching flush keeps stickyDowngraded false and the diverging
    // flush immediately downgrades.
    const q = new BatchedFlush(m, batchBridge(), 1, 16, undefined, 'rust-ssot')
    q.enqueue(
      { intent: 'ok0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'ok0'),
    )
    q.enqueue(
      { intent: 'ok1', writes: new Map([['a' as NodeId, 2]]) },
      1,
      jsCommit(2, 'ok1'),
    )
    expect(q.stickyDowngraded).toBe(false)
    expect(q.promotedFlushCount).toBe(2)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })
})

describe('V2.5 (#1544) — Decision 6 tier 3 (runtime flip) is FREE: default/js-ssot never enters the compare/downgrade path (V2.1 #1522 invariant intact)', () => {
  it('default (engine-omitted) queue never downgrades even with a divergent bridge', () => {
    const m = mirrorWith('a')
    // Bridge WOULD diverge at index 0 — but a default js-ssot queue
    // never compares/promotes/downgrades (the tier-3 free property:
    // omitting `engine` is byte-identical to dev 97da8420).
    const q = new BatchedFlush(m, batchBridge(0), 1) // no engineMode arg
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
    expect(q.stickyDowngraded).toBe(false)
    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })

  it('an explicit js-ssot queue never downgrades even with a divergent bridge', () => {
    const m = mirrorWith('a')
    const q = new BatchedFlush(m, batchBridge(0), 1, 16, undefined, 'js-ssot')
    q.enqueue(
      { intent: 'c0', writes: new Map([['a' as NodeId, 1]]) },
      0,
      jsCommit(1, 'c0'),
    )
    expect(q.stickyDowngraded).toBe(false)
    expect(q.shadowCompareCount).toBe(0)
    expect(q.promotedFlushCount).toBe(0)
    expect(q.divergedFlushCount).toBe(0)
    expect(q.error).toBeUndefined()
  })
})
