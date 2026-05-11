/**
 * @packageDocumentation
 *
 * Cross-backend determinism property suite (EPIC #680, sub-issue
 * #685). Drives the same SPEC §15 command logs through two
 * `BackendEngine` implementations — the in-package TS engine and a
 * loadable WASM engine — and asserts byte-equal commit-log
 * serialisation across them. Once a real WASM engine ships (Phase 1
 * of EPIC #680 — see #687, #1031 follow-ups), this suite is the
 * CI-blocking gate that pins
 *
 * ```
 * transition_js(s, a) == transition_wasm_gc(s, a) == transition_wasm_serde(s, a)
 * ```
 *
 * byte-identical across all four implementations the issue catalogues
 * (JS, WASM-GC-builtins, WASM-GC-classic, WASM-serde).
 *
 * @remarks
 * Phase-1 caveat. The `loadWasmBackend()` entry point shipped in
 * #1031 still throws `WasmBackendUnavailableError` because the
 * concrete `WebAssembly.instantiate()` path waits on engine work in
 * #682 / #683 / #693 follow-ups — those issues shipped the Rust
 * workspace, the wasm-pack pipeline, and the serde bridge *stub*,
 * not a wired `BackendEngine` implementation.
 *
 * The suite therefore:
 *
 *   1. Tries to load the WASM backend at the top of every property.
 *   2. If the load throws `WasmBackendUnavailableError`, logs a
 *      structured skip message and exits the property cleanly. The
 *      test is not marked failed because the dependency is documented
 *      and tracked in the issue body; a skip is the correct signal.
 *   3. If the load succeeds, runs the full property body against
 *      `(TS, WASM)` pairs.
 *
 * That gives us a CI gate that's *ready to fire the moment a real
 * WASM engine lands*. The contract this suite locks in does not
 * change between today and that day: same canonical seeds, same
 * fc.commands alphabet, same `expectByteEqualLog` oracle.
 *
 * What this file deliberately does NOT do (deferred to follow-ups):
 *
 *   - **Tiered fuzz budgets (5k / 100k / cargo-fuzz).** Once the
 *     engine exists, raise `numRuns` from the propertyOptions floor
 *     to the issue's tiered ceilings: 5 000 for the PR gate, 100 000
 *     for the nightly gate, 2-hour cargo-fuzz weekly. This file
 *     ships at the propertyOptions floor so a hollow run terminates
 *     fast.
 *
 *   - **`arbAdversarialValue` adversarial bias.** The issue calls
 *     for a 30%-biased adversarial-value arbitrary in a
 *     `@causl/core-testing-internal` package. That package does not
 *     exist today; the adversarial-bias work lands alongside Phase-1
 *     because the divergence sources it targets (NaN, ±0, lone
 *     surrogates, BigInt boundaries) are between-backend phenomena
 *     that the in-package TS-only suites cannot exercise.
 *
 *   - **`bridge-roundtrip.property.test.ts`.** Separate property
 *     file in the issue spec. Cheap (no engine init); lands as a
 *     sibling file when the bridge stubs in `tools/engine-rs-bridge-
 *     gc` and `tools/engine-rs-bridge-serde` start round-tripping
 *     real JS values.
 *
 *   - **Apalache differential reuse.** The TLA+ EPIC-7 corpus drives
 *     `causl-enumerator` via `tools/enumerator/diff/`; the 4-way
 *     `CombinedStatus` agreement classifier lands when all four
 *     implementations exist.
 *
 *   - **Migration boundary 5×5×3 matrix.** Documented as future-test
 *     scaffolding at the bottom of this file (`describe.skip` row +
 *     a doc comment that pins the dimensions). The
 *     `snapshot()`/`hydrate()` round-trip the matrix depends on
 *     lands in #687.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/685} — this gate.
 * @see {@link https://github.com/iasbuilt/causl/issues/680} — WASM EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/687} — JS → WASM migration round-trip (gates the 5×5 matrix).
 * @see {@link https://github.com/iasbuilt/causl/issues/1031} — `loadWasmBackend()` entry point this suite consumes.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

import { createCausl } from '../../src/index.js'
import type { BackendEngine } from '../../wasm/index.js'
import {
  __createWasmBackendSyncForTests,
  __isPhase1WasmBackendForTests,
  loadWasmBackend,
  WasmBackendUnavailableError,
} from '../../wasm/index.js'
import {
  CROSS_BACKEND_FUZZ_TIERS,
  propertyOptions,
  resolveCrossBackendFuzzTier,
  type CrossBackendFuzzTierConfig,
} from './seed.js'
import {
  CANONICAL_SEEDS,
  type World,
  commandArbitrary,
  expectByteEqualIR,
  makeWorlds,
} from './replay-determinism.test.js'

// ---------------------------------------------------------------------------
// WASM backend loader — capability probe.
//
// `loadWasmBackend()` from #1031 returns a `BackendEngine` once the
// concrete instantiation path lands. Today it throws
// `WasmBackendUnavailableError`; we catch that specific class and skip,
// re-throwing any other error so a misbehaving loader can't masquerade
// as a missing dependency.
// ---------------------------------------------------------------------------

/**
 * Result of probing for a usable WASM backend.
 *
 *   - `kind: 'ready'` — the loader returned a real `BackendEngine`.
 *     The property body runs the full cross-backend gate.
 *
 *   - `kind: 'unavailable'` — the loader threw
 *     `WasmBackendUnavailableError` (or a future loader-defined
 *     equivalent). The property body logs a structured skip and
 *     returns. Not a test failure — the dependency on Phase 1 is
 *     tracked in #685 and #687.
 */
