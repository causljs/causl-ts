/**
 * @packageDocumentation
 *
 * Behavioural pinning for `graph.explain(node)`, the introspection primitive
 * that exposes a target node's lineage as an `Explanation`-valued derived
 * node.
 *
 * `explain` earns its slot in the canonical seven-method public surface for a
 * specific reason: I refused to bolt a "devtools panel" onto the side of the
 * engine. Instead the engine has to be inspectable through its own
 * primitives. `graph.explain(node)` returns *another node* — a derived view
 * of the dependency lineage that can itself be subscribed to, displayed,
 * drilled into. Not a one-shot JSON dump. If I can't demo "edit a derivation
 * while it's running, watch the change propagate," I haven't earned the
 * comparison to spreadsheets that I keep wanting to make.
 *
 * The Explanation shape is a discriminated union by `via` (#298) — each
 * frame carries `value`, `computedAt`, and a recursive `deps[]` of
 * `{ node, contributedAt, explanation }` triples. The leaf is the
 * `via: 'input'` frame.
 */

import { describe, expect, it } from 'vitest'
import {
  createCausl,
  NodeDisposedError,
  UnknownNodeError,
  type Explanation,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

describe('graph.explain(node)', () => {
  /**
   * The handle returned by `explain` is a derived node valued as an
   * `Explanation` describing the target. The recursive shape lists each
   * direct dep with its own (leaf) input frame.
   */
  it('returns a derived node carrying the lineage of the target', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const exp = g.explain(sum)
    const e: Explanation = g.read(exp)
    if (e.via === 'cycle') throw new Error('unexpected cycle')
    expect(e.via).toBe('derived')
    expect(e.node).toBe('sum')
    expect(e.value).toBe(3)
    expect(e.deps.map((d) => d.node).sort()).toEqual(['a', 'b'])
    expect(e.computedAt).toBe(0)
  })

  /**
   * After a commit the explanation reflects the new value and the new
   * `computedAt` GraphTime.
   */
  it('updates as the underlying node updates', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const exp = g.explain(sum)
    g.commit('a→10', (tx) => tx.set(a, 10))
    const e = g.read(exp)
    if (e.via === 'cycle') throw new Error('unexpected cycle')
    expect(e.value).toBe(12)
    expect(e.computedAt).toBe(1)
  })

  /**
   * The liveness commitment requires that explain is itself a graph
   * value — not a snapshot. An explain handle behaves like any other
   * derived node and may be subscribed to directly; each commit that
   * affects the target produces a fresh notification, the same way any
   * other downstream observer would see it.
   */
  it('is itself subscribable (the live-system property)', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const exp = g.explain(a)
    const seen: number[] = []
    g.subscribe(exp, (e) => {
      if (e.via !== 'cycle') seen.push(e.value as number)
    })
    g.commit('a→7', (tx) => tx.set(a, 7))
    expect(seen).toEqual([1, 7])
  })

  /**
   * Repeated `explain` calls on the same node return the same handle —
   * memoised by target node id (#298 T6).
   */
  it('returns the same explain handle for repeated calls on the same node', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const e1 = g.explain(a)
    const e2 = g.explain(a)
    expect(e1).toBe(e2)
    expect(e1.id).toBe(e2.id)
  })

  /**
   * `explain` on a fabricated handle whose id was never registered
   * faults with `UnknownNodeError`. `explain` is one of the read-side
   * primitives in SPEC §12.1's canonical seven and shares the same
   * up-front entry-validation gate as `read` and `subscribe`; the
   * error surface is uniform across all three so a fabricated id is
   * caught no matter which read-side primitive a caller reaches for.
   */
  it('throws UnknownNodeError on an unregistered node', () => {
    // Arrange: a graph and a fabricated handle whose id was never registered.
    const g = createCausl()
    const ghost = { id: 'never-registered' }

    // Act + assert: explain rejects the unknown id at the entry-validation gate.
    expect(() => g.explain(ghost)).toThrow(UnknownNodeError)
  })

  /**
   * After an input is released through the adapter-layer `dispose`
   * hook, `explain` must surface `NodeDisposedError` — the typed
   * disposal error distinct from `UnknownNodeError` — so adapter
   * code reading lineage can branch on "released" vs. "never
   * registered" the same way `read` and `subscribe` do.
   */
  it('throws NodeDisposedError after disposal', () => {
    // Arrange: register an input, then dispose it through the internal hook.
    const g = createCausl()
    const a = g.input('a', 1)
    dispose(g, a)

    // Act + assert: explain surfaces the typed disposal error,
    // not the generic UnknownNodeError used for never-registered ids.
    expect(() => g.explain(a)).toThrow(NodeDisposedError)
    expect(() => g.explain(a)).not.toThrow(UnknownNodeError)
  })
})
