/**
 * @packageDocumentation
 *
 * EPIC #290 sub-issue #213 — JUMP / IMPORT_STATE / ROLLBACK must be
 * implemented as historical reads (`graph.snapshotAt(t)`), not as
 * mutations (`graph.hydrate`). The engine's denotational rule —
 * "a transaction creates exactly one new `t`; outside a commit the
 * graph is read-only" — leaves no legal path for the panel to forge a
 * GraphTime advance, so time travel must be a read-only projection;
 * the previous shim violated that contract.
 *
 * Each handler is exercised in isolation via the extension mock; the
 * post-condition asserts:
 *   1. `graph.now` is unchanged (no GraphTime advance).
 *   2. Per-node observers do NOT fire on the live graph (the engine
 *      isn't mutated).
 *   3. The panel receives a re-init with the historical projection
 *      (so the time-travel UX still terminates with the panel state
 *      anchored to the requested moment).
 */

import { createCausl } from '@causljs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDevtools } from '../src/index.js'

interface MockConn {
  init: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  emit?: (msg: unknown) => void
}

function installExt(): MockConn {
  const conn: MockConn = {
    init: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn((listener) => {
      conn.emit = listener
      return () => undefined
    }),
    unsubscribe: vi.fn(),
  }
  ;(globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown }).__REDUX_DEVTOOLS_EXTENSION__ =
    {
      connect: vi.fn(() => conn),
    }
  return conn
}

describe('devtools-bridge time travel via readAt (#213)', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  /**
   * JUMP_TO_STATE re-renders the panel via `conn.init` with a
   * historical projection sourced from `graph.snapshotAt(t)`. The
   * engine is unchanged: `graph.now` stays put and a node observer
   * does not fire.
   */
  it('JUMP_TO_STATE projects via snapshotAt — no mutation, no observer fire', () => {
    const conn = installExt()
    // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped
    // `commitHistoryCap` / `snapshotRetentionCap` defaults to 0;
    // JUMP_TO_STATE projects via snapshotAt(t), which requires
    // opt-in retention.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.commit('c1', (tx) => tx.set(a, 10)) // t=1, a=10
    g.commit('c2', (tx) => tx.set(a, 20)) // t=2, a=20
    const beforeNow = g.now
    const beforeA = g.read(a)
    const observer = vi.fn()
    g.subscribe(a, observer)
    observer.mockClear() // discard the subscribe-time emit

    connectDevtools(g)
    conn.init.mockClear()

    // Panel asks to jump to t=1.
    conn.emit?.({
      type: 'DISPATCH',
      payload: { type: 'JUMP_TO_STATE' },
      state: JSON.stringify({ schema: 1, time: 1, inputs: { a: 10 } }),
    })

    // Engine is unchanged.
    expect(g.now).toBe(beforeNow)
    expect(g.read(a)).toBe(beforeA)
    expect(observer).not.toHaveBeenCalled()
    // Panel was informed of the historical projection.
    expect(conn.init).toHaveBeenCalled()
    const arg = conn.init.mock.calls[conn.init.mock.calls.length - 1]![0] as {
      time: number
      inputs: Record<string, unknown>
    }
    expect(arg.time).toBe(1)
    expect(arg.inputs.a).toBe(10)
  })

  /**
   * ROLLBACK projects at the bridge's baseline GraphTime. Without a
   * preceding `COMMIT` message the baseline is the connection moment.
   */
  it('ROLLBACK projects at the baseline time without mutating the engine', () => {
    const conn = installExt()
    // Explicit cap: SPEC §5.1 Amendment 2 (#716) — see JUMP_TO_STATE.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.commit('c1', (tx) => tx.set(a, 7))
    connectDevtools(g)
    const baselineNow = g.now
    g.commit('c2', (tx) => tx.set(a, 99)) // post-baseline mutation

    const observer = vi.fn()
    g.subscribe(a, observer)
    observer.mockClear()
    conn.init.mockClear()

    conn.emit?.({ type: 'DISPATCH', payload: { type: 'ROLLBACK' } })

    expect(g.now).toBeGreaterThan(baselineNow) // c2 advanced; rollback did not retreat
    expect(g.read(a)).toBe(99) // engine still at present
    expect(observer).not.toHaveBeenCalled()
    expect(conn.init).toHaveBeenCalled()
    const arg = conn.init.mock.calls[conn.init.mock.calls.length - 1]![0] as {
      time: number
    }
    expect(arg.time).toBe(baselineNow)
  })

  /**
   * IMPORT_STATE projects each requested historical state via
   * snapshotAt and re-inits the panel without hydrating the engine.
   */
  it('IMPORT_STATE projects via snapshotAt and does not hydrate', () => {
    const conn = installExt()
    const g = createCausl()
    const a = g.input('a', 0)
    g.commit('c1', (tx) => tx.set(a, 1))
    g.commit('c2', (tx) => tx.set(a, 2))
    connectDevtools(g)
    conn.init.mockClear()
    const beforeNow = g.now
    const observer = vi.fn()
    g.subscribe(a, observer)
    observer.mockClear()

    conn.emit?.({
      type: 'DISPATCH',
      payload: {
        type: 'IMPORT_STATE',
        nextLiftedState: {
          computedStates: [{ state: { schema: 1, time: 1, inputs: { a: 1 } } }],
        },
      },
    })

    expect(g.now).toBe(beforeNow)
    expect(observer).not.toHaveBeenCalled()
    expect(conn.init).toHaveBeenCalled()
  })

  /**
   * When the requested historical time falls outside the retention
   * window, the bridge surfaces the `evicted` branch as a no-op (no
   * panel re-init, no engine mutation) rather than fabricating state.
   */
  it('JUMP for an evicted GraphTime is a no-op', () => {
    const conn = installExt()
    // Explicit `commitHistoryCap` because SPEC §5.1 Amendment 2
    // (#716) flipped both defaults to 0; a positive
    // `commitHistoryCap` is the gate that lets the
    // `snapshotRetentionCap` chain build at all (Phase F.6 runs iff
    // `commitHistoryCap > 0`).
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 2 })
    const a = g.input('a', 0)
    // Push the retention window past t=1.
    g.commit('c1', (tx) => tx.set(a, 1))
    g.commit('c2', (tx) => tx.set(a, 2))
    g.commit('c3', (tx) => tx.set(a, 3))
    g.commit('c4', (tx) => tx.set(a, 4))
    connectDevtools(g)
    conn.init.mockClear()
    const beforeNow = g.now

    conn.emit?.({
      type: 'DISPATCH',
      payload: { type: 'JUMP_TO_STATE' },
      state: JSON.stringify({ schema: 1, time: 0, inputs: { a: 0 } }),
    })

    expect(g.now).toBe(beforeNow)
    // No re-init: the bridge declines to fabricate state for evicted t.
    expect(conn.init).not.toHaveBeenCalled()
  })
})
