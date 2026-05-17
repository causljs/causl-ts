/**
 * @packageDocumentation
 *
 * Shallow-equal variant of {@link useCausl}. Selectors that
 * compose a fresh object or array per call defeat the `Object.is`
 * dedup the engine relies on — every commit looks like a change
 * because the wrapper reference is new even when the contents have
 * not moved. This module supplies a hook that performs a one-level
 * structural comparison (top-level keys for plain objects, indices
 * for arrays) at the selector boundary, plus the underlying
 * {@link shallowEqual} primitive. Shape inspired by zustand's
 * `useShallow`.
 *
 *   const view = useCausl((g) => ({ a: g.read(a), b: g.read(b) }))
 */

import type { Graph } from '@causljs/core'
import { __causlAdapterRead, narrowCapability, type ReadOnlyGraph } from '@causljs/core/internal'
import { useCallback, useContext, useDebugValue, useMemo, useRef, useSyncExternalStore } from 'react'
import { CauslContext } from './context.js'

/**
 * A pure selector projecting a value from the engine.
 *
 * @typeParam T - The selector's return type.
 *
 * @remarks
 * The handle is a {@link ReadOnlyGraph} — capability-narrowed at the
 * adapter boundary so the selector cannot reach `commit` / `input` /
 * `derived` / `exportModel`. See #229.
 */
export type Selector<T> = (graph: ReadOnlyGraph) => T

/**
 * Subscribe to a slice of the graph with shallow-equal dedup.
 *
 * @typeParam T - The selector's return type, typically an object or
 * array literal composed inside the selector.
 *
 * @param selector - Pure projection from the current `Graph` to the
 * value the component cares about.
 * @returns The currently-selected value; changes between renders only
 * when {@link shallowEqual} reports a difference against the previous
 * return.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Use this in place of {@link useCausl} when the selector returns
 * a freshly-constructed wrapper that would otherwise force a render
 * on every commit. The cache is invalidated if the host swaps the
 * graph handle on the provider.
 *
 * @example
 * ```tsx
 * const { a, b } = useCauslShallow((g) => ({
 *   a: g.read(aNode),
 *   b: g.read(bNode),
 * }))
 * ```
 *
 * @see {@link useCausl}
 * @see {@link shallowEqual}
 */
export function useCauslShallow<T>(selector: Selector<T>): T {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCauslShallow must be used inside <CauslProvider>')
  }
  const { graph } = ctx
  // Narrow to a ReadOnlyGraph at the boundary (#229). Same Proxy
  // pattern as `useCausl`; `useMemo` keyed on `graph` keeps the
  // wrapper stable across renders.
  const cap = useMemo(() => narrowCapability(graph), [graph])
  // Cached snapshot tracking: same shape as `useCausl`, but the
  // equality predicate below is structural rather than identity-based.
  const lastValue = useRef<{ value: T; from: Graph } | null>(null)

  // Subscribe side of useSyncExternalStore: forward every commit on
  // the engine's commit log to React. Memoised on `graph` so the
  // subscription is recreated only on engine handle swaps.
  const subscribe = useCallback(
    (onChange: () => void) => graph.subscribeCommits(() => onChange()),
    [graph],
  )

  // getSnapshot side of useSyncExternalStore: re-run the selector,
  // then return the previous reference when shallowEqual succeeds.
  // A stable reference per `GraphTime` is the mechanism that keeps
  // concurrent renders coherent and prevents tearing under strict
  // mode's double invocation.
  //
  // #1241 — wrap the selector in `__causlAdapterRead` to keep
  // `graph.read(...)` calls outside the opt-in H1 hazard tracker.
  // The `useSyncExternalStore` snapshot-retention contract would
  // otherwise produce a false-positive warning on every commit.
  // The seam is a no-op in production builds (tree-shaken with the
  // rest of the H1 apparatus).
  const getSnapshot = useCallback((): T => {
    return __causlAdapterRead(graph, () => {
      const next = selector(cap)
      if (lastValue.current && lastValue.current.from === graph) {
        if (shallowEqual(lastValue.current.value, next)) {
          return lastValue.current.value
        }
      }
      lastValue.current = { value: next, from: graph }
      return next
    })
  }, [graph, cap, selector])

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useDebugValue(value)
  return value
}

/**
 * One-level structural equality predicate.
 *
 * @typeParam T - The compared value type.
 *
 * @param a - First value to compare.
 * @param b - Second value to compare.
 * @returns `true` when the values are `Object.is`-equal, or are
 * arrays of equal length whose indices are pairwise `Object.is`-equal,
 * or are plain objects with the same own-key set whose values are
 * pairwise `Object.is`-equal; otherwise `false`.
 *
 * @remarks
 * The predicate is intentionally one level deep — nested objects are
 * compared by reference. That matches the dedup contract: callers who
 * need deeper structural equality should pre-normalise inside the
 * selector or memoise the deeper structures elsewhere.
 *
 * @example
 * ```ts
 * shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 }) // true
 * shallowEqual([1, 2, 3], [1, 2, 3])           // true
 * shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }) // false (nested ref differs)
 * ```
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null) return false
  if (typeof b !== 'object' || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false
    }
    return true
  }
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false
    }
  }
  return true
}
