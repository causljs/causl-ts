/**
 * @packageDocumentation
 *
 * #1241 — regression gate for the H1 dev-warning false-positive in
 * canonical `@causljs/react` adapter usage.
 *
 * Issue #1241 surfaced that the H1 hazard warning (#1155, PR #1238)
 * fired on every commit when any `@causljs/react` hook was in use. The
 * cause is structural: `useSyncExternalStore` retains the last
 * `getSnapshot` return reference across commits for tearing detection,
 * and the canonical hooks (`useCauslNode`, `useCausl`,
 * `useCauslShallow`, `useCauslTypedArrayNode`) all return objects
 * (the node's value, the selector projection, the typed-array view).
 * That single retained reference matched the engine's "read return
 * held across commit" pattern verbatim and triggered the warning.
 *
 * #1241 ships three coordinated fixes:
 *
 *   - **A.** Default `enableH1HazardWarning` flipped to `false`
 *     (opt-in). Adopters who do not opt in see no warnings.
 *   - **B.** An internal `__causlAdapterRead(graph, fn)` seam that
 *     canonical adapters wrap their `getSnapshot` body in. The
 *     engine's H1 hazard tracker increments a depth counter for the
 *     duration of `fn`'s synchronous body and skips reads issued
 *     inside.
 *   - **C.** The H1 instrumentation is wrapped in
 *     `process.env.NODE_ENV !== 'production'` literal blocks so
 *     esbuild / terser DCE the WeakRef apparatus in production bundles.
 *
 * This suite gates **fix B**: with the opt-in flag armed (the case
 * that triggered the original false positive), no warning fires for
 * any of the canonical adapter hooks even after multiple commits.
 * The pure-TS held-ref pattern (`graph.read` outside the seam) MUST
 * still warn — the false-positive direction is what #1241 fixes, NOT
 * the load-bearing positive arm from #1155.
 */
import { createCausl } from '@causljs/core'
import { act, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CauslProvider,
  useCausl,
  useCauslNode,
  useCauslShallow,
  useCauslTypedArrayNode,
} from '../src/index.js'

/**
 * Match the canonical warning text emitted by the H1 instrumentation
 * (`packages/core/src/graph.ts` `checkH1HazardOnCommit`).
 */
function isH1Warning(arg: unknown): boolean {
  return typeof arg === 'string' && arg.includes('[causl] H1 hazard')
}

function countH1Warnings(spy: { mock: { calls: unknown[][] } }): number {
  let n = 0
  for (const call of spy.mock.calls) {
    if (call.length > 0 && isH1Warning(call[0])) n++
  }
  return n
}

describe('H1 hazard warning — @causljs/react adapter exemption (#1241)', () => {
  let warnSpy: { mock: { calls: unknown[][] }; mockRestore: () => void }
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // Force a dev environment so the tree-shake gate in `graph.ts`
    // does not bypass the H1 apparatus before we get a chance to
    // assert on it. This mirrors the prod build behaviour at runtime:
    // in production the apparatus is DCE'd entirely, and these
    // assertions would be vacuously true.
    process.env.NODE_ENV = 'development'
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    warnSpy.mockRestore()
  })

  /**
   * `useCauslNode` reading an object-valued derived must NOT trigger
   * the H1 warning on commit, even with the dev safety net opted in.
   * This is the load-bearing regression gate from #1241: the original
   * false positive was triggered exactly by this code path.
   */
  it('useCauslNode reading an object-valued derived does not warn on commit', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const count = g.input('count', 0)
    const view = g.derived('view', (get) => ({ count: get(count) }))

    function View(): JSX.Element {
      const v = useCauslNode(view)
      return <span data-testid="v">{v.count}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')

    act(() => {
      g.commit('count→1', (tx) => tx.set(count, 1))
    })
    expect(screen.getByTestId('v').textContent).toBe('1')

    act(() => {
      g.commit('count→2', (tx) => tx.set(count, 2))
    })
    expect(screen.getByTestId('v').textContent).toBe('2')

    // Three render cycles + two commits, all reading through the
    // adapter-exemption seam. No H1 warning should fire.
    expect(countH1Warnings(warnSpy)).toBe(0)
  })

  /**
   * `useCausl(selector)` reading an object-valued derived must NOT
   * warn. Selectors that surface the underlying object (rather than
   * building a fresh wrapper per call) are the documented stable-
   * dedup path. The selector's `graph.read` runs inside the seam.
   *
   * Note — selectors that build a fresh object literal per call are
   * explicitly the use case for {@link useCauslShallow}; `useCausl`
   * relies on `Object.is` dedup and would otherwise loop on every
   * render. The shallow-equal arm covers the fresh-wrapper case.
   */
  it('useCausl reading an object-valued derived does not warn on commit', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const view = g.derived('view', (get) => ({ a: get(a) }))

    function View(): JSX.Element {
      const v = useCausl((graph) => graph.read(view))
      return <span data-testid="v">{v.a}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0')

    act(() => {
      g.commit('a→1', (tx) => tx.set(a, 1))
    })
    expect(screen.getByTestId('v').textContent).toBe('1')

    expect(countH1Warnings(warnSpy)).toBe(0)
  })

  /**
   * `useCauslShallow` is the canonical hook for projecting fresh
   * object literals; verifies the seam applies on this code path too.
   */
  it('useCauslShallow with an object-projecting selector does not warn on commit', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const b = g.input('b', 0)

    function View(): JSX.Element {
      const v = useCauslShallow((graph) => ({
        a: graph.read(a),
        b: graph.read(b),
      }))
      return (
        <span data-testid="v">
          {v.a}:{v.b}
        </span>
      )
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('0:0')

    act(() => {
      g.commit('a→3', (tx) => tx.set(a, 3))
    })
    expect(screen.getByTestId('v').textContent).toBe('3:0')

    expect(countH1Warnings(warnSpy)).toBe(0)
  })

  /**
   * `useCauslTypedArrayNode` synthesises a typed-array view from the
   * node's committed value — the underlying `graph.read` happens
   * inside the adapter-exemption seam.
   */
  it('useCauslTypedArrayNode does not warn on commit', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const prices = g.input<Float64Array>('prices', new Float64Array([1, 2, 3]))

    function View(): JSX.Element {
      const arr = useCauslTypedArrayNode(prices, Float64Array)
      return <span data-testid="v">{arr.length}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('3')

    act(() => {
      g.commit('prices+1', (tx) =>
        tx.set(prices, new Float64Array([4, 5, 6, 7])),
      )
    })
    expect(screen.getByTestId('v').textContent).toBe('4')

    expect(countH1Warnings(warnSpy)).toBe(0)
  })

  /**
   * The pure-TS held-ref pattern (a `graph.read` issued OUTSIDE the
   * adapter-exemption seam, with the result captured on a closure-
   * scoped local across a commit) MUST still warn. This is the
   * load-bearing positive arm from #1155: the H1 hazard is real and
   * the dev safety net catches it when the adopter opts in. #1241's
   * fix is restricted to the false-positive direction from canonical
   * adapter usage; the legitimate hazard pattern is unchanged.
   */
  it('preserves the pure-TS held-ref warning outside the seam', () => {
    const g = createCausl({ enableH1HazardWarning: true })
    const a = g.input('a', 0)
    const obj = g.derived('obj', (get) => ({ a: get(a) }))
    const held = g.read(obj) // outside React, outside the seam
    expect(held).toEqual({ a: 0 })
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(countH1Warnings(warnSpy)).toBe(1)
    expect(held.a).toBe(0) // anchor
  })
})
