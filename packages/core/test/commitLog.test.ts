/**
 * @packageDocumentation
 *
 * `graph.commitLog` contract suite (EPIC #283 / #281).
 *
 * Liveness was the part of the previous spec that quietly disappeared
 * into a "devtools panel sitting next to the engine"; the fix is to
 * make the engine inspectable through its own primitives. Concretely,
 * the transaction log is a `Behavior [Commit]` — queryable by the
 * same API as any other graph value, realised here as a
 * {@link DerivedNode} whose value is the current bounded commit
 * history, observable via the standard `subscribe` / `read` /
 * `explain` Graph primitives.
 *
 * `commitLog` coexists with `subscribeCommits`, which carries the
 * narrower per-commit notification capability — one Commit object
 * per fire, no log read — for callers that only need the
 * "wake me on any change" signal without access to the full log.
 * That capability split is deliberate: persistence, devtools, and SSR
 * hydration each get the smallest surface they actually need rather
 * than the union of everyone's needs.
 *
 * Tests in this suite construct the engine with explicit
 * `commitHistoryCap: 1000` because SPEC §5.1 Amendment 2 (#716)
 * flipped the default to 0 — `commitLog` accumulation is gated on a
 * positive cap (Phase F.4 / §5.1 Amendment 1, #715). The bounded-
 * retention sub-suite below covers the cap=0 and custom-cap branches
 * directly.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCausl,
  NotAnInputNodeError,
  type Commit,
  type DerivedNode,
  type Graph,
  type InputNode,
} from '../src/index.js'

describe('graph.commitLog (EPIC #283 / #281)', () => {
  /**
   * Shape contract — what the public surface guarantees about the
   * type and identity of the commitLog node.
   */
  describe('shape contract', () => {
    /**
     * commitLog is exposed on the Graph interface as a stable
     * accessor. Reading it once and reading it again return the
     * same node handle — its identity is fixed for the engine's
     * lifetime.
     */
    it('is exposed on the Graph interface as a stable handle', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      // act + assert: the property exists and is referentially stable
      const a = g.commitLog
      const b = g.commitLog
      expect(a).toBe(b)
      expect(a).toBeDefined()
      expect(typeof a.id).toBe('string')
    })

    /**
     * commitLog's value type is `readonly Commit[]`. Reading via
     * `graph.read(commitLog)` returns an array; on a fresh graph
     * the array is empty.
     */
    it('initial value on a fresh graph is an empty array', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      // act
      const value = g.read(g.commitLog)
      // assert
      expect(Array.isArray(value)).toBe(true)
      expect(value).toEqual([])
    })

    /**
     * The value is byte-stable across repeated reads when no
     * commit has fired between them — the engine must not allocate
     * a fresh array on every read.
     */
    it('value is referentially stable across repeated reads on a quiescent engine', () => {
      // arrange: drive a commit so the array is non-empty
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 1)
      g.commit('seed', (tx) => tx.set(a, 5))
      // act: read twice without intervening commits
      const first = g.read(g.commitLog)
      const second = g.read(g.commitLog)
      // assert: same reference
      expect(first).toBe(second)
    })
  })

  /**
   * Value semantics — what the array contains and how it grows.
   */
  describe('value semantics', () => {
    /**
     * The array grows by one entry per successful commit.
     */
    it('grows by exactly one entry per successful commit', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      // act: three sequential commits
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      g.commit('three', (tx) => tx.set(a, 3))
      // assert
      expect(g.read(g.commitLog).length).toBe(3)
    })

    /**
     * Entries appear in commit order (oldest first).
     */
    it('entries appear in commit order with monotonically increasing time', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      // act
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      g.commit('three', (tx) => tx.set(a, 3))
      const log = g.read(g.commitLog)
      // assert: intents in order
      expect(log.map((c) => c.intent)).toEqual(['one', 'two', 'three'])
      // assert: times strictly increasing
      for (let i = 1; i < log.length; i++) {
        expect(log[i]!.time).toBeGreaterThan(log[i - 1]!.time)
      }
    })

    /**
     * Each entry's intent + time match the Commit returned by
     * `graph.commit(...)`.
     */
    it('each entry matches the Commit object returned by graph.commit()', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      // act: capture the Commit returned by graph.commit
      const returned: Commit = g.commit('seed', (tx) => tx.set(a, 9))
      // assert: that Commit appears in the log
      const log = g.read(g.commitLog)
      expect(log).toHaveLength(1)
      expect(log[0]!.time).toBe(returned.time)
      expect(log[0]!.intent).toBe(returned.intent)
      expect(log[0]!.changedNodes).toEqual(returned.changedNodes)
    })

    /**
     * Atomicity composite (with EPIC #280 #265 rollback): a failed
     * commit must NOT append an entry to the commit log. The
     * subsequent successful commit must produce a log identical to
     * one driven by a graph that never saw the failure.
     */
    it('failed commits do not append entries (atomicity)', () => {
      // arrange: parallel graphs A (sees failure) vs B (no failure)
      const drive = (g: Graph, a: InputNode<number>): void => {
        g.commit('first', (tx) => tx.set(a, 100))
        try {
          g.commit('toxic', () => {
            throw new Error('user code panic')
          })
        } catch {
          /* expected on graph A only */
        }
        g.commit('third', (tx) => tx.set(a, 200))
      }
      const driveB = (g: Graph, a: InputNode<number>): void => {
        g.commit('first', (tx) => tx.set(a, 100))
        g.commit('third', (tx) => tx.set(a, 200))
      }

      const gA = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const aA = gA.input('a', 1)
      drive(gA, aA)

      const gB = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const aB = gB.input('a', 1)
      driveB(gB, aB)

      // assert: both engines have identical commit logs
      expect(JSON.stringify(gA.read(gA.commitLog))).toBe(
        JSON.stringify(gB.read(gB.commitLog)),
      )
    })

    /**
     * The exposed array is read-only — callers cannot mutate the
     * engine's history through their handle. This test attempts a
     * forced mutation via `as` cast and verifies the engine's
     * subsequent read returns a non-mutated value.
     */
    it('the returned array is not the same reference the engine mutates internally', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      g.commit('seed', (tx) => tx.set(a, 1))
      // act: try to mutate the returned array
      const log = g.read(g.commitLog) as Commit[]
      try {
        log.push({ time: 999, intent: 'forged', changedNodes: [], originatedAt: undefined })
      } catch {
        /* if frozen, that's also acceptable */
      }
      // act: drive another real commit
      g.commit('second', (tx) => tx.set(a, 2))
      // assert: engine's view is correct (forged entry didn't appear)
      const fresh = g.read(g.commitLog)
      const intents = fresh.map((c) => c.intent)
      expect(intents).toContain('seed')
      expect(intents).toContain('second')
      // The forged 'forged' intent must NOT be in the engine's view.
      expect(intents).not.toContain('forged')
    })
  })

  /**
   * Subscription semantics — observable behaviour through the
   * standard `subscribe` API.
   */
  describe('subscription semantics', () => {
    /**
     * `subscribe(commitLog, observer)` fires once synchronously on
     * registration with the current array — the same engine-wide
     * subscribe contract every load-bearing Graph primitive honours
     * (notified once per commit when the value changes, with an
     * initial fire on registration).
     */
    it('subscribe(commitLog, observer) fires once synchronously with the current array', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      g.commit('seed', (tx) => tx.set(a, 5))
      const obs = vi.fn()
      // act
      const unsub = g.subscribe(g.commitLog, obs)
      // assert: fired once with current value
      expect(obs).toHaveBeenCalledTimes(1)
      const firstCall = obs.mock.calls[0]!
      const initialValue = firstCall[0] as readonly Commit[]
      expect(initialValue.length).toBe(1)
      expect(initialValue[0]!.intent).toBe('seed')
      unsub()
    })

    /**
     * Subscriber fires once per commit with the updated array.
     */
    it('fires once per successful commit with the updated array', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      obs.mockClear() // discard the initial-fire delivery
      // act: drive three commits
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      g.commit('three', (tx) => tx.set(a, 3))
      // assert: three notifications
      expect(obs).toHaveBeenCalledTimes(3)
      // each call's array has growing length
      const lengths = obs.mock.calls.map(
        (call) => (call[0] as readonly Commit[]).length,
      )
      expect(lengths).toEqual([1, 2, 3])
      unsub()
    })

    /**
     * Subscribers do NOT fire on a failed commit (atomicity-
     * via-subscription).
     */
    it('does not fire when a commit fails during user-callback execution', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      obs.mockClear()
      // act: commit body throws
      try {
        g.commit('toxic', () => {
          throw new Error('user code panic')
        })
      } catch {
        /* expected */
      }
      // assert: no notification fired
      expect(obs).not.toHaveBeenCalled()
      unsub()
    })

    /**
     * `unsubscribe` stops further notifications.
     */
    it('unsubscribe() stops further notifications', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      const obs = vi.fn()
      const unsub = g.subscribe(g.commitLog, obs)
      obs.mockClear()
      // act
      g.commit('one', (tx) => tx.set(a, 1))
      unsub()
      g.commit('two', (tx) => tx.set(a, 2))
      // assert
      expect(obs).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * Bounded-retention semantics — the array honours
   * `commitHistoryCap`.
   */
  describe('bounded retention', () => {
    /**
     * Custom `commitHistoryCap` bounds the array length.
     */
    it('honours a custom commitHistoryCap', () => {
      // arrange: cap of 3
      const g = createCausl({ commitHistoryCap: 3 })
      const a = g.input('a', 0)
      // act: drive 5 commits
      for (let i = 1; i <= 5; i++) {
        g.commit(`commit-${i}`, (tx) => tx.set(a, i))
      }
      // assert: only the most-recent 3 retained
      const log = g.read(g.commitLog)
      expect(log).toHaveLength(3)
      expect(log.map((c) => c.intent)).toEqual([
        'commit-3',
        'commit-4',
        'commit-5',
      ])
    })

    /**
     * `commitHistoryCap: 0` is the zero-retention recipe for long-lived
     * hosts. Each commit still advances `now` and fires per-node
     * subscribers; only log accumulation is suppressed. The cap is the
     * only memory-hygiene knob — there is no runtime flush primitive,
     * because firing `commitLog` subscribers outside a commit boundary
     * would violate §5 (observer-visible mutation only happens inside a
     * commit).
     */
    it('commitHistoryCap: 0 keeps the log empty across commits', () => {
      // arrange: cap of 0.
      const g = createCausl({ commitHistoryCap: 0 })
      const a = g.input('a', 0)
      // act: drive a few commits.
      g.commit('one', (tx) => tx.set(a, 1))
      g.commit('two', (tx) => tx.set(a, 2))
      // assert: log stays empty.
      expect(g.read(g.commitLog)).toEqual([])
      // assert: forward-progress state still advances.
      expect(g.now).toBe(2)
      expect(g.read(a)).toBe(2)
    })
  })

  /**
   * Integration with the rest of the Graph surface.
   */
  describe('integration with other Graph primitives', () => {
    /**
     * commitLog is a derived node, not an input — `tx.set` against
     * it must be rejected at compile time AND at runtime.
     */
    it('cannot be tx.set (it is a derived node)', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      // act + assert: forced runtime cast fails at the engine's
      // input-vs-derived check inside tx.set
      expect(() =>
        g.commit('forge', (tx) => {
          // The cast is the test surface — application code that
          // ignores the type system at the boundary must still see
          // the engine reject.
          tx.set(g.commitLog as unknown as InputNode<readonly Commit[]>, [])
        }),
      ).toThrow(NotAnInputNodeError)
    })

    /**
     * `graph.explain(commitLog)` returns a derived node — the
     * commit log participates in the engine's lineage view. The
     * commit-log-as-Behavior promise is paired with `explain`
     * returning *another node* — a derived view of the dependency
     * lineage that can itself be subscribed to, displayed, drilled
     * into — not a one-shot JSON dump. The explanation must list
     * any deps the engine's implementation chooses to declare for
     * the commitLog node.
     */
    it('graph.explain(commitLog) returns a derived Explanation node', () => {
      // arrange
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      // act
      const explanation = g.explain(g.commitLog)
      // assert: it's a node — the explain primitive returns a
      // subscribable derived view of the lineage
      expect(explanation).toBeDefined()
      expect(typeof explanation.id).toBe('string')
      // explanation should be readable
      const view = g.read(explanation)
      expect(view).toBeDefined()
      expect(view.node).toBe(g.commitLog.id)
    })
  })

  /**
   * Self-checks for the harness-internal test code, so a future
   * regression in test infrastructure doesn't silently mask a
   * regression in the production code.
   */
  describe('harness self-checks', () => {
    /**
     * `vi.fn()` records all calls in declaration order — confirm
     * the test framework is doing what the assertions assume.
     */
    it('vi.fn() preserves call order for assertion ordering', () => {
      const f = vi.fn()
      f('a')
      f('b')
      f('c')
      const args = f.mock.calls.map((c) => c[0] as string)
      expect(args).toEqual(['a', 'b', 'c'])
    })

    /**
     * The `Commit` shape we destructure in assertions is what the
     * engine actually returns from `graph.commit(...)`.
     */
    it('graph.commit returns a Commit with time, intent, changedNodes', () => {
      const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
      const a = g.input('a', 0)
      const c = g.commit('test', (tx) => tx.set(a, 1))
      expect(typeof c.time).toBe('number')
      expect(c.intent).toBe('test')
      expect(Array.isArray(c.changedNodes)).toBe(true)
    })
  })
})
