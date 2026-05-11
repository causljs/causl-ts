/**
 * @packageDocumentation
 *
 * Phase 4 staleness-policy guard tests. The stale-async race — a
 * fetch returns after its dependency changed — is real and the engine
 * cannot avoid it; what it can guarantee is a defined response. The
 * guard is a single line in resource.ts: when `loadedAt > loadingAt`
 * the fetch result is tagged `stale` rather than `loaded`. The cases
 * below pin the guard's behaviour against deterministic interleavings
 * of `(commit, fetch-start, fetch-resolve, commit, ...)`, including a
 * per-resource opt-out and the recovery path from stale back to
 * loaded.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { resource } from '../src/index.js'

/**
 * Externally-resolvable promise handle used by these tests to interleave
 * a commit between loader start and loader completion.
 *
 * @typeParam T - Value type produced by the deferred promise.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/**
 * Constructs a {@link Deferred}. Unlike the property-test variant this
 * one omits the `settled` latch — every test here resolves each
 * deferred at most once.
 *
 * @typeParam T - Value type produced by the deferred promise.
 * @returns A fresh {@link Deferred} backed by a pending promise.
 */
function defer<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/**
 * Suite covering each branch of the `loadedAt > loadingAt` guard plus
 * the per-resource opt-out (`stalenessGuard: false`) and recovery from
 * stale back into loaded.
 */
describe('staleness-policy guard', () => {
  /**
   * Baseline case: with no commits interleaved between loader start and
   * loader completion, `loadedAt === loadingAt` so the guard yields
   * `loaded`.
   */
  it('a fetch with no concurrent commits resolves as Loaded', async () => {
    // Construct a synchronous-resolution loader so the fetch settles
    // without any intervening clock advance.
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 1 })
    await r.fetch()
    // No commits occurred during the fetch, so the guard cannot fire.
    expect(g.read(r.node).state).toBe('loaded')
  })

  /**
   * Canonical stale-async case: a commit lands between loader start and
   * loader resolve, so `loadedAt > loadingAt` and the guard tags the
   * result `stale` while still preserving the loaded value.
   */
  it('a fetch that resolves AFTER an external commit lands as Stale', async () => {
    const g = createCausl()
    const other = g.input('other', 0)
    const d = defer<number>()
    const r = resource<number>(g, 'r', { loader: () => d.promise })

    // Begin the fetch; the deferred is now pending.
    const fetchPromise = r.fetch()
    // External commit interleaves between loader start and resolve.
    g.commit('external', (tx) => tx.set(other, 1))
    // Resolve the loader after the clock has already advanced.
    d.resolve(42)
    await fetchPromise

    // Expect the guard to mark this stale yet retain the resolved value.
    const v = g.read(r.node)
    expect(v.state).toBe('stale')
    if (v.state !== 'stale') throw new Error('unreachable')
    expect(v.value).toBe(42)
  })

  /**
   * Opt-out path: setting `stalenessGuard: false` selects last-writer-wins
   * semantics, so the same interleaving that would otherwise be stale
   * lands as `loaded`.
   */
  it('staleness can be opted out per resource (last-writer-wins)', async () => {
    const g = createCausl()
    const other = g.input('other', 0)
    const d = defer<number>()
    // Disable the guard for this resource only.
    const r = resource<number>(g, 'r', {
      loader: () => d.promise,
      stalenessGuard: false,
    })
    const fetchPromise = r.fetch()
    // Same interleaving as the previous case — the difference is purely
    // the opt-out flag.
    g.commit('external', (tx) => tx.set(other, 1))
    d.resolve(42)
    await fetchPromise
    expect(g.read(r.node).state).toBe('loaded')
  })

  /**
   * Recovery path: once a resource is `stale`, a subsequent fetch with
   * no intervening commits must transition it back to `loaded`.
   */
  it('refetch after Stale returns to Loaded if no further interference', async () => {
    const g = createCausl()
    const other = g.input('other', 0)
    const d1 = defer<number>()
    const d2 = defer<number>()
    let calls = 0
    // Loader picks the right deferred per call so each fetch is
    // independently controllable.
    const r = resource<number>(g, 'r', {
      loader: () => {
        calls += 1
        return calls === 1 ? d1.promise : d2.promise
      },
    })
    // First fetch races a commit and lands as stale.
    const f1 = r.fetch()
    g.commit('external', (tx) => tx.set(other, 1))
    d1.resolve(1)
    await f1
    expect(g.read(r.node).state).toBe('stale')

    // Second fetch sees no commits, so the guard does not fire.
    const f2 = r.fetch()
    d2.resolve(2)
    await f2
    expect(g.read(r.node).state).toBe('loaded')
  })

  /**
   * Mixed sequence exercising stale -> loaded -> stale across three
   * back-to-back fetches sharing one queue of deferreds. Each transition
   * is governed solely by whether a commit lands between the matching
   * `fetch-start` and `fetch-resolve`.
   */
  it('many interleaved fetches: each completes deterministically per its origin', async () => {
    const g = createCausl()
    const other = g.input('other', 0)
    const queue: Array<Deferred<number>> = []
    let n = 0
    // Loader pushes a fresh deferred per call so the test can resolve
    // them in order.
    const r = resource<number>(g, 'r', {
      loader: () => {
        const d = defer<number>()
        queue.push(d)
        return d.promise
      },
    })

    // First fetch: commit interleaves -> stale.
    const f1 = r.fetch()
    g.commit('intervene', (tx) => tx.set(other, ++n))
    queue[0]!.resolve(1)
    await f1
    expect(g.read(r.node).state).toBe('stale')

    // Second fetch: no commit interleaves -> loaded.
    const f2 = r.fetch()
    queue[1]!.resolve(2)
    await f2
    expect(g.read(r.node).state).toBe('loaded')

    // Third fetch: commit interleaves again -> back to stale.
    const f3 = r.fetch()
    g.commit('intervene-2', (tx) => tx.set(other, ++n))
    queue[2]!.resolve(3)
    await f3
    expect(g.read(r.node).state).toBe('stale')
  })
})
