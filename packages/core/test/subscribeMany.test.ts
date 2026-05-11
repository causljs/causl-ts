/**
 * @packageDocumentation
 *
 * Behavioural contract for `graph.subscribeMany(nodes, observer, options?)`
 * — the multi-node subscription primitive shipped in #766 to surface the
 * per-node subscriber index from #738 (#671 MVP) as the adopter-facing
 * convenience the original audit promised. Pins the four contract
 * clauses the issue body calls out:
 *
 * 1. The observer fires once synchronously at registration with the
 *    tuple of current values, mirroring the per-node `subscribe`
 *    initial-fire contract.
 * 2. The observer fires once when *any* of the registered nodes'
 *    values changes — and exactly once even when multiple group
 *    members move in the same commit.
 * 3. The observer does NOT fire when an unrelated node moves in a
 *    commit; the per-node bucket index from #738 makes that an
 *    O(0) walk through the group's buckets, never an O(N) sweep.
 * 4. The returned `unsubscribe` drops the entire group atomically
 *    and is idempotent — repeated calls are harmless.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createCausl,
  NodeDisposedError,
  UnknownNodeError,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

describe('graph.subscribeMany(nodes, observer)', () => {
  /**
   * The synchronous initial fire surfaces the current value tuple to
   * the observer, mirroring `subscribe`'s initial-fire contract.
   */
  it('fires once synchronously with the tuple of current values', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const c = g.input('c', 3)
    const obs = vi.fn()

    g.subscribeMany([a, b, c], obs)

    expect(obs).toHaveBeenCalledTimes(1)
    expect(obs).toHaveBeenCalledWith([1, 2, 3])
  })

  /**
   * Headline acceptance: a commit that changes any one of the
   * registered nodes fires the observer exactly once, with the
   * fresh value tuple read at the post-commit moment.
   */
  it('fires once per commit when any one of the registered nodes changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const c = g.input('c', 0)
    const fires: ReadonlyArray<number>[] = []
    g.subscribeMany([a, b, c], (values) => {
      fires.push([...(values as readonly number[])])
    })

    // Initial fire — [0, 0, 0].
    expect(fires).toEqual([[0, 0, 0]])

    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(fires).toEqual([[0, 0, 0], [1, 0, 0]])

    g.commit('b→7', (tx) => tx.set(b, 7))
    expect(fires).toEqual([[0, 0, 0], [1, 0, 0], [1, 7, 0]])

    g.commit('c→9', (tx) => tx.set(c, 9))
    expect(fires).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [1, 7, 0],
      [1, 7, 9],
    ])
  })

  /**
   * Multi-member commit must dedupe to a single fire — exactly the
   * "exactly one notification, not two" invariant the per-node
   * `subscribe` contract enforces, lifted to the group surface.
   */
  it('fires exactly once when multiple registered nodes change in the same commit', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const c = g.input('c', 0)
    const obs = vi.fn()
    g.subscribeMany([a, b, c], obs)

    // Initial fire is one call.
    expect(obs).toHaveBeenCalledTimes(1)

    // One commit moves all three members; the observer fires exactly once.
    g.commit('all', (tx) => {
      tx.set(a, 1)
      tx.set(b, 2)
      tx.set(c, 3)
    })
    expect(obs).toHaveBeenCalledTimes(2)
    expect(obs).toHaveBeenLastCalledWith([1, 2, 3])
  })

  /**
   * Per-node index from #738 makes a commit on an unrelated node a
   * no-op for the group's observer — the bucket walk visits exactly
   * the changed-node bucket, and the group's nodes don't appear
   * there.
   */
  it('does not fire when an unrelated node changes', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const c = g.input('c', 3)
    const d = g.input('d', 4)
    const obs = vi.fn()
    g.subscribeMany([a, b, c], obs)

    // Initial fire only.
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('d→999', (tx) => tx.set(d, 999))
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('d→1000', (tx) => tx.set(d, 1000))
    expect(obs).toHaveBeenCalledTimes(1)
  })

  /**
   * Equality cutoff: a commit that writes the same value to a
   * registered node must not fire the observer (the per-node
   * `Object.is` cutoff applies uniformly).
   */
  it('skips the fire when the only changed registered node lands on Object.is-equal value', () => {
    const g = createCausl()
    const a = g.input('a', 5)
    const b = g.input('b', 6)
    const obs = vi.fn()
    g.subscribeMany([a, b], obs)

    expect(obs).toHaveBeenCalledTimes(1)

    // Write the same value back — Phase B equality cutoff suppresses
    // the entry from `changedNodes`, so the group's bucket is never
    // visited and the observer doesn't fire.
    g.commit('a→5', (tx) => tx.set(a, 5))
    expect(obs).toHaveBeenCalledTimes(1)
  })

  /**
   * Returned `unsubscribe` removes the entire group atomically — no
   * member of the group fires after the disposer is invoked, even
   * when subsequent commits change other members.
   */
  it('returns an idempotent disposer that drops the whole group', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const obs = vi.fn()
    const off = g.subscribeMany([a, b], obs)

    expect(obs).toHaveBeenCalledTimes(1)

    off()
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('b→2', (tx) => tx.set(b, 2))
    expect(obs).toHaveBeenCalledTimes(1)

    // Idempotent: a second `off()` is a no-op.
    expect(() => off()).not.toThrow()
    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(obs).toHaveBeenCalledTimes(1)
  })

  /**
   * Validation up front: a fabricated handle in the group rejects
   * the whole registration with `UnknownNodeError`, mirroring the
   * single-node `subscribe` gate.
   */
  it('throws UnknownNodeError when any member is not registered', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const fake = { id: 'never-registered' } as ReturnType<typeof g.input<number>>

    expect(() => g.subscribeMany([a, fake], () => {})).toThrow(UnknownNodeError)
  })

  /**
   * Validation up front: a disposed-node handle in the group
   * rejects the whole registration with `NodeDisposedError`, the
   * same discriminator the per-node `subscribe` gate produces.
   */
  it('throws NodeDisposedError when any member has been disposed', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    dispose(g, b)

    expect(() => g.subscribeMany([a, b], () => {})).toThrow(NodeDisposedError)
  })

  /**
   * Empty tuple is a degenerate registration: fires once with `[]`
   * and never again. The dispose closure is a no-op.
   */
  it('handles an empty node tuple by firing once with []', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const obs = vi.fn()
    const off = g.subscribeMany([], obs)

    expect(obs).toHaveBeenCalledTimes(1)
    expect(obs).toHaveBeenCalledWith([])

    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(obs).toHaveBeenCalledTimes(1)

    off()
  })

  /**
   * Composes with other subscriptions: a per-node `subscribe` and a
   * `subscribeMany` covering the same node both fire on a commit
   * touching that node, with the group's per-commit dedupe set
   * unaffected by the unrelated single-node entry.
   */
  it('composes with single-node subscribe on overlapping nodes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const oneFires: number[] = []
    const manyFires: ReadonlyArray<number>[] = []
    g.subscribe(a, (v) => oneFires.push(v))
    g.subscribeMany([a, b], (values) => {
      manyFires.push([...(values as readonly number[])])
    })

    g.commit('a→1', (tx) => tx.set(a, 1))

    // Initial fires plus one each on the commit.
    expect(oneFires).toEqual([0, 1])
    expect(manyFires).toEqual([[0, 0], [1, 0]])
  })

  /**
   * Derived nodes are first-class members of the group. A commit
   * that flows through a derived node fires the group observer with
   * the derived's recomputed value alongside the input tuple.
   */
  it('observes derived nodes alongside inputs', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const obs = vi.fn()
    g.subscribeMany([a, sum], obs)

    expect(obs).toHaveBeenLastCalledWith([1, 3])

    g.commit('a→10', (tx) => tx.set(a, 10))
    expect(obs).toHaveBeenLastCalledWith([10, 12])
  })
})
