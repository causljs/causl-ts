/**
 * @packageDocumentation
 *
 * `useCauslFamily(key, factory)` — parameterised node lifecycle for
 * virtualised rows and other "one node per identity" patterns. Closes
 * Adoption-gap #1 (Jotai's `atomFamily`): a hook that returns a stable
 * `Node<T>` per `key`, identity-shared across consumers within the
 * same `<CauslProvider>`, and disposed when the last consumer
 * unmounts.
 *
 * The first mount of a key invokes the factory; subsequent mounts
 * return the cached node without re-invoking. Disposal is deferred
 * via microtask: when refcount drops to zero, disposal is scheduled
 * for the next microtask rather than running immediately. If a
 * re-mount increments refcount before the microtask fires, disposal
 * is cancelled — that is what makes the hook StrictMode-double-mount
 * safe.
 *
 * The hook returns a `Node<T>`, not a value. Reading the node is a
 * separate `useCausl(graph => graph.read(node))` call, preserving
 * the MVU split between selector-driven subscription and dispatch:
 * the family hook owns identity and lifetime, {@link useCausl}
 * owns the snapshot, and {@link useDispatch} owns mutation.
 *
 * @remarks
 * The registry is per-provider (carried on {@link CauslContext}),
 * not module-global: two `<CauslProvider>` instances in the same
 * tree maintain isolated family namespaces, so a key collision in one
 * provider does not leak a node into the other.
 *
 * Disposal goes through `@causl/core/internal`'s `dispose` rather
 * than a method on the public {@link Graph} interface. The engine's
 * canonical public surface is a small, load-bearing set of primitives
 * the engine cannot exist without; "this node's lifetime is bounded
 * by a component's mount" is an adapter-level concern, not a primitive
 * application code should reach for, so the dispose primitive lives
 * behind the `@causl/core/internal` entrypoint and is not covered
 * by the public package's SemVer guarantees. Routing through the
 * internal entrypoint keeps the public surface honest — a
 * leading-underscore method on `Graph` would still be public — and
 * confines the lifecycle responsibility to the React adapter, which
 * is the only layer that owns the "component mount" concept.
 */

import type { Graph, Node } from '@causl/core'
import { dispose } from '@causl/core/internal'
import { useContext, useEffect } from 'react'
import { CauslContext } from './context.js'

/**
 * Capability handed to a {@link FamilyFactory}. Closes #257 (capability
 * narrowing across factory/selector seams): a factory exists to
 * register one node per key, so it gets `input` + `derived` and
 * nothing else.
 *
 * The narrowing is structural — a real `Graph` is assignable to
 * `FamilyGraph`, but a factory cannot reach back into the engine for
 * `commit`, `read`, `hydrate`, `snapshot`, `exportModel`,
 * `subscribeCommits`, or any other authority outside its registration
 * job. `read` is intentionally excluded: a derived node has its own
 * `get`-tracked accessor inside the compute closure, and a factory
 * that reads outside that closure would observe a snapshot at the
 * wrong time and break dynamic-dependency tracking. SPEC §12.3
 * "smallest interface a consumer needs"; PR #205 introduced the same
 * lens for the test-seam `narrowCapability`. This is the production-
 * code analogue, applied at the type level so the discipline holds at
 * compile time rather than depending on a runtime Proxy.
 */
export type FamilyGraph = Pick<Graph, 'input' | 'derived'>

/**
 * Factory that produces (and registers, via `graph.input` /
 * `graph.derived`) a node for a given `key`.
 *
 * @typeParam T - Value type of the node the factory returns.
 * @param graph - The provider-scoped engine handle, narrowed to the
 *  registration capability ({@link FamilyGraph}). The factory is
 *  expected to call `graph.input(...)` or `graph.derived(...)`
 *  exactly once and return the resulting handle. Methods outside the
 *  narrow surface (`commit`, `hydrate`, `snapshot`, `subscribeCommits`,
 *  …) are intentionally unreachable from here — they are not the
 *  factory's responsibility.
 * @param key - The keying identity passed to the hook.
 * @returns The freshly-registered node handle.
 */
export type FamilyFactory<T> = (graph: FamilyGraph, key: string) => Node<T>

/**
 * Returns a stable `Node<T>` for `key` within the enclosing
 * `<CauslProvider>`. The factory runs once per key per provider;
 * subsequent mounts of the same key return the cached handle. The
 * node is disposed via `@causl/core/internal`'s `dispose` when the
 * last consumer unmounts (deferred to the next microtask so
 * StrictMode's double-invoke does not destroy and recreate the node).
 *
 * @typeParam T - Value type of the node the factory produces.
 * @param key - Keying identity. Identity is per-(provider, key); two
 *  providers around the same graph maintain isolated namespaces.
 * @param factory - Producer that constructs and registers the node
 *  the first time `key` is seen in this provider.
 * @returns The cached or freshly-registered node handle for `key`.
 *
 * @throws Error when called outside a `<CauslProvider>`.
 *
 * @example
 * ```tsx
 * const node = useCauslFamily(`row:${rowId}`, (graph, key) =>
 *   graph.input(key, defaultRow),
 * )
 * const value = useCausl((g) => g.read(node))
 * ```
 *
 * @see {@link FamilyFactory}
 * @see {@link CauslContext}
 */
export function useCauslFamily<T>(
  key: string,
  factory: FamilyFactory<T>,
): Node<T> {
  // Reject use outside a provider — no registry to write into.
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCauslFamily must be used inside <CauslProvider>')
  }
  const { graph, families } = ctx

  // Resolve at render time. If no entry exists for this key, run the
  // factory once and seed a refcount-zero entry; the mount-effect bumps
  // the count, and the unmount cleanup decrements it (and schedules a
  // deferred dispose if the count hits zero).
  let entry = families.get(key)
  if (!entry) {
    const node = factory(graph, key) as Node<unknown>
    entry = { node, refcount: 0 }
    families.set(key, entry)
  }
  const resolved = entry

  // Lifecycle: bump refcount on mount, decrement on unmount. Disposal
  // runs in a microtask so a StrictMode double-invoke can cancel it
  // before the engine releases the node.
  useEffect(() => {
    const e = families.get(key)
    if (!e) return
    e.refcount++
    return () => {
      e.refcount--
      if (e.refcount <= 0) {
        // Defer disposal — if the same key mounts again before the
        // microtask runs (the StrictMode case), the refcount will be
        // back above zero and the dispose call is skipped.
        queueMicrotask(() => {
          if (e.refcount <= 0 && families.get(key) === e) {
            families.delete(key)
            dispose(graph, e.node)
          }
        })
      }
    }
  }, [graph, families, key])

  return resolved.node as Node<T>
}
