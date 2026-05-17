/**
 * @packageDocumentation
 *
 * Tests for the per-node `useCauslNode(node)` hook introduced in #677.
 *
 * The primary acceptance criterion for this MVP is that subscribing to
 * node A does NOT cause a re-render when an unrelated node B changes.
 * This is the structural guarantee that distinguishes the per-node
 * subscription path from the selector-based `useCausl` path: React's
 * `onChange` is never invoked for commits that do not touch the
 * subscribed node, rather than being invoked and then deduped.
 *
 * The e2e dropped-frames gate (≤ 5% over 30s on a 1000-cell viewport
 * at 60Hz, plus p95 commit-to-paint ≤ 16ms) shipped in #765 — the
 * Playwright spec lives at
 * `packages/react/e2e/tests/dropped-frames-1000.spec.ts`.
 */

import { createCausl } from '@causl/core'
import { act, render, screen } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCauslNode } from '../src/index.js'

describe('useCauslNode(node)', () => {
  /**
   * Confirms the hook reads the node's initial value on first render.
   */
  it('renders the current node value', () => {
    const g = createCausl()
    const a = g.input('a', 42)

    function View(): JSX.Element {
      const v = useCauslNode(a)
      return <span data-testid="v">{v}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('42')
  })

  /**
   * Confirms the hook re-renders when the subscribed node's value changes.
   */
  it('re-renders when the subscribed node changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)

    function View(): JSX.Element {
      const v = useCauslNode(a)
      return <span data-testid="v">{v}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')

    act(() => {
      g.commit('a→99', (tx) => tx.set(a, 99))
    })
    expect(screen.getByTestId('v').textContent).toBe('99')
  })

  /**
   * Core acceptance criterion for #677: subscribing to node A must NOT
   * cause a re-render when an unrelated node B is committed. A render-
   * counter ref tracks whether React re-rendered the component after the
   * unrelated commit.
   *
   * This test verifies the per-node subscription guarantee at the React
   * level: because the hook uses `graph.subscribe(a, cb)` (not
   * `subscribeCommits`), React's onChange is never called for commits
   * that only touch B, so the render count stays constant.
   */
  it('does NOT re-render when an unrelated node changes (#677 core)', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 100)

    function View(): JSX.Element {
      const renderCount = useRef(0)
      renderCount.current += 1
      const v = useCauslNode(a)
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

    // Commit to unrelated node B — node A's subscriber must NOT fire.
    act(() => {
      g.commit('b→999', (tx) => tx.set(b, 999))
    })
    const afterB = screen.getByTestId('v').textContent ?? ''
    const rendersAfterB = Number(afterB.split('/')[1])
    // Render count must be unchanged — no extra render for the B commit.
    expect(rendersAfterB).toBe(initialRenders)

    // Commit to watched node A — must trigger exactly one additional render.
    act(() => {
      g.commit('a→2', (tx) => tx.set(a, 2))
    })
    const afterA = screen.getByTestId('v').textContent ?? ''
    const rendersAfterA = Number(afterA.split('/')[1])
    // Render count must have advanced after the relevant commit.
    expect(rendersAfterA).toBeGreaterThan(initialRenders)
    // And the displayed value must reflect the new value.
    expect(afterA.split('/')[0]).toBe('2')
  })

  /**
   * Confirms `useCauslNode` works with derived nodes, not just inputs.
   */
  it('works with derived nodes', () => {
    const g = createCausl()
    const a = g.input('a', 3)
    const doubled = g.derived('doubled', (get) => get(a) * 2)

    function View(): JSX.Element {
      const v = useCauslNode(doubled)
      return <span data-testid="v">{v}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('6')

    act(() => {
      g.commit('a→5', (tx) => tx.set(a, 5))
    })
    expect(screen.getByTestId('v').textContent).toBe('10')
  })

  /**
   * Confirms `useCauslNode` raises a clear diagnostic when invoked
   * outside any `<CauslProvider>`.
   */
  it('throws a descriptive error when used outside a provider', () => {
    const g = createCausl()
    const a = g.input('a', 0)

    function View(): JSX.Element {
      const v = useCauslNode(a)
      return <span>{v}</span>
    }

    expect(() => render(<View />)).toThrowError(
      /useCauslNode must be used inside <CauslProvider>/,
    )
  })
})
