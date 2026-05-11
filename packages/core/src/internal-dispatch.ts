/**
 * @packageDocumentation
 *
 * Private-to-`@causl/core` registry that bridges the engine closure
 * (in `graph.ts`) and the publicly-importable `@causl/core/internal`
 * entrypoint (in `internal.ts`). The bridge keeps adapter primitives
 * (e.g., `dispose`) callable from outside the engine without leaking
 * them onto the public {@link Graph} interface in `types.ts`.
 *
 * @remarks
 * Application code does not import this file (it is not in the
 * package's `exports`). The shape lives here, separate from
 * `internal.ts`, so the engine can register dispatch entries without
 * pulling in the public-but-internal entrypoint module. Like every
 * surface behind `@causl/core/internal`, this module is excluded
 * from the public-method commitment and carries no SemVer guarantee.
 */

import type { Graph, GraphSnapshot, Node } from './types.js';

/**
 * Adapter-layer operations that need engine-closure access. The shape
 * grows as new internal primitives accrete; each addition is recorded
 * alongside the named adapter consumer that justifies it (the disposal
 * hook below, for instance, is owned by `@causl/react`'s
 * `useCauslFamily` lifecycle).
 *
 * @internal
 */
export interface InternalDispatch {
  /**
   * Adapter-layer disposal hook. Removes `node` from the engine
   * registry, drops its dep / dependent edges, cancels matching
   * subscriptions, and records the disposal time so subsequent access
   * through the public surface throws `NodeDisposedError`. Idempotent.
   */
  readonly dispose: (node: Node<unknown>) => void;
  /**
   * Migration hydrate (issue #1090). Applies a {@link GraphSnapshot}
   * to a fresh graph WITHOUT publishing the synthetic `'hydrate'`
   * commit record `Graph.hydrate` appends. Reachable only through
   * `@causl/core/internal`'s `_migrateFrom(graph, snap)` helper;
   * adopters use `Graph.hydrate` for the documented SSR-restore path.
   *
   * Used by the WASM auto-adapt wrapper and the cross-backend
   * determinism property test (`packages/core/test/properties/
   * cross-backend-determinism.property.test.ts`) so the migration
   * matrix can compare literal IR byte-equality against an (N+M)-
   * commit pure-TS baseline that has no `'hydrate'` entry. See
   * `Graph._migrateFrom`'s docstring in `./graph.ts` for the
   * precondition (`now === 0` and no commit history) and the
   * preserved §3 monotonicity argument.
   */
  readonly _migrateFrom: (snap: GraphSnapshot) => void;
}

// One registry, keyed weakly so a discarded graph and its dispatch
// entry are collected together. The graph handle is the identity key
// because that is what adapter code already holds.
const registry = new WeakMap<Graph, InternalDispatch>();

/**
 * Engine-side hook used by `createCausl` to publish its internal
 * dispatch under the returned graph handle. Calling this from outside
 * `graph.ts` would silently overwrite the engine's registration; the
 * function is exported only because `graph.ts` and `internal.ts` live
 * in the same package and need a shared lookup table.
 *
 * @param graph - The handle returned by `createCausl`.
 * @param dispatch - The engine's adapter-facing operations.
 *
 * @internal
 */
export function registerInternalDispatch(
  graph: Graph,
  dispatch: InternalDispatch,
): void {
  registry.set(graph, dispatch);
}

/**
 * Dispatch lookup used by `internal.ts`. Throws if the graph was not
 * produced by `createCausl` — adapter code passing a foreign object
 * gets a typed failure rather than a silent no-op.
 *
 * @param graph - The handle whose dispatch should be retrieved.
 * @returns The engine's adapter-facing operations for `graph`.
 * @throws Error when `graph` was not produced by `createCausl`.
 *
 * @internal
 */
export function lookupInternalDispatch(graph: Graph): InternalDispatch {
  const d = registry.get(graph);
  if (!d) {
    throw new Error(
      'Graph was not produced by createCausl() — internal dispatch unavailable. ' +
        'Did you pass an unrelated object to an @causl/core/internal helper?',
    );
  }
  return d;
}
