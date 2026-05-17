/**
 * @packageDocumentation
 *
 * Cross-bridge `Commit` byte-identity property suite (EPIC #680, sub-
 * issue #1071). Drives the SAME `Action` through both wasm-engine
 * bridges — `engine-rs-bridge-serde` (universal-fallback) and
 * `engine-rs-bridge-gc` (WasmGC + `wasm:js-string`) — and asserts the
 * resulting `Commit` JSON is byte-identical across the two marshalling
 * paths.
 *
 * This is the **cross-bridge** gate (distinct from #685's
 * **cross-backend** gate that pins
 * `transition_js(s, a) == transition_wasm(s, a)`). The cross-bridge
 * gate sits one tier below: regardless of which JS↔WASM bridge a host
 * picks, the *engine* output must be the same down to the byte. A
 * divergence between bridges with the same input
 * means a marshalling drift (a NodeId reorder in a JSON serializer, a
 * BigInt vs Number coercion in serde-wasm-bindgen vs wasm:js-string,
 * a stale stub on one side, ...) and is a Phase-1 regression.
 *
 * @remarks
 * Phase-1 status (post-#1086 Sub-C):
 *
 *   - The serde bridge (`tools/engine-rs-bridge-serde`) calls real
 *     `causl_engine_core::transition_phased` (Sub-B, #1062 / PR #1087).
 *     Its wire shape is `{ state, commit, events }` where `commit` is
 *     a `CommitRecord { time, intent, changedNodes }`.
 *
 *   - The GC bridge (`tools/engine-rs-bridge-gc`) wires the real
 *     engine types and the eleven-call `wasm:js-string` extern surface
 *     (Sub-C, #1064 / PR #1086). The internal commit pipeline is
 *     pinned at the `CommitRecord` JSON shape so the cross-bridge gate
 *     fires on byte-identity by construction.
 *
 * The artefact JS shims live under `packages/core/wasm-pkg/{serde,
 * gc-classic,gc-builtins}-nodejs/` after a successful `pnpm wasm:build`
 * (issue #1103 extended the build driver to emit both `--target
 * bundler` and `--target nodejs` artefacts per bridge — the bundler
 * shim is consumed by the `@causljs/core/wasm` loader + bundler-interop
 * fixtures, the nodejs shim is consumed by this suite). The nodejs
 * shim uses `fs.readFileSync` + `WebAssembly.instantiate` so Node's
 * ESM loader can `import()` it directly without a bundler step. The
 * suite therefore:
 *
 *   1. Tries to dynamically import both bridge JS shims at probe time.
 *   2. If either import fails (artefact missing, wrong target, host
 *      lacks WasmGC, ...), logs a structured skip message naming both
 *      bridge paths and the failure reason, then exits the property
 *      cleanly. The test is not marked failed because the dependency
 *      shape is documented and tracked in the issue body.
 *   3. If both imports succeed, runs the full property body against
 *      the canonical seed registry imported from #685 plus
 *      generated `Action` arbitraries at the
 *      {@link propertyOptions} floor (1 000 trials).
 *
 * The contract this suite locks in does not change between today and
 * the day the bridges become Node-loadable: same canonical seeds, same
 * `Action` arbitrary shapes, same byte-equal Commit oracle.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1071} — this gate.
 * @see {@link https://github.com/iasbuilt/causl/issues/685} — cross-backend (sibling) gate.
 * @see {@link https://github.com/iasbuilt/causl/issues/680} — WASM EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/1086} — GC bridge Sub-C (precondition for this gate).
 * @see {@link https://github.com/iasbuilt/causl/issues/1062} — serde bridge Sub-B (precondition for this gate).
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

import {
  propertyOptions,
  resolveCrossBackendFuzzTier,
  type CrossBackendFuzzTierConfig,
} from './seed.js'
import { CANONICAL_SEEDS } from './replay-determinism.test.js'

// ---------------------------------------------------------------------------
// Bridge probe — dynamic import of both wasm-pack-emitted JS shims.
//
// The two bridges this suite pins:
//   - `causl-engine-bridge-serde` → `packages/core/wasm-pkg/serde-nodejs/
//      causl_engine_bridge_serde.js`
//   - `causl-engine-bridge-gc`    → `packages/core/wasm-pkg/gc-classic-nodejs/
//      causl_engine_bridge_gc.js`
//
// Per #1103 the build driver emits both `--target bundler` and
// `--target nodejs` artefacts per bridge; the `*-nodejs/` shims are
// what Node's ESM loader can `import()` directly (the `*-bundler/`
// shims need a host bundler to rewrite their `new URL(..., import.meta.url)`
// asset references). This suite imports the nodejs variant so the
// 1000-trial gate fires under vitest without a bundler step.
//
// `gc-classic` is the host-portable GC artefact (the `gc-builtins`
// variant requires `wasm:js-string` import bindings — Chrome 131+ /
// Firefox 130+ / Node 22.6+ — and would skip the suite on any
// older Node). `gc-classic` works wherever WasmGC works. The suite
// can be retargeted at the `gc-builtins-nodejs` artefact by flipping
// the `GC_BRIDGE_PATH` segment below; the test contract is unchanged.
//
// Imports happen exactly once per test run (memoised below) so the
// skip banner prints once and the wasm-pack module init cost
// (`init()` is implicit on first call for the nodejs target) is
// paid once.
// ---------------------------------------------------------------------------

/** Absolute filesystem path segment of the serde bridge JS shim
 * (`--target nodejs` variant — host-loadable from Node's ESM loader). */
