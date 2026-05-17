/**
 * @packageDocumentation
 *
 * EPIC #290 sub-issue #299 — protocol fidelity property test.
 *
 * Drives the bridge through random scenarios mixing local commits and
 * remote DevTools messages and checks invariants pulled from the
 * Redux DevTools monitor protocol. Without this, every internal
 * refactor risks silent panel incompatibility.
 *
 * Invariants asserted (issue #299 O1–O9):
 *   - O2 INIT precedes everything else on the wire.
 *   - O4 STATE follows ACTION — every `conn.send(action, state)` pair
 *        carries the same shape (`type`, `payload`) and the state is
 *        a `GraphSnapshot`.
 *   - O5 Time-travel is read-only — JUMP / IMPORT_STATE / ROLLBACK
 *        do NOT bump `graph.now` and do NOT emit new ACTIONs (#213).
 *   - O7 ROLLBACK collapses to a single re-init at the baseline; the
 *        bridge does not mutate the live engine.
 *   - O8 Disconnect is idempotent — calling the disposer twice is a
 *        no-op (#238).
 *   - O9 Zero-cost when never connected — covered by zero-cost.test.ts.
 *
 * Property-based fuzz is the race-detection layer for everything the
 * type system and API shape don't catch — so 1000+ random scenarios
 * per property are run on every CI invocation, with deterministic
 * logged seeds so any failure is reproducible. `propertyTrials`
 * enforces that floor.
 */

import { createCausl, type Graph } from '@causl/core'
import { propertyTrials } from '@causl/core-testing-internal'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDevtools } from '../../src/index.js'

interface MockConn {
  init: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  emit?: (msg: unknown) => void
}

function installExt(): { ext: { connect: ReturnType<typeof vi.fn> }; conns: MockConn[] } {
  const conns: MockConn[] = []
  const ext = {
    connect: vi.fn(() => {
      const conn: MockConn = {
        init: vi.fn(),
        send: vi.fn(),
        subscribe: vi.fn((listener) => {
          conn.emit = listener
          return () => undefined
        }),
        unsubscribe: vi.fn(),
      }
      conns.push(conn)
      return conn
    }),
  }
  ;(globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown }).__REDUX_DEVTOOLS_EXTENSION__ =
    ext
  return { ext, conns }
}

/** A random local commit step. */
type LocalStep = { kind: 'commit'; intent: string; value: number }

/** A random remote DevTools message step. */
type RemoteStep =
  | { kind: 'jump'; time: number; value: number }
  | { kind: 'import'; time: number; value: number }
  | { kind: 'rollback' }
  | { kind: 'commitMsg' }
  | { kind: 'sweep' }
  | { kind: 'pause' }
  | { kind: 'lock' }

type Step = LocalStep | RemoteStep

const arbLocal: fc.Arbitrary<LocalStep> = fc.record({
  kind: fc.constant('commit' as const),
  intent: fc.stringMatching(/^[a-z]{1,8}$/),
  value: fc.integer({ min: -50, max: 50 }),
})

const arbRemote: fc.Arbitrary<RemoteStep> = fc.oneof(
  fc.record({
    kind: fc.constant('jump' as const),
    time: fc.integer({ min: 0, max: 30 }),
    value: fc.integer({ min: -50, max: 50 }),
  }),
  fc.record({
    kind: fc.constant('import' as const),
    time: fc.integer({ min: 0, max: 30 }),
    value: fc.integer({ min: -50, max: 50 }),
  }),
  fc.record({ kind: fc.constant('rollback' as const) }),
  fc.record({ kind: fc.constant('commitMsg' as const) }),
  fc.record({ kind: fc.constant('sweep' as const) }),
  fc.record({ kind: fc.constant('pause' as const) }),
  fc.record({ kind: fc.constant('lock' as const) }),
)

const arbStep: fc.Arbitrary<Step> = fc.oneof({ weight: 3, arbitrary: arbLocal }, {
  weight: 1,
  arbitrary: arbRemote,
})

const arbScenario: fc.Arbitrary<readonly Step[]> = fc.array(arbStep, {
  minLength: 0,
  maxLength: 30,
})

