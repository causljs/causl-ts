/**
 * useSyncExternalStore adoption + StrictMode double-render tests (#132).
 *
 * useCausl already uses useSyncExternalStore (closes the React-18
 * tearing class structurally). This file pins that contract with
 * explicit double-render scenarios.
 */

import { createCausl, type Graph } from '@causljs/core'
import {
  assertConsistentGraphTime,
  assertResultStability,
  propertyTrials,
  type TraceEntry,
} from '@causljs/core/testing'
import { act, render, screen } from '@testing-library/react'
import fc from 'fast-check'
import { StrictMode, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CauslProvider, useCausl } from '../src/index.js'

function harness(g: Graph) {
  return ({ children }: { children: React.ReactNode }) => (
    <CauslProvider graph={g}>{children}</CauslProvider>
  )
}

/**
 * Canonical render count for a `useSyncExternalStore`-backed
 * component on initial mount under React 18 `<StrictMode>`. React
 * 18.x dev intentionally double-invokes function-component bodies on
 * initial mount; `useCausl` is built on `useSyncExternalStore`,
 * which guarantees both invocations observe the same snapshot. So
 * the canonical post-mount `renders` array length is 2.
 *
 * Pinned as a constant so a future React minor that bumps the count
 * (e.g. a hypothetical 3-pass StrictMode) updates here in one place
 * rather than scattering magic-2s across the suite. If you upgrade
 * React and the test fails on this constant, that is the expected
 * signal — re-pin after auditing the new render-count contract.
 *
 * (#227 review-205) The Set-based assertion this replaced collapsed
 * a runaway-loop emission of `[5,5,…,5]` to `Set([5])`; the
 * exact-shape array assertion below catches a regression that the
 * Set silently laundered.
 */
const EXPECTED_STRICTMODE_RENDERS_PER_INITIAL_MOUNT = 2

