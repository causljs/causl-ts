/**
 * @packageDocumentation
 *
 * H9 parity-gate scaffolding — `WebAssembly.Memory.prototype.grow()`
 * invalidating React.useMemo closures that hold typed-array views
 * into the WASM linear-memory buffer.
 *
 * Background.
 *
 * Issue #1157 (panel-review-derived sub-issue of post-0.9.0 Rust port
 * epic #1133) splits the H9 hazard from `docs/wasm-backend-adopter-audit.md`
 * out as a stand-alone parity gate. The TS engine has no linear memory
 * and therefore cannot reproduce the hazard; the Phase-1 `WasmBackend`
 * (issues #1062 / #1065 / PR #1107) is currently a TS-wrapper that
 * routes commits through `createCausl()`, so it accidentally satisfies
 * the gate too. The hazard becomes observable only when the future
 * Rust-driven engine (epic #1133) replaces the wrapper's internal
 * commit pipeline with a real `WebAssembly.Memory`-backed allocator.
 *
 * At that point any adopter `useMemo(() => new Float64Array(memory.buffer,
 * offset, length), [commit])` closure cached across a commit boundary
 * that triggers `memory.grow()` becomes wrong silently — the closure's
 * captured `ArrayBuffer` reference is detached, every read produces
 * `0` / a `TypeError`, and React's reconciler has no signal to evict
 * the stale view. The gate this file scaffolds catches that regression
 * during the Rust port, not after adopters file bugs.
 *
 * Why scaffold now.
 *
 * The Markbåge/Miller panel review (2026-05-11) flagged that the hazard
 * was filed in the adopter audit (PR #1021) but never had a gate. Two
 * choices: (a) wait for the Rust port to land then write the gate
 * after the fact, or (b) scaffold the gate now with `it.skipIf(
 * !realRustBackend)` so the assertions are pre-written and activate
 * automatically when the Phase-1 wrapper is swapped. Option (b) was
 * accepted: the cognitive load of writing the assertions correctly is
 * paid once, at the moment the hazard is fresh, instead of being
 * re-derived months later under port pressure.
 *
 * Activation contract.
 *
 * The {@link realRustBackend} getter returns `false` today because the
 * `loadWasmBackend()` shipper (PR #1107) returns a Phase-1 `WasmBackend`
 * instance that wraps a TS `Graph`. The `__isPhase1WasmBackendForTests`
 * guard in `packages/core/wasm/index.ts` returns `true` for that
 * instance; the negation is the activation signal. When the Rust port
 * lands and the wrapper is swapped for a bridge-routing implementation,
 * `__isPhase1WasmBackendForTests` returns `false` and the assertions
 * in this file start firing.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1157} — H9 parity-gate issue.
 * @see {@link https://github.com/iasbuilt/causl/issues/1133} — Rust port epic.
 * @see {@link https://github.com/iasbuilt/causl/pull/1021} — adopter audit (H9 hazard origin).
 * @see `docs/wasm-backend-adopter-audit.md` — adopter-audit document.
 */

import {
  __isPhase1WasmBackendForTests,
  __createWasmBackendSyncForTests,
  type BackendEngine,
} from '@causl/core/wasm'
import { describe, expect, it } from 'vitest'

/**
 * `true` IFF the WASM backend the React adapter would resolve at
 * `loadWasmBackend()` time is a real Rust-driven engine (i.e. NOT the
 * Phase-1 TS-wrapper `WasmBackend` class shipped by PR #1107).
 *
 * The Phase-1 wrapper has no WASM linear memory at all — it routes
 * commits through `createCausl()` — so the H9 hazard literally cannot
 * be reproduced against it. The gate must be a strict guard against
 * "we are running on Phase-1 today" so the assertions stay correct
 * once the wrapper is swapped.
 *
 * Today this returns `false`: `__createWasmBackendSyncForTests()`
 * mints a Phase-1 `WasmBackend` instance and
 * `__isPhase1WasmBackendForTests()` returns `true` for it, so the
 * negation is `false` and every `it.skipIf(!realRustBackend)` skips.
 *
 * When the Rust port lands and the wrapper is replaced by a
 * bridge-routing implementation, `__isPhase1WasmBackendForTests()`
 * starts returning `false` for the new instances; the negation flips
 * to `true` and the assertions in this file start running.
 *
 * @internal
 */
function realRustBackend(): boolean {
  let probe: BackendEngine
  try {
    probe = __createWasmBackendSyncForTests('h9.parity.probe')
  } catch {
    // The probe constructor failed — we cannot determine the backend
    // shape, so treat the gate as inactive (skip) rather than firing
    // a misleading assertion failure. The Rust port's switchover plan
    // (epic #1133) preserves the `__createWasmBackendSyncForTests`
    // factory; if it ever fails, the migration is incomplete and the
    // skip is the correct conservative answer.
    return false
  }
  // The Phase-1 guard returns `true` for the TS-wrapper class and
  // `false` for any future bridge-routing implementation. The H9
  // gate activates exactly when the guard flips to `false`.
  return !__isPhase1WasmBackendForTests(probe)
}

