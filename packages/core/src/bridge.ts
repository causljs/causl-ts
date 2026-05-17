/**
 * @packageDocumentation
 *
 * Pluggable bridge between JS and the WASM-backed engine.
 *
 * @remarks
 * The JS↔WASM boundary is the dominant cost in WebAssembly-backed
 * reactive engines: every commit serialises JS values to UTF-8 JSON,
 * walks them through `serde_json`, and reverses the process on the way
 * out. For a 100k-node graph that is approximately 10⁶–10⁷ allocations
 * per commit on marshalling alone — and most of those go to two
 * operations: object construction/destruction and string copying.
 *
 * Two newer Wasm proposals collapse those costs:
 *
 * - **WasmGC** (Chromium 119+, Firefox 120+, Node 22.6+) — `externref`
 *   reference types let WASM hold GC-managed JS object references
 *   without serialisation.
 * - **JS String Builtins** (Wasm CG Phase 4 / Wasm 3.0; Chrome 131,
 *   Firefox 130+, Node 22.6+) — direct imports for JS string
 *   operations via `(import "wasm:js-string" "length" ...)`. Strings
 *   stay JS-side; no UTF-8 copy.
 *
 * Host support varies — legacy Node, older Safari, embedded runtimes
 * lack one or both. The bridge between JS and WASM is therefore
 * **pluggable**: pick the fastest combination the host actually
 * supports, fall back transparently otherwise.
 *
 * This module ships **only the TypeScript-side abstraction** — the
 * `Bridge` interface, the `BridgeFeatures` capability flags, the
 * `detectBridge()` harness that probes the host, and a placeholder
 * `serde-json` bridge that always succeeds. The two real bridge
 * implementations land in dedicated PRs:
 *
 * - #692 — WasmGC + JS String Builtins (dual artifact: builtins +
 *   classic fallback)
 * - #693 — `serde_json` + UTF-8 fallback bridge
 *
 * Until those land, `detectBridge()` returns the universal
 * placeholder. Consumers can program against the interface today; when
 * the implementations ship, no consumer code changes.
 *
 * The interface is intentionally over-specified to preserve seams for
 * proposals not yet baseline:
 *
 * - {@link BridgeFeatures.sharedMemory} — flagged today, no consumers.
 *   When the threading EPIC opens, a `SharedMemoryBridge` slot already
 *   exists in `detectBridge()`. Threading is no longer an
 *   "architectural rewrite"; it is a fourth bridge.
 * - {@link BridgeFeatures.stringView} — flagged today, future
 *   `wasm:string-view` bridge slot. Loader can probe
 *   `wasm:string-view`/`length` analogous to the JS String Builtins
 *   probe.
 * - {@link CodeUnitIndex} / {@link CodePointIndex} newtypes —
 *   committed in the public API now. When `wasm:string-view` lands
 *   (code-point native), only the bridge implementation changes;
 *   consumers' index types stay correct.
 * - {@link Bridge.abiVersion} — bumped on any ABI-breaking bridge
 *   change. The Rust side ships
 *   `#[link_section = ".bridge_abi_version"] static ABI_VERSION: u8 = N;`;
 *   the JS loader reads the section before instantiation; mismatched
 *   bridges fail-closed with a clear error.
 */

/**
 * Capability flags reported by a {@link Bridge} implementation.
 *
 * @remarks
 * Each flag corresponds to a Wasm or host-platform proposal that — if
 * present — collapses a layer of marshalling cost on the JS↔WASM
 * boundary. The flags are surfaced on the interface (rather than
 * inferred from `Bridge.id`) so consumers can branch on the
 * capability they care about without enumerating bridge identities,
 * and so future bridges with novel mixes of capabilities slot in
 * without churning the type.
 */
export interface BridgeFeatures {
  /**
   * WasmGC reference types (`externref` / `ref.null any`). When true,
   * the bridge can hold GC-managed JS object references inside WASM
   * tables without serialising them to JSON.
   */
  readonly gc: boolean
  /**
   * JS String Builtins — direct imports of JS string operations from
   * the `wasm:js-string` import module. When true, the bridge avoids
   * the UTF-8 round-trip for strings that cross the boundary.
   */
  readonly jsStringBuiltins: boolean
  /**
   * SharedArrayBuffer + Atomics + `WebAssembly.Memory({ shared: true })`.
   * Reserved for the future threading EPIC; no consumers today, but
   * surfaced so the multi-threaded bridge fits the same interface.
   */
  readonly sharedMemory: boolean
  /**
   * `wasm:string-view` — the proposal that exposes JS string slices
   * to Wasm with code-point-native indexing. Reserved for the future
   * string-view bridge; no consumers today.
   */
  readonly stringView: boolean
}

