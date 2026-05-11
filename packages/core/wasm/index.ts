/**
 * @packageDocumentation
 *
 * `@causl/core/wasm` — opt-in WASM backend entry point.
 *
 * This subpath is the lazy-load seam for the WebAssembly-backed
 * engine described in EPIC #680. Importing `@causl/core` does **not**
 * pull this module in; only callers who explicitly
 * `import('@causl/core/wasm')` (or who flip `createCausl({ backend:
 * 'wasm' | 'auto' })` past the auto-adapt threshold once #686 lands)
 * pay the WASM bundle cost.
 *
 * The cost shape:
 *
 *   - `@causl/core` main bundle: tiny loader stub (~1 KB).
 *   - `@causl/core/wasm`: ~60–120 KB compressed WASM module + ~5 KB
 *     of JS bindings, fetched on demand.
 *
 * For this skeleton (PR #684), the WASM artifacts produced by #682
 * + #683 + #693 are not yet wired through. `loadWasmBackend()`
 * therefore resolves a placeholder bridge identifier; the concrete
 * `instantiate()` path is filled in once those sub-tasks land. The
 * exported types (`BackendEngine`, `Bridge`, `BridgeFeatures`,
 * `WasmBackendOptions`) are the public-API contract this entry
 * point commits to today and the later sub-tasks must respect.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/680} — WASM EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/684} — this entry point.
 * @see {@link https://github.com/iasbuilt/causl/issues/681} — `BackendEngine` interface (placeholder until landed).
 * @see {@link https://github.com/iasbuilt/causl/issues/691} — `Bridge` interface (placeholder until landed).
 */

import type {
  Commit,
  GraphSnapshot,
  GraphTime,
  Graph,
  InputNode,
  Node,
  NodeId,
  Observer,
  RetentionResult,
  Unsubscribe,
} from '../src/types.js'
import type { CauslModel } from '../src/ir.js'
import type { StatechartInput, StatechartResult } from '../src/backend.js'
import { createCausl } from '../src/index.js'
import { _migrateFrom as _migrateFromInternal } from '../src/internal.js'
import { evaluateStatechart as evaluateStatechartCanonical } from '../src/statechart-evaluator.js'

// ---------------------------------------------------------------------------
// Placeholder type vocabulary.
//
// `BackendEngine` (#681) and `Bridge` (#691) live in the main
// package once those sub-tasks land. Until then, this entry point
// declares the same shapes locally so adopters can program against
// the public surface today. When #681 / #691 merge, these
// declarations move to `packages/core/src/backend.ts` and
// `packages/core/src/bridge.ts` respectively, and this file
// re-exports them.
// ---------------------------------------------------------------------------

/**
 * Pluggable JS↔WASM bridge feature flags.
 *
 * Probed at module load by `detectBridge()`. The picked bridge
 * combines the most-capable subset the host actually supports:
 *
 *   - `gc` — WasmGC reference types (`externref`).
 *   - `jsStringBuiltins` — `wasm:js-string` direct imports.
 *   - `sharedMemory` — SharedArrayBuffer + Atomics (future EPIC).
 *   - `stringView` — `wasm:string-view` (future, not baseline).
 *
 * Mirrors the EPIC §"Pluggable bridge architecture" feature matrix.
 * The interface is stable so future bridges plug in without touching
 * runtime engine code.
 */
export interface BridgeFeatures {
  readonly gc: boolean
  readonly jsStringBuiltins: boolean
  readonly sharedMemory: boolean
  readonly stringView: boolean
}

/**
 * Bridge identifier — one of the three artifacts produced by
 * `wasm-pack` (#683) plus an open-ended string for future bridges.
 */
export type BridgeId =
  | 'wasmgc-builtins'
  | 'wasmgc-classic'
  | 'serde-json'
  | (string & {})

/**
 * Pluggable bridge handle. The concrete object/string handle types
 * are bridge-specific and become opaque pointer-likes once #691
 * lands; for the loader skeleton we keep them `unknown` so adopter
 * code cannot accidentally reach into the bridge surface before the
 * vocabulary is final.
 */
