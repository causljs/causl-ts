/**
 * @packageDocumentation
 *
 * EPIC #290 sub-issue #294 — `liveDerived(...).replace(next)` must
 * preserve node identity, suppress no-op notifications via the
 * engine's `Object.is` rule, retrack dependencies on the new compute,
 * and remain coherent with `graph.explain(node)`.
 *
 * The contract is the "edit a derivation while it's running" promise
 * that earns the comparison to spreadsheets: a REPL or devtools panel
 * connected to a running graph must be able to mutate, replace, and
 * replay derivations without restarting the host process. External
 * references (devtools selectors, explain panels, snapshot diffs)
 * therefore must not break across an edit — the node is still the
 * same node; only the compute behind it changed.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { liveDerived } from '../src/index.js'

describe('liveDerived().replace — identity & coherence (#294)', () => {
  /**
   * T1 — node id stability across `replace`. A UI selector that holds
   * the live node by reference must continue to point at the same
   * object after the compute is swapped.
   */
  it('T1: replace preserves node identity', () => {
    const g = createCausl()
    const a = g.input('a', 2)
    const b = g.input('b', 3)
    const live = liveDerived<number>(g, 'sum', (get) => get(a) + get(b))
    const idBefore = live.node.id
    const refBefore = live.node
    live.replace((get) => get(a) * get(b))
    expect(live.node.id).toBe(idBefore)
    expect(live.node).toBe(refBefore)
    expect(g.read(live.node)).toBe(6)
  })

  /**
   * T2 — `Object.is` suppression. Replacing with a closure that
   * computes the same value as the prior frame must not fire
   * subscribers; the engine already suppresses Object.is-equal value
   * notifications, and `replace` must not cheat that.
   */
  it('T2: replace with Object.is-equal value does not notify subscribers', () => {
    const g = createCausl()
    const a = g.input('a', 2)
    const b = g.input('b', 3)
    const live = liveDerived<number>(g, 'sum', (get) => get(a) + get(b))
    expect(g.read(live.node)).toBe(5)
    const seen: number[] = []
    g.subscribe(live.node, (v) => seen.push(v))
    // Initial subscribe-time emit is the seam helper's "current value"
    // bridge; we measure post-replace fires.
    const baselineFires = seen.length
    // Replace with a different closure that yields the same numeric value.
    live.replace((get) => get(b) + get(a))
    expect(g.read(live.node)).toBe(5)
    expect(seen.length - baselineFires).toBe(0)
    // A genuine value change still fires.
    live.replace((get) => get(a) * get(b))
    expect(g.read(live.node)).toBe(6)
    expect(seen.length - baselineFires).toBe(1)
    expect(seen[seen.length - 1]).toBe(6)
  })

  /**
   * T3 — dependency retracking. After a swap the live node must drop
   * deps the old compute used and pick up deps the new compute reads.
   */
  it('T3: replace retracks dependencies', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const c = g.input('c', 3)
    const live = liveDerived<number>(g, 'x', (get) => get(a) + get(b))
    expect(g.read(live.node)).toBe(3)
    const fires: number[] = []
    g.subscribe(live.node, (v) => fires.push(v))
    const baseline = fires.length
    // Swap to depend on `a` and `c`, dropping `b`.
    live.replace((get) => get(a) + get(c))
    expect(g.read(live.node)).toBe(4)
    const afterSwap = fires.length
    // Mutate `b` (the abandoned dep) — must NOT recompute the live node.
    g.commit('bump-b', (tx) => tx.set(b, 99))
    expect(fires.length).toBe(afterSwap)
    expect(g.read(live.node)).toBe(4)
    // Mutate `c` (the new active dep) — must recompute and fire.
    g.commit('bump-c', (tx) => tx.set(c, 10))
    expect(g.read(live.node)).toBe(11)
    expect(fires.length).toBe(afterSwap + 1)
    void baseline
  })

  /**
   * T4 — explain coherence. The lineage view must reflect the new
   * deps after a replace and emit at most one update for the swap.
   */
  it('T4: graph.explain reflects the new lineage after replace', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const c = g.input('c', 3)
    const live = liveDerived<number>(g, 'x', (get) => get(a) + get(b))
    // Force the explain node to compute against the original deps.
    const before = g.read(g.explain(live.node))
    if (before.via === 'cycle') throw new Error('unexpected cycle')
    const beforeDeps = before.deps.map((d) => d.node)
    expect(beforeDeps).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(beforeDeps).not.toContain(c.id)
    // Swap to depend on `a` and `c`. Read live.node so the engine
    // observes the new deps before we re-read explain.
    live.replace((get) => get(a) + get(c))
    void g.read(live.node)
    const after = g.read(g.explain(live.node))
    if (after.via === 'cycle') throw new Error('unexpected cycle')
    const afterDeps = after.deps.map((d) => d.node)
    expect(afterDeps).toEqual(expect.arrayContaining([a.id, c.id]))
    expect(afterDeps).not.toContain(b.id)
  })

  /**
   * T5 — replace inside an open commit. The "concurrent replace"
   * pattern is `g.commit('swap', tx => { live.replace(fn2); tx.set(a, 10) })`,
   * because the live-edit promise has to compose with the only
   * mutation entry point (`graph.commit`). It must not throw
   * `CommitInProgressError`, the live node must recompute under the
   * new closure, and subscribers see exactly one notification for the
   * whole commit. That single-fire is the atomicity guarantee falling
   * out of the semantic foundation: a transaction creates exactly one
   * new `GraphTime`, there is no fractional time, and the worked
   * example demands "exactly one notification, not two" even when
   * multiple writes land in one commit.
   */
  it('T5: replace inside an open commit yields one notification', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const live = liveDerived<number>(g, 'y', (get) => get(a) + 1)
    expect(g.read(live.node)).toBe(2)
    const fires: number[] = []
    g.subscribe(live.node, (v) => fires.push(v))
    const baseline = fires.length
    g.commit('swap', (tx) => {
      live.replace((get) => get(a) * 100)
      tx.set(a, 7)
    })
    // After the commit, the new compute is applied against the new input.
    expect(g.read(live.node)).toBe(700)
    // Atomicity: subscribers see one fire across the whole commit.
    expect(fires.length - baseline).toBe(1)
    expect(fires[fires.length - 1]).toBe(700)
  })

  /**
   * T6 — StrictMode-style double-replace with the same closure ref.
   * Must be a no-op on the second call: no extra version bump, no
   * subscriber fire if value unchanged.
   */
  it('T6: same closure replace twice fires at most once', () => {
    const g = createCausl()
    const a = g.input('a', 5)
    const live = liveDerived<number>(g, 'z', (get) => get(a))
    expect(g.read(live.node)).toBe(5)
    const fires: number[] = []
    g.subscribe(live.node, (v) => fires.push(v))
    const baseline = fires.length
    const fn2 = (get: <U>(n: { id: string }) => U) =>
      (get(a) as number) * 2
    live.replace(fn2 as never)
    expect(g.read(live.node)).toBe(10)
    const after1 = fires.length
    live.replace(fn2 as never) // identical reference — must be a no-op
    expect(g.read(live.node)).toBe(10)
    expect(fires.length).toBe(after1)
    void baseline
  })
})