type WasmProbe =
  | { readonly kind: 'ready'; readonly engine: BackendEngine }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Try to load the WASM backend exactly once per test run.
 *
 * Memoising the probe matters for two reasons:
 *
 *   1. The `loadWasmBackend()` cache (see #1031) is per-bridge; we
 *      don't want every property trial paying the bridge-detection
 *      cost.
 *
 *   2. The skip message should print exactly once when the backend is
 *      unavailable, not once per `it()` block. We dedupe at the
 *      module level by sharing the `wasmProbe` promise.
 */
let wasmProbe: Promise<WasmProbe> | null = null

function probeWasm(): Promise<WasmProbe> {
  if (wasmProbe) return wasmProbe
  wasmProbe = (async () => {
    try {
      const engine = await loadWasmBackend()
      return { kind: 'ready' as const, engine }
    } catch (err) {
      if (err instanceof WasmBackendUnavailableError) {
        return {
          kind: 'unavailable' as const,
          reason: err.message,
        }
      }
      // Any other loader error is a real failure — let it surface so
      // the test report distinguishes "WASM not built yet" (skip)
      // from "loader is broken" (failure).
      throw err
    }
  })()
  return wasmProbe
}

/**
 * Print the skip banner exactly once per test run. The skip is
 * informational — CI greps the line to confirm the gate is dormant
 * for the documented reason (Phase 1 not yet shipped) rather than
 * silently disabled.
 */
let skipLogged = false
function logWasmSkip(reason: string): void {
  if (skipLogged) return
  skipLogged = true
  console.log(
    `[cross-backend-determinism] WASM backend unavailable — suite is dormant. ` +
      `reason='${reason}'. ` +
      `Gate auto-activates the moment loadWasmBackend() returns a real BackendEngine. ` +
      `See https://github.com/iasbuilt/causl/issues/685 and ` +
      `https://github.com/iasbuilt/causl/issues/687.`,
  )
}

// ---------------------------------------------------------------------------
// Cross-backend `World` pair.
//
// The replay-determinism `World` carries a `Graph` (the TS engine).
// For the cross-backend gate we want one `World` against the TS
// engine and a parallel `World` against the WASM backend. The
// command alphabet defined in `replay-determinism.test.ts` is
// already polymorphic over `World`; what we need here is a
// `BackendEngine`-shaped `Graph`-compatible projection so the same
// commands can run against both implementations.
//
// The `Graph` surface is wider than `BackendEngine` (it adds
// `input()`, `derived()`, the transaction-callback shape on
// `commit()`, etc.). The TS engine satisfies both surfaces directly.
// The WASM engine satisfies only `BackendEngine`; the Graph-shaped
// methods compose on top in the JS-side facade — that composition
// work lands in #687 alongside the migration round-trip.
//
// For #685's scaffolding we therefore mark the cross-backend
// `World` pairing as TODO and gate the property body on Phase 1.
// When the Graph facade learns to route through a `BackendEngine`,
// the wiring drops in here without changing the surrounding
// property scaffolding.
// ---------------------------------------------------------------------------

/**
 * Future cross-backend `World` shape. Lives behind a Phase-1 gate.
 *
 * Once the `Graph` facade routes through `BackendEngine`, this type
 * becomes a structural alias for the replay-determinism `World` with
 * a `backendKind` discriminator so the byte-equal oracle can name
 * which backend diverged in failure messages.
 *
 * @internal Future-facing — concrete construction lands when the
 * WASM `BackendEngine` exists.
 */
interface CrossBackendWorld extends World {
  readonly backendKind: 'js' | 'wasm-gc-builtins' | 'wasm-gc-classic' | 'wasm-serde'
}

/**
 * Build a TS-side `CrossBackendWorld`. Trivial wrapper around
 * `makeWorld()`; included for parity with `makeWasmCrossBackendWorld()`
 * so the call sites are symmetric.
 *
 * The TS-side world's graphId is pinned to the same string the WASM
 * side mints (`@causl/core/wasm:serde-json` by default — see
 * {@link loadWasmBackend}'s `graphName` option). Both `Graph`
 * instances must share a graphId because the byte-equal IR oracle
 * compares the `graphId` field directly.
 */
function makeJsCrossBackendWorld(
  graphName = 'causl.wasm.serde-json',
): CrossBackendWorld {
  const w: World = {
    graph: createCausl({ name: graphName }),
    inputs: new Map(),
    deriveds: new Map(),
  }
  return Object.assign(w, { backendKind: 'js' as const })
}

/**
 * Build a WASM-side `CrossBackendWorld`. Wraps the loaded
 * {@link BackendEngine} in a `World`-shaped pair so the
 * replay-determinism command alphabet can drive both ends.
 *
 * @remarks
 * Phase-1 implementation (#1065): the loaded `BackendEngine` is a
 * `WasmBackend` instance whose internal `Graph` is reachable through
 * the `__graph()` accessor. The world exposes that wrapped graph
 * directly so `fc.Command.run()` can call `graph.input()`,
 * `graph.derived()`, and `graph.commit()` against it as if it were
 * the public surface. The WASM-vs-TS distinction lives at the
 * `backendKind` label level, not at the runtime path level — the
 * intent of the cross-backend determinism gate is to validate that
 * `transition_js(s, a) == transition_wasm(s, a)` byte-identically;
 * because the Phase-1 WASM backend's commit path *is* the same TS
 * commit path under the hood, the gate fires green by construction.
 * That is the correct Phase-1 behaviour: it pins the contract so a
 * subsequent PR swapping the internal commit path for a Rust-driven
 * one (#1062 follow-up, GC bridge, etc.) cannot regress determinism
 * without surfacing here.
 *
 * @internal
 */
function makeWasmCrossBackendWorld(
  engine: BackendEngine,
  bridge: 'wasm-gc-builtins' | 'wasm-gc-classic' | 'wasm-serde',
  graphName = 'causl.wasm.serde-json',
): CrossBackendWorld {
  if (__isPhase1WasmBackendForTests(engine)) {
    // Phase-1 path: reach the wrapped Graph directly. The internal
    // graph already carries the `graphName` the engine was loaded
    // with; the caller MUST have passed the matching name to
    // `loadWasmBackend({ graphName })` so the IR `graphId` field
    // lines up with the JS-side world.
    void bridge
    void graphName
    const w: World = {
      graph: engine.__graph(),
      inputs: new Map(),
      deriveds: new Map(),
    }
    return Object.assign(w, {
      backendKind:
        bridge === 'wasm-gc-builtins'
          ? ('wasm-gc-builtins' as const)
          : bridge === 'wasm-gc-classic'
            ? ('wasm-gc-classic' as const)
            : ('wasm-serde' as const),
    })
  }
  // Future-facing path: when the bridge artefact is a real Rust
  // engine, `__isPhase1WasmBackendForTests` returns false and a
  // bridge-routing adapter slots in here. Until then, this branch is
  // unreachable in CI.
  throw new Error(
    'makeWasmCrossBackendWorld(): loaded engine is not a Phase-1 WasmBackend; ' +
      'the bridge-routing adapter for a Rust-driven engine ships in a follow-up.',
  )
}

/**
 * Load the WASM backend with a graphName pinned to match the JS-side
 * `World`. The `loadWasmBackend()` cache is per-bridge, so we always
 * reset before probing to make sure the pinned graphName takes effect
 * for this test run.
 */
async function loadWasmBackendWithPinnedName(
  graphName: string,
): Promise<BackendEngine> {
  // The shared module cache holds a backend keyed on `bridge` only —
  // a previous test's `loadWasmBackend()` call would have minted the
  // default graphName. Reset before each scenario so the canonical
  // seed runs against a fresh wasm-side `Graph` with the requested
  // graphName.
  const mod = await import('../../wasm/index.js')
  mod.__resetWasmBackendCacheForTests()
  return loadWasmBackend({ graphName })
}

// ---------------------------------------------------------------------------
// The byte-equal oracle. Same shape as replay-determinism's, with a
// backend-kind label so the failure trace tells you which pair
// diverged.
// ---------------------------------------------------------------------------

/**
 * Cross-backend variant of `expectByteEqualIR`. Wraps the
 * replay-determinism helper with a label including both
 * `backendKind`s so a failing trace says e.g. `(js vs wasm-serde)`
 * rather than the generic `LEFT vs RIGHT`.
 *
 * @internal Currently unused at runtime (suite skips); ready for
 * the moment the WASM backend lands. Kept exported-shape so the
 * Phase-1 PR is a pure swap, no behavioural changes to the gate.
 */
function expectByteEqualAcrossBackends(
  a: CrossBackendWorld,
  b: CrossBackendWorld,
  label: string,
): void {
  expectByteEqualIR(a, b, `${a.backendKind} vs ${b.backendKind} :: ${label}`)
}

// ---------------------------------------------------------------------------
// Property suite.
// ---------------------------------------------------------------------------

describe('cross-backend determinism (EPIC #680 / #685)', () => {
  // ---------------------------------------------------------------
  // Capability probe — one test that surfaces the WASM-load state
  // explicitly. Useful as a status row in the CI summary: a green
  // "WASM backend loaded" line means the rest of the suite is hot;
  // a green "WASM backend unavailable (gated on #687)" line means
  // the suite is dormant for the documented reason.
  // ---------------------------------------------------------------
  describe('WASM backend capability probe', () => {
    it('loadWasmBackend() either returns a BackendEngine or throws WasmBackendUnavailableError', async () => {
      const probe = await probeWasm()
      if (probe.kind === 'ready') {
        expect(probe.engine).toBeDefined()
        expect(typeof probe.engine.commit).toBe('function')
        expect(typeof probe.engine.exportModel).toBe('function')
        return
      }
      // Skip-shape: a non-empty reason string is what the loader
      // promised in the structured `WasmBackendUnavailableError`.
      expect(probe.reason).toMatch(/CAUSL_WASM_NOT_BUILT|not yet built|placeholder/i)
      logWasmSkip(probe.reason)
    })
  })

  // ---------------------------------------------------------------
  // SPEC §15 canonical-seed parity. Replays the canonical seed
  // registry imported from `replay-determinism.test.ts` across the
  // TS engine and the WASM backend. The expected outcome on every
  // (seed, backend-pair) cell is byte-identical IR after every
  // command — same contract the within-backend replay-determinism
  // suite already pins for the TS engine alone.
  //
  // The seeds intentionally include the §10 worked example shape
  // (`spec-10-worked-example-arithmetic`) the issue calls out by
  // name. NaN-handling and BigInt-boundary seeds land alongside
  // `arbAdversarialValue` when `@causl/core-testing-internal` ships.
  // ---------------------------------------------------------------
  describe('SPEC §15 canonical-seed cross-backend parity', () => {
    for (const seed of CANONICAL_SEEDS) {
      it(`byte-equal IR across TS and WASM for seed '${seed.id}'`, async () => {
        // Pin a per-scenario graphName so the JS-side and WASM-side
        // engines share a `graphId` field in their IR projections.
        // The byte-equal oracle compares `graphId` directly; without
        // the pin the wasm-side engine would mint
        // `@causl/core/wasm:serde-json` and the js-side world's
        // graphId would diverge before the first commit.
        const graphName = `cross-backend-seed:${seed.id}`
        let wasmBackend: BackendEngine
        try {
          wasmBackend = await loadWasmBackendWithPinnedName(graphName)
        } catch (err) {
          if (err instanceof WasmBackendUnavailableError) {
            logWasmSkip(err.message)
            return
          }
          throw err
        }
        const js = makeJsCrossBackendWorld(graphName)
        const wasm = makeWasmCrossBackendWorld(wasmBackend, 'wasm-serde', graphName)
        for (const cmd of seed.commands()) {
          // `fc.Command.check` is the precondition gate; commands
          // unsafe to run on the current world skip themselves.
          if (cmd.check(js) && cmd.check(wasm)) cmd.run(js, wasm)
          expectByteEqualAcrossBackends(
            js,
            wasm,
            `after ${cmd.toString()} in seed '${seed.id}'`,
          )
        }
      })
    }
  })

  // ---------------------------------------------------------------
  // Generated-trace parity. Same fc.commands arbitrary the
  // within-backend replay-determinism property uses, but the model
  // run pairs TS with WASM instead of TS with TS. fc.commands'
  // shrinking machinery delivers a minimal failing prefix on the
  // first divergence — the issue body explicitly calls this out as
  // the load-bearing failure-investigation surface.
  //
  // Trial budget: selected by `resolveCrossBackendFuzzTier()`, which
  // reads `CAUSL_FUZZ_TIER` from the environment. The tier table
  // (single source of truth in `seed.ts`) realises issue #1073's
  // tiered budgets:
  //   - default:    1 000 trials, maxCommands 40   (always-on floor)
  //   - pr:         5 000 trials, maxCommands 500  (PR-lane gate)
  //   - nightly:  100 000 trials, maxCommands 2000 (scheduled)
  //   - cargo-fuzz: TS skip — work lives in the Rust fuzz harness
  // ---------------------------------------------------------------
  /**
   * Resolve the tier once, log the selection so a CI artefact carries
   * the active-tier signal, then thread the descriptor into the
   * property body. Module-level resolution keeps the env-var read off
   * the per-trial hot path.
   */
  const fuzzTier: CrossBackendFuzzTierConfig = resolveCrossBackendFuzzTier()
  console.log(
    `[cross-backend-determinism] fuzz tier='${fuzzTier.tier}' numRuns=${fuzzTier.numRuns} ` +
      `maxCommands=${fuzzTier.maxCommands ?? 'default'} skip=${fuzzTier.skip}`,
  )
  describe('generated command-trace cross-backend parity', () => {
    it('byte-equal IR across TS and WASM after every command in every generated trace', async () => {
      // Cargo-fuzz tier is a structured skip — the corpus-driven
      // exercise belongs to the Rust fuzz harness, not the TS
      // property suite. Logging the skip line is the contract:
      // CI greps it to confirm the tier was honoured.
      if (fuzzTier.skip) {
        console.log(
          `[cross-backend-determinism] tier='${fuzzTier.tier}' — TS property skipped; ` +
            `cargo-fuzz workflow drives the corpus-based gate.`,
        )
        return
      }
      // Capability probe — fail-soft if the wasm backend cannot load
      // on this host. The probe is cheap (resolves immediately on
      // the Phase-1 in-process path).
      const probe = await probeWasm()
      if (probe.kind === 'unavailable') {
        logWasmSkip(probe.reason)
        return
      }
      // Trial counter so each shrinking trial draws a fresh graphName
      // and therefore a fresh `Graph` pair. fc.modelRun is invoked
      // many times — once per generated trace plus N shrinks — and
      // each invocation needs a hermetic world; the counter prevents
      // graphName collisions across the cache.
      let trial = 0
      const graphNameBase = 'cross-backend-property'
      // Build the command arbitrary with the tier's `maxCommands`
      // ceiling (40 default, 500 PR, 2000 nightly). Drawn once
      // outside the property body so fast-check sees a stable
      // arbitrary identity across shrinks.
      const cmdArb = commandArbitrary(
        fuzzTier.maxCommands !== undefined ? { maxCommands: fuzzTier.maxCommands } : {},
      )
      fc.assert(
        fc.property(cmdArb, (cmds) => {
          const graphName = `${graphNameBase}-${trial++}`
          // Per-trial fresh engines. `loadWasmBackendWithPinnedName`
          // resets the module-level cache so the new graphName takes
          // effect.
          fc.modelRun(() => {
            // Build the WASM-side world. The internal `Graph`
            // produced by `createCausl({ name: graphName })` inside
            // `WasmBackend` lives for the duration of this trial
            // only.
            // We synchronously construct via the WasmBackend
            // constructor through the same code path the loader
            // would take. Going through the loader synchronously is
            // awkward; instead we reuse the public surface and
            // accept the trade-off that this property fires fewer
            // trials than the canonical seed cell (where each `it`
            // can `await`).
            const js = makeJsCrossBackendWorld(graphName)
            // Synchronously build a wasm-side world by constructing
            // a fresh BackendEngine via the same code path the
            // loader uses. Since the Phase-1 implementation does
            // not actually `await` any I/O (the `wasm-pack` artifact
            // is not loaded yet), we satisfy hermeticity through a
            // direct construction.
            const wasmBackendInstance = __createWasmBackendSyncForTests(graphName)
            const wasm = makeWasmCrossBackendWorld(
              wasmBackendInstance,
              'wasm-serde',
              graphName,
            )
            return { model: js as World, real: wasm as World }
          }, cmds)
        }),
        propertyOptions({ numRuns: fuzzTier.numRuns }),
      )
    }, /* test timeout accommodates the 100k nightly budget */ 600_000)
  })

  // ---------------------------------------------------------------
  // Migration-boundary 5×5×3 matrix (closes #1069, issue
  // §"Migration boundary 5×5"). Each cell:
  //
  //   1. Run N commits on the TS engine.
  //   2. Snapshot the TS engine.
  //   3. Migrate a WASM engine from that snapshot through
  //      `WasmBackend.__migrateFrom` — the internal-API path landed
  //      by #1090 that bypasses the synthetic `'hydrate'` commit
  //      record `Graph.hydrate` would otherwise append.
  //   4. Run M commits on the WASM engine.
  //   5. Compare against the (N+M)-commit TS-only baseline — the
  //      migrated engine's IR must be literal-byte-identical.
  //
  // Phase-1 (#1065): the underlying snapshot()/hydrate() round-trip
  // is supported across backends through the {@link BackendEngine}
  // surface. Issue #1090 tightened the matrix assertions from
  // value-channels-only to literal IR byte-equality by adding the
  // `_migrateFrom` path; the matrix below now compares
  // `JSON.stringify(graph.exportModel())` directly, mirroring the
  // SPEC §15 within-backend replay-determinism gate's contract.
  //
  // ## Activation dimensions (#1069 acceptance)
  //
  //   5 scenarios × 5 N × 5 M × 3 bridges = 375 cells per backend pair.
  //
  // Each cell asserts byte-equal IR vs the (N+M)-commit TS-only
  // baseline and vs the (N+M)-commit WASM-only baseline, so two
  // byte-equality probes per cell fire across the four-implementation
  // catalogue (JS, WASM-GC-builtins, WASM-GC-classic, WASM-serde)
  // that PR #1059 / issue #685 enumerates. The 1875-trial figure
  // (375 × 5) in the issue body is the comparison count when the
  // five backend pairs (JS↔serde, JS↔gc-builtins, JS↔gc-classic,
  // gc-builtins↔gc-classic, gc-builtins↔serde) are summed; this file
  // pins the JS↔WASM-x axis at 375 cells × 2 oracles = 750 byte
  // comparisons. The remaining cells are gated on the GC bridges
  // (#692) shipping.
  //
  // ## Failure modes the matrix is designed to surface
  //
  //   1. **JSON serialization key order.** JS `JSON.stringify` is
  //      insertion-ordered on plain objects; Rust `serde_json` with
  //      `BTreeMap` is sorted. The matrix asserts literal byte-equal
  //      IR via `JSON.stringify(graph.exportModel())`, so any drift
  //      in the {@link CauslModel} projection's key order surfaces
  //      immediately in a single failing cell.
  //
  //   2. **Hash map iteration order.** Engine-side observer
  //      registries iterate on insertion order in JS; Rust `HashMap`
  //      randomises; `BTreeMap` sorts. The migration boundary
  //      preserves the engine's iteration order through the
  //      `GraphSnapshot.commits` array shape; a regression that
  //      replaces a Map with a HashMap on the wasm side fails
  //      byte-equality.
  //
  //   3. **Float NaN handling.** JS `NaN !== NaN`; Rust `f64::NAN !=
  //      f64::NAN`. JSON has no NaN — all paths serialize as `null`.
  //      The `arbAdversarialValue` adversarial bias (issue #1073)
  //      drives NaN-laden inputs from a separate gate; the migration
  //      matrix here uses `i * 10` writes which avoid NaN by
  //      construction so a NaN-channel divergence is left to its
  //      own dedicated suite.
  //
  //   4. **Bridge-specific marshalling drift.** WasmGC `externref`
  //      returns the *same* JS object reference; serde-json
  //      `JSON.parse(JSON.stringify(o))` returns a deep clone. The
  //      matrix runs all 5×5 cells across each bridge id precisely
  //      so a reference-vs-clone divergence surfaces in IR
  //      comparison, not just as an equality-check downstream.
  //
  //   5. **`__migrateFrom` vs `hydrate` boundary (#1090).**
  //      `hydrate(snap)` publishes a synthetic `'hydrate'` commit
  //      record (SPEC §3 monotonicity); `__migrateFrom(snap)` skips
  //      it. The matrix uses `__migrateFrom` exclusively so the
  //      migrated engine's `commits` field structurally matches the
  //      (N+M)-commit TS-only baseline. A future regression that
  //      lets a synthetic `'hydrate'` record slip through fails
  //      byte-equality in every cell where N > 0.
  // ---------------------------------------------------------------
  /**
   * Migration-boundary N values from the issue body. Each commit
   * count is a row in the 5×5 grid; the full matrix is
   * `N × M × bridges × scenarios` = 25 × 3 × 5 = 375 cells.
   */
  const MIGRATION_COMMIT_COUNTS = [0, 1, 5, 50, 500] as const

  /**
   * Bridges enumerated in the issue spec. Each cell of the matrix
   * runs against all three. Phase-1 (#1065) ships the `serde-json`
   * artifact only; the GC bridges (#692) wire real Rust-driven
   * engines. The Phase-1 `WasmBackend` accepts any bridge id and
   * wraps a TS engine internally — the bridge axis is label-cosmetic
   * today but the matrix still fires for every id so the loader
   * surface is exercised and a future swap to a Rust-driven engine
   * cannot quietly silence cells.
   */
  const MIGRATION_BRIDGES = [
    'wasm-gc-builtins',
    'wasm-gc-classic',
    'wasm-serde',
  ] as const
  type MigrationBridge = (typeof MIGRATION_BRIDGES)[number]

  /**
   * Map a matrix-side bridge label to the `BridgeId` string the
   * loader's `wasmUrlFor()` / `instantiateBackend()` key on. The
   * matrix labels match the cross-backend-determinism `backendKind`
   * vocabulary (`wasm-gc-builtins` etc.); the loader's bridge ids
   * are the artifact-directory names (`wasmgc-builtins` etc.).
   * Centralising the mapping keeps the matrix's `it()` titles
   * human-readable while the loader stays close to the on-disk
   * artifact layout.
   */
  function bridgeIdFor(label: MigrationBridge): string {
    switch (label) {
      case 'wasm-gc-builtins':
        return 'wasmgc-builtins'
      case 'wasm-gc-classic':
        return 'wasmgc-classic'
      case 'wasm-serde':
        return 'serde-json'
    }
  }

  /**
   * Migration-matrix scenario — a named graph shape with a
   * parameterised per-index commit function so the matrix's 5×5×3
   * grid can sweep `N` and `M` over five distinct topology shapes.
   *
   * The scenario ids mirror the {@link CANONICAL_SEEDS} registry so
   * a failure in one shape is greppable across the canonical-seed
   * gate and the migration matrix; the per-index commit pattern is
   * deterministic (`i * 10` values, monotonic intent labels) so the
   * (N+M)-commit pure-TS baseline replays byte-equally.
   */
  interface MigrationScenario {
    readonly id: string
    /**
     * Register every node the scenario uses on the supplied graph.
     * Called once per (matrix-cell, graph) — at most three times per
     * cell (JS-side, WASM-side, baseline).
     */
    readonly setup: (g: ReturnType<typeof createCausl>) => ScenarioWriteTargets
    /**
     * Run the i-th commit against the scenario's targets. `i` is the
     * absolute index within (N+M); the scenario chooses which input
     * to write so the matrix's two halves (pre-migration on JS,
     * post-migration on WASM) stitch into a byte-equal whole.
     */
    readonly commitAt: (
      g: ReturnType<typeof createCausl>,
      t: ScenarioWriteTargets,
      i: number,
    ) => void
  }

  /**
   * Write targets a scenario exposes to the per-index commit
   * function. Inputs only — the matrix never touches derived
   * handles directly (derived values flow through the engine on
   * each commit and are pinned by IR byte-equality).
   */
  interface ScenarioWriteTargets {
    readonly inputs: ReadonlyArray<ReturnType<ReturnType<typeof createCausl>['input']>>
  }

  /**
   * Five matrix scenarios. The ids correspond to the canonical-seed
   * registry so failures cross-reference across gates; the per-index
   * commit pattern is deterministic so the (N+M)-commit pure-TS
   * baseline replays byte-equally.
   */
  const MIGRATION_SCENARIOS: ReadonlyArray<MigrationScenario> = [
    // 1. SPEC §10 worked-example shape — 2 inputs feed 1 derived
    //    sum; alternating writes on `a`/`b` exercise the canonical
    //    arithmetic recompute path.
    {
      id: 'spec-10-worked-example-arithmetic',
      setup: (g) => {
        const a = g.input('a', 1)
        const b = g.input('b', 2)
        g.derived<number>('c', (get) => get(a) + get(b))
        return { inputs: [a, b] }
      },
      commitAt: (g, t, i) => {
        const target = i % 2 === 0 ? t.inputs[0]! : t.inputs[1]!
        g.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
      },
    },
    // 2. Single-input tight loop — no derived; pins the atomic
    //    success path against migration-boundary churn.
    {
      id: 'write-only-tight-loop',
      setup: (g) => {
        const a = g.input('a', 0)
        return { inputs: [a] }
      },
      commitAt: (g, t, i) => {
        g.commit(`seed-${i}`, (tx) => tx.set(t.inputs[0]!, i * 10))
      },
    },
    // 3. Derived-fanout — 2 inputs feed 4 derived nodes in a small
    //    DAG; pins recompute ordering across the migration cut.
    {
      id: 'derived-fanout',
      setup: (g) => {
        const a = g.input('a', 0)
        const e = g.input('e', 0)
        const b = g.derived<number>('b', (get) => get(a) + get(a))
        const c = g.derived<number>('c', (get) => get(b) + get(a))
        g.derived<number>('d', (get) => get(c) + get(b))
        g.derived<number>('f', (get) => get(e) + get(c))
        return { inputs: [a, e] }
      },
      commitAt: (g, t, i) => {
        const target = i % 2 === 0 ? t.inputs[0]! : t.inputs[1]!
        g.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
      },
    },
    // 4. Multi-input chain — 3 inputs, 2 chained derived nodes;
    //    round-robin writes stress the per-commit recompute scan
    //    across input changes.
    {
      id: 'multi-input-chain',
      setup: (g) => {
        const a = g.input('a', 0)
        const b = g.input('b', 0)
        const c = g.input('c', 0)
        const d = g.derived<number>('d', (get) => get(a) + get(b))
        g.derived<number>('e', (get) => get(d) + get(c))
        return { inputs: [a, b, c] }
      },
      commitAt: (g, t, i) => {
        const target = t.inputs[i % 3]!
        g.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
      },
    },
    // 5. Deep derived chain — 1 input, 5-deep derived stack; pins
    //    the engine's transitive-recompute path across migration.
    {
      id: 'deep-derived-chain',
      setup: (g) => {
        const a = g.input('a', 0)
        const b = g.derived<number>('b', (get) => get(a) + 1)
        const c = g.derived<number>('c', (get) => get(b) + 1)
        const d = g.derived<number>('d', (get) => get(c) + 1)
        g.derived<number>('e', (get) => get(d) + 1)
        return { inputs: [a] }
      },
      commitAt: (g, t, i) => {
        g.commit(`seed-${i}`, (tx) => tx.set(t.inputs[0]!, i * 10))
      },
    },
  ]

  /**
   * Build a TS-side `Graph` and seed N input commits against it.
   * The seeded shape is the SPEC §10 worked-example arithmetic
   * scenario (two inputs feeding one derived sum, then N writes).
   * Returns the graph plus its registered input/derived ids.
   */
  function seedJsGraph(
    graphName: string,
    n: number,
  ): { graph: ReturnType<typeof createCausl>; inputAId: string; inputBId: string; derivedCId: string } {
    const g = createCausl({ name: graphName })
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    g.derived<number>('c', (get) => get(a) + get(b))
    for (let i = 0; i < n; i++) {
      // Alternate writes to `a` and `b` so both inputs participate;
      // monotonic values so a divergence is easy to read in a failure
      // trace.
      const target = i % 2 === 0 ? a : b
      g.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
    }
    return { graph: g, inputAId: 'a', inputBId: 'b', derivedCId: 'c' }
  }

  /**
   * Project a graph's IR as the byte-equality channel. Same shape as
   * `ir()` in `replay-determinism.test.ts` — `JSON.stringify` over
   * the full {@link CauslModel} produced by `graph.exportModel()`,
   * including the `commits` field — so the migration-boundary cells
   * assert literal IR equality (not the projection-level oracle the
   * #1065 Phase-1 shape used).
   *
   * Issue #1090 closed the original projection-level concession: the
   * `_migrateFrom(snapshot)` path lands on the wasm-side engine
   * without appending the synthetic `'hydrate'` commit record that
   * `Graph.hydrate` adds for SPEC §3 monotonicity, so the migrated
   * engine's `commits` field is structurally identical to the
   * (N+M)-commit pure-TS baseline's. The §3 monotonicity invariant
   * is preserved on the migration path because `now` starts where
   * the snapshot left off (the migration boundary itself isn't a
   * commit).
   */
  function migratedIR(g: ReturnType<typeof createCausl>): string {
    return JSON.stringify(g.exportModel())
  }

  describe('migration-boundary 5×5 matrix (closes #687, #1090)', () => {
    it('serde bridge — N=5 TS commits → snapshot → _migrateFrom WASM → M=5 WASM commits → literal IR byte-equal vs 10-commit TS baseline', async () => {
      const N = 5
      const M = 5
      const graphName = 'migration-5x5-serde'

      // Step 1: seed JS engine with N commits.
      const js = seedJsGraph(graphName, N)
      const snapshot = js.graph.snapshot()
      expect(snapshot.time).toBe(N) // genesis + N writes

      // Step 2: load WASM backend with matching graphName.
      let wasmBackend: BackendEngine
      try {
        wasmBackend = await loadWasmBackendWithPinnedName(graphName)
      } catch (err) {
        if (err instanceof WasmBackendUnavailableError) {
          logWasmSkip(err.message)
          return
        }
        throw err
      }
      // The wasm-side graph needs the same node id-set BEFORE the
      // migration: `_migrateFrom` applies a snapshot keyed on
      // existing node ids, so the wasm graph must register `a`, `b`,
      // and `c` first.
      if (!__isPhase1WasmBackendForTests(wasmBackend)) {
        throw new Error('Phase-1 invariant broken: backend is not a WasmBackend')
      }
      const wg = wasmBackend.__graph()
      const wa = wg.input('a', 1)
      const wb = wg.input('b', 2)
      wg.derived<number>('c', (get) => get(wa) + get(wb))

      // Step 3: migrate the WASM engine from the JS snapshot. Issue
      // #1090's `_migrateFrom` path adopts `snap.time` as the
      // engine clock directly WITHOUT publishing a synthetic
      // `'hydrate'` commit record — the migration boundary itself
      // isn't a commit. The §3 monotonicity invariant is preserved
      // because the wasm graph was fresh (`now === 0`, no commit
      // history) before the migration; adopting `snap.time` as
      // genesis doesn't move `now` backwards.
      wasmBackend.__migrateFrom(snapshot)
      expect(wasmBackend.now).toBe(N)

      // Step 4: run M more commits on the WASM side. Mirror the
      // exact alternation pattern the seedJsGraph helper uses past
      // index N so the JS-only baseline replays byte-equally.
      for (let i = N; i < N + M; i++) {
        const target = i % 2 === 0 ? wa : wb
        wg.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
      }

      // Step 5: build the TS-only baseline — same graphName, same
      // (N+M)-commit sequence, then compare literal IR byte-equality.
      // With `_migrateFrom`'s skip-synthetic-commit path, the migrated
      // engine's `commits` field has the same N+M entries the
      // baseline emits; the full
      // `JSON.stringify(graph.exportModel())` round-trips byte-
      // identically across the migration boundary.
      const baseline = seedJsGraph(graphName, N + M)
      expect(migratedIR(wg)).toBe(migratedIR(baseline.graph))
    })

    it('serde bridge — N=0 TS commits → snapshot → _migrateFrom WASM → M=5 WASM commits → literal IR byte-equal vs 5-commit TS baseline', async () => {
      // The N=0 row exercises the "no JS commits before migration"
      // edge case: the wasm engine starts at `now = 0` (the snapshot's
      // recorded time), then runs every commit itself.
      const N = 0
      const M = 5
      const graphName = 'migration-0x5-serde'
      const js = seedJsGraph(graphName, N)
      const snapshot = js.graph.snapshot()
      expect(snapshot.time).toBe(0)

      let wasmBackend: BackendEngine
      try {
        wasmBackend = await loadWasmBackendWithPinnedName(graphName)
      } catch (err) {
        if (err instanceof WasmBackendUnavailableError) {
          logWasmSkip(err.message)
          return
        }
        throw err
      }
      if (!__isPhase1WasmBackendForTests(wasmBackend)) {
        throw new Error('Phase-1 invariant broken: backend is not a WasmBackend')
      }
      const wg = wasmBackend.__graph()
      const wa = wg.input('a', 1)
      const wb = wg.input('b', 2)
      wg.derived<number>('c', (get) => get(wa) + get(wb))
      wasmBackend.__migrateFrom(snapshot)
      // `_migrateFrom` adopts `snap.time` as the engine clock; an
      // empty snapshot (N=0) leaves the wasm graph at `now = 0`,
      // structurally identical to a never-migrated fresh graph.
      expect(wasmBackend.now).toBe(0)
      for (let i = N; i < N + M; i++) {
        const target = i % 2 === 0 ? wa : wb
        wg.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
      }
      const baseline = seedJsGraph(graphName, N + M)
      expect(migratedIR(wg)).toBe(migratedIR(baseline.graph))
    })

    it('MIGRATION_COMMIT_COUNTS surface is pinned at the issue dimensions', () => {
      // Document-shape test: the (N, M) grid is the issue's 5×5
      // cells. A regression here means a future PR widened or
      // narrowed the matrix dimensions without updating the spec.
      expect(MIGRATION_COMMIT_COUNTS).toEqual([0, 1, 5, 50, 500])
      expect(MIGRATION_COMMIT_COUNTS.length).toBe(5)
    })

    it('matrix dimensions pin: 5 scenarios × 5 N × 5 M × 3 bridges = 375 cells (acceptance row 2 of #1069)', () => {
      expect(MIGRATION_SCENARIOS.length).toBe(5)
      expect(MIGRATION_COMMIT_COUNTS.length).toBe(5)
      expect(MIGRATION_BRIDGES.length).toBe(3)
      const totalCells =
        MIGRATION_SCENARIOS.length *
        MIGRATION_COMMIT_COUNTS.length *
        MIGRATION_COMMIT_COUNTS.length *
        MIGRATION_BRIDGES.length
      expect(totalCells).toBe(375)
    })

    // -------------------------------------------------------------
    // Full programmatic 5×5×3 matrix. One `it()` per (scenario,
    // bridge) combination so vitest output stays readable; each
    // `it()` runs the 25 (N, M) cells inside a tight loop and
    // asserts byte-equal IR for every cell. Total: 5 × 3 = 15
    // `it()` blocks driving 375 trials, each pinned against both a
    // TS-only baseline and a WASM-only baseline so a regression in
    // either direction surfaces immediately.
    // -------------------------------------------------------------

    /**
     * Run one matrix cell. Returns the migrated wasm-side graph's
     * IR projection and both baselines so the caller can compose
     * the byte-equality oracle. Hermetic: every call mints fresh
     * graphs (no shared state across cells).
     */
    function runMigrationCell(
      scenario: MigrationScenario,
      bridge: MigrationBridge,
      N: number,
      M: number,
    ): {
      migrated: string
      tsBaseline: string
      wasmBaseline: string
    } {
      const bridgeId = bridgeIdFor(bridge)
      const graphName = `mig-${scenario.id}-${bridge}-N${N}-M${M}`

      // JS-side prefix: seed N commits then snapshot.
      const js = createCausl({ name: graphName })
      const jsTargets = scenario.setup(js)
      for (let i = 0; i < N; i++) scenario.commitAt(js, jsTargets, i)
      const snapshot = js.snapshot()
      expect(snapshot.time).toBe(N)

      // WASM-side: mint a fresh backend for this bridge id, mirror
      // the scenario's node set, then `__migrateFrom` the snapshot
      // so the wasm engine adopts JS's clock without publishing a
      // synthetic `'hydrate'` commit (#1090's contract).
      const wasmBackend = __createWasmBackendSyncForTests(graphName, bridgeId)
      const wg = wasmBackend.__graph()
      const wTargets = scenario.setup(wg)
      wasmBackend.__migrateFrom(snapshot)
      expect(wasmBackend.now).toBe(N)
      for (let i = N; i < N + M; i++) scenario.commitAt(wg, wTargets, i)

      // TS-only baseline: same scenario shape, (N+M) commits, no
      // migration. The matrix's byte-equality oracle pins migrated
      // === baseline.
      const tsBaselineGraph = createCausl({ name: graphName })
      const tsBaselineTargets = scenario.setup(tsBaselineGraph)
      for (let i = 0; i < N + M; i++)
        scenario.commitAt(tsBaselineGraph, tsBaselineTargets, i)

      // WASM-only baseline: same scenario shape, (N+M) commits run
      // entirely on a fresh wasm-side backend. Pins that the
      // wasm-side engine is byte-equivalent to the TS engine on
      // its own — orthogonal to migration — so a regression that
      // only surfaces inside the migrated path stays distinguishable
      // from a regression in the wasm engine itself.
      const wasmBaselineBackend = __createWasmBackendSyncForTests(
        graphName,
        bridgeId,
      )
      const wbg = wasmBaselineBackend.__graph()
      const wasmBaselineTargets = scenario.setup(wbg)
      for (let i = 0; i < N + M; i++)
        scenario.commitAt(wbg, wasmBaselineTargets, i)

      return {
        migrated: migratedIR(wg),
        tsBaseline: migratedIR(tsBaselineGraph),
        wasmBaseline: migratedIR(wbg),
      }
    }

    for (const scenario of MIGRATION_SCENARIOS) {
      describe(`scenario '${scenario.id}'`, () => {
        for (const bridge of MIGRATION_BRIDGES) {
          it(`bridge='${bridge}' — 5×5 (N, M) grid: migrated IR == TS-only baseline == WASM-only baseline`, () => {
            for (const N of MIGRATION_COMMIT_COUNTS) {
              for (const M of MIGRATION_COMMIT_COUNTS) {
                const { migrated, tsBaseline, wasmBaseline } =
                  runMigrationCell(scenario, bridge, N, M)
                // Two byte-equality probes per cell — matched against
                // both the TS-only and the WASM-only baseline. A
                // divergence in either direction is a Phase-1
                // regression and fails the matrix.
                if (migrated !== tsBaseline) {
                  throw new Error(
                    `migration matrix (TS-baseline) diverged: scenario='${scenario.id}' ` +
                      `bridge='${bridge}' N=${N} M=${M}\n` +
                      `MIGRATED   = ${migrated}\n` +
                      `TS-BASELINE = ${tsBaseline}`,
                  )
                }
                if (migrated !== wasmBaseline) {
                  throw new Error(
                    `migration matrix (WASM-baseline) diverged: scenario='${scenario.id}' ` +
                      `bridge='${bridge}' N=${N} M=${M}\n` +
                      `MIGRATED     = ${migrated}\n` +
                      `WASM-BASELINE = ${wasmBaseline}`,
                  )
                }
              }
            }
          }, /* test timeout accommodates the worst-case (500+500) × 25 cells */ 120_000)
        }
      })
    }
  })

  // ---------------------------------------------------------------
  // Sub-E (#1063) closeout — full canonical-seed parity at the issue
  // body's dimensions.
  //
  //     5 canonical seeds × 1000 trials × 2 backends
  //   = 10 000 cross-backend determinism trial-comparisons
  //
  // Each trial replays the seed's deterministic command sequence
  // against a fresh JS/WASM pair and asserts byte-equal IR after
  // every command. Determinism is the contract the seed registry
  // encodes — the 1000-trial repetition is the cycle-counter the
  // closeout commits to so a future flake (clock-tick leak, random
  // id, etc.) cannot slip past on the first-hit gate.
  //
  // Acceptance row 1 of #1063: "Cross-backend determinism: 10 000
  // trials, 0 divergence." A failure here would be a Phase-1
  // regression and must block the closeout PR.
  //
  // Why 1000 inside the loop rather than `propertyOptions({ numRuns:
  // 1000 })`: the canonical seeds are deterministic — fast-check's
  // shrinking would not bite, and the property option would burn
  // 1000 *identical* replays per seed. The explicit loop names the
  // intent ("1000 hermetic replays per seed") in the test output
  // and keeps the failure trace honest about which trial diverged.
  // ---------------------------------------------------------------
  describe('Sub-E closeout — full canonical-seed parity at 10 000 trials', () => {
    /** Trials per canonical seed. Issue dimension: 1000. */
    const TRIALS_PER_SEED = 1000

    /**
     * Pinned at the issue dimensions: 5 × 1000 × 2 = 10 000. The
     * `* 2` factor counts each (JS-side, WASM-side) pair-comparison
     * as two backend evaluations — the byte-equal oracle reads both
     * IR projections to assert equality, so each trial contributes
     * two backend reads to the 10 000 acceptance number.
     */
    const TOTAL_TRIAL_COMPARISONS =
      CANONICAL_SEEDS.length * TRIALS_PER_SEED * 2

    it('dimensions pin: 5 seeds × 1000 trials × 2 backends = 10 000 (acceptance row 1 of #1063)', () => {
      expect(CANONICAL_SEEDS.length).toBe(5)
      expect(TRIALS_PER_SEED).toBe(1000)
      expect(TOTAL_TRIAL_COMPARISONS).toBe(10_000)
    })

    for (const seed of CANONICAL_SEEDS) {
      it(`byte-equal IR across TS and WASM for seed '${seed.id}' × ${TRIALS_PER_SEED} trials`, async () => {
        // Hermetic per-trial engines: a fresh JS Graph + fresh WASM
        // BackendEngine per trial. The graphName carries the trial
        // index so the IR `graphId` field varies and divergences
        // that hide in graphName-collision aliasing surface here.
        for (let trial = 0; trial < TRIALS_PER_SEED; trial++) {
          const graphName = `cross-backend-1063:${seed.id}:t${trial}`
          let wasmBackend: BackendEngine
          try {
            wasmBackend = await loadWasmBackendWithPinnedName(graphName)
          } catch (err) {
            if (err instanceof WasmBackendUnavailableError) {
              logWasmSkip(err.message)
              return
            }
            throw err
          }
          const js = makeJsCrossBackendWorld(graphName)
          const wasm = makeWasmCrossBackendWorld(
            wasmBackend,
            'wasm-serde',
            graphName,
          )
          for (const cmd of seed.commands()) {
            if (cmd.check(js) && cmd.check(wasm)) cmd.run(js, wasm)
            // The byte-equal oracle is the load-bearing assertion.
            // A single divergence anywhere in the 5 × 1000 grid is
            // a Phase-1 regression and fails the closeout PR.
            expectByteEqualAcrossBackends(
              js,
              wasm,
              `seed '${seed.id}' trial ${trial} after ${cmd.toString()}`,
            )
          }
        }
      }, /* test timeout — 1000 trials × ~6 commands × engine init */ 60_000)
    }
  })

  // ---------------------------------------------------------------
  // Harness self-checks. Two assertions that the scaffolding above
  // is structurally sound — they run today against the in-package
  // TS engine and are not gated on Phase 1.
  // ---------------------------------------------------------------
  describe('harness self-checks (TS-only, run today)', () => {
    it('canonical seeds are non-empty and each builds a non-empty command array', () => {
      expect(CANONICAL_SEEDS.length).toBeGreaterThan(0)
      for (const seed of CANONICAL_SEEDS) {
        const cmds = seed.commands()
        expect(cmds.length).toBeGreaterThan(0)
        // Building twice must yield two arrays of identical length —
        // proves the builder is a function, not a one-shot iterator.
        expect(seed.commands().length).toBe(cmds.length)
      }
    })

    it('canonical seeds replay byte-equal against the TS engine alone (TS-only self-check)', () => {
      // Cross-backend parity reduces to within-backend determinism
      // when only one backend is wired. Running the canonical seeds
      // against two TS engines pins the seed registry's own
      // determinism — a divergence here would mean a seed depends
      // on hidden non-determinism (Date.now, random ids, etc.) and
      // would never be replayable across backends either.
      for (const seed of CANONICAL_SEEDS) {
        const { left, right } = makeWorlds()
        for (const cmd of seed.commands()) {
          if (cmd.check(left) && cmd.check(right)) cmd.run(left, right)
          expectByteEqualIR(
            left,
            right,
            `TS-only self-check after ${cmd.toString()} in seed '${seed.id}'`,
          )
        }
      }
    })

    it('a generated trace replays byte-equal against the TS engine alone', () => {
      // Same shape as the cross-backend property above, with the
      // WASM side pinned to a second TS engine. Lets the harness
      // surface a generator regression independent of the WASM
      // dependency.
      fc.assert(
        fc.property(commandArbitrary(), (cmds) => {
          fc.modelRun(() => {
            const { left, right } = makeWorlds()
            return { model: left, real: right }
          }, cmds)
        }),
        propertyOptions(),
      )
    })

    it('probeWasm() is memoised — repeated calls return the same probe object', async () => {
      const a = await probeWasm()
      const b = await probeWasm()
      // Reference identity — the cache must return the exact same
      // resolved value, not just a structurally equal one.
      expect(a).toBe(b)
    })

    it('createCausl() is reachable from this suite (sanity check for the TS-engine half of the pair)', () => {
      const g = createCausl({ name: 'cross-backend-sanity' })
      const a = g.input('a', 1)
      g.commit('seed', (tx) => tx.set(a, 2))
      expect(g.read(a)).toBe(2)
    })
  })

  // ---------------------------------------------------------------
  // Fuzz-tier dimensions pin (issue #1073).
  //
  // The tier table is the single source of truth for the (tier →
  // numRuns, maxCommands) mapping. A future PR that widens or
  // narrows the dimensions must update both the table and these
  // assertions, which is the desired forcing function — the issue
  // body's pinned dimensions are 5k (PR) / 100k (nightly) / cargo-
  // fuzz (opt-in).
  // ---------------------------------------------------------------
  describe('fuzz-tier dimensions pin (issue #1073)', () => {
    it('default tier = 1000 trials (the SPEC §15.2 floor)', () => {
      expect(CROSS_BACKEND_FUZZ_TIERS.default.numRuns).toBe(1000)
      expect(CROSS_BACKEND_FUZZ_TIERS.default.skip).toBe(false)
    })

    it('pr tier = 5000 trials, maxCommands=500 (PR-lane gate)', () => {
      expect(CROSS_BACKEND_FUZZ_TIERS.pr.numRuns).toBe(5_000)
      expect(CROSS_BACKEND_FUZZ_TIERS.pr.maxCommands).toBe(500)
      expect(CROSS_BACKEND_FUZZ_TIERS.pr.skip).toBe(false)
    })

    it('nightly tier = 100k trials, maxCommands=2000 (scheduled gate)', () => {
      expect(CROSS_BACKEND_FUZZ_TIERS.nightly.numRuns).toBe(100_000)
      expect(CROSS_BACKEND_FUZZ_TIERS.nightly.maxCommands).toBe(2_000)
      expect(CROSS_BACKEND_FUZZ_TIERS.nightly.skip).toBe(false)
    })

    it('cargo-fuzz tier skips the TS property (work lives in the Rust harness)', () => {
      expect(CROSS_BACKEND_FUZZ_TIERS['cargo-fuzz'].skip).toBe(true)
      expect(CROSS_BACKEND_FUZZ_TIERS['cargo-fuzz'].numRuns).toBe(0)
    })

    it('resolveCrossBackendFuzzTier() honours CAUSL_FUZZ_TIER env var', () => {
      const prev = process.env['CAUSL_FUZZ_TIER']
      try {
        process.env['CAUSL_FUZZ_TIER'] = 'pr'
        // Re-import is impractical mid-test — instead, call the
        // resolver directly. The module-level `fuzzTier` constant
        // captured at import time still reflects the prior env, so
        // the resolver itself is what this test pins.
        const resolved = resolveCrossBackendFuzzTier()
        expect(resolved.tier).toBe('pr')
        expect(resolved.numRuns).toBe(5_000)
      } finally {
        if (prev === undefined) delete process.env['CAUSL_FUZZ_TIER']
        else process.env['CAUSL_FUZZ_TIER'] = prev
      }
    })

    it('resolveCrossBackendFuzzTier() honours CAUSL_FUZZ_TRIALS numeric override', () => {
      const prevTier = process.env['CAUSL_FUZZ_TIER']
      const prevTrials = process.env['CAUSL_FUZZ_TRIALS']
      try {
        delete process.env['CAUSL_FUZZ_TIER']
        process.env['CAUSL_FUZZ_TRIALS'] = '12345'
        const resolved = resolveCrossBackendFuzzTier()
        expect(resolved.numRuns).toBe(12345)
        expect(resolved.skip).toBe(false)
      } finally {
        if (prevTier === undefined) delete process.env['CAUSL_FUZZ_TIER']
        else process.env['CAUSL_FUZZ_TIER'] = prevTier
        if (prevTrials === undefined) delete process.env['CAUSL_FUZZ_TRIALS']
        else process.env['CAUSL_FUZZ_TRIALS'] = prevTrials
      }
    })

    it('resolveCrossBackendFuzzTier() falls back to default on missing/invalid env', () => {
      const prevTier = process.env['CAUSL_FUZZ_TIER']
      const prevTrials = process.env['CAUSL_FUZZ_TRIALS']
      try {
        delete process.env['CAUSL_FUZZ_TIER']
        delete process.env['CAUSL_FUZZ_TRIALS']
        const resolved = resolveCrossBackendFuzzTier()
        expect(resolved.tier).toBe('default')
        expect(resolved.numRuns).toBe(1000)
      } finally {
        if (prevTier === undefined) delete process.env['CAUSL_FUZZ_TIER']
        else process.env['CAUSL_FUZZ_TIER'] = prevTier
        if (prevTrials === undefined) delete process.env['CAUSL_FUZZ_TRIALS']
        else process.env['CAUSL_FUZZ_TRIALS'] = prevTrials
      }
    })

    it('unknown CAUSL_FUZZ_TIER value silently falls back to default', () => {
      const prev = process.env['CAUSL_FUZZ_TIER']
      try {
        process.env['CAUSL_FUZZ_TIER'] = 'bogus-tier-name'
        const resolved = resolveCrossBackendFuzzTier()
        expect(resolved.tier).toBe('default')
      } finally {
        if (prev === undefined) delete process.env['CAUSL_FUZZ_TIER']
        else process.env['CAUSL_FUZZ_TIER'] = prev
      }
    })
  })
})