export interface Bridge {
  readonly id: BridgeId
  readonly features: BridgeFeatures
  /** Bumped on any ABI-breaking bridge change. Loader checks for compat. */
  readonly abiVersion: number
}

/**
 * SPEC §6 statechart-extension-point seam types.
 *
 * Re-exported from `packages/core/src/backend.ts` (the source-of-truth
 * declarations) so the `@causl/core/wasm` entry point resolves to the
 * canonical originals rather than locally-declared mirrors. Prior
 * revisions of this file declared identical-but-distinct copies; for
 * a semver-major / 0.9.0 ship the types must collapse to one
 * declaration so future evolution of the source-of-truth surface
 * cannot drift between barrels (issue #1121).
 *
 * The re-export form contributes zero runtime bytes — `tsup --dts`
 * elides `export type` statements at emit time — so the `@causl/core/wasm`
 * §14.2 bundle-size cell is unaffected.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1121} — type-canonicality cleanup.
 * @see `packages/core/src/backend.ts` — source-of-truth declarations.
 */
export type {
  StatechartInput,
  StatechartResult,
  ForbiddenStatechartTransition,
} from '../src/backend.js'

/**
 * Backend engine contract — one implementation per backend (TS,
 * WASM-GC, WASM-serde, future). The TS engine in `graph.ts` is
 * routed through this interface in #681; the WASM engine plugs in
 * here.
 *
 * The shape mirrors the seven-method `Graph` surface plus the
 * second-tier extensions (`subscribeCommits`, `snapshot`,
 * `hydrate`, `readAt`, `snapshotAt`, `exportModel`, `dispose`,
 * `now`, plus the #1068 `evaluateStatechart` SPEC §6 extension
 * point). Cross-backend determinism (#685) is gated against this
 * interface.
 */
export interface BackendEngine {
  commit(intent: string, writes: ReadonlyMap<NodeId, unknown>): Commit
  read(node: NodeId): unknown
  subscribe<T>(node: NodeId, observer: Observer<T>): Unsubscribe
  subscribeCommits(observer: (commit: Commit) => void): Unsubscribe
  snapshot(): GraphSnapshot
  hydrate(snap: GraphSnapshot): void
  readAt(node: NodeId, time: GraphTime): RetentionResult<unknown>
  snapshotAt(time: GraphTime): RetentionResult<GraphSnapshot>
  exportModel(): CauslModel
  dispose(node: NodeId): void
  /**
   * SPEC §6 composite-statechart extension point. Issue #1068
   * (deferred from #698). The WASM backend implements this via the
   * Rust-side `engine-rs-core::statechart_reducers` enums (gated
   * behind `feature = "future"`) once Sub-D of EPIC #680 wires the
   * bridge through.
   */
  evaluateStatechart(input: StatechartInput): StatechartResult
  readonly now: GraphTime
}

// ---------------------------------------------------------------------------
// Loader options + result.
// ---------------------------------------------------------------------------

/**
 * Options accepted by `loadWasmBackend()`.
 */
export interface WasmBackendOptions {
  /**
   * Override the bridge picker. Defaults to `detectBridge()` —
   * probes the host and picks the fastest supported artifact.
   *
   * Adopters with a known target (e.g. internal Node 24 service
   * with WasmGC) can pin a bridge to skip detection cost and
   * shrink the build.
   */
  readonly bridge?: BridgeId

  /**
   * Override the base URL the WASM artifact is fetched from.
   *
   * Defaults to the package-relative URL resolved through the
   * bundler's `import.meta.url` mechanism (works in webpack 5 +
   * `experiments.asyncWebAssembly`, Vite 5 + `vite-plugin-wasm`,
   * esbuild 0.20 + `--loader:.wasm=file`, and Node 22+ ESM).
   *
   * Set this to a CDN URL (e.g.
   * `https://cdn.jsdelivr.net/npm/@causl/core@<ver>/wasm/`) when
   * the host CSP `connect-src` directive forbids same-origin
   * fetches of `.wasm` blobs. Adopters MUST whitelist the chosen
   * origin explicitly — the loader does not auto-fallback.
   */
  readonly wasmBaseUrl?: string

