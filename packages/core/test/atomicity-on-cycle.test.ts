/**
 * @packageDocumentation
 *
 * Atomicity-under-failure contract (EPIC #280, sub-issue #265).
 * Pins the rollback contract that `commit()` must satisfy when
 * any phase of the commit pipeline throws: input writes do not land,
 * `now` does not advance, no `Commit` record is published, no
 * subscriber fires.
 *
 * Atomicity is a theorem, not a goal: a transaction creates exactly
 * one new `t`, there is no fractional time, and `commit` is the sole
 * mutation entry-point — outside a commit the graph is read-only,
 * inside a commit reads see staged writes, outside reads see the
 * previous committed snapshot, and there is no concurrent-mutation
 * question because there is no concurrent-mutation API.
 *
 * Causl's cycle detection currently fires at REGISTRATION time
 * (when `computed=false`), not commit-time recompute (deps are
 * fixed once `computed=true`). Even so, atomicity is declared as
 * a theorem rather than a goal, and `docs/lifecycle.md` §4 makes
 * `Validating → Idle` the only edge out on `guard-failed [strict]`.
 * The rollback contract must hold for any throw escaping from inside
 * the commit body — `tx.set` validation, the user-supplied `run`
 * callback, `recomputeAffected`, observer dispatch — even where the
 * specific throw site is hypothetical today.
 *
 * The harness drives several throw paths that ARE reproducible on
 * `main` and asserts atomicity for each. A regression that allows
 * any of these to leak partial state is captured.
 *
 * @see docs/lifecycle.md §4 — guard-failed [strict] bypasses Publishing
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCausl,
  NotAnInputNodeError,
  StaleTxError,
  type Commit,
  type Graph,
  type InputNode,
} from '../src/index.js'

/**
 * Snapshot the externally-observable state of a graph for byte-equal
 * comparison after an attempted-and-failed commit. Captures every
 * surface the atomicity contract guards.
 */
interface GraphState {
  readonly now: number
  readonly inputs: ReadonlyMap<string, unknown>
  readonly historyLength: number
  readonly serializedIR: string
}

function captureState(g: Graph, inputs: ReadonlyArray<InputNode<unknown>>): GraphState {
  const inputMap = new Map<string, unknown>()
  for (const node of inputs) inputMap.set(node.id, g.read(node))
  const ir = g.exportModel()
  return {
    now: g.now,
    inputs: inputMap,
    historyLength: ir.commits.length,
    serializedIR: JSON.stringify(ir),
  }
}

function expectStateUnchanged(
  before: GraphState,
  after: GraphState,
  label: string,
): void {
  expect(after.now, `${label}: now`).toBe(before.now)
  expect(after.historyLength, `${label}: history length`).toBe(before.historyLength)
  expect(after.serializedIR, `${label}: IR`).toBe(before.serializedIR)
  expect(after.inputs.size, `${label}: input count`).toBe(before.inputs.size)
  for (const [id, value] of before.inputs) {
    expect(after.inputs.get(id), `${label}: input ${id}`).toBe(value)
  }
}

