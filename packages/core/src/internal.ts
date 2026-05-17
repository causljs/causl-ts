/**
 * @packageDocumentation
 *
 * Adapter-level escape hatch for the Causl engine. The exports here
 * sit outside the canonical seven-method commitment (createCausl,
 * input, derived, commit, read, subscribe, explain) and the second-tier
 * extensions (subscribeCommits, commitLog, exportModel, snapshot,
 * hydrate, readAt, snapshotAt, now). They exist for adapter
 * packages (`@causljs/react`, `@causljs/persistence`,
 * `@causljs/devtools-bridge`, …) that need engine-internal hooks the
 * application surface deliberately omits.
 *
 * @remarks
 * Application code MUST NOT import from `@causljs/core/internal`. The
 * surface here exists on the engine for adapter use but is NOT part of
 * the public-method commitment, NOT documented in the public README,
 * and NOT covered by SemVer guarantees on the `@causljs/core` public
 * exports. Adapters that import from here vendor that risk and pin a
 * tight version range.
 *
 * The module is intentionally narrow. Internal primitives are listed
 * alongside the consumer that justifies them — for example, the
 * disposal hook is owned by `@causljs/react`'s `useCauslFamily`
 * because the React hook is the unit that owns "this node's lifetime
 * is bounded by a component's mount." If an internal primitive becomes
 * broadly useful, it can be promoted to the second-tier extension list
 * with a written justification; demotion in the other direction is the
 * harder move and is treated accordingly.
 */

import type { Graph, GraphSnapshot, Node, Observer, Unsubscribe } from './types.js';
import { lookupInternalDispatch } from './internal-dispatch.js';

/**
 * Sentinel marker confirming the `@causljs/core/internal` entrypoint
 * resolves. Has no runtime use beyond import-path verification — kept
 * as a stable export so the `internal.test.ts` wiring assertion that
 * landed alongside the entrypoint scaffold continues to hold.
 *
 * @internal
 */
export const INTERNAL_ENTRYPOINT = '@causljs/core/internal' as const;

/**
 * Adapter-layer disposal hook. Releases a node from the engine
 * registry, drops every dep / dependent edge it participated in,
 * cancels any subscriptions targeting it, and records a tombstone
 * with the current GraphTime. Subsequent access through the public
 * surface throws `NodeDisposedError` (a typed error distinct from
 * `UnknownNodeError`).
 *
 * Idempotent — calling `dispose` on a node already disposed is a
 * no-op.
 *
 * @param graph - The handle returned by `createCausl`.
 * @param node - The node to dispose.
 * @throws {@link DisposalDuringCommitError} when invoked while a
 *  commit is in progress on `graph`.
 * @throws {@link NodeHasDependentsError} when `node` still has live
 *  dependents — adapter code must release downstream consumers
 *  before their producer.
 * @throws Error when `graph` was not produced by `createCausl`.
 *
 * @example
 * ```ts
 * import { createCausl } from '@causljs/core';
 * import { dispose } from '@causljs/core/internal';
 *
 * const graph = createCausl();
 * const a = graph.input('a', 1);
 * dispose(graph, a); // node `a` released; subsequent reads throw
 * ```
 *
 * @internal
 */
export function dispose(graph: Graph, node: Node<unknown>): void {
  lookupInternalDispatch(graph).dispose(node);
}

/**
 * Internal-API migration hydrate (issue #1090). Applies a
 * {@link GraphSnapshot} to a fresh graph WITHOUT publishing the
 * synthetic `'hydrate'` commit record that {@link Graph.hydrate}
 * appends. The migration boundary itself isn't a commit, so the
 * §3 monotonicity invariant is preserved by adopting `snap.time`
 * as the engine clock directly (precondition: `now === 0` and
 * `commitHistory.length === 0`).
 *
 * Adopters MUST use {@link Graph.hydrate} for SSR-restore on a
 * running graph. `_migrateFrom` exists only for two consumers:
 *
 *   1. The WASM auto-adapt wrapper (`@causljs/core/wasm`'s
 *      `WasmBackend.__migrateFrom`) so a JS → WASM migration
 *      reaches the wasm-side engine without an intervening
 *      synthetic record.
 *   2. The cross-backend determinism property test
 *      (`packages/core/test/properties/cross-backend-determinism.
 *      property.test.ts`) so the migration matrix can compare
 *      literal IR byte-equality against the (N+M)-commit pure-TS
 *      baseline that has no `'hydrate'` entry.
 *
 * Application code MUST NOT import this helper — `Graph.hydrate`
 * is the public, SemVer-stable bulk-restore primitive.
 *
 * @param graph - The handle returned by `createCausl`. Must be in a
 *   fresh migration-boundary state (no commits, `now === 0`).
 * @param snap - The snapshot envelope to migrate from. Same wire
 *   shape as `Graph.hydrate` consumes.
 * @throws {@link HydrationSchemaError} when `snap.schema` is not
 *   the supported version (`1`), or when `snap.schemaHash` is
 *   present and does not match the live graph's registered node
 *   id-set digest.
 * @throws {@link Error} when the graph is not fresh (already
 *   committed, or `now !== 0`).
 * @throws {@link CommitInProgressError} when invoked re-entrantly
 *   from inside another commit / hydrate callback.
 * @throws Error when `graph` was not produced by `createCausl`.
 *
 * @see {@link Graph.hydrate} — the public SSR-restore path with
 *   the synthetic 'hydrate' commit record.
 * @see issue #1090 — the literal-IR byte-equality framing the
 *   cross-backend determinism gate locks in.
 *
 * @internal
 */