const SERDE_BRIDGE_PATH = '../../wasm-pkg/serde-nodejs/causl_engine_bridge_serde.js'
/**
 * Absolute filesystem path segment of the GC bridge JS shim
 * (classic-strings variant, `--target nodejs` — host-portable everywhere
 * WasmGC is supported and host-loadable from Node's ESM loader). The
 * builtins variant requires `wasm:js-string` import bindings and is
 * not selected as the default skip-probe target.
 */
const GC_BRIDGE_PATH = '../../wasm-pkg/gc-classic-nodejs/causl_engine_bridge_gc.js'

/**
 * `BridgeModule` — the wasm-pack-emitted shim shape both bridges
 * export. `commit(state, action)` is the SPEC §16.4.1 entry point;
 * `bridge_id()` is the diagnostic that confirms the artefact loaded
 * the expected feature row.
 */
interface BridgeModule {
  /** Same call shape as the serde / gc bridge `#[wasm_bindgen] fn commit`. */
  readonly commit: (state: unknown, action: unknown) => unknown
  /** Diagnostic identifier — `"serde-json"` | `"wasmgc-builtins"` | `"wasmgc-classic"`. */
  readonly bridge_id: () => string
}

/**
 * Result of probing for both bridge JS shims. The suite runs the full
 * property body only when both bridges loaded; any failure on either
 * side flips the suite into skip-mode with a structured banner.
 */
type BridgeProbe =
  | {
      readonly kind: 'ready'
      readonly serde: BridgeModule
      readonly gc: BridgeModule
    }
  | {
      readonly kind: 'unavailable'
      readonly reason: string
    }

/**
 * Memoised bridge-import probe. The `loadWasmBackend()` precedent
 * (`cross-backend-determinism.property.test.ts`) shows why this is the
 * right shape: a once-per-run cache means the skip banner prints
 * exactly once across all `it()` blocks, and the bridge module init
 * cost is amortised across every property trial. We share the probe
 * promise rather than the resolved value so concurrent vitest workers
 * within the same module land on a single import attempt.
 */
let bridgeProbe: Promise<BridgeProbe> | null = null

function probeBridges(): Promise<BridgeProbe> {
  if (bridgeProbe) return bridgeProbe
  bridgeProbe = (async () => {
    // Each bridge import is independent; settle them in parallel so a
    // single slow load doesn't serialise the probe. Failure on either
    // side aborts the suite into skip-mode — both bridges must load
    // for the byte-identity contract to be meaningful.
    const [serdeResult, gcResult] = await Promise.allSettled([
      // Vite-style `/* @vite-ignore */` annotations would let us bypass
      // bundler resolution here, but Vitest runs under Node's ESM
      // loader and resolves these at runtime against the wasm-pkg
      // tree on disk. A missing or wrong-target artefact surfaces as
      // an `ERR_MODULE_NOT_FOUND` (or a bundler-target init error if
      // the shim runs against Node's loader) which we catch below.
      import(SERDE_BRIDGE_PATH) as Promise<BridgeModule>,
      import(GC_BRIDGE_PATH) as Promise<BridgeModule>,
    ])
    if (serdeResult.status === 'rejected') {
      return {
        kind: 'unavailable' as const,
        reason:
          `serde bridge import failed (${SERDE_BRIDGE_PATH}): ` +
          `${(serdeResult.reason as Error)?.message ?? String(serdeResult.reason)}`,
      }
    }
    if (gcResult.status === 'rejected') {
      return {
        kind: 'unavailable' as const,
        reason:
          `gc bridge import failed (${GC_BRIDGE_PATH}): ` +
          `${(gcResult.reason as Error)?.message ?? String(gcResult.reason)}`,
      }
    }
    // Structural sanity — both shims must expose the SPEC §16.4.1
    // `commit(state, action)` boundary entry point. If wasm-pack ever
    // renames the export, a structured skip is better than a cryptic
    // `TypeError: serde.commit is not a function` deep in a property
    // trial.
    const serde = serdeResult.value
    const gc = gcResult.value
    if (typeof serde.commit !== 'function' || typeof gc.commit !== 'function') {
      return {
        kind: 'unavailable' as const,
        reason:
          `bridge shim missing commit() export: ` +
          `serde.commit=${typeof serde.commit}, gc.commit=${typeof gc.commit}`,
      }
    }
    return { kind: 'ready' as const, serde, gc }
  })()
  return bridgeProbe
}

