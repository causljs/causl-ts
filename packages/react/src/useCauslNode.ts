/**
 * @packageDocumentation
 *
 * Per-node subscription hook for `@causl/react`. {@link useCauslNode}
 * binds a single {@link Node} to React via `graph.subscribe(node, cb)`
 * so the component re-renders ONLY when that node's value changes —
 * not on every commit to the graph.
 *
 * This is the per-node subscription path introduced in #677. The
 * selector-based {@link useCausl} hook subscribes to every commit via
 * `subscribeCommits`, then deduplicates at the selector boundary with
 * `Object.is`. `useCauslNode` takes the complementary approach: it
 * subscribes at the engine level to a single node so React's `onChange`
 * never fires for unrelated commits. The engine already applies an
 * `Object.is` equality cutoff before notifying per-node subscribers, so
 * no additional dedup logic is needed here.
 *
 * Performance note: the e2e dropped-frames gate (≤ 5% over 30s on a
 * 1000-cell viewport at 60Hz, plus p95 commit-to-paint ≤ 16ms) shipped
 * in #765 once #738 + #777 hit the underlying ≤ 5.5ms commit bench
 * number from #671. The Playwright spec lives at
 * `packages/react/e2e/tests/dropped-frames-1000.spec.ts`.
 */

import type { Node } from '@causl/core'
import { __causlAdapterRead } from '@causl/core/internal'
import { useCallback, useContext, useDebugValue, useSyncExternalStore } from 'react'
import { CauslContext } from './context.js'

/**
 * Subscribe to a single graph node.
 *
 * @typeParam T - Value type of the observed node.
 *
 * @param node - The input or derived node to subscribe to. The component
 * re-renders only when this node's value changes — unrelated commits do
 * not trigger a re-render.
 * @returns The node's current committed value.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Backed by `useSyncExternalStore` for concurrent-render safety. The
 * subscription is via `graph.subscribe(node, cb)`, which the engine fires
 * exactly once per commit during which the node's value changed (with the
 * engine's own `Object.is` equality cutoff applied). This is more
 * efficient than the selector-based {@link useCausl} for components that
 * read a single node because React's `onChange` is never invoked for
 * commits that do not touch the subscribed node.
 *
 * For multi-node projections, use {@link useCausl} with a selector.
 *
 * @example
 * ```tsx
 * const total = useCauslNode(totalNode)
 * ```
 *
 * @see {@link useCausl}
 */
export function useCauslNode<T>(node: Node<T>): T {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCauslNode must be used inside <CauslProvider>')
  }
  const { graph } = ctx

  // Subscribe side of useSyncExternalStore: use graph.subscribe(node, cb)
  // so React's onChange only fires when this specific node's value changes.
  // The engine applies its own Object.is cutoff before notifying subscribers,
  // so a commit that writes the same value to this node does not trigger a
  // re-render. Memoised on both graph and node so the subscription is
  // recreated only when the engine handle or node identity changes.
  const subscribe = useCallback(
    (onChange: () => void) => graph.subscribe(node, () => onChange()),
    [graph, node],
  )

  // getSnapshot side of useSyncExternalStore: read the node's current
  // committed value. React calls this during render and after every
  // onChange notification. Because onChange only fires when the node's
  // value actually changed, this read always returns a fresh value.
  //
  // #1241 — the read is wrapped in `__causlAdapterRead` so the opt-in
  // H1 hazard tracker skips it. `useSyncExternalStore` retains the
  // last snapshot reference across commits for tearing detection;
  // that retention is intrinsic to the adapter contract, not an
  // adopter bug, so the hazard tracker must NOT flag it. The seam is
  // a no-op in production builds (tree-shaken with the rest of the H1
  // apparatus).
  const getSnapshot = useCallback(
    (): T => __causlAdapterRead(graph, () => graph.read(node)),
    [graph, node],
  )

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useDebugValue(value)
  return value
}
