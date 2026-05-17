/**
 * @packageDocumentation
 *
 * No-fallback cross-implementation determinism gate for
 * `BackendEngine.evaluateStatechart` (issue #1122).
 *
 * Pins two contracts at the 1000-trial floor for both the
 * `ConflictRegistry` and `ResourceFleet` regions of the SPEC §6
 * composite-statechart extension point landed by #1068 / PR #1092:
 *
 *   1. **JsBackend ↔ WasmBackend byte-identity.** Every
 *      `(region, state, event, time, id)` quadruple produces a
 *      structurally-equal {@link StatechartResult} when routed through
 *      either backend's `evaluateStatechart` method.
 *
 *   2. **Synthetic-forbidden fallback never invoked.** The legacy
 *      back-channel fallback path (a synthetic-forbidden result with
 *      `from='__backend-for-test-missing__'`) was removed in #1122; the
 *      `WasmBackend` retains an internal `syntheticFallbackCount`
 *      counter that MUST remain zero. This property asserts it stays
 *      zero across 1000 trials per region — a future regression that
 *      silently re-introduces a fallback fires this gate.
 *
 * The trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED` and
 * logged on failure for reproducible CI bisection.
 *
 * ## Why this file exists separately from `evaluate-statechart-agreement`
 *
 * The sync-side agreement gate
 * (`packages/sync/test/properties/evaluate-statechart-agreement.property.test.ts`,
 * landed by PR #1092) pins `JsBackend.evaluateStatechart` ↔ canonical
 * `reduceConflict` / `reduceResource` byte-equality. This file pins a
 * different cross-implementation gate — `JsBackend.evaluateStatechart`
 * ↔ `WasmBackend.evaluateStatechart` — and additionally instruments
 * the no-fallback property the #1122 cleanup commits to. Both gates
 * fire together every CI run; together with the cross-bridge
 * `Commit`-byte-identity gate (#1071) and the cross-backend
 * commit-log gate (#685) they form the four-way determinism net for
 * the Phase-1 WASM backend.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1122} — this gate.
 * @see {@link https://github.com/iasbuilt/causl/issues/1068} — `evaluateStatechart` extension point.
 * @see {@link https://github.com/iasbuilt/causl/issues/685} — cross-backend determinism EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/1071} — cross-bridge `Commit` byte-identity gate.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { propertyTrials } from '@causl/core-testing-internal'

import { JsBackend, type JsBackendOps } from '../../src/backend.js'
import { evaluateStatechart as evaluateStatechartCanonical } from '../../src/statechart-evaluator.js'
import {
  __createWasmBackendSyncForTests,
  __isPhase1WasmBackendForTests,
  type BackendEngine,
  type StatechartInput,
  type StatechartResult,
} from '../../wasm/index.js'

// ---------------------------------------------------------------------------
// Test fixtures — minimal `JsBackend` whose `evaluateStatechart` op
// routes through the same canonical evaluator that `createCausl` wires
// into the production `JsBackend` (see `graph.ts:6240`). The other
// ten `JsBackendOps` fields throw `notWired()` because this gate only
// exercises the statechart seam; the throw is the structural assertion
// that the property never reaches into commit/read/snapshot/... by
// accident.
// ---------------------------------------------------------------------------

function makeJsBackend(): JsBackend {
  const notWired = (op: string): never => {
    throw new Error(
      `evaluate-statechart-no-fallback property test: JsBackendOps.${op} is ` +
        `not wired in this fixture — the property exercises ` +
        `evaluateStatechart only.`,
    )
  }
  const ops: JsBackendOps = {
    commit: () => notWired('commit'),
    read: () => notWired('read'),
    subscribe: () => notWired('subscribe'),
    subscribeCommits: () => notWired('subscribeCommits'),
    snapshot: () => notWired('snapshot'),
    hydrate: () => notWired('hydrate'),
    exportModel: () => notWired('exportModel'),
    readAt: () => notWired('readAt'),
    snapshotAt: () => notWired('snapshotAt'),
    dispose: () => notWired('dispose'),
    // The only op the property exercises — the same delegation
    // `graph.ts` wires for the production JsBackend.
    evaluateStatechart: (input) => evaluateStatechartCanonical(input),
    now: () => 0,
  }
  return new JsBackend(ops)
}

// ---------------------------------------------------------------------------
// Arbitraries — mirror the shapes the canonical reducers in
// `@causl/sync/src/statechart-reducers.ts` accept. Reproduced here
// because the package boundary forbids `@causl/core` from importing
// from `@causl/sync`; the agreement gate in
// `packages/sync/test/properties/evaluate-statechart-agreement.property.test.ts`
// pins the same arbitraries against the canonical reducer, so the
// shape coverage stays in lockstep.
// ---------------------------------------------------------------------------

const conflictStateArb = fc.constantFrom(
  'open',
  'resolved',
  'ignored',
  'superseded',
  'unknown',
)
const conflictEventArb = fc.oneof(
  fc.record({
    kind: fc.constant('resolve' as const),
    resolution: fc.anything(),
  }),
  fc.record({ kind: fc.constant('ignore' as const) }),
  fc.record({
    kind: fc.constant('supersede' as const),
    bySupersedingId: fc.string({ minLength: 1, maxLength: 16 }),
  }),
)

const resourcePromise = Promise.resolve('handle-stand-in')
const resourceStateArb = fc.oneof(
  fc.record({ state: fc.constant('idle' as const) }),
  fc.record({
    state: fc.constant('loading' as const),
    origin: fc.integer({ min: 0, max: 1000 }),
    promise: fc.constant(resourcePromise),
  }),
  fc.record({
    state: fc.constant('loaded' as const),
    value: fc.integer(),
    origin: fc.integer({ min: 0, max: 1000 }),
    loadedAt: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({
    state: fc.constant('stale' as const),
    value: fc.integer(),
    origin: fc.integer({ min: 0, max: 1000 }),
    loadedAt: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({
    state: fc.constant('errored' as const),
    error: fc.string(),
    origin: fc.integer({ min: 0, max: 1000 }),
    erroredAt: fc.integer({ min: 0, max: 1000 }),
  }),
)
const resourceEventArb = fc.oneof(
  fc.record({
    kind: fc.constant('fetch-start' as const),
    origin: fc.integer({ min: 0, max: 1000 }),
    promise: fc.constant(resourcePromise),
  }),
  fc.record({
    kind: fc.constant('fetch-resolve' as const),
    value: fc.integer(),
    loadingAt: fc.integer({ min: 0, max: 1000 }),
    stalenessGuard: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('fetch-reject' as const),
    error: fc.string(),
  }),
  fc.record({ kind: fc.constant('invalidate' as const) }),
  fc.record({ kind: fc.constant('fail' as const), error: fc.string() }),
)

const timeArb = fc.integer({ min: 0, max: 1_000_000 })
const idArb = fc.string({ minLength: 1, maxLength: 16 })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectBackendIsPhase1(
  engine: BackendEngine,
): asserts engine is BackendEngine & {
  __evalCountersForTests(): {
    readonly evalDelegateCount: number
    readonly syntheticFallbackCount: number
  }
} {
  if (!__isPhase1WasmBackendForTests(engine)) {
    throw new Error(
      'evaluate-statechart-no-fallback: expected a Phase-1 WasmBackend; the ' +
        'no-fallback gate only applies to the in-process JS-wrapped backend.',
    )
  }
}

// ---------------------------------------------------------------------------
// ConflictRegistry — JsBackend ↔ WasmBackend byte-identity + zero
// synthetic-forbidden fallback invocations.
// ---------------------------------------------------------------------------

describe('SPEC §6 evaluateStatechart no-fallback (ConflictRegistry, issue #1122)', () => {
  it('JsBackend ↔ WasmBackend byte-identity AND synthetic fallback never invoked', () => {
    const js = makeJsBackend()
    const wasm = __createWasmBackendSyncForTests(
      'evaluate-statechart-no-fallback:conflict',
    )
    expectBackendIsPhase1(wasm)

    let trials = 0
    let mismatches = 0
    fc.assert(
      fc.property(
        conflictStateArb,
        conflictEventArb,
        timeArb,
        idArb,
        (state, event, time, id) => {
          trials += 1
          const input: StatechartInput = {
            region: 'conflict',
            state,
            event,
            time,
            id,
          }
          const jsResult = js.evaluateStatechart(
            input as unknown as Parameters<
              JsBackend['evaluateStatechart']
            >[0],
          ) as unknown as StatechartResult
          const wasmResult = wasm.evaluateStatechart(input)
          // Byte-identity at the structural level — the SPEC §6
          // determinism contract issue #1068 / PR #1092 commits to.
          try {
            expect(wasmResult).toEqual(jsResult)
          } catch (err) {
            mismatches += 1
            throw err
          }
          // No fallback invoked — the legacy synthetic-forbidden tag
          // would surface as `from === '__backend-for-test-missing__'`;
          // the canonical evaluator never produces that tag.
          if (wasmResult.kind === 'forbidden') {
            expect(wasmResult.reason.from).not.toBe(
              '__backend-for-test-missing__',
            )
            expect(wasmResult.reason.to).not.toBe(
              '__backend-for-test-missing__',
            )
          }
        },
      ),
      propertyTrials('evaluateStatechart.no-fallback.conflict'),
    )

    // Trip-wire counters: after the full property run the WasmBackend
    // delegated to the canonical evaluator on every call and the
    // removed synthetic-forbidden fallback path was never entered.
    const counters = wasm.__evalCountersForTests()
    expect(counters.evalDelegateCount).toBe(trials)
    expect(counters.syntheticFallbackCount).toBe(0)
    expect(mismatches).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ResourceFleet — same shape as the conflict block, over the
// `ResourceReducerState` × `ResourceEvent` cross-product.
// ---------------------------------------------------------------------------

describe('SPEC §6 evaluateStatechart no-fallback (ResourceFleet, issue #1122)', () => {
  it('JsBackend ↔ WasmBackend byte-identity AND synthetic fallback never invoked', () => {
    const js = makeJsBackend()
    const wasm = __createWasmBackendSyncForTests(
      'evaluate-statechart-no-fallback:resource',
    )
    expectBackendIsPhase1(wasm)

    let trials = 0
    let mismatches = 0
    fc.assert(
      fc.property(
        resourceStateArb,
        resourceEventArb,
        timeArb,
        idArb,
        (state, event, time, id) => {
          trials += 1
          const input: StatechartInput = {
            region: 'resource',
            state,
            event,
            time,
            id,
          }
          const jsResult = js.evaluateStatechart(
            input as unknown as Parameters<
              JsBackend['evaluateStatechart']
            >[0],
          ) as unknown as StatechartResult
          const wasmResult = wasm.evaluateStatechart(input)
          try {
            expect(wasmResult).toEqual(jsResult)
          } catch (err) {
            mismatches += 1
            throw err
          }
          if (wasmResult.kind === 'forbidden') {
            expect(wasmResult.reason.from).not.toBe(
              '__backend-for-test-missing__',
            )
            expect(wasmResult.reason.to).not.toBe(
              '__backend-for-test-missing__',
            )
          }
        },
      ),
      propertyTrials('evaluateStatechart.no-fallback.resource'),
    )

    const counters = wasm.__evalCountersForTests()
    expect(counters.evalDelegateCount).toBe(trials)
    expect(counters.syntheticFallbackCount).toBe(0)
    expect(mismatches).toBe(0)
  })
})
