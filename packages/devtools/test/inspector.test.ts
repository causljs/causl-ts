/**
 * @packageDocumentation
 *
 * Behavioural tests for the node-inspector devtools surface (`inspect`
 * and `watchInspect`). The animating contract is that the engine is
 * inspectable through its own primitives — a node's current value,
 * dependencies, and dependents are themselves derived values, so a
 * snapshot view is just a bundle of those. Verified here: a snapshot
 * view bundles the recursive `Explanation` (#298) and the GraphTime
 * at which the read occurred, while the streaming variant fires once
 * on subscribe and again on each relevant commit until unsubscribed —
 * the same `subscribe(node, observer)` cadence every consumer already
 * uses.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { inspect, watchInspect, type NodeInspectorView } from '../src/index.js'

describe('inspect(graph, node)', () => {
  /**
   * The snapshot of a derived node carries its full lineage tree and a
   * `inspectedAt` clock anchored to the graph's current GraphTime
   * (zero before any commit has landed).
   */
  it('returns the current Explanation plus inspectedAt', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const view = inspect(g, sum)
    expect(view.inspectedAt).toBe(0)
    if (view.explanation.via === 'cycle') throw new Error('unexpected')
    expect(view.explanation.via).toBe('derived')
    expect(view.explanation.node).toBe('sum')
    expect(view.explanation.value).toBe(3)
    expect(view.explanation.deps.map((d) => d.node).sort()).toEqual(['a', 'b'])
  })

  /**
   * Subsequent inspections see the post-commit world: value updates,
   * `inspectedAt` advances to the new commit count.
   */
  it('reflects updates after a commit', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sum = g.derived('sum', (get) => get(a) * 5)
    const initial = inspect(g, sum)
    if (initial.explanation.via === 'cycle') throw new Error('unexpected')
    expect(initial.explanation.value).toBe(5)
    g.commit('a→4', (tx) => tx.set(a, 4))
    const view = inspect(g, sum)
    if (view.explanation.via === 'cycle') throw new Error('unexpected')
    expect(view.explanation.value).toBe(20)
    expect(view.inspectedAt).toBe(1)
  })
})

/**
 * Streaming inspection: an observer receives snapshots on subscribe and
 * after every commit that touches the node, until the returned unsubscribe
 * function is invoked. This piggybacks on the same fire-on-commit cadence
 * any other subscriber uses — devtools panels become regular consumers of
 * the engine's primitives rather than a parallel inspection channel.
 */
describe('watchInspect(graph, node, observer)', () => {
  /**
   * Subscription fires immediately with the current view, then again on
   * each relevant commit. After unsubscribing, further commits are ignored
   * even when they would have changed the value.
   */
  it('fires on subscription and on every relevant commit', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sum = g.derived('sum', (get) => get(a) * 2)
    const fires: NodeInspectorView[] = []
    const valueOf = (v: NodeInspectorView | undefined): unknown =>
      v && v.explanation.via !== 'cycle' ? v.explanation.value : undefined
    const unsub = watchInspect(g, sum, (v) => fires.push(v))
    expect(fires.length).toBe(1)
    expect(valueOf(fires[0])).toBe(2)
    g.commit('a→10', (tx) => tx.set(a, 10))
    expect(valueOf(fires.at(-1))).toBe(20)
    unsub()
    g.commit('a→100', (tx) => tx.set(a, 100))
    expect(valueOf(fires.at(-1))).toBe(20)
  })
})