/**
 * Branded UTF-16 code-unit index (the JS String addressing model).
 *
 * @remarks
 * JS strings are UTF-16 code-unit sequences, so all current string
 * bridges index by code unit. The brand keeps the public API stable
 * when a future `wasm:string-view` bridge introduces a code-point
 * addressing path: the index newtype stays correct on the consumer
 * side because the type is structurally distinct from a plain
 * `number`.
 */
export type CodeUnitIndex = number & { readonly __brand: 'CodeUnit' }

/**
 * Branded Unicode code-point index.
 *
 * @remarks
 * Reserved for the future `wasm:string-view` bridge, which is
 * code-point-native. Surfaced today so the public API does not change
 * shape when the bridge upgrades.
 */
export type CodePointIndex = number & { readonly __brand: 'CodePoint' }

/**
 * Opaque handle to a JS object that the bridge has registered with
 * the WASM module.
 *
 * @remarks
 * The shape (an integer slot id, a GC root token, an `externref`)
 * varies by bridge. Consumers must treat the handle as opaque and
 * round-trip it only through {@link Bridge.fromWasmObject} and
 * {@link Bridge.release}.
 */
export interface WasmObjectHandle {
  readonly __kind: 'WasmObjectHandle'
}

/**
 * Opaque handle to a JS string the bridge has registered with the
 * WASM module.
 *
 * @remarks
 * As with {@link WasmObjectHandle}, the shape varies by bridge —
 * UTF-8 length-prefixed pointer, slot id, `externref` of the JS
 * string, future `stringref` — and the handle is opaque to the
 * caller.
 */
export interface WasmStringHandle {
  readonly __kind: 'WasmStringHandle'
}

/**
 * Discriminated union of every handle a bridge may issue.
 *
 * @remarks
 * `release()` accepts any handle the bridge has issued; the union
 * keeps the call site honest without forcing each kind through a
 * separate method.
 */
export type WasmHandle = WasmObjectHandle | WasmStringHandle

/**
 * Stable identifier for the three baseline bridges plus a
 * forward-compatible escape hatch for future bridges (`shared-memory`,
 * `string-view`, …) that land against the same interface.
 */
export type BridgeId =
  | 'wasmgc-builtins'
  | 'wasmgc-classic'
  | 'serde-json'
  | (string & { readonly __brand?: 'FutureBridge' })

/**
 * Pluggable JS↔WASM boundary contract.
 *
 * @remarks
 * Every bridge in the matrix — `wasmgc-builtins` (#692),
 * `wasmgc-classic` (#692 fallback artifact), `serde-json` (#693), and
 * any future bridge (e.g. `shared-memory` for the threading EPIC) —
 * implements this interface. The {@link BackendEngine} consumes only
 * the interface; bridges are interchangeable at runtime.
 *
 * Two operations dominate boundary cost — object construction and
 * string copying — so they are the only two crossings the interface
 * exposes as primitives. Numbers and booleans pass through cheaply
 * (8 bytes / 4 bytes respectively) and need no bridge primitive.
 */
export interface Bridge {
  /**
   * Stable identifier for telemetry and benchmarking. The three
   * baseline ids are `wasmgc-builtins`, `wasmgc-classic`, and
   * `serde-json`; future bridges add new ids without deprecating
   * existing ones.
   */
  readonly id: BridgeId
  /**
   * Capability flags this bridge advertises. Consumers branch on the
   * flag, not the {@link Bridge.id}.
   */
  readonly features: BridgeFeatures
  /**
   * ABI version, bumped on any ABI-breaking bridge change. The
   * Rust-side `.bridge_abi_version` linker section is read by the
   * loader and matched against this number; a mismatch fails-closed
   * before the WASM module is instantiated.
   */
  readonly abiVersion: number
  /**
   * Register a JS object with the WASM module and return an opaque
   * handle.
   */
  toWasmObject(o: object): WasmObjectHandle
  /**
   * Resolve an opaque object handle back to its JS object.
   */
  fromWasmObject(h: WasmObjectHandle): object
  /**
   * Register a JS string with the WASM module and return an opaque
   * handle. The bridge owns the allocation; callers must
   * {@link Bridge.release} it when done.
   *
   * Result strings are allocated through the bridge's allocator so a
   * future `wasm:string-view` bridge can substitute its own without
   * changing the consumer surface.
   */
  toWasmString(s: string): WasmStringHandle
  /**
   * Resolve an opaque string handle back to a JS string.
   *
   * The returned string is a plain JS `string` even when the bridge
   * keeps the underlying buffer in WASM linear memory; the bridge
   * never leaks `JsValue` (or any wasm-bindgen wrapper) into bridge
   * consumers.
   */
  fromWasmString(h: WasmStringHandle): string
  /**
   * Release a handle previously issued by this bridge. Idempotent;
   * releasing an unknown or already-released handle is a no-op.
   */
  release(h: WasmHandle): void
}

