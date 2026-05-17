/**
 * @packageDocumentation
 *
 * Unit tests for the `resource(graph, key, options)` factory and its
 * lifecycle state machine. Covers the initial `idle` state, the
 * idle → loading → loaded happy path, transitions into `errored` on
 * loader rejection, the loaded → stale flip driven by `invalidate()`,
 * and the chart-conformant `fail()` mutator (the host-driven trigger
 * for the chart-named `Loading | Loaded → Errored` edges; refuses
 * every other source state with a typed error per `SPEC.md` §17
 * commitment 7).
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { ForbiddenResourceTransitionError, resource } from '../src/index.js'

/**
 * Suite exercising the resource lifecycle state machine and the
 * imperative controls (`fetch`, `invalidate`, `fail`) exposed on the
 * resource handle.
 */
describe('resource(graph, key, options)', () => {
  /**
   * Confirms a freshly-created resource sits in `idle` before any
   * fetch is initiated.
   */
  it('starts in `idle`', () => {
    // From-state: (none). Event: construction. To-state: idle.
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 42 })
    const v = g.read(r.node)
    expect(v.state).toBe('idle')
  })

  /**
   * Pins the happy-path transition sequence: idle → loading → loaded,
   * with the loader's resolved value reflected on the node.
   */
  it('transitions idle → loading → loaded on a successful fetch', async () => {
    // From-state: idle. Event: fetch resolves with 7. To-state: loaded { value: 7 }.
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 7 })
    const value = await r.fetch()
    expect(value).toBe(7)
    const v = g.read(r.node)
    expect(v.state).toBe('loaded')
    if (v.state !== 'loaded') throw new Error('unreachable')
    expect(v.value).toBe(7)
  })

  /**
   * Verifies a rejected loader drives the resource into `errored` and
   * the rejection propagates back to the awaiting caller.
   */
  it('transitions to errored on loader rejection', async () => {
    // From-state: idle. Event: fetch rejects. To-state: errored.
    const g = createCausl()
    const r = resource<number>(g, 'r', {
      loader: async () => {
        throw new Error('boom')
      },
    })
    await expect(r.fetch()).rejects.toThrow(/boom/)
    const v = g.read(r.node)
    expect(v.state).toBe('errored')
  })

  /**
   * Pins the loaded → stale transition: `invalidate()` marks the
   * payload as stale while preserving the previously loaded value for
   * UI continuity.
   */
  it('invalidate() flips Loaded → Stale', async () => {
    // Arrange: drive the resource to Loaded { value: 100 }.
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 100 })
    await r.fetch()
    // From-state: loaded. Event: invalidate(). To-state: stale, value retained.
    r.invalidate()
    const v = g.read(r.node)
    expect(v.state).toBe('stale')
    if (v.state !== 'stale') throw new Error('unreachable')
    expect(v.value).toBe(100)
  })

  /**
   * Pins the chart-conformant `Loaded → Errored` edge of `fail()`.
   * `SPEC.md` §6 / `docs/lifecycle.md` §1 name this transition under
   * the `invalidate(error)` trigger; `fail()` is the host-driven
   * mutator that fires it. The `origin` field of the prior `loaded`
   * state is preserved so the failure stays anchored to the GraphTime
   * the load originated at.
   */
  it('fail() drives Loaded → Errored', async () => {
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 1 })
    await r.fetch()
    const loaded = g.read(r.node)
    if (loaded.state !== 'loaded') throw new Error('unreachable')
    const originBefore = loaded.origin
    // From-state: loaded. Event: fail(). To-state: errored.
    r.fail(new Error('server-side rejection'))
    const v = g.read(r.node)
    expect(v.state).toBe('errored')
    if (v.state !== 'errored') throw new Error('unreachable')
    expect(v.error).toBeInstanceOf(Error)
    expect(v.origin).toBe(originBefore)
  })

  /**
   * Pins the chart-conformant `Loading → Errored` edge of `fail()`.
   * The chart names this transition under the `fetch-reject` trigger;
   * the loader's rejection branch fires it from inside `fetchOnce`,
   * and `fail()` covers the host-side equivalent — e.g. a host that
   * cancels an in-flight load and wants the resource parked in
   * `errored` instead of `loading`.
   */
  it('fail() drives Loading → Errored', () => {
    const g = createCausl()
    // Loader that never resolves: leaves the resource in `loading`.
    const r = resource<number>(g, 'r', {
      loader: () => new Promise<number>(() => undefined),
    })
    void r.fetch()
    expect(g.read(r.node).state).toBe('loading')
    // From-state: loading. Event: fail(). To-state: errored.
    r.fail(new Error('host-cancelled'))
    expect(g.read(r.node).state).toBe('errored')
  })

  /**
   * `SPEC.md` §6 / `docs/lifecycle.md` §1 draw exactly two edges into
   * `Errored`: `Loading → Errored` and `Loaded → Errored`. The other
   * three source states (`idle`, `stale`, `errored`) have no edge
   * into `Errored`. `SPEC.md` §17 commitment 7 forbids shipping enum
   * tags whose transitions are not specified by the chart, so
   * `fail()` rejects those source states with a typed error rather
   * than silently writing the `errored` tag.
   */
  describe('fail() rejects source states the chart does not name', () => {
    it('throws ForbiddenResourceTransitionError from idle', () => {
      const g = createCausl()
      const r = resource<number>(g, 'r', { loader: async () => 1 })
      // From-state: idle. Event: fail(). Chart has no edge.
      expect(() => r.fail(new Error('rejected'))).toThrow(
        ForbiddenResourceTransitionError,
      )
      // The state-tag must remain unchanged after the rejected mutator.
      expect(g.read(r.node).state).toBe('idle')
    })

    it('throws ForbiddenResourceTransitionError from stale', async () => {
      const g = createCausl()
      const r = resource<number>(g, 'r', { loader: async () => 1 })
      await r.fetch()
      r.invalidate()
      expect(g.read(r.node).state).toBe('stale')
      // From-state: stale. Event: fail(). Chart has no edge.
      expect(() => r.fail(new Error('rejected'))).toThrow(
        ForbiddenResourceTransitionError,
      )
      expect(g.read(r.node).state).toBe('stale')
    })

    it('throws ForbiddenResourceTransitionError from errored', async () => {
      const g = createCausl()
      const r = resource<number>(g, 'r', {
        loader: async () => {
          throw new Error('first')
        },
      })
      await expect(r.fetch()).rejects.toThrow(/first/)
      expect(g.read(r.node).state).toBe('errored')
      // From-state: errored. Event: fail(). Chart has no edge.
      expect(() => r.fail(new Error('again'))).toThrow(
        ForbiddenResourceTransitionError,
      )
      expect(g.read(r.node).state).toBe('errored')
    })

    /**
     * Adapter UIs need to route the rejection — the error carries the
     * resource id, the source state tag, and the attempted target.
     * Same shape as `ForbiddenConflictTransitionError`.
     */
    it('the thrown error carries (id, from, to) for adapter UI routing', () => {
      const g = createCausl()
      const r = resource<number>(g, 'res:42', { loader: async () => 1 })
      try {
        r.fail(new Error('rejected'))
        expect.fail('expected ForbiddenResourceTransitionError')
      } catch (e) {
        if (!(e instanceof ForbiddenResourceTransitionError)) throw e
        expect(e.id).toBe('res:42')
        expect(e.from).toBe('idle')
        expect(e.to).toBe('errored')
      }
    })
  })

  /**
   * Pins SPEC §9.1's "Suspense fresh-Promise-per-render" row: the
   * in-flight Promise lives on `ResourceState.loading` itself (one per
   * loading episode, identity-stable across renders for the same key
   * and origin). Reads at two GraphTimes during the same loading
   * episode return the same Promise reference — that identity is what
   * SuspenseList ordering and `startTransition` cached-value display
   * depend on.
   */
  it('loading state carries an identity-stable Promise per loading episode', async () => {
    const g = createCausl()
    const other = g.input('other', 0)
    let resolveFn: (v: number) => void = () => undefined
    const loaderPromise = new Promise<number>((res) => {
      resolveFn = res
    })
    const r = resource<number>(g, 'r', { loader: () => loaderPromise })
    const fetchPromise = r.fetch()
    const v1 = g.read(r.node)
    expect(v1.state).toBe('loading')
    if (v1.state !== 'loading') throw new Error('unreachable')
    // Advance graph time via an unrelated commit; the loading episode
    // is unchanged because the resource node was not mutated.
    g.commit('unrelated', (tx) => tx.set(other, 1))
    const v2 = g.read(r.node)
    expect(v2.state).toBe('loading')
    if (v2.state !== 'loading') throw new Error('unreachable')
    // Identity-stable: same Promise reference across reads.
    expect(v1.promise).toBe(v2.promise)
    resolveFn(99)
    await fetchPromise
    await v1.promise
  })

  /**
   * Sibling pin: the engine-anchored Promise must not reject when the
   * loader rejects. Suspense throws the Promise to the renderer; the
   * renderer awaits it and re-attempts. A rejected Promise creates a
   * different code path (and noisy unhandled-rejection warnings). The
   * loader's rejection still drives the resource to `errored`; the
   * subsequent re-read surfaces the error through the canonical
   * `errored` tag.
   */
  it('loading.promise resolves (does not reject) when the loader rejects', async () => {
    const g = createCausl()
    const r = resource<number>(g, 'r', {
      loader: async () => {
        throw new Error('boom')
      },
    })
    const fetchPromise = r.fetch()
    const v = g.read(r.node)
    expect(v.state).toBe('loading')
    if (v.state !== 'loading') throw new Error('unreachable')
    await expect(v.promise).resolves.toBeUndefined()
    await expect(fetchPromise).rejects.toThrow(/boom/)
    expect(g.read(r.node).state).toBe('errored')
  })
})
