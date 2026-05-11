/**
 * Perf invariant: recompute count = |affected|, not graph size (#145).
 *
 * The performance commitment I'm willing to defend is short: a commit
 * producing N derived recomputations should run in O(N) time, not
 * O(graph size). Dirty marking and dependency walking are bounded by
 * the affected subgraph. This is a correctness criterion phrased as
 * performance, not a benchmark with a millisecond target — specific
 * node counts and millisecond numbers belong in the epic, not in the
 * engine's load-bearing contract. This file is the PR-blocking gate:
 * a regression that recomputes unrelated derivations fails this test
 * loudly.
 *
 * Counters are wired through the shared testing seam at
 * `@causl/core-testing-internal` (PR #205). The seam wraps user
 * `compute` closures with an instrumented Compute<T> that counts each
 * engine-driven invocation against a stable label. Counting at this
 * boundary keeps the canonical-seven public surface unchanged: no
 * `__onCompute` symbol leaks into the engine, and downstream consumers
 * (Epic A #180/#181, Epic G #201) reach the same primitive uniformly.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, type Node } from '../src/index.js'
import { dispose } from '../src/internal.js'
import { recomputeCounter } from '@causl/core-testing-internal'

describe('recompute-count invariant — O(|affected|) gate (#145)', () => {
  it('a commit that changes one input recomputes only its dependents', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const counter = recomputeCounter()
    const aDerived = g.derived('a-derived', counter.wrap((get) => get(a) + 1, 'a-derived'))
    const bDerived = g.derived('b-derived', counter.wrap((get) => get(b) + 1, 'b-derived'))
    // Force initial settle so the eager compute on registration is not
    // confused with the recompute we're measuring.
    g.subscribe(aDerived, () => {})
    g.subscribe(bDerived, () => {})
    counter.reset()
    g.commit('bump-a', (tx) => tx.set(a, 5))
    expect(counter.count('a-derived')).toBe(1)
    expect(counter.count('b-derived')).toBe(0)
  })

  it('chain recompute scales with chain length (1 per node), not graph size', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const chainLen = 50
    let prev: Node<number> = a
    const chainIds: string[] = []
    for (let i = 0; i < chainLen; i++) {
      const upstream: Node<number> = prev
      const id = `c${i}`
      chainIds.push(id)
      const node: Node<number> = g.derived<number>(
        id,
        counter.wrap((get) => get(upstream) + 1, id),
      )
      prev = node
    }
    // 100-derived noise that does not depend on `a`.
    const noise = g.input('noise', 0)
    const noiseIds: string[] = []
    for (let i = 0; i < 100; i++) {
      const id = `n${i}`
      noiseIds.push(id)
      g.derived(
        id,
        counter.wrap((get) => get(noise) + i, id),
      )
    }
    // Subscribe to the chain tail so the engine holds a settled value
    // before the measured commit. (Noise nodes are intentionally not
    // subscribed; their initial eager compute counts toward setup, not
    // the per-commit recompute we measure post-reset.)
    g.subscribe(prev, () => {})
    counter.reset()
    g.commit('bump', (tx) => tx.set(a, 1))
    // Per-node assertion: chain nodes recompute exactly once, noise
    // nodes recompute exactly zero. Per-id (not summed) so a single
    // recompute leak in one noise node fails loud rather than averaging
    // out across 100.
    for (const id of chainIds) expect(counter.count(id)).toBe(1)
    for (const id of noiseIds) expect(counter.count(id)).toBe(0)
  })

  it('a commit that changes nothing recomputes nothing', () => {
    const g = createCausl()
    const a = g.input('a', 5)
    const counter = recomputeCounter()
    const d = g.derived('d', counter.wrap((get) => get(a), 'd'))
    g.subscribe(d, () => {})
    counter.reset()
    g.commit('noop', (tx) => tx.set(a, 5)) // same value, Object.is dedup
    expect(counter.count('d')).toBe(0)
  })

  it('diamond wavefront-join: D recomputes once per commit, not twice (no double-eval)', () => {
    // A → B; A → C; B + C → D. Bumping A must recompute D exactly once,
    // not once per upstream wavefront. This is the canonical glitch
    // shape the O(|affected|) commitment is in tension with: a naive
    // dirty-mark walk that fires D on each upstream completion would
    // double-evaluate, even though the affected-subgraph cardinality
    // is still 3.
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const b = g.derived('b', counter.wrap((get) => get(a) + 1, 'b'))
    const c = g.derived('c', counter.wrap((get) => get(a) * 2, 'c'))
    const d = g.derived('d', counter.wrap((get) => get(b) + get(c), 'd'))
    g.subscribe(d, () => {})
    counter.reset()
    g.commit('bump-a', (tx) => tx.set(a, 5))
    expect(counter.count('b')).toBe(1)
    expect(counter.count('c')).toBe(1)
    expect(counter.count('d')).toBe(1)
    expect(counter.total()).toBe(3)
  })

  it('dynamic-dep flip: removed deps no longer trigger recompute on the dependent', () => {
    // Dependencies are inferred from observed `get()` calls, so a
    // derivation that switches between two upstreams must drop the
    // edge to the no-longer-read input on its next recompute. After
    // the flip, bumping the removed input must NOT recompute `c` —
    // a stale-edge engine that retains the prior dep set would fire
    // a phantom recompute and fail loud at the per-id assertion.
    const g = createCausl()
    const flag = g.input('flag', true)
    const x = g.input('x', 10)
    const y = g.input('y', 20)
    const counter = recomputeCounter()
    const c = g.derived(
      'c',
      counter.wrap((get) => (get(flag) ? get(x) : get(y)), 'c'),
    )
    g.subscribe(c, () => {})
    // Phase 1: flip the flag so `c` re-resolves against {flag, y}
    // and drops its edge to `x`. The flip itself produces one
    // recompute of `c`; we reset after.
    g.commit('flip', (tx) => tx.set(flag, false))
    counter.reset()
    // Phase 2: bump the removed dep. `c` must stay quiet.
    g.commit('bump-removed-dep', (tx) => tx.set(x, 999))
    expect(counter.count('c')).toBe(0)
    // Sanity: bumping the *current* dep still recomputes `c`.
    counter.reset()
    g.commit('bump-current-dep', (tx) => tx.set(y, 999))
    expect(counter.count('c')).toBe(1)
  })

  it('equality cutoff: Object.is-equal recompute prunes downstream walk', () => {
    // `a` is unrelated to `b`; `b` is a constant derivation; `c` reads
    // `b`. The dep-driven affected set seeded at `a` reaches no derived
    // — `b` never wired an edge from `a` — so neither `b` nor `c`
    // recompute on a `bump-a` commit. The Object.is-equal framing
    // survives because `b`'s value is, post-commit, structurally
    // identical to the prior moment: the engine never touched it.
    // (Mirrors the seam-suite test in
    // packages/core/testing/src/__tests__/recomputeCounter.test.ts:61.)
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    // b is a constant — does NOT read `a`, so `b` is not in `a`'s
    // dependents adjacency; the affected-set BFS seeded at `a` skips
    // `b` and `c` entirely.
    const b = g.derived('b', counter.wrap(() => 42, 'b'))
    const c = g.derived('c', counter.wrap((get) => get(b) + 1, 'c'))
    g.subscribe(c, () => {})
    counter.reset()
    g.commit('bump-a', (tx) => tx.set(a, 5))
    // `b` is not reachable from `a` through the reverse-dep graph,
    // so the recompute count stays at zero. `c`, downstream of `b`,
    // also stays at zero.
    expect(counter.count('b')).toBe(0)
    expect(counter.count('c')).toBe(0)
  })

  it('range subscription: only nodes in the subscribed window recompute', () => {
    // Virtualized-list shape: register N rows over a shared input,
    // keep a windowed subset live, dispose the rest. Bumping the
    // shared input must recompute only the survivors. A walker that
    // ignores tombstones and re-fires on dead lineage fails the per-id
    // zero on every disposed row.
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const total = 30
    const windowStart = 10
    const windowEnd = 20 // half-open [10, 20)
    const rows: Array<Node<number>> = []
    for (let i = 0; i < total; i++) {
      const id = `row${i}`
      rows.push(
        g.derived(
          id,
          counter.wrap((get) => get(a) + i, id),
        ),
      )
    }
    // Drop rows outside the window. Disposal flows through the
    // adapter-internal hook (§12.3) — the canonical seven-method
    // surface deliberately does not expose it.
    const liveIds: string[] = []
    const deadIds: string[] = []
    for (let i = 0; i < total; i++) {
      const row = rows[i]!
      if (i >= windowStart && i < windowEnd) {
        liveIds.push(row.id)
        // Subscribe survivors so the engine holds settled values.
        g.subscribe(row, () => {})
      } else {
        deadIds.push(row.id)
        dispose(g, row)
      }
    }
    counter.reset()
    g.commit('bump-shared', (tx) => tx.set(a, 1))
    for (const id of liveIds) expect(counter.count(id)).toBe(1)
    for (const id of deadIds) expect(counter.count(id)).toBe(0)
  })

  it('coalesced multi-write: N writes in one tx fire each dependent at most once', () => {
    // A commit that writes the same input three times converges on
    // one staged value (Map.set is idempotent on key) and Phase B
    // publishes exactly one new value, so a dependent recomputes
    // once — not once per `tx.set`. A naive engine that fires on
    // every `tx.set` would recompute three times and fail at the
    // per-id `toBe(1)` assertion.
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const d = g.derived('d', counter.wrap((get) => get(a) + 1, 'd'))
    g.subscribe(d, () => {})
    counter.reset()
    g.commit('multi-write', (tx) => {
      tx.set(a, 1)
      tx.set(a, 5)
      tx.set(a, 5)
    })
    expect(counter.count('d')).toBe(1)
  })

  it('explain-laziness: explain() does not force recompute of unrelated derivations', () => {
    // `explain(left)` registers a derived whose lineage covers
    // `left`'s subgraph only. Bumping a node in an unrelated branch
    // must NOT recompute either `right` or the explain handle — the
    // affected-set seeded at the bumped input never reaches into
    // `left`'s lineage. A walker that re-fires every derived on
    // every commit would recompute `right` and fail the zero.
    const g = createCausl()
    const leftIn = g.input('left-in', 0)
    const rightIn = g.input('right-in', 0)
    const counter = recomputeCounter()
    const left = g.derived('left', counter.wrap((get) => get(leftIn) + 1, 'left'))
    const right = g.derived('right', counter.wrap((get) => get(rightIn) + 1, 'right'))
    g.subscribe(left, () => {})
    g.subscribe(right, () => {})
    // Register the explain handle *after* the initial settle so its
    // creation is part of setup, not the measured commit.
    g.explain(left)
    counter.reset()
    g.commit('bump-right', (tx) => tx.set(rightIn, 5))
    expect(counter.count('right')).toBe(1)
    expect(counter.count('left')).toBe(0)
  })

  it('disposed branch: recompute skips disposed lineage entirely', () => {
    // `a → b → c`. After disposing `c` then `b` (downstream-first per
    // the dependents-still-live guard), bumping `a` must walk into an
    // empty downstream set: `b` and `c` record zero recomputes. A
    // walker that ignores `entries.has(id)` on the affected frontier
    // would invoke a stale closure and the count would be non-zero.
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const b = g.derived('b', counter.wrap((get) => get(a) + 1, 'b'))
    const c = g.derived('c', counter.wrap((get) => get(b) + 1, 'c'))
    g.subscribe(c, () => {})
    // Release downstream first (NodeHasDependentsError otherwise).
    dispose(g, c)
    dispose(g, b)
    counter.reset()
    g.commit('bump-a', (tx) => tx.set(a, 5))
    expect(counter.count('b')).toBe(0)
    expect(counter.count('c')).toBe(0)
    expect(counter.total()).toBe(0)
  })

  it('stale derived read after dep flip: re-resolves via current dep set, not prior', () => {
    // After `c` flips its dep set from {flag, x} to {flag, y},
    // bumping `y` recomputes `c` to a fresh value (re-resolved via
    // the current dep set). A stale-deps engine that reuses the
    // prior dep edge would either skip the recompute (per-id zero)
    // or return a value computed off `x`'s pre-flip read — both
    // failures show up: the count assertion fails OR the value
    // assertion fails. Pinning both makes the regression mode
    // unambiguous on review.
    const g = createCausl()
    const flag = g.input('flag', true)
    const x = g.input('x', 100)
    const y = g.input('y', 200)
    const counter = recomputeCounter()
    const c = g.derived(
      'c',
      counter.wrap((get) => (get(flag) ? get(x) : get(y)), 'c'),
    )
    g.subscribe(c, () => {})
    // Settle: flip the flag so `c` re-resolves against {flag, y}.
    g.commit('flip', (tx) => tx.set(flag, false))
    counter.reset()
    // Bump `y`, the *current* dep. `c` recomputes exactly once and
    // reads through `y`, returning 999 — not the stale 100 from `x`.
    g.commit('bump-y', (tx) => tx.set(y, 999))
    expect(counter.count('c')).toBe(1)
    expect(g.read(c)).toBe(999)
  })

  it('subscribe-only: subscribe() alone (no commit) does not recompute settled derivations', () => {
    // `subscribe` reads the cached value and dispatches the initial
    // notification synchronously without forcing a recompute. A
    // settled derivation that gains a second observer must record
    // zero new recomputes — a bug that re-evaluates on each
    // subscribe would fail the per-id zero.
    const g = createCausl()
    const a = g.input('a', 0)
    const counter = recomputeCounter()
    const d = g.derived('d', counter.wrap((get) => get(a) + 1, 'd'))
    // Settle with a first subscriber so the engine holds the value.
    g.subscribe(d, () => {})
    counter.reset()
    // Second subscribe: no commit fires, no recompute should occur.
    const unsub = g.subscribe(d, () => {})
    expect(counter.count('d')).toBe(0)
    unsub()
    // A third subscribe — same expectation.
    g.subscribe(d, () => {})
    expect(counter.count('d')).toBe(0)
  })
})
