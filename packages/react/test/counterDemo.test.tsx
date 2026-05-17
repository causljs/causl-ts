/**
 * @packageDocumentation
 *
 * Phase 2 acceptance demo — Counter. The smallest possible end-to-end
 * MVU app composed against `@causljs/react`: a single input, an
 * increment, a decrement, a reset, and a derived "doubled" view that
 * only re-renders when its slice actually changes. Lives as a test
 * rather than a `/demo/` subapp because the acceptance criterion is
 * simply "it runs"; a vitest run is the cheapest viable gate.
 */

import { createCausl, type Graph, type InputNode } from '@causljs/core'
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

/** Messages accepted by the counter demo's `Update`. */
type Msg = { kind: 'inc' } | { kind: 'dec' } | { kind: 'reset' }

/**
 * Build a self-contained counter demo: a fresh graph, the single
 * `counter` input node, and an `Update` table covering increment,
 * decrement, and reset transitions. Returned as a record so callers
 * can wire each piece into a provider plus consumer component.
 */
function buildCounterDemo(): {
  graph: Graph
  counter: InputNode<number>
  update: Update<Msg>
} {
  const graph = createCausl()
  // Single mutable input — the entire demo state.
  const counter = graph.input<number>('counter', 0)
  // Each Msg kind maps to a commit that advances the graph by one tick.
  const update: Update<Msg> = createUpdate<Msg>({
    inc: (_m, g) => {
      g.commit('inc', (tx) => tx.set(counter, g.read(counter) + 1))
    },
    dec: (_m, g) => {
      g.commit('dec', (tx) => tx.set(counter, g.read(counter) - 1))
    },
    reset: (_m, g) => {
      g.commit('reset', (tx) => tx.set(counter, 0))
    },
  })
  return { graph, counter, update }
}

/**
 * Demo component that surfaces the counter value, a derived doubled
 * value, and three buttons that dispatch the corresponding messages
 * back through the provider.
 */
function CounterApp({
  counter,
}: {
  counter: InputNode<number>
}): JSX.Element {
  // Two independent selector subscriptions — `doubled` derives at the
  // selector boundary so it only re-runs when `counter` changes.
  const value = useCausl((graph) => graph.read(counter))
  const doubled = useCausl((graph) => graph.read(counter) * 2)
  const dispatch = useDispatch<Msg>()
  return (
    <div>
      <span data-testid="value">{value}</span>
      <span data-testid="doubled">{doubled}</span>
      <button data-testid="inc" onClick={() => dispatch({ kind: 'inc' })}>
        +1
      </button>
      <button data-testid="dec" onClick={() => dispatch({ kind: 'dec' })}>
        -1
      </button>
      <button data-testid="reset" onClick={() => dispatch({ kind: 'reset' })}>
        reset
      </button>
    </div>
  )
}

/**
 * End-to-end tests of the Phase 2 Counter demo, exercising dispatch,
 * derivation, and provider isolation.
 */
describe('Phase 2 — Counter demo', () => {
  /**
   * Walks through a full session: initial render, single increment,
   * a batched click sequence, and a reset. Each step asserts both
   * the raw value and its doubled derivation refresh in lockstep.
   */
  it('starts at 0 and increments/decrements/resets via Msg dispatch', () => {
    const { graph, counter, update } = buildCounterDemo()
    render(
      <CauslProvider graph={graph} update={update}>
        <CounterApp counter={counter} />
      </CauslProvider>,
    )
    // Baseline: counter starts at 0; doubled mirrors that.
    expect(screen.getByTestId('value').textContent).toBe('0')
    expect(screen.getByTestId('doubled').textContent).toBe('0')

    // One increment dispatched through React's act wrapper.
    act(() => screen.getByTestId('inc').click())
    expect(screen.getByTestId('value').textContent).toBe('1')
    expect(screen.getByTestId('doubled').textContent).toBe('2')

    // Three dispatches in a single act — net effect should be +1.
    act(() => {
      screen.getByTestId('inc').click()
      screen.getByTestId('inc').click()
      screen.getByTestId('dec').click()
    })
    expect(screen.getByTestId('value').textContent).toBe('2')
    expect(screen.getByTestId('doubled').textContent).toBe('4')

    // Reset returns the input to 0 and propagates to the derivation.
    act(() => screen.getByTestId('reset').click())
    expect(screen.getByTestId('value').textContent).toBe('0')
    expect(screen.getByTestId('doubled').textContent).toBe('0')
  })

  /**
   * Verifies that two `<CauslProvider>` siblings each holding a
   * distinct graph stay isolated: clicking the left counter must not
   * bleed into the right counter's state.
   */
  it('two adjacent counters with separate graphs increment independently', () => {
    const left = buildCounterDemo()
    const right = buildCounterDemo()
    // Mount two independent providers side by side.
    render(
      <>
        <CauslProvider graph={left.graph} update={left.update}>
          <div data-testid="left">
            <CounterApp counter={left.counter} />
          </div>
        </CauslProvider>
        <CauslProvider graph={right.graph} update={right.update}>
          <div data-testid="right">
            <CounterApp counter={right.counter} />
          </div>
        </CauslProvider>
      </>,
    )
    // Increment only the left counter.
    const leftSection = screen.getByTestId('left')
    act(() => leftSection.querySelector<HTMLButtonElement>('[data-testid="inc"]')!.click())
    const rightSection = screen.getByTestId('right')
    // Left advanced to 1; right must remain at its initial 0.
    expect(leftSection.querySelector('[data-testid="value"]')!.textContent).toBe('1')
    expect(rightSection.querySelector('[data-testid="value"]')!.textContent).toBe('0')
  })
})
