/**
 * <Hydrate snapshot={…}> — applies a server-captured GraphSnapshot to
 * the engine before children commit (#130, #219).
 *
 * Usage (Next.js App Router):
 *
 *   // app/page.tsx (server component)
 *   const graph = createCausl()
 *   bootGraphFromDb(graph)
 *   const snapshot = graph.snapshot()
 *   return (
 *     <CauslProvider graph={clientGraph}>
 *       <Hydrate snapshot={snapshot}>
 *         <App />
 *       </Hydrate>
 *     </CauslProvider>
 *   )
 *
 * Channel choice — `useLayoutEffect`, not render-phase mutation. Render
 * bodies must be pure: a discarded `Suspense` / `startTransition`
 * render must not leave the engine hydrated for a commit that never
 * happened. `useLayoutEffect` runs synchronously after render but
 * before paint, so SSR HTML and the first client paint still observe
 * the same hydrated values, while render itself stays pure.
 *
 * Keying — `[ctx.graph]`. The guard is per (component-instance ×
 * graph-identity), not per-component-instance. Swapping the provider
 * graph re-arms hydration on the new graph; snapshot-prop churn
 * without a graph swap is a no-op (the engine's `hydrate` is
 * non-monotonic on `now`, so re-hydrating on every prop change would
 * drag GraphTime backward). The module-scoped `WeakMap` keyed by
 * `Graph` subsumes the per-instance `useRef<Graph|null>` keying
 * tried in #324: graph-identity is the contract boundary, so we
 * key off of it directly rather than off a component-instance ref
 * that doesn't survive StrictMode's mount/cleanup/remount cycle.
 *
 * StrictMode safety — under React 18 StrictMode, the layout effect
 * runs on mount, the cleanup runs, and the effect runs again on the
 * remount with a fresh component instance (refs reset). A
 * module-scoped `WeakMap<Graph, GraphSnapshot>` registry of pairs
 * already applied survives the cycle: the second remount finds the
 * pair recorded and short-circuits. Subscribers see exactly one
 * `Commit { intent: 'hydrate' }` per provider mount.
 */

import type { Graph, GraphSnapshot } from '@causljs/core'
import { useContext, useLayoutEffect, type JSX, type ReactNode } from 'react'
import { CauslContext } from './context.js'

export interface HydrateProps {
  readonly snapshot: GraphSnapshot
  readonly children: ReactNode
}

// Module-scoped registry of "(graph, snapshot) pairs we have already
// applied". A WeakMap keyed by Graph survives React 18 StrictMode's
// mount/cleanup/remount cycle (where the component is destroyed and a
// fresh instance — with fresh refs — is mounted): the Graph reference
// is stable across the cycle, so the second remount's effect finds the
// pair already recorded and skips re-applying. Component-instance
// `useRef` would not survive this cycle and the engine would emit two
// `intent: 'hydrate'` commits per provider mount.
//
// `WeakMap` lets a graph be garbage-collected once no other reference
// holds it; the registry never leaks across long-lived processes.
const hydratedSnapshotByGraph = new WeakMap<Graph, GraphSnapshot>()

export function Hydrate({ snapshot, children }: HydrateProps): JSX.Element {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('<Hydrate> must be used inside <CauslProvider>')
  }

  useLayoutEffect(() => {
    const g = ctx.graph
    // Already hydrated this exact (graph, snapshot) pair — skip. This
    // is the StrictMode-tear guard: the second mount in StrictMode's
    // mount/cleanup/remount cycle finds the pair recorded by the first
    // mount and short-circuits, so subscribers see exactly one
    // `intent: 'hydrate'` commit per provider mount.
    if (hydratedSnapshotByGraph.get(g) === snapshot) return
    g.hydrate(snapshot)
    hydratedSnapshotByGraph.set(g, snapshot)
    // Effect depends only on `ctx.graph`. Re-hydrating on snapshot-prop
    // change is forbidden by contract (snapshot consumed once per graph
    // identity); the dep array enforces that mechanically — the WeakMap
    // entry stays bound to the *first* snapshot applied to this graph.
    // (`snapshot` is intentionally omitted from the dep array.)
  }, [ctx.graph])

  return <>{children}</>
}
