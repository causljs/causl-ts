/**
 * @packageDocumentation
 *
 * React provider component for `@causljs/react`. `<CauslProvider>`
 * wraps a subtree, accepting a host-constructed {@link Graph} and an
 * optional MVU {@link Update} runner, and routes both through
 * {@link CauslContext}. The provider deliberately does not own the
 * graph — lifecycle, disposal, and replacement remain with the host —
 * so React-side mounting and unmounting cannot cause engine state to
 * be lost between renders. The context value is memoised so
 * referential identity changes only when the inputs do, which keeps
 * `useSyncExternalStore` callers from re-subscribing on every render.
 */

import type { Graph } from '@causljs/core'
import type { JSX, ReactNode } from 'react'
import { useMemo } from 'react'
import {
  CauslContext,
  type FamilyEntry,
  type CauslContextValue,
} from './context.js'
import type { Update } from './update.js'

/**
 * Props for {@link CauslProvider}.
 *
 * @typeParam Msg - The application's message union when an `update`
 * runner is supplied; defaults to `unknown` for read-only setups.
 *
 * @remarks
 * The explicit `| undefined` on `update` is required under
 * `exactOptionalPropertyTypes: true` so callers can pass
 * `update={maybeUndefined}` without a TypeScript error.
 */
export interface CauslProviderProps<Msg = unknown> {
  readonly graph: Graph
  /**
   * Optional MVU runner. Note the explicit `| undefined` — required
   * with `exactOptionalPropertyTypes: true` to allow the prop to be
   * passed as `update={maybeUndefined}` cleanly.
   */
  readonly update?: Update<Msg, Graph> | undefined
  readonly children: ReactNode
}

/**
 * Provides the engine and an optional MVU runner to its subtree.
 *
 * @typeParam Msg - The application message union accepted by `update`.
 *
 * @param props - The provider props; see {@link CauslProviderProps}.
 * @returns A React element wrapping `children` in {@link CauslContext.Provider}.
 *
 * @remarks
 * The provider does not own the graph — host code constructs and
 * disposes it; the provider only routes the handle. The context value
 * is wrapped in `useMemo` so that consumer hooks do not see a fresh
 * object reference unless `graph` or `update` actually change.
 *
 * @example
 * ```tsx
 * <CauslProvider graph={graph} update={update}>
 *   <App />
 * </CauslProvider>
 * ```
 *
 * @see {@link CauslContext}
 * @see {@link useCausl}
 * @see {@link useDispatch}
 */
export function CauslProvider<Msg = unknown>(
  props: CauslProviderProps<Msg>,
): JSX.Element {
  const { graph, update, children } = props
  // One family registry per provider mount. Using `useMemo` with the
  // graph as the only dep keeps the same map across renders of this
  // provider but discards it if the host swaps the graph handle —
  // the new graph gets a fresh namespace, no leak from the old one.
  const families = useMemo<Map<string, FamilyEntry>>(() => new Map(), [graph])
  // Context-value memoisation: rebuild only when the graph handle or
  // the update runner identity changes. The conditional spread keeps
  // the `update` key absent (rather than `undefined`) when no runner
  // is supplied, matching the optional-property contract on the
  // context value type.
  const value = useMemo<CauslContextValue<Msg>>(
    () =>
      update
        ? { graph, update, families }
        : { graph, families },
    [graph, update, families],
  )
  // Context plumbing: widen the Msg-parametric value to `unknown` at
  // the boundary so each consumer hook can refine Msg independently
  // without forcing a single Msg union onto the provider call site.
  return (
    <CauslContext.Provider value={value as CauslContextValue<unknown>}>
      {children}
    </CauslContext.Provider>
  )
}
