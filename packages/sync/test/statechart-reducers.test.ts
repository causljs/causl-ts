/**
 * @packageDocumentation
 *
 * Unit + property tests for the pure statechart reducers carved out
 * in #698 (`packages/sync/src/statechart-reducers.ts`). The reducers
 * are the SPEC §6 ConflictRegistry and ResourceFleet decision logic
 * lifted out of the engine adapter — the migration target for the
 * future Rust port (EPIC #680). These tests pin the reducer's
 * surface independent of the wiring shells in `./conflict.ts` and
 * `./resource.ts`, which is the property #698's exit criterion
 * names: the reducer's contract is testable without the engine in
 * the loop.
 *
 * Tests below cover:
 *
 * - Every chart-named legal edge in both regions (assertion on the
 *   `ok` arm and the produced state).
 * - Every chart-rejected edge (assertion on the `forbidden` arm and
 *   the carried `(region, from, to, id)` metadata).
 * - Determinism: calling each reducer twice with the same inputs
 *   produces structurally-equal outputs. This is the byte-identity
 *   property #698 names for the future Rust port; the TS reducer is
 *   the oracle the eventual Rust implementation must match.
 *
 * @see issue #698 — extract pure statechart reducers.
 * @see SPEC.md §6 — Composite statechart, ConflictRegistry and
 *   ResourceFleet regions.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { propertyTrials } from '@causl/core-testing-internal'
import {
  reduceConflict,
  reduceResource,
  type ConflictEvent,
  type ConflictReducerState,
  type ResourceEvent,
  type ResourceReducerState,
} from '../src/statechart-reducers.js'

// ---------------------------------------------------------------------------
// ConflictRegistry reducer
// ---------------------------------------------------------------------------

describe('reduceConflict (SPEC §6 ConflictRegistry region)', () => {
  describe('legal edges out of Open', () => {
    it('Open → Resolved carries the resolution payload and time', () => {
      const r = reduceConflict('open', { kind: 'resolve', resolution: { c: 1 } }, 42, 'conflict:a')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ kind: 'resolved', value: { c: 1 }, at: 42 })
    })

    it('Open → Ignored carries the time', () => {
      const r = reduceConflict('open', { kind: 'ignore' }, 7, 'conflict:b')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ kind: 'ignored', at: 7 })
    })

    it('Open → Superseded carries the linkage and the time', () => {
      const r = reduceConflict(
        'open',
        { kind: 'supersede', bySupersedingId: 'conflict:other' },
        9,
        'conflict:c',
      )
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({
        kind: 'superseded',
        bySupersedingId: 'conflict:other',
        at: 9,
      })
    })
  })

  describe('rejected edges — every non-Open source', () => {
    const terminals: ConflictReducerState[] = ['resolved', 'ignored', 'superseded', 'unknown']
    const events: ReadonlyArray<{ event: ConflictEvent; to: string }> = [
      { event: { kind: 'resolve', resolution: 'x' }, to: 'resolved' },
      { event: { kind: 'ignore' }, to: 'ignored' },
      { event: { kind: 'supersede', bySupersedingId: 'conflict:other' }, to: 'superseded' },
    ]

    for (const from of terminals) {
      for (const { event, to } of events) {
        it(`rejects ${event.kind}() from ${from} with ForbiddenTransition(conflict, ${from} → ${to})`, () => {
          const r = reduceConflict(from, event, 1, 'conflict:x')
          expect(r.kind).toBe('forbidden')
          if (r.kind !== 'forbidden') return
          expect(r.reason).toEqual({ region: 'conflict', from, to, id: 'conflict:x' })
        })
      }
    }
  })

  describe('determinism — repeated calls return structurally-equal results', () => {
    it('calling reduceConflict twice with the same args returns deep-equal results', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<ConflictReducerState>('open', 'resolved', 'ignored', 'superseded', 'unknown'),
          fc.oneof(
            fc.record({ kind: fc.constant('resolve' as const), resolution: fc.anything() }),
            fc.record({ kind: fc.constant('ignore' as const) }),
            fc.record({
              kind: fc.constant('supersede' as const),
              bySupersedingId: fc.string({ minLength: 1, maxLength: 16 }),
            }),
          ),
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.string({ minLength: 1, maxLength: 16 }),
          (state, event, time, id) => {
            const a = reduceConflict(state, event as ConflictEvent, time, id)
            const b = reduceConflict(state, event as ConflictEvent, time, id)
            // Structural equality is the contract: same kind, same
            // payload. Object identity is NOT promised — the future
            // Rust port allocates fresh structs per call, and we want
            // the TS oracle to match that.
            expect(a).toEqual(b)
          },
        ),
        propertyTrials('reduceConflict.deterministic'),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// ResourceFleet reducer
// ---------------------------------------------------------------------------

describe('reduceResource (SPEC §6 ResourceFleet region)', () => {
  const idle: ResourceReducerState<number> = { state: 'idle' }
  const loading = (origin = 0): ResourceReducerState<number> => ({
    state: 'loading',
    origin,
    promise: Promise.resolve(undefined),
  })
  const loaded = (value: number): ResourceReducerState<number> => ({
    state: 'loaded',
    value,
    origin: 0,
    loadedAt: 1,
  })
  const stale = (value: number): ResourceReducerState<number> => ({
    state: 'stale',
    value,
    origin: 0,
    loadedAt: 1,
  })
  const errored: ResourceReducerState<number> = {
    state: 'errored',
    error: new Error('e'),
    origin: 0,
    erroredAt: 1,
  }

  describe('legal edges — fetch-start is unconditional', () => {
    const all: ReadonlyArray<[string, ResourceReducerState<number>]> = [
      ['idle', idle],
      ['loading', loading()],
      ['loaded', loaded(42)],
      ['stale', stale(42)],
      ['errored', errored],
    ]
    for (const [name, state] of all) {
      it(`* → Loading is legal from ${name}`, () => {
        const promise = Promise.resolve(undefined)
        const r = reduceResource(state, { kind: 'fetch-start', origin: 5, promise }, 5, 'r')
        expect(r.kind).toBe('ok')
        if (r.kind !== 'ok') return
        expect(r.next).toEqual({ state: 'loading', origin: 5, promise })
      })
    }
  })

  describe('legal edges — fetch-resolve from Loading', () => {
    it('Loading → Loaded when no staleness was observed', () => {
      const r = reduceResource(
        loading(0),
        { kind: 'fetch-resolve', value: 7, loadingAt: 1, stalenessGuard: true },
        1,
        'r',
      )
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'loaded', value: 7, origin: 0, loadedAt: 1 })
    })

    it('Loading → Stale when GraphTime advanced past loadingAt with the guard on', () => {
      const r = reduceResource(
        loading(0),
        { kind: 'fetch-resolve', value: 7, loadingAt: 1, stalenessGuard: true },
        5,
        'r',
      )
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'stale', value: 7, origin: 0, loadedAt: 5 })
    })

    it('Loading → Loaded when staleness guard is OFF (last-writer-wins)', () => {
      const r = reduceResource(
        loading(0),
        { kind: 'fetch-resolve', value: 7, loadingAt: 1, stalenessGuard: false },
        5,
        'r',
      )
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'loaded', value: 7, origin: 0, loadedAt: 5 })
    })
  })

  describe('legal edges — fetch-reject and fail', () => {
    it('Loading → Errored via fetch-reject', () => {
      const err = new Error('boom')
      const r = reduceResource(loading(0), { kind: 'fetch-reject', error: err }, 2, 'r')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'errored', error: err, origin: 0, erroredAt: 2 })
    })

    it('Loading → Errored via fail() preserves origin', () => {
      const err = new Error('boom')
      const r = reduceResource(loading(0), { kind: 'fail', error: err }, 2, 'r')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'errored', error: err, origin: 0, erroredAt: 2 })
    })

    it('Loaded → Errored via fail() preserves origin', () => {
      const err = new Error('boom')
      const r = reduceResource(loaded(7), { kind: 'fail', error: err }, 3, 'r')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'errored', error: err, origin: 0, erroredAt: 3 })
    })
  })

  describe('chart-named no-op — invalidate from non-Loaded', () => {
    it('invalidate on Loaded → Stale', () => {
      const r = reduceResource(loaded(7), { kind: 'invalidate' }, 9, 'r')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      expect(r.next).toEqual({ state: 'stale', value: 7, origin: 0, loadedAt: 1 })
    })

    it.each([
      ['idle', idle],
      ['loading', loading()],
      ['stale', stale(7)],
      ['errored', errored],
    ] as const)('invalidate on %s is a no-op (next === state, shell skips commit)', (_, state) => {
      const r = reduceResource(state, { kind: 'invalidate' }, 9, 'r')
      expect(r.kind).toBe('ok')
      if (r.kind !== 'ok') return
      // Reference equality is intentional — the shell uses `next ===
      // current` to skip the commit and avoid advancing GraphTime.
      expect(r.next).toBe(state)
    })
  })

  describe('rejected edges — every chart-illegal source', () => {
    it.each([
      ['idle', idle],
      ['loaded', loaded(7)],
      ['stale', stale(7)],
      ['errored', errored],
    ] as const)('fetch-resolve from %s is forbidden', (name, state) => {
      const r = reduceResource(
        state,
        { kind: 'fetch-resolve', value: 1, loadingAt: 0, stalenessGuard: true },
        1,
        'r',
      )
      expect(r.kind).toBe('forbidden')
      if (r.kind !== 'forbidden') return
      expect(r.reason).toEqual({ region: 'resource', from: name, to: 'loaded', id: 'r' })
    })

    it.each([
      ['idle', idle],
      ['loaded', loaded(7)],
      ['stale', stale(7)],
      ['errored', errored],
    ] as const)('fetch-reject from %s is forbidden', (name, state) => {
      const r = reduceResource(state, { kind: 'fetch-reject', error: new Error('x') }, 1, 'r')
      expect(r.kind).toBe('forbidden')
      if (r.kind !== 'forbidden') return
      expect(r.reason).toEqual({ region: 'resource', from: name, to: 'errored', id: 'r' })
    })

    it.each([
      ['idle', idle],
      ['stale', stale(7)],
      ['errored', errored],
    ] as const)('fail from %s is forbidden', (name, state) => {
      const r = reduceResource(state, { kind: 'fail', error: new Error('x') }, 1, 'r')
      expect(r.kind).toBe('forbidden')
      if (r.kind !== 'forbidden') return
      expect(r.reason).toEqual({ region: 'resource', from: name, to: 'errored', id: 'r' })
    })
  })

  describe('determinism — repeated calls return structurally-equal results', () => {
    it('calling reduceResource twice with the same args returns deep-equal results', () => {
      // Use a fixed Promise instance so structural-equality assertions
      // don't fail on Promise identity inside `loading`-arm states.
      const promise = Promise.resolve(undefined)
      const stateArb = fc.oneof(
        fc.constant<ResourceReducerState<number>>({ state: 'idle' }),
        fc.record({
          state: fc.constant('loading' as const),
          origin: fc.integer({ min: 0, max: 1000 }),
          promise: fc.constant(promise),
        }),
        fc.record({
          state: fc.constant('loaded' as const),
          value: fc.integer(),
          origin: fc.integer({ min: 0, max: 1000 }),
          loadedAt: fc.integer({ min: 0, max: 1000 }),
        }),
      )
      const eventArb = fc.oneof(
        fc.record({
          kind: fc.constant('fetch-start' as const),
          origin: fc.integer({ min: 0, max: 1000 }),
          promise: fc.constant(promise),
        }),
        fc.record({
          kind: fc.constant('fetch-resolve' as const),
          value: fc.integer(),
          loadingAt: fc.integer({ min: 0, max: 1000 }),
          stalenessGuard: fc.boolean(),
        }),
        fc.record({ kind: fc.constant('fetch-reject' as const), error: fc.string() }),
        fc.record({ kind: fc.constant('invalidate' as const) }),
        fc.record({ kind: fc.constant('fail' as const), error: fc.string() }),
      )

      fc.assert(
        fc.property(
          stateArb,
          eventArb,
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.string({ minLength: 1, maxLength: 16 }),
          (state, event, time, id) => {
            const a = reduceResource(state, event as ResourceEvent, time, id)
            const b = reduceResource(state, event as ResourceEvent, time, id)
            expect(a).toEqual(b)
          },
        ),
        propertyTrials('reduceResource.deterministic'),
      )
    })
  })
})
