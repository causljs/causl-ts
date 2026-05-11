/**
 * @packageDocumentation
 *
 * Surface-level pinning for the `createCausl` factory: presence of the
 * canonical API, the initial GraphTime, monotonic time advancement under
 * commits (including no-ops), and isolation between independently-
 * constructed graph instances. Each suite below constructs one or more
 * graphs and inspects either the method shape on the returned object or
 * the value of `graph.now` after a known sequence of commits.
 *
 * The canonical surface this factory must produce is the load-bearing
 * seven: `createCausl()` itself, plus `input`, `derived`, `commit`,
 * `read`, `subscribe`, and `explain` on the returned graph. Each row of
 * that table earned its slot by being unavoidable — the engine cannot
 * exist without one of these seven, and each is the smallest possible
 * expression of its concept. Time advancement comes from the rule that
 * `commit` is the only mutation API and produces exactly one new
 * `GraphTime` per call.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

/**
 * Pins the construction-time and lifecycle invariants of the engine
 * factory: the canonical surface is present and time starts at t₀ = 0.
 */
describe('createCausl()', () => {
  /**
   * The factory return value exposes the canonical seven primitive
   * methods (`input`, `derived`, `commit`, `read`, `subscribe`, `explain`),
   * each as a callable function. These are the public methods the engine
   * defends on every PR review.
   */
  it('returns an object exposing the canonical primitive methods', () => {
    // arrange + act: construct a fresh graph.
    const g = createCausl()
    // assert: each canonical primitive is a function on the returned handle.
    expect(typeof g.input).toBe('function')
    expect(typeof g.derived).toBe('function')
    expect(typeof g.commit).toBe('function')
    expect(typeof g.read).toBe('function')
    expect(typeof g.subscribe).toBe('function')
    expect(typeof g.explain).toBe('function')
  })

  /**
   * A freshly-constructed graph reports GraphTime zero — the engine's
   * `t₀`, the initial moment in the ordered sequence of commit moments —
   * establishing the baseline against which subsequent commits are
   * measured.
   */
  it('starts at GraphTime t₀ = 0', () => {
    const g = createCausl()
    expect(g.now).toBe(0)
  })

  /**
   * Each `commit` call (whether write-bearing or empty) increments
   * `graph.now` by exactly one, so GraphTime is a monotonic strictly-
   * increasing counter over the sequence of Event Commits.
   */
  it('advances GraphTime by exactly 1 per commit', () => {
    // arrange: graph at t=0 with one input.
    const g = createCausl()
    const a = g.input('a', 0)
    expect(g.now).toBe(0)
    // act + assert: each commit ticks the clock by exactly one.
    g.commit('w1', (tx) => tx.set(a, 1))
    expect(g.now).toBe(1)
    g.commit('w2', (tx) => tx.set(a, 2))
    expect(g.now).toBe(2)
    // Even a no-op commit advances time (it is still an Event Commit).
    g.commit('noop', () => {
      // intentionally empty
    })
    expect(g.now).toBe(3)
  })

  /**
   * Two graphs constructed by separate calls to `createCausl` share no
   * state: a commit on one leaves the other's `now` untouched, so module-
   * scoped consumers can hold multiple graphs without cross-contamination.
   */
  it('produces independent graph instances', () => {
    // arrange: two independent graphs.
    const g1 = createCausl()
    const g2 = createCausl()
    const a1 = g1.input('a', 1)
    // act: mutate only the first graph.
    g1.commit('bump', (tx) => tx.set(a1, 99))
    // assert: the second graph's clock is unaffected.
    expect(g1.now).toBe(1)
    expect(g2.now).toBe(0)
  })
})
