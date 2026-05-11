/**
 * @packageDocumentation
 *
 * Tests for the primary `useCausl(selector)` hook. Exercises basic
 * read semantics, change-driven re-render, `Object.is`-based dedup so
 * unrelated commits do not cause renders, and the provider-required
 * runtime error path.
 */

import { createCausl, type Graph } from '@causl/core'
import { act, render, screen } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCausl } from '../src/index.js'

/**
 * Suite for `useCausl(selector)` — covers the four canonical
 * behaviours: initial read, re-render on selected change, no-op on
 * unrelated change, and missing-provider diagnostic.
 */
describe('useCausl(selector)', () => {
  /**
   * Confirms the initial render reflects the value returned by the
   * selector against the provider's graph.
   */
  it('renders the current selector value', () => {
    // Seed the graph with a non-zero default to differentiate from
    // the empty-state baseline.
    const g = createCausl()
    const a = g.input('a', 7)
    /** Test component — projects input `a` into the DOM. */
    function View(): JSX.Element {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('7')
  })

  /**
   * Confirms the hook re-renders when a commit alters the value
   * returned by the selector. Two successive commits both propagate.
   */
  it('re-renders when the selected value changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    /** Test component — reads input `a`. */
    function View(): JSX.Element {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // First commit: 0 → 1.
    act(() => {
      g.commit('a→1', (tx) => tx.set(a, 1))
    })
    expect(screen.getByTestId('v').textContent).toBe('1')
    // Second commit: 1 → 42 confirms repeated subscription updates.
    act(() => {
      g.commit('a→42', (tx) => tx.set(a, 42))
    })
    expect(screen.getByTestId('v').textContent).toBe('42')
  })

  /**
   * `Object.is`-based dedup must suppress renders when a commit alters
   * a graph cell the selector does not depend on. A subsequent commit
   * to the watched cell still triggers a render.
   */
  it('does not re-render when an unrelated input changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)

    /**
     * Test component — selector reads only `a`, so commits touching
     * only `b` should produce no observable render-count delta.
     */
    function View(): JSX.Element {
      const renderCount = useRef(0)
      renderCount.current += 1
      const v = useCausl((graph) => graph.read(a))
      return (
        <span data-testid="v">
          {v}/{renderCount.current}
        </span>
      )
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // Snapshot render count after initial mount.
    const initial = screen.getByTestId('v').textContent ?? ''
    const initialRenders = Number(initial.split('/')[1])

    // Commit to the unrelated input `b` — selector value unchanged.
    act(() => {
      g.commit('b→7', (tx) => tx.set(b, 7))
    })
    const afterB = screen.getByTestId('v').textContent ?? ''
    const rendersAfterB = Number(afterB.split('/')[1])
    // No additional render — selector returned the same value.
    expect(rendersAfterB).toBe(initialRenders)

    // Commit to watched input `a` — selector value changes.
    act(() => {
      g.commit('a→1', (tx) => tx.set(a, 1))
    })
    const afterA = screen.getByTestId('v').textContent ?? ''
    const rendersAfterA = Number(afterA.split('/')[1])
    // Render count must strictly advance after the relevant commit.
    expect(rendersAfterA).toBeGreaterThan(initialRenders)
  })

  /**
   * Confirms `useCausl` raises a clear, hook-named diagnostic when
   * invoked outside any `<CauslProvider>` context.
   */
  it('throws a descriptive error when used outside a provider', () => {
    /** Test component — invoking the hook without a provider throws. */
    function View(): JSX.Element {
      const v = useCausl((graph) => graph.now)
      return <span>{v}</span>
    }
    // Expect the diagnostic from the hook to surface through render.
    expect(() => render(<View />)).toThrowError(
      /useCausl must be used inside <CauslProvider>/,
    )
  })

  /**
   * Capability-narrowing assertions (#229). Selectors are pure read-side
   * code; they should receive only `read`/`subscribe`/`subscribeCommits`
   * /`now`. Today the `Graph` is passed in raw, which leaks `commit`,
   * `input`, `derived`, `exportModel` ambient authority into selector
   * code (Mark Miller POLA violation; tearing hazard if a selector
   * mutates mid-render).
   *
   * Wiring: the hook calls `narrowCapability(graph)` from
   * `@causl/core/internal` at the entry boundary. The Proxy throws
   * `CapabilityViolation` on any non-allowed property access.
   */
  describe('selector receives a narrowed capability (not the engine)', () => {
    it('exposes read/subscribe/subscribeCommits/now to the selector', () => {
      const g = createCausl()
      const a = g.input('a', 5)
      let captured: unknown
      function View(): JSX.Element {
        const v = useCausl((cap) => {
          captured = cap
          return cap.read(a)
        })
        return <span data-testid="v">{v}</span>
      }
      render(
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>,
      )
      expect(screen.getByTestId('v').textContent).toBe('5')
      // The four allowed methods are reachable on the captured cap.
      const cap = captured as {
        read: unknown
        subscribe: unknown
        subscribeCommits: unknown
        now: unknown
      }
      expect(typeof cap.read).toBe('function')
      expect(typeof cap.subscribe).toBe('function')
      expect(typeof cap.subscribeCommits).toBe('function')
      expect(typeof cap.now).toBe('number')
    })

    it('throws CapabilityViolation when a selector reaches for commit/input/derived/exportModel', () => {
      const g = createCausl()
      const a = g.input('a', 0)
      let captured: unknown
      function View(): JSX.Element {
        const v = useCausl((cap) => {
          captured = cap
          return cap.read(a)
        })
        return <span>{v}</span>
      }
      render(
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>,
      )
      // `commit` and friends are not part of the narrowed capability;
      // the runtime Proxy rejects any property access that isn't in
      // the allow-list. Cast through `Graph` because we're explicitly
      // testing the runtime gate that catches authority leaks the
      // type system already forbids.
      const leaked = captured as Graph
      expect(() => leaked.commit('hack', () => undefined)).toThrow(/CapabilityViolation/)
      expect(() => leaked.input('x' as never, 1 as never)).toThrow(/CapabilityViolation/)
      expect(() => leaked.derived('y' as never, () => 1 as never)).toThrow(/CapabilityViolation/)
      expect(() => leaked.exportModel()).toThrow(/CapabilityViolation/)
    })
  })
})
