/**
 * @packageDocumentation
 *
 * Primary subscription hook for `@causl/react`. {@link useCausl}
 * binds a selector over the {@link Graph} to React's
 * `useSyncExternalStore`, providing concurrent-render-safe reads with
 * a `GraphTime`-consistent snapshot per render. Re-renders are gated
 * by an `Object.is` comparison at the selector boundary so that
 * commits not affecting the selected slice do not propagate. Selector
 * results are cached against the current graph identity to keep
 * referential stability across re-evaluations triggered by React
 * (strict-mode double invocation, concurrent retries).
 */

import type { Graph } from '@causl/core'
import { __causlAdapterRead, narrowCapability, type ReadOnlyGraph } from '@causl/core/internal'
import { useCallback, useContext, useDebugValue, useMemo, useRef, useSyncExternalStore } from 'react'
import { CauslContext } from './context.js'

/**
 * A pure selector projecting a value from the engine.
 *
 * @typeParam T - The selector's return type.
 *
 * @remarks
 * Selectors must be pure and read only through the supplied `graph`
 * handle. The denotational model treats every value as a
 * `Behavior a := GraphTime → a`, and a derived value at time `t` is a
 * pure function of its inputs at the same time `t`: there is no
 * intermediate "B updated but C did not" state because there is no
 * intermediate time. Reading from anywhere other than the supplied
 * handle (or smuggling state in via closure that doesn't go through
 * the engine) breaks that invariant — two slices read in one render
 * could observe inconsistent `GraphTime`s and the selector would
 * return a glitched value.
 *
 * The handle passed in is a {@link ReadOnlyGraph} — Mark Miller's
 * principle of least authority applied at the React boundary. The
 * selector cannot reach `commit`, `input`, `derived`, or
 * `exportModel`; any attempt throws `CapabilityViolation` from
 * `@causl/core/internal` (the type narrowing forbids it at compile
 * time, the Proxy enforces it at runtime against `as any` coerced
 * leaks). See #229.
 */
export type Selector<T> = (graph: ReadOnlyGraph) => T

/**
 * Subscribe to a slice of the graph.
 *
 * @typeParam T - The selector's return type.
 *
 * @param selector - Pure projection from the current `Graph` to the
 * value the component cares about.
 * @returns The currently-selected value; changes between renders only
 * when the selector returns a value not `Object.is`-equal to the
 * previous return.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Backed by `useSyncExternalStore` so React 18 concurrent rendering
 * and strict-mode double-invocation behave correctly. The subscription
 * is to the graph's commit log — the engine exposes the transaction
 * log as a `Behavior [Commit]` queryable through the same primitives
 * as any other graph value, and `subscribeCommits` is the narrow
 * notification capability built on top of it. Every commit is a
 * candidate for re-evaluation; the `Object.is` dedup at the selector
 * boundary prevents unrelated commits from causing a render.
 *
 * For selectors returning fresh objects or arrays per call, prefer
 * {@link useCauslShallow} so structurally-equal returns do not
 * defeat the dedup.
 *
 * @example
 * ```tsx
 * const sum = useCausl((g) => g.read(sumNode))
 * ```
 *
 * @see {@link useCauslShallow}
 * @see {@link useDispatch}
 */
export function useCausl<T>(selector: Selector<T>): T {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCausl must be used inside <CauslProvider>')
  }
  const { graph } = ctx
  // Narrow the engine handle to a ReadOnlyGraph at the boundary
  // (#229). Selectors are read-side application code; they should not
  // be able to reach `commit` / `input` / `derived` / `exportModel`
  // ambient authority. The Proxy is constructed once per graph
  // identity — `useMemo` keyed on `graph` keeps the wrapper stable
  // across renders so that selector reference equality (and the
  // `useSyncExternalStore` subscribe/getSnapshot identity below) is
  // unaffected.
  const cap = useMemo(() => narrowCapability(graph), [graph])
  // Cached snapshot tracking: holds the most recently returned value
  // along with the graph identity it was selected from. The `from`
  // tag invalidates the cache if the host swaps the graph handle on
  // the provider mid-life.
  const lastValue = useRef<{ value: T; from: Graph } | null>(null)

  // Subscribe side of useSyncExternalStore: forward every commit on
  // the engine's commit log to React's onChange. Memoised on `graph`
  // so React only re-subscribes when the engine handle itself
  // changes, not on every render. Subscribed via the full graph
  // (not the narrowed cap) because the hook is itself the adapter
  // boundary that owns the subscription lifecycle.
  const subscribe = useCallback(
    (onChange: () => void) => graph.subscribeCommits(() => onChange()),
    [graph],
  )

  // getSnapshot side of useSyncExternalStore: re-run the selector,
  // then return the previous reference if the new value is
  // Object.is-equal. React calls this both during render and during
  // store-change callbacks; a stable reference is the mechanism that
  // gives concurrent-render `GraphTime` consistency and prevents
  // tearing across the double-invocation protocol in strict mode.
  //
  // #1241 — the selector body is wrapped in `__causlAdapterRead` so
  // any `graph.read(...)` calls it issues bypass the opt-in H1
  // hazard tracker. `useSyncExternalStore` retains the last snapshot
  // reference across commits for tearing detection; flagging that
  // retention as an H1 hazard would be a false positive (the
  // retention is intrinsic to the adapter contract, not an adopter
  // bug). The seam is a no-op in production builds (tree-shaken
  // with the rest of the H1 apparatus).
  const getSnapshot = useCallback((): T => {
    return __causlAdapterRead(graph, () => {
      const next = selector(cap)
      if (lastValue.current && lastValue.current.from === graph) {
        if (Object.is(lastValue.current.value, next)) {
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
