import { createCausl, type Commit, type GraphSnapshot } from '@causljs/core'
import { assertResultStability } from '@causljs/core/testing'
import { act, render, screen } from '@testing-library/react'
import React, { StrictMode, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { Hydrate, CauslProvider, useCausl } from '../src/index.js'

/**
 * Major version of the React runtime under test. The peer-dep matrix
 * (#261) runs the suite against React 18 *and* React 19; a couple of
 * tests are sensitive to React-18-specific StrictMode timing and need
 * a runtime gate to stay green on the React 19 leg.
 */
const REACT_MAJOR = Number((React.version ?? '0').split('.')[0])

// Helper: read an input from a graph by id, scoped under a given provider.
function ReadA(): JSX.Element {
  const v = useCausl((g) => g.read({ id: 'a' }))
  return <span data-testid="v">{String(v)}</span>
}

describe('<Hydrate snapshot={…}>', () => {
  it('applies the snapshot before children render', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const before = g.now
    const snapshot: GraphSnapshot = { schema: 1, time: 7, inputs: { a: 99 } }

    function View() {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={snapshot}>
          <View />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('99')
    // Post-#366: hydrate routes through the commit pipeline, advancing
    // `now` by exactly one tick (§3 monotonicity). The on-the-wire
    // snapshot label is preserved on the published Commit's
    // `originatedAt` field, not on the live graph's `now`.
    expect(g.now).toBe(before + 1)
  })

  it('hydrates exactly once across re-renders', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    function View() {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    const { rerender } = render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={{ schema: 1, time: 1, inputs: { a: 1 } }}>
          <View />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('1')
    // The user mutates the value AFTER hydration.
    g.commit('bump', (tx) => tx.set(a, 100))
    // Rerender with a different snapshot — the second render does NOT
    // re-hydrate (the WeakMap pair guard holds), so user's 100 stays.
    rerender(
      <CauslProvider graph={g}>
        <Hydrate snapshot={{ schema: 1, time: 99, inputs: { a: 999 } }}>
          <View />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('100')
  })

  it('throws when used outside a Provider', () => {
    const snapshot: GraphSnapshot = { schema: 1, time: 0, inputs: {} }
    function Doomed() {
      return (
        <Hydrate snapshot={snapshot}>
          <span>x</span>
        </Hydrate>
      )
    }
    expect(() => render(<Doomed />)).toThrow(/<Hydrate>/)
  })

  // ---- StrictMode + commit-log + result-stability coverage (#241, #219) ----
  //
  // These tests pin the observable contract of <Hydrate> independent
  // of its implementation channel. #219's structural fix moves the
  // mutation out of the render body into `useLayoutEffect` keyed by
  // graph identity, with a module-scoped `WeakMap<Graph, GraphSnapshot>`
  // tear-guard. The canary below was `it.fails` while the render-phase
  // mutation lived; #219 flips it to `it` because exactly one
  // `intent: 'hydrate'` commit reaches subscribers per provider mount.

  // The canary that #219 was filed against: under render-phase
  // mutation a `useRef(false)` got recreated on the StrictMode
  // remount and hydrate fired twice. Moving the work into
  // `useLayoutEffect` with a module-scoped `WeakMap<Graph,
  // GraphSnapshot>` tear-guard collapses both React 18 and React 19
  // StrictMode mount sequences to exactly one
  // `Commit { intent: 'hydrate' }` per provider mount. Now passes on
  // both peer-dep legs of the matrix (#261).
  it('StrictMode mount: emits exactly one Commit { intent: "hydrate" } per provider mount', () => {
    // SPEC §11 (commit-log uniformity): hydrate is a privileged commit and
    // every commit-log subscriber sees it exactly once. StrictMode's
    // double-invoke must not multiply the commit count.
    const g = createCausl()
    g.input('a', 0)
    const commits: Commit[] = []
    // Subscribe BEFORE mount so we capture the very first hydration.
    g.subscribeCommits((c) => {
      commits.push(c)
    })
    const snapshot: GraphSnapshot = { schema: 1, time: 5, inputs: { a: 42 } }

    function View() {
      const v = useCausl((graph) => graph.read({ id: 'a' }))
      return <span data-testid="v">{String(v)}</span>
    }
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <Hydrate snapshot={snapshot}>
            <View />
          </Hydrate>
        </CauslProvider>
      </StrictMode>,
    )
    expect(screen.getByTestId('v').textContent).toBe('42')
    const hydrateCommits = commits.filter((c) => c.intent === 'hydrate')
    expect(hydrateCommits).toHaveLength(1)
    // Post-#366: the commit's `time` is `prev.now + 1` (= 1 here, fresh
    // graph), not `snap.time`. The snapshot's recorded label is
    // preserved on `originatedAt`.
    expect(hydrateCommits[0]?.time).toBe(1)
    expect(hydrateCommits[0]?.originatedAt).toBe(5)
  })

  it('post-hydrate useSyncExternalStore snapshot is referentially stable', () => {
    // SPEC §12.4: getSnapshot must return a stable reference between
    // back-to-back calls with no intervening commit, otherwise React's
    // useSyncExternalStore enters a render loop. The
    // `assertResultStability` seam pins it.
    const g = createCausl()
    const a = g.input('a', 0)
    const snapshot: GraphSnapshot = { schema: 1, time: 3, inputs: { a: 7 } }

    function View() {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={snapshot}>
          <View />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('7')
    // After hydration, querying the engine via the same selector twice
    // must yield Object.is-equal results (no fresh ref churn).
    assertResultStability({
      getSnapshot: () => g.read(a),
    })
  })

  it('subscribeCommits observer under the provider sees the hydration commit', () => {
    // The consumer side of #184: a child component subscribing to
    // `g.subscribeCommits` must observe one `intent: 'hydrate'` per mount,
    // proving the engine-level emission propagates through the React tree.
    const g = createCausl()
    g.input('a', 0)
    const observed: Commit[] = []
    g.subscribeCommits((c) => {
      observed.push(c)
    })
    const snapshot: GraphSnapshot = { schema: 1, time: 11, inputs: { a: 99 } }

    function View() {
      const v = useCausl((graph) => graph.read({ id: 'a' }))
      return <span data-testid="v">{String(v)}</span>
    }
    render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={snapshot}>
          <View />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('99')
    const hydrates = observed.filter((c) => c.intent === 'hydrate')
    expect(hydrates).toHaveLength(1)
    expect(hydrates[0]?.changedNodes).toContain('a')
  })

  // ---- Per-graph keying contract (#246, subsumed by #219's WeakMap) ----
  //
  // The hydration guard must be keyed by the underlying graph identity,
  // not by React's per-component-instance ref. If a host swaps the
  // provider's graph while keeping the same `<Hydrate>` element in the
  // tree, the new graph must be hydrated. #219's module-scoped
  // `WeakMap<Graph, GraphSnapshot>` keys directly off graph identity,
  // so #324's per-instance `useRef<Graph|null>` is redundant — the
  // contract is enforced at the registry, not at the component.

  it('re-arms hydration when the provider graph swaps', () => {
    // SPEC §12.4: hydration runs once before any child subscribes — for
    // that graph. A fresh provider graph must restart that contract.
    const g1 = createCausl()
    g1.input('a', 0)
    const snapshot: GraphSnapshot = { schema: 1, time: 4, inputs: { a: 7 } }
    const { rerender } = render(
      <CauslProvider graph={g1}>
        <Hydrate snapshot={snapshot}>
          <ReadA />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('7')

    // Swap to a fresh graph with the same node id but different starting
    // value. The same `<Hydrate snapshot=…>` element must hydrate g2.
    const g2 = createCausl()
    g2.input('a', 0)
    rerender(
      <CauslProvider graph={g2}>
        <Hydrate snapshot={snapshot}>
          <ReadA />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('7')
    // Post-#366: `g2.now` advances by one tick from its pre-hydrate
    // value (0 on a fresh graph), not to `snap.time`.
    expect(g2.now).toBe(1)
  })

  it('snapshot-prop churn without graph swap is a no-op (documented)', () => {
    // Pin the contract: once a graph is hydrated for a given identity,
    // changing the `snapshot` prop is a no-op. Re-hydrating on prop
    // change would surprise callers passing useMemo-unstable snapshot
    // objects, and would also burn an extra GraphTime tick per
    // re-render. Post-#366 hydrate is monotonic on `now` (it routes
    // through the commit pipeline and advances by exactly one tick),
    // so re-hydrating on every prop change wouldn't drag time backward
    // — but it would inflate the commit log with redundant 'hydrate'
    // entries and waste subscriber dispatches.
    const g = createCausl()
    const a = g.input('a', 0)
    const { rerender } = render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={{ schema: 1, time: 1, inputs: { a: 1 } }}>
          <ReadA />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('1')

    // User commits after hydration. Wrap in act() so React processes
    // the external-store notification before we assert.
    act(() => {
      g.commit('user-edit', (tx) => tx.set(a, 100))
    })
    expect(screen.getByTestId('v').textContent).toBe('100')

    // Different snapshot, same graph — must be a no-op (user's 100 stays).
    rerender(
      <CauslProvider graph={g}>
        <Hydrate snapshot={{ schema: 1, time: 99, inputs: { a: 999 } }}>
          <ReadA />
        </Hydrate>
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('100')
    expect(g.now).toBe(2) // user-edit advanced from 1
  })
})
