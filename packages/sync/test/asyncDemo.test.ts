/**
 * @packageDocumentation
 *
 * Phase 4 acceptance demo exercising async fetch with stale-result protection.
 * Walks through a scenario where a user picks a category, the loader begins
 * fetching its items, and the user picks another category before the first
 * fetch resolves. The contract under test is that the result of the first
 * fetch must not clobber the second category's view. The fixture wires up an
 * input for the selected category, a per-category resource loader, and a
 * derived view that exposes items only when loaded for the current selection.
 */

import { createCausl, type Graph, type InputNode } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { resource, type ResourceState } from '../src/index.js'

/**
 * Demo item shape used by the per-category loader fixture.
 */
interface Item {
  readonly id: number
  readonly category: string
  readonly name: string
}

/**
 * Hand-rolled deferred handle exposing both a promise and its resolver,
 * letting tests control loader completion ordering deterministically.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/**
 * Constructs a {@link Deferred} whose `resolve` callback can be invoked
 * externally by the test to release a pending loader call.
 */
function defer<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

/**
 * Builds the async-demo fixture: a graph, the `selected` input node, a
 * per-category items resource, and the map of pending deferred loader
 * results keyed by category. The loader reads the currently selected
 * category and returns the corresponding deferred promise, creating one
 * lazily on first request so that tests can resolve fetches at will.
 */
function buildAsyncDemo(): {
  graph: Graph
  selected: InputNode<string>
  resourceHandle: ReturnType<typeof resource<Item[]>>
  pending: Map<string, Deferred<Item[]>>
} {
  const graph = createCausl()
  const selected = graph.input<string>('selected', 'fruit')
  const pending = new Map<string, Deferred<Item[]>>()
  const r = resource<Item[]>(graph, 'items', {
    loader: async () => {
      const cat = graph.read(selected)
      let d = pending.get(cat)
      if (!d) {
        d = defer<Item[]>()
        pending.set(cat, d)
      }
      return d.promise
    },
  })
  return { graph, selected, resourceHandle: r, pending }
}

/**
 * Suite covering Phase 4 acceptance: async fetches must reach Loaded
 * for the active selection, decay to Stale when an in-flight load is
 * outraced by an input change, and recover to Loaded after a refetch
 * for the new selection.
 */
describe('Phase 4 — async demo with stale-result protection', () => {
  /**
   * Verifies the happy path: fetching while the selection is stable
   * resolves into the Loaded state with the loader's payload.
   */
  it('successfully loads items for the active category', async () => {
    const { graph, resourceHandle, pending } = buildAsyncDemo()
    // Arrange: initiate a fetch for the default 'fruit' category.
    const fetchPromise = resourceHandle.fetch()
    // Act: release the pending loader with two fruit items.
    pending.get('fruit')!.resolve([
      { id: 1, category: 'fruit', name: 'apple' },
      { id: 2, category: 'fruit', name: 'pear' },
    ])
    await fetchPromise
    // Assert: resource transitioned idle → loading → loaded with payload size 2.
    const v: ResourceState<Item[]> = graph.read(resourceHandle.node)
    expect(v.state).toBe('loaded')
    if (v.state !== 'loaded') throw new Error('unreachable')
    expect(v.value.length).toBe(2)
  })

  /**
   * Pins the stale-result protection contract: a fetch whose selection
   * input changes mid-flight must end up in the `stale` state rather
   * than overwriting the new selection's view.
   */
  it('a fetch interrupted by a category change resolves as Stale', async () => {
    const { graph, selected, resourceHandle, pending } = buildAsyncDemo()
    // Arrange: kick off a fetch for the active 'fruit' category.
    const fruitFetch = resourceHandle.fetch()
    // Act (interleave): before the fruit fetch resolves, the user changes category.
    graph.commit('switch-to-veggies', (tx) => tx.set(selected, 'veggies'))
    // Act (late resolve): the fruit promise resolves after the input switched.
    pending.get('fruit')!.resolve([
      { id: 1, category: 'fruit', name: 'apple' },
    ])
    await fruitFetch
    // Assert: transition is loading → stale, not loading → loaded.
    const v = graph.read(resourceHandle.node)
    expect(v.state).toBe('stale')
  })

  /**
   * Confirms recovery: after Stale is observed the host can refetch and
   * reach Loaded carrying data scoped to the now-active selection.
   */
  it('refetching after a category change reaches Loaded for the new category', async () => {
    const { graph, selected, resourceHandle, pending } = buildAsyncDemo()
    // Arrange: initial fetch for 'fruit', then switch to 'veggies' and resolve fruit late.
    const fruitFetch = resourceHandle.fetch()
    graph.commit('switch-to-veggies', (tx) => tx.set(selected, 'veggies'))
    pending.get('fruit')!.resolve([{ id: 1, category: 'fruit', name: 'apple' }])
    await fruitFetch
    expect(graph.read(resourceHandle.node).state).toBe('stale')

    // Act: the host application notices Stale and refetches for the new category.
    const veggieFetch = resourceHandle.fetch()
    if (!pending.has('veggies')) pending.set('veggies', defer<Item[]>())
    pending
      .get('veggies')!
      .resolve([{ id: 100, category: 'veggies', name: 'carrot' }])
    await veggieFetch
    // Assert: transition is stale → loading → loaded with veggie payload.
    const v = graph.read(resourceHandle.node)
    expect(v.state).toBe('loaded')
    if (v.state !== 'loaded') throw new Error('unreachable')
    expect(v.value[0]?.category).toBe('veggies')
  })
})
