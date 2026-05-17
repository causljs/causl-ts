/**
 * @packageDocumentation
 *
 * Behavioural tests for the `commitLog(graph)` devtools primitive.
 *
 * §11 framing: the engine is its own observer. The devtools `commitLog`
 * is a `DerivedNode<readonly Commit[]>` projection of the engine's
 * canonical `graph.commitLog`, capped to a configured capacity and
 * reversed to most-recent-first for UI consumption. These assertions
 * pin that contract: the projection is itself queryable through the
 * standard `read` / `subscribe` / `explain` surface, capacity-bounded
 * (memory stays predictable in long-lived processes), and stable
 * across repeated calls so a UI does not accidentally subscribe to
 * two streams.
 *
 * Tests construct the engine with explicit `commitHistoryCap` /
 * `snapshotRetentionCap` because SPEC §5.1 Amendment 2 (#716) flipped
 * the default to 0; the devtools projection only sees what the
 * engine's bounded log retained, so opt-in retention is required.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { commitLog } from '../src/index.js'

/**
 * Contract suite for `commitLog(graph)` — a derived projection of the
 * engine's commit log shaped as a `DerivedNode<readonly Commit[]>`.
 */
describe('commitLog(graph)', () => {
  /**
   * The projection starts empty, grows as commits land, and surfaces
   * entries with the most recent commit first so a UI can render
   * newest-on-top without re-sorting.
   */
  it('captures commits as they occur, most-recent first', () => {
    // Arrange: empty graph with a single input and a fresh log node.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const log = commitLog(g)
    expect(g.read(log).length).toBe(0)
    // Act: drive three commits in chronological order.
    g.commit('first', (tx) => tx.set(a, 1))
    g.commit('second', (tx) => tx.set(a, 2))
    g.commit('third', (tx) => tx.set(a, 3))
    // Assert: snapshot is reverse-chronological (newest at index 0).
    const entries = g.read(log)
    expect(entries.length).toBe(3)
    expect(entries[0]?.intent).toBe('third')
    expect(entries[1]?.intent).toBe('second')
    expect(entries[2]?.intent).toBe('first')
  })

  /**
   * Bounded capacity makes the projection a window: once full, the
   * oldest entry drops out on each new commit so memory stays
   * predictable for long-running hosts.
   */
  it('respects a custom capacity (older entries drop)', () => {
    // Arrange: log capped at two entries.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const log = commitLog(g, { capacity: 2 })
    // Act: emit three commits — one more than capacity.
    g.commit('one', (tx) => tx.set(a, 1))
    g.commit('two', (tx) => tx.set(a, 2))
    g.commit('three', (tx) => tx.set(a, 3))
    // Assert: the oldest entry ('one') is dropped; newest stays at index 0.
    const entries = g.read(log)
    expect(entries.length).toBe(2)
    expect(entries[0]?.intent).toBe('three')
    expect(entries[1]?.intent).toBe('two')
  })

  /**
   * Each entry exposes `changedNodes`, the set of node ids whose values
   * moved during the commit (inputs touched plus any downstream derivations
   * recomputed). Devtools rely on this to highlight propagation paths.
   */
  it('records the changedNodes set', () => {
    // Arrange: graph with one input feeding one derivation.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.derived('sum', (get) => get(a) + 1)
    const log = commitLog(g)
    // Act: a single commit propagates from input to derived.
    g.commit('a→7', (tx) => tx.set(a, 7))
    // Assert: both nodes show up in the changed set.
    const entry = g.read(log)[0]
    expect(entry?.changedNodes).toContain('a')
    expect(entry?.changedNodes).toContain('sum')
  })

  /**
   * Capacity must be positive — a zero/negative buffer would render the log
   * useless and is rejected at construction rather than silently coerced.
   */
  it('rejects capacity <= 0', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    // Act + Assert: invalid capacity throws synchronously.
    expect(() => commitLog(g, { capacity: 0 })).toThrow()
  })

  /**
   * §11 stable identity: a UI that calls `commitLog(g)` twice must
   * receive the same `DerivedNode<...>` so it subscribes to one
   * stream, not two. Memoised per (graph, id).
   */
  it('returns a stable identity per (graph, id)', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    expect(commitLog(g)).toBe(commitLog(g))
    expect(commitLog(g, { capacity: 5 })).toBe(commitLog(g, { capacity: 5 }))
    // Distinct capacities → distinct ids → distinct nodes.
    expect(commitLog(g, { capacity: 5 })).not.toBe(commitLog(g, { capacity: 7 }))
  })

  /**
   * §11 liveness: subscribers fire on every successful commit, with
   * the post-commit window. Realises the §11 framing the issue cites
   * — the projection is itself a derived node, not a one-shot dump.
   */
  it('subscribers fire on the commit that triggered the update', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const log = commitLog(g)
    const fired: { time: number; head: number | undefined }[] = []
    // The engine's `subscribe` fires once synchronously with the
    // current value at registration time, then once per commit that
    // changes the node — those follow-up fires are the §11 pin.
    g.subscribe(log, (value, time) => {
      fired.push({ time, head: value[0]?.time })
    })
    g.commit('one', (tx) => tx.set(a, 1))
    g.commit('two', (tx) => tx.set(a, 2))
    // Fires: initial (t=0, empty), commit at t=1, commit at t=2.
    // Each commit's fire carries the commit that woke us up at the head
    // of the window — the regression #383 documents was that the head
    // was the *previous* commit because Phase D ran before
    // `commitLogEntry.value` refresh; Phase F.5 closes that gap.
    expect(fired.length).toBe(3)
    expect(fired[0]).toEqual({ time: 0, head: undefined })
    expect(fired[1]).toEqual({ time: 1, head: 1 })
    expect(fired[2]).toEqual({ time: 2, head: 2 })
  })
})
