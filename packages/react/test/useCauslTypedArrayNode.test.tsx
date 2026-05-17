/**
 * @packageDocumentation
 *
 * Tests for the typed-array projection hook
 * {@link useCauslTypedArrayNode} introduced in #688 (sub-task of the
 * WASM-engine EPIC #680).
 *
 * The real zero-copy-into-linear-memory path depends on the WASM
 * artefacts produced by #682 / #683 / #693, which are not yet
 * built. Until they ship, `loadWasmBackend()` (#1031) throws
 * `WasmBackendUnavailableError` and the hook takes its documented
 * JS-engine fallback path. These tests pin the fallback contract:
 *
 *   1. The hook returns a typed array of the requested constructor
 *      shape, regardless of the JS-side committed value's shape
 *      (typed array, plain array, `null`).
 *   2. View identity is stable across renders for a single commit:
 *      `Object.is(viewN, viewN)` holds across React's re-reads of
 *      `getSnapshot`, even under strict-mode double invocation.
 *   3. Same per-node subscription semantics as `useCauslNode`:
 *      commits to unrelated nodes do NOT trigger a re-render.
 *   4. Same provider guard as the rest of the hook family.
 */

import { createCausl } from '@causljs/core'
import { act, render, screen } from '@testing-library/react'
import { StrictMode, useRef, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCauslTypedArrayNode } from '../src/index.js'