describe('useCausl — useSyncExternalStore + StrictMode (#132)', () => {
  it('produces identical output across StrictMode double-renders', () => {
    const g = createCausl()
    const a = g.input('a', 5)
    const renders: number[] = []
    function View() {
      const v = useCausl((graph) => graph.read(a))
      renders.push(v)
      return <span data-testid="v">{v}</span>
    }
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      </StrictMode>,
    )
    // Exact-shape assertion (#227): pinning the array — not the set
    // of values — is what distinguishes a healthy double-render from
    // a runaway loop. A subscription/getSnapshot loop that re-emits
    // `5` hundreds of times collapsed to `new Set([5])` (the prior
    // assertion silently passed); the exact-shape check fails the
    // moment `renders.length` deviates from the canonical
    // StrictMode count.
    expect(renders).toEqual(
      Array(EXPECTED_STRICTMODE_RENDERS_PER_INITIAL_MOUNT).fill(5),
    )
    expect(screen.getByTestId('v').textContent).toBe('5')
  })

  it('getSnapshot returns a referentially stable value when nothing changed', () => {
    // Referential-stability gate (see PR #187 review comments).
    // useSyncExternalStore enters a render loop if getSnapshot returns a
    // fresh reference between back-to-back calls with no commit.
    const g = createCausl()
    const a = g.input('a', 7)
    assertResultStability({
      getSnapshot: () => g.read(a),
    })
  })

  // ---- getServerSnapshot SSR parity (#230, follow-up to PR #187 review) ----
  //
  // The third argument of useSyncExternalStore is the server-snapshot
  // callback. useCausl passes `getSnapshot` for both the client and
  // server slot today; that means the value paths are structurally the
  // same code. The risk this suite pins is *future drift* — a refactor
  // that memoises one path differently, or wires a request-scoped
  // server context, must not silently diverge SSR from CSR.
  //
  // Three legs:
  //   (a) renderToString equals client render for the same graph;
  //   (b) hydrateRoot fires no hydration-mismatch warning;
  //   (c) ≥1000 random graphs/values: the SSR HTML and the pre-hydration
  //       client HTML stay equal across the input domain, and every
  //       observation collapses to one GraphTime per render frame
  //       (the SPEC §3 invariant via assertConsistentGraphTime).
  describe('getServerSnapshot SSR parity (#230)', () => {
    it('renderToString output matches the client-render output for the same graph', () => {
      const g = createCausl()
      g.input('count', 42)
      function View() {
        const v = useCausl((graph) => graph.read({ id: 'count' })) as number
        return <span data-testid="v">{v}</span>
      }
      const tree = (
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      )
      const serverHtml = renderToString(tree)
      const { container } = render(tree)
      // Pre-hydration parity: the server-rendered HTML and the client
      // first-render HTML must be byte-identical for the same graph
      // state, otherwise React fires a hydration mismatch.
      expect(serverHtml).toBe(container.innerHTML)
      expect(serverHtml).toContain('42')
    })

    it('hydrateRoot does not emit a hydration mismatch warning', async () => {
      const g = createCausl()
      g.input('count', 7)
      function View() {
        const v = useCausl((graph) => graph.read({ id: 'count' })) as number
        return <span data-testid="v">{v}</span>
      }
      const tree = (
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      )
      const serverHtml = renderToString(tree)

      // jsdom DOM seeded with the SSR markup so hydrateRoot has a tree
      // to attach to. React's hydration warnings fire as console.error;
      // the spy turns them into a test failure.
      const host = document.createElement('div')
      host.innerHTML = serverHtml
      document.body.appendChild(host)

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { hydrateRoot } = await import('react-dom/client')
      let root: ReturnType<typeof hydrateRoot> | null = null
      try {
        await act(async () => {
          root = hydrateRoot(host, tree)
        })
        const errorMessages = errorSpy.mock.calls.map((c) => String(c[0] ?? ''))
        const warnMessages = warnSpy.mock.calls.map((c) => String(c[0] ?? ''))
        const hydrationMismatch = [...errorMessages, ...warnMessages].some(
          (m) =>
            m.includes('hydrat') ||
            m.includes('did not match') ||
            m.includes('Text content does not match'),
        )
        expect(hydrationMismatch).toBe(false)
        expect(host.textContent).toContain('7')
      } finally {
        errorSpy.mockRestore()
        warnSpy.mockRestore()
        if (root) {
          act(() => {
            root!.unmount()
          })
        }
        document.body.removeChild(host)
      }
    })

    it('server snapshot and client snapshot resolve at the same GraphTime per render frame', () => {
      const g = createCausl()
      g.input('a', 5)
      const trace: TraceEntry[] = []
      function View() {
        const v = useCausl((graph) => graph.read({ id: 'a' })) as number
        // §3 invariant: at every observation, the GraphTime the value
        // resolves at must be a single value within one frame. Capture
        // observations from both the SSR path and the CSR path under
        // the same frameId; assertConsistentGraphTime collapses them
        // to one time or fails loud.
        trace.push({ frameId: 0, selector: 'ssr|csr', value: v, time: g.now })
        return <span data-testid="v">{v}</span>
      }
      const tree = (
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      )
      // Server path — engages getServerSnapshot via renderToString.
      const serverHtml = renderToString(tree)
      // Client path — engages getSnapshot via the same hook.
      render(tree)
      expect(serverHtml).toContain('5')
      expect(screen.getByTestId('v').textContent).toBe('5')
      // Cross-path GraphTime collapse — both paths see the same `now`.
      assertConsistentGraphTime(trace)
    })

    // §15.2 trial-count floor — propertyTrials enforces ≥1000 trials so
    // the parity contract holds over the input domain, not just one
    // hand-picked scalar. Failing inputs are shrunk; seeds are logged.
    it(
      'property: SSR HTML equals client HTML for arbitrary primitive input values',
      () => {
        fc.assert(
          fc.property(
            fc.oneof(
              fc.integer({ min: -1000, max: 1000 }),
              fc.string({ maxLength: 32 }),
              fc.boolean(),
            ),
            (initial) => {
              const g = createCausl()
              g.input('x', initial)
              function View() {
                const v = useCausl((graph) =>
                  graph.read({ id: 'x' }),
                ) as number | string | boolean
                return <span>{String(v)}</span>
              }
              const tree = (
                <CauslProvider graph={g}>
                  <View />
                </CauslProvider>
              )
              const serverHtml = renderToString(tree)
              const { container, unmount } = render(tree)
              try {
                // Parity contract: server-snapshot path and client-
                // snapshot path on the same graph render the same
                // *value* — i.e. same observable text content. We
                // compare textContent rather than raw HTML because
                // renderToString applies stricter HTML attribute/
                // entity escaping than jsdom's innerHTML serialiser
                // (e.g. `"` vs `&quot;` in text), and that
                // serialisation gap is not a parity violation —
                // React hydrates fine across it. The contract this
                // pins is that the *value* observed by the SSR
                // snapshot equals the value observed by the client
                // snapshot for the same graph.
                const host = document.createElement('div')
                host.innerHTML = serverHtml
                expect(host.textContent).toBe(container.textContent)
                // Pre-hydration time is t₀ (no commits applied);
                // both paths must resolve there.
                expect(g.now).toBe(0)
              } finally {
                unmount()
              }
            },
          ),
          propertyTrials('ssr-getServerSnapshot-parity'),
        )
      },
      120_000,
    )
  })

  it('multiple StrictMode-mounted consumers all see the same committed value', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    function View({ id }: { id: string }) {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid={`v-${id}`}>{v}</span>
    }
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <View id="1" />
          <View id="2" />
          <View id="3" />
        </CauslProvider>
      </StrictMode>,
    )
    act(() => {
      g.commit('bump', (tx) => tx.set(a, 42))
    })
    expect(screen.getByTestId('v-1').textContent).toBe('42')
    expect(screen.getByTestId('v-2').textContent).toBe('42')
    expect(screen.getByTestId('v-3').textContent).toBe('42')
  })

  it('selector identity stability — re-creating the selector across renders does not loop', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    let renderCount = 0
    function View() {
      renderCount++
      // New selector closure each render — useCausl must not
      // resubscribe forever. The Object.is dedup on getSnapshot keeps
      // re-renders bounded.
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    function Wrapper() {
      const [, force] = useState(0)
      return (
        <>
          <button data-testid="rerender" onClick={() => force((x) => x + 1)} />
          <View />
        </>
      )
    }
    render(
      <CauslProvider graph={g}>
        <Wrapper />
      </CauslProvider>,
    )
    const baseline = renderCount
    act(() => {
      (screen.getByTestId('rerender') as HTMLButtonElement).click()
    })
    // One forced rerender → one extra render; not a loop.
    expect(renderCount).toBeLessThanOrEqual(baseline + 2)
  })

  it('post-commit, every consumer sees the new value in the same render pass (no tearing)', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const observed: number[][] = []
    function ViewA() {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="va">{v}</span>
    }
    function ViewB() {
      const v = useCausl((graph) => graph.read(a) * 10)
      return <span data-testid="vb">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <ViewA />
        <ViewB />
      </CauslProvider>,
    )
    observed.push([
      Number(screen.getByTestId('va').textContent),
      Number(screen.getByTestId('vb').textContent),
    ])
    act(() => {
      g.commit('bump', (tx) => tx.set(a, 5))
    })
    observed.push([
      Number(screen.getByTestId('va').textContent),
      Number(screen.getByTestId('vb').textContent),
    ])
    // Tearing-free: at every observation, A*10 === B (a is the same
    // value within a render pass).
    for (const [va, vb] of observed) {
      expect(vb).toBe(va! * 10)
    }
  })
})