describe('commit() atomicity under failure (EPIC #280 / #265)', () => {
  /**
   * The user-supplied `run` callback may itself throw — application
   * code is not trustworthy. When it does, the engine must NOT have
   * staged any writes, advanced `now`, or published a Commit.
   */
  describe('user-supplied run callback throws', () => {
    /**
     * Callback throws BEFORE any `tx.set` runs. State must be
     * byte-identical to the pre-commit snapshot.
     */
    it('throws synchronously before any tx.set — engine state byte-equal to pre-commit', () => {
      // arrange: a small graph
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      g.derived<number>('s', (get) => get(a) + get(b))
      const before = captureState(g, [a, b])

      // act: commit whose body throws before staging anything
      const sentinel = new Error('user code panic')
      expect(() =>
        g.commit('toxic', () => {
          throw sentinel
        }),
      ).toThrow(sentinel)

      // assert: state byte-identical
      const after = captureState(g, [a, b])
      expectStateUnchanged(before, after, 'pre-stage throw')
    })

    /**
     * Callback throws AFTER staging at least one `tx.set`. The
     * staged write must NOT have landed — atomicity contract.
     */
    it('throws after staging tx.set — staged writes do not land', () => {
      // arrange: graph + subscriber to count notifications
      const g = createCausl()
      const a = g.input('a', 10)
      const b = g.input('b', 20)
      const obs = vi.fn()
      g.subscribe(a, obs)
      obs.mockClear() // discard initial-fire
      // Capture AFTER subscribe so the IRSubscribe wire-format
      // record is part of the pre-commit baseline. PR-B1 drains
      // active subscribers into `events` on every export; the
      // atomicity contract under test is "failed commit doesn't
      // mutate state", not "subscribers don't surface in IR".
      const before = captureState(g, [a, b])

      // act: commit stages writes then throws
      const sentinel = new Error('user code panic mid-tx')
      expect(() =>
        g.commit('toxic', (tx) => {
          tx.set(a, 99)
          tx.set(b, 88)
          throw sentinel
        }),
      ).toThrow(sentinel)

      // assert: state byte-identical, subscribers untouched
      const after = captureState(g, [a, b])
      expectStateUnchanged(before, after, 'post-stage throw')
      expect(obs).not.toHaveBeenCalled()
    })

    /**
     * Mixed sequence: commit succeeds, then commit throws, then
     * commit succeeds. The middle failure must not perturb the
     * trace observed by the third commit.
     */
    it('successful commit after failed commit produces identical trace', () => {
      // arrange: two parallel graphs we'll drive identically
      const driveSuccess = (g: Graph, a: InputNode<number>): void => {
        g.commit('first', (tx) => tx.set(a, 100))
      }
      const driveFailureBetween = (g: Graph, a: InputNode<number>): void => {
        try {
          g.commit('toxic', (tx) => {
            tx.set(a, 9999)
            throw new Error('toxic')
          })
        } catch {
          /* swallow */
        }
      }
      const driveFinalSuccess = (g: Graph, a: InputNode<number>): void => {
        g.commit('third', (tx) => tx.set(a, 200))
      }

      // act: drive engine A through success → failure → success
      // Pin `name` so both engines share `graphId`; the byte-equal
      // claim is "two identical traces produce identical IR", which
      // requires the same identity (schema 3 stamps `graphId` on
      // every node and commit; without a shared name the engines
      // mint distinct UUIDs and the IRs would diverge by design).
      const gA = createCausl({ name: 'atomicity-gA' })
      const aA = gA.input('a', 1)
      driveSuccess(gA, aA)
      driveFailureBetween(gA, aA)
      driveFinalSuccess(gA, aA)

      // act: drive engine B through success → success (no failure between)
      const gB = createCausl({ name: 'atomicity-gA' })
      const aB = gB.input('a', 1)
      driveSuccess(gB, aB)
      driveFinalSuccess(gB, aB)

      // assert: serialised IR is byte-equal — failure left zero trace
      expect(JSON.stringify(gA.exportModel())).toBe(
        JSON.stringify(gB.exportModel()),
      )
    })
  })

  /**
   * `tx.set` itself can throw via type-checked guards (e.g.
   * NotAnInputNodeError when targeting a derived). The throw
   * propagates out of the user's callback to commit's catch
   * boundary; atomicity must still hold.
   */
  describe('tx.set guard throws (NotAnInputNodeError)', () => {
    /**
     * Commit body calls `tx.set` on a derived node. Engine must
     * throw NotAnInputNodeError; no writes land, no time advances.
     */
    it('throws NotAnInputNodeError — engine state unchanged', () => {
      // arrange: input + derived
      const g = createCausl()
      const a = g.input('a', 1)
      const d = g.derived<number>('d', (get) => get(a) * 2)
      const before = captureState(g, [a])

      // act: commit attempts tx.set on the derived
      expect(() =>
        g.commit('toxic', (tx) => {
          tx.set(a, 7) // legal stage
          // The cast is the test surface — application code that ignores
          // the type system at the boundary must still see the engine reject.
          tx.set(d as unknown as InputNode<number>, 99) // illegal
        }),
      ).toThrow(NotAnInputNodeError)

      // assert: even the legal stage that preceded the throw must
      // have been rolled back
      const after = captureState(g, [a])
      expectStateUnchanged(before, after, 'tx.set guard throw')
    })
  })

  /**
   * StaleTxError protects the commit boundary against transactions
   * captured-and-leaked. The engine's `tx` handle is bounded to
   * its commit; using it after `run` returned is a catalogued
   * race-class row caught by API design — there is no API to read
   * inside another transaction's staging window, and the leaked
   * handle is rejected at runtime. Atomicity for the originating
   * commit is unaffected (the stale use happens in a SEPARATE call
   * frame), so this case exists only to confirm the typed error
   * fires — not to assert rollback.
   */
  describe('StaleTxError on leaked tx handle', () => {
    /**
     * Captured `tx` used after the commit returned must throw
     * StaleTxError. The completed commit's effects remain
     * (because that commit succeeded).
     */
    it('throws StaleTxError when used after commit returned', () => {
      // arrange
      const g = createCausl()
      const a = g.input('a', 1)
      let leakedTx: Parameters<Parameters<Graph['commit']>[1]>[0] | undefined
      g.commit('first', (tx) => {
        leakedTx = tx
        tx.set(a, 5)
      })
      // commit succeeded — engine state should reflect it
      expect(g.read(a)).toBe(5)

      // act + assert: using the leaked tx throws StaleTxError
      expect(() => leakedTx!.set(a, 999)).toThrow(StaleTxError)

      // assert: read still reflects the prior committed value
      expect(g.read(a)).toBe(5)
    })
  })

  /**
   * Re-entrant commit (calling `g.commit` from inside another
   * commit's body) must throw CommitInProgressError. The outer
   * commit's effects either ALL land or ALL roll back — not
   * partially.
   */
  describe('re-entrant commit (CommitInProgressError)', () => {
    /**
     * Inner commit attempt throws; outer commit's staged write
     * does NOT land, because the throw escapes the run callback
     * back to commit's catch boundary.
     */
    it('throws on re-entrant commit — outer staged write does not land', () => {
      // arrange
      const g = createCausl()
      const a = g.input('a', 1)
      const before = captureState(g, [a])

      // act: outer commit stages a write, then attempts a nested commit
      expect(() =>
        g.commit('outer', (tx) => {
          tx.set(a, 99)
          // Inner commit must throw CommitInProgressError; the throw
          // escapes the run callback and reaches commit's catch.
          g.commit('inner', () => {
            /* unreachable */
          })
        }),
      ).toThrow()

      // assert: outer's tx.set(a, 99) did NOT land
      const after = captureState(g, [a])
      expectStateUnchanged(before, after, 're-entrant commit')
    })
  })

  /**
   * THE REAL ATOMICITY VIOLATION: a derived's user-supplied
   * `compute` callback throwing during Phase D (recompute) leaves
   * Phase B (input writes) and Phase C (`now += 1`) effects in
   * place. The commit() function uses a `try/finally`, not a
   * `try/catch`, so the engine state is corrupted: input writes
   * landed, time advanced, but no Commit was published, no
   * subscribers fired.
   *
   * This is the exact scenario #265 was filed for. The fix is to
   * snapshot the pre-commit state of input values + `now` and roll
   * them back inside the catch arm.
   */
  describe('Phase D recompute throws — atomicity rollback', () => {
    /**
     * A user-defined derived whose `compute` callback throws on
     * the second invocation (after registration). The first commit
     * that touches its dependency triggers the throw during recompute.
     *
     * On the current engine WITHOUT the fix: input write landed,
     * `now` advanced, no Commit published. State is corrupted.
     *
     * After the #265 fix: input value reverted, `now` reverted,
     * IR byte-equal to pre-commit.
     */
    it('user compute throws during recompute — input writes do not land', () => {
      // arrange: a derived whose compute throws on a sentinel input value
      const g = createCausl()
      const a = g.input('a', 1)
      const TOXIC_VALUE = 99
      const sentinel = new Error('compute panic on toxic value')
      g.derived<number>('toxic', (get) => {
        const v = get(a)
        if (v === TOXIC_VALUE) throw sentinel
        return v
      })
      // Registration succeeded with v=1 (not the sentinel).
      const before = captureState(g, [a])

      // act: commit a write to the toxic value — Phase D recompute throws
      expect(() => g.commit('toxic-trigger', (tx) => tx.set(a, TOXIC_VALUE))).toThrow(
        sentinel,
      )

      // assert: input write did NOT land
      const after = captureState(g, [a])
      expectStateUnchanged(before, after, 'compute throw during recompute')
    })

    /**
     * Multi-input commit where ONE downstream derived throws. The
     * other inputs' writes also must roll back — atomicity is
     * all-or-nothing, not partial.
     */
    it('multi-input commit with a throwing downstream — all writes roll back', () => {
      // arrange: derived throws when a + b > sentinel
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      const c = g.input('c', 3)
      const TOXIC_THRESHOLD = 200
      const sentinel = new Error('downstream panic')
      g.derived<number>('throws-on-recompute', (get) => {
        const sum = get(a) + get(b)
        if (sum > TOXIC_THRESHOLD) throw sentinel
        return sum
      })
      const before = captureState(g, [a, b, c])

      // act: commit writes a, b, AND c — a + b will exceed the threshold
      // and trigger the throw. The failure must roll back c too —
      // atomicity is total, not partial.
      expect(() =>
        g.commit('multi', (tx) => {
          tx.set(a, 100)
          tx.set(b, 200)
          tx.set(c, 300)
        }),
      ).toThrow(sentinel)

      // assert: all three inputs reverted
      const after = captureState(g, [a, b, c])
      expectStateUnchanged(before, after, 'multi-input atomic rollback')
    })

    /**
     * Subscribers must NOT fire when the commit fails. Even if a
     * downstream notification path was reached, the rollback
     * contract demands zero observer activity.
     */
    it('subscribers do not fire when commit fails during recompute', () => {
      // arrange: subscribe before triggering the toxic commit
      const g = createCausl()
      const a = g.input('a', 1)
      const TOXIC = 999
      g.derived<number>('toxic', (get) => {
        const v = get(a)
        if (v === TOXIC) throw new Error('throw')
        return v
      })
      const obs = vi.fn()
      g.subscribe(a, obs)
      obs.mockClear() // discard initial-fire

      // act: commit triggers throw
      expect(() => g.commit('toxic', (tx) => tx.set(a, TOXIC))).toThrow()

      // assert: subscriber NEVER fired post-failure
      expect(obs).not.toHaveBeenCalled()
    })

    /**
     * After a failed commit, a subsequent successful commit must
     * produce a trace identical to a graph that never saw the
     * failure. Pins that the failure left zero observable trace.
     */
    it('successful commit after failed recompute produces identical trace', () => {
      // arrange: parallel graphs A (sees failure between) vs B (no failure)
      // The toxic compute throws ONLY when the input is the sentinel
      // 9999. Other commits go through cleanly.
      const TOXIC_SENTINEL = 9999
      const buildToxicDerived = (g: Graph, a: InputNode<number>): void => {
        g.derived<number>('toxic', (get) => {
          const v = get(a)
          if (v === TOXIC_SENTINEL) throw new Error('compute panic')
          return v
        })
      }
      const driveSuccess = (g: Graph, a: InputNode<number>): void => {
        g.commit('first', (tx) => tx.set(a, 100))
      }
      const driveFinal = (g: Graph, a: InputNode<number>): void => {
        g.commit('third', (tx) => tx.set(a, 200))
      }

      // build A and drive: success → failure → success
      // Pin `name` so both engines share `graphId`; the byte-equal
      // claim requires identical graph identity per schema 3.
      const gA = createCausl({ name: 'atomicity-recompute' })
      const aA = gA.input('a', 1)
      buildToxicDerived(gA, aA)
      driveSuccess(gA, aA)
      try {
        gA.commit('toxic', (tx) => tx.set(aA, TOXIC_SENTINEL))
      } catch {
        /* expected */
      }
      driveFinal(gA, aA)

      // build B and drive: success → success (no failure between)
      const gB = createCausl({ name: 'atomicity-recompute' })
      const aB = gB.input('a', 1)
      buildToxicDerived(gB, aB)
      driveSuccess(gB, aB)
      driveFinal(gB, aB)

      // assert: byte-equal IR — failure left zero trace
      expect(JSON.stringify(gA.exportModel())).toBe(
        JSON.stringify(gB.exportModel()),
      )
    })
  })

  /**
   * Successful commit path — sanity checks. These tests exist to
   * ensure the rollback machinery added for the failure cases does
   * NOT break the success path. Without these, the rollback
   * implementation could "succeed" by always rolling back.
   */
  describe('successful commits land all expected effects', () => {
    /**
     * Single tx.set lands cleanly: input updated, now advanced,
     * Commit pushed, subscribers fire.
     */
    it('single tx.set lands and advances now exactly once', () => {
      // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped the
      // `commitHistoryCap` default to 0. This test asserts the
      // commit-history grew by one, which requires opt-in retention.
      const g = createCausl({ commitHistoryCap: 1000 })
      const a = g.input('a', 1)
      const beforeNow = g.now
      const beforeHistory = g.exportModel().commits.length
      const obs = vi.fn()
      g.subscribe(a, obs)
      obs.mockClear()

      // act
      const result: Commit = g.commit('write', (tx) => tx.set(a, 7))

      // assert: write landed
      expect(g.read(a)).toBe(7)
      // assert: now advanced exactly once
      expect(g.now).toBe(beforeNow + 1)
      // assert: Commit returned matches
      expect(result.time).toBe(beforeNow + 1)
      expect(result.intent).toBe('write')
      expect(result.changedNodes).toContain('a')
      // assert: history grew by one
      expect(g.exportModel().commits.length).toBe(beforeHistory + 1)
      // assert: subscriber fired exactly once
      expect(obs).toHaveBeenCalledTimes(1)
      expect(obs).toHaveBeenCalledWith(7, beforeNow + 1)
    })

    /**
     * Multi-tx.set commit: all writes land atomically; subscribers
     * fire once per changed input; now advances exactly once.
     */
    it('multi tx.set commit lands all writes atomically', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      const c = g.input('c', 3)
      const beforeNow = g.now
      const obsA = vi.fn()
      const obsB = vi.fn()
      const obsC = vi.fn()
      g.subscribe(a, obsA)
      g.subscribe(b, obsB)
      g.subscribe(c, obsC)
      obsA.mockClear()
      obsB.mockClear()
      obsC.mockClear()

      // act: commit changes a + b but not c
      g.commit('partial', (tx) => {
        tx.set(a, 10)
        tx.set(b, 20)
      })

      // assert: a + b updated, c unchanged
      expect(g.read(a)).toBe(10)
      expect(g.read(b)).toBe(20)
      expect(g.read(c)).toBe(3)
      // assert: now advanced exactly once (not three times)
      expect(g.now).toBe(beforeNow + 1)
      // assert: only changed-input subscribers fired
      expect(obsA).toHaveBeenCalledTimes(1)
      expect(obsB).toHaveBeenCalledTimes(1)
      expect(obsC).not.toHaveBeenCalled()
    })
  })
})