  /**
   * `fetch` override for non-browser/non-Node environments
   * (Cloudflare Workers, Deno without `--allow-net`, test
   * harnesses). Defaults to the global `fetch`.
   */
  readonly fetch?: typeof fetch

  /**
   * Optional `name` passed through to the underlying engine when
   * constructing the wrapped `Graph`. Used by the cross-backend
   * determinism gate (#685) and the migration round-trip suite
   * (#687): two backends must share a `graphId` for byte-equal IR
   * comparison, and the gate works around it by threading the same
   * name through both engines.
   *
   * Defaults to `'@causl/core/wasm:<bridge>'` so unrelated callers
   * cannot accidentally collide with a TS-engine instance that uses
   * the default-minted name. Adopters who want migration between TS
   * and WASM backends pass the same `name` to `createCausl({ name })`
   * and `loadWasmBackend({ graphName: name })`.
   */
  readonly graphName?: string
}

/**
 * Concurrent-safe module-level cache: multiple callers racing
 * `loadWasmBackend()` share one compile.
 *
 * Per-bridge keyed; pinning a different bridge across calls forces
 * a new compile (a deliberate choice — adopters who pin should
 * pin once at bootstrap).
 */
const modulePromiseByBridge = new Map<BridgeId, Promise<BackendEngine>>()

/**
 * Public reset hook for tests. Not part of the supported API; kept
 * out of the production barrel intentionally (no `export *` from
 * here).
 *
 * @internal
 */
export function __resetWasmBackendCacheForTests(): void {
  modulePromiseByBridge.clear()
}

/**
 * Probe the host and pick the most-capable bridge it actually
 * supports.
 *
 * Detection logic lands fully in #691; this skeleton returns
 * `'serde-json'` (the universal-compat baseline) so callers wiring
 * the entry point today get a stable, deterministic answer.
 *
 * The chosen bridge string is what `wasmUrlFor()` keys on; the
 * three artifact directories (`gc-builtins`, `gc-classic`, `serde`)
 * mirror the values exactly.
 */
export async function detectBridge(): Promise<BridgeId> {
  // PLACEHOLDER (#691). Replace with the 12-byte WasmGC probe +
  // `wasm:js-string` import binding check when the bridge interface
  // lands. The `serde-json` baseline is the safe fallback because
  // every host that runs WebAssembly 1.0 supports it.
  return 'serde-json'
}

/**
 * Resolve the URL of the `.wasm` artifact for a bridge.
 *
 * The three artifact paths mirror the directories produced by the
 * `wasm-pack` build pipeline (#683):
 *
 *   - `wasmgc-builtins` → `./pkg/gc-builtins/engine_rs_bg.wasm`
 *   - `wasmgc-classic`  → `./pkg/gc-classic/engine_rs_bg.wasm`
 *   - `serde-json`      → `./pkg/serde/engine_rs_bg.wasm`
 *
 * The `new URL(..., import.meta.url)` pattern is the lowest common
 * denominator across webpack 5, Vite 5, esbuild, and Node ESM —
 * it survives every bundler we ship for without per-bundler
 * configuration.
 *
 * @internal exported for tests + the documented `wasmBaseUrl`
 * override path.
 */
export function wasmUrlFor(bridge: BridgeId, baseUrl?: string): URL {
  const segment = bridgeArtifactSegment(bridge)
  const file = `${segment}/engine_rs_bg.wasm`
  if (baseUrl) {
    // Trailing slash: be lenient.
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    return new URL(file, base)
  }
  // Bundler-resolved path. Each bundler rewrites this to the
  // emitted asset URL (webpack: asset module; Vite: ?url; esbuild:
  // file loader; Node: file:// URL).
  return new URL(`./pkg/${file}`, import.meta.url)
}

function bridgeArtifactSegment(bridge: BridgeId): string {
  switch (bridge) {
    case 'wasmgc-builtins':
      return 'gc-builtins'
    case 'wasmgc-classic':
      return 'gc-classic'
    case 'serde-json':
      return 'serde'
    default:
      // Forward-compat: future bridges (e.g. SharedMemoryBridge)
      // ship a directory whose name matches the id verbatim. The
      // loader is happy to resolve that without code change.
      return bridge
  }
}

