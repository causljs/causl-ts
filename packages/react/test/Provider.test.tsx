/**
 * @packageDocumentation
 *
 * Tests for `<CauslProvider>` — the React component that publishes a
 * Causl graph onto context for descendant hooks and components. The
 * cases cover the basic plumbing: presence of context inside the
 * provider, absence outside, and isolation between sibling providers
 * each carrying a distinct graph instance.
 */

import { createCausl } from '@causl/core'
import { render, screen } from '@testing-library/react'
import { useContext, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslContext, CauslProvider } from '../src/index.js'

/**
 * Tiny consumer used as a probe for the surrounding context value. It
 * renders the graph's current revision (`graph.now`) when context is
 * present, or the literal `no-ctx` when used outside any provider.
 */
function GraphPeek(): JSX.Element {
  // Read the raw context directly to verify provider plumbing without
  // routing through the higher-level hooks.
  const ctx = useContext(CauslContext)
  return <div data-testid="now">{ctx ? String(ctx.graph.now) : 'no-ctx'}</div>
}

/**
 * Suite for the `<CauslProvider>` component covering context
 * publication, absence, and per-instance isolation semantics.
 */
describe('<CauslProvider>', () => {
  /**
   * Verifies a child component nested under `<CauslProvider>` can
   * see the provided graph through `CauslContext`.
   */
  it('makes the graph available to children via context', () => {
    // Fresh graph: revision starts at 0, which the probe will emit.
    const g = createCausl()
    render(
      <CauslProvider graph={g}>
        <GraphPeek />
      </CauslProvider>,
    )
    expect(screen.getByTestId('now').textContent).toBe('0')
  })

  /**
   * Confirms the default context value is undefined so consumers
   * rendered outside any provider can detect the absence and degrade.
   */
  it('children outside the provider see no context', () => {
    // No surrounding provider: the probe falls back to its sentinel.
    render(<GraphPeek />)
    expect(screen.getByTestId('now').textContent).toBe('no-ctx')
  })

  /**
   * Demonstrates that two adjacent providers expose independent graphs
   * to their respective subtrees, so committing to one does not bleed
   * into the other.
   */
  it('routes a different graph per provider instance', () => {
    const g1 = createCausl()
    const g2 = createCausl()
    // Bump g2's revision to 1 so the two probes report different
    // values and the cross-provider isolation is visible.
    g2.commit('bump', () => {
      /* noop */
    })
    render(
      <>
        <CauslProvider graph={g1}>
          <GraphPeek />
        </CauslProvider>
        <CauslProvider graph={g2}>
          <GraphPeek />
        </CauslProvider>
      </>,
    )
    // Probes appear in document order: g1 first (still at 0),
    // then g2 (advanced to 1 by the earlier commit).
    const cells = screen.getAllByTestId('now')
    expect(cells.map((c) => c.textContent)).toEqual(['0', '1'])
  })
})
