/**
 * @packageDocumentation
 *
 * Typed-array projection hook for `@causl/react` (#688, sub-task of
 * #680). {@link useCauslTypedArrayNode} subscribes to a single
 * {@link Node} whose value is bulk numeric data and returns a typed
 * array view (`Float64Array`, `Uint8Array`, `Int32Array`, ...) that
 * is stable across renders until the next commit.
 *
 * @remarks
 * **WASM backend status.** The full zero-copy view-into-linear-memory
 * implementation requires the WASM engine artefacts produced by
 * #682 / #683 / #693; until those land, `loadWasmBackend()` (#1031)
 * throws `WasmBackendUnavailableError`. This hook therefore ships
 * the *fallback* path only:
 *
 *   1. The hook detects the WASM backend by attempting
 *      `loadWasmBackend()` once at module evaluation; the structured
 *      error `code: 'CAUSL_WASM_NOT_BUILT'` flips the hook into
 *      JS-engine mode.
 *   2. In JS-engine mode, it reads the node's current committed value
 *      via `graph.read(node)` and synthesises a typed-array view from
 *      the JS value (zero-copy when the value is already an instance
 *      of the requested constructor; otherwise a `from(...)` copy).
 *   3. View identity is preserved across renders for a given commit:
 *      `useSyncExternalStore.getSnapshot` caches the previous view
 *      and re-returns it when the engine's per-node `Object.is`
 *      cutoff says the value is unchanged.
 *
 * The hook contract is forward-compatible with the WASM path: once
 * the engine ships, callers retain the same call site and start
 * receiving real `WebAssembly.Memory.buffer`-backed views with the
 * same stability guarantee. Until then adopters get a typed-array
 * shape to program against, plus identity stability that lets
 * `React.memo`-style equality skips work today.
 *
 * **`memory.grow()` invariant (deferred — see #680).** The WASM
 * backend must never call `WebAssembly.Memory.grow()` mid-render:
 * grow invalidates every existing view. The engine pre-allocates a
 * worst-case heap and grows only between commit boundaries. The
 * fallback path is unaffected because no shared linear memory is
 * involved — every view is a JS-owned buffer. The invariant becomes
 * load-bearing once #682 / #683 / #693 wire the WASM artifacts; the
 * hook surface here is unchanged.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/688} — this hook.
 * @see {@link https://github.com/iasbuilt/causl/issues/680} — WASM EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/1031} — `loadWasmBackend()` loader stub.
 */

import type { Node } from '@causl/core'
import { useCallback, useContext, useDebugValue, useRef, useSyncExternalStore } from 'react'
import { CauslContext } from './context.js'

/**
 * The subset of typed-array constructors supported by
 * {@link useCauslTypedArrayNode}. Restricted to the three concrete
 * shapes called out in #688's scope (`Float64Array`, `Uint8Array`,
 * `Int32Array`); other typed arrays can be added without an ABI
 * break by extending this union.
 *
 * @remarks
 * The constraint is on the *constructor instance*, not on a
 * `TypedArray` base class — TypeScript's structural typing does not
 * model `TypedArray` directly, so we enumerate the concrete shapes
 * the hook accepts.
 */
export type CauslTypedArray = Float64Array | Uint8Array | Int32Array

/**
 * Constructor handle for one of {@link CauslTypedArray}. Used by the
 * fallback path's `from(...)` copy to materialise a view of the
 * requested element shape when the node's committed value is not
 * already an instance of `T`.
 */
export type CauslTypedArrayCtor<T extends CauslTypedArray> = {
  new (length: number): T
  from(source: ArrayLike<number>): T
}

/**
 * WASM-backend availability probe — resolved once at module load via
 * {@link loadWasmBackend} from `@causl/core/wasm`. The hook reads
 * this synchronously after the first render via a one-shot effect to
 * decide whether to take the zero-copy WASM-memory path or the
 * JS-engine fallback.
 *
 * @remarks
 * Today the probe always resolves to `false` because the WASM
 * artefacts (#682 / #683 / #693) are not yet built —
 * `loadWasmBackend()` throws `WasmBackendUnavailableError` with
 * `code: 'CAUSL_WASM_NOT_BUILT'`. We still issue the probe so the
 * hook flips to the WASM path automatically once the artefacts ship,
 * with no source change in adopter code.
 *
 * The probe is module-scoped (one promise per process) and never
 * re-issued — the bridge fingerprint of the host does not change
 * across the React-app lifetime.
 *
 * @internal
 */
let wasmBackendAvailable: boolean | null = null