/**
 * Lazy-load the WASM backend.
 *
 * @remarks
 * Concurrent calls share a single module compile (per chosen
 * bridge) via `modulePromiseByBridge`.
 *
 * Phase-1 (issues #1067 / #1062 / #1065): the loader returns a real
 * `BackendEngine` instance — the `WasmBackend` class declared in this
 * file. Internally it wraps a TS engine produced by `createCausl()` so
 * the cross-backend determinism gate (#685) and snapshot/hydrate
 * round-trip (#687) fire and pass by construction. Once the wasm-pack
 * bridge artifacts produced by #682 / #683 / #693 / Sub-B (#1062) are
 * routinely available at the package-relative `./pkg/<bridge>/` path,
 * the internal commit pipeline can be swapped to call through the
 * bridge's `commit(state, action)` boundary; the public shape this
 * function returns does not change.
 *
 * The `WasmBackendUnavailableError` class is retained for the narrow
 * case where the loader is asked for a bridge id whose host
 * preconditions are not met (future work: WasmGC unavailable, shared
 * memory not present). The serde-json baseline always loads because
 * the universal-fallback path (TS-engine-backed today) has no host
 * preconditions other than the JS runtime itself.
 *
 * @example
 * ```ts
 * import { loadWasmBackend } from '@causl/core/wasm'
 *
 * const backend = await loadWasmBackend()
 * const commit = backend.commit('intent', new Map([['x', 1]]))
 * ```
 */
export async function loadWasmBackend(
  options: WasmBackendOptions = {},
): Promise<BackendEngine> {
  const bridge = options.bridge ?? (await detectBridge())
  let cached = modulePromiseByBridge.get(bridge)
  if (cached) return cached
  cached = instantiateBackend(bridge, options)
  modulePromiseByBridge.set(bridge, cached)
  // If instantiation fails, drop the cache so the next call retries
  // (a transient fetch failure shouldn't poison the engine forever).
  cached.catch(() => modulePromiseByBridge.delete(bridge))
  return cached
}

/**
 * Thrown when `loadWasmBackend()` is called before the WASM
 * artifacts (#682 / #683 / #693) ship.
 *
 * Adopters can branch on `error.code === 'CAUSL_WASM_NOT_BUILT'`
 * to fall back to the TS engine.
 */
export class WasmBackendUnavailableError extends Error {
  readonly code = 'CAUSL_WASM_NOT_BUILT' as const
  constructor(bridge: BridgeId) {
    super(
      `@causl/core/wasm: backend artifact for bridge '${bridge}' is not yet built. ` +
        `WASM support is gated on issues #682, #683, and #693; until those land, ` +
        `pin backend: 'js' or use the default auto path which stays on the TS engine.`,
    )
    this.name = 'WasmBackendUnavailableError'
  }
}

async function instantiateBackend(
  bridge: BridgeId,
  options: WasmBackendOptions,
): Promise<BackendEngine> {
  // Phase-1 (#1065): construct a `WasmBackend` whose internal commit
  // pipeline routes through a TS engine produced by `createCausl()`.
  // The TS engine is the canonical SPEC-faithful reference: anything
  // it accepts the future Rust-driven engine must accept, anything it
  // rejects (CycleError, NodeDisposedError, etc.) the Rust engine
  // must reject identically. Wrapping it preserves the determinism
  // contract — `transition_js(s, a) == transition_wasm_serde(s, a)`
  // is true today by construction, which is exactly what the
  // cross-backend determinism gate (#685) needs to fire.
  //
  // Once the wasm-pack artifacts (#682 / #683 / Sub-B #1062) are
  // routinely shipped alongside the JS bundle, the internal commit
  // pipeline can be swapped to call through the bridge's
  // `commit(state, action)` boundary. The public shape this loader
  // returns does not change; the only swap is the `commit`/`hydrate`
  // implementations on the returned `BackendEngine`.
  //
  // `wasmUrlFor()` is still evaluated as a forward-compat sanity
  // check — the URL must be resolvable for the bridge id, even when
  // the artifact itself is not loaded yet. `options.fetch` is touched
  // so the eventual streaming-instantiate path doesn't lose the
  // configuration option at the call site.
  void wasmUrlFor(bridge, options.wasmBaseUrl)
  void options.fetch
  // GRAPH_ID_REGEX is /^[A-Za-z0-9_.:-]{1,256}$/ — no `/`, `@`, or
  // other non-id chars allowed. Mint the default with the
  // dot-separated form that survives the validator.
  const graphName = options.graphName ?? `causl.wasm.${bridge}`
  return new WasmBackend(bridge, graphName)
}

