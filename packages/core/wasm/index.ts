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

// F-marshal scaffold (#1463+) — public re-export of the WasmStateMirror
// marshaler surface. Adopters wire this up via the `BackendEngine`
// methods today (TS-engine wrap) and through the marshaler directly
// once F-marshal.5 routes `WasmBackend.commit()` through it.
import {
  applyBatchBridgeResult,
  applyBridgeResult,
  marshalBatchEnvelope,
  marshalCommitEnvelope,
  WasmStateMirror,
  type BatchBridgeResult,
  type BatchCommitInput,
  type BridgeResult,
  type JsonValue as MarshalerJsonValue,
} from './marshaler.js'
export {
  applyBatchBridgeResult,
  applyBridgeResult,
  hydrate,
  marshalBatchEnvelope,
  marshalCommitEnvelope,
  NodeDisposedError,
  snapshot,
  WasmStateMirror,
} from './marshaler.js'
export type {
  BatchBridgeResult,
  BatchCommitInput,
  BatchEnvelope,
  BridgeAllocator,
  BridgeCommitAction,
  BridgeCommitRecord,
  BridgeResult,
  BridgeState,
  CommitEnvelope,
  InputCellWire,
  JsonValue as MarshalerJsonValue,
  Slot,
} from './marshaler.js'

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

// ---------------------------------------------------------------------------
// C.3 (#1501) — BatchedFlush queue.
//
// Option (c) batched-commit boundary scaffolding (epic #1493). Per
// `docs/epic-1483/option-c-batched-boundary.md` §2.1 Answer C the JS
// engine is SSOT: `commit()` returns the TS graph's `Commit`
// synchronously; the marshaler runs in a buffered SHADOW mode. The
// only thing this queue batches is the WASM-side WIRE crossing — NOT
// the commit semantics, NOT subscriber dispatch (§4.2 choice (i)), NOT
// `graph.now` advancement (§3.1, one tick per commit always).
//
// **No adopter-visible perf change at v1.x.** With the default
// `afterN = 1` (wired through `createCausl` in C.4) the queue flushes
// immediately on every commit, which is byte-identical to the
// pre-C.3 per-commit shadow path (option-c doc §2.3 / §7). This is
// scaffolding for a future v2.x Rust-SSOT cutover, not a perf win;
// the #1133 boundary-tax falsification is not refuted by this work.
// ---------------------------------------------------------------------------

/**
 * The shadow bridge adapter the {@link BatchedFlush} queue drives. The
 * single-commit `commit(state, action)` is the pre-C.3 F-marshal.5
 * shadow surface (kept for the `afterN === 1` fast path and for
 * adapters that have not adopted `commit_batch` yet); `commit_batch`
 * is the C.1 batched extern (`tools/engine-rs-bridge-{serde,gc}`,
 * PRs #1496/#1497).
 */
export interface BatchedFlushBridge {
  commit(state: unknown, action: unknown): unknown
  /**
   * Optional — the C.1 `commit_batch(state, actions)` extern. When a
   * primed bridge does not expose it (legacy single-commit adapters,
   * older test mocks) the queue degrades to N sequential
   * `commit(state, action)` calls, which is byte-identical by
   * construction (option-c doc §3.1) — the loop body IS the
   * single-envelope path.
   */
  commit_batch?(state: unknown, actions: unknown): unknown
}

/**
 * C.3 (#1501) — buffered shadow-flush queue for the WASM wire
 * crossing.
 *
 * Buffers per-commit `(intent, writes)` shadow inputs and flushes them
 * as a single `commit_batch` envelope when a trigger fires:
 *
 *   - **count** — `afterN` commits buffered (this PR);
 *   - **time** — `intervalMs` elapsed since the first buffered commit
 *     (C.3 PR 2);
 *   - **manual** — {@link flush} called explicitly (this PR);
 *   - **implicit** — `snapshot()` / `dispose()` force a flush so the
 *     WASM-side state reflects committed work (C.3 PR 3).
 *
 * The queue NEVER influences the adopter-facing `Commit` — that is the
 * TS graph's synchronous return (Answer C). A flush failure is
 * captured for the cross-backend determinism gate's assertion path
 * exactly as the pre-C.3 shadow path captured per-commit failures;
 * adopter commits do not throw on shadow failures (the TS graph is
 * SSOT).
 */
export class BatchedFlush {
  /** Count-based flush threshold. `1` = flush every commit (default). */
  readonly afterN: number

  /** Buffered per-commit shadow inputs, in commit order. */
  readonly #buffer: BatchCommitInput[] = []

  /** The mirror the queue marshals against (Decision 1 SSOT — JS-side). */
  readonly #mirror: WasmStateMirror

  /** Shadow bridge adapter (single + optional batched extern). */
  readonly #bridge: BatchedFlushBridge

  /** Captured flush error for the determinism gate's assertion path. */
  #error: Error | undefined

  /**
   * The `mirror.now` value the NEXT flush's envelope must start from
   * (the pre-batch clock). Set when the first commit is buffered so
   * the batch envelope's `state.now` matches what the SSOT TS engine
   * started the first buffered commit from — mirrors the pre-C.3
   * per-commit `mirror.now` sync (index.ts:581).
   */
  #pendingBaseNow: number | undefined