/**
 * Print the skip banner exactly once per test run. CI greps this line
 * to confirm the gate is dormant for the documented reason (bridge
 * artefacts not loadable in Node yet) rather than silently disabled.
 */
let skipLogged = false
function logBridgeSkip(reason: string): void {
  if (skipLogged) return
  skipLogged = true

  console.log(
    `[bridge-roundtrip] both bridges required — suite is dormant. ` +
      `reason='${reason}'. ` +
      `Expected paths: ` +
      `serde='${SERDE_BRIDGE_PATH}', gc='${GC_BRIDGE_PATH}'. ` +
      `Gate auto-activates the moment a Node-target wasm-pack build ships. ` +
      `See https://github.com/iasbuilt/causl/issues/1071 and ` +
      `https://github.com/iasbuilt/causl/issues/680.`,
  )
}

// ---------------------------------------------------------------------------
// `Action` arbitraries. The Rust-side `Action` enum is internally
// tagged via `#[serde(tag = "action", rename_all = "kebab-case")]`
// (see `tools/engine-rs-core/src/action.rs`); the wire shape we
// produce here must match that convention exactly so both bridges
// deserialise the same Rust value before passing it to the engine.
//
// We synthesise the four payload variants the bridges round-trip
// today without contention: `tick`, `commit`, `dispose`, and a
// minimal-payload `subscribe`. The remaining four variants
// (`unsubscribe`, `resolve-pending`, `dispatch-msg`, `begin-fetch`)
// land in a follow-up alongside the `arbAdversarialValue` work named
// in #685 — those carry payloads (`resource` ids, free-form
// `serde_json::Value` Msg payloads) that this property gate doesn't
// need to fire its first byte-identity assertion.
// ---------------------------------------------------------------------------

/**
 * The id pool the property draws from. Pinned to a small,
 * deterministic alphabet so a divergence between bridges names a
 * concrete id rather than a UUID — the failure trace is then
 * immediately bisectable against the engine source.
 *
 * Per issue #1080 / PRs #1114 + #1115 the Rust-side `NodeId` is now
 * `NodeId(u32)` — a dense-slot newtype around an integer — so the
 * bridges' serde decoder rejects string ids on the wire with
 * "invalid type: string ..., expected u32". This suite emits numeric
 * ids `0..8` to match. The `replay-determinism.test.ts` cross-backend
 * gate (which runs against the JS-side Graph API, not the bridges)
 * still uses string ids; the two suites are deliberately decoupled
 * here because the wire-shape contract is the bridges' concern.
 */
const NODE_IDS = [0, 1, 2, 3, 4, 5, 6, 7] as const

/** Arbitrary for the `now` field of `State` — bounded so byte-identical
 * `time` arithmetic stays inside JS's safe-integer range and serde's
 * canonical-JSON contract emits the same digits on both sides. */
const arbStateNow = fc.integer({ min: 0, max: 2 ** 30 })

/** State envelope arbitrary — only `now` is sent. The Rust-side `State`
 * carries container-level `#[serde(default)]`, so the bridges fill in
 * the other ten fields with empty defaults on both sides identically. */
const arbState = arbStateNow.map((now) => ({ now }))

/** `Action::Tick` — the cheapest variant. No payload. */
const arbActionTick = fc.constant({ action: 'tick' })

/** `Action::Commit { intent, writes }`. Writes drawn from `NODE_IDS`. */
const arbActionCommit = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 16 }),
    fc.uniqueArray(fc.constantFrom(...NODE_IDS), { minLength: 0, maxLength: 6 }),
  )
  .map(([intent, writes]) => ({ action: 'commit', intent, writes }))

/** `Action::Dispose { node }` — single-node disposal. */
const arbActionDispose = fc
  .constantFrom(...NODE_IDS)
  .map((node) => ({ action: 'dispose', node }))

/** `Action::Subscribe { node, observer_id }` — minimal-payload subscribe.
 *
 * The Rust-side `ObserverId` is a newtype over `String`; we emit a
 * short deterministic id ("obs-<n>") so a divergence between bridges
 * carries an immediately-readable identifier in the failure trace
 * rather than a fast-check UUID. */
const arbActionSubscribe = fc
  .tuple(fc.constantFrom(...NODE_IDS), fc.integer({ min: 0, max: 99 }))
  .map(([node, n]) => ({
    action: 'subscribe',
    node,
    observer_id: `obs-${n}`,
  }))

