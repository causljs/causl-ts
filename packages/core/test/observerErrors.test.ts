/**
 * @packageDocumentation
 *
 * Pins down the observer-fault contract: thrown errors inside
 * subscribers must not poison the dispatch loop or destabilise the
 * graph. Observer faults are a runtime race-class — the type system
 * cannot reach across into application-supplied callbacks — so the
 * engine guarantees a *defined response* (isolation, structured
 * reporting) rather than avoidance. Tests cover four scenarios: a
 * throwing observer must not block sibling observers, the default
 * sink routes errors to `console.error`, an injected
 * `onObserverError` hook receives both the error and the offending
 * node's id, and commit-level subscribers (`subscribeCommits`) honour
 * the same hook.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCausl } from '../src/index.js'

/**
 * Suite covering observer error reporting: isolation across
 * subscribers, default `console.error` routing, and the
 * `onObserverError` hook for both node and commit observers.
 */
describe('observer error reporting', () => {
  /**
   * When one observer throws, peer observers on the same node still
   * receive the new value — failures are isolated, not propagated.
   */
  it('a throwing observer does not interrupt other observers', () => {
    // Arrange: two subscribers on the same input; the first throws.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a, () => {
      throw new Error('boom from observer 1')
    })
    g.subscribe(a, (v) => seen.push(v))
    // Act: commit a value change to trigger both observers.
    g.commit('a→1', (tx) => tx.set(a, 1))
    // Assert: the surviving observer recorded the new value.
    expect(seen).toContain(1)
  })

  /**
   * Without a custom hook, a throwing observer's error is reported
   * via `console.error` so it remains visible during development.
   */
  it('a throwing observer is reported via console.error by default', () => {
    // Arrange: stub `console.error` so we can observe its calls.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // Arrange (cont): a graph with a throwing subscriber.
      const g = createCausl()
      const a = g.input('a', 0)
      g.subscribe(a, () => {
        throw new Error('boom')
      })
      // Act: commit a value change to trigger the failing observer.
      g.commit('a→1', (tx) => tx.set(a, 1))
      // Assert: `console.error` was called and at least one argument
      // mentions the original error message.
      expect(errSpy).toHaveBeenCalled()
      const args = errSpy.mock.calls.flat()
      expect(args.some((arg) => String(arg).includes('boom'))).toBe(true)
    } finally {
      // Teardown: always restore the real `console.error`.
      errSpy.mockRestore()
    }
  })

  /**
   * Configuring `onObserverError` redirects observer faults away
   * from `console.error`; the hook receives the thrown error and a
   * context object identifying the failing node.
   */
  it('observer-error hook receives the error and the observed value', () => {
    // Arrange: custom hook that captures (error, nodeId) tuples.
    const errors: Array<{ error: unknown; node: string | undefined }> = []
    const g = createCausl({
      onObserverError: (error, ctx) => {
        errors.push({ error, node: ctx.nodeId })
      },
    })
    const a = g.input('a', 0)
    g.subscribe(a, () => {
      throw new Error('boom')
    })
    // Act: the subscribe call fires once with the initial value
    // (first error); the commit fires it again (second error).
    g.commit('a→1', (tx) => tx.set(a, 1))
    // Assert: both invocations were captured and tagged with node id
    // 'a', and the second carries the expected message.
    expect(errors.length).toBe(2)
    expect(errors[0]?.node).toBe('a')
    expect(errors[1]?.node).toBe('a')
    expect((errors[1]?.error as Error).message).toBe('boom')
  })

  /**
   * Commit-level observers registered via `subscribeCommits` route
   * thrown errors through the same `onObserverError` hook as
   * node-level observers.
   */
  it('a throwing commit observer (subscribeCommits) is also reported', () => {
    // Arrange: graph with a hook and a throwing commit subscriber.
    const errors: unknown[] = []
    const g = createCausl({ onObserverError: (e) => errors.push(e) })
    const a = g.input('a', 0)
    g.subscribeCommits(() => {
      throw new Error('commit-observer-boom')
    })
    // Act: produce a commit so the commit observer fires.
    g.commit('a→1', (tx) => tx.set(a, 1))
    // Assert: exactly one error was reported, carrying the original
    // message.
    expect(errors.length).toBe(1)
    expect((errors[0] as Error).message).toBe('commit-observer-boom')
  })
})
