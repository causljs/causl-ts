/**
 * @packageDocumentation
 *
 * Behavioural pinning for `graph.simulate(intent, run)` — the §5
 * dry-run API that lets a caller predict a commit's effect without
 * advancing GraphTime, appending to the commit log, or firing any
 * subscriber.
 *
 * §5 names exactly three commit-mode shapes — `strict`,
 * `with-conflicts`, and a separate `graph.simulate(...)` API for
 * dry-run. The first two collapse onto the existing `commit` pipeline
 * (the engine ships no blocking constraints today, so `strict` is the
 * de-facto behaviour). `simulate` is the third row, and the §5 contract
 * is the strong one: after the call returns, engine state is byte-
 * identical to the pre-call moment. Every guarantee §5 makes about
 * `commit` — atomicity, observer-visibility through one mutation API,
 * exactly-one-tick-per-commit — `simulate` upholds by *also* not
 * mutating any of the surfaces that would break those guarantees.
 *
 * The suite below pins three rows of that contract:
 *
 * 1. **Happy path** — `simulate` predicts the post-commit `read(node)`
 *    correctly. A subsequent `commit` with the same `run` lambda
 *    produces a {@link Commit} whose `changedNodes` matches the
 *    simulation's `stagedDiff ∪ derivedDiff` (modulo the engine-owned
 *    `commitLog` node, which `simulate` does not refresh).
 * 2. **Side effects** — `simulate` does NOT advance `graph.now`, does
 *    NOT append to the commit log, does NOT fire any per-node
 *    subscriber, and does NOT fire any commit-level subscriber.
 * 3. **Errors** — `simulate` predicts the typed errors that escape
 *    `commit` ({@link NotAnInputNodeError}, {@link UnknownNodeError},
 *    {@link NodeDisposedError}, {@link StaleTxError}, plus user-thrown
 *    errors out of the `run` callback or from inside a derived
 *    compute) without throwing them at the caller. The {@link CycleError}
 *    row fires at REGISTRATION time today (`computed=false` is the only
 *    state under which the dirty-stack guard walks), so simulate
 *    inherits the same parity contract — it neither suppresses a
 *    CycleError that registration would have thrown nor fabricates one
 *    on the latent-cycle silent-accept path. Re-entrancy is the one
 *    structural misuse that DOES throw out of simulate itself — the
 *    same `CommitInProgressError` contract as nested `commit`.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CommitInProgressError,
  CycleError,
  NodeDisposedError,
  NotAnInputNodeError,
  CauslError,
  StaleTxError,
  UnknownNodeError,
  createCausl,
  type InputNode,
  type Tx,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

describe('graph.simulate(intent, run) — §5 dry-run API', () => {
  describe('happy path', () => {
    /**
     * The most basic guarantee: `simulate` predicts the post-commit
     * `read(node)` correctly. The simulation advances no state, but
     * the predicted `Commit.changedNodes` is exactly what a real
     * commit would have produced.
     */
    it('predicts the post-commit changed-node set', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      g.derived('sum', (get) => get(a) + get(b))

      const result = g.simulate('preview', (tx) => tx.set(a, 100))
      expect(result.status).toBe('clean')
      if (result.status !== 'clean') return
      expect(result.commit.intent).toBe('preview')
      expect(result.commit.time).toBe(1)
      expect([...result.commit.changedNodes].sort()).toEqual(['a', 'sum'])
      expect(result.stagedDiff).toEqual(['a'])
      expect(result.derivedDiff).toEqual(['sum'])
    })

    /**
     * A `simulate` followed by an identical `commit` produces a
     * `Commit.changedNodes` byte-equal to the simulation's `stagedDiff
     * ∪ derivedDiff`. Same intent, same writes, same effect — the
     * dry-run is a faithful preview.
     */
    it('matches a subsequent commit with the same run lambda', () => {
      const g = createCausl()
      const a = g.input('a', 0)
      const b = g.input('b', 0)
      g.derived('product', (get) => get(a) * get(b))
      g.derived('shifted', (get) => get(a) + 1)

      const writes = (tx: Tx): void => {
        tx.set(a, 7)
        tx.set(b, 9)
      }

      const sim = g.simulate('test', writes)
      const real = g.commit('test', writes)

      expect(sim.status).toBe('clean')
      if (sim.status !== 'clean') return
      // The simulation predicts what the commit would change. The
      // real commit additionally fires the engine-owned commitLog
      // node, which is not part of the user-visible model and which
      // simulate intentionally skips refreshing — strip it before
      // comparing.
      const realChanges = real.changedNodes.filter(
        (id) => id !== '__causl_commit_log__',
      )
      expect([...sim.commit.changedNodes].sort()).toEqual([...realChanges].sort())
    })

    /**
     * A staged write that lands on the same value as the prior
     * commit (`Object.is` equality) is omitted from the diff —
     * mirrors `commit`'s Phase B contract.
     */
    it('omits no-op staged writes from stagedDiff', () => {
      const g = createCausl()
      const a = g.input('a', 42)
      g.derived('double', (get) => get(a) * 2)

      const result = g.simulate('noop', (tx) => tx.set(a, 42))
      expect(result.status).toBe('clean')
      if (result.status !== 'clean') return
      expect(result.stagedDiff).toEqual([])
      expect(result.derivedDiff).toEqual([])
      expect(result.commit.changedNodes).toEqual([])
    })

    /**
     * A write whose downstream derivation evaluates to the same
     * value as before (an Object.is convergence) is omitted from
     * the derivedDiff — the equality-cutoff that `commit`'s Phase D
     * applies.
     */
    it('omits derivations whose recomputed value did not change', () => {
      const g = createCausl()
      const a = g.input('a', 10)
      // saturating max — clamping to 100 means writes ≥ 100 land
      // on the same value.
      g.derived('cap', (get) => Math.min(get(a), 100))

      // Pre-saturate the cap so its current value is 100.
      g.commit('saturate', (tx) => tx.set(a, 100))

      // Now simulate a write that bumps `a` higher; `cap` would
      // recompute to the same `100`.
      const result = g.simulate('try-200', (tx) => tx.set(a, 200))
      expect(result.status).toBe('clean')
      if (result.status !== 'clean') return
      expect(result.stagedDiff).toEqual(['a'])
      expect(result.derivedDiff).toEqual([])
    })

    /**
     * Multiple sequential `simulate` calls all predict against the
     * same pre-call state — a simulate doesn't perturb the next
     * simulate's prediction.
     */
    it('repeated simulates produce identical predictions', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.derived('plus10', (get) => get(a) + 10)

      const r1 = g.simulate('a', (tx) => tx.set(a, 5))
      const r2 = g.simulate('b', (tx) => tx.set(a, 5))
      const r3 = g.simulate('c', (tx) => tx.set(a, 5))

      expect(r1.status).toBe('clean')
      expect(r2.status).toBe('clean')
      expect(r3.status).toBe('clean')
      if (r1.status !== 'clean' || r2.status !== 'clean' || r3.status !== 'clean') return
      expect(r1.commit.time).toBe(1)
      expect(r2.commit.time).toBe(1)
      expect(r3.commit.time).toBe(1)
      expect(r1.commit.changedNodes).toEqual(r2.commit.changedNodes)
      expect(r2.commit.changedNodes).toEqual(r3.commit.changedNodes)
    })
  })

  describe('side effects — observer-invisible dry-run', () => {
    /**
     * The §5 contract's load-bearing invariant: `simulate` does not
     * advance `graph.now`. The dry-run is observer-invisible.
     */
    it('does not advance graph.now', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.commit('seed', (tx) => tx.set(a, 2))
      expect(g.now).toBe(1)

      g.simulate('preview', (tx) => tx.set(a, 99))
      expect(g.now).toBe(1)
      expect(g.read(a)).toBe(2)
    })

    /**
     * `simulate` does NOT fire per-node subscribers — observers
     * registered via `graph.subscribe(node, …)` see only their
     * initial-fire and any subsequent real commits, never a dry-run.
     */
    it('does not fire per-node subscribers', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.derived('plus1', (get) => get(a) + 1)
      const obs = vi.fn()
      g.subscribe(a, obs)
      // initial-fire happens synchronously at subscribe time
      obs.mockClear()

      g.simulate('preview', (tx) => tx.set(a, 100))
      expect(obs).not.toHaveBeenCalled()

      // and a real commit afterwards still fires correctly
      g.commit('real', (tx) => tx.set(a, 100))
      expect(obs).toHaveBeenCalledWith(100, 1)
    })

    /**
     * `simulate` does NOT fire `subscribeCommits` observers — the
     * commit log is not appended to, so consumers that wake on any
     * commit do not wake on a simulate.
     */
    it('does not fire commit-level subscribers', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const obs = vi.fn()
      g.subscribeCommits(obs)

      g.simulate('preview', (tx) => tx.set(a, 999))
      expect(obs).not.toHaveBeenCalled()

      // real commit afterwards still fires
      g.commit('real', (tx) => tx.set(a, 999))
      expect(obs).toHaveBeenCalledTimes(1)
    })

    /**
     * `simulate` does not append to the commit log — `commitLog`
     * subscribers see no new entry, and `exportModel().commits` is
     * unchanged.
     */
    it('does not append to the commit log', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.commit('seed', (tx) => tx.set(a, 2))

      const beforeLog = g.read(g.commitLog)
      const beforeIR = JSON.stringify(g.exportModel())

      g.simulate('preview', (tx) => tx.set(a, 999))

      expect(g.read(g.commitLog)).toBe(beforeLog)
      expect(JSON.stringify(g.exportModel())).toBe(beforeIR)
    })

    /**
     * After `simulate` returns, every input cell still holds its
     * pre-call value AND its `lastWriteTime` (queried via
     * `explain`'s `computedAt` field) is unchanged.
     */
    it('does not mutate input cells', () => {
      const g = createCausl()
      const a = g.input('a', 7)
      g.commit('seed', (tx) => tx.set(a, 7))

      const beforeNow = g.now
      const beforeValue = g.read(a)
      const beforeExplain = JSON.stringify(g.read(g.explain(a)))

      g.simulate('preview', (tx) => tx.set(a, 999))

      expect(g.now).toBe(beforeNow)
      expect(g.read(a)).toBe(beforeValue)
      expect(JSON.stringify(g.read(g.explain(a)))).toBe(beforeExplain)
    })

    /**
     * After `simulate` returns, every derived cell still holds its
     * pre-call value AND its `lastTime` is unchanged (queried via
     * `explain`'s `computedAt`).
     */
    it('does not mutate derived cells', () => {
      const g = createCausl()
      const a = g.input('a', 3)
      const sum = g.derived('sum', (get) => get(a) + 10)

      const beforeValue = g.read(sum)
      const beforeExplain = JSON.stringify(g.read(g.explain(sum)))

      g.simulate('preview', (tx) => tx.set(a, 100))

      expect(g.read(sum)).toBe(beforeValue)
      expect(JSON.stringify(g.read(g.explain(sum)))).toBe(beforeExplain)
    })
  })

  describe('errors return as part of the result', () => {
    /**
     * Writing to a derived node would throw {@link NotAnInputNodeError}
     * inside a real commit. `simulate` surfaces the same typed error
     * on the failed arm of the result without throwing at the caller.
     */
    it('predicts NotAnInputNodeError', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const sum = g.derived('sum', (get) => get(a) + 1)

      const result = g.simulate('bad', (tx) => {
        // @ts-expect-error — forcing the engine to surface the runtime guard
        tx.set(sum, 99)
      })
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBeInstanceOf(NotAnInputNodeError)
      expect(result.error).toBeInstanceOf(CauslError)
    })

    /**
     * Writing through a fabricated handle whose id is not registered
     * surfaces as a typed {@link UnknownNodeError}.
     */
    it('predicts UnknownNodeError', () => {
      const g = createCausl()
      const fake = { id: 'unregistered' } as unknown as InputNode<number>

      const result = g.simulate('ghost', (tx) => tx.set(fake, 42))
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBeInstanceOf(UnknownNodeError)
    })

    /**
     * Writing to a disposed input surfaces as a typed
     * {@link NodeDisposedError} — the typed disposal error
     * distinguishable from the generic unknown-id error.
     */
    it('predicts NodeDisposedError', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      dispose(g, a)

      const result = g.simulate('to-dead', (tx) => tx.set(a, 99))
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBeInstanceOf(NodeDisposedError)
    })

    /**
     * A captured `tx` reference used after the `run` callback
     * returned would have thrown {@link StaleTxError} inside a real
     * commit. The dry-run surfaces the same.
     */
    it('predicts StaleTxError', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      let escaped: Tx | null = null

      // First simulate captures the tx; result is clean because no
      // post-callback write was attempted.
      g.simulate('capture', (tx) => {
        escaped = tx
      })

      // Second simulate: try to use the escaped tx from the prior
      // simulate's body. The staleness guard is reset per simulate;
      // the captured handle is invalid because its `txAlive` flag was
      // flipped at the end of the first simulate.
      const result = g.simulate('use-stale', () => {
        ;(escaped as unknown as Tx).set(a, 99)
      })
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBeInstanceOf(StaleTxError)
    })

    /**
     * A user-thrown error inside the `run` callback flows through
     * the failed arm unchanged — `simulate` does not pretend to own
     * the user's exception hierarchy.
     */
    it('surfaces user-thrown errors on the failed arm', () => {
      const g = createCausl()
      const sentinel = new Error('user code panic')

      const result = g.simulate('panic', () => {
        throw sentinel
      })
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBe(sentinel)
    })

    /**
     * Cycles are caught at first-commit time (#705): the
     * registration-time DFS gate (#360) was dropped because it was
     * O(N²) on chains and overflowed the V8 stack on N > ~10000;
     * Phase D's augmented Kahn pass catches a latent cycle the
     * moment a commit walks into the SCC. Simulate borrows the same
     * Phase D pipeline, so a simulate that exercises a holder-mutated
     * latent cycle now resolves on the failed arm with a typed
     * `CycleError` — the same shape the corresponding commit() would
     * throw. This pins the parity guarantee: simulate predicts what
     * commit would do, and on the latent-cycle row that means
     * "failed with CycleError", not a silently-accepted clean
     * prediction.
     */
    it('matches commit on the latent-cycle path (caught at first-commit-time, #705)', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const holder: { ref: { id: string } | null } = { ref: null }
      g.derived<number>('m1', (get) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        holder.ref !== null ? (get(holder.ref as any) as number) : get(a),
      )
      const m2 = g.derived<number>('m2', (get) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get({ id: 'm1' } as any) as number,
      )
      holder.ref = m2

      // The latent cycle is now visible to Phase D the moment a
      // commit walks into the SCC. Simulate runs the same Phase D
      // body, so the cycle fires here with a CycleError on the
      // failed arm — same shape commit() would throw.
      const result = g.simulate('bump-a', (tx) => tx.set(a, 2))
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBeInstanceOf(CycleError)
    })

    /**
     * A user-defined compute that throws inside a derivation
     * triggered by a simulate's recompute surfaces the throw on the
     * failed arm — `simulate` mirrors `commit`'s behaviour when an
     * application-supplied compute panics during Phase D.
     */
    it('surfaces a derivation-compute throw on the failed arm', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const sentinel = new Error('compute panic')
      // The derivation throws when `a` is non-zero, falls through
      // when `a` is zero. Registration runs at `a=1` so we'd never
      // pass the registration walk... seed at zero and bump.
      g.commit('init', () => {
        // no-op — keeps a at 1, will overwrite below.
      })
      const a0 = g.input('a0', 0)
      g.derived<number>('panicy', (get) => {
        if (get(a0) > 0) throw sentinel
        return 1
      })

      // Simulate bumping `a0` to 5 → derived's compute throws.
      const result = g.simulate('panic', (tx) => tx.set(a0, 5))
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') return
      expect(result.error).toBe(sentinel)
      // a, a0 references kept alive for the linter
      void a
    })
  })

  describe('re-entrancy is the only failure that throws', () => {
    /**
     * `simulate` invoked from inside a `commit` callback throws
     * {@link CommitInProgressError} synchronously — same contract as
     * nested `commit`. Re-entrancy is structural, not transactional;
     * the engine refuses to nest its single mutation pipeline.
     */
    it('throws CommitInProgressError when nested inside a commit', () => {
      const g = createCausl()
      const a = g.input('a', 1)

      let captured: unknown = null
      expect(() =>
        g.commit('outer', () => {
          try {
            g.simulate('inner', (tx) => tx.set(a, 99))
          } catch (err) {
            captured = err
            throw err
          }
        }),
      ).toThrow(CommitInProgressError)
      expect(captured).toBeInstanceOf(CommitInProgressError)
    })

    /**
     * `simulate` invoked from inside another `simulate`'s callback
     * throws {@link CommitInProgressError} synchronously inside the
     * outer simulate's `run` body — the single-pipeline discipline
     * applies in both directions. The throw escapes `run`, lands in
     * the outer simulate's catch arm, and surfaces on the outer
     * simulate's failed result. This is the same shape any
     * engine-emitted error takes when escaping `run` mid-simulate.
     */
    it('inner simulate throws CommitInProgressError; outer surfaces it on failed', () => {
      const g = createCausl()
      const a = g.input('a', 1)

      let captured: unknown = null
      const outer = g.simulate('outer', () => {
        try {
          g.simulate('inner', (tx) => tx.set(a, 99))
        } catch (err) {
          captured = err
          throw err
        }
      })
      // The inner simulate threw — the user callback caught and
      // observed the typed error.
      expect(captured).toBeInstanceOf(CommitInProgressError)
      // The outer simulate then surfaced that throw on its failed arm
      // (the `run` callback re-threw it).
      expect(outer.status).toBe('failed')
      if (outer.status !== 'failed') return
      expect(outer.error).toBeInstanceOf(CommitInProgressError)
    })

    /**
     * The re-entrancy throw must not corrupt the outer simulate's
     * rollback. After the throw escapes the inner simulate (and
     * surfaces on the outer simulate's failed arm), the engine
     * returns to its pre-call state byte-identically.
     */
    it('rolls back cleanly after re-entrancy throw', () => {
      const g = createCausl()
      const a = g.input('a', 7)
      g.commit('seed', (tx) => tx.set(a, 7))
      const beforeNow = g.now
      const beforeValue = g.read(a)

      g.simulate('outer', () => {
        g.simulate('inner', () => {
          // never reached — re-entrancy throws synchronously
        })
      })

      expect(g.now).toBe(beforeNow)
      expect(g.read(a)).toBe(beforeValue)
      // and a real commit still works afterwards
      g.commit('after', (tx) => tx.set(a, 99))
      expect(g.now).toBe(beforeNow + 1)
    })
  })

  describe('engine state recovery — byte-equality after the call', () => {
    /**
     * The integration check: capture engine state via `exportModel`,
     * run a complex simulate, then capture again. The two snapshots
     * must serialise byte-identically.
     */
    it('exportModel() is byte-identical before and after a clean simulate', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      g.derived('sum', (get) => get(a) + get(b))
      g.derived('product', (get) => get(a) * get(b))
      g.commit('seed', (tx) => {
        tx.set(a, 10)
        tx.set(b, 20)
      })

      const before = JSON.stringify(g.exportModel())
      g.simulate('preview', (tx) => {
        tx.set(a, 999)
        tx.set(b, 888)
      })
      const after = JSON.stringify(g.exportModel())
      expect(after).toBe(before)
    })

    /**
     * Same byte-equality guarantee on the failed arm: a simulate
     * that surfaces a typed engine error must leave engine state
     * byte-identical to the pre-call moment.
     */
    it('exportModel() is byte-identical before and after a failed simulate', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const sum = g.derived('sum', (get) => get(a) + 1)
      g.commit('seed', (tx) => tx.set(a, 5))

      const before = JSON.stringify(g.exportModel())
      g.simulate('bad', (tx) => {
        // @ts-expect-error — forcing runtime guard
        tx.set(sum, 99)
      })
      const after = JSON.stringify(g.exportModel())
      expect(after).toBe(before)
    })
  })
})
