/**
 * @packageDocumentation
 *
 * Behavioural tests for `liveDerived` — the editable derivation primitive
 * that powers the "edit a derivation while it's running, watch the change
 * propagate" promise. That demo is the gate for earning the comparison to
 * spreadsheets: the thing that made spreadsheets matter is that a
 * non-programmer can change a formula in a cell and see the world
 * recompute *now*, and a REPL connected to a running graph must be able
 * to mutate, replace, and replay derivations without restarting the host
 * process. These tests confirm initial compute correctness, that
 * `replace()` hot-swaps the function and recomputes downstream, that
 * input mutations continue to drive the latest compute, and that
 * subscribers observe each swap as a regular value emission.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { liveDerived } from '../src/index.js'

/**
 * Contract suite for `liveDerived(graph, id, initial)` — a derivation handle
 * whose compute function can be replaced at runtime without tearing down
 * the node or its subscribers. The hot-swap requirement is what makes the
 * "watch the change propagate" demo possible: the node identity stays
 * stable so dependents stay wired, while the compute behind it is allowed
 * to change.
 */
describe('liveDerived(graph, id, initial)', () => {
  /**
   * On creation the handle's node reads the value produced by the initial
   * compute, exactly as a vanilla `graph.derived` would.
   */
  it('starts with the initial compute', () => {
    // Arrange: input feeding a doubling live derivation.
    const g = createCausl()
    const a = g.input('a', 5)
    const live = liveDerived<number>(g, 'live', (get) => get(a) * 2)
    // Assert: initial read reflects the starting compute.
    expect(g.read(live.node)).toBe(10)
  })

  /**
   * `replace()` installs a new compute function and immediately propagates
   * a fresh value through the same node identity, so dependents stay wired.
   */
  it('replace() swaps in a new compute and recomputes downstream', () => {
    // Arrange: input feeding a doubling live derivation.
    const g = createCausl()
    const a = g.input('a', 5)
    const live = liveDerived<number>(g, 'live', (get) => get(a) * 2)
    expect(g.read(live.node)).toBe(10)
    // Act + Assert: each replace produces the value the new compute prescribes.
    live.replace((get) => get(a) + 100)
    expect(g.read(live.node)).toBe(105)
    live.replace((get) => get(a) - 1)
    expect(g.read(live.node)).toBe(4)
  })

  /**
   * After a swap the live node continues to depend on the inputs read by
   * the *current* compute — input commits drive recomputation under the
   * latest function, not stale lineage.
   */
  it('input changes still trigger recompute under the current compute', () => {
    // Arrange: live derivation reading input `a`.
    const g = createCausl()
    const a = g.input('a', 5)
    const live = liveDerived<number>(g, 'live', (get) => get(a) * 2)
    // Act: commit advances input under original compute.
    g.commit('a→7', (tx) => tx.set(a, 7))
    expect(g.read(live.node)).toBe(14)
    // Act: swap compute, then commit again.
    live.replace((get) => get(a) + 1)
    g.commit('a→100', (tx) => tx.set(a, 100))
    // Assert: latest commit applies the post-replace compute.
    expect(g.read(live.node)).toBe(101)
  })

  /**
   * Subscribers observe both the initial value and every replace() as a
   * regular value emission, so a UI does not need a separate channel to
   * react to compute swaps.
   */
  it('subscribers see live updates after replace()', () => {
    // Arrange: input feeding a doubling live derivation, with a subscriber.
    const g = createCausl()
    const a = g.input('a', 5)
    const live = liveDerived<number>(g, 'live', (get) => get(a) * 2)
    const seen: number[] = []
    g.subscribe(live.node, (v) => seen.push(v))
    // Act: two replaces in sequence.
    live.replace((get) => get(a) + 1)
    live.replace((get) => -get(a))
    // Assert: subscriber receives initial value plus one emission per swap.
    expect(seen).toEqual([10, 6, -5])
  })
})