/**
 * Promise tracking the in-flight backend probe. Resolves to a
 * `boolean` exactly once. Future calls observe the cached
 * {@link wasmBackendAvailable} value directly without re-importing
 * the loader.
 *
 * @internal
 */
let wasmBackendProbe: Promise<boolean> | null = null

/**
 * Kick off the WASM-backend probe lazily. Returns a promise that
 * resolves to `true` if a backend is reachable and `false` if
 * `loadWasmBackend()` throws (or the loader module itself is
 * unavailable, e.g. when the host bundler tree-shook the
 * `@causl/core/wasm` subpath).
 *
 * @remarks
 * The dynamic `import('@causl/core/wasm')` is deliberate: the
 * subpath is an opt-in entry point and should not be force-loaded by
 * `@causl/react`'s main bundle. Bundlers that exclude the subpath
 * (or set up CSP forbidding wasm fetch) see the dynamic-import
 * rejection and the hook falls back cleanly to the JS engine.
 *
 * @internal
 */
function probeWasmBackend(): Promise<boolean> {
  if (wasmBackendProbe) return wasmBackendProbe
  wasmBackendProbe = (async () => {
    try {
      // Subpath is opt-in. The dynamic import + loader call together
      // are the seam the WASM artefacts plug into; until they ship,
      // `loadWasmBackend()` throws `WasmBackendUnavailableError` and
      // the fallback path takes over.
      const mod = (await import('@causl/core/wasm')) as {
        loadWasmBackend: () => Promise<unknown>
      }
      await mod.loadWasmBackend()
      wasmBackendAvailable = true
      return true
    } catch {
      wasmBackendAvailable = false
      return false
    }
  })()
  return wasmBackendProbe
}

// Kick the probe off at module load so the answer is usually ready
// by the time the first render reaches the hook. The promise is
// fire-and-forget — the hook tolerates a `null` (not-yet-resolved)
// state by taking the JS fallback for that render and re-rendering
// once the probe lands.
void probeWasmBackend()

/**
 * Synchronous read of the cached probe answer.
 *
 * Returns `null` if the probe is still in flight (the first render
 * before the dynamic-import microtask drains), `true` if a WASM
 * backend resolved, `false` if `loadWasmBackend()` threw (the
 * documented today-state until #682 / #683 / #693 ship).
 *
 * Exported for tests + the future zero-copy fast-path branch inside
 * {@link useCauslTypedArrayNode} (`getSnapshot` consults this to
 * decide between the WASM linear-memory view and the JS coercion
 * copy). The hook reads it on every snapshot so the moment the
 * probe lands the next render flips paths.
 *
 * @internal
 */
export function __isWasmBackendAvailableForTests(): boolean | null {
  return wasmBackendAvailable
}

/**
 * Subscribe to a graph node whose value is bulk numeric data,
 * receiving a typed-array view.
 *
 * @typeParam T - One of `Float64Array | Uint8Array | Int32Array`.
 *
 * @param node - The input or derived node to subscribe to. The
 * component re-renders only when this node's value changes — unrelated
 * commits do not trigger a re-render (same per-node-subscription
 * semantics as {@link useCauslNode}).
 * @param ctor - Constructor for the typed array shape to return.
 * Used by the JS-engine fallback to coerce non-`T` committed values
 * (e.g. a plain `number[]`) into a `T` view; ignored on the WASM
 * path where the engine reports the element shape directly.
 * @returns A typed-array view of the node's current committed value.
 * The reference is **stable across renders until the next commit**
 * during which the engine reports a value change — same-commit
 * reads return the identically-`Object.is`-equal view.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * **Zero-copy path (WASM backend, deferred — #680 / #682 / #683 /
 * #693).** When the WASM backend is active, the returned view points
 * directly into the engine's linear memory: `new ctor(memory.buffer,
 * offset, length)`. No copy occurs per render. The engine guarantees
 * no `memory.grow()` between the `getSnapshot` read and the React
 * render that consumes the view; grows happen only at commit
 * boundaries.
 *
 * **Fallback path (JS engine, today).** The hook reads the node's
 * current value via `graph.read(node)`. If the value is already an
 * instance of `ctor`, it is returned verbatim. Otherwise the hook
 * coerces it via `ctor.from(value)` (one-shot copy on commit). A
 * cached view reference is reused across renders for the same
 * commit, so `React.memo` consumers comparing by identity skip work.
 *
 * **Stability contract.** The view returned for commit `N` is
 * `Object.is`-equal to itself across every render between commit
 * `N` and commit `N+1`. After a commit that changes the subscribed
 * node, the hook returns a *fresh* view (new reference). Adopters
 * MAY rely on `Object.is(viewA, viewB) === false` as a signal that
 * the underlying numeric data changed.
 *
 * @example
 * Subscribe to a `Float64Array` cell range:
 * ```tsx
 * const range = useCauslTypedArrayNode(prices, Float64Array)
 * // `range` is stable across renders until `prices` next changes.
 * ```
 *
 * @example
 * Subscribe to a `Uint8Array` blob in a hex viewer:
 * ```tsx
 * const bytes = useCauslTypedArrayNode(blob, Uint8Array)
 * ```
 *
 * @see {@link useCauslNode} — single-node subscription without typed-array coercion.
 */
