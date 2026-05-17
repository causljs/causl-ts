/**
 * @packageDocumentation
 *
 * Public entry point for `@causljs/react`, the React binding layer for
 * the Causl dependency engine. This module re-exports the provider,
 * hooks, MVU update helpers, and supporting types that together form
 * the application surface for React hosts.
 *
 * The barrel is deliberately narrow. `tx.set(node, value)` is a *write
 * API*, not a *thinking API*: application developers do not think "I
 * will mutate `cell:wb1:Sheet1:A1`," they think "the user clicked
 * Save." The MVU shape — typed `Msg` discriminated unions plus an
 * `update` runner — is the front door that lets `Msg` carry the "make
 * impossible states impossible" guarantee at the application surface
 * rather than scattering it across 57 internal enum tags. The previous
 * draft's nine kinds of hook (`useGraphValue`, `useGraphStatus`,
 * `useGraphConflicts`, `useGraphExplanation`, `useGraphTransaction`,
 * `useGraphDerived`, `useGraphSelector`, `useGraphResource`) collapse
 * to two: {@link useCausl} for selector-driven subscription and
 * {@link useDispatch} for typed dispatch. Status, conflicts, and
 * explanations are values selectable from the same store and do not
 * need their own hooks.
 *
 * Public surface:
 *   - CauslProvider          — provides a Graph through React context
 *   - useCausl(selector)     — re-renders when the selected value changes
 *   - useDispatch()             — returns a typed Msg dispatcher
 *   - createUpdate<Msg, Graph>  — typed Update<Msg, Graph> runner factory
 *   - defineMsgs / MsgOf / Msg  — typed Msg discriminated-union helper (#369)
 *   - assertNever               — exhaustiveness probe for switch (msg.kind)
 */

/** MVU runner type and helpers for sequencing app messages into commits. */
export type { Update } from './update.js'
export { createUpdate, runMessages } from './update.js'

/**
 * Typed `Msg` discriminated-union helper for the §8 MVU surface (#369).
 * `defineMsgs({ tag: null | payload<T>(), ... })` returns a typed
 * variant-constructor record plus a phantom `_union` field carrying
 * the closed `Msg` union; `MsgOf<typeof builder>` extracts that union
 * for use as the type parameter to `createUpdate`. `assertNever` is
 * the canonical default-arm exhaustiveness probe; `Msg<K, P>` is the
 * generic variant template for callers who prefer to spell the union
 * out by hand.
 */
export type { Msg, MsgBuilder, MsgOf, MsgSpec, PayloadMarker } from './msg.js'
export { assertNever, defineMsgs, payload } from './msg.js'

/** React context value plus the context object consumers subscribe to. */
export type { CauslContextValue } from './context.js'
export { CauslContext } from './context.js'

/** Provider component and its props (graph + optional update). */
export type { CauslProviderProps } from './Provider.js'
export { CauslProvider } from './Provider.js'

/** Selector type alias and the primary subscription hook. */
export type { Selector } from './useCausl.js'
export { useCausl } from './useCausl.js'

/**
 * Shallow-equal selector hook plus the comparison primitive it uses.
 * Useful for selectors returning fresh object/array literals per call.
 */
export { shallowEqual, useCauslShallow } from './useCauslShallow.js'

/**
 * Per-node subscription hook (#677 MVP). Subscribes directly to a single
 * node via `graph.subscribe(node, cb)` so React only re-renders when that
 * node's value changes — unrelated commits never trigger a re-render.
 * Use this in place of `useCausl` when reading a single node; prefer
 * `useCausl(selector)` for multi-node projections.
 *
 * @remarks
 * The e2e dropped-frames gate (≤ 5% over 30s on a 1000-cell viewport
 * at 60Hz, plus p95 commit-to-paint ≤ 16ms) shipped in #765 — see
 * `packages/react/e2e/tests/dropped-frames-1000.spec.ts`.
 */
export { useCauslNode } from './useCauslNode.js'

/**
 * Typed-array projection hook (#688, sub-task of #680). Subscribes to
 * a single node whose value is bulk numeric data and returns a
 * `Float64Array | Uint8Array | Int32Array` view that is stable across
 * renders until the next commit. Designed to become zero-copy once
 * the WASM backend (#682 / #683 / #693) lands; today it falls back to
 * a coerced view of the JS-engine value with the same stability
 * contract, so adopters can program against the final shape now.
 *
 * @remarks
 * The WASM-backend availability probe runs once at module load via
 * `loadWasmBackend()` (#1031); until the artefacts ship, the loader
 * throws `WasmBackendUnavailableError` and the hook takes the JS
 * fallback. See {@link useCauslTypedArrayNode} for the contract.
 */
export type { CauslTypedArray, CauslTypedArrayCtor } from './useCauslTypedArrayNode.js'
export { useCauslTypedArrayNode } from './useCauslTypedArrayNode.js'

/** Dispatcher type alias and the hook returning a typed dispatcher. */
export type { Dispatch } from './useDispatch.js'
export { useDispatch } from './useDispatch.js'

/**
 * Family-lifecycle hook closing Adoption-gap #1 (Jotai's `atomFamily`):
 * stable per-key node identity within a provider, refcount-driven
 * disposal via `@causljs/core/internal`. See {@link useCauslFamily}.
 */
export type { FamilyFactory, FamilyGraph } from './useCauslFamily.js'
export { useCauslFamily } from './useCauslFamily.js'

/**
 * Suspense-projection hook closing Adoption-gap #2 (Jotai's
 * Suspense atoms): projects a `SuspendableResource<T>` from the graph
 * through a selector and either returns the resolved `T`, throws a
 * Promise for `<Suspense>`, or throws an error for an error boundary.
 * See {@link useCauslSuspense}.
 */
export type { SuspendableResource } from './useCauslSuspense.js'
export { useCauslSuspense } from './useCauslSuspense.js'

/**
 * SSR hydration component (#130). Applies a server-captured
 * {@link GraphSnapshot} to the provider's graph on first mount, then
 * renders its children. See {@link Hydrate}.
 */
export type { HydrateProps } from './Hydrate.js'
export { Hydrate } from './Hydrate.js'

/**
 * Package version literal. Pinned to `'0.0.0'` until the binding ships
 * a tagged release; consumers can use it as a runtime version probe.
 */
export const VERSION = '0.0.0'
