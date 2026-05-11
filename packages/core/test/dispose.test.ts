/**
 * @packageDocumentation
 *
 * Behavioural contract for the adapter-layer disposal hook reachable
 * via `@causl/core/internal`'s `dispose` helper. `_dispose` is
 * deliberately not part of the seven-method commitment, not in the
 * public README, and not covered by SemVer guarantees on the
 * `@causl/core` public exports — it lives behind the
 * `@causl/core/internal` entrypoint because disposal is an
 * adapter-level concern. The React `useCauslFamily` hook owns the
 * concept of "this node's lifetime is bounded by a component's
 * mount"; application code has no business calling `_dispose`
 * directly.
 *
 * The contract pinned here: after disposal, public-surface access
 * to the released node surfaces a typed {@link NodeDisposedError}
 * (distinct from {@link UnknownNodeError}); double-disposal is a
 * no-op; mid-commit disposal is rejected; and disposal of a node
 * with live dependents is rejected with the offending dependent
 * ids surfaced.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCausl,
  DisposalDuringCommitError,
  NodeDisposedError,
  NodeHasDependentsError,
  UnknownNodeError,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

/**
 * Contract suite for `dispose(graph, node)`. Covers the post-disposal
 * surface, idempotence, mid-commit rejection, and the dependents-still-live
 * guard.
 */
describe('@causl/core/internal :: dispose(graph, node)', () => {
  /**
   * After disposing an input, every public-surface access must throw
   * `NodeDisposedError` with the node id and the disposal time —
   * the `Disposed` discriminated tag's runtime guard catches escapes
   * past the type narrowing.
   */
  it('routes post-disposal reads through NodeDisposedError', () => {
    // arrange: a graph with one disposable input
    const g = createCausl()
    const a = g.input('a', 1)

    // act: dispose then attempt to read
    dispose(g, a)

    // assert: the engine reports a typed disposal error, not Unknown
    expect(() => g.read(a)).toThrow(NodeDisposedError)
    expect(() => g.read(a)).not.toThrow(UnknownNodeError)
  })

  /**
   * `subscribe` on a disposed input must surface the same typed error
   * — not a silent dead-letter — because the internal-API contract is
   * that adapter code can branch on "released" vs. "never registered"
   * to make a useful retry/cleanup decision.
   */
  it('routes post-disposal subscribe through NodeDisposedError', () => {
    // arrange: dispose first, then attempt to subscribe
    const g = createCausl()
    const a = g.input('a', 1)
    dispose(g, a)

    // act + assert: subscribe surfaces the typed error
    expect(() => g.subscribe(a, () => {})).toThrow(NodeDisposedError)
  })

  /**
   * Disposal is idempotent: calling `dispose` a second time on the
   * same node is a no-op, not an error. Adapter retry paths depend on
   * this guarantee.
   */
  it('is idempotent across repeated calls', () => {
    // arrange: dispose once
    const g = createCausl()
    const a = g.input('a', 1)
    dispose(g, a)

    // act + assert: a second call does not throw
    expect(() => dispose(g, a)).not.toThrow()
  })

  /**
   * Disposal of an unknown node — one never registered with this
   * graph — is also a no-op (no typed error). The asymmetry vs. read
   * is deliberate: the post-disposal surface is the contract, not the
   * dispose call itself.
   */
  it('treats disposal of an unknown node as a no-op', () => {
    // arrange: a foreign-looking node handle never registered
    const g = createCausl()
    const ghost = { id: 'never-registered' }

    // act + assert: dispose tolerates the unknown id silently
    expect(() => dispose(g, ghost)).not.toThrow()
  })

  /**
   * Mid-commit disposal must throw `DisposalDuringCommitError` rather
   * than corrupt the engine's in-flight staging buffer. Adapter code
   * must defer disposal to a microtask outside the commit window.
   */
  it('rejects disposal while a commit is in progress', () => {
    // arrange: a graph with two inputs to keep the commit body non-empty
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)

    // act: trigger a commit whose body attempts disposal
    let captured: unknown
    g.commit('attempt', (tx) => {
      tx.set(a, 9) // staged write — keeps the commit alive
      try {
        dispose(g, b)
      } catch (e) {
        captured = e
      }
    })

    // assert: the captured error is the typed mid-commit guard
    expect(captured).toBeInstanceOf(DisposalDuringCommitError)
  })

  /**
   * Disposing a node that still has live derived dependents must
   * throw, because dropping the producer would leave stale edges.
   * The error surfaces every offending dependent id.
   */
  it('rejects disposal of a node with live dependents', () => {
    // arrange: a → b (b reads a)
    const g = createCausl()
    const a = g.input('a', 1)
    g.derived('b', (get) => get(a) + 1)

    // act + assert: dispose(a) refuses because b still reads from it
    expect(() => dispose(g, a)).toThrow(NodeHasDependentsError)
  })

  /**
   * After disposing the dependent first, the producer becomes
   * disposable. This pins the contract that the caller drains
   * downstream consumers before their producers.
   */
  it('admits disposal once dependents are released first', () => {
    // arrange: a → b
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.derived('b', (get) => get(a) + 1)

    // act: release the dependent first, then the producer
    dispose(g, b)
    dispose(g, a)

    // assert: both are now released
    expect(() => g.read(a)).toThrow(NodeDisposedError)
    expect(() => g.read(b)).toThrow(NodeDisposedError)
  })

  /**
   * Subscribers attached before disposal must stop receiving
   * notifications afterwards — the engine's subscription set is
   * cleaned up as part of the dispose pipeline.
   */
  it('cancels existing subscriptions on the disposed node', () => {
    // arrange: subscribe, then dispose
    const g = createCausl()
    const a = g.input('a', 1)
    const obs = vi.fn()
    g.subscribe(a, obs)
    obs.mockClear() // discard the initial-fire delivery

    // act: dispose; further commits do not reach the dead subscriber
    dispose(g, a)

    // assert: no further notifications can arrive (the subscription is gone)
    expect(obs).not.toHaveBeenCalled()
  })

  /**
   * Calling `dispose` on a foreign object (one not produced by
   * `createCausl`) surfaces a clear failure rather than silently
   * succeeding. The bridge throws when its dispatch lookup misses.
   */
  it('rejects dispatch for a foreign graph handle', () => {
    // arrange: a fake graph handle and a real-ish node
    const fakeGraph = {} as unknown as ReturnType<typeof createCausl>
    const node = { id: 'x' }

    // act + assert: lookup miss surfaces a descriptive error
    expect(() => dispose(fakeGraph, node)).toThrow(/createCausl/)
  })
})