/**
 * Top-level `Action` arbitrary — covers the four variants the
 * cross-bridge gate exercises today. The weight distribution favours
 * `commit` because that is the variant whose engine path actually
 * writes to `commit_log` (the others walk `transition_phased` for a
 * `time + 1` increment + an empty `changedNodes` summary). Skewing
 * trials toward `commit` puts the byte-identity contract under more
 * pressure on the serialisation surface that matters most.
 */
const arbAction = fc.oneof(
  { weight: 4, arbitrary: arbActionCommit },
  { weight: 2, arbitrary: arbActionTick },
  { weight: 1, arbitrary: arbActionDispose },
  { weight: 1, arbitrary: arbActionSubscribe },
)

// ---------------------------------------------------------------------------
// Bridge invocation + byte-equal oracle.
//
// Each bridge's `commit(state, action)` returns a JS object that
// flattens the SPEC §16.4.1 `(State, Commit, Events)` triple (serde)
// or a bare `Commit` (gc — see Sub-C's host-target preview test in
// `tools/engine-rs-bridge-gc/src/lib.rs:264-288`). The contract this
// gate pins is byte-identity of the canonical `Commit` JSON — we
// project both bridge outputs onto that shape and compare via
// `JSON.stringify` against a key-stable order.
// ---------------------------------------------------------------------------

/**
 * Project a bridge's `commit()` return value onto its canonical
 * `Commit` JSON form. The serde bridge wraps the commit in a
 * `{ state, commit, events }` envelope; the gc bridge returns the
 * commit directly. We unwrap the envelope on the serde side and
 * canonicalise the key order on both sides so the byte-equal oracle
 * compares like for like.
 *
 * The canonical order is alphabetical (`changedNodes`, `intent`,
 * `time`) — `JSON.stringify` of an object literal preserves
 * insertion order, so we rebuild the object key-by-key. A bridge
 * that emits `{ "time": ..., "intent": ..., "changedNodes": ... }`
 * vs `{ "changedNodes": ..., "intent": ..., "time": ... }` would
 * otherwise diverge on the byte channel for no semantic reason.
 */
function canonicaliseCommit(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new Error(
      `bridge commit() returned non-object: ${typeof raw} (${String(raw)})`,
    )
  }
  // Unwrap the serde bridge's `{ state, commit, events }` envelope if
  // present; the gc bridge returns the bare commit. The shape check is
  // structural — adopters who add a `commit` field to a future variant
  // of the gc bridge result envelope inherit the unwrap automatically.
  const obj = raw as Record<string, unknown>
  const commit =
    'commit' in obj && obj.commit !== null && typeof obj.commit === 'object'
      ? (obj.commit as Record<string, unknown>)
      : obj
  // Canonical key order — alphabetical, all three fields explicit. The
  // `intent` field is absent on the gc bridge's bare Commit; the
  // explicit `?? null` keeps the byte channel comparable across the
  // two bridges. A divergence on any of `changedNodes`, `intent`, or
  // `time` is a real Phase-1 regression and surfaces here.
  const canonical = {
    changedNodes: commit['changedNodes'] ?? commit['changed_nodes'] ?? null,
    intent: commit['intent'] ?? null,
    time: commit['time'] ?? null,
  }
  return JSON.stringify(canonical)
}

/**
 * The byte-equal oracle — drive a single `(State, Action)` through
 * both bridges and assert the canonicalised `Commit` JSON matches
 * byte-for-byte. The `label` field is threaded into the assertion
 * message so a failure points at the offending trial / seed / cmd.
 */
function expectByteEqualCommitAcrossBridges(
  serde: BridgeModule,
  gc: BridgeModule,
  state: unknown,
  action: unknown,
  label: string,
): void {
  // Each bridge owns its own marshalling. We call them with the
  // SAME `state` / `action` literals so any divergence at the wire
  // level is the bridges' fault, not the test's.
  let serdeOut: unknown
  let gcOut: unknown
  try {
    serdeOut = serde.commit(state, action)
  } catch (err) {
    throw new Error(
      `serde bridge threw on (${label}): ${(err as Error)?.message ?? String(err)}`,
    )
  }
  try {
    gcOut = gc.commit(state, action)
  } catch (err) {
    throw new Error(
      `gc bridge threw on (${label}): ${(err as Error)?.message ?? String(err)}`,
    )
  }
  const serdeJson = canonicaliseCommit(serdeOut)
  const gcJson = canonicaliseCommit(gcOut)
  expect(gcJson, `bridge Commit divergence (${label})`).toBe(serdeJson)
}

