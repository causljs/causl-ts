/**
 * useCauslSuspense — Suspense projection of ResourceState (#127).
 *
 * Covers the four loaded/stale/errored/idle transitions and the
 * loading→suspended boundary, plus SPEC §9.1's identity-stable
 * Promise contract for the `loading` arm and the `idle` arm.
 */

import { createCausl, type Graph } from '@causl/core'
import { render, screen, waitFor } from '@testing-library/react'
import { Component, Suspense, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import {
  CauslProvider,
  useCauslSuspense,
  type SuspendableResource,
} from '../src/index.js'

class ErrorBoundary extends Component<
  { fallback: (e: unknown) => ReactNode; children: ReactNode },
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

describe('useCauslSuspense', () => {
  it('returns the value for `loaded` state', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loaded',
      value: 42,
      origin: 0,
      loadedAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(<View />, { wrapper: harness(g) })
    expect(screen.getByTestId('v').textContent).toBe('42')
  })

  it('returns the cached value for `stale` state (does not throw)', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'stale',
      value: 99,
      origin: 0,
      loadedAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(<View />, { wrapper: harness(g) })
    expect(screen.getByTestId('v').textContent).toBe('99')
  })

  it('throws to Suspense for `loading` state', () => {
    const g = createCausl()
    const promise = new Promise<number>(() => undefined)
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loading',
      origin: 0,
      promise,
    })
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
    expect(screen.getByTestId('loading')).toBeTruthy()
  })

  it('throws to error boundary for `errored` state', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'errored',
      error: new Error('boom'),
      origin: 0,
      erroredAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span>{v}</span>
    }
    render(
      <ErrorBoundary fallback={(e) => <span data-testid="err">{(e as Error).message}</span>}>
        <View />
      </ErrorBoundary>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('err').textContent).toBe('boom')
  })

  /**
   * `idle` is the documented "suspend, not error" contract (hook
   * header + SPEC §9.1). Pinning the previous `throw Error` was wrong;
   * this test now asserts the Suspense fallback wins and the error
   * boundary stays clean. The mirror of #228 in the integration suite
   * is the same assertion.
   */
  it('suspends for `idle` state (no error boundary trigger)', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', { state: 'idle' })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    render(
      <ErrorBoundary fallback={(e) => <span data-testid="err">{(e as Error).message}</span>}>
        <Suspense fallback={<span data-testid="loading">…</span>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
      { wrapper: harness(g) },
    )
    expect(screen.getByTestId('loading')).toBeTruthy()
    expect(screen.queryByTestId('err')).toBeNull()
    expect(screen.queryByTestId('v')).toBeNull()
  })

  /**
   * SPEC §9.1 — "Suspense fresh-Promise-per-render breaks SuspenseList /
   * `startTransition`". The fix is structural: `ResourceState.loading`
   * carries the Promise itself, so two reads at different graph times
   * during the same loading episode return the same Promise reference.
   * Two suspending children in one Suspense boundary throwing the same
   * Promise lets the renderer schedule a single re-attempt rather than
   * a chain of misaligned ones.
   */
  it('throws the engine-anchored Promise (identity-stable across renders) for `loading`', () => {
    const g = createCausl()
    const promise = new Promise<number>(() => undefined)
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loading',
      origin: 0,
      promise,
    })
    const thrown: unknown[] = []
    function View() {
      try {
        const v = useCauslSuspense((graph) => graph.read(r))
        return <span data-testid="v">{v}</span>
      } catch (x) {
        thrown.push(x)
        throw x
      }
    }
    render(
      <Suspense fallback={<span data-testid="loading">…</span>}>
        <View />
        <View />
      </Suspense>,
      { wrapper: harness(g) },
    )
    // Both renders threw the engine-anchored promise; identity must
    // match so React can dedup them.
    expect(thrown.length).toBeGreaterThanOrEqual(2)
    for (const t of thrown) expect(t).toBe(promise)
  })

  it('selector receives a narrowed capability — commit/input/derived throw CapabilityViolation (#229)', () => {
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', { state: 'loaded', value: 1, origin: 0, loadedAt: 0 })
    let captured: unknown
    function View() {
      const v = useCauslSuspense((cap) => {
        captured = cap
        return cap.read(r)
      })
      return <span data-testid="v">{v}</span>
    }
    render(<View />, { wrapper: harness(g) })
    expect(screen.getByTestId('v').textContent).toBe('1')
    const leaked = captured as Graph
    expect(() => leaked.commit('hack', () => undefined)).toThrow(/CapabilityViolation/)
    expect(() => leaked.input('x' as never, 1 as never)).toThrow(/CapabilityViolation/)
    expect(() => leaked.derived('y' as never, () => 1 as never)).toThrow(/CapabilityViolation/)
    expect(() => leaked.exportModel()).toThrow(/CapabilityViolation/)
  })

  it('transitions from loading to loaded as the resource state advances', async () => {
    const g = createCausl()
    let resolveFn = (_v: number) => undefined as void
    const promise = new Promise<number>((res) => {
      resolveFn = (v) => res(v)
    })
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loading',
      origin: 0,
      promise,
    })
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
    expect(screen.getByTestId('loading')).toBeTruthy()
    // Resolve the promise + commit the loaded state.
    resolveFn(7)
    g.commit('loaded', (tx) =>
      tx.set(r, { state: 'loaded', value: 7, origin: 0, loadedAt: 1 }),
    )
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('7'))
  })
})