export function _migrateFrom(graph: Graph, snap: GraphSnapshot): void {
  lookupInternalDispatch(graph)._migrateFrom(snap);
}

/**
 * H1 adapter-exemption seam (issue #1241). Run `fn` with the engine's
 * H1 hazard tracker suppressed for reads issued synchronously from
 * inside the body.
 *
 * Used by canonical `@causljs/react` hooks (`useCauslNode`,
 * `useCausl`, `useCauslShallow`, `useCauslTypedArrayNode`) to wrap
 * their `useSyncExternalStore` `getSnapshot` body. The
 * `useSyncExternalStore` contract retains the snapshot across
 * commits for tearing detection — that retention is intrinsic to
 * the adapter, not an adopter bug. Wrapping the snapshot body in
 * `__causlAdapterRead` flags those reads as engine-internal
 * bookkeeping so the H1 hazard tracker skips them, eliminating
 * the false-positive warning that flagged PR #1238 in review.
 *
 * The helper composes via a depth counter — nested adapter calls
 * (an adapter hook reading through another adapter hook) all
 * suppress tracking for the whole sub-tree, with unconditional
 * decrement on throw via `finally`.
 *
 * In production builds (`process.env.NODE_ENV === 'production'`)
 * the H1 apparatus is tree-shaken away and this helper degenerates
 * to invoking `fn()` directly. Adapter code does not need to guard
 * the import on the environment — every code path is uniform.
 *
 * @typeParam T - Return type of the wrapped function.
 *
 * @param graph - The handle returned by `createCausl`.
 * @param fn - Synchronous body whose reads should bypass the H1
 *  hazard tracker.
 * @returns Whatever `fn()` returns.
 * @throws Error when `graph` was not produced by `createCausl`.
 *
 * @remarks
 * **Strictly internal.** Application code MUST NOT import this
 * helper, and the underscore-double-prefix naming (`__causl_*`)
 * is deliberately ugly to discourage drive-by adoption. The
 * shape is not part of any SemVer-stable surface; adapter
 * packages that import it pin a tight version range on
 * `@causljs/core`.
 *
 * @example
 * Inside an adapter hook:
 * ```ts
 * import { __causlAdapterRead } from '@causljs/core/internal';
 *
 * const getSnapshot = useCallback(
 *   () => __causlAdapterRead(graph, () => graph.read(node)),
 *   [graph, node],
 * )
 * ```
 *
 * @internal
 */
export function __causlAdapterRead<T>(graph: Graph, fn: () => T): T {
  return lookupInternalDispatch(graph).__causlAdapterRead(fn);
}

/**
 * Exhaustiveness helper for discriminated-union switches.
 *
 * Place `assertNever(value)` in the `default` arm of a `switch` over
 * a tagged union; TypeScript narrows `value` to `never` only when the
 * other arms have collectively covered every variant, so adding a new
 * variant produces a compile error at *every* call site instead of a
 * silent runtime fallback.
 *
 * Realises the engine-wide commitment that every discriminated union —
 * Resource, Formula, Conflict, NodeStatus, RetentionResult, the error
 * `kind` tags — is a *tagged* union with an exhaustiveness check the
 * type system can enforce, so adding a new variant produces a compile
 * error at every call site rather than a silent runtime fallback (#273).
 *
 * @param value - Value the surrounding switch failed to discriminate.
 *   At a correctly-exhaustive call site this is unreachable; the
 *   parameter type `never` is what makes the check structural.
 * @param hint - Optional human-readable label included in the runtime
 *   error if the impossible nonetheless happens (defensive — protects
 *   against `as any`-coerced inputs that bypass the type check).
 * @throws {@link Error} unconditionally if reached at runtime.
 *
 * @example
 * ```ts
 * function area(s: { kind: 'circle'; r: number } | { kind: 'sq'; s: number }): number {
 *   switch (s.kind) {
 *     case 'circle': return Math.PI * s.r ** 2;
 *     case 'sq':     return s.s ** 2;
 *     default:       return assertNever(s);
 *   }
 * }
 * ```
 *
 * @internal
 */