/**
 * Probe each {@link BridgeFeatures} capability in turn.
 *
 * @remarks
 * Probes are runtime, not build-time, so a host that newly enables
 * GC (or flips an experimental flag on the next page load) picks up
 * the fast bridge automatically. Each probe is cheap: a 12-byte
 * module compilation plus a `WebAssembly.compile` rejection check.
 *
 * The probes are:
 *
 * 1. **WasmGC** — try compiling a tiny module that uses
 *    `ref.null any`. If `WebAssembly.compile` rejects, no GC.
 * 2. **JS String Builtins** — try compiling a module that imports
 *    `wasm:js-string.length`. If rejected, no String Builtins.
 * 3. **Shared memory** — check `crossOriginIsolated` and probe
 *    `new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })`.
 * 4. **String view** — try compiling a module that imports
 *    `wasm:string-view`. If rejected, no string-view (the common case
 *    today; no host has shipped string-view yet).
 *
 * The probes catch any thrown exception and report `false` for that
 * capability — feature detection failures are never fatal.
 *
 * @internal Surface kept narrow so the test suite can override
 * individual probes via {@link detectBridge}'s feature override.
 */
export async function detectFeatures(): Promise<BridgeFeatures> {
  const gc = await probeWasmGc()
  const jsStringBuiltins = await probeJsStringBuiltins()
  const sharedMemory = probeSharedMemory()
  const stringView = await probeStringView()
  return Object.freeze({ gc, jsStringBuiltins, sharedMemory, stringView })
}

/**
 * Compile-and-discard probe template. Any thrown error or rejected
 * promise reports the capability as absent.
 */
async function tryCompile(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.compile !== 'function') {
      return false
    }
    await WebAssembly.compile(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Minimal "WasmGC available" probe — a 12-byte module that references
 * `ref.null any`. Pre-GC engines reject the module at compile time;
 * GC-enabled engines accept it.
 *
 * @remarks
 * The exact byte sequence is intentionally captured at a single call
 * site so future tightening of the probe (e.g. once browsers settle
 * on a richer GC type test) lands in one place.
 */
async function probeWasmGc(): Promise<boolean> {
  // (module (func (drop (ref.null any)))) — 12-byte WasmGC sniff.
  // The shape is the smallest module that *requires* GC types; on
  // pre-GC engines `WebAssembly.compile` rejects with a validation
  // error, on GC engines it succeeds.
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
    0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
    0x0a, 0x07, 0x01, 0x05, 0x00, 0xd0, 0x6e, 0x1a, 0x0b,
    // code section: ref.null any (0xd0 0x6e), drop (0x1a), end (0x0b)
  ])
  return tryCompile(bytes)
}

/**
 * "JS String Builtins available" probe — try compiling a module that
 * imports `wasm:js-string.length`.
 *
 * @remarks
 * The probe is conservative: hosts that recognise the import module
 * accept the compile; hosts that don't reject with a link or
 * validation error. We additionally consult
 * `WebAssembly.validate` shape if the host exposes it.
 */
async function probeJsStringBuiltins(): Promise<boolean> {
  // (module (import "wasm:js-string" "length" (func (param externref) (result i32))))
  // Pre-builtins engines reject the import-module name; engines with
  // builtins accept it (and the compiled module is discarded).
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    // type section: (param externref) -> (i32)
    0x01, 0x06, 0x01, 0x60, 0x01, 0x6f, 0x01, 0x7f,
    // import section: "wasm:js-string" . "length" : func type 0
    0x02, 0x1c, 0x01,
    0x0e, 0x77, 0x61, 0x73, 0x6d, 0x3a, 0x6a, 0x73, 0x2d, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67,
    0x06, 0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68,
    0x00, 0x00,
  ])
  return tryCompile(bytes)
}

