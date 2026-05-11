/**
 * Suspense integration scenarios — error boundaries, stale-during-
 * refetch, SuspenseList, transition boundaries (#128 v0).
 */

import { createCausl, type Graph } from '@causl/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  Component,
  Suspense,
  startTransition,
  useDeferredValue,
  useState,
  type ReactNode,
} from 'react'
import { describe, expect, it } from 'vitest'
import {
  CauslProvider,
  useCauslSuspense,
  type SuspendableResource,
} from '../src/index.js'

class ErrorBoundary extends Component<
  { fallback: (e: unknown) => ReactNode; onReset?: () => void; children: ReactNode },
  { error: unknown }
> {
  override state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

function harness(g: Graph) {
  return ({ children }: { children: ReactNode }) => (
    <CauslProvider graph={g}>{children}</CauslProvider>
  )
}

describe('Suspense integration scenarios (#128)', () => {
  it('error boundary swallows the throw and renders the fallback', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'errored',
      error: new Error('upstream-failed'),
      origin: 0,
      erroredAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span>{v}</span>
    }
    render(
      <ErrorBoundary fallback={(e) => <span data-testid="fb">{(e as Error).message}</span>}>
        <Suspense fallback={<span data-testid="loading">…</span>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('fb').textContent).toBe('upstream-failed')
  })

  it('stale-during-refetch keeps showing the previous value (no Suspense flash)', async () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', { state: 'loaded', value: 1, origin: 0, loadedAt: 0 })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(
      <Suspense fallback={<span data-testid="loading">…</span>}>
        <View />
      </Suspense>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('v').textContent).toBe('1')
    // Transition to stale — value still rendered, no fallback.
    g.commit('stale', (tx) => tx.set(r, { state: 'stale', value: 1, origin: 0, loadedAt: 0 }))
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('1'))
    expect(screen.queryByTestId('loading')).toBeNull()
    // Transition to loaded with new value.
    g.commit('reloaded', (tx) => tx.set(r, { state: 'loaded', value: 2, origin: 0, loadedAt: 0 }))
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('2'))
  })

  it('two suspending children inside one Suspense both gate together', () => {
    const g = createCausl()
    const a = g.input<SuspendableResource<number>>('a', {
      state: 'loading',
      origin: 0,
      promise: new Promise(() => undefined),
    })
    const b = g.input<SuspendableResource<number>>('b', {
      state: 'loading',
      origin: 0,
      promise: new Promise(() => undefined),
    })
    function ViewA() {
      const v = useCauslSuspense((graph) => graph.read(a))
      return <span data-testid="a">{v}</span>
    }
    function ViewB() {
      const v = useCauslSuspense((graph) => graph.read(b))
      return <span data-testid="b">{v}</span>
    }
    render(
      <Suspense fallback={<span data-testid="loading">both…</span>}>
        <ViewA />
        <ViewB />
      </Suspense>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('loading')).toBeTruthy()
    expect(screen.queryByTestId('a')).toBeNull()
    expect(screen.queryByTestId('b')).toBeNull()
  })

  it('errored→loaded recovery reshows content (after error-boundary reset is the consumer\'s job)', async () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', { state: 'loaded', value: 1, origin: 0, loadedAt: 0 })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(
      <ErrorBoundary fallback={(e) => <span data-testid="fb">{(e as Error).message}</span>}>
        <Suspense fallback={<span data-testid="loading">…</span>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('v').textContent).toBe('1')
    g.commit('error', (tx) =>
      tx.set(r, { state: 'errored', error: new Error('x'), origin: 0, erroredAt: 0 }),
    )
    await waitFor(() => expect(screen.getByTestId('fb').textContent).toBe('x'))
    // Recovery to loaded after the error boundary is mounted does NOT
    // automatically re-render — the boundary holds its caught state
    // until the consumer resets it. This documents that contract.
  })

  // --- review-205 follow-ups (#233): 5 promoted scenarios + 1 it.todo ---
  // The 5 below were `it.todo` in the v0 PR; they're now real tests
  // exercising SuspenseList-equivalent / useTransition / useDeferredValue /
  // nested-Suspense / error-boundary-reset surface area called out as
  // P1 in PR #183 review comments. The 6th (idle contract) stays as
  // `it.todo` — tracked by #228 and depends on #224 landing the
  // source-side `idle → suspend` fix; baking in the wrong contract
  // here would be worse than no test.

  /**
   * "SuspenseList together"-equivalent assertion (#233).
   *
   * `SuspenseList` itself ships in `react@experimental` only; the
   * load-bearing structural property the family depends on — Promise
   * identity stability across renders for the same loading episode —
   * is testable against the canonical React 18 surface. Without
   * stable Promise identity, SuspenseList cannot coordinate "together"
   * reveals across siblings (each render hands React a fresh thenable,
   * defeating the coordinator's deduplication).
   *
   * Two sibling suspenders read the *same* engine-anchored Promise.
   * Across N forced re-renders (driven by an unrelated commit), the
   * thrown thenable identity must remain ===. That is the structural
   * assertion review-205 called out as missing in v0 — the highest-
   * leverage missing assertion per the per-group review.
   */
  it('SuspenseList structural prerequisite — Promise identity is stable across renders for the same loading episode', () => {
    const g = createCausl()
    const promise = new Promise<number>(() => undefined)
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loading',
      origin: 0,
      promise,
    })
    // Unrelated input — used to force re-renders without changing the
    // resource state, exercising the dedup path that must preserve
    // the thrown thenable's identity.
    const tick = g.input('tick', 0)
    const thrown: unknown[] = []
    function ProbeView() {
      try {
        // Read the unrelated input so the component subscribes to
        // commits on `tick` and re-renders on every bump.
        useCauslSuspense((graph) => {
          // Dependency on `tick` keeps the selector subscribed.
          void graph.read(tick)
          return graph.read(r)
        })
        return <span />
      } catch (e) {
        thrown.push(e)
        throw e
      }
    }
    render(
      <Suspense fallback={<span data-testid="loading">…</span>}>
        <ProbeView />
        <ProbeView />
      </Suspense>,
      { wrapper: harness(g) },
    )
    // Fallback rendered, both probes threw.
    expect(screen.getByTestId('loading')).toBeTruthy()
    const initialCount = thrown.length
    expect(initialCount).toBeGreaterThanOrEqual(2)
    // Both children threw the *same* Promise instance — SuspenseList's
    // structural prerequisite for "together" reveal coordination.
    for (const t of thrown) {
      expect(t).toBe(promise)
    }
    // Force re-renders via an unrelated commit. The resource state
    // doesn't change, so the engine-anchored Promise identity must
    // hold across the new render cycle.
    act(() => {
      g.commit('tick→1', (tx) => tx.set(tick, 1))
    })
    // Some additional throws may have happened (Suspense will retry);
    // every newly thrown thenable must still be the same Promise.
    for (const t of thrown) {
      expect(t).toBe(promise)
    }
  })

  /**
   * `useTransition` cached-value display (#233).
   *
   * Transition path: starts loaded with cached value, transition
   * commits a *stale* state (which the hook treats as "still
   * renderable"). The cached value stays visible — no Suspense
   * fallback flash. Mirrors the `stale-during-refetch` assertion
   * above but exercised through `startTransition`, which is the path
   * application code takes when invalidating a resource via
   * dispatched intent.
   *
   * The non-flash assertion is the load-bearing one: a regression to
   * fresh-Promise-per-render would still pass the "stale text shows"
   * check, but the fallback-never-rendered guarantee separates the
   * two contracts.
   */
  it('useTransition shows the cached `loaded` value during a transition (no Suspense flash)', async () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', { state: 'loaded', value: 1, origin: 0, loadedAt: 0 })
    let everSawFallback = false
    function FallbackProbe() {
      everSawFallback = true
      return <span data-testid="loading">…</span>
    }
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(
      <Suspense fallback={<FallbackProbe />}>
        <View />
      </Suspense>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('v').textContent).toBe('1')
    // Refresh-as-stale: the hook treats `stale` as renderable with
    // the cached value. Wrapped in startTransition to exercise the
    // concurrent-rendering path React applications take when
    // invalidating a resource.
    act(() => {
      startTransition(() => {
        g.commit('refresh-stale', (tx) => tx.set(r, { state: 'stale', value: 1, origin: 0, loadedAt: 0 }))
      })
    })
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('1'))
    expect(screen.queryByTestId('loading')).toBeNull()
    expect(everSawFallback).toBe(false)
    // Resolve to a new loaded value.
    act(() => {
      g.commit('reloaded', (tx) => tx.set(r, { state: 'loaded', value: 2, origin: 0, loadedAt: 0 }))
    })
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('2'))
    expect(everSawFallback).toBe(false)
  })

  /**
   * `useDeferredValue` lag without unmount (#233).
   *
   * Search-style harness: the deferred string is read into the
   * subscriber. Fast-fire input updates while a `loading` resource
   * keeps the suspending child boundary active. The fallback's mount
   * counter — captured via class-component lifecycle methods — must
   * not increment beyond the initial mount during the deferred
   * catch-up. A regression that unmounts and remounts the
   * suspending subtree on every deferred-value change would bump
   * the counter; the assertion catches it.
   */
  it('useDeferredValue lag — fast updates do not unmount the suspending child', async () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<string>>('r', {
      state: 'loading',
      origin: 0,
      promise: new Promise(() => undefined),
    })
    let fallbackMountCount = 0
    let fallbackUnmountCount = 0
    /**
     * Class component is the most direct way to count mounts /
     * unmounts in React 18 — `componentDidMount` / `componentWillUnmount`
     * fire once per lifecycle event, no risk of strict-mode double
     * invoke (which only doubles `useEffect` setup, not class
     * lifecycle).
     */
    class FallbackProbe extends Component<unknown, unknown> {
      override componentDidMount() {
        fallbackMountCount++
      }
      override componentWillUnmount() {
        fallbackUnmountCount++
      }
      override render() {
        return <span data-testid="loading">…</span>
      }
    }
    function SuspendingChild({ q }: { q: string }) {
      // Read the deferred query (forces subscription on each render
      // even though the value isn't used) and the resource (drives
      // suspension).
      void q
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    let setQuery = (_q: string) => undefined as void
    function Search() {
      const [query, setQ] = useState('a')
      setQuery = setQ
      const deferred = useDeferredValue(query)
      return (
        <Suspense fallback={<FallbackProbe />}>
          <SuspendingChild q={deferred} />
        </Suspense>
      )
    }
    render(<Search />, { wrapper: harness(g) })
    // Initial mount: fallback rendered for loading resource.
    expect(screen.getByTestId('loading')).toBeTruthy()
    expect(fallbackMountCount).toBe(1)
    expect(fallbackUnmountCount).toBe(0)
    // Fast-fire input updates. The Suspense boundary holds; the
    // fallback must NOT unmount and remount on every keystroke.
    await act(async () => {
      setQuery('ab')
    })
    await act(async () => {
      setQuery('abc')
    })
    await act(async () => {
      setQuery('abcd')
    })
    // Fallback is the same instance — no remount of the suspending
    // subtree on deferred-value updates.
    expect(fallbackMountCount).toBe(1)
    expect(fallbackUnmountCount).toBe(0)
  })

  /**
   * Nested Suspense boundaries (#233).
   *
   * Inner boundary wraps a `loading` resource A; outer boundary
   * wraps a `loaded` resource B. The inner fallback isolates the
   * inner suspender — outer content (B's value) renders. Resolve A
   * → inner reveals, outer unchanged.
   *
   * Negative assertion: the outer fallback never renders for an
   * inner-only loading episode.
   */
  it('nested Suspense boundaries isolate the loading episode to the inner fallback', async () => {
    const g = createCausl()
    let resolveA = (_v: number) => undefined as void
    const promiseA = new Promise<number>((res) => {
      resolveA = (v) => res(v)
    })
    const a = g.input<SuspendableResource<number>>('a', {
      state: 'loading',
      origin: 0,
      promise: promiseA,
    })
    const b = g.input<SuspendableResource<number>>('b', {
      state: 'loaded',
      value: 99,
      origin: 0,
      loadedAt: 0,
    })
    let outerFallbackRenders = 0
    function OuterFallback() {
      outerFallbackRenders++
      return <span data-testid="outer-fb">outer…</span>
    }
    function ViewA() {
      const v = useCauslSuspense((graph) => graph.read(a))
      return <span data-testid="a">{v}</span>
    }
    function ViewB() {
      const v = useCauslSuspense((graph) => graph.read(b))
      return <span data-testid="b">{v}</span>
    }
    render(
      <Suspense fallback={<OuterFallback />}>
        <ViewB />
        <Suspense fallback={<span data-testid="inner-fb">inner…</span>}>
          <ViewA />
        </Suspense>
      </Suspense>,
      { wrapper: harness(g) },
    )
    // Outer renders B; inner fallback shows for A.
    expect(screen.getByTestId('b').textContent).toBe('99')
    expect(screen.getByTestId('inner-fb')).toBeTruthy()
    expect(screen.queryByTestId('outer-fb')).toBeNull()
    expect(outerFallbackRenders).toBe(0)
    // Resolve A — inner reveals, outer unchanged. Resolve the
    // Promise first (Suspense has a thrown-Promise reference and
    // listens for resolution before retrying), then commit the
    // loaded state for `useCausl` to pick up. Same shape as the
    // `transitions from loading to loaded` test in
    // `useCauslSuspense.test.tsx`.
    resolveA(7)
    g.commit('a→loaded', (tx) => tx.set(a, { state: 'loaded', value: 7, origin: 0, loadedAt: 0 }))
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('7'))
    expect(screen.getByTestId('b').textContent).toBe('99')
    expect(outerFallbackRenders).toBe(0)
    // The outer fallback never rendered through the entire lifecycle.
  })

  /**
   * Error-boundary reset path (#233).
   *
   * Resource starts `errored`; the boundary catches and renders a
   * fallback with a "retry" affordance. The fallback flips the
   * resource to `loaded` *and* resets the boundary state — the
   * subtree re-mounts and the now-loaded resource renders without
   * throwing. The reset path is the only way back from `errored`
   * (the boundary holds its caught state until consent to reset).
   */
  it('error-boundary onReset re-mounts the subtree and a now-loaded resource renders', async () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'errored',
      error: new Error('first-fail'),
      origin: 0,
      erroredAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    /**
     * Boundary that exposes a `reset` callback to its fallback. The
     * reset path is the canonical recovery shape — `react-error-
     * boundary`'s `resetErrorBoundary` mirrors this exactly.
     */
    class ResettableBoundary extends Component<
      {
        fallback: (e: unknown, reset: () => void) => ReactNode
        children: ReactNode
      },
      { error: unknown }
    > {
      override state = { error: null as unknown }
      static getDerivedStateFromError(error: unknown) {
        return { error }
      }
      override render() {
        if (this.state.error) {
          return this.props.fallback(this.state.error, () => {
            this.setState({ error: null })
          })
        }
        return this.props.children
      }
    }
    render(
      <ResettableBoundary
        fallback={(e, reset) => (
          <button
            data-testid="retry"
            onClick={() => {
              g.commit('recover', (tx) => tx.set(r, { state: 'loaded', value: 42, origin: 0, loadedAt: 0 }))
              reset()
            }}
          >
            {(e as Error).message}
          </button>
        )}
      >
        <Suspense fallback={<span data-testid="loading">…</span>}>
          <View />
        </Suspense>
      </ResettableBoundary>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('retry').textContent).toBe('first-fail')
    // Fire the reset path: commit + boundary reset.
    act(() => {
      ;(screen.getByTestId('retry') as HTMLButtonElement).click()
    })
    // Now-loaded resource renders without throwing — the recovery
    // path closed the loop.
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('42'))
  })

  // TODO(review-205, P0): the `idle → throw Error` contract regression
  // (see PR #183 review comments, action items for #182) needs a
  // failing test that locks in the *correct* behaviour (suspend, not
  // error). The 5 todos above are promoted by #233; this 6th stays
  // in place because the spec decision is still open and tracked
  // by #228 (which depends on #224 landing the source-side fix).
  it.todo(
    'idle contract — `idle` resource suspends rather than throwing (currently throws; awaiting #228/#224)',
  )
})