  constructor(
    mirror: WasmStateMirror,
    bridge: BatchedFlushBridge,
    afterN = 1,
  ) {
    if (!Number.isInteger(afterN) || afterN < 1) {
      throw new RangeError(
        `BatchedFlush: afterN must be an integer >= 1 (got ${String(afterN)})`,
      )
    }
    this.#mirror = mirror
    this.#bridge = bridge
    this.afterN = afterN
  }

  /** Number of commits currently buffered (un-flushed). */
  get pending(): number {
    return this.#buffer.length
  }

  /**
   * Captured flush error, if the most recent flush threw. Cleared on
   * the next successful flush. The cross-backend determinism gate
   * asserts this stays `undefined`.
   */
  get error(): Error | undefined {
    return this.#error
  }

  /**
   * Buffer one commit's shadow input. The `baseNow` is the TS graph's
   * PRE-commit clock for the FIRST buffered commit (the value the
   * batch envelope's `state.now` must carry); subsequent commits in
   * the same window do not move it (the Rust extern threads the
   * post-state internally). Triggers a count-based flush when the
   * buffer reaches `afterN`.
   */
  enqueue(input: BatchCommitInput, baseNow: number): void {
    if (this.#buffer.length === 0) {
      this.#pendingBaseNow = baseNow
    }
    this.#buffer.push(input)
    if (this.#buffer.length >= this.afterN) {
      this.flush()
    }
  }

