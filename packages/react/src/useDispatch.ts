/**
 * @packageDocumentation
 *
 * Dispatch hook for `@causl/react`. {@link useDispatch} is the
 * read-write companion to {@link useCausl}: it returns a
 * referentially-stable function that forwards application messages
 * into the MVU runner installed on the surrounding
 * `<CauslProvider>`. Each invocation flows through that runner,
 * which is responsible for issuing exactly one `graph.commit(...)`.
 *
 * Commits are the only way time advances. Outside a commit the graph
 * is read-only; inside a commit, reads see staged writes; outside,
 * reads see the previous committed snapshot. Each `commit` produces
 * exactly one new `GraphTime`, which is what triggers the subscription
 * channel that `useCausl` listens on. The runner is the seam where
 * a `Msg` is translated into that single discrete event.
 */

import { useCallback, useContext } from 'react'
import { CauslContext } from './context.js'

/**
 * Function shape returned by {@link useDispatch}.
 *
 * @typeParam Msg - The application's message union.
 */
export type Dispatch<Msg> = (msg: Msg) => void

/**
 * Hook returning a dispatcher for the application's `Msg` union.
 *
 * @typeParam Msg - The application's message union.
 *
 * @returns A stable dispatcher; identity changes only when the graph
 * handle or the `update` runner identity changes on the surrounding
 * provider.
 * @throws Error when called outside `<CauslProvider>`, or when the
 * provider was not configured with an `update` runner.
 *
 * @remarks
 * The provider must be configured with an `update` function (see
 * {@link CauslProviderProps}). If it is not, calling the dispatcher
 * throws — the throw is deferred to call time so a component can be
 * rendered under a read-only provider without crashing at mount.
 *
 * @example
 * ```tsx
 * const dispatch = useDispatch<Msg>()
 * return <button onClick={() => dispatch({ kind: 'edit-cell', ref, value })}>Save</button>
 * ```
 *
 * @see {@link useCausl}
 * @see {@link Update}
 */
export function useDispatch<Msg>(): Dispatch<Msg> {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useDispatch must be used inside <CauslProvider>')
  }
  const { graph, update } = ctx
  // Stable dispatcher: memoised against `graph` and `update` so
  // descendant components depending on dispatch identity (effect deps,
  // memo deps) do not churn every render. The `update`-missing check
  // runs at call time, not at render time, so a read-only provider
  // does not break component mount.
  return useCallback(
    (msg: Msg) => {
      if (!update) {
        throw new Error(
          'useDispatch called but no `update` function was supplied to <CauslProvider>',
        )
      }
      ;(update as (msg: Msg, g: typeof graph) => void)(msg, graph)
    },
    [graph, update],
  )
}
