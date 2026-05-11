/**
 * @packageDocumentation
 *
 * Behavioural contract for the `transient: true` option on
 * `graph.subscribe(node, observer, options)` and
 * `graph.subscribeMany(nodes, observer, options)` shipped in #766.
 * Pins the four contract clauses the issue body calls out:
 *
 * 1. A transient observer fires at most once via Phase G — the
 *    next commit-time fire after registration — and is auto-disposed
 *    before that commit returns.
 * 2. The synchronous initial fire from `subscribe` does NOT count
 *    as the transient slot — initial fire is bookkeeping that
 *    surfaces the current value to the observer; the auto-dispose
 *    trigger is the next Phase G fire.
 * 3. A transient observer that never sees a value change never
 *    fires (and is therefore never auto-disposed) — `transient`
 *    is "fire at most once," not "exists for at most one commit."
 * 4. The transient flag applies group-wide on `subscribeMany`: the
 *    whole group is dropped at the end of the first commit during
 *    which any member changed.
 */

import { describe, expect, it, vi } from 'vitest'
import { createCausl } from '../src/index.js'

describe('graph.subscribe(node, observer, { transient: true })', () => {
  /**
   * Headline acceptance: register transient, change the input,
   * observer fires once at commit time, and is dropped before the
   * next commit.
   */
  it('fires exactly once via Phase G, then auto-disposes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const obs = vi.fn()

    g.subscribe(a, obs, { transient: true })
    // Initial synchronous fire — does NOT consume the transient slot.
    expect(obs).toHaveBeenCalledTimes(1)
    expect(obs).toHaveBeenCalledWith(0, 0)

    // First commit changes the input → Phase G fires the observer
    // once and schedules the auto-dispose.
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(obs).toHaveBeenCalledTimes(2)
    expect(obs).toHaveBeenLastCalledWith(1, 1)

    // Subsequent commits never fire the observer — the registration
    // was dropped by the end of the previous commit's `finally` arm.
    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(obs).toHaveBeenCalledTimes(2)

    g.commit('a→3', (tx) => tx.set(a, 3))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * `transient` is "fire at most once," not "exists for at most one
   * commit." A transient subscription whose value never moves stays
   * alive across an arbitrary number of commits.
   */
  it('does not fire (and does not auto-dispose) when the value never moves', () => {
    const g = createCausl()
    const a = g.input('a', 5)
    const b = g.input('b', 7)
    const obs = vi.fn()

    g.subscribe(a, obs, { transient: true })
    expect(obs).toHaveBeenCalledTimes(1)

    // Several commits move only `b` — the transient observer on `a`
    // never sees a change, so its slot is never consumed.
    g.commit('b→8', (tx) => tx.set(b, 8))
    g.commit('b→9', (tx) => tx.set(b, 9))
    g.commit('b→10', (tx) => tx.set(b, 10))
    expect(obs).toHaveBeenCalledTimes(1)

    // Now move `a` — the still-live transient registration fires
    // exactly once and is auto-disposed.
    g.commit('a→6', (tx) => tx.set(a, 6))
    expect(obs).toHaveBeenCalledTimes(2)
    expect(obs).toHaveBeenLastCalledWith(6, 4)

    g.commit('a→7', (tx) => tx.set(a, 7))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * The `Object.is` equality cutoff applies before Phase G fires, so
   * a transient observer registered on a node whose value gets
   * written to its current value still doesn't fire — `transient`
   * does not loosen the equality contract.
   */
  it('does not fire when the commit lands on Object.is-equal value', () => {
    const g = createCausl()
    const a = g.input('a', 42)
    const obs = vi.fn()

    g.subscribe(a, obs, { transient: true })
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('a→42', (tx) => tx.set(a, 42))
    expect(obs).toHaveBeenCalledTimes(1)

    // Now move `a` — the transient slot is still live, fires once.
    g.commit('a→43', (tx) => tx.set(a, 43))
    expect(obs).toHaveBeenCalledTimes(2)

    g.commit('a→44', (tx) => tx.set(a, 44))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * Manual `unsubscribe()` on a transient registration that has not
   * yet fired must drop it cleanly — the auto-dispose path and the
   * manual-dispose path are mutually idempotent.
   */
  it('honours manual unsubscribe before the auto-dispose trigger', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const obs = vi.fn()

    const off = g.subscribe(a, obs, { transient: true })
    expect(obs).toHaveBeenCalledTimes(1)

    off()
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(obs).toHaveBeenCalledTimes(1)

    // Idempotent: a second `off()` after the auto-dispose path
    // would have run is also a no-op.
    expect(() => off()).not.toThrow()
  })

  /**
   * `subscribe(node, observer)` (no options) preserves the canonical
   * retain-across-commits contract — no regression from the
   * `transient` introduction.
   */
  it('omitting options preserves the canonical retained-subscription contract', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const obs = vi.fn()

    g.subscribe(a, obs)
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('a→2', (tx) => tx.set(a, 2))
    g.commit('a→3', (tx) => tx.set(a, 3))

    // Initial fire + 3 changing commits = 4 calls.
    expect(obs).toHaveBeenCalledTimes(4)
  })
})

describe('graph.subscribeMany(nodes, observer, { transient: true })', () => {
  /**
   * The `transient` flag applies group-wide: when any member of the
   * group changes, the observer fires once and the entire group is
   * auto-disposed before the commit returns.
   */
  it('fires exactly once via Phase G across the group, then auto-disposes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const c = g.input('c', 0)
    const obs = vi.fn()

    g.subscribeMany([a, b, c], obs, { transient: true })
    // Initial synchronous fire — does NOT consume the transient slot.
    expect(obs).toHaveBeenCalledTimes(1)
    expect(obs).toHaveBeenLastCalledWith([0, 0, 0])

    g.commit('b→7', (tx) => tx.set(b, 7))
    expect(obs).toHaveBeenCalledTimes(2)
    expect(obs).toHaveBeenLastCalledWith([0, 7, 0])

    // Subsequent commits — even ones moving multiple group members —
    // do not fire the observer; the whole group was dropped.
    g.commit('a+c', (tx) => {
      tx.set(a, 1)
      tx.set(c, 1)
    })
    expect(obs).toHaveBeenCalledTimes(2)

    g.commit('b→8', (tx) => tx.set(b, 8))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * Multi-member move in the same commit still dedupes to one fire,
   * and the whole group is dropped.
   */
  it('fires once when multiple members move in the same commit, then auto-disposes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const obs = vi.fn()

    g.subscribeMany([a, b], obs, { transient: true })
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('both', (tx) => {
      tx.set(a, 1)
      tx.set(b, 2)
    })
    expect(obs).toHaveBeenCalledTimes(2)
    expect(obs).toHaveBeenLastCalledWith([1, 2])

    g.commit('a→3', (tx) => tx.set(a, 3))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * A commit on a node not in the group does not fire (and does not
   * consume) the transient group slot. The group stays alive until
   * one of its own members moves.
   */
  it('survives unrelated commits until a member changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const c = g.input('c', 0)
    const obs = vi.fn()

    g.subscribeMany([a, b], obs, { transient: true })
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('c→1', (tx) => tx.set(c, 1))
    g.commit('c→2', (tx) => tx.set(c, 2))
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('a→9', (tx) => tx.set(a, 9))
    expect(obs).toHaveBeenCalledTimes(2)

    // Group dropped — further commits on `b` do not fire.
    g.commit('b→9', (tx) => tx.set(b, 9))
    expect(obs).toHaveBeenCalledTimes(2)
  })
})
