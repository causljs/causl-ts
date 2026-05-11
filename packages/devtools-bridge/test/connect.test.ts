import { createCausl } from '@causl/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDevtools, isExtensionAvailable } from '../src/index.js'

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

describe('connectDevtools', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  it('returns a no-op disposer when the extension is absent', () => {
    expect(isExtensionAvailable()).toBe(false)
    const g = createCausl()
    const unsub = connectDevtools(g)
    expect(typeof unsub).toBe('function')
    unsub() // should not throw
  })

  it('forwards initial state via init() when the extension is present', () => {
    const conn = installExt()
    expect(isExtensionAvailable()).toBe(true)
    const g = createCausl()
    g.input('a', 1)
    connectDevtools(g)
    expect(conn.init).toHaveBeenCalledWith(g.snapshot())
  })

  it('forwards every commit as a Redux action with intent as `type`', () => {
    const conn = installExt()
    const g = createCausl()
    const a = g.input('a', 0)
    connectDevtools(g)
    g.commit('bump', (tx) => tx.set(a, 1))
    expect(conn.send).toHaveBeenCalledTimes(1)
    const [action, state] = conn.send.mock.calls[0]!
    expect(action.type).toBe('bump')
    expect(action.payload.changedNodes).toContain('a')
    expect(state).toEqual(g.snapshot())
  })

  it('JUMP_TO_STATE projects via snapshotAt without mutating the engine (#213)', () => {
    const conn = installExt()
    const g = createCausl()
    const a = g.input('a', 0)
    g.commit('c1', (tx) => tx.set(a, 1))
    g.commit('c2', (tx) => tx.set(a, 2))
    connectDevtools(g)
    const beforeNow = g.now
    const beforeA = g.read(a)
    conn.init.mockClear()
    conn.emit?.({
      type: 'DISPATCH',
      payload: { type: 'JUMP_TO_STATE' },
      state: JSON.stringify({ schema: 1, time: 1, inputs: { a: 1 } }),
    })
    // Engine unchanged; the bridge only re-displays history to the panel.
    expect(g.now).toBe(beforeNow)
    expect(g.read(a)).toBe(beforeA)
    expect(conn.init).toHaveBeenCalled()
  })

  it('disposer cleans up commit + extension subscriptions', () => {
    const conn = installExt()
    const g = createCausl()
    g.input('a', 0)
    const dispose = connectDevtools(g)
    dispose()
    expect(conn.unsubscribe).toHaveBeenCalled()
  })
})
