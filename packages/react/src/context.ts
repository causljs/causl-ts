/**
 * @packageDocumentation
 *
 * React context plumbing for `@causljs/react`. A single context object
 * carries the engine handle (`Graph`) and an optional MVU `update`
 * runner from `<CauslProvider>` down to consumer hooks
 * (`useCausl`, `useCauslShallow`, `useDispatch`). The context
 * value itself is intentionally minimal — it is the routing layer, not
 * a store, so referential stability of the value is governed by the
 * provider's `useMemo` and is independent of commit traffic on the
 * underlying graph.
 */

import type { Graph, Node } from '@causljs/core'
import { createContext } from 'react'
import type { Update } from './update.js'

/**
 * Bookkeeping for one entry in the per-provider family registry used
 * by {@link useCauslFamily}. Tracks the node handle returned by
 * the factory and a refcount that tallies live consumers; when the
 * count returns to zero, the hook schedules disposal via
 * `@causljs/core/internal`'s `dispose`.
 *
 * @remarks
 * Exported only so {@link CauslContextValue} can carry the typed
 * registry. Treat as internal — adapter authors should not consult
 * the entry directly.
 *
 * @internal
 */
export interface FamilyEntry {
  readonly node: Node<unknown>
  refcount: number
}

/**
 * Shape of the value travelling through {@link CauslContext}.
 *
 * @typeParam Msg - The application's message union, when an `update`
 * runner has been wired up. Defaults to `unknown` so the context can be
 * created without committing to a specific Msg type at the
 * module-creation site.
 *
 * @remarks
 * `update` is optional: a provider may supply a graph for read-only
 * subscription consumers without also installing a dispatch surface.
 * Hooks that need dispatch (see {@link useDispatch}) throw a
 * descriptive error when `update` is absent.
 */
export interface CauslContextValue<Msg = unknown> {
  readonly graph: Graph
  readonly update?: Update<Msg, Graph> | undefined
  /**
   * Per-provider registry consumed by {@link useCauslFamily}. Each
   * `<CauslProvider>` mount owns a fresh map so two providers
   * around the same graph keep their own family namespaces; nodes are
   * not shared by accident.
   *
   * @remarks
   * The map is mutable in place — refcount increments and decrements
   * happen during effect cleanup, so the reference itself is stable
   * across renders.
   *
   * @internal
   */
  readonly families: Map<string, FamilyEntry>
}

/**
 * The single context that carries the engine into the React tree.
 *
 * @remarks
 * A `null` default signals "no Provider above this consumer"; the
 * hooks check for that sentinel and throw a descriptive error. The
 * value is widened to `CauslContextValue<unknown>` at the context
 * boundary so that every consumer can refine `Msg` independently with
 * a generic hook call without forcing a single Msg union onto the
 * context creation site.
 *
 * @see {@link CauslProvider}
 * @see {@link useCausl}
 * @see {@link useDispatch}
 */
export const CauslContext = createContext<CauslContextValue<unknown> | null>(null)
CauslContext.displayName = 'CauslContext'