describe('H9 — memory.grow invalidates React.useMemo closures (parity gate)', () => {
  /**
   * Scaffold the always-on shape of the gate — proves the
   * `realRustBackend` getter resolves without throwing on the current
   * Phase-1 wrapper and reports the documented `false` answer. This
   * test exists so that if the wrapper is swapped accidentally
   * without updating the getter, the unconditional shape assertion
   * surfaces the drift before the skipped assertions silently start
   * firing against an undefined-behavior engine.
   *
   * The `false`-today expectation is documented in the file header.
   * Flipping it to `true` is the explicit signal the Rust port has
   * landed; that swap happens in the same PR that replaces the
   * Phase-1 wrapper.
   */
  it('reports the Phase-1 wrapper today (getter resolves false)', () => {
    // Until the Rust port (epic #1133) lands, every WasmBackend the
    // loader produces is a TS-wrapper Phase-1 instance — the getter
    // must agree. When this flips, the swap PR updates this assertion
    // alongside removing the `__isPhase1WasmBackendForTests` guard.
    expect(realRustBackend()).toBe(false)
  })

  /**
   * H9 acceptance #1 (per issue #1157):
   *
   * > Mount `useCauslNode` with backend that grows linear memory
   * > between commits. Assert: React.useMemo closures invalidate
   * > (return new values) when buffer grows.
   *
   * The shape of the activated test:
   *
   *   1. `loadWasmBackend()` resolves to a bridge-routing engine.
   *   2. Mount a component that calls `useCauslNode(typedNode)` and
   *      wraps the returned typed-array view in a `useMemo(() =>
   *      computeStats(view), [view])`.
   *   3. Commit a write that grows the engine's linear memory (the
   *      Rust side decides when to grow; the gate assumes the
   *      commit-boundary growth schedule documented in epic #1133).
   *   4. Force a re-render and assert the `useMemo`'s captured
   *      `view.buffer` is NOT `===` the pre-grow buffer, AND that the
   *      derived stats reflect the post-grow value. If React's
   *      reconciler missed the invalidation, the stats are stale and
   *      the assertion fails — exactly the regression class this gate
   *      catches.
   *
   * Until then, `it.skipIf(!realRustBackend())` keeps this test
   * inert; the body documents the activation contract for the future
   * port author.
   */
  it.skipIf(!realRustBackend())(
    'useMemo closures invalidate when WASM linear memory grows between commits',
    () => {
      // Activation criteria (Rust port lands → flip):
      //
      // - `loadWasmBackend()` returns a bridge-routing BackendEngine.
      // - Engine MUST expose its underlying `WebAssembly.Memory`
      //   handle through a documented introspection seam so the test
      //   can capture pre/post `buffer` references and confirm
      //   detachment. The seam is part of the Rust port's adopter
      //   debugging contract (TBD during epic #1133); without it the
      //   test cannot disambiguate "grow happened" from "grow was
      //   skipped".
      // - The test commits a large typed-array write known to exceed
      //   the engine's current memory.pages, forcing a grow at commit
      //   boundary.
      // - A `useMemo(() => new ctor(view.buffer, offset, length),
      //   [view])` closure is mounted before the commit; the
      //   post-commit render MUST surface a fresh memo value, which
      //   the test asserts by comparing the cached object identity
      //   across renders.
      //
      // Concrete implementation deferred to the Rust port PR — the
      // introspection seam shape determines the exact assertion
      // wording, and writing it speculatively risks pinning the
      // engine surface to a shape the port chooses not to ship.
      expect.fail(
        'H9 scaffold: gate activated (realRustBackend() === true) but the ' +
          'concrete useMemo-invalidation assertions are not implemented yet. ' +
          'Implement them in the same PR that swaps the Phase-1 wrapper for ' +
          'the bridge-routing engine (epic #1133).',
      )
    },
  )

  /**
   * H9 acceptance #2 (per issue #1157):
   *
   * > Assert: typed-array views into old buffer are detected (error
   * > or fresh views).
   *
   * The shape of the activated test:
   *
   *   1. Same backend + bridge setup as the previous test.
   *   2. Manually construct a typed-array view into the engine's
   *      linear-memory buffer (`new Float64Array(memory.buffer,
   *      offset, length)`).
   *   3. Commit a write that grows the memory.
   *   4. Either:
   *      (a) Reading through the cached view throws a `TypeError`
   *          for "Cannot perform %TypedArray%.prototype.byteLength on
   *          detached ArrayBuffer" — the documented JS-spec behavior
   *          for stale views after a `grow()`. The test catches the
   *          error and treats that as a passing detection signal.
   *      (b) The engine's adopter-facing API has refreshed the view
   *          for the adopter (the safer-by-default mode the Rust
   *          port may pick), in which case the view's `buffer` ===
   *          the new memory.buffer.
   *
   * Either (a) or (b) is acceptable — both prove the engine surfaces
   * the grow to adopters; the bug class this gate guards against is
   * "engine grows memory and adopter never finds out", where the
   * adopter's stale view reads back zeros silently.
   */
  it.skipIf(!realRustBackend())(
    'typed-array views into pre-grow buffer are detected (error or auto-refreshed)',
    () => {
      // Activation criteria (Rust port lands → flip):
      //
      // - Same `loadWasmBackend()` + introspection-seam preconditions
      //   as the previous test.
      // - Test constructs a `Float64Array` view directly against the
      //   engine's `memory.buffer` BEFORE the grow-triggering commit.
      // - After the commit, the test attempts two reads:
      //     1. `cachedView[0]` — if this throws `TypeError`, the
      //        detached-buffer detection path is working (option (a)).
      //     2. `cachedView.buffer === currentMemoryBuffer` — if this
      //        is `true`, the engine auto-refreshed the view
      //        (option (b)).
      // - The test passes iff EITHER detection works, fails iff
      //   BOTH fail (silent stale-view read class).
      //
      // Concrete implementation deferred to the Rust port PR for the
      // same reason as the previous test — the engine's
      // adopter-facing introspection seam determines the assertion
      // shape.
      expect.fail(
        'H9 scaffold: gate activated (realRustBackend() === true) but the ' +
          'concrete detached-buffer-detection assertions are not implemented ' +
          'yet. Implement them in the same PR that swaps the Phase-1 wrapper ' +
          'for the bridge-routing engine (epic #1133).',
      )
    },
  )
})
