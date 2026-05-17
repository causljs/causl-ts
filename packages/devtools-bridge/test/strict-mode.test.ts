/**
 * @packageDocumentation
 *
 * EPIC #290 sub-issue #238 — `connectDevtools` and its disposer must
 * be idempotent across React 18/19 StrictMode mount/unmount/mount
 * cycles. Without this, the second `connect()` in the same effect
 * cycle double-inits the panel and double-subscribes to commits, and
 * the disposer's `conn.unsubscribe()` is called twice.
 *
 * Two patterns are exercised:
 *   1. **Concurrent double-mount**: `d1 = connect(g); d2 = connect(g)` —
 *      panel sees a single init, commits forward once per write,
 *      `conn.unsubscribe()` is called exactly once after both
 *      disposers have run.
 *   2. **StrictMode mount/unmount/mount**: `d = connect(g); d(); d2 =
 *      connect(g); d2()` — each cycle is a fresh connection with one
 *      init and one cleanup; calling each disposer a second time is
 *      a no-op.
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

describe('connectDevtools StrictMode idempotence (#238)', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  /**
   * Concurrent double-mount: two live disposers exist at once. The
   * extension panel must see exactly one connection and one init
   * payload; commits forward once.
   */
  it('concurrent double-connect shares a single connection', () => {
    const { ext, conns } = installExt()
    const g = createCausl()
    const a = g.input('a', 0)
    const d1 = connectDevtools(g)
    const d2 = connectDevtools(g)
    // One ext.connect, one panel init, one subscribe.
    expect(ext.connect).toHaveBeenCalledTimes(1)
    expect(conns.length).toBe(1)
    expect(conns[0]!.init).toHaveBeenCalledTimes(1)
    // A commit fires conn.send once, not twice.
    g.commit('c1', (tx) => tx.set(a, 1))
    expect(conns[0]!.send).toHaveBeenCalledTimes(1)
    // Disposing one half does not tear down the panel.
    d1()
    expect(conns[0]!.unsubscribe).not.toHaveBeenCalled()
    g.commit('c2', (tx) => tx.set(a, 2))
    expect(conns[0]!.send).toHaveBeenCalledTimes(2)
    // Disposing the second half flushes the connection.
    d2()
    expect(conns[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    // Post-cleanup commits are silent.
    g.commit('c3', (tx) => tx.set(a, 3))
    expect(conns[0]!.send).toHaveBeenCalledTimes(2)
  })

  /**
   * StrictMode pattern: mount → unmount → mount. Each cycle is a
   * separate connection (the first was disposed). Disposers are
   * idempotent — calling each one twice is a no-op for the second
   * call.
   */
  it('mount/unmount/mount produces a fresh connection per active mount', () => {
    const { ext, conns } = installExt()
    const g = createCausl()
    g.input('a', 0)
    const d1 = connectDevtools(g)
    expect(ext.connect).toHaveBeenCalledTimes(1)
    d1()
    d1() // idempotent — second call is a no-op
    expect(conns[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    const d2 = connectDevtools(g)
    expect(ext.connect).toHaveBeenCalledTimes(2)
    expect(conns.length).toBe(2)
    expect(conns[1]!.init).toHaveBeenCalledTimes(1)
    d2()
    d2() // idempotent
    expect(conns[1]!.unsubscribe).toHaveBeenCalledTimes(1)
  })

  /**
   * Different graphs get independent connections — the WeakMap keys
   * by graph identity, not by package state.
   */
  it('separate graphs get separate connections', () => {
    const { ext } = installExt()
    const g1 = createCausl()
    const g2 = createCausl()
    const d1 = connectDevtools(g1)
    const d2 = connectDevtools(g2)
    expect(ext.connect).toHaveBeenCalledTimes(2)
    d1()
    d2()
  })
})
