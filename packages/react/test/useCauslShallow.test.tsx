/**
 * @packageDocumentation
 *
 * `useCauslShallow` — shallow-equality dedup for object/array
 * selectors. Without it a selector that returns a fresh object each
 * call would re-render on every commit (Object.is is always false for
 * fresh objects). Shallow equality on top-level keys/indices removes
 * those spurious renders. Also covers the standalone `shallowEqual`
 * utility used by the hook.
 */

import { createCausl } from '@causljs/core'
import { act, render, screen } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import {
  shallowEqual,
  CauslProvider,
  useCauslShallow,
} from '../src/index.js'

/**
 * Tests for the standalone `shallowEqual` utility — table-driven so
 * each input pair documents one branch of the equality contract:
 * matching keys, differing keys, key-count mismatch, array shape,
 * primitive identity, and explicit non-recursion on nested objects.
 */
describe('shallowEqual', () => {
  /**
   * Table-driven assertions over pairs of values and expected results.
   * Each row captures one comparison case so coverage is explicit.
   */
  it.each([
    [{ a: 1, b: 2 }, { a: 1, b: 2 }, true],
    [{ a: 1, b: 2 }, { a: 1, b: 3 }, false],
    [{ a: 1 }, { a: 1, b: 2 }, false],
    [[1, 2, 3], [1, 2, 3], true],
    [[1, 2, 3], [1, 2, 4], false],
    [[1, 2], [1, 2, 3], false],
    [null, null, true],
    [null, {}, false],
    [{}, null, false],
    [1, 1, true],
    [{ a: { nested: 1 } }, { a: { nested: 1 } }, false], // deep change
  ])('%j vs %j → %s', (a, b, expected) => {
    expect(shallowEqual(a, b)).toBe(expected)
  })
})

/**
 * Suite for the `useCauslShallow` hook — confirms shallow dedup of
 * object selectors, render-on-real-change semantics, and the
 * provider-required diagnostic.
 */
describe('useCauslShallow', () => {
  /**
   * A commit that leaves every selected slice equal must not produce
   * an additional render, even though the selector returns a brand-new
   * object literal on every call.
   */
  it('does not re-render when the selector returns a shallow-equal object', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    /**
     * Test component — selector returns a fresh `{ a, b }` literal
     * each call; render count is tracked via a ref so the test can
     * detect any unwanted renders.
     */
    function View(): JSX.Element {
      const renderRef = useRef(0)
      renderRef.current += 1
      const view = useCauslShallow((graph) => ({
        a: graph.read(a),
        b: graph.read(b),
      }))
      return (
        <span data-testid="v">
          {view.a}/{view.b}/{renderRef.current}
        </span>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // Snapshot render count after initial mount.
    const initialText = screen.getByTestId('v').textContent ?? ''
    const initialRenders = Number(initialText.split('/')[2])

    // Commit a value that does not change the selected slice.
    act(() => {
      g.commit('a→1 (noop)', (tx) => tx.set(a, 1))
    })
    // Render count should be unchanged because the slice is shallow-equal.
    const afterNoopRenders = Number(
      (screen.getByTestId('v').textContent ?? '').split('/')[2],
    )
    expect(afterNoopRenders).toBe(initialRenders)
  })

  /**
   * Conversely, mutating one slice key must propagate to a render —
   * shallow dedup must not swallow real changes.
   */
  it('re-renders when one slice key changes', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    /** Test component — projects a two-key view of inputs `a` and `b`. */
    function View(): JSX.Element {
      const view = useCauslShallow((graph) => ({
        a: graph.read(a),
        b: graph.read(b),
      }))
      return <span data-testid="v">{view.a}/{view.b}</span>
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // Initial state reflects the input defaults.
    expect(screen.getByTestId('v').textContent).toBe('1/2')
    // Change the `a` slice — the rendered view must update.
    act(() => {
      g.commit('a→7', (tx) => tx.set(a, 7))
    })
    expect(screen.getByTestId('v').textContent).toBe('7/2')
  })

  /**
   * Confirms `useCauslShallow` raises a hook-named diagnostic when
   * invoked outside any `<CauslProvider>` context.
   */
  it('throws outside a provider', () => {
    /** Test component — calling the hook without a provider throws. */
    function View(): JSX.Element {
      const v = useCauslShallow((graph) => graph.now)
      return <span>{v}</span>
    }
    expect(() => render(<View />)).toThrowError(
      /useCauslShallow must be used inside <CauslProvider>/,
    )
  })
})