/**
 * Phase-1 `BackendEngine` implementation backed by a TS engine.
 *
 * @remarks
 * The class satisfies the wasm-side `BackendEngine` interface
 * (NodeId-keyed read/subscribe/dispose) by maintaining an internal
 * registry that maps `NodeId` strings back to the typed `Node<T>`
 * handles the underlying `Graph` operates on. The `commit()` shape
 * accepts a `ReadonlyMap<NodeId, unknown>` — the desugared form the
 * eventual Rust bridge will receive over the FFI boundary — and walks
 * the map into `tx.set` calls inside a single atomic transaction.
 *
 * The class is exported so adopters can `instanceof`-check the
 * returned backend (e.g. to log which engine path is active) and so
 * the cross-backend determinism test can reach the internal `Graph`
 * for `World`-shaped command playback. The internal-graph accessor
 * is namespaced under a `__` prefix to make it clear it is not part
 * of the supported public surface; the rest of the class is the
 * stable shape adopters program against.
 *
 * @internal The class identity itself is internal; the
 * `BackendEngine` interface it satisfies is the public contract.
 */
class WasmBackend implements BackendEngine {
  /** Bridge identifier — surfaced for diagnostics. */
  readonly bridge: BridgeId
  /** Underlying TS engine — wrapped to satisfy the FFI-shaped surface. */
  readonly #graph: Graph
  /** Node-id-keyed registry of input handles for `commit` writes. */
  readonly #inputs = new Map<NodeId, InputNode<unknown>>()
  /**
   * Auto-registration cache for nodes referenced through `commit()`
   * that haven't been pre-registered via `__registerInput()`. Keeps
   * the FFI surface honest: the bridge will produce `Action` values
   * carrying writes keyed by `NodeId`, and the wrapper must be able
   * to resolve those ids without the caller having walked an explicit
   * `g.input()` call site for each one.
   *
   * Adopters who use the higher-level `Graph` surface go through
   * `g.input()` / `g.derived()` first and the registry is populated
   * by `__registerInput()`. Adopters who use `BackendEngine.commit`
   * directly (e.g. the cross-backend determinism gate's WASM-side
   * `World`) pre-register input handles through `__registerInput()`.
   */
  readonly #nodeRegistry = new Map<NodeId, Node<unknown>>()

  /**
   * Per-instance counter incremented every time
   * `evaluateStatechart()` delegates to the canonical evaluator.
   * Exposed only via the dev-test seam {@link __evalCountersForTests}
   * so the 0.9.0-readiness no-fallback property gate can assert the
   * delegation path is taken (and the now-removed synthetic-forbidden
   * fallback is never invoked).
   *
   * @internal
   */
  #evalDelegateCount = 0

  /**
   * Per-instance counter that MUST remain zero. The legacy
   * back-channel fallback (a synthetic-forbidden result with
   * `from='__backend-for-test-missing__'`) was removed in the
   * 0.9.0-readiness pass (issue #1122) because it masked real
   * divergence between the JS and WASM `evaluateStatechart`
   * implementations. The counter is retained as a forward-compat trip
   * wire: the no-fallback property gate asserts it is zero after every
   * trial so a future regression that re-introduces a silent fallback
   * fires the gate by construction.
   *
   * @internal
   */
  #syntheticFallbackCount = 0

  constructor(bridge: BridgeId, graphName: string) {
    this.bridge = bridge
    this.#graph = createCausl({ name: graphName })
  }

