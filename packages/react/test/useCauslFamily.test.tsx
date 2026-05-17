/**
 * @packageDocumentation
 *
 * Behavioural contract for {@link useCauslFamily}: stable per-key
 * node identity within a single provider, isolated namespaces across
 * providers, refcount-driven disposal via `@causl/core/internal`,
 * and StrictMode-safe deferred dispose.
 *
 * The disposal channel routes through the internal entrypoint
 * deliberately, not the public {@link Graph} interface: `_dispose`
 * (and the `Disposed` node tag) is an adapter-level concern with no
 * SemVer guarantees, used by exactly this React hook because the
 * hook owns the concept of "this node's lifetime is bounded by a
 * component's mount." Application code never calls it directly. If
 * the primitive ever becomes broadly useful it gets promoted to the
 * public surface with its own justification — the demotion direction
 * is the harder one and is held back by quarterly review.
 */

import {
  createCausl,
  NodeDisposedError,
  type Graph,
  type Node,
} from '@causl/core'
import { act, render, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCauslFamily } from '../src/index.js'

/** Provider wrapper that pins a graph for a renderHook call. */
function harness(graph: Graph) {
  return ({ children }: { children: React.ReactNode }) => (
    <CauslProvider graph={graph}>{children}</CauslProvider>
  )
}

/** Drain the microtask queue used by deferred-dispose. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
}

/**
 * Identity-sharing contract: two consumers under the *same* provider
 * mount must see the same node handle for the same key, and disjoint
 * handles for distinct keys. This is the core promise the hook makes
 * downstream of the registry.
 */
describe('useCauslFamily — identity within a provider', () => {
  /**
   * Two components under one provider that ask for the same key must
   * receive the same `Node` reference; the factory runs exactly once.
   */
  it('shares node identity for two consumers under the same provider', () => {
    // arrange: a single provider, two consumers asking for the same key
    const g = createCausl()
    let factoryCalls = 0
    const Pair = () => {
      const a = useCauslFamily('A1', (graph, key) => {
        factoryCalls++
        return graph.input(`cell:${key}`, 0)
      })
      const b = useCauslFamily('A1', (graph, key) => {
        factoryCalls++
        return graph.input(`cell:${key}`, 0)
      })
      return <div data-testid="ids">{`${a.id}|${b.id}`}</div>
    }

    // act: render the pair under one provider
    const { getByTestId } = render(
      <CauslProvider graph={g}>
        <Pair />
      </CauslProvider>,
    )

    // assert: identity is shared and the factory ran exactly once
    expect(getByTestId('ids').textContent).toBe('cell:A1|cell:A1')
    expect(factoryCalls).toBe(1)
  })

  /**
   * Distinct keys under the same provider yield distinct nodes —
   * the registry's keying is exact-match.
   */
  it('returns distinct nodes for different keys', () => {
    // arrange: one provider, two consumers with distinct keys
    const g = createCausl()
    const a = renderHook(
      () => useCauslFamily('A1', (graph, key) => graph.input(`cell:${key}`, 0)),
      { wrapper: harness(g) },
    )
    const b = renderHook(
      () => useCauslFamily('A2', (graph, key) => graph.input(`cell:${key}`, 0)),
      { wrapper: harness(g) },
    )

    // assert: distinct ids, distinct handles
    expect(a.result.current).not.toBe(b.result.current)
    expect(a.result.current.id).toBe('cell:A1')
    expect(b.result.current.id).toBe('cell:A2')
  })

  /**
   * Re-rendering the consumer must not perturb the cached entry —
   * identity is stable across renders that have nothing to do with
   * the registry.
   */
  it('preserves node identity across re-renders of the same component', () => {
    // arrange: render once, capture the handle
    const g = createCausl()
    const { result, rerender } = renderHook(
      () => useCauslFamily('A1', (graph, key) => graph.input(`cell:${key}`, 0)),
      { wrapper: harness(g) },
    )
    const first = result.current

    // act: re-render the same hook
    rerender()

    // assert: the handle is referentially identical
    expect(result.current).toBe(first)
  })
})

/**
 * Per-provider isolation — the brutal-critique P0 fix from #178's
 * review. Two `<CauslProvider>` mounts wrapping the same graph
 * must keep their family namespaces separate, even when callers use
 * the same key. A leak between providers would let one component
 * tree's lifecycle reach into another's.
 */