describe('useCauslTypedArrayNode(node, ctor)', () => {
  /**
   * Confirms the hook returns a typed array of the requested shape
   * when the underlying committed value is already that shape — the
   * "zero-copy-equivalent" path on the JS engine (no coercion copy).
   */
  it('returns the value verbatim when it is already an instance of ctor', () => {
    const g = createCausl()
    const initial = new Float64Array([1, 2, 3])
    const node = g.input('prices', initial)

    let captured: Float64Array | null = null
    function View(): JSX.Element {
      captured = useCauslTypedArrayNode(node, Float64Array)
      return <span data-testid="v">{captured.length}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('3')
    expect(captured).toBeInstanceOf(Float64Array)
    // The exact reference flows through: no defensive copy on the
    // zero-copy-equivalent path.
    expect(captured).toBe(initial)
  })

  /**
   * Confirms the hook coerces a non-`ctor` committed value (here a
   * plain `number[]`) into the requested typed-array shape. This is
   * the documented fallback for callers who haven't yet migrated
   * their input nodes to typed arrays.
   */
  it('coerces a plain number array into the requested typed array', () => {
    const g = createCausl()
    const node = g.input<number[]>('rgb', [255, 128, 0])

    let captured: Uint8Array | null = null
    function View(): JSX.Element {
      captured = useCauslTypedArrayNode(node, Uint8Array)
      return <span data-testid="v">{Array.from(captured).join(',')}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(captured).toBeInstanceOf(Uint8Array)
    expect(Array.from(captured!)).toEqual([255, 128, 0])
  })

  /**
   * Confirms the hook returns an empty typed array when the
   * committed value is `null` or `undefined`. Adopters get a usable
   * (zero-length) view rather than a runtime crash.
   */
  it('returns an empty typed array when the value is null', () => {
    const g = createCausl()
    const node = g.input<Int32Array | null>('maybe', null)

    let captured: Int32Array | null = null
    function View(): JSX.Element {
      captured = useCauslTypedArrayNode(node, Int32Array)
      return <span data-testid="v">{captured.length}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(captured).toBeInstanceOf(Int32Array)
    expect(captured!.length).toBe(0)
  })

  /**
   * Core stability contract from the #688 hook docs: the returned
   * view reference is stable across renders until the next commit
   * during which the engine reports a value change. Same-commit
   * reads MUST return identically-`Object.is`-equal views, so
   * `React.memo`-style identity comparisons skip work.
   *
   * Verified by triggering a commit on an UNRELATED node — the
   * subscription does not fire, but if React happens to re-call
   * `getSnapshot` (e.g. during a concurrent root render), it must
   * see the cached view.
   */
  it('returns a stable view reference for the same commit', () => {
    const g = createCausl()
    const node = g.input<number[]>('xs', [1, 2, 3])

    const captures: Float64Array[] = []
    function View(): JSX.Element {
      const v = useCauslTypedArrayNode(node, Float64Array)
      captures.push(v)
      return <span data-testid="v">{v.length}</span>
    }

    const { rerender } = render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    const first = captures.at(-1)!
    rerender(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    const second = captures.at(-1)!
    // Same commit → identical view reference.
    expect(Object.is(first, second)).toBe(true)
  })

  /**
   * After a commit that changes the subscribed node, the hook must
   * return a *fresh* view reference. This is the signal adopters
   * use to detect that bulk numeric data changed.
   */
  it('returns a fresh view reference after a commit changes the node', () => {
    const g = createCausl()
    const node = g.input<number[]>('xs', [1, 2, 3])

    const captures: Float64Array[] = []
    function View(): JSX.Element {
      const v = useCauslTypedArrayNode(node, Float64Array)
      captures.push(v)
      return <span data-testid="v">{v.length}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    const before = captures.at(-1)!

    act(() => {
      g.commit('xs→[4,5]', (tx) => tx.set(node, [4, 5]))
    })
    const after = captures.at(-1)!

    expect(Object.is(before, after)).toBe(false)
    expect(Array.from(after)).toEqual([4, 5])
  })

  /**
   * Same per-node subscription guarantee as `useCauslNode`:
   * subscribing to node A must NOT cause a re-render when an
   * unrelated node B is committed. This is the structural
   * efficiency property the WASM path inherits unchanged.
   */
  it('does NOT re-render when an unrelated node changes', () => {
    const g = createCausl()
    const xs = g.input<number[]>('xs', [1, 2, 3])
    const other = g.input('other', 0)

    function View(): JSX.Element {
      const renderCount = useRef(0)
      renderCount.current += 1
      const v = useCauslTypedArrayNode(xs, Float64Array)
      return (
        <span data-testid="v">
          {v.length}/{renderCount.current}
        </span>
      )
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    const initial = screen.getByTestId('v').textContent ?? ''
    const initialRenders = Number(initial.split('/')[1])

    act(() => {
      g.commit('other→1', (tx) => tx.set(other, 1))
    })
    const after = screen.getByTestId('v').textContent ?? ''
    const rendersAfter = Number(after.split('/')[1])
    expect(rendersAfter).toBe(initialRenders)
  })

  /**
   * `useSyncExternalStore` + strict-mode mount/unmount cycles: the
   * hook must survive React 18's double-invocation pattern without
   * losing subscriptions or returning torn views. We mount the same
   * subtree under `<StrictMode>` and assert that the rendered text
   * reflects the committed value.
   */
  it('works under StrictMode mount/unmount cycles', () => {
    const g = createCausl()
    const node = g.input<number[]>('xs', [1, 2, 3])

    function View(): JSX.Element {
      const v = useCauslTypedArrayNode(node, Float64Array)
      return <span data-testid="v">{v.length}</span>
    }

    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <View />
        </CauslProvider>
      </StrictMode>,
    )
    expect(screen.getByTestId('v').textContent).toBe('3')

    act(() => {
      g.commit('xs→[1,2,3,4,5]', (tx) => tx.set(node, [1, 2, 3, 4, 5]))
    })
    expect(screen.getByTestId('v').textContent).toBe('5')
  })

  /**
   * Confirms the hook raises a clear diagnostic when invoked
   * outside any `<CauslProvider>`. Mirrors `useCauslNode`'s guard.
   */
  it('throws a descriptive error when used outside a provider', () => {
    const g = createCausl()
    const node = g.input<number[]>('xs', [1, 2, 3])

    function View(): JSX.Element {
      const v = useCauslTypedArrayNode(node, Float64Array)
      return <span>{v.length}</span>
    }

    expect(() => render(<View />)).toThrowError(
      /useCauslTypedArrayNode must be used inside <CauslProvider>/,
    )
  })

  /**
   * Confirms the hook works with derived nodes, not just inputs.
   * A derived node computing a typed array from an input node must
   * flow through unchanged.
   */
  it('works with derived nodes', () => {
    const g = createCausl()
    const xs = g.input<number[]>('xs', [1, 2, 3])
    const doubled = g.derived('doubled', (get) => get(xs).map((n) => n * 2))

    function View(): JSX.Element {
      const v = useCauslTypedArrayNode(doubled, Float64Array)
      return <span data-testid="v">{Array.from(v).join(',')}</span>
    }

    render(
      <CauslProvider graph={g}>
        <View />
      </CauslProvider>,
    )
    expect(screen.getByTestId('v').textContent).toBe('2,4,6')

    act(() => {
      g.commit('xs→[10,20]', (tx) => tx.set(xs, [10, 20]))
    })
    expect(screen.getByTestId('v').textContent).toBe('20,40')
  })
})