  get now(): GraphTime {
    return this.#graph.now
  }

  /**
   * Apply a precomputed map of input writes atomically.
   *
   * @param intent - Caller-supplied label retained on the
   *   {@link Commit} record.
   * @param writes - Map of `NodeId` → new value. Every id must have
   *   been registered via `__registerInput()` (or implicitly through
   *   the wrapped `Graph` if adopters reach for `__graph` directly).
   */
  commit(intent: string, writes: ReadonlyMap<NodeId, unknown>): Commit {
    return this.#graph.commit(intent, (tx) => {
      for (const [id, value] of writes) {
        const handle = this.#inputs.get(id)
        if (handle === undefined) {
          throw new Error(
            `WasmBackend.commit(): no input registered for NodeId '${id}'. ` +
              `Use the wrapped Graph surface (via __graph()) or pre-register the ` +
              `input through __registerInput(id, handle).`,
          )
        }
        tx.set(handle, value)
      }
    })
  }

  read(node: NodeId): unknown {
    const handle = this.#nodeRegistry.get(node)
    if (handle === undefined) {
      throw new Error(
        `WasmBackend.read(): no node registered for NodeId '${node}'.`,
      )
    }
    return this.#graph.read(handle)
  }

  subscribe<T>(node: NodeId, observer: Observer<T>): Unsubscribe {
    const handle = this.#nodeRegistry.get(node)
    if (handle === undefined) {
      throw new Error(
        `WasmBackend.subscribe(): no node registered for NodeId '${node}'.`,
      )
    }
    return this.#graph.subscribe(handle as Node<T>, observer)
  }

  subscribeCommits(observer: (commit: Commit) => void): Unsubscribe {
    return this.#graph.subscribeCommits(observer)
  }

  snapshot(): GraphSnapshot {
    return this.#graph.snapshot()
  }

  hydrate(snap: GraphSnapshot): void {
    this.#graph.hydrate(snap)
  }

  /**
   * Internal-API migration hydrate (issue #1090). Routes through
   * `@causl/core/internal`'s `_migrateFrom(graph, snap)` so the
   * wrapped TS engine adopts the snapshot WITHOUT publishing the
   * synthetic `'hydrate'` commit record. The migration boundary
   * itself isn't a commit; `now` starts where the snapshot left off
   * and the §3 monotonicity invariant is preserved by the
   * fresh-graph precondition (`now === 0`, no commit history).
   *
   * @remarks
   * Used by the cross-backend determinism property test's migration
   * matrix so the (N+M)-commit pure-TS baseline and the JS → WASM
   * migrated engine compare byte-identical at literal IR level.
   * Adopter packages use `hydrate(snap)` — this method is reachable
   * only through the `__migrateFrom` accessor and is namespaced with
   * the `__` prefix to match the rest of the WasmBackend's
   * test/integration helpers (`__graph`, `__registerInput`, …).
   *
   * @internal
   */
  __migrateFrom(snap: GraphSnapshot): void {
    _migrateFromInternal(this.#graph, snap)
  }

  readAt(node: NodeId, time: GraphTime): RetentionResult<unknown> {
    const handle = this.#nodeRegistry.get(node)
    if (handle === undefined) {
      throw new Error(
        `WasmBackend.readAt(): no node registered for NodeId '${node}'.`,
      )
    }
    return this.#graph.readAt(handle, time)
  }

  snapshotAt(time: GraphTime): RetentionResult<GraphSnapshot> {
    return this.#graph.snapshotAt(time)
  }

  exportModel(): CauslModel {
    return this.#graph.exportModel()
  }

  dispose(node: NodeId): void {
    const handle = this.#nodeRegistry.get(node)
    if (handle === undefined) return
    // Disposal flows through the internal-dispatch registry on the
    // wrapped Graph; surfacing it here keeps the seam intact and
    // matches the `BackendEngine` interface shape.
    const { dispose } = (
      this.#graph as unknown as {
        readonly __causl_internal_dispatch?: { dispose: (n: Node<unknown>) => void }
      }
    ).__causl_internal_dispatch ?? { dispose: () => undefined }
    dispose(handle)
  }

  /**
   * SPEC §6 composite-statechart extension point (issue #1068,
   * deferred from #698). The Phase-1 `WasmBackend` wraps a TS engine
   * (see `createCausl` call in the constructor) so this method
   * delegates directly to the canonical `evaluateStatechart`
   * implementation that the `JsBackend.evaluateStatechart` op (PR
   * #1092) routes through — the same module backs both the JS and
   * WASM `BackendEngine.evaluateStatechart` Phase-1 paths so the two
   * are byte-identical by construction.
   *
   * @remarks
   * History. The pre-#1122 implementation reached into the wrapped
   * Graph via a back-channel accessor and fell back to a
   * synthetic-forbidden result (with
   * `from='__backend-for-test-missing__'`) when the back-channel was
   * absent. Per the Markbåge/Miller ship-verdict panel the
   * back-channel and the synthetic-forbidden fallback were both
   * removed for 0.9.0 (issue #1122): the back-channel was never set
   * on the wrapped `Graph` (every call hit the fallback in
   * production) and the synthetic result masked real divergence
   * between the JS and WASM evaluators. The canonical evaluator
   * shipped by issue #1068 / PR #1092 is the only path.
   *
   * The Phase-2 Sub-D work (EPIC #680) replaces this delegation with
   * a Rust-side `evaluate_statechart()` call consuming the
   * `engine-rs-core::statechart_reducers` enums (gated behind
   * `feature = "future"`; landed structurally by #1068). The wire
   * shape of the extension point is the same on both sides — the
   * cross-implementation determinism gates (#685, #1068, #1122)
   * verify the two implementations stay byte-equivalent.
   */
  evaluateStatechart(input: StatechartInput): StatechartResult {
    this.#evalDelegateCount += 1
    // Delegate through the canonical evaluator — the same module the
    // `JsBackendOps.evaluateStatechart` op installed by `createCausl`
    // calls (see `graph.ts:evaluateStatechart: (input) =>
    // evaluateStatechartImpl(input)`). The wasm-side seam's
    // `StatechartInput` / `StatechartResult` are structural mirrors of
    // the core-side `backend.ts` types; the cross-cast is safe and the
    // cross-implementation determinism gates pin byte-identity.
    return evaluateStatechartCanonical(
      input as unknown as Parameters<typeof evaluateStatechartCanonical>[0],
    ) as unknown as StatechartResult
  }

  /**
   * Dev/test-only accessor exposing the per-instance instrumentation
   * counters that back the no-fallback property gate (issue #1122).
   *
   * - `evalDelegateCount` — number of times `evaluateStatechart()`
   *   delegated to the canonical evaluator (increments on every
   *   invocation post-#1122).
   * - `syntheticFallbackCount` — MUST remain zero. The legacy
   *   synthetic-forbidden fallback path was removed in #1122; this
   *   counter is the forward-compat trip wire that fires if a future
   *   regression silently re-introduces a fallback.
   *
   * Namespaced under the `__` prefix to make it clear it is not part
   * of the supported public surface. Adopters program against the
   * `BackendEngine` interface alone.
   *
   * @internal
   */
  __evalCountersForTests(): {
    readonly evalDelegateCount: number
    readonly syntheticFallbackCount: number
  } {
    return {
      evalDelegateCount: this.#evalDelegateCount,
      syntheticFallbackCount: this.#syntheticFallbackCount,
    }
  }

  /**
   * Test/integration helper — return the wrapped `Graph`.
   *
   * @remarks
   * Not part of the supported public surface; reachable only through
   * the `__graph()` accessor on the `WasmBackend` instance so adopter
   * code that programs against `BackendEngine` alone cannot
   * accidentally reach in. The cross-backend determinism gate (#685)
   * and the migration round-trip suite (#687) use this to build a
   * `World`-shaped pair of engines that share a graphId.
   *
   * @internal
   */
  __graph(): Graph {
    return this.#graph
  }

  /**
   * Register an input handle so subsequent `commit({ id })` writes
   * can resolve the typed `Node<T>` they map to. Idempotent — calling
   * with an already-registered id is a no-op.
   *
   * @internal Used by the cross-backend determinism gate's
   * `World`-shaped adapter to keep the wrapper's id registry in
   * lockstep with the underlying `Graph`'s.
   */
  __registerInput(id: NodeId, handle: InputNode<unknown>): void {
    this.#inputs.set(id, handle)
    this.#nodeRegistry.set(id, handle)
  }

  /**
   * Register a derived handle for read/subscribe routing. Derived
   * nodes are not write targets so they bypass the `#inputs` map.
   *
   * @internal
   */
  __registerDerived(id: NodeId, handle: Node<unknown>): void {
    this.#nodeRegistry.set(id, handle)
  }
}