describe('useCauslFamily — per-provider isolation', () => {
  /**
   * Two distinct providers around the same graph must run the
   * factory twice for the same key, and produce nodes that are
   * registered under distinct ids (the factory builds the id from
   * the key, but the engine registers each separately because the
   * provider-scoped registries don't see each other).
   */
  it('does not leak entries between two providers around the same graph', () => {
    // arrange: a single graph, two providers each with their own consumer
    const g = createCausl()
    let leftRuns = 0
    let rightRuns = 0
    const Left = () =>
      useCauslFamily('K', (graph, key) => {
        leftRuns++
        return graph.input(`left:${key}`, 0)
      }) && null
    const Right = () =>
      useCauslFamily('K', (graph, key) => {
        rightRuns++
        return graph.input(`right:${key}`, 0)
      }) && null

    // act: mount two providers in disjoint subtrees
    render(
      <>
        <CauslProvider graph={g}>
          <Left />
        </CauslProvider>
        <CauslProvider graph={g}>
          <Right />
        </CauslProvider>
      </>,
    )

    // assert: each provider's factory ran independently of the other
    expect(leftRuns).toBe(1)
    expect(rightRuns).toBe(1)
  })

  /**
   * Replacing the `graph` prop on a provider must reset the family
   * registry — the new graph gets a fresh namespace, no leak from
   * the old one. The `useMemo` dep on `graph` in `Provider.tsx`
   * encodes this.
   */
  it('resets the registry when the provider swaps its graph', () => {
    // arrange: a wrapper that lets the test swap the graph handle
    let factoryRuns = 0
    const Consumer = () => {
      useCauslFamily('K', (graph, key) => {
        factoryRuns++
        return graph.input(`cell:${key}`, 0)
      })
      return null
    }
    const Wrapper = ({ graph }: { graph: Graph }) => (
      <CauslProvider graph={graph}>
        <Consumer />
      </CauslProvider>
    )
    const g1 = createCausl()
    const g2 = createCausl()

    // act: render with g1, then re-render with g2
    const { rerender } = render(<Wrapper graph={g1} />)
    expect(factoryRuns).toBe(1)
    rerender(<Wrapper graph={g2} />)

    // assert: the second graph triggered a fresh factory run
    expect(factoryRuns).toBe(2)
  })
})

/**
 * Disposal contract — disposal goes through `@causl/core/internal`
 * (no public-Graph leak) and is deferred via microtask so StrictMode
 * does not destroy and recreate the node.
 */
describe('useCauslFamily — disposal lifecycle', () => {
  /**
   * After the last consumer unmounts and the deferred dispose
   * microtask runs, public-surface access to the node throws
   * {@link NodeDisposedError}. This is the contract that the hook
   * actually drives the engine's disposal channel — not just the
   * registry — so rows in a virtualised list don't accumulate.
   */
  it('disposes the node when the last consumer unmounts', async () => {
    // arrange: track the node so the test can assert on it post-unmount
    const g = createCausl()
    let captured: Node<number> | null = null
    const Consumer = () => {
      captured = useCauslFamily('row:1', (graph, key) =>
        graph.input(`cell:${key}`, 42),
      )
      return null
    }

    // act: mount, then unmount, then drain the microtask queue
    const { unmount } = render(
      <CauslProvider graph={g}>
        <Consumer />
      </CauslProvider>,
    )
    expect(captured).not.toBeNull()
    unmount()
    await act(async () => {
      await flushMicrotasks()
    })

    // assert: the node has been disposed; reads surface NodeDisposedError
    expect(() => g.read(captured!)).toThrow(NodeDisposedError)
  })

  /**
   * Under `StrictMode`, React intentionally double-invokes effects
   * (mount → unmount → mount) on first render to surface accidental
   * cleanup bugs. The hook's deferred dispose must observe the
   * intervening re-mount and skip the engine call, so the node
   * remains alive after the StrictMode dance.
   */
  it('survives StrictMode double-mount without disposing', async () => {
    // arrange: a single consumer wrapped in StrictMode
    const g = createCausl()
    let captured: Node<number> | null = null
    const Consumer = () => {
      captured = useCauslFamily('row:1', (graph, key) =>
        graph.input(`cell:${key}`, 42),
      )
      return null
    }

    // act: mount under StrictMode and let the double-invoke settle
    render(
      <StrictMode>
        <CauslProvider graph={g}>
          <Consumer />
        </CauslProvider>
      </StrictMode>,
    )
    await act(async () => {
      await flushMicrotasks()
    })

    // assert: the node is still readable — disposal was cancelled
    expect(captured).not.toBeNull()
    expect(g.read(captured!)).toBe(42)
  })

  /**
   * Two consumers share refcount: dropping one leaves the node
   * alive; dropping the second triggers disposal.
   */
  it('refcount admits disposal only after the last consumer leaves', async () => {
    // arrange: two consumers under one provider, controlled by a flag
    const g = createCausl()
    let captured: Node<number> | null = null
    const Consumer = ({ id }: { id: string }) => {
      captured = useCauslFamily('row:1', (graph, key) =>
        graph.input(`cell:${key}`, 99),
      )
      return <div data-testid={id} />
    }
    const Tree = ({ count }: { count: 0 | 1 | 2 }) => (
      <CauslProvider graph={g}>
        {count >= 1 && <Consumer id="a" />}
        {count === 2 && <Consumer id="b" />}
      </CauslProvider>
    )

    // act 1: mount two consumers
    const { rerender } = render(<Tree count={2} />)
    expect(captured).not.toBeNull()

    // act 2: drop one — refcount stays positive, node alive
    rerender(<Tree count={1} />)
    await act(async () => {
      await flushMicrotasks()
    })
    expect(g.read(captured!)).toBe(99)

    // act 3: drop the last consumer — disposal microtask now fires
    rerender(<Tree count={0} />)
    await act(async () => {
      await flushMicrotasks()
    })

    // assert: node has been disposed
    expect(() => g.read(captured!)).toThrow(NodeDisposedError)
  })
})
