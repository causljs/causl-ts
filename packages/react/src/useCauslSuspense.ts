/**
 * useCauslSuspense — Suspense projection of Resource-shaped values.
 *
 * Closes #127. Closes Adoption-gap #2 (Jotai's Suspense atoms): the
 * tagged-union `ResourceState<T>` from `@causl/sync` becomes a
 * value `T` that integrates with `<Suspense>` and React error
 * boundaries.
 *
 * Mapping:
 *   - `loading` → throw the in-flight Promise carried on the state
 *                 (engine-anchored, identity-stable across renders for
 *                 the same loading episode — SPEC §9.1).
 *   - `loaded`  → return `value`.
 *   - `stale`   → return cached `value` (do not throw — we already
 *                 have a value to render; the application can refetch
 *                 explicitly).
 *   - `errored` → throw `error` (Error Boundary catches it).
 *   - `idle`    → throw a Promise that resolves on the next graph
 *                 commit. Identity-stable per graph; the application
 *                 must trigger a fetch for the resource to leave
 *                 `idle`. The contract is "suspend, not error".
 *
 * The selector returns the canonical `ResourceState<T>` from
 * `@causl/sync` — no fork. `SuspendableResource<T>` is kept as a
 * type alias for backward compatibility with consumers that imported
 * it from this package.
 */

import type { Graph } from '@causl/core'
import { assertNever, type ReadOnlyGraph } from '@causl/core/internal'
import type { ResourceState } from '@causl/sync'
import { useContext } from 'react'
import { CauslContext } from './context.js'
import { useCausl } from './useCausl.js'

/**
 * Backward-compatible alias for the canonical `ResourceState<T>` from
 * `@causl/sync`. The previous shape was a structurally-incompatible
 * fork that invented `promise?` on `loading` and dropped `origin:
 * GraphTime` / `loadedAt` / `erroredAt`; consumers that only checked
 * the tag continue to type-check, while the engine-anchored fields
 * (`origin`, `loadedAt`, `erroredAt`, `promise`) are now visible to
 * them.
 */
export type SuspendableResource<T> = ResourceState<T>

/**
 * Per-graph cache of the Promise thrown for the `idle` state. Identity
 * is what makes Suspense behave: SuspenseList ordering, transition
 * cached-value display, and hydration-warning suppression all key off
 * Promise identity across renders. A WeakMap keys the Promise on the
 * graph identity so the Promise is shared across every render that
 * sees an `idle` resource on that graph and gets garbage-collected
 * with the graph itself.
 *
 * The Promise resolves on the next commit; subsequent renders observe
 * the new state (loading/loaded/etc.) and select a different arm.
 */
const idlePromiseByGraph = new WeakMap<Graph, Promise<unknown>>()

/**
 * Returns the identity-stable Promise to throw when an `idle` resource
 * is observed on `graph`. The Promise resolves the next time `graph`
 * commits; at resolution the cache entry is cleared so the next idle
 * observation (should one occur — typically the resource has moved to
 * `loading` by then) creates a fresh Promise tied to the next commit.
 */
function idlePromiseFor(graph: Graph): Promise<unknown> {
  const cached = idlePromiseByGraph.get(graph)
  if (cached) return cached
  const promise = new Promise<unknown>((resolve) => {
    const unsubscribe = graph.subscribeCommits(() => {
      idlePromiseByGraph.delete(graph)
      unsubscribe()
      resolve(undefined)
    })
  })
  idlePromiseByGraph.set(graph, promise)
  return promise
}

/**
 * Project a `ResourceState<T>` through a selector and return `T` —
 * throwing for Suspense or an error boundary as appropriate.
 *
 * The selector receives a {@link ReadOnlyGraph} (capability-narrowed
 * via `narrowCapability` at the `useCausl` boundary) — Mark
 * Miller's principle of least authority. A selector cannot reach
 * `commit` / `input` / `derived` / `exportModel`; the type narrowing
 * is the compile-time gate, the runtime Proxy throws
 * `CapabilityViolation` against `as any`-coerced leaks. See #229.
 */
export function useCauslSuspense<T>(
  selector: (graph: ReadOnlyGraph) => SuspendableResource<T>,
): T {
  // Pull the graph from context for the idle-Promise cache. The cache
  // keys on graph identity so multi-render in `idle` state throws the
  // same Promise reference (SPEC §9.1: Promise identity is engine- or
  // adapter-owned, never per-render-fabricated). The `loading` arm
  // throws `result.promise` directly — that one is engine-owned on
  // `ResourceState.loading`.
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCauslSuspense must be used inside <CauslProvider>')
  }
  const result = useCausl(selector)
  switch (result.state) {
    case 'loaded':
    case 'stale':
      return result.value
    case 'errored':
      // Throw the original error so error boundaries can catch.
      throw result.error
    case 'loading':
      // Engine-anchored Promise: identity-stable per loading episode.
      // No `??` fallback — `ResourceState.loading.promise` is a
      // required field on the canonical type.
      throw result.promise
    case 'idle':
      // Suspend, not error. The Promise resolves on the next commit
      // and is identity-stable across renders for the same graph.
      throw idlePromiseFor(ctx.graph)
    default:
      // Exhaustiveness gate — if a new tag is added to ResourceState,
      // this fails to type-check.
      return assertNever(result)
  }
}