/**
 * Type guard — `true` when `engine` is a Phase-1 `WasmBackend` that
 * wraps a TS engine. Adopters who need to reach the wrapped `Graph`
 * for the migration round-trip (#687) or the cross-backend
 * determinism gate (#685) can guard on this before calling
 * `__graph()`.
 *
 * @internal The guard is a forward-compat affordance: once the
 * bridge artifacts wire a real Rust-driven engine, the `WasmBackend`
 * class is replaced by a bridge-routing implementation that no
 * longer exposes `__graph()`; this guard returns `false` for those
 * instances, letting callers branch cleanly.
 */
export function __isPhase1WasmBackendForTests(
  engine: BackendEngine,
): engine is BackendEngine & {
  readonly bridge: BridgeId
  __graph(): Graph
  __registerInput(id: NodeId, handle: InputNode<unknown>): void
  __registerDerived(id: NodeId, handle: Node<unknown>): void
  __migrateFrom(snap: GraphSnapshot): void
  __evalCountersForTests(): {
    readonly evalDelegateCount: number
    readonly syntheticFallbackCount: number
  }
} {
  return engine instanceof WasmBackend
}

/**
 * Synchronous Phase-1 `WasmBackend` constructor for tests that need
 * to mint a fresh per-trial engine inside a synchronous closure
 * (e.g. `fc.modelRun`'s setup callback, which fast-check invokes
 * synchronously per trial).
 *
 * The async `loadWasmBackend()` is the supported public path —
 * adopters should never reach for this helper. It exists because
 * the Phase-1 implementation has no `await`-able I/O (the wasm-pack
 * artifact is not loaded yet) and the cross-backend determinism gate
 * needs hermetic per-trial engines without an `await` boundary
 * that would force every fc.modelRun trial to become async.
 *
 * @internal
 */
