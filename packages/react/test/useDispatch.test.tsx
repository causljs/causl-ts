/**
 * @packageDocumentation
 *
 * Tests for the `useDispatch` React hook. Verifies it routes messages
 * through the `update` function configured on the surrounding
 * `<CauslProvider>` and that misuse — missing update, missing
 * provider — produces clear runtime errors at render time.
 */

import { createCausl } from '@causljs/core'
import { act, render, screen } from '@testing-library/react'
import { type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import {
  createUpdate,
  CauslProvider,
  useDispatch,
  useCausl,
  type Update,
} from '../src/index.js'

/** Discriminated union exercising both nullary and payload-bearing messages. */
type Msg = { kind: 'inc' } | { kind: 'set'; value: number }

/**
 * Suite for the `useDispatch()` hook covering the happy path and the
 * two diagnostic error paths (no update configured, no provider).
 */
describe('useDispatch()', () => {
  /**
   * End-to-end: a click handler dispatches messages that flow through
   * the provider's `update`, mutate the graph, and trigger re-render
   * via `useCausl`.
   */
  it('dispatches a Msg through the configured update', () => {
    // Set up graph + counter input.
    const g = createCausl()
    const counter = g.input('counter', 0)
    // Build the update reducer used by the provider.
    const update: Update<Msg> = createUpdate<Msg>({
      inc: (_m, graph) => {
        graph.commit('inc', (tx) => tx.set(counter, graph.read(counter) + 1))
      },
      set: (m, graph) => {
        graph.commit('set', (tx) => tx.set(counter, m.value))
      },
    })

    /**
     * Test component — reads the counter via `useCausl` and emits
     * `{ kind: 'inc' }` on each click using `useDispatch`.
     */
    function View(): JSX.Element {
      const value = useCausl((graph) => graph.read(counter))
      const dispatch = useDispatch<Msg>()
      return (
        <button data-testid="b" onClick={() => dispatch({ kind: 'inc' })}>
          {value}
        </button>
      )
    }

    render(
      <CauslProvider graph={g} update={update}>
        <View />
      </CauslProvider>,
    )
    // Initial render reflects the input default.
    expect(screen.getByTestId('b').textContent).toBe('0')
    // Single click dispatches one increment.
    act(() => {
      screen.getByTestId('b').click()
    })
    expect(screen.getByTestId('b').textContent).toBe('1')
    // Two clicks within the same act() should both be applied.
    act(() => {
      screen.getByTestId('b').click()
      screen.getByTestId('b').click()
    })
    expect(screen.getByTestId('b').textContent).toBe('3')
  })

  /**
   * Confirms that calling `dispatch` against a provider that lacks an
   * `update` prop yields a descriptive runtime error instead of
   * silently no-oping.
   */
  it('throws when no update is configured on the Provider', () => {
    const g = createCausl()
    /**
     * Test component — calls `dispatch` during render so the resulting
     * throw propagates synchronously out of `render()`.
     */
    function View(): JSX.Element {
      const dispatch = useDispatch<Msg>()
      // Invoke dispatch during render so the throw propagates out of render().
      dispatch({ kind: 'inc' })
      return <span />
    }
    expect(() =>
      render(
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>,
      ),
    ).toThrowError(/no `update` function was supplied/)
  })

  /**
   * Confirms `useDispatch` raises a clear error message when invoked
   * outside any `<CauslProvider>` context, naming the offending hook.
   */
  it('throws a descriptive error when used outside a provider', () => {
    /**
     * Test component — the hook call itself throws, so the dispatcher
     * return value is never captured.
     */
    function View(): JSX.Element {
      // The hook itself throws on render; we don't need to capture the
      // returned dispatcher.
      useDispatch<Msg>()
      return <span />
    }
    // Expect render to surface the diagnostic from the hook.
    expect(() => render(<View />)).toThrowError(
      /useDispatch must be used inside <CauslProvider>/,
    )
  })
})
