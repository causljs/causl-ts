/**
 * @packageDocumentation
 *
 * Engine-side registry for test-only seams. Mirrors the shape of
 * `internal-dispatch.ts` (the adapter-facing seam used by `dispose`)
 * but is kept strictly separate so adapter code never reaches it: the
 * production `@causljs/core/internal` entrypoint exposes adapter
 * primitives, while this registry is consumed only by the
 * `@causljs/core-testing-internal` package surfaced as
 * `@causljs/core/testing`. Splitting the two registries keeps §12.3
 * honest — the adapter surface does not grow rows whose justification
 * begins "adapter code has no production use for it" (#376).
 *
 * @remarks
 * This module is not listed in the package's `exports` field; the
 * testing seam reaches it via a relative import from inside the same
 * package directory tree (`packages/core/testing/src/...`). Keeping
 * the registry in `src/` (rather than under `testing/`) preserves the
 * engine closure boundary: only `graph.ts` registers, and the testing
 * helpers only read.
 */

import type { Graph, NodeId } from './types.js';

/**
 * Test-only operations the engine publishes for property suites and
 * cross-package conformance harnesses. The interface is intentionally
 * small — every entry is justified by a named test consumer, the same
 * discipline `InternalDispatch` applies to adapter primitives.
 *
 * @internal
 */
export interface TestingDispatch {
  /**
   * Live size of the disposed-tombstone ring. The ring is bounded by
   * `disposedTombstoneCap` (default 1000); the property suite for
   * #251 (`disposed-tombstone-bound.test.ts`) asserts the returned
   * value never exceeds the cap across arbitrary unique-id churn.
   * Adapter code has no production use for this number — it lives
   * here, behind the testing seam, because the underlying retention
   * is engine-internal hygiene, not a contract surface.
   */
  readonly disposedTombstoneSize: () => number;
  /**
   * Live count of registered `commitLog` consumers (#715
   * follow-up). A consumer is any one of: a
   * `subscribe(graph.commitLog, …)` registration, a
   * `commitMetadataDerived(...)` registration, or a plain
   * `derived(...)` whose recorded read-set includes the engine-
   * owned `COMMIT_LOG_ID`. The count gates Phase F.4's
   * per-commit rebuild of `commitLogEntry.value`: when zero,
   * the rebuild is dead work and the bounded ring (Phase F)
   * still keeps history warm. Test code asserts this counter
   * to pin the gate without inspecting engine internals.
   */
  readonly commitLogConsumerCount: () => number;
  /**
   * Live `deps` Set the engine stores on the {@link DerivedEntry} for
   * `id`. Returns `null` for unregistered ids and for input ids
   * (inputs have no deps). The returned reference is the engine's
   * own Set instance — `setDeps` swaps the reference on a dep-shift
   * rather than mutating in place, so a captured value is the
   * structurally-correct snapshot of the read-set at capture time.
   *
   * @remarks
   * #703 Win 3 property test (`setDeps-immutability.test.ts`):
   * captured Sets must NEVER be mutated by subsequent commits — that
   * is the load-bearing invariant which makes the audit's "skip the
   * `new Set(e.deps)` clone" optimisation sound. Application /
   * adapter code does not consume this seam; the test surface owns
   * the only justified consumer.
   */
  readonly derivedDeps: (id: NodeId) => ReadonlySet<NodeId> | null;
}

// Parallel registry to `internal-dispatch`'s, keyed weakly so a
// discarded graph and its testing entry are collected together. The
// graph handle is the identity key because that is what test code
// already holds.
const registry = new WeakMap<Graph, TestingDispatch>();

/**
 * Engine-side hook used by `createCausl` to publish its testing
 * dispatch under the returned graph handle. Calling this from outside
 * `graph.ts` would silently overwrite the engine's registration; the
 * function is exported only because `graph.ts` and the testing seam
 * helpers need a shared lookup table.
 *
 * @param graph - The handle returned by `createCausl`.
 * @param dispatch - The engine's test-only operations.
 *
 * @internal
 */
export function registerTestingDispatch(
  graph: Graph,
  dispatch: TestingDispatch,
): void {
  registry.set(graph, dispatch);
}

/**
 * Dispatch lookup used by the testing seam helpers. Throws if the
 * graph was not produced by `createCausl` — test code passing a
 * foreign object gets a typed failure rather than a silent no-op.
 *
 * @param graph - The handle whose testing dispatch should be retrieved.
 * @returns The engine's test-only operations for `graph`.
 * @throws Error when `graph` was not produced by `createCausl`.
 *
 * @internal
 */
export function lookupTestingDispatch(graph: Graph): TestingDispatch {
  const d = registry.get(graph);
  if (!d) {
    throw new Error(
      'Graph was not produced by createCausl() — testing dispatch unavailable. ' +
        'Did you pass an unrelated object to an @causljs/core/testing helper?',
    );
  }
  return d;
}
