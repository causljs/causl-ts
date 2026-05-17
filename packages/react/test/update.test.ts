/**
 * @packageDocumentation
 *
 * Tests for the MVU-shaped `Update<Msg, Graph>` runner. Application
 * developers don't think "I will mutate `cell:wb1:Sheet1:A1`"; they
 * think "the user clicked Save." `tx.set(node, value)` is a write
 * API, not a thinking API — so I put an MVU-shaped front door on
 * the engine: transactions are the engine room, messages are the
 * front door, and the `Msg` discriminated union is what the type
 * system enforces.
 *
 * Covers `createUpdate` (build a kind-dispatching reducer keyed by
 * the `Msg` discriminator) and `runMessages` (sequence a list of
 * messages into committed graph states). Also asserts an unhandled
 * `kind` produces a descriptive runtime error so missing handlers
 * fail loudly rather than silently no-opping.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { createUpdate, runMessages, type Update } from '../src/index.js'

/**
 * Discriminated union driving the counter examples below. Each test
 * narrows on the `kind` field so handlers receive the appropriate
 * payload type.
 */
type CounterMsg =
  | { kind: 'increment' }
  | { kind: 'decrement' }
  | { kind: 'set'; value: number }

/**
 * Suite covering the MVU-shaped `Update<Msg, Graph>` runner — both
 * direct dispatch via `createUpdate` and bulk sequencing via
 * `runMessages`, plus the unhandled-kind error path. The shape mirrors
 * the application surface: messages in, side-effecting commit out,
 * with the `Msg` union as the only place "make impossible states
 * impossible" applies at the application boundary.
 */
describe('Update<Msg, Graph> runner', () => {
  /**
   * Confirms `createUpdate` constructs a function that dispatches on
   * the `kind` discriminator and advances the graph on each call. The
   * runner returns `void` — the graph handle is the same handle the
   * caller already holds, so the return value carries no information.
   */
  it('createUpdate dispatches by `kind` and advances the graph', () => {
    // Build a graph with a single counter input.
    const graph = createCausl()
    const counter = graph.input('counter', 0)
    // Construct an update reducer keyed by the `kind` discriminator.
    const update: Update<CounterMsg> = createUpdate<CounterMsg>({
      increment: (_msg, g) => {
        g.commit('inc', (tx) => tx.set(counter, g.read(counter) + 1))
      },
      decrement: (_msg, g) => {
        g.commit('dec', (tx) => tx.set(counter, g.read(counter) - 1))
      },
      set: (msg, g) => {
        g.commit('set', (tx) => tx.set(counter, msg.value))
      },
    })
    // First dispatch: route to `increment` handler.
    update({ kind: 'increment' }, graph)
    expect(graph.read(counter)).toBe(1)
    // Second dispatch: route to `set` handler with payload `42`.
    update({ kind: 'set', value: 42 }, graph)
    expect(graph.read(counter)).toBe(42)
  })

  /**
   * Confirms `runMessages` folds an array of messages through the
   * supplied update, producing one commit per message and returning
   * the same graph handle for caller convenience.
   */
  it('runMessages sequences a Msg list into commits', () => {
    const graph = createCausl()
    const counter = graph.input('counter', 0)
    const update: Update<CounterMsg> = createUpdate<CounterMsg>({
      increment: (_msg, g) => {
        g.commit('inc', (tx) => tx.set(counter, g.read(counter) + 1))
      },
      decrement: (_msg, g) => {
        g.commit('dec', (tx) => tx.set(counter, g.read(counter) - 1))
      },
      set: (msg, g) => {
        g.commit('set', (tx) => tx.set(counter, msg.value))
      },
    })
    // A mixed sequence ending in an absolute `set` so the final value
    // is independent of the prior arithmetic.
    const messages: CounterMsg[] = [
      { kind: 'increment' },
      { kind: 'increment' },
      { kind: 'increment' },
      { kind: 'decrement' },
      { kind: 'set', value: 100 },
    ]
    const g = runMessages(update, graph, messages)
    // `runMessages` returns the same handle it was given.
    expect(g).toBe(graph)
    // Final counter value matches the last `set` payload.
    expect(g.read(counter)).toBe(100)
    // Each message should have produced exactly one commit, advancing `now`.
    expect(g.now).toBe(messages.length)
  })

  /**
   * An unknown `kind` must throw a descriptive runtime error so that
   * gaps in the handler map cannot silently no-op.
   */
  it('throws when a Msg kind is unhandled', () => {
    // Local Msg union with handlers only for `a` and `b`.
    type M = { kind: 'a' } | { kind: 'b' }
    const update: Update<M> = createUpdate<M>({
      a: (_m, _g) => {},
      b: (_m, _g) => {},
    })
    const graph = createCausl()
    // Coerce an out-of-union `kind` to force the runtime branch.
    expect(() =>
      update({ kind: 'c' as 'a' }, graph),
    ).toThrowError(/No handler for Msg kind/)
  })
})