  /**
   * Flush the buffer as a single `commit_batch` envelope (or, if the
   * bridge lacks the batched extern, as N sequential single-commit
   * calls — byte-identical by construction, option-c doc §3.1). A
   * no-op when the buffer is empty (so implicit/manual flushes are
   * always safe to call). The projected `Commit[]` is returned for
   * the C.3 PR 3 implicit-flush callers; the per-commit subscriber
   * fire is the JS engine's job (Answer C — NOT batched here).
   */
  flush(): Commit[] {
    if (this.#buffer.length === 0) return []
    const batch = this.#buffer.splice(0, this.#buffer.length)
    const baseNow = this.#pendingBaseNow ?? (this.#mirror.now as unknown as number)
    this.#pendingBaseNow = undefined
    try {
      // Sync the mirror clock to the pre-batch base so the envelope's
      // `state.now` matches what the SSOT TS engine started the first
      // buffered commit from (mirrors index.ts:581's per-commit sync,
      // applied once per batch boundary).
      this.#mirror.now = baseNow as unknown as GraphTime
      const envelope = marshalBatchEnvelope(this.#mirror, batch)
      if (typeof this.#bridge.commit_batch === 'function') {
        const result = this.#bridge.commit_batch(
          envelope.state,
          envelope.actions,
        ) as BatchBridgeResult
        const commits = applyBatchBridgeResult(this.#mirror, result)
        this.#error = undefined
        return commits
      }
      // Degrade path: the bridge has no batched extern. Replay the
      // batch as N sequential single-commit shadow calls. This is
      // byte-identical to the batched path by construction — the
      // loop body IS the single-envelope path (option-c doc §3.1).
      const commits: Commit[] = []
      for (const single of batch) {
        const singleEnv = marshalCommitEnvelope(
          this.#mirror,
          single.intent,
          single.writes as ReadonlyMap<NodeId, MarshalerJsonValue>,
        )
        const singleResult = this.#bridge.commit(
          singleEnv.state,
          singleEnv.action,
        ) as BridgeResult
        commits.push(applyBridgeResult(this.#mirror, singleResult))
      }
      this.#error = undefined
      return commits
    } catch (err) {
      // Shadow-path failure — captured for the determinism gate.
      // Adopter commits do not throw (the TS graph is SSOT).
      this.#error = err as Error
      return []
    }
  }
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
    // F-marshal.5 (#1468) — ROUTE COMMIT THROUGH THE MARSHALER. The
    // adopter-facing return value is still the TS graph's `Commit`
    // (the SSOT for `read` / `subscribe` / `snapshot` until those
    // adopters' methods land on the marshaler in F-marshal.7); the
    // marshaler call runs as a shadow contract assertion so the JS↔
    // WASM wire path is exercised on every commit.
    //
    // The shadow path is gated on the marshaler mirror being
    // initialised — the cross-backend determinism property test
    // primes it via `__primeMarshalerForTests` before each scenario
    // so the gate fires green-by-construction on Action::Commit only.
    // Other adopter paths see no behavioural change today.
    const tsCommit = this.#graph.commit(intent, (tx) => {
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

    // C.3 (#1501) — BUFFERED shadow path. When a BatchedFlush queue is
    // primed, the per-commit shadow wire crossing is buffered and
    // flushed on a trigger (count this PR; time/manual/implicit in
    // C.3 PR 2/3) as a single `commit_batch` envelope. The
    // adopter-facing return is STILL the TS graph's synchronous
    // `Commit` (option-c doc §2.1 Answer C — only the wire crosses
    // batches, not the commit semantics). With the default afterN=1
    // (wired via createCausl in C.4) this is byte-identical to the
    // pre-C.3 per-commit shadow path (option-c doc §2.3 / §7).
    if (this.#batchedFlush !== undefined) {
      // The pre-batch base clock for the FIRST buffered commit is the
      // TS graph's PRE-commit clock (tsCommit.time - 1), exactly the
      // value the pre-C.3 per-commit path synced mirror.now to.
      this.#batchedFlush.enqueue(
        {
          intent,
          writes: writes as ReadonlyMap<NodeId, MarshalerJsonValue>,
        },
        (tsCommit.time as number) - 1,
      )
    } else if (this.#marshaler !== undefined) {
      // Pre-C.3 per-commit shadow path — preserved verbatim for the
      // F-marshal.5 gate that primes only the single-commit mirror.
      // Null-safe so adopters who never prime see no overhead.
      try {
        // Sync mirror.now to the TS graph's pre-commit clock so the
        // marshaler envelope's `state.now` matches what the SSOT TS
        // engine commit started from. The TS Graph mints a non-zero
        // starting `now` per warmup discipline; without this sync the
        // shadow path would diverge by exactly the warmup offset.
        this.#marshaler.now = (tsCommit.time as number) - 1 as GraphTime
        const envelope = marshalCommitEnvelope(
          this.#marshaler,
          intent,
          writes as ReadonlyMap<NodeId, MarshalerJsonValue>,
        )
        // The marshaler call is fire-and-forget: it pins the wire
        // shape but does not influence the returned Commit. The
        // bridge call returns a BridgeResult we apply to the mirror
        // so `mirror.now` / `mirror.inputs` track the TS graph.
        const bridgeResult = this.#marshalerBridge!.commit(
          envelope.state,
          envelope.action,
        ) as BridgeResult
        applyBridgeResult(this.#marshaler, bridgeResult)
      } catch (err) {
        // Surface shadow-path failures via the marshaler-error hook
        // so the cross-backend gate's assertion path sees them. Adopter
        // commits do not throw on shadow failures (the TS graph is
        // SSOT).
        this.#marshalerError = err as Error
      }
    }

    return tsCommit
  }

  /** C.3 (#1501) — BatchedFlush queue (buffered shadow path). */
  #batchedFlush: BatchedFlush | undefined

  /**
   * C.3 (#1501) — install a {@link BatchedFlush} queue so `commit()`
   * BUFFERS the shadow wire crossing instead of flushing per-commit.
   * The adopter-facing `commit()` return is unchanged (the TS graph's
   * synchronous `Commit`). When a queue is primed it SUPERSEDES the
   * pre-C.3 single-commit shadow path; the cross-backend determinism
   * gate's per-flush assertion (C.5) reads {@link __getBatchedFlushForTests}.
   *
   * @internal Test-only seam until C.4 wires it through `createCausl`.
   */
  __primeBatchedFlushForTests(queue: BatchedFlush): void {
    this.#batchedFlush = queue
  }

  /**
   * C.3 (#1501) — the installed {@link BatchedFlush} queue (or
   * `undefined`). The cross-backend determinism gate (C.5) reads
   * `.error` off this for its per-flush assertion path; implicit-flush
   * callers (C.3 PR 3) read it to force a flush before
   * `snapshot()` / `dispose()`.
   *
   * @internal
   */
  __getBatchedFlushForTests(): BatchedFlush | undefined {
    return this.#batchedFlush
  }

  /**
   * F-marshal.5 (#1468) — install a marshaler mirror + bridge adapter
   * so `commit()` shadows the JS↔WASM wire path on every commit. The
   * cross-backend determinism gate uses this to exercise the marshaler
   * surface without changing adopter-facing semantics.
   *
   * @internal Test-only seam. Production paths leave the marshaler
   * dormant; F-marshal.7 promotes the marshaler from shadow to SSOT
   * for snapshot/hydrate.
   */
  __primeMarshalerForTests(
    mirror: WasmStateMirror,
    bridge: { commit(state: unknown, action: unknown): unknown },
  ): void {
    this.#marshaler = mirror
    this.#marshalerBridge = bridge
    this.#marshalerError = undefined
  }

  /**
   * F-marshal.5 (#1468) — surface any error captured by the shadow
   * marshaler path. The cross-backend determinism gate calls this
   * after each command to assert the marshaler stays green; production
   * adopters never see this surface.
   *
   * @internal
   */
  __getMarshalerErrorForTests(): Error | undefined {
    return this.#marshalerError
  }

  /** F-marshal.5 (#1468) — JS-side mirror, populated by the gate's prime. */
  #marshaler: WasmStateMirror | undefined
  /** F-marshal.5 (#1468) — bridge adapter, populated by the gate's prime. */
  #marshalerBridge:
    | { commit(state: unknown, action: unknown): unknown }
    | undefined
  /** F-marshal.5 (#1468) — captured shadow-path error for test inspection. */
  #marshalerError: Error | undefined

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
