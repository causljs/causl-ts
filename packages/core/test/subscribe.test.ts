/**
 * @packageDocumentation
 *
 * Behavioural contract for `graph.subscribe(node, observer)`: initial fire
 * on subscription, one notification per commit when the value changes,
 * `Object.is` equality skip, unsubscribe semantics, atomic derived
 * emissions, and observer-error isolation. Each `it(...)` pins one of
 * these contract clauses so regressions surface against a named subscribe
 * behaviour rather than as a vague observer failure.
 *
 * `subscribe` is one of the seven canonical public methods we defend on
 * every PR review — its contract is to notify once per commit when the
 * observed value changes. The atomic-derived clause is the visible face
 * of glitch-freedom: in the smallest worked example, two inputs written
 * inside one transaction produce exactly one notification at the
 * downstream subscriber, not two — there is no fractional time and no
 * mid-commit emission.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createCausl,
  NodeDisposedError,
  UnknownNodeError,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

/**
 * Contract suite for `graph.subscribe`. Pins each visible behaviour an
 * observer can rely on across subscription, commits, equality skips,
 * unsubscribe, atomic derived propagation, and error isolation.
 */
describe('graph.subscribe(node, observer)', () => {
  /**
   * Subscribing must immediately invoke the observer once with the
   * current value and the current clock (here: clock `0`).
   */
  it('fires once with the current value at subscription time', () => {
    // Arrange: a fresh graph with one input at value 5.
    const g = createCausl()
    const a = g.input('a', 5)
    const obs = vi.fn()

    // Act: subscribe.
    g.subscribe(a, obs)

    // Assert: exactly one synchronous fire with (value, clock).
    expect(obs).toHaveBeenCalledTimes(1)
    expect(obs).toHaveBeenCalledWith(5, 0)
  })

  /**
   * After the initial fire, every commit that changes the observed
   * value yields exactly one notification with the new value.
   */
  it('fires once per commit when the observed value changes', () => {
    // Arrange: subscribe, capture each emitted value.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a, (v) => seen.push(v))

    // Act: three commits, each writing a distinct value.
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('a→2', (tx) => tx.set(a, 2))
    g.commit('a→3', (tx) => tx.set(a, 3))

    // Assert: initial 0 plus one notification per changing commit.
    expect(seen).toEqual([0, 1, 2, 3])
  })

  /**
   * Commits whose write produces an `Object.is`-equal value must not
   * notify subscribers — equality is the de-duplication boundary.
   */
  it('skips notifications when the value is Object.is-equal', () => {
    // Arrange: subscribe to an input starting at 0.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a, (v) => seen.push(v))

    // Act: interleave no-op writes with a real change.
    g.commit('a→0 (no-op)', (tx) => tx.set(a, 0))
    g.commit('a→1', (tx) => tx.set(a, 1))
    g.commit('a→1 (no-op)', (tx) => tx.set(a, 1))

    // Assert: only the genuine change between Object.is-distinct values is observed.
    expect(seen).toEqual([0, 1])
  })

  /**
   * `subscribe` must return an unsubscribe handle that, once called,
   * stops further notifications without affecting other subscribers.
   */
  it('returns an unsubscribe function that stops further notifications', () => {
    // Arrange: subscribe and keep the disposer.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    const unsub = g.subscribe(a, (v) => seen.push(v))

    // Act: one commit observed, then unsubscribe, then another commit.
    g.commit('a→1', (tx) => tx.set(a, 1))
    unsub()
    g.commit('a→2', (tx) => tx.set(a, 2))

    // Assert: only the pre-unsubscribe values land in the log.
    expect(seen).toEqual([0, 1])
  })

  /**
   * Subscribing to a derived node must yield atomic per-commit emissions —
   * even when a single transaction writes multiple inputs the derived
   * depends on. This is the smallest worked example's "exactly one
   * notification, not two" guarantee in test form: a single commit
   * advancing time by one tick yields a single observation of the
   * post-commit derived value.
   */
  it('observers see derived values atomically (one notify per commit)', () => {
    // Arrange: a derived `sum` over two inputs.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const seen: number[] = []
    g.subscribe(sum, (v) => seen.push(v))

    // Act: write both inputs in a single transaction.
    g.commit('both', (tx) => {
      tx.set(a, 10)
      tx.set(b, 20)
    })

    // Assert: one consistent post-commit emission, no transient (10+2) glitch.
    expect(seen).toEqual([3, 30])
  })

  /**
   * Subscribing through a fabricated handle whose id was never
   * registered must fault with `UnknownNodeError` rather than
   * silently allocating subscription bookkeeping. `subscribe` is one
   * of the read-side primitives in SPEC §12.1's canonical seven, and
   * it shares the same up-front entry-validation gate as `read` and
   * `explain` — pinning the throw here makes the contract visible at
   * the test level rather than inferable only from the engine's
   * source.
   */
  it('throws UnknownNodeError on an unregistered node', () => {
    // Arrange: a graph and a fabricated handle whose id was never registered.
    const g = createCausl()
    const ghost = { id: 'never-registered' }

    // Act + assert: subscribe rejects the unknown id at the entry-validation gate.
    expect(() => g.subscribe(ghost, () => {})).toThrow(UnknownNodeError)
  })

  /**
   * After an input is released through the adapter-layer `dispose`
   * hook (`@causljs/core/internal`), `subscribe` must surface
   * `NodeDisposedError` — the typed disposal error distinct from
   * `UnknownNodeError` — so adapter code can branch on "released"
   * vs. "never registered". SPEC §9.1's use-after-dispose row names
   * `subscribe` explicitly; this is that row's regression-pin.
   */
  it('throws NodeDisposedError after disposal', () => {
    // Arrange: register an input, then dispose it through the internal hook.
    const g = createCausl()
    const a = g.input('a', 1)
    dispose(g, a)

    // Act + assert: subscribe surfaces the typed disposal error,
    // not the generic UnknownNodeError used for never-registered ids.
    expect(() => g.subscribe(a, () => {})).toThrow(NodeDisposedError)
    expect(() => g.subscribe(a, () => {})).not.toThrow(UnknownNodeError)
  })

  /**
   * A throwing observer must not block siblings from being notified —
   * exceptions are isolated per-observer.
   */
  it('isolates observer exceptions from each other', () => {
    // Arrange: register a throwing observer first, then a recording observer.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a, () => {
      throw new Error('boom')
    })
    g.subscribe(a, (v) => seen.push(v))

    // Act: drive a single commit.
    g.commit('a→1', (tx) => tx.set(a, 1))

    // Assert: despite the throwing observer, the second one was notified for both values.
    expect(seen).toContain(0)
    expect(seen).toContain(1)
  })
})