export function assertNever(value: never, hint = 'unhandled discriminator'): never {
  throw new Error(`${hint}: ${JSON.stringify(value)}`)
}

/**
 * Read-only capability slice of the engine: `read`, `subscribe`,
 * `subscribeCommits`, and `now`, with no `commit`, `input`, `derived`,
 * `exportModel`, `snapshot`, or any other mutating / registering
 * surface.
 *
 * @remarks
 * Mark Miller's principle of least authority applied at the *adapter*
 * boundary. Adapters (`@causljs/react`, `@causljs/persistence`,
 * `@causljs/devtools-bridge`) wrap their selector / listener boundary
 * with {@link narrowCapability} so the function they hand to
 * application code receives only the read-side capability. Application
 * code does not name this type and should not import it: selector
 * inference flows from the adapter's hook signature, and the few cases
 * that want to spell the parameter out can use the adapter's own
 * `Selector<T>` alias. This type is the contract *between* adapters
 * and the engine, not between adapters and application code.
 *
 * Per §12.3, this type is internal-only — no adapter re-exports it on
 * a public barrel.
 *
 * @internal
 */
export type ReadOnlyGraph = Pick<Graph, 'read' | 'subscribe' | 'subscribeCommits' | 'now'>

/**
 * Thrown by the {@link narrowCapability} Proxy when application code
 * (typically a misbehaving selector) tries to reach for engine
 * authority that was deliberately excluded from the narrowed view.
 *
 * @remarks
 * The class name (`CapabilityViolation`) is asserted in adapter-side
 * tests via `/CapabilityViolation/`; do not rename without updating
 * the consuming suites.
 *
 * @internal
 */
export class CapabilityViolation extends Error {
  readonly attempt: string
  constructor(attempt: string) {
    super(
      `CapabilityViolation: tried to invoke '${attempt}' on a narrowed ` +
        `ReadOnlyGraph. Selectors and listeners must not mutate or register; ` +
        `if you need authority over the engine, accept a full Graph parameter ` +
        `at the call site rather than reach for ambient capability.`,
    )
    this.name = 'CapabilityViolation'
    this.attempt = attempt
  }
}

/**
 * Narrow a full {@link Graph} to a read-only capability view.
 *
 * The returned object is structurally a `ReadOnlyGraph`, wrapped in a
 * `Proxy` that throws {@link CapabilityViolation} on any property
 * access not in the allow-list (`read`, `subscribe`, `subscribeCommits`,
 * `now`). The type narrowing is the compile-time gate; the Proxy is
 * the runtime gate against `as any`-coerced or `as Graph`-coerced
 * leaks.
 *
 * Adapter packages (`@causljs/react`, `@causljs/persistence`,
 * `@causljs/devtools-bridge`) wrap their selector/listener boundary
 * with this so application code receives only the read-side
 * capability. Application code MUST NOT import this directly — adapters
 * own the boundary.
 *
 * @param graph - The full engine handle.
 * @returns A `ReadOnlyGraph` view that throws on any non-allowed access.
 *
 * @example
 * ```ts
 * // Inside an adapter hook:
 * const cap = narrowCapability(graph)
 * const value = selector(cap)  // selector cannot reach commit/input/derived
 * ```
 *
 * @internal
 */
export function narrowCapability(graph: Graph): ReadOnlyGraph {
  const allowed: ReadOnlyGraph = {
    read<T>(node: Node<T>): T {
      return graph.read(node)
    },
    subscribe<T>(node: Node<T>, observer: Observer<T>): Unsubscribe {
      return graph.subscribe(node, observer)
    },
    subscribeCommits(observer) {
      return graph.subscribeCommits(observer)
    },
    get now() {
      return graph.now
    },
  }

  // The Proxy traps any unexpected access — even property reads of
  // mutating methods that TypeScript would have caught at compile time.
  // This is the runtime spine of Miller's capability discipline.
  return new Proxy(allowed, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      // Anything not in the allow-list is an authority leak attempt.
      // Common offenders: 'commit', 'input', 'derived', 'exportModel'.
      throw new CapabilityViolation(String(prop))
    },
    set(_target, prop) {
      throw new CapabilityViolation(`set:${String(prop)}`)
    },
    deleteProperty(_target, prop) {
      throw new CapabilityViolation(`delete:${String(prop)}`)
    },
  })
}