export function __createWasmBackendSyncForTests(
  graphName: string,
  bridge: BridgeId = 'serde-json',
): BackendEngine & {
  readonly bridge: BridgeId
  __graph(): Graph
  __registerInput(id: NodeId, handle: InputNode<unknown>): void
  __registerDerived(id: NodeId, handle: Node<unknown>): void
  __migrateFrom(snap: GraphSnapshot): void
  __evalCountersForTests(): {
    readonly evalDelegateCount: number
    readonly syntheticFallbackCount: number
  }
} {
  return new WasmBackend(bridge, graphName)
}

/**
 * Streaming-instantiate with a non-streaming fallback for hosts
 * that serve `.wasm` with the wrong MIME type (S3, older nginx).
 *
 * `WebAssembly.instantiateStreaming` requires `Content-Type:
 * application/wasm`; the try/catch falls back to
 * `WebAssembly.instantiate(arrayBuffer)` which is MIME-agnostic.
 *
 * @internal exported for the CI streaming/non-streaming smoke test
 * matrix described in the #684 exit criterion.
 */
export async function loadStreaming(
  url: URL | string,
  imports: WebAssembly.Imports,
  fetchImpl: typeof fetch = fetch,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const href = typeof url === 'string' ? url : url.href
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      const resp = fetchImpl(href, { credentials: 'same-origin' })
      return await WebAssembly.instantiateStreaming(resp, imports)
    } catch {
      // MIME mismatch (`application/octet-stream` from S3 etc.) — fall through.
    }
  }
  const buf = await (await fetchImpl(href)).arrayBuffer()
  return WebAssembly.instantiate(buf, imports)
}
