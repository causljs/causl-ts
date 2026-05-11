/**
 * @packageDocumentation
 *
 * Behavioural pinning for `graph.dependencies(node)` and
 * `graph.dependents(node)` — the §11 third-bullet inspection
 * primitives that publish the engine's forward and reverse dep
 * adjacency as one-shot snapshots.
 *
 * SPEC §11's third liveness bullet: *"a node's current dependents and
 * current dependency are themselves derived nodes."* The shipped shape
 * here is a one-shot `readonly NodeId[]` rather than a
 * `DerivedNode<readonly NodeId[]>` — the §383 finding is that the
 * commit pipeline cannot host derived nodes whose value is metadata
 * about the commit pipeline itself without a recursive-fire path the
 * §5 single-tick invariant cannot absorb. The snapshot shape preserves
 * the §11 semantics — the engine is its own observer, no side-channel
 * devtools API — without re-entering the pipeline. A future PR may
 * layer a derived handle on top once the recursive-fire question is
 * settled.
 *
 * The suite below pins three rows of that contract:
 *
 * 1. **`dependencies` correctness** — returns the right set after
 *    registration, after a dynamic-dep branch swap, and stays empty
 *    after the upstream consumer is disposed.
 * 2. **`dependents` correctness** — returns every direct consumer of
 *    a target node, including multiple consumers, and shrinks when a
 *    consumer rewires onto a different conditional branch.
 * 3. **Error surface** — both throw `UnknownNodeError` for fabricated
 *    ids and `NodeDisposedError` for ids that have been released
 *    through the adapter-layer `dispose` hook, mirroring `read` /
 *    `subscribe` / `explain`.
 */

import { describe, expect, it } from 'vitest'
import {
  NodeDisposedError,
  UnknownNodeError,
  createCausl,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

describe('graph.dependencies(node) — §11 forward-edge snapshot', () => {
  /**
   * The most basic guarantee: a freshly-registered derivation reports
   * the input ids it captured on first compute, lex-sorted for stable
   * iteration. An input reports `[]` because inputs have no upstream
   * by construction.
   */
  it('returns the dep set captured by the most recent compute', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))

    // Force first evaluation so deps are populated. `read` is the
    // engine's first-evaluation entry point for derivations.
    g.read(sum)

    expect(g.dependencies(sum)).toEqual(['a', 'b'])
    expect(g.dependencies(a)).toEqual([])
    expect(g.dependencies(b)).toEqual([])
  })

  /**
   * A derivation that has never been evaluated reports `[]` — its
   * dep-set is rebuilt only by `computeDerived`, and the engine has
   * no honest answer until then. Pinning this row prevents a future
   * change from silently fabricating an empty array as a "looks fine"
   * default once compute has run.
   */
  it('returns [] for a derivation that has never been evaluated', () => {
    const g = createCausl()
    g.input('a', 1)
    const noop = g.derived('noop', () => 42)
    expect(g.dependencies(noop)).toEqual([])
  })

  /**
   * Dynamic-dependency cleanup row: a derivation taking a different
   * conditional branch must report the *new* dep set after the swap,
   * not the union of "ever read." This is the same property the
   * dynamic-dep fuzz suite (`derived.test.ts`) gates against orphan
   * upstream subscriptions; here we pin its read-side projection.
   */
  it('reflects dynamic-dep branch swaps after a commit', () => {
    const g = createCausl()
    const cond = g.input('cond', true)
    const left = g.input('left', 10)
    const right = g.input('right', 20)
    const branch = g.derived('branch', (get) =>
      get(cond) ? get(left) : get(right),
    )

    // Initial branch: depends on cond + left
    g.read(branch)
    expect(g.dependencies(branch)).toEqual(['cond', 'left'])

    // Swap branch: now depends on cond + right (left dropped)
    g.commit('flip', (tx) => tx.set(cond, false))
    g.read(branch)
    expect(g.dependencies(branch)).toEqual(['cond', 'right'])
  })

  /**
   * After `dispose` releases a derivation, calling `dependencies` on
   * the released handle must surface `NodeDisposedError` — the same
   * read-side error contract `read`/`subscribe`/`explain` offer.
   * Adapter code branches on this typed error to distinguish
   * "released" from "never registered."
   */
  it('throws NodeDisposedError after the node is disposed', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sum = g.derived('sum', (get) => get(a) + 1)
    g.read(sum)

    dispose(g, sum)
    expect(() => g.dependencies(sum)).toThrow(NodeDisposedError)
    expect(() => g.dependencies(sum)).not.toThrow(UnknownNodeError)
  })

  /**
   * The returned array is frozen — the engine's read-side projections
   * cannot be mutated by a consumer to corrupt the next call. Same
   * deep-immutability invariant `readAt` upholds via `cloneForRetention`.
   */
  it('returns a frozen array', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sum = g.derived('sum', (get) => get(a) + 1)
    g.read(sum)

    const deps = g.dependencies(sum)
    expect(Object.isFrozen(deps)).toBe(true)
  })
})

