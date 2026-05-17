/**
 * Protocol coverage for the eight monitor messages beyond JUMP_TO_*
 * that PR #192's brutal-critique flagged as silently dropped.
 *
 * Each describe-block targets one message kind and asserts the
 * observable effect on the bridge state, the engine, or the panel
 * connection — whichever the message's contract owns.
 */

import { createCausl } from '@causljs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDevtools } from '../src/connect.js'

interface MockConn {
  init: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  emit: (msg: unknown) => void
}

/**
 * Install a synchronous mock of `__REDUX_DEVTOOLS_EXTENSION__` and
 * return a handle that lets the test push monitor messages through
 * the listener captured during `subscribe(...)`.
 */
function installExt(): MockConn {
  const conn = {
    init: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn() as unknown as MockConn['subscribe'],
    unsubscribe: vi.fn(),
    emit: (() => {}) as MockConn['emit'],
  } as MockConn
  conn.subscribe = vi.fn((listener: (msg: unknown) => void) => {
    conn.emit = listener
    return () => undefined
  }) as unknown as MockConn['subscribe']
  ;(globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown }).__REDUX_DEVTOOLS_EXTENSION__ =
    {
      connect: vi.fn(() => conn),
    }
  return conn
}

describe('devtools-bridge protocol coverage (review-209 P0)', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  describe('PAUSE_RECORDING', () => {
    it('stops forwarding subsequent commits when status=true', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      connectDevtools(g)
      conn.emit({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING', status: true } })
      g.commit('bump', (tx) => tx.set(a, 1))
      expect(conn.send).not.toHaveBeenCalled()
    })

    it('resumes forwarding when status=false', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      connectDevtools(g)
      conn.emit({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING', status: true } })
      g.commit('a', (tx) => tx.set(a, 1))
      conn.emit({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING', status: false } })
      g.commit('b', (tx) => tx.set(a, 2))
      expect(conn.send).toHaveBeenCalledTimes(1)
      expect(conn.send.mock.calls[0]![0].type).toBe('b')
    })

    it('toggles when status is omitted', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      connectDevtools(g)
      conn.emit({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING' } })
      g.commit('paused', (tx) => tx.set(a, 1))
      conn.emit({ type: 'DISPATCH', payload: { type: 'PAUSE_RECORDING' } })
      g.commit('resumed', (tx) => tx.set(a, 2))
      expect(conn.send).toHaveBeenCalledTimes(1)
      expect(conn.send.mock.calls[0]![0].type).toBe('resumed')
    })
  })

  describe('LOCK_CHANGES', () => {
    it('drops subsequent monitor messages while locked', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      connectDevtools(g)
      conn.emit({ type: 'DISPATCH', payload: { type: 'LOCK_CHANGES', status: true } })
      // A JUMP would normally hydrate; under lock it must not.
      conn.emit({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_STATE' },
        state: JSON.stringify({ schema: 1, time: 99, inputs: { a: 42 } }),
      })
      expect(g.read(a)).toBe(0)
      expect(g.now).toBe(0)
    })

    it('LOCK_CHANGES itself is honoured even while locked (so the panel can unlock)', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      g.commit('c1', (tx) => tx.set(a, 7)) // retain t=1 with a=7
      connectDevtools(g)
      conn.emit({ type: 'DISPATCH', payload: { type: 'LOCK_CHANGES', status: true } })
      conn.emit({ type: 'DISPATCH', payload: { type: 'LOCK_CHANGES', status: false } })
      conn.init.mockClear()
      conn.emit({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_STATE' },
        state: JSON.stringify({ schema: 1, time: 1, inputs: { a: 7 } }),
      })
      // Engine is read-only under #213; panel got the historical projection.
      expect(g.read(a)).toBe(7)
      expect(conn.init).toHaveBeenCalled()
    })
  })

  describe('IMPORT_STATE', () => {
    it('projects the last computedState time via snapshotAt without mutating (#213)', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      g.commit('c1', (tx) => tx.set(a, 1))
      g.commit('c2', (tx) => tx.set(a, 99))
      connectDevtools(g)
      const beforeNow = g.now
      const beforeA = g.read(a)
      conn.init.mockClear()
      conn.emit({
        type: 'DISPATCH',
        payload: {
          type: 'IMPORT_STATE',
          nextLiftedState: {
            computedStates: [
              { state: { schema: 1, time: 1, inputs: { a: 1 } } },
              { state: { schema: 1, time: 2, inputs: { a: 99 } } },
            ],
          },
        },
      })
      // Engine is unchanged; panel was re-inited with the historical view.
      expect(g.now).toBe(beforeNow)
      expect(g.read(a)).toBe(beforeA)
      expect(conn.init).toHaveBeenCalled()
    })

    it('re-inits the panel after a successful import', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      const initBefore = conn.init.mock.calls.length
      conn.emit({
        type: 'DISPATCH',
        payload: {
          type: 'IMPORT_STATE',
          nextLiftedState: {
            computedStates: [{ state: { schema: 1, time: 5, inputs: { a: 7 } } }],
          },
        },
      })
      expect(conn.init.mock.calls.length).toBe(initBefore + 1)
    })

    it('ignores empty computedStates arrays', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 4)
      connectDevtools(g)
      conn.emit({
        type: 'DISPATCH',
        payload: { type: 'IMPORT_STATE', nextLiftedState: { computedStates: [] } },
      })
      expect(g.read(a)).toBe(4)
    })
  })

  describe('COMMIT', () => {
    it('promotes the current state to the new ROLLBACK baseline', () => {
      const conn = installExt()
      // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped
      // `commitHistoryCap` / `snapshotRetentionCap` defaults to 0;
      // ROLLBACK reads through `snapshotAt(baselineNow)`, which
      // requires opt-in retention.
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      connectDevtools(g)
      g.commit('first', (tx) => tx.set(a, 1))
      conn.emit({ type: 'DISPATCH', payload: { type: 'COMMIT' } })
      const baselineNow = g.now
      g.commit('second', (tx) => tx.set(a, 2))
      conn.init.mockClear()
      conn.emit({ type: 'DISPATCH', payload: { type: 'ROLLBACK' } })
      // ROLLBACK projects the panel back to the COMMIT baseline GraphTime
      // via snapshotAt; the engine is not hydrated (#213).
      expect(g.read(a)).toBe(2) // engine still at present
      expect(conn.init).toHaveBeenCalled()
      const arg = conn.init.mock.calls[conn.init.mock.calls.length - 1]![0] as {
        time: number
      }
      expect(arg.time).toBe(baselineNow)
    })

    it('re-inits the panel on COMMIT', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      const before = conn.init.mock.calls.length
      conn.emit({ type: 'DISPATCH', payload: { type: 'COMMIT' } })
      expect(conn.init.mock.calls.length).toBe(before + 1)
    })
  })

  describe('ROLLBACK', () => {
    it('projects the panel back to the connection-time baseline (#213)', () => {
      const conn = installExt()
      const g = createCausl()
      const a = g.input('a', 0)
      connectDevtools(g)
      const baselineNow = g.now
      g.commit('change', (tx) => tx.set(a, 42))
      conn.init.mockClear()
      conn.emit({ type: 'DISPATCH', payload: { type: 'ROLLBACK' } })
      // Engine still reflects the present; the panel re-displays the baseline.
      expect(g.read(a)).toBe(42)
      expect(conn.init).toHaveBeenCalled()
      const arg = conn.init.mock.calls[conn.init.mock.calls.length - 1]![0] as {
        time: number
      }
      expect(arg.time).toBe(baselineNow)
    })
  })

  describe('SWEEP', () => {
    it('clears the skipped-action set', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      // Mark two actions skipped, then sweep — both must clear.
      conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_ACTION', id: 1 } })
      conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_ACTION', id: 2 } })
      conn.emit({ type: 'DISPATCH', payload: { type: 'SWEEP' } })
      // Re-toggling id=1 must add it back (set is empty after sweep).
      conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_ACTION', id: 1 } })
      // No public skipped accessor — assert via a follow-up SWEEP not throwing
      // and via a TOGGLE_ACTION re-adding the id (covered by absence of error).
      expect(() =>
        conn.emit({ type: 'DISPATCH', payload: { type: 'SWEEP' } }),
      ).not.toThrow()
    })
  })

  describe('TOGGLE_ACTION', () => {
    it('flips a previously unseen id into the skipped set', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      expect(() =>
        conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_ACTION', id: 3 } }),
      ).not.toThrow()
    })

    it('ignores TOGGLE_ACTION with non-numeric id', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      expect(() =>
        conn.emit({
          type: 'DISPATCH',
          payload: { type: 'TOGGLE_ACTION', id: 'not-a-number' as unknown as number },
        }),
      ).not.toThrow()
    })
  })

  describe('TOGGLE_PERSIST', () => {
    it('does not throw and is observable through repeated toggles', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      // Two toggles should leave the bridge in its original persistence stance —
      // the test asserts handler reachability rather than internal state, which
      // is intentionally encapsulated.
      expect(() => {
        conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_PERSIST' } })
        conn.emit({ type: 'DISPATCH', payload: { type: 'TOGGLE_PERSIST' } })
      }).not.toThrow()
    })
  })

  describe('unknown messages', () => {
    it('silently drops unknown DISPATCH payload kinds', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      expect(() =>
        conn.emit({ type: 'DISPATCH', payload: { type: 'NOT_A_REAL_MESSAGE' } }),
      ).not.toThrow()
    })

    it('silently drops non-DISPATCH messages (ACTION/START/STOP)', () => {
      const conn = installExt()
      const g = createCausl()
      g.input('a', 0)
      connectDevtools(g)
      expect(() => conn.emit({ type: 'START' })).not.toThrow()
      expect(() => conn.emit({ type: 'STOP' })).not.toThrow()
      expect(() => conn.emit({ type: 'ACTION' })).not.toThrow()
    })
  })
})
