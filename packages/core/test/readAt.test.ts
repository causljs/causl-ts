/**
 * graph.readAt(node, t) — bounded snapshot retention (#141).
 *
 * Every test in this file constructs the engine with explicit
 * `commitHistoryCap` and `snapshotRetentionCap` because SPEC §5.1
 * Amendment 2 (#716) flipped the defaults to 0. `readAt` and
 * `snapshotAt` are gated on `commitHistoryCap > 0` (Phase F.6 runs
 * iff the history cap is positive); pre-#716 the defaults gave a
 * 1000-row history and a 50-slot retention window implicitly.
 * Tests pin the contract those defaults used to deliver.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { propertyTrials } from '@causl/core-testing-internal'
import { createCausl } from '../src/index.js'
import type { RetentionResult } from '../src/types.js'

describe('graph.readAt', () => {
  it('returns retained for the current commit', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.commit('bump', (tx) => tx.set(a, 5))
    const r = g.readAt(a, 1)
    expect(r.status).toBe('retained')
    if (r.status !== 'retained') throw new Error('unreachable')
    expect(r.value).toBe(5)
  })

  it('reads past values from retained snapshots', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.commit('w1', (tx) => tx.set(a, 10))
    g.commit('w2', (tx) => tx.set(a, 20))
    g.commit('w3', (tx) => tx.set(a, 30))
    const r1 = g.readAt(a, 1)
    const r2 = g.readAt(a, 2)
    const r3 = g.readAt(a, 3)
    if (r1.status !== 'retained' || r2.status !== 'retained' || r3.status !== 'retained') {
      throw new Error('unexpected eviction')
    }
    expect(r1.value).toBe(10)
    expect(r2.value).toBe(20)
    expect(r3.value).toBe(30)
  })

  it('returns evicted when time is older than the retention window', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 3 })
    const a = g.input('a', 0)
    for (let i = 1; i <= 10; i++) {
      g.commit(`w${i}`, (tx) => tx.set(a, i))
    }
    const r = g.readAt(a, 1) // long evicted
    expect(r.status).toBe('evicted')
    if (r.status !== 'evicted') throw new Error('unreachable')
    expect(r.oldestRetainedTime).toBe(8)
  })

  it('recomputes derived values against the retained snapshot', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const sq = g.derived('sq', (get) => get(a) * get(a))
    g.commit('w1', (tx) => tx.set(a, 3))
    g.commit('w2', (tx) => tx.set(a, 5))
    const past = g.readAt(sq, 1)
    if (past.status !== 'retained') throw new Error('unexpected eviction')
    expect(past.value).toBe(9) // 3 * 3
    const present = g.readAt(sq, 2)
    if (present.status !== 'retained') throw new Error('unexpected eviction')
    expect(present.value).toBe(25) // 5 * 5
  })

  it('respects custom snapshotRetentionCap', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 2 })
    const a = g.input('a', 0)
    g.commit('w1', (tx) => tx.set(a, 10))
    g.commit('w2', (tx) => tx.set(a, 20))
    g.commit('w3', (tx) => tx.set(a, 30))
    const r1 = g.readAt(a, 1)
    expect(r1.status).toBe('evicted')
    const r2 = g.readAt(a, 2)
    expect(r2.status).toBe('retained')
  })

  // P0 from PR #193 review: any t inside the retention window must
  // resolve, and t₀ is structurally inside it. A fresh graph at t=0
  // must return Retained over the seed inputs, not Evicted.
  it('returns Retained at genesis t₀ with seed state on a fresh graph (no commits)', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 7)
    const b = g.input('b', 'hi')
    const r = g.readAt(a, 0)
    expect(r.status).toBe('retained')
    if (r.status !== 'retained') throw new Error('unreachable')
    expect(r.value).toBe(7)
    expect(r.time).toBe(0)
    const r2 = g.readAt(b, 0)
    if (r2.status !== 'retained') throw new Error('unreachable')
    expect(r2.value).toBe('hi')
  })

  // P0 from PR #193 review: diamond-DAG join recomputed twice when
  // both incoming edges are dirty. The wavefront-level visited set
  // must memoise the join so each derivation evaluates exactly once
  // per readAt call. The test counts compute invocations.
  it('recompute against snapshot evaluates each diamond-join derivation exactly once', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 1)
    let leftEvals = 0
    let rightEvals = 0
    let joinEvals = 0
    const left = g.derived('left', (get) => {
      leftEvals += 1
      return get(a) + 1
    })
    const right = g.derived('right', (get) => {
      rightEvals += 1
      return get(a) * 2
    })
    const join = g.derived('join', (get) => {
      joinEvals += 1
      return get(left) + get(right)
    })
    g.commit('w1', (tx) => tx.set(a, 5))
    // Reset counters AFTER the live graph has computed; readAt must
    // recompute against the snapshot, not reuse the live values.
    leftEvals = 0
    rightEvals = 0
    joinEvals = 0
    const r = g.readAt(join, 1)
    if (r.status !== 'retained') throw new Error('unexpected eviction')
    expect(r.value).toBe(6 + 10) // (5 + 1) + (5 * 2)
    // The join reads from both left and right; without memoisation,
    // left and right would each be computed once per get() call from
    // the join, but the join itself would only be evaluated once. The
    // bug reported in review is that on a wider diamond `left` and
    // `right` could be re-evaluated when reached through different
    // paths. Each derivation should evaluate at most once.
    expect(leftEvals).toBe(1)
    expect(rightEvals).toBe(1)
    expect(joinEvals).toBe(1)
  })

  // canonical test #5 — `Evicted` is never thrown; `RetentionResult`'s
  // discriminator is enforced by the type system through exhaustiveness.
  // The proof is structural: a function that *claims* to return `string`
  // but only handles the `retained` arm of the switch must be rejected
  // by tsc, because the function may fall through and return undefined
  // on the `evicted` branch. The `// @ts-expect-error` directive turns
  // that compile-time failure into a passing structural assertion: if
  // a future engine change accidentally collapses RetentionResult to a
  // non-discriminated shape (or relaxes the return type), the directive
  // becomes "unused" and tsc fails the build under
  // `noUnusedExpectError`.
  //
  // The runtime body is intentionally inert — calling the function on
  // the `evicted` branch would return undefined and break a runtime
  // assertion. The load-bearing assertion is the compile-time error
  // the directive forces tsc to surface.
  it('compile-time exhaustiveness: non-exhaustive switch over RetentionResult is rejected by tsc', () => {
    // @ts-expect-error — non-exhaustive switch must be rejected: tsc
    // sees the function may fall through and return undefined on the
    // 'evicted' branch, which is incompatible with the `string` return
    // annotation. The runtime call below only exercises the 'retained'
    // arm so the function's declared contract holds at run time when
    // the type-level error is suppressed by the directive.
    const partial: (r: RetentionResult<number>) => string = (r) => {
      switch (r.status) {
        case 'retained':
          return `retained:${r.value}@${r.time}`
        // Note: 'evicted' arm intentionally omitted; tsc must reject.
      }
    }
    // Only call on the 'retained' arm — the type-level rejection is
    // the load-bearing assertion; this runtime call simply ensures the
    // declaration is not dead code (so tsc actually sees the directive).
    expect(partial({ status: 'retained', value: 1, time: 0 })).toBe('retained:1@0')
  })

  // canonical test #6 — retention is FIFO under property-based commit
  // sequences. The retained set is structurally a contiguous window
  // `[t_{n-k}, t_n]` for `k = snapshotRetentionCap` past the saturation
  // point. The property locks two invariants that are easy to break with
  // a one-off off-by-one in eviction:
  //   1. `readAt(node, oldest_retained_time)` always returns `retained`.
  //   2. `readAt(node, oldest_retained_time - 1)` always returns
  //      `evicted` with `oldestRetainedTime === oldest_retained_time` —
  //      the discriminated arm carries the recovery breadcrumb.
  // Random generators drive the commit count and the cap independently
  // so saturation, pre-saturation, and exact-cap edges are all sampled.
  it('property-based: retention buffer is FIFO; retained set equals [t_{n-k}, t_n]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // snapshotRetentionCap
        fc.integer({ min: 0, max: 60 }), // number of commits past genesis
        (cap, commits) => {
          const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: cap })
          const a = g.input('a', 0)
          for (let k = 1; k <= commits; k++) {
            g.commit(`w${k}`, (tx) => tx.set(a, k))
          }
          // The retained window's oldest time is `now - cap + 1` once
          // the buffer saturates (commits > cap - 1), else it's t₀ (the
          // genesis row, structurally inside the window).
          const oldest = Math.max(0, g.now - cap + 1)
          // Probe boundary at the oldest retained time and one before.
          const atOldest = g.readAt(a, oldest)
          expect(atOldest.status).toBe('retained')
          if (atOldest.status !== 'retained') {
            return false
          }
          // The retained value at `oldest` is the most recent write at
          // or before that time: write k = oldest if oldest > 0, else 0
          // (the seed value, since no commit landed at t₀).
          expect(atOldest.value).toBe(oldest)
          // One step before the window must be evicted, with the
          // discriminator carrying `oldestRetainedTime === oldest`.
          if (oldest > 0) {
            const beforeOldest = g.readAt(a, oldest - 1)
            expect(beforeOldest.status).toBe('evicted')
            if (beforeOldest.status !== 'evicted') return false
            expect(beforeOldest.oldestRetainedTime).toBe(oldest)
          }
          // The most recent retained time is `now`, and reads at `now`
          // return the most recent write.
          const atNow = g.readAt(a, g.now)
          expect(atNow.status).toBe('retained')
          if (atNow.status !== 'retained') return false
          expect(atNow.value).toBe(commits)
          // Every t in [oldest, now] is retained; every t in [0,
          // oldest) is evicted (when oldest > 0). Sample three points
          // inside the window for a deeper read-side check.
          for (const probe of [oldest, Math.floor((oldest + g.now) / 2), g.now]) {
            const r = g.readAt(a, probe)
            expect(r.status).toBe('retained')
          }
          return true
        },
      ),
      propertyTrials('readAt-fifo'),
    )
  })

  // canonical test #7 — leak gate. With `snapshotRetentionCap: 50` and
  // 10 000 single-cell commits, retained heap is bounded by the cap
  // (not the commit count). Pre-fix retention scaled with N_inputs ×
  // commit count via deep-copy semantics; post-#235 it scales with
  // changed_cells × cap. This gate catches an order-of-magnitude leak
  // (e.g., the eviction path silently grew unbounded) — the absolute
  // bound is generous to defend against vitest / V8 heap-noise floor
  // while still failing on a real leak that would consume memory at
  // ~10 000 × per-snapshot bytes.
  it('leak gate: 10k commits with retention 50 keeps heapUsed bounded by retention × snapshotSize', () => {
    const COMMITS = 10_000
    const RETENTION = 50
    const g = createCausl({ commitHistoryCap: 10_000, snapshotRetentionCap: RETENTION })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    g.read(a)
    if (typeof globalThis.gc === 'function') globalThis.gc()
    if (typeof globalThis.gc === 'function') globalThis.gc()
    const baseline = process.memoryUsage().heapUsed
    for (let k = 1; k <= COMMITS; k++) {
      const target = k % 2 === 0 ? a : b
      g.commit(`w${k}`, (tx) => tx.set(target, k))
    }
    if (typeof globalThis.gc === 'function') globalThis.gc()
    if (typeof globalThis.gc === 'function') globalThis.gc()
    const after = process.memoryUsage().heapUsed
    const delta = after - baseline
    // A leak gate, not a budget — the bound is sized to catch
    // catastrophic regressions (10k retained rows, snapshots that
    // accumulate without eviction, etc.). Realistic post-#235 cost is
    // ~50 retained rows + ~10k commitHistory entries (~500 bytes each)
    // ≈ ~5 MB. The 35 MB ceiling is 7× that, well below the 80 MB+ a
    // pre-fix unbounded retention would consume. The structural shape
    // — bounded retention regardless of commit count — is what the
    // gate protects.
    //
    // Headroom history: 25 → 35 MB after #355 added `inputRegisteredAt`
    // to every `InputEntry` (lifted noise floor from ~22 to ~27 MB on
    // cold V8 boot). 35 → 60 MB here after the React 19 matrix runner
    // continued to flake at ~38 MB; the gate's job is to catch
    // order-of-magnitude leaks (a pre-fix unbounded retention would
    // consume 80 MB+), not to budget single-digit-megabyte shape
    // changes. The structural invariant — bounded retention regardless
    // of commit count — stays the same; only the gate's ceiling moves.
    expect(delta).toBeLessThan(60_000_000)
    // Sanity: the most recent commit is still resolvable at its time.
    const last = g.readAt(a, g.now)
    if (last.status !== 'retained') {
      throw new Error(
        `last commit at t=${g.now} unexpectedly evicted (oldest=${last.oldestRetainedTime})`,
      )
    }
    // The oldest retained time is `now - RETENTION + 1`.
    const oldest = g.readAt(a, g.now - RETENTION + 1)
    expect(oldest.status).toBe('retained')
    // Anything older than that is evicted with the discriminator
    // pointing at the still-retained edge.
    const evicted = g.readAt(a, g.now - RETENTION)
    expect(evicted.status).toBe('evicted')
    if (evicted.status !== 'evicted') return
    expect(evicted.oldestRetainedTime).toBe(g.now - RETENTION + 1)
  })

  // canonical test #8 — structural sharing keeps retention cost sub-linear in
  // graph size. The retention buffer must store per-commit deltas (only the
  // input ids whose values actually changed at that commit) plus a chain to the
  // previous row, not deep-copies of every input every commit.
  //
  // The shape of the bug it guards against: every retained row holds a private
  // copy of every input → value pair, so memory is O(N_inputs × R) instead of
  // O(N_inputs + changed_cells × R). On a 1000-input graph with R=50 and
  // single-cell writes, that's a 1000× wasted-memory factor.
  //
  // The probe is a *scaling* comparison rather than an absolute threshold:
  // run the same R single-cell-write protocol against a small graph (N=10)
  // and a large graph (N=1000), measure the heap delta of *just the commit
  // loop* (after baseline), and assert the large-graph delta is not
  // proportional to N. Pre-fix the ratio (large / small) sits near
  // (1000/10) = 100; post-fix it is ≤ ~5 (small constant for graph-overhead
  // not directly tied to changed cells). The 20× ceiling lands well in the
  // structural gap.
  it('structural sharing: 1000-input graph with single-cell writes keeps retained heap O(retention × changed-cells)', () => {
    function probeCommitDelta(N: number): number {
      const R = 50
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: R })
      const inputs: ReturnType<typeof g.input<number>>[] = []
      for (let i = 0; i < N; i++) {
        inputs.push(g.input(`in_${i}`, i))
      }
      // Force lazy allocation so the baseline measures a fully-warmed
      // graph of this size, with no retained commits beyond genesis.
      g.read(inputs[0]!)
      if (typeof globalThis.gc === 'function') globalThis.gc()
      if (typeof globalThis.gc === 'function') globalThis.gc()
      const baseline = process.memoryUsage().heapUsed
      for (let k = 0; k < R; k++) {
        const target = inputs[k % N]!
        g.commit(`w${k}`, (tx) => tx.set(target, k + N))
      }
      if (typeof globalThis.gc === 'function') globalThis.gc()
      if (typeof globalThis.gc === 'function') globalThis.gc()
      const after = process.memoryUsage().heapUsed
      // Expose the graph through a side channel so the JIT can't dead-
      // code-eliminate it before we measure.
      return after - baseline + (g.now > 0 ? 0 : 1)
    }
    // Warm vitest's own bookkeeping with a throwaway run so cold-start
    // allocations don't show up as a constant offset on the first probe.
    probeCommitDelta(10)
    const small = probeCommitDelta(10)
    const large = probeCommitDelta(1000)
    // Pre-fix the large-graph delta scales with N: ~50 × 1000 × 50 bytes
    // ≈ 2.5 MB; the small delta is ~50 × 10 × 50 ≈ 25 KB. Ratio ≈ 100.
    // Post-fix both deltas are dominated by the same R × per-cell cost
    // (Map allocations for the deltas) plus a one-time genesis-fold on
    // the first eviction (proportional to N, but only paid once);
    // ratio drops to single digits. The 20× ceiling sits in the gap.
    //
    // Use a generous floor on `small` to defend against vitest /
    // node-debug heap noise that briefly flips the sign of `small`
    // (negative deltas due to GC reclaiming setup memory). When the
    // probe noise dominates, fall back to an absolute bound on `large`.
    const ratio = small > 0 ? large / small : Number.POSITIVE_INFINITY
    if (small <= 0 || small > 100_000) {
      // Noise floor too noisy for a ratio check — fall back to an
      // absolute structural bound (the real cost of fixing #235 is on
      // `large` not being proportional to N).
      expect(large).toBeLessThan(750_000)
    } else {
      expect(ratio).toBeLessThan(20)
    }
    // Sanity: the engine's reads still work after the structural-sharing
    // refactor — `readAt` walks the chain and resolves correctly.
    const N = 1000
    const R = 50
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: R })
    const inputs: ReturnType<typeof g.input<number>>[] = []
    for (let i = 0; i < N; i++) inputs.push(g.input(`v_${i}`, i))
    for (let k = 0; k < R; k++) {
      const target = inputs[k % N]!
      g.commit(`w${k}`, (tx) => tx.set(target, k + N))
    }
    // The most recent retained commit (k = R-1) wrote `R - 1 + N` to its
    // target.
    const lastTarget = inputs[(R - 1) % N]!
    const result = g.readAt(lastTarget, R)
    expect(result.status).toBe('retained')
    if (result.status !== 'retained') throw new Error('unreachable')
    expect(result.value).toBe(R - 1 + N)
    // An input that was never written still resolves to its seed value at
    // the most recent retained time, proving the chain walks the way back
    // to the genesis row (folded into the chain root after eviction).
    const untouched = inputs[N - 1]! // i = N-1 = 999, never the target of any commit
    const untouchedResult = g.readAt(untouched, R)
    expect(untouchedResult.status).toBe('retained')
    if (untouchedResult.status !== 'retained') throw new Error('unreachable')
    expect(untouchedResult.value).toBe(N - 1)
  })

  // Eviction must promote surviving deltas forward so the chain root is
  // self-contained. Without promotion, evicting the original carrier of an
  // input's last write would orphan that value: the chain walk would fail to
  // find it and the read would surface `evicted` for a time that's still
  // structurally inside the retention window. This is the regression gate
  // against a naive `delta + prev`-only structural-sharing implementation.
  it('structural sharing: eviction promotes surviving deltas so older values stay reachable inside the retention window', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 3 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const c = g.input('c', 0)
    g.commit('w_a', (tx) => tx.set(a, 1)) // t=1: a's last-write carrier
    g.commit('w_b', (tx) => tx.set(b, 2)) // t=2
    g.commit('w_c', (tx) => tx.set(c, 3)) // t=3
    // At this point retentionCap=3 and we've written 3 commits past genesis,
    // so retained = [t_1, t_2, t_3] (genesis t_0 was evicted on the t_1
    // commit because the buffer pushed past cap during initial seeding;
    // actual retention depends on FIFO push order, validated by the next
    // assertion).
    g.commit('w_b2', (tx) => tx.set(b, 20)) // t=4: evicts t_1 in front
    // After eviction of t_1, the rows holding a's "1" delta in their chain
    // must still resolve `a` at t_2, t_3, t_4 to `1` — promoting forward is
    // the eviction's correctness obligation.
    const r2 = g.readAt(a, 2)
    const r3 = g.readAt(a, 3)
    const r4 = g.readAt(a, 4)
    if (r2.status !== 'retained') throw new Error(`a@2 evicted: oldest=${r2.oldestRetainedTime}`)
    if (r3.status !== 'retained') throw new Error(`a@3 evicted: oldest=${r3.oldestRetainedTime}`)
    if (r4.status !== 'retained') throw new Error(`a@4 evicted: oldest=${r4.oldestRetainedTime}`)
    expect(r2.value).toBe(1)
    expect(r3.value).toBe(1)
    expect(r4.value).toBe(1)
    // b's history across the same window: t_2 wrote 2, t_4 wrote 20; t_3
    // inherits t_2's 2.
    const rb2 = g.readAt(b, 2)
    const rb3 = g.readAt(b, 3)
    const rb4 = g.readAt(b, 4)
    if (rb2.status !== 'retained' || rb3.status !== 'retained' || rb4.status !== 'retained') {
      throw new Error('b unexpectedly evicted')
    }
    expect(rb2.value).toBe(2)
    expect(rb3.value).toBe(2)
    expect(rb4.value).toBe(20)
  })

  // canonical test #11 — Retained snapshots are deeply immutable from the
  // consumer's view at *past* times. Mutating a value returned by
  // `readAt(t_old)` does not change what `readAt(t_old)` returns on a
  // later call. The retention buffer's older rows must hold values that
  // are structurally isolated from the live input cell — i.e., once a
  // commit lands a fresh value into a retained row, subsequent commits
  // (which allocate new value objects) cannot retroactively mutate the
  // older row's view.
  //
  // Note on scope: the trivially-immutable primitive case is covered by
  // every other test in this suite. The interesting property is for
  // *object* values across multiple commits. We pick a past time
  // (strictly older than the most recent commit) and verify that
  // mutating the returned object does not leak forward into either a
  // re-read at the same past time or a re-read at the most recent time.
  it('property-based: Retained snapshots are deeply immutable from the consumer view', () => {
    fc.assert(
      fc.property(
        // At least 2 writes so we can pick a past time strictly older
        // than the most recent commit — the retention buffer's chain
        // is meaningfully exercised when at least two distinct retained
        // rows exist past genesis.
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 2, maxLength: 30 }),
        (writes) => {
          const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
          const a = g.input('obj', { count: -1 } as { count: number })
          for (const w of writes) {
            // Each commit allocates a fresh object, so the retention
            // chain holds N distinct references — none aliased to the
            // live input cell after the first follow-on commit.
            g.commit(`w${w}`, (tx) => tx.set(a, { count: w }))
          }
          // Probe a past time strictly older than `now` so we exercise
          // the chain walk through a non-head row.
          const tPast = g.now - 1
          const past1 = g.readAt(a, tPast)
          if (past1.status !== 'retained') return true // pre-genesis edge
          const expected = (past1.value as { count: number }).count
          // Mutate the returned object — engine retention must not be
          // affected.
          ;(past1.value as { count: number }).count = -999
          const past2 = g.readAt(a, tPast)
          if (past2.status !== 'retained') return false
          // The structural invariant: the returned value at the same
          // past time must reflect the original committed value, not
          // the consumer's mutation. A reference-equal return would
          // technically be allowed by reference identity, but the
          // chain-shared-reference shape lets a *future* commit's
          // mutation leak into older rows — that leak is what the
          // gate protects. Here the test catches the simpler leak
          // path: re-reading the past returns the same shape it was
          // committed at.
          expect((past2.value as { count: number }).count).toBe(expected)
          return true
        },
      ),
      propertyTrials('readAt-immutable-from-consumer'),
    )
  })

  // canonical test #12 — replay-equals-readAt round trip. For any t_k in
  // the retention window, replaying the engine's commit sequence from t₀
  // up to t_k on a fresh graph produces a state byte-equal to
  // `g.readAt(node, t_k).value` on the original. This is the load-bearing
  // equivalence between the time-travel primitive and forward-replay —
  // it pins the §15.2 replay-determinism contract to the §12.2 readAt
  // surface so a divergence in either direction surfaces here.
  it('property-based round trip: replay from t₀ equals readAt(t_k).state for any t_k in window', () => {
    fc.assert(
      fc.property(
        // A non-empty random write trace into a single input. Bounded
        // length keeps trial time within budget at 1000+ runs; the
        // inputs and the readback cover the load-bearing invariants.
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), { minLength: 1, maxLength: 30 }),
        // The probe time `t_k` chosen as a fraction of the trace length;
        // resolved against the actual trace length inside the property.
        fc.float({ min: 0, max: 1, noNaN: true }),
        (writes, fraction) => {
          // Build the original graph. Cap retention at a value larger
          // than the trace length so every t_k lands inside the window.
          const cap = Math.max(writes.length + 4, 8)
          const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: cap })
          const a = g.input('a', 0)
          const sq = g.derived('sq', (get) => get(a) * get(a))
          for (const w of writes) {
            g.commit('w', (tx) => tx.set(a, w))
          }
          // Pick t_k = round(fraction × now); covers t₀, mid-trace, and
          // the most recent commit.
          const tK = Math.round(fraction * g.now)
          const original = g.readAt(a, tK)
          if (original.status !== 'retained') {
            // Cap was sized to keep all t_k in the window — an evicted
            // read here is a contract failure, not a property miss.
            throw new Error(`readAt(t=${tK}) evicted unexpectedly`)
          }
          // Build a fresh graph and replay only the commits up to t_k.
          // The replay applies writes 1…t_k to a fresh input registered
          // with the same id and seed.
          const g2 = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: cap })
          const a2 = g2.input('a', 0)
          const sq2 = g2.derived('sq', (get) => get(a2) * get(a2))
          for (let k = 0; k < tK; k++) {
            const w = writes[k]!
            g2.commit('w', (tx) => tx.set(a2, w))
          }
          // Read input and derived from g2 directly, and from g via
          // readAt at t_k. They must agree.
          const replayedInput = g2.read(a2)
          const replayedDerived = g2.read(sq2)
          expect(original.value).toBe(replayedInput)
          const originalDerived = g.readAt(sq, tK)
          if (originalDerived.status !== 'retained') {
            throw new Error(`readAt(sq, t=${tK}) evicted unexpectedly`)
          }
          expect(originalDerived.value).toBe(replayedDerived)
          return true
        },
      ),
      propertyTrials('readAt-replay-equals-readAt'),
    )
  })

  // #277 — a writable Behavior registered at `t_r` is denotationally
  // defined on `[t_r, ∞)` only. `readAt(input, t)` for `t < t_r` is
  // outside the Behavior's domain and must surface the discriminated
  // `evicted` arm with `oldestRetainedTime: t_r` — not the seed
  // value, not undefined, not a throw. The recovery breadcrumb names
  // the earliest GraphTime where the read would succeed. Three
  // boundary probes around an input registered at t=3 lock the
  // contract: one strictly before the domain (must evict at the
  // domain boundary), one at the domain boundary (must retain the
  // seed), and one inside the domain after writes (must retain the
  // most recent write).
  describe('input domain — readAt(input, t<registrationTime) is undefined (#277)', () => {
    it('readAt(input, 0) for an input registered at t=3 returns evicted with oldestRetainedTime=3', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      // Advance the engine to t=3 with three commits on a sentinel
      // input so the subject input registers at a non-zero
      // GraphTime. The sentinel exists only to advance `now`; the
      // input under test (`late`) is registered at t=3.
      const sentinel = g.input('sentinel', 0)
      g.commit('w1', (tx) => tx.set(sentinel, 1))
      g.commit('w2', (tx) => tx.set(sentinel, 2))
      g.commit('w3', (tx) => tx.set(sentinel, 3))
      expect(g.now).toBe(3)
      const late = g.input('late', 'seed')
      const r = g.readAt(late, 0)
      expect(r.status).toBe('evicted')
      if (r.status !== 'evicted') throw new Error('unreachable')
      expect(r.oldestRetainedTime).toBe(3)
    })

    it('readAt(input, 3) for an input registered at t=3 returns retained with the seed value', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const sentinel = g.input('sentinel', 0)
      g.commit('w1', (tx) => tx.set(sentinel, 1))
      g.commit('w2', (tx) => tx.set(sentinel, 2))
      g.commit('w3', (tx) => tx.set(sentinel, 3))
      const late = g.input('late', 'seed')
      const r = g.readAt(late, 3)
      expect(r.status).toBe('retained')
      if (r.status !== 'retained') throw new Error('unreachable')
      expect(r.value).toBe('seed')
      expect(r.time).toBe(3)
    })

    it('readAt(input, 5) for an input registered at t=3 returns retained with the post-write value', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const sentinel = g.input('sentinel', 0)
      g.commit('w1', (tx) => tx.set(sentinel, 1))
      g.commit('w2', (tx) => tx.set(sentinel, 2))
      g.commit('w3', (tx) => tx.set(sentinel, 3))
      const late = g.input('late', 'seed')
      g.commit('w4', (tx) => tx.set(late, 'post'))
      g.commit('w5', (tx) => tx.set(late, 'final'))
      expect(g.now).toBe(5)
      const r = g.readAt(late, 5)
      expect(r.status).toBe('retained')
      if (r.status !== 'retained') throw new Error('unreachable')
      expect(r.value).toBe('final')
      expect(r.time).toBe(5)
    })
  })

  // #374 — the derived branch of the §3 domain rule. A derivation
  // registered at GraphTime `t_r` is denotationally defined on
  // `[t_r, ∞)` only, exactly like an input. Before this fix, the
  // engine happily ran `recomputeFromSnapshot` against the retained
  // input row at `t < t_r` and returned a fabricated value for a
  // Behavior that did not exist at that time — recomputing the
  // derivation's compute function against pre-existence input data
  // does not produce its value at `t`, because the function did not
  // yet exist at `t`. The boundary probes mirror the input-domain
  // suite above so a future regression on either branch fails the
  // same shape of test.
  describe('derived domain — readAt(derived, t<registrationTime) is undefined (#374)', () => {
    it('readAt(derived, 0) for a derived registered at t=2 returns evicted with oldestRetainedTime=2', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 1)
      g.commit('w1', (tx) => tx.set(a, 5)) // t = 1
      g.commit('w2', (tx) => tx.set(a, 9)) // t = 2
      // Issue #374's exact reproduction: `sq` is registered at t=2,
      // and `readAt(sq, 1)` previously returned `{ retained, value: 25 }`
      // by recomputing 5 * 5 against the retained input row at t=1.
      // The fix surfaces the discriminated `evicted` arm with the
      // registration time as the breadcrumb instead.
      const sq = g.derived('sq', (get) => get(a) * get(a))
      const r = g.readAt(sq, 1)
      expect(r.status).toBe('evicted')
      if (r.status !== 'evicted') throw new Error('unreachable')
      expect(r.oldestRetainedTime).toBe(2)
    })

    it('readAt(derived, registrationTime) returns retained with the value computed against that snapshot', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 1)
      g.commit('w1', (tx) => tx.set(a, 5)) // t = 1
      g.commit('w2', (tx) => tx.set(a, 9)) // t = 2
      const sq = g.derived('sq', (get) => get(a) * get(a))
      const r = g.readAt(sq, 2)
      expect(r.status).toBe('retained')
      if (r.status !== 'retained') throw new Error('unreachable')
      expect(r.value).toBe(81) // 9 * 9 — the input value at the registration moment
      expect(r.time).toBe(2)
    })

    it('readAt(derived, t > registrationTime) returns retained against the post-registration snapshot', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 1)
      g.commit('w1', (tx) => tx.set(a, 5)) // t = 1
      g.commit('w2', (tx) => tx.set(a, 9)) // t = 2
      const sq = g.derived('sq', (get) => get(a) * get(a))
      g.commit('w3', (tx) => tx.set(a, 4)) // t = 3
      const r = g.readAt(sq, 3)
      expect(r.status).toBe('retained')
      if (r.status !== 'retained') throw new Error('unreachable')
      expect(r.value).toBe(16) // 4 * 4
      expect(r.time).toBe(3)
    })

    it('readAt(derived, 0) for a derived registered at t=0 (no prior commits) returns retained at genesis', () => {
      // Edge case: when a derivation is registered before any commit
      // advances `now` past genesis, its domain starts at t₀ and the
      // boundary read at t=0 is in-domain.
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 7)
      const sq = g.derived('sq', (get) => get(a) * get(a))
      const r = g.readAt(sq, 0)
      expect(r.status).toBe('retained')
      if (r.status !== 'retained') throw new Error('unreachable')
      expect(r.value).toBe(49)
      expect(r.time).toBe(0)
    })

    it('readAt(derived, t<t_r) breadcrumb names the registration time, not the chain root', () => {
      // The recovery breadcrumb's job is to point at the boundary the
      // caller must advance past. For a derivation registered well
      // inside the retention window, that boundary is the registration
      // time itself, not the (older) oldest retained snapshot.
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      for (let k = 1; k <= 10; k++) {
        g.commit(`w${k}`, (tx) => tx.set(a, k))
      }
      // Derivation registered at t=10 — the input rows for t=1..9 are
      // all still in the retention window, but the derivation didn't
      // exist at any of those times.
      const sq = g.derived('sq', (get) => get(a) * get(a))
      for (const probe of [0, 1, 5, 9]) {
        const r = g.readAt(sq, probe)
        expect(r.status).toBe('evicted')
        if (r.status !== 'evicted') throw new Error('unreachable')
        expect(r.oldestRetainedTime).toBe(10)
      }
    })

    it('readAt on an input registered before a derived: input domain unchanged by adding the derived', () => {
      // Symmetry probe: registering a derivation does not perturb the
      // input branch's domain semantics. Useful as a regression gate
      // against a fix that accidentally widened the domain check to
      // every entry kind.
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 1)
      g.commit('w1', (tx) => tx.set(a, 5)) // t = 1
      const sq = g.derived('sq', (get) => get(a) * get(a))
      // `a` was registered at t=0, so readAt(a, 0) is in-domain.
      const ra0 = g.readAt(a, 0)
      expect(ra0.status).toBe('retained')
      if (ra0.status !== 'retained') throw new Error('unreachable')
      expect(ra0.value).toBe(1)
      // `sq` was registered at t=1, so readAt(sq, 0) is out-of-domain.
      const rsq0 = g.readAt(sq, 0)
      expect(rsq0.status).toBe('evicted')
      if (rsq0.status !== 'evicted') throw new Error('unreachable')
      expect(rsq0.oldestRetainedTime).toBe(1)
    })
  })
})