describe('graph.dependents(node) — §11 reverse-edge snapshot', () => {
  /**
   * Every direct consumer of a target node is reported, including
   * multiple consumers. The snapshot is lex-sorted so callers can
   * diff successive invocations without leaking compute order.
   */
  it('returns every direct consumer of an input', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const plus1 = g.derived('plus1', (get) => get(a) + 1)
    const plus2 = g.derived('plus2', (get) => get(a) + 2)
    const plus3 = g.derived('plus3', (get) => get(a) + 3)

    // Force evaluation so the reverse-dep map is populated.
    g.read(plus1)
    g.read(plus2)
    g.read(plus3)

    expect(g.dependents(a)).toEqual(['plus1', 'plus2', 'plus3'])
  })

  /**
   * A node with no live derivations consuming it reports `[]` — both
   * inputs and derivations satisfy this on first registration before
   * any downstream compute touches them.
   */
  it('returns [] for nodes with no live consumers', () => {
    const g = createCausl()
    const lonely = g.input('lonely', 0)
    expect(g.dependents(lonely)).toEqual([])

    const sum = g.derived('sum', (get) => get(lonely) + 1)
    g.read(sum)
    // sum has no consumers
    expect(g.dependents(sum)).toEqual([])
  })

  /**
   * Reverse-dep symmetry with the dynamic-dep cleanup row: when a
   * consumer rewires onto a different conditional branch, the dropped
   * upstream node's `dependents` set must shrink correspondingly. The
   * commit pipeline already maintains the reverse-dep map for
   * invalidation — this method publishes the same view.
   */
  it('shrinks when a consumer rewires off the upstream branch', () => {
    const g = createCausl()
    const cond = g.input('cond', true)
    const left = g.input('left', 10)
    const right = g.input('right', 20)
    const branch = g.derived('branch', (get) =>
      get(cond) ? get(left) : get(right),
    )

    g.read(branch)
    expect(g.dependents(left)).toEqual(['branch'])
    expect(g.dependents(right)).toEqual([])

    g.commit('flip', (tx) => tx.set(cond, false))
    g.read(branch)
    expect(g.dependents(left)).toEqual([])
    expect(g.dependents(right)).toEqual(['branch'])
  })

  /**
   * After `dispose` releases a derivation, the upstream's reverse-dep
   * set must drop the released id — `_dispose` already drops forward
   * edges, so `dependents` reading the live map sees the shrunken set
   * the moment disposal completes.
   */
  it('drops released consumers from the upstream reverse-dep set', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const dead = g.derived('dead', (get) => get(a) + 1)
    const live = g.derived('live', (get) => get(a) + 2)

    g.read(dead)
    g.read(live)
    expect(g.dependents(a)).toEqual(['dead', 'live'])

    dispose(g, dead)
    expect(g.dependents(a)).toEqual(['live'])
  })

  /**
   * The error surface mirrors `read`/`subscribe`/`explain`:
   * `UnknownNodeError` for fabricated ids and `NodeDisposedError` for
   * released ids. The §11 inspection primitives must not invent a
   * separate error catalogue for the same read-side miss conditions.
   */
  it('throws UnknownNodeError on a fabricated handle', () => {
    const g = createCausl()
    expect(() => g.dependents({ id: 'never-registered' })).toThrow(
      UnknownNodeError,
    )
    expect(() => g.dependencies({ id: 'never-registered' })).toThrow(
      UnknownNodeError,
    )
  })

  /**
   * Disposing a target node, then calling `dependents` on its handle,
   * surfaces `NodeDisposedError` — adapters branch on this typed
   * error rather than the generic `UnknownNodeError`.
   */
  it('throws NodeDisposedError after the target is disposed', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    dispose(g, a)
    expect(() => g.dependents(a)).toThrow(NodeDisposedError)
    expect(() => g.dependents(a)).not.toThrow(UnknownNodeError)
  })

  /**
   * The returned array is frozen — same deep-immutability discipline
   * as `dependencies`.
   */
  it('returns a frozen array', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sum = g.derived('sum', (get) => get(a) + 1)
    g.read(sum)

    const dep = g.dependents(a)
    expect(Object.isFrozen(dep)).toBe(true)
  })
})