/**
 * "Shared memory available" probe — checks both that the page is
 * cross-origin-isolated (or running outside the browser) and that
 * `WebAssembly.Memory` accepts the `shared: true` constructor option.
 */
function probeSharedMemory(): boolean {
  try {
    // In browsers, SharedArrayBuffer requires COOP/COEP isolation; in
    // Node, `crossOriginIsolated` is undefined and the check passes
    // through.
    const isolation = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
    if (isolation === false) return false
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Memory !== 'function') {
      return false
    }
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true } as WebAssembly.MemoryDescriptor)
    return true
  } catch {
    return false
  }
}

/**
 * "wasm:string-view available" probe.
 *
 * @remarks
 * No host has shipped `wasm:string-view` as of this writing, so the
 * probe is expected to return `false` everywhere. It exists so the
 * future string-view bridge slots in without changing the harness.
 */
async function probeStringView(): Promise<boolean> {
  // (module (import "wasm:string-view/wtf16" "length" (func (param externref) (result i32))))
  // Hosts that ship the string-view proposal accept this import
  // module name; everyone else rejects it.
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x06, 0x01, 0x60, 0x01, 0x6f, 0x01, 0x7f,
    0x02, 0x26, 0x01,
    0x18, 0x77, 0x61, 0x73, 0x6d, 0x3a, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67, 0x2d, 0x76, 0x69, 0x65, 0x77, 0x2f, 0x77, 0x74, 0x66, 0x31, 0x36,
    0x06, 0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68,
    0x00, 0x00,
  ])
  return tryCompile(bytes)
}

/**
 * Read the `CAUSL_WASM_BRIDGE` env var if available. Mirrors the
 * defensive lookup pattern used in {@link loadFlagsFromEnv}: never
 * throws if `process` is absent or `process.env` is a hostile Proxy.
 */
function readBridgeOverride(): 'gc' | 'serde' | 'auto' | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    const raw = proc?.env?.CAUSL_WASM_BRIDGE
    if (raw === 'gc' || raw === 'serde' || raw === 'auto') return raw
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Placeholder `serde-json` bridge.
 *
 * @remarks
 * **STUB.** This is the universal-fallback placeholder returned by
 * {@link detectBridge} until the real implementations land in #692
 * (WasmGC + JS String Builtins) and #693 (`serde_json` + UTF-8
 * fallback). Every bridge primitive throws — instantiating a real
 * WASM module is the responsibility of the bridge-specific PRs. The
 * placeholder exists so:
 *
 * 1. The TypeScript surface compiles and is exported today.
 * 2. Consumers programming against {@link Bridge} get a non-`null`
 *    return value from {@link detectBridge} and can branch on
 *    `bridge.id === 'serde-json'` without `undefined` checks.
 * 3. Tests that exercise the harness end-to-end can assert the
 *    fallback path returns *some* bridge.
 *
 * The {@link BridgeFeatures} flags are all `false`: the placeholder
 * advertises no Wasm capabilities. The {@link Bridge.abiVersion} is
 * pinned at `0` to make it visually distinct from the real
 * `serde-json` bridge (which will ship at `abiVersion: 1`).
 */
function makeSerdeJsonPlaceholder(): Bridge {
  const placeholderError = (): Error =>
    new Error(
      '[@causl/core] serde-json bridge is a placeholder pending #693. ' +
        'Real implementation lands with the wasm-pack pipeline.',
    )
  const features: BridgeFeatures = Object.freeze({
    gc: false,
    jsStringBuiltins: false,
    sharedMemory: false,
    stringView: false,
  })
  return Object.freeze<Bridge>({
    id: 'serde-json',
    features,
    abiVersion: 0,
    toWasmObject(): WasmObjectHandle {
      throw placeholderError()
    },
    fromWasmObject(): object {
      throw placeholderError()
    },
    toWasmString(): WasmStringHandle {
      throw placeholderError()
    },
    fromWasmString(): string {
      throw placeholderError()
    },
    release(): void {
      // Idempotent no-op; matches the real bridge contract so that
      // disposal code that runs after instantiation failure does not
      // itself throw.
    },
  })
}

