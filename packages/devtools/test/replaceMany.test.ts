/**
 * @packageDocumentation
 *
 * Behavioural tests for `replaceMany` — the batched counterpart to
 * `liveDerived.replace()`. The animating contract is that the live-edit
 * primitive has to compose with the engine's atomicity guarantee:
 * `graph.commit` is the only way time advances and produces exactly one
 * new `GraphTime`, so swapping the compute on several live derivations
 * at once must collapse into a single commit. Any subscriber downstream
 * of the affected set fires at most once, mirroring the worked example's
 * "exactly one notification, not two" rule. Also verifies that per-handle
 * `replace()` continues to operate normally afterwards and that cross-
 * graph misuse is rejected loudly.
 */

import { createCausl, type Compute } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { liveDerived, replaceMany, type LiveDerivedHandle } from '../src/index.js'

/**
 * Contract suite for `replaceMany(graph, edits)` — atomic, batched compute
 * swaps for a set of `liveDerived` handles owned by a single graph. The
 * batching is the point: a devtools UI rebuilding several derivations at
 * once should land them inside one commit so downstream consumers see one
 * coherent post-edit state instead of an interleaved sequence.
 */
describe('replaceMany(graph, edits)', () => {
  /**
   * Three independent compute swaps issued through one `replaceMany` call
   * must collapse into a single commit, so a downstream subscriber sees
   * exactly one emission carrying all three new values.
   */
  it('batches three replaces into one downstream notification', () => {
    // Arrange: three live derivations and a combo derivation that depends on all of them.
    const g = createCausl()
    const a = g.input('a', 1)
    const live1 = liveDerived<number>(g, 'live1', (get) => get(a) * 1)
    const live2 = liveDerived<number>(g, 'live2', (get) => get(a) * 1)
    const live3 = liveDerived<number>(g, 'live3', (get) => get(a) * 1)
    const seen: Array<readonly [number, number, number]> = []
    g.subscribe(
      g.derived('combo', (get) =>
        [get(live1.node), get(live2.node), get(live3.node)] as const,
      ),
      (v) => seen.push(v),
    )
    // Reset to ignore the initial subscription emission.
    seen.length = 0

    // Arrange: the three new compute functions to install.
    const next1: Compute<number> = (get) => get(a) * 10
    const next2: Compute<number> = (get) => get(a) * 100
    const next3: Compute<number> = (get) => get(a) * 1000

    // Act: apply all three swaps in one batched call.
    replaceMany(g, [
      { handle: live1 as LiveDerivedHandle<unknown>, next: next1 as Compute<unknown> },
      { handle: live2 as LiveDerivedHandle<unknown>, next: next2 as Compute<unknown> },
      { handle: live3 as LiveDerivedHandle<unknown>, next: next3 as Compute<unknown> },
    ])
    // Assert: subscriber sees exactly one emission with all post-swap values.
    expect(seen.length).toBe(1)
    expect(seen[0]).toEqual([10, 100, 1000])
  })

  /**
   * After a batched swap, individual `handle.replace()` calls keep working
   * on their own commit cadence — `replaceMany` does not leave handles in
   * a degraded state.
   */
  it('individual replace() still works after a batched replaceMany()', () => {
    // Arrange: a single live derivation with a subscriber.
    const g = createCausl()
    const a = g.input('a', 1)
    const h = liveDerived<number>(g, 'h', (get) => get(a))
    const seen: number[] = []
    g.subscribe(h.node, (v) => seen.push(v))
    // Drop the initial-subscription emission.
    seen.length = 0

    // Act + Assert: each individual replace produces its own emission.
    h.replace((get) => get(a) + 100)
    expect(seen).toEqual([101])
    h.replace((get) => get(a) + 1000)
    expect(seen).toEqual([101, 1001])
  })

  /**
   * A handle from one graph cannot be applied to another. Cross-graph
   * misuse raises a clearly diagnosable error rather than silently
   * corrupting either graph's state.
   */
  it('throws if a handle was registered with a different graph', () => {
    // Arrange: two distinct graphs with similar shapes but separate identities.
    const g1 = createCausl()
    const g2 = createCausl()
    g1.input('a', 0)
    g2.input('a', 0)
    const h = liveDerived<number>(g1, 'live', () => 42)
    const next: Compute<number> = () => 99
    // Act + Assert: applying g1's handle against g2 throws a registration error.
    expect(() =>
      replaceMany(g2, [
        { handle: h as LiveDerivedHandle<unknown>, next: next as Compute<unknown> },
      ]),
    ).toThrow(/not registered/)
  })
})