// ---------------------------------------------------------------------------
// Canonical-seed registry → `Action`-sequence projection.
//
// The replay-determinism `CANONICAL_SEEDS` registry (#685) is the
// shared catalogue both cross-backend determinism (#685) and
// cross-bridge byte-identity (#1071) gates reuse. The seeds are
// declared as `fc.Command<World, World>` tuples that drive the
// JS-side `Graph` API; the cross-bridge gate doesn't have a `Graph`
// surface (the bridges operate at the `(State, Action)` boundary), so
// we project each seed's command alphabet onto an `Action` sequence
// that the bridges can consume. The mapping is:
//
//   - `AddInputCommand`        → no-op (input registration is a JS-side
//                                concern; the bridges operate on the
//                                already-built state envelope).
//   - `AddDerivedSumCommand`   → no-op (same).
//   - `CommitSetCommand`       → `Action::Commit { intent: 'seed-<id>',
//                                writes: ['<id>'] }`.
//   - `AttemptCycleCommand`    → no-op (cycle detection is engine-
//                                internal and the cross-bridge contract
//                                is "same Action → same Commit"; cycle
//                                attempts don't produce a different
//                                wire `Action` on the boundary).
//
// The projection deliberately collapses to the smallest set of
// `Action`s that exercises the bridges' commit pipeline. The full
// command alphabet is preserved for the cross-backend gate (#685)
// where the engines participate end-to-end.
// ---------------------------------------------------------------------------

/**
 * Project a canonical seed (id ∈ `CANONICAL_SEEDS`) onto a sequence of
 * `Action` values the bridges can consume. Returns at least one
 * `Action::Tick` so seeds that contain only no-op commands still
 * exercise the boundary on a non-empty trace.
 */
function projectSeedToActions(seedId: string): ReadonlyArray<unknown> {
  // Pre-baked projections per known seed id. The seeds are content-
  // addressable by `id` — a future PR that renames a seed will fail
  // this projection lookup, surfacing the rename as an explicit test
  // failure rather than silently dropping a row.
  // Per #1080 / PRs #1114 + #1115 the Rust-side `NodeId` is `u32`; the
  // string seed labels in the registry (`'a'`, `'b'`, `'e'`, ...)
  // project to dense slot indices (a=0, b=1, e=4) so the bridges'
  // serde decoder accepts the wire payload. The mapping below is a
  // 1:1 alphabetic-to-slot translation — keep in sync with the
  // `NODE_IDS = [0..8]` pool above.
  switch (seedId) {
    case 'register-time-cycle-with-flanking-writes':
      return [
        { action: 'commit', intent: 'seed-a', writes: [0] },
        { action: 'commit', intent: 'seed-b', writes: [1] },
      ]
    case 'spec-10-worked-example-arithmetic':
      return [
        { action: 'commit', intent: 'seed-a-3', writes: [0] },
        { action: 'commit', intent: 'seed-b-10', writes: [1] },
        { action: 'commit', intent: 'seed-a-300', writes: [0] },
      ]
    case 'write-only-tight-loop':
      return [
        { action: 'commit', intent: 'tight-1', writes: [0] },
        { action: 'commit', intent: 'tight-2', writes: [0] },
        { action: 'commit', intent: 'tight-3', writes: [0] },
        { action: 'commit', intent: 'tight-0', writes: [0] },
      ]
    case 'derived-fanout':
      return [
        { action: 'commit', intent: 'fanout-a-1', writes: [0] },
        { action: 'commit', intent: 'fanout-a-2', writes: [0] },
        { action: 'commit', intent: 'fanout-e-99', writes: [4] },
      ]
    case 'cycle-flanked-by-derivation-additions':
      return [{ action: 'commit', intent: 'cycle-a-100', writes: [0] }]
    default:
      // Unknown seed id — emit a `Tick` so the property still produces
      // a comparable trace, but log so a typo / rename surfaces
      // immediately in the test output.

      console.warn(
        `[bridge-roundtrip] no Action projection for canonical seed '${seedId}'; ` +
          `falling back to a single Action::Tick. ` +
          `Add a switch arm in projectSeedToActions() to fix.`,
      )
      return [{ action: 'tick' }]
  }
}

/**
 * Build the `State.inputs` Vec prefix needed for an `Action` sequence
 * to satisfy the post-A.2 (#1133) node-resolution gate. Walks every
 * `Action::Commit { writes }` and `Action::Dispose { node }` /
 * `Action::Subscribe { node }` in the sequence, computes the highest
 * slot index referenced, and emits a dense `InputCell` prefix from
 * slot 0 through that ceiling.
 *
 * The cells are minimal: `id = slot`, `value = null` (JsonValue::Null),
 * `last_write_time = 0`. The `generation` / `last_staged_*` /
 * `has_dependents` fields are `#[serde(skip)]` on the Rust side and
 * default to `0`/`false` — the same generation a wire `NodeId(slot)`
 * carries (`NodeId::from_index` ⇒ `gen: 0`) — so the validator's
 * `cell.generation == id.gen` check passes by construction.
 *
 * Returns `[]` when no slot is referenced — keeps the wire envelope
 * minimal for `tick`-only sequences.
 */