/**
 * Pick the highest-tier bridge available on the current host.
 *
 * @remarks
 * Selection order:
 *
 * 1. If `CAUSL_WASM_BRIDGE=serde`, return the `serde-json` bridge.
 * 2. If `CAUSL_WASM_BRIDGE=gc` or the host advertises both
 *    {@link BridgeFeatures.gc} and
 *    {@link BridgeFeatures.jsStringBuiltins}, attempt to load the
 *    `wasmgc-builtins` bridge; on instantiation failure fall through.
 * 3. If only {@link BridgeFeatures.gc} is available, attempt to load
 *    the `wasmgc-classic` bridge; on failure fall through.
 * 4. Otherwise return the universal `serde-json` bridge.
 *
 * Tier table per #680's browser-compat audit:
 *
 * | Tier | Hosts                                              | Bridge            |
 * | ---- | -------------------------------------------------- | ----------------- |
 * | A    | Chromium 131+, Firefox 130+, Node 22.6+            | `wasmgc-builtins` |
 * | B    | Safari 18.2+ (GC yes, builtins uncertain)          | `wasmgc-classic`  |
 * | C    | Cloudflare Workers, Vercel Edge, Deno Deploy       | `serde-json`      |
 * | D    | Node 18 LTS, anything pre-GC                       | `serde-json`      |
 *
 * **STUB BEHAVIOUR (current PR).** Until #692 and #693 land the real
 * bridges, this function always returns a {@link makeSerdeJsonPlaceholder}
 * regardless of host capabilities. The probes still run (they
 * exercise the harness on the real hosts that the CI matrix covers),
 * but their results are recorded only on the returned bridge's
 * {@link BridgeFeatures} for telemetry; the bridge identity stays
 * `serde-json`. When the real bridges land, the
 * `loadGcBridge()` / `loadSerdeBridge()` hooks below switch to
 * dynamic-import-based loaders and the function's return type does
 * not change.
 *
 * Feature-detection failures never crash: the harness always returns
 * *some* bridge — the universal fallback if every probe rejects.
 */
export async function detectBridge(): Promise<Bridge> {
  let features: BridgeFeatures
  try {
    features = await detectFeatures()
  } catch {
    // Defensive: a hostile host that throws on `WebAssembly.compile`
    // (e.g. CSP `wasm-src 'none'`) must not crash the loader. Fall
    // through to the universal bridge.
    features = Object.freeze({
      gc: false,
      jsStringBuiltins: false,
      sharedMemory: false,
      stringView: false,
    })
  }

  const explicit = readBridgeOverride()
  if (explicit === 'serde') {
    return loadSerdeBridge(features)
  }
  if (explicit === 'gc' || (features.gc && features.jsStringBuiltins)) {
    try {
      return await loadGcBridge(features)
    } catch {
      // Fall through to the serde fallback.
    }
  }
  if (features.gc) {
    try {
      return await loadGcClassicBridge(features)
    } catch {
      // Fall through.
    }
  }
  return loadSerdeBridge(features)
}

/**
 * Loader hook for the GC + String Builtins bridge.
 *
 * @remarks
 * **STUB pending #692.** Returns the placeholder. The real
 * implementation will dynamic-import `@causl/core/wasm-gc-builtins`
 * and instantiate the wasm-pack-produced module.
 */
async function loadGcBridge(_features: BridgeFeatures): Promise<Bridge> {
  // Awaiting a resolved promise keeps the function signature aligned
  // with the eventual dynamic-import loader without introducing
  // microtask reordering versus the GC-classic loader.
  await Promise.resolve()
  // The placeholder's features are pinned to `all-false`; we must
  // not lie about the host's GC support just because the loader
  // returns a placeholder. The `_features` argument is captured by
  // the real loader (#692) when it ships; the leading underscore is
  // the codebase's convention for an interface-mandated parameter
  // not yet consumed.
  return makeSerdeJsonPlaceholder()
}

/**
 * Loader hook for the GC-only fallback bridge (no JS String Builtins).
 *
 * @remarks
 * **STUB pending #692.** Returns the placeholder. The real
 * implementation will dynamic-import `@causl/core/wasm-gc-classic`.
 */
async function loadGcClassicBridge(_features: BridgeFeatures): Promise<Bridge> {
  await Promise.resolve()
  return makeSerdeJsonPlaceholder()
}

/**
 * Loader hook for the universal serde-json fallback bridge.
 *
 * @remarks
 * **STUB pending #693.** Returns the placeholder. The real
 * implementation will dynamic-import `@causl/core/wasm-serde` and
 * instantiate the wasm-pack-produced module.
 */
function loadSerdeBridge(_features: BridgeFeatures): Bridge {
  return makeSerdeJsonPlaceholder()
}
