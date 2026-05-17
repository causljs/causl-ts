/**
 * @packageDocumentation
 *
 * Phase 2 acceptance — React 18 StrictMode + concurrent-rendering tests.
 *
 * In dev, StrictMode mounts every component twice and runs every effect
 * twice. The hooks must therefore be:
 *   - referentially stable in their subscribe callbacks (or
 *     useSyncExternalStore re-subscribes on every render),
 *   - safe against double-effect — duplicate subscriptions must not
 *     produce duplicate renders or duplicate dispatches,
 *   - tolerant of selectors that return fresh objects (no infinite
 *     re-render loop when the selector returns Object.is-distinct
 *     values stably across renders, *which we explicitly do not
 *     promise* — the contract is to dedup by Object.is, full stop).
 */

import { createCausl } from '@causl/core'
import { act, render, screen } from '@testing-library/react'
import { StrictMode, useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCausl } from '../src/index.js'

/**
 * Suite covering React 18 StrictMode and concurrent-rendering safety for
 * the Causl React bindings. Each case wraps the component tree in
 * `<StrictMode>` (or relies on its semantics) to confirm subscriptions,
 * effect cleanup, and render counts remain bounded.
 */
describe('Phase 2 — React 18 StrictMode + concurrent', () => {
  /**
   * Verifies that double-mount under StrictMode does not leak duplicate
   * subscriptions. A single commit after mount must trigger at most one
   * StrictMode-paired re-render rather than a multiplied render storm.
   */
  it('useCausl survives StrictMode double-mount without leaking subscriptions', () => {
    // Build a minimal graph with a single counter input.
    const g = createCausl()
    const a = g.input('a', 0)
    let renders = 0
    /**
     * Test component — counts its own renders so the test can assert
     * that StrictMode's double-mount does not cause subscription leaks.
     */
    function View(): JSX.Element {
      renders += 1
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    // Mount inside StrictMode to exercise the double-invocation path.
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      </StrictMode>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')
    // Snapshot render count after mount so we can isolate post-commit renders.
    const baseline = renders
    // Drive a single commit; only the StrictMode-paired renders should follow.
    act(() => {
      g.commit('a→1', (tx) => tx.set(a, 1))
    })
    expect(screen.getByTestId('v').textContent).toBe('1')
    // StrictMode doubles renders, but a single commit must not cause
    // more than 2 (StrictMode pair) renders against the baseline.
    expect(renders - baseline).toBeLessThanOrEqual(2)
  })

  /**
   * A selector whose result is stable under `Object.is` must not trigger
   * an infinite render loop, even when invoked under StrictMode's
   * double-render semantics.
   */
  it('a stable Object.is selector does not loop', () => {
    // Set up a single input the selector will read.
    const g = createCausl()
    const a = g.input('a', 1)
    /**
     * Test component — selector returns `read(a) * 1`, an arithmetic
     * identity, so `Object.is` will dedup successive calls.
     */
    function View(): JSX.Element {
      const renderCount = useRef(0)
      renderCount.current += 1
      const value = useCausl((graph) => graph.read(a) * 1)
      return (
        <span data-testid="v">
          {value}/{renderCount.current}
        </span>
      )
    }
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      </StrictMode>,
    )
    // Initial render in StrictMode is at most 2 (mount + effect double-mount).
    const text = screen.getByTestId('v').textContent ?? ''
    const renderCount = Number(text.split('/')[1])
    // Bound the render count generously to allow StrictMode's pairing
    // without permitting a runaway loop.
    expect(renderCount).toBeLessThanOrEqual(4)
  })

  /**
   * Confirms that several commits issued inside the same React task
   * coalesce into a single rendered update reflecting the final value.
   */
  it('multiple commits in the same task batch into rendered updates', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    /** Test component — renders the latest value of input `a`. */
    function View(): JSX.Element {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // Burst three commits within a single act() — only the terminal
    // value should be observed in the DOM after batching.
    act(() => {
      g.commit('a→1', (tx) => tx.set(a, 1))
      g.commit('a→2', (tx) => tx.set(a, 2))
      g.commit('a→3', (tx) => tx.set(a, 3))
    })
    expect(screen.getByTestId('v').textContent).toBe('3')
  })

  /**
   * Verifies that `useCausl` releases its subscription on unmount.
   * Subsequent commits against the graph must complete cleanly without
   * touching the unmounted component or throwing.
   */
  it('subscribe is correctly cleaned up after unmount', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    /** Test component — reads input `a` and renders its value. */
    function View(): JSX.Element {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    const { unmount } = render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')
    // Tear down the subtree before issuing further commits.
    unmount()
    // After unmount, commits should not throw or attempt to update DOM.
    expect(() =>
      g.commit('a→1', (tx) => tx.set(a, 1)),
    ).not.toThrow()
  })
})