function buildInputsForActions(
  actions: ReadonlyArray<unknown>,
): ReadonlyArray<{ id: number; value: null; last_write_time: number }> {
  let maxSlot = -1
  for (const action of actions) {
    const a = action as Record<string, unknown>
    if (a.action === 'commit' && Array.isArray(a.writes)) {
      for (const w of a.writes as ReadonlyArray<number>) {
        if (typeof w === 'number' && w > maxSlot) maxSlot = w
      }
    } else if (
      (a.action === 'dispose' || a.action === 'subscribe' || a.action === 'unsubscribe') &&
      typeof a.node === 'number'
    ) {
      if (a.node > maxSlot) maxSlot = a.node
    }
  }
  if (maxSlot < 0) return []
  const cells: Array<{ id: number; value: null; last_write_time: number }> = []
  for (let slot = 0; slot <= maxSlot; slot++) {
    cells.push({ id: slot, value: null, last_write_time: 0 })
  }
  return cells
}

// ---------------------------------------------------------------------------
// Property suite.
// ---------------------------------------------------------------------------

describe('cross-bridge Commit byte-identity (#1071)', () => {
  // ---------------------------------------------------------------
  // Capability probe — surfaces the bridge-load state explicitly. A
  // green "both bridges loaded" line means the rest of the suite is
  // hot; a green "bridges unavailable (reason ...)" line means the
  // suite is dormant for the documented reason.
  // ---------------------------------------------------------------
  describe('bridge capability probe', () => {
    it('serde + gc bridges either both load or the suite skips with a structured reason', async () => {
      const probe = await probeBridges()
      if (probe.kind === 'ready') {
        expect(probe.serde).toBeDefined()
        expect(probe.gc).toBeDefined()
        expect(typeof probe.serde.commit).toBe('function')
        expect(typeof probe.gc.commit).toBe('function')
        // The bridge id surface is part of the wasm-pack export
        // contract — confirm both bridges expose the expected
        // diagnostic identifier. A missing `bridge_id()` would not
        // affect the byte-identity contract but does indicate a
        // wasm-pack target / feature drift worth surfacing.
        if (typeof probe.serde.bridge_id === 'function') {
          expect(probe.serde.bridge_id()).toMatch(/serde/)
        }
        if (typeof probe.gc.bridge_id === 'function') {
          expect(probe.gc.bridge_id()).toMatch(/^wasmgc-/)
        }
        return
      }
      // Skip-shape: a non-empty `reason` is the contract the loader
      // promised. The exact substring it carries depends on the host
      // (`ERR_MODULE_NOT_FOUND`, `Cannot find module`, ...) — we just
      // assert the reason is non-empty and matches one of the known
      // failure idioms.
      expect(probe.reason.length).toBeGreaterThan(0)
      expect(probe.reason).toMatch(
        /import failed|missing|ENOENT|ERR_MODULE|not found|Cannot find/i,
      )
      logBridgeSkip(probe.reason)
    })
  })

  // ---------------------------------------------------------------
  // Canonical-seed byte-identity. Replays each canonical seed's
  // `Action` projection against both bridges and asserts byte-
  // identical Commit JSON after every action.
  // ---------------------------------------------------------------
  describe('canonical-seed cross-bridge byte-identity (reused from #685)', () => {
    for (const seed of CANONICAL_SEEDS) {
      it(`byte-equal Commit across serde+gc bridges for seed '${seed.id}'`, async () => {
        const probe = await probeBridges()
        if (probe.kind === 'unavailable') {
          logBridgeSkip(probe.reason)
          return
        }
        const actions = projectSeedToActions(seed.id)
        // Pre-Phase-C (#1133 A.2) introduced the generational-NodeId
        // node-resolution gate: `Action::Commit { writes }` now requires
        // every write target to resolve to a *live* `InputCell` on the
        // state side. A bare `{now: 0}` envelope has an empty `inputs`
        // Vec, so writes against slot 0 surface as
        // `RaceClass::UnknownNode { slot: 0 }` rather than reaching the
        // commit pipeline. This pre-provisions the smallest `inputs`
        // prefix the seed's writes touch so the byte-identity contract
        // exercises the real commit path on both bridges.
        //
        // The `generation` field is `#[serde(skip)]` and re-defaults to
        // `0` on the Rust side — the same generation a bare wire
        // `NodeId(slot)` carries (`NodeId::from_index` ⇒ `gen: 0`) — so
        // a freshly-decoded `InputCell { id: slot, value: null,
        // last_write_time: 0 }` matches the write target by construction.
        const inputs = buildInputsForActions(actions)
        // Each action runs against a fresh envelope so the seed's
        // trace is hermetic. The `time` field of the result advances
        // per action; we don't thread the post-state back through
        // because the bridges' canonical-commit contract is per-
        // action, not per-trace. A future suite that pins post-state
        // byte-identity (when both bridges return a post-state in
        // identical form) layers on top of this one without changing
        // the per-action assertion.
        let nowSnapshot = 0
        for (const action of actions) {
          expectByteEqualCommitAcrossBridges(
            probe.serde,
            probe.gc,
            { now: nowSnapshot, inputs },
            action,
            `seed '${seed.id}' action ${JSON.stringify(action)}`,
          )
          // Advance the synthetic clock so successive actions don't
          // hit identical `time` fields — the byte-identity contract
          // must hold across distinct timestamps, not just `now=0`.
          nowSnapshot += 1
        }
      })
    }
  })

  // ---------------------------------------------------------------
  // Generated-trace byte-identity. The 1000-trial floor named in the
  // #1071 acceptance criteria. fast-check's shrinking machinery
  // delivers a minimal failing prefix on the first divergence — the
  // load-bearing failure-investigation surface for the cross-bridge
  // gate.
  //
  // Trial budget: selected by `resolveCrossBackendFuzzTier()` (#1073),
  // which reads `CAUSL_FUZZ_TIER` from the environment. The tier table
  // (single source of truth in `seed.ts`) realises the tiered budgets:
  //   - default:    1 000 trials   (always-on floor, #1071 acceptance)
  //   - pr:         5 000 trials   (PR-lane gate)
  //   - nightly:  100 000 trials   (scheduled)
  //   - cargo-fuzz: TS skip — work lives in the Rust fuzz harness
  // Module-level resolution keeps the env-var read off the per-trial
  // hot path; the log line is what CI greps to confirm the tier was
  // honoured.
  // ---------------------------------------------------------------
  const fuzzTier: CrossBackendFuzzTierConfig = resolveCrossBackendFuzzTier()

  console.log(
    `[bridge-roundtrip] fuzz tier='${fuzzTier.tier}' numRuns=${fuzzTier.numRuns} skip=${fuzzTier.skip}`,
  )

  describe('generated Action × State byte-identity', () => {
    it('byte-equal Commit across serde+gc bridges for every (State, Action) trial', async () => {
      // Cargo-fuzz tier is a structured skip — the corpus-driven
      // exercise belongs to the Rust fuzz harness (`tools/engine-rs-
      // fuzz/`), not the TS property suite. Logging the skip line is
      // the contract: CI greps it to confirm the tier was honoured.
      if (fuzzTier.skip) {

        console.log(
          `[bridge-roundtrip] tier='${fuzzTier.tier}' — TS property skipped; ` +
            `cargo-fuzz workflow drives the corpus-based gate.`,
        )
        return
      }
      const probe = await probeBridges()
      if (probe.kind === 'unavailable') {
        logBridgeSkip(probe.reason)
        return
      }
      const { serde, gc } = probe
      fc.assert(
        fc.property(arbState, arbAction, (state, action) => {
          expectByteEqualCommitAcrossBridges(
            serde,
            gc,
            state,
            action,
            `state=${JSON.stringify(state)} action=${JSON.stringify(action)}`,
          )
        }),
        propertyOptions({ numRuns: fuzzTier.numRuns }),
      )
    }, /* test timeout accommodates the 100k nightly budget */ 600_000)

    it('byte-equal Commit across serde+gc bridges for every Action-sequence trial', async () => {
      // Sequence-shaped variant — runs N actions in a row against
      // both bridges so a divergence that only surfaces after a
      // specific prefix (e.g. a `commit` after a `dispose`) cannot
      // hide behind the single-action arbitrary above. The sequence
      // length is bounded by the tier's `maxCommands` ceiling so the
      // PR-lane and nightly tiers exercise a deeper trace than the
      // 1000-trial default; the overall trial budget is still
      // `fuzzTier.numRuns`.
      if (fuzzTier.skip) {

        console.log(
          `[bridge-roundtrip] tier='${fuzzTier.tier}' — TS property skipped; ` +
            `cargo-fuzz workflow drives the corpus-based gate.`,
        )
        return
      }
      const probe = await probeBridges()
      if (probe.kind === 'unavailable') {
        logBridgeSkip(probe.reason)
        return
      }
      const { serde, gc } = probe
      // Cap the per-trial sequence length at the tier's maxCommands
      // ceiling (or 16 at the default tier — deep enough to surface a
      // prefix-dependent divergence, shallow enough to keep individual
      // trials snappy at 1000-trial budget). The PR-lane and nightly
      // tiers inherit their respective ceilings (500 / 2000).
      const maxLen = fuzzTier.maxCommands ?? 16
      fc.assert(
        fc.property(
          fc.tuple(arbState, fc.array(arbAction, { minLength: 1, maxLength: maxLen })),
          ([initialState, actions]) => {
            let now = initialState.now
            for (let i = 0; i < actions.length; i++) {
              const action = actions[i]
              expectByteEqualCommitAcrossBridges(
                serde,
                gc,
                { now },
                action,
                `step ${i} action=${JSON.stringify(action)}`,
              )
              // The synthetic clock advances per action so the
              // sequence exercises a range of `time` values, not just
              // the initial one.
              now += 1
            }
          },
        ),
        propertyOptions({ numRuns: fuzzTier.numRuns }),
      )
    }, /* test timeout accommodates the 100k nightly budget */ 600_000)
  })

  // ---------------------------------------------------------------
  // Harness self-checks — TS-only assertions that the scaffolding
  // above is structurally sound. They run today against the in-
  // package arbitraries and are not gated on bridge availability.
  // ---------------------------------------------------------------
  describe('harness self-checks (run today)', () => {
    it('canonical seeds project to non-empty Action sequences', () => {
      for (const seed of CANONICAL_SEEDS) {
        const actions = projectSeedToActions(seed.id)
        expect(actions.length).toBeGreaterThan(0)
        for (const a of actions) {
          // Every projected action carries the internally-tagged
          // `action` discriminator that the Rust-side
          // `#[serde(tag = "action")]` deserialiser expects.
          expect(typeof (a as { action: string }).action).toBe('string')
        }
      }
    })

    it('canonicaliseCommit() is byte-stable on equivalent shapes', () => {
      // Two object literals carrying the same logical commit in
      // different field orders MUST canonicalise to the same string.
      // A regression here would mean the oracle itself is non-
      // deterministic and any property failure would be unreliable.
      const a = { time: 42, intent: 'x', changedNodes: ['a', 'b'] }
      const b = { changedNodes: ['a', 'b'], intent: 'x', time: 42 }
      expect(canonicaliseCommit(a)).toBe(canonicaliseCommit(b))
    })

    it('canonicaliseCommit() unwraps the serde-bridge envelope shape', () => {
      // The serde bridge returns `{ state, commit, events }`; the gc
      // bridge returns a bare commit. The oracle must unwrap the
      // envelope before comparing — proven here by feeding both
      // shapes and asserting they canonicalise to the same string.
      const envelope = {
        state: { now: 42 },
        commit: { time: 42, intent: 'x', changedNodes: ['a'] },
        events: [],
      }
      const bare = { time: 42, intent: 'x', changedNodes: ['a'] }
      expect(canonicaliseCommit(envelope)).toBe(canonicaliseCommit(bare))
    })

    it('canonicaliseCommit() accepts changed_nodes snake_case alias', () => {
      // The Rust-side `Commit` struct renames `changed_nodes` →
      // `changedNodes` for the wire serde, but the alias path is a
      // belt-and-braces affordance against a future bridge that
      // forgets to apply `#[serde(rename = "changedNodes")]`. The
      // canonicaliser accepts either spelling and emits the camelCase
      // form so the byte channel stays canonical.
      const snake = { time: 1, intent: 'x', changed_nodes: ['a'] }
      const camel = { time: 1, intent: 'x', changedNodes: ['a'] }
      expect(canonicaliseCommit(snake)).toBe(canonicaliseCommit(camel))
    })

    it('probeBridges() is memoised — repeated calls return the same probe object', async () => {
      const a = await probeBridges()
      const b = await probeBridges()
      // Reference identity — the cache must return the exact same
      // resolved value, not just a structurally equal one. Matches
      // the `probeWasm()` self-check in
      // `cross-backend-determinism.property.test.ts`.
      expect(a).toBe(b)
    })

    it('arbAction emits valid action discriminators', () => {
      // Run the arbitrary against the propertyOptions floor and
      // assert every sampled value carries one of the four expected
      // action tags. A regression here would mean the test is
      // exercising a tag the bridges don't recognise.
      fc.assert(
        fc.property(arbAction, (a) => {
          const tag = (a as { action: string }).action
          expect(['tick', 'commit', 'dispose', 'subscribe']).toContain(tag)
        }),
        propertyOptions(),
      )
    })

    it('CANONICAL_SEEDS reuse — every seed in the #685 registry has an Action projection', () => {
      // Acceptance row of #1071: the cross-bridge gate reuses the
      // canonical seed registry from #685 verbatim. A seed added to
      // the registry without an Action projection here would hit the
      // default-warn arm of `projectSeedToActions()` and silently
      // run as a Tick — the explicit check below surfaces that
      // omission as a test failure.
      for (const seed of CANONICAL_SEEDS) {
        const actions = projectSeedToActions(seed.id)
        // The fallback arm emits a single Tick; treat that as a
        // sentinel and require every named seed to have an explicit
        // projection (the seeds today all produce >= 1 commit action).
        const isFallbackTick =
          actions.length === 1 &&
          (actions[0] as { action: string }).action === 'tick'
        expect(
          isFallbackTick,
          `canonical seed '${seed.id}' has no explicit Action projection — ` +
            `add a switch arm in projectSeedToActions()`,
        ).toBe(false)
      }
    })
  })
})
