/**
 * @packageDocumentation
 *
 * Phase 2 acceptance demo — Calculator. A 3-input + 4-derivation
 * diamond rendered in React. The suite exercises multiple inputs and
 * a chain of derived nodes (a, b, c -> sum, ab, ac, total), selector
 * deduplication at the React boundary so unrelated inputs do not
 * trigger spurious re-renders, and dispatch routing through
 * `useDispatch` driven by a single `set` message kind.
 */

import { createCausl, type Graph, type InputNode } from '@causljs/core'
import { act, render, screen } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import {
  createUpdate,
  CauslProvider,
  useDispatch,
  useCausl,
  type Update,
} from '../src/index.js'

/** Single message kind: assign one of the three named inputs. */
type Msg = { kind: 'set'; key: 'a' | 'b' | 'c'; value: number }

/** Bundle returned by {@link buildCalc} containing the graph, named inputs, and the update table. */
interface CalcGraph {
  graph: Graph
  inputs: { a: InputNode<number>; b: InputNode<number>; c: InputNode<number> }
  update: Update<Msg>
}

/**
 * Construct the calculator's graph: three numeric inputs `a`, `b`,
 * `c`, three first-tier derivations (`sum = a + b`, `ab = a * b`,
 * `ac = a * c`), and a `total = sum + ab + ac` aggregate fanned in
 * from the first tier. Pairs the graph with an `Update` that handles
 * the lone `set` message kind by committing a single input write.
 */
function buildCalc(): CalcGraph {
  const graph = createCausl()
  // Three independent inputs forming the top of the diamond.
  const a = graph.input<number>('a', 0)
  const b = graph.input<number>('b', 0)
  const c = graph.input<number>('c', 0)
  // First tier of derivations — each depends on a subset of inputs.
  graph.derived<number>('sum', (get) => get(a) + get(b))
  graph.derived<number>('ab', (get) => get(a) * get(b))
  graph.derived<number>('ac', (get) => get(a) * get(c))
  // Aggregate node fanning in all three first-tier derivations.
  graph.derived<number>('total', (get) =>
    get<number>({ id: 'sum' }) +
    get<number>({ id: 'ab' }) +
    get<number>({ id: 'ac' }),
  )
  const inputs = { a, b, c }
  // Single message kind keeps the update table tiny; the key field
  // selects which input node to assign.
  const update: Update<Msg> = createUpdate<Msg>({
    set: (m, g) => {
      g.commit(`set ${m.key}=${m.value}`, (tx) => tx.set(inputs[m.key], m.value))
    },
  })
  return { graph, inputs, update }
}

/**
 * Calculator view component. Renders the live values of every input
 * and the aggregate `total`, exposes a render counter for diagnostic
 * purposes, and provides three buttons that each dispatch a fixed
 * `set` message.
 */
function CalcView({ inputs }: { inputs: CalcGraph['inputs'] }): JSX.Element {
  // Render counter — increments on every commit/render pass and is
  // surfaced in the DOM for assertions about render frequency.
  const renderRef = useRef(0)
  renderRef.current += 1
  // One subscription per input plus one for the aggregate; selectors
  // are kept narrow so unrelated changes do not force re-renders.
  const a = useCausl((g) => g.read(inputs.a))
  const b = useCausl((g) => g.read(inputs.b))
  const c = useCausl((g) => g.read(inputs.c))
  const total = useCausl((g) =>
    g.read<number>({ id: 'total' }),
  )
  const dispatch = useDispatch<Msg>()
  return (
    <div>
      <span data-testid="a">{a}</span>
      <span data-testid="b">{b}</span>
      <span data-testid="c">{c}</span>
      <span data-testid="total">{total}</span>
      <span data-testid="renders">{renderRef.current}</span>
      <button
        data-testid="set-a-3"
        onClick={() => dispatch({ kind: 'set', key: 'a', value: 3 })}
      />
      <button
        data-testid="set-b-5"
        onClick={() => dispatch({ kind: 'set', key: 'b', value: 5 })}
      />
      <button
        data-testid="set-c-7"
        onClick={() => dispatch({ kind: 'set', key: 'c', value: 7 })}
      />
    </div>
  )
}

/**
 * End-to-end test for the Phase 2 Calculator demo. Verifies the
 * diamond derivation aggregates correctly across successive dispatch
 * events.
 */
describe('Phase 2 — Calculator demo', () => {
  /**
   * Drives the demo through three dispatches and asserts the
   * `total` derivation tracks the expected algebra at each step:
   * `total = (a + b) + (a * b) + (a * c)`.
   */
  it('total = (a+b) + (a*b) + (a*c) and refreshes per dispatch', () => {
    const calc = buildCalc()
    render(
      <CauslProvider graph={calc.graph} update={calc.update}>
        <CalcView inputs={calc.inputs} />
      </CauslProvider>,
    )
    // Initial state: every input is 0, so total is 0.
    expect(screen.getByTestId('total').textContent).toBe('0')
    act(() => screen.getByTestId('set-a-3').click())
    // a=3, b=0, c=0 -> total = 3 + 0 + 0 = 3
    expect(screen.getByTestId('total').textContent).toBe('3')
    act(() => screen.getByTestId('set-b-5').click())
    // a=3, b=5, c=0 -> total = 8 + 15 + 0 = 23
    expect(screen.getByTestId('total').textContent).toBe('23')
    act(() => screen.getByTestId('set-c-7').click())
    // a=3, b=5, c=7 -> total = 8 + 15 + 21 = 44
    expect(screen.getByTestId('total').textContent).toBe('44')
  })
})