export function useCauslTypedArrayNode<T extends CauslTypedArray>(
  node: Node<unknown>,
  ctor: CauslTypedArrayCtor<T>,
): T {
  const ctx = useContext(CauslContext)
  if (!ctx) {
    throw new Error('useCauslTypedArrayNode must be used inside <CauslProvider>')
  }
  const { graph } = ctx

  // Cached view + the JS value it was derived from. We key the cache
  // on `Object.is(rawValue, lastRaw)` so that the engine's per-node
  // `Object.is` cutoff (the same one `useCauslNode` relies on) maps
  // 1:1 onto our view-identity contract: same committed value → same
  // returned view reference. Storing the raw value alongside the
  // view is what lets `getSnapshot` return the cached view when
  // React calls it twice in a row for the same commit (which it does
  // during concurrent renders / strict-mode double-invocation).
  const cache = useRef<{
    readonly raw: unknown
    readonly view: T
    readonly graph: typeof graph
  } | null>(null)

  // Subscribe side of useSyncExternalStore: route through
  // `graph.subscribe(node, cb)` so React's onChange only fires for
  // commits that change *this* node. The engine's `Object.is` cutoff
  // pre-filters no-op writes, mirroring `useCauslNode` exactly.
  //
  // memory.grow() invariant (deferred, #680): on the WASM path the
  // engine must guarantee no grow happens between the onChange
  // callback firing and React re-reading getSnapshot. The current
  // JS fallback is unaffected — no shared linear memory.
  const subscribe = useCallback(
    (onChange: () => void) => graph.subscribe(node, () => onChange()),
    [graph, node],
  )

  // getSnapshot side: read raw value, project to typed-array T,
  // return the cached view when the raw value has not changed.
  //
  // The `wasmBackendAvailable` consult lands here (rather than at
  // module load) so the hook flips to the zero-copy path on the
  // next render after the probe lands, without forcing every adopter
  // to refactor when #682 / #683 / #693 ship. Until then the value
  // is `false` (probe rejected) or `null` (probe still in flight)
  // and the JS coercion fallback runs.
  const getSnapshot = useCallback((): T => {
    const raw = graph.read(node) as unknown
    const cached = cache.current
    if (cached && cached.graph === graph && Object.is(cached.raw, raw)) {
      // Same commit, same value — return the same view reference
      // so consumers skip rendering work by identity.
      return cached.view
    }
    // FUTURE (#680): when `wasmBackendAvailable === true`, read the
    // node's `(ptr, len)` pair from the WASM-backed engine and
    // return `new ctor(memory.buffer, ptr, len)` directly. The
    // engine guarantees no `memory.grow()` between this read and
    // React's render — grows happen only at commit boundaries.
    void wasmBackendAvailable
    const view = coerceToTypedArray(raw, ctor)
    cache.current = { raw, view, graph }
    return view
  }, [graph, node, ctor])

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useDebugValue(value)
  return value
}

/**
 * Coerce a node's committed value to the requested typed-array
 * shape.
 *
 * @typeParam T - The target typed-array shape.
 *
 * @param raw - The committed value read from the graph. May be a
 * typed array of the target shape, a typed array of a different
 * shape, a plain array of numbers, or `null`/`undefined`.
 * @param ctor - The target typed-array constructor.
 * @returns A view of `T`. Zero-copy when `raw` is already an
 * instance of `ctor`; otherwise a one-shot copy via `ctor.from(...)`.
 *
 * @internal
 */
function coerceToTypedArray<T extends CauslTypedArray>(
  raw: unknown,
  ctor: CauslTypedArrayCtor<T>,
): T {
  if (raw instanceof ctor) return raw
  if (raw == null) return new ctor(0)
  // ArrayBufferView (different shape) or array-like of numbers.
  // `ctor.from` handles both via the iterable / array-like protocol;
  // the result is always a fresh buffer owned by the typed array.
  return ctor.from(raw as ArrayLike<number>)
}
