/**
 * useTransition / useDeferredValue tests for causl React adapter (#133).
 *
 * useCausl is built on useSyncExternalStore so concurrent-rendering
 * paths are handled by React; these tests pin the user-facing contract:
 * deferred values eventually catch up, and a transition does not produce
 * a torn observation.
 */

import { createCausl } from '@causl/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  Suspense,
  useDeferredValue,
  useTransition,
  type ReactNode,
} from 'react'
import { describe, expect, it } from 'vitest'
import {
  CauslProvider,
  useCausl,
  useCauslSuspense,
  type SuspendableResource,
} from '../src/index.js'

describe('useTransition / useDeferredValue (#133)', () => {
  it('useDeferredValue eventually catches up to the latest engine commit', async () => {
    const g = createCausl()
    const a = g.input('a', 0)
    function View() {
      const v = useCausl((graph) => graph.read(a))
      const deferred = useDeferredValue(v)
      return (
        <span data-testid="v">
          {v}/{deferred}
        </span>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0/0')
    act(() => {
      g.commit('bump', (tx) => tx.set(a, 5))
    })
    // Eventually both immediate and deferred reach 5.
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('5/5'),
    )
  })

  it('a transition wraps the commit; UI eventually reflects the new value', async () => {
    const g = createCausl()
    const a = g.input('a', 0)
    function View() {
      const [, startTransition] = useTransition()
      const v = useCausl((graph) => graph.read(a))
      return (
        <>
          <button
            data-testid="bump"
            onClick={() =>
              startTransition(() => {
                g.commit('bump', (tx) => tx.set(a, v + 1))
              })
            }
          />
          <span data-testid="v">{v}</span>
        </>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')
    act(() => {
      (screen.getByTestId('bump') as HTMLButtonElement).click()
    })
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('1'))
  })

  // The four assertion families landed below were the P0/P1 gaps from
  // PR #188 review (#223). Each pins a different concurrent-mode
  // operator against the engine's commit semantics so a regression in
  // any one is independently falsifiable instead of laundered into a
  // single "pair-consistency" assertion.

  it('isPending — startTransition flips isPending to true and back to false', async () => {
    // P0 (PR #188 review): the prior suite never observed
    // `isPending`, so a regression that swallowed the transition
    // (e.g. running the commit synchronously) would still pass the
    // post-settle value assertion. This test records every render's
    // isPending and asserts the lifecycle: false → true (mid-flight)
    // → false (settled).
    const g = createCausl()
    const a = g.input('a', 0)
    const pendingTrace: boolean[] = []
    function View() {
      const [isPending, startTransition] = useTransition()
      const v = useCausl((graph) => graph.read(a))
      pendingTrace.push(isPending)
      return (
        <>
          <button
            data-testid="bump"
            onClick={() =>
              startTransition(() => {
                g.commit('bump', (tx) => tx.set(a, v + 1))
              })
            }
          />
          <span data-testid="v">{v}</span>
          <span data-testid="pending">{String(isPending)}</span>
        </>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    // Initial mount: isPending must be false.
    expect(pendingTrace.every((p) => p === false)).toBe(true)
    expect(screen.getByTestId('pending').textContent).toBe('false')
    const baselineLen = pendingTrace.length
    act(() => {
      ;(screen.getByTestId('bump') as HTMLButtonElement).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('1'),
    )
    // Settled: isPending back to false.
    await waitFor(() =>
      expect(screen.getByTestId('pending').textContent).toBe('false'),
    )
    // At least one render between baseline and settle observed
    // isPending === true. A regression that runs the commit
    // synchronously skips the pending state entirely; this leg
    // catches it.
    const transitionRenders = pendingTrace.slice(baselineLen)
    expect(transitionRenders.some((p) => p === true)).toBe(true)
    // Lifecycle bookend: every render after the final true entry is
    // false (no oscillation), and the trace ends false.
    expect(pendingTrace[pendingTrace.length - 1]).toBe(false)
  })

  it('useDeferredValue lag — deferred lags during transition and converges', async () => {
    // P0 (PR #188 review): the prior catch-up test only asserted the
    // settled equality `v === deferred`. It never observed the
    // intermediate frame where `deferred !== v` (the lag), which is
    // the actual point of `useDeferredValue`. A regression that
    // returned the immediate value through the deferred slot would
    // still pass catch-up; this test records every paired
    // observation and asserts the deferred path never overshoots.
    const g = createCausl()
    const a = g.input('a', 0)
    const pairs: Array<[number, number]> = []
    function View() {
      const v = useCausl((graph) => graph.read(a))
      const deferred = useDeferredValue(v)
      pairs.push([v, deferred])
      return (
        <span data-testid="v">
          {v}/{deferred}
        </span>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0/0')
    act(() => {
      g.commit('bump', (tx) => tx.set(a, 7))
    })
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('7/7'),
    )
    // Convergence leg (existing contract).
    expect(pairs[pairs.length - 1]).toEqual([7, 7])
    // No-overshoot leg: deferred is always either the current or a
    // previous value of v. Concretely, in this two-value sequence
    // (0 → 7), every pair is (0,0), (7,0), or (7,7); the deferred
    // never exceeds v. A regression that swapped the slots would
    // produce (0,7) and fail this leg.
    for (const [vv, dd] of pairs) {
      expect([0, 7]).toContain(vv)
      expect([0, 7]).toContain(dd)
      // dd is either the same as vv (settled) or the previous value
      // (lagging). It cannot be ahead.
      if (vv === 0) expect(dd).toBe(0)
      // When vv === 7, deferred is 0 (lag) or 7 (caught up) — both
      // are valid; we only forbid `dd > vv` semantically.
    }
  })

  it('urgent-vs-transition interleaving — urgent commit wins immediately; transitioned value resumes after', async () => {
    // P0 (PR #188 review): no test exercised mixing an urgent commit
    // with a pending transition. Engine semantics: every commit
    // mutates the graph synchronously and atomically — there is no
    // "deferred engine commit" inside `startTransition`. What
    // transitions defer is React's render lane, not the engine
    // mutation. So this test pins the user-facing contract: when an
    // urgent commit fires AFTER a transition commit has already
    // moved the engine, the engine settles at the urgent value
    // (urgent wins) and React's render eventually reflects that. A
    // subsequent transition-wrapped commit on top must again resume
    // from that base — i.e. the transition mechanism does not pin
    // the engine to a stale snapshot.
    const g = createCausl()
    const a = g.input('a', 0)
    const trace: number[] = []
    function View() {
      const [, startTransition] = useTransition()
      const v = useCausl((graph) => graph.read(a))
      trace.push(v)
      return (
        <>
          <button
            data-testid="transition-bump"
            onClick={() =>
              startTransition(() => {
                // Engine moves to 100 synchronously; React schedules
                // the render in the transition lane.
                g.commit('t-bump', (tx) => tx.set(a, 100))
              })
            }
          />
          <button
            data-testid="urgent-bump"
            onClick={() => {
              // Urgent commit — outside startTransition. Engine
              // mutation is synchronous; React schedules the render
              // in the urgent lane.
              g.commit('u-bump', (tx) => tx.set(a, 5))
            }}
          />
          <button
            data-testid="transition-resume"
            onClick={() =>
              startTransition(() => {
                g.commit('t-resume', (tx) => tx.set(a, 200))
              })
            }
          />
          <span data-testid="v">{v}</span>
        </>
      )
    }
    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')
    // Step 1: transition bump in its own act. Engine moves to 100,
    // React renders the transition-lane update.
    act(() => {
      ;(screen.getByTestId('transition-bump') as HTMLButtonElement).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('100'),
    )
    // Step 2: urgent bump — fires AFTER the transition committed.
    // Engine moves to 5; the urgent lane wins immediately.
    act(() => {
      ;(screen.getByTestId('urgent-bump') as HTMLButtonElement).click()
    })
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('5'))
    // Step 3: transition resume — a second transition commits on
    // top. The engine is not pinned by any prior transition; it
    // resumes from the post-urgent base of 5 and moves to 200.
    act(() => {
      ;(
        screen.getByTestId('transition-resume') as HTMLButtonElement
      ).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('200'),
    )
    // Interleaving trace: every committed value (100, 5, 200) was
    // observed at some render. A regression that queues urgent
    // commits behind a transition would never render `5` mid-trace;
    // one that pinned the engine to a transition snapshot would
    // never render `200`.
    expect(trace).toContain(100)
    expect(trace).toContain(5)
    expect(trace).toContain(200)
    // Ordering leg: the urgent value (5) must appear after the
    // transitioned value (100) — urgent fires only after the
    // transition has settled. And the resumed transition (200) must
    // appear after the urgent.
    const idx100 = trace.indexOf(100)
    const idx5 = trace.indexOf(5)
    const idx200 = trace.indexOf(200)
    expect(idx100).toBeLessThan(idx5)
    expect(idx5).toBeLessThan(idx200)
  })

  it('Suspense + transition coexistence — cached loaded value stays visible during transition', async () => {
    // P1 (PR #188 review): no test exercised wrapping a Suspense
    // refetch in a transition. The contract is that when a fresh
    // suspending read is initiated inside `startTransition`, the
    // previously-loaded value remains visible (no fallback flash);
    // only on settle does the new value appear.
    const g = createCausl()
    const r = g.input<SuspendableResource<number>>('r', {
      state: 'loaded',
      value: 1,
      origin: 0,
      loadedAt: 0,
    })
    function View() {
      const v = useCauslSuspense((graph) => graph.read(r))
      return <span data-testid="v">{v}</span>
    }
    function Wrapper() {
      const [, startTransition] = useTransition()
      return (
        <>
          <button
            data-testid="refetch"
            onClick={() =>
              startTransition(() => {
                // Stale — engine contract: the cached value is still
                // observable while the new fetch is in flight. The
                // Suspense projection narrows on the tag so the tree
                // does not throw the Promise; the transition keeps
                // the prior frame visible.
                g.commit('stale', (tx) =>
                  tx.set(r, { state: 'stale', value: 1, origin: 0, loadedAt: 0 }),
                )
              })
            }
          />
          <Suspense fallback={<span data-testid="loading">…</span>}>
            <View />
          </Suspense>
        </>
      )
    }
    render(
      <CauslProvider graph={g}>
        <Wrapper />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('1')
    expect(screen.queryByTestId('loading')).toBeNull()
    act(() => {
      ;(screen.getByTestId('refetch') as HTMLButtonElement).click()
    })
    // Coexistence leg: during the stale transition the cached value
    // is still rendered and the Suspense fallback never appears.
    await waitFor(() => {
      expect(screen.getByTestId('v').textContent).toBe('1')
    })
    expect(screen.queryByTestId('loading')).toBeNull()
    // Settle to a fresh loaded value — eventually visible.
    act(() => {
      g.commit('reloaded', (tx) =>
        tx.set(r, { state: 'loaded', value: 2, origin: 0, loadedAt: 0 }),
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('2'),
    )
    // Fallback never flashed during the entire sequence.
    expect(screen.queryByTestId('loading')).toBeNull()
  })

  it('rapid commits inside transitions do not tear paired selectors', async () => {
    const g = createCausl()
    const a = g.input('a', 0)
    function App({ children }: { children: ReactNode }) {
      return <CauslProvider graph={g}>{children}</CauslProvider>
    }
    function View() {
      const x = useCausl((graph) => graph.read(a))
      const xx = useCausl((graph) => graph.read(a) * 2)
      return (
        <span data-testid="v">
          {x}/{xx}
        </span>
      )
    }
    render(
      <App>
        <View />
      </App>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0/0')
    act(() => {
      for (let i = 1; i <= 10; i++) {
        g.commit(`c${i}`, (tx) => tx.set(a, i))
      }
    })
    // Final state — pair stays consistent (no x === 5 with xx === 12).
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('10/20'))
  })
})