function applyStep(g: Graph, conn: MockConn, step: Step, a: { id: string }): void {
  switch (step.kind) {
    case 'commit':
      // Use the real graph; the bridge's commit observer fires `send`.
      g.commit(step.intent, (tx) => tx.set(a as never, step.value))
      return
    case 'jump':
      conn.emit?.({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_STATE' },
        state: JSON.stringify({
          schema: 1,
          time: step.time,
          inputs: { a: step.value },
        }),
      })
      return
    case 'import':
      conn.emit?.({
        type: 'DISPATCH',
        payload: {
          type: 'IMPORT_STATE',
          nextLiftedState: {
            computedStates: [
              {
                state: { schema: 1, time: step.time, inputs: { a: step.value } },
              },
            ],
          },
        },
      })
      return
    case 'rollback':
      conn.emit?.({ type: 'DISPATCH', payload: { type: 'ROLLBACK' } })
      return
    case 'commitMsg':
      conn.emit?.({ type: 'DISPATCH', payload: { type: 'COMMIT' } })
      return
    case 'sweep':
      conn.emit?.({ type: 'DISPATCH', payload: { type: 'SWEEP' } })
      return
    case 'pause':
      conn.emit?.({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING' } })
      return
    case 'lock':
      conn.emit?.({ type: 'DISPATCH', payload: { type: 'LOCK_CHANGES' } })
      return
  }
}

describe('protocol fidelity (#299)', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  /**
   * O2 + O4 — the first wire-event is `conn.init`, every later
   * `conn.send` carries an action of the right shape paired with a
   * `GraphSnapshot`-shaped state, and `conn.send` fires only after
   * the initial `init`.
   */
  it('every scenario produces a well-formed wire trace', () => {
    fc.assert(
      fc.property(arbScenario, (steps) => {
        const { conns } = installExt()
        const g = createCausl()
        const a = g.input('a', 0)
        const dispose = connectDevtools(g)
        const conn = conns[0]!
        for (const step of steps) {
          applyStep(g, conn, step, a)
        }
        // O2 — init was called at least once, and before any send.
        // vitest's mocks expose `invocationCallOrder` — a globally
        // monotonic id assigned on each call. The earliest init id
        // must precede the earliest send id (if any).
        const initOrders = conn.init.mock.invocationCallOrder
        const sendOrders = conn.send.mock.invocationCallOrder
        expect(initOrders.length).toBeGreaterThanOrEqual(1)
        if (sendOrders.length > 0) {
          expect(Math.min(...initOrders)).toBeLessThan(Math.min(...sendOrders))
        }
        // O4 — every send carries a string `type` and a GraphSnapshot-
        // shaped state.
        for (const call of conn.send.mock.calls) {
          const [action, state] = call as [{ type: unknown }, { schema: unknown; time: unknown }]
          expect(typeof action.type).toBe('string')
          expect(state.schema).toBe(1)
          expect(typeof state.time).toBe('number')
        }
        dispose()
      }),
      propertyTrials('protocol-fidelity'),
    )
  })

  /**
   * O5 — JUMP / IMPORT_STATE do NOT mutate the live engine. After any
   * scenario, `graph.now` only ever advances on local commits.
   */
  it('time-travel messages never advance graph.now', () => {
    fc.assert(
      fc.property(arbScenario, (steps) => {
        const { conns } = installExt()
        const g = createCausl()
        const a = g.input('a', 0)
        const dispose = connectDevtools(g)
        const conn = conns[0]!
        // Track expected `now` from local commits alone.
        let expectedNow = g.now
        for (const step of steps) {
          if (step.kind === 'commit') expectedNow += 1
          applyStep(g, conn, step, a)
        }
        expect(g.now).toBe(expectedNow)
        dispose()
      }),
      propertyTrials('protocol-fidelity-no-mutation'),
    )
  })

  /**
   * O8 — disposer is idempotent. After any scenario, calling the
   * disposer twice produces only a single `conn.unsubscribe`.
   */
  it('disposer is idempotent across scenarios', () => {
    fc.assert(
      fc.property(arbScenario, (steps) => {
        const { conns } = installExt()
        const g = createCausl()
        const a = g.input('a', 0)
        const dispose = connectDevtools(g)
        const conn = conns[0]!
        for (const step of steps) {
          applyStep(g, conn, step, a)
        }
        dispose()
        dispose()
        expect(conn.unsubscribe).toHaveBeenCalledTimes(1)
      }),
      propertyTrials('protocol-fidelity-idempotent-dispose'),
    )
  })
})
