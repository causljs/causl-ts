/**
 * @packageDocumentation
 *
 * Pins the bounded-history contract on `graph.exportModel().commits`. Earlier
 * implementations baked in a 10k cap; the engine now exposes a configurable
 * `commitHistoryCap` option on `createCausl`, with `0` as the explicit
 * recipe for long-lived hosts that want zero retention. Each test commits a
 * known sequence and inspects the exported model to assert eviction order and
 * the cap's lower bound.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

/**
 * Groups the assertions for the commit-history ring buffer: configurable cap
 * and FIFO eviction at the lower bound.
 */
describe('commit-history bounds', () => {
  /**
   * When a custom cap is supplied at construction, only the most recent N
   * commits remain in the exported model regardless of `maxCommits` requested
   * by the caller; older entries are evicted in FIFO order.
   */
  it('respects a custom commitHistoryCap', () => {
    // arrange: graph configured with a 3-slot history cap.
    const g = createCausl({ commitHistoryCap: 3 })
    const a = g.input('a', 0)
    // act: ten back-to-back commits overflow the buffer.
    for (let i = 0; i < 10; i++) {
      g.commit(`c${i}`, (tx) => tx.set(a, i))
    }
    const m = g.exportModel({ maxCommits: 100 })
    // assert: only the last three intents survive, in commit order.
    expect(m.commits.length).toBe(3)
    expect(m.commits.map((c) => c.intent)).toEqual(['c7', 'c8', 'c9'])
  })

  /**
   * `commitHistoryCap: 0` is the zero-retention recipe — long-lived hosts
   * that want no in-memory log set the cap at construction. Each commit
   * still advances `now` and fires per-node subscribers; only the log
   * accumulation is suppressed. There is no runtime flush primitive
   * because firing `commitLog` subscribers outside a commit boundary would
   * violate §5.
   */
  it('commitHistoryCap: 0 keeps the log at zero entries across commits', () => {
    // arrange: graph configured with a zero-slot history cap.
    const g = createCausl({ commitHistoryCap: 0 })
    const a = g.input('a', 0)
    // act: drive several commits.
    g.commit('first', (tx) => tx.set(a, 1))
    g.commit('second', (tx) => tx.set(a, 2))
    g.commit('third', (tx) => tx.set(a, 3))
    // assert: log stays empty regardless of commit count.
    expect(g.exportModel().commits.length).toBe(0)
    expect(g.read(g.commitLog)).toEqual([])
    // assert: forward-progress state still advances — `now` records every
    // commit even though the log retains nothing.
    expect(g.now).toBe(3)
    expect(g.read(a)).toBe(3)
  })

  /**
   * SPEC §5.1 Amendment 2 (#716): the default flipped from 1000 to 0.
   * Constructing an engine with NO options is now byte-equivalent to
   * passing `commitHistoryCap: 0` explicitly. This test pins the new
   * default behaviour so a future drift back to a non-zero default
   * fails immediately and visibly. The pairing with §5.1 Amendment 1
   * (#715) means this is the cap=0 fast path — Phases F, F.4, F.6
   * all skip and the per-commit envelope cost is eliminated.
   */
  it('default `createCausl()` (no options) leaves the log empty across commits', () => {
    // arrange: graph constructed with NO options — the new default
    // path. Pre-#716 this graph would have a 1000-slot history cap.
    const g = createCausl()
    const a = g.input('a', 0)
    // act: drive several commits.
    g.commit('first', (tx) => tx.set(a, 1))
    g.commit('second', (tx) => tx.set(a, 2))
    g.commit('third', (tx) => tx.set(a, 3))
    // assert: log stays empty under the new default — same observable
    // shape as `commitHistoryCap: 0` explicit.
    expect(g.exportModel().commits.length).toBe(0)
    expect(g.read(g.commitLog)).toEqual([])
    // assert: forward-progress state still advances — `now` records every
    // commit even though the log retains nothing.
    expect(g.now).toBe(3)
    expect(g.read(a)).toBe(3)
  })
})
