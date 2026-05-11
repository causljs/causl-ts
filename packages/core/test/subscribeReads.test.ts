/**
 * @packageDocumentation
 *
 * Behavioural contract for `graph.subscribeReads(observer, projection)`
 * — the engine-tracked-deps variant of `subscribeCommits` introduced
 * by SPEC §11.1 amended (#701). Pins the four contract clauses the
 * audit pulled out of the amendment:
 *
 * 1. Fires only when the projection's recorded read-set intersects
 *    the just-published commit's `changedNodes` — not on commits that
 *    move a node the projection never read.
 * 2. Conditional reads update the recorded read-set on each
 *    re-evaluation, so a projection that flips branches
 *    automatically follows the live branch and stops firing on the
 *    abandoned branch's writes.
 * 3. The returned disposer idempotently removes the registration —
 *    repeated calls are harmless and a fired-then-disposed observer
 *    receives no further notifications.
 * 4. The dispatch composes with #671's per-node subscriber index:
 *    the recorded deps live in the same `subscribeReadsByNode`
 *    bucket map, so Phase G walks only the registrations whose deps
 *    actually moved this commit.
 */

import { describe, expect, it, vi } from 'vitest'
import { createCausl } from '../src/index.js'

describe('graph.subscribeReads(observer, projection)', () => {
  /**
   * The headline acceptance: the observer fires only when the
   * projection's read-set intersects the commit's `changedNodes`.
   * A projection over `a` does not see commits that change only
   * `b`.
   */
  it('fires only when a node the projection read changes', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const fires: number[] = []
    g.subscribeReads<number>(
      (_commit, value) => fires.push(value),
      () => g.read(a),
    )

    // Initial fire — projection's value at registration is `1`.
    expect(fires).toEqual([1])

    // Commit on `b`: not in the projection's read-set, no fire.
    g.commit('b→3', (tx) => tx.set(b, 3))
    expect(fires).toEqual([1])

    // Commit on `a`: in the read-set, observer fires with the new value.
    g.commit('a→10', (tx) => tx.set(a, 10))
    expect(fires).toEqual([1, 10])

    // Another commit on `b`: still no fire.
    g.commit('b→4', (tx) => tx.set(b, 4))
    expect(fires).toEqual([1, 10])
  })

  /**
   * Conditional reads: the projection initially reads `flag` and
   * `a`; after `flag` flips and the projection re-runs, the
   * recorded read-set becomes `{flag, b}`. Subsequent writes to `a`
   * must NOT fire the observer because `a` is no longer in the
   * recorded set. This is the "follow the live branch" promise the
   * audit requires.
   */
  it('updates the recorded read-set on conditional re-evaluation', () => {
    const g = createCausl()
    const flag = g.input('flag', false)
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const fires: number[] = []
    g.subscribeReads<number>(
      (_commit, value) => fires.push(value),
      () => (g.read(flag) ? g.read(b) : g.read(a)),
    )

    // Initial fire: projection reads flag (false) → reads `a` (1).
    // Recorded deps are {flag, a}.
    expect(fires).toEqual([1])

    // Write to `a` — in the recorded set, observer fires with `2`.
    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(fires).toEqual([1, 2])

    // Flip the flag — `flag` is in the recorded set so the
    // projection re-runs. New read-set is {flag, b}; new value is
    // `b` = 2. Observer fires with `2` (the value of b).
    g.commit('flag→true', (tx) => tx.set(flag, true))
    expect(fires).toEqual([1, 2, 2])

    // Write to `a` — `a` is no longer in the recorded set. No fire.
    g.commit('a→99', (tx) => tx.set(a, 99))
    expect(fires).toEqual([1, 2, 2])

    // Write to `b` — newly in the recorded set, observer fires.
    g.commit('b→5', (tx) => tx.set(b, 5))
    expect(fires).toEqual([1, 2, 2, 5])
  })

  /**
   * The disposer returned from `subscribeReads` removes the
   * registration. Subsequent commits — even on nodes the projection
   * read — must not fire the observer. The disposer is idempotent:
   * a second call is a harmless no-op and does not throw.
   */
  it('returns an idempotent unsubscribe', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const obs = vi.fn()
    const dispose = g.subscribeReads<number>(obs, () => g.read(a))

    // Initial fire on registration.
    expect(obs).toHaveBeenCalledTimes(1)

    g.commit('a→2', (tx) => tx.set(a, 2))
    expect(obs).toHaveBeenCalledTimes(2)

    dispose()
    g.commit('a→3', (tx) => tx.set(a, 3))
    expect(obs).toHaveBeenCalledTimes(2)

    // Idempotent — second call is a no-op, does not throw.
    expect(() => dispose()).not.toThrow()
    g.commit('a→4', (tx) => tx.set(a, 4))
    expect(obs).toHaveBeenCalledTimes(2)
  })

  /**
   * The audit's per-node-index composition test (#671): a registration
   * over node `a` lives in the same `changed → bucket` lookup the
   * per-node subscriber walk uses. We verify the shape externally by
   * asserting that a 1000-registrant graph in which all 1000
   * registrations read `a` and only `b` changes does NOT fire any
   * observer — the bucket lookup misses on `b` and the entire fan
   * is skipped. (Internally this is `subscribeReadsByNode.get(b) ===
   * undefined` followed by `continue`; externally it surfaces as a
   * tally of zero observer fires after one commit.)
   */
  it('composes with #671 per-node index — registrations on `a` are not visited when only `b` changes', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    let fireCount = 0

    // Register 1000 projections over `a`. Each registration's
    // initial fire bumps `fireCount` once, so we capture the
    // baseline after registration.
    const disposers: Array<() => void> = []
    for (let i = 0; i < 1000; i++) {
      disposers.push(
        g.subscribeReads<number>(
          () => {
            fireCount++
          },
          () => g.read(a),
        ),
      )
    }
    expect(fireCount).toBe(1000) // initial fires only

    // Commit on `b` — none of the 1000 registrations record `b`,
    // so the `subscribeReadsByNode.get(b)` lookup returns
    // `undefined` and Phase G skips the entire fan. fireCount
    // stays at 1000.
    g.commit('b→1', (tx) => tx.set(b, 1))
    expect(fireCount).toBe(1000)

    // Commit on `a` — all 1000 registrations have `a` in their
    // recorded deps, so all 1000 observers fire exactly once.
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(fireCount).toBe(2000)

    for (const dispose of disposers) dispose()
  })

  /**
   * A projection that reads multiple nodes which all move in one
   * commit must fire its observer exactly once — the same
   * "exactly one notification per commit" contract `subscribe`
   * enforces via the `Object.is(lastValue, v)` cutoff. The
   * `subscribeReads` dispatch dedupes via a per-commit `fired`
   * Set so a multi-dep registration doesn't get visited once per
   * changed dep.
   */
  it('fires the observer at most once per commit', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    let fires = 0
    g.subscribeReads<number>(
      () => {
        fires++
      },
      () => g.read(a) + g.read(b),
    )

    expect(fires).toBe(1) // initial fire

    // One commit moves both `a` and `b` — projection deps are
    // {a, b}. Observer fires exactly once.
    g.commit('a,b', (tx) => {
      tx.set(a, 10)
      tx.set(b, 20)
    })
    expect(fires).toBe(2)
  })

  /**
   * The observer receives the just-published `Commit` record so
   * adopters can branch on `commit.intent` / `commit.changedNodes`
   * without needing to subscribe to `subscribeCommits` separately.
   */
  it('passes the just-published commit alongside the projection value', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const seen: Array<{ time: number; intent: string; value: number }> = []
    g.subscribeReads<number>(
      (commit, value) => {
        seen.push({ time: commit.time, intent: commit.intent, value })
      },
      () => g.read(a),
    )

    // Initial fire records the registration moment.
    expect(seen[0]?.intent).toBe('subscribe-reads-initial')
    expect(seen[0]?.value).toBe(1)

    g.commit('bump', (tx) => tx.set(a, 7))
    expect(seen[1]?.intent).toBe('bump')
    expect(seen[1]?.value).toBe(7)
  })

  /**
   * Projections that read derived nodes work the same way:
   * `subscribeReads` records the derived id in the read-set, and a
   * commit that propagates a change through to the derived fires
   * the observer with the recomputed value.
   */
  it('tracks reads through derived nodes', () => {
    const g = createCausl()
    const a = g.input('a', 2)
    const doubled = g.derived('doubled', (get) => get(a) * 2)
    const fires: number[] = []
    g.subscribeReads<number>(
      (_commit, value) => fires.push(value),
      () => g.read(doubled),
    )

    expect(fires).toEqual([4])

    g.commit('a→5', (tx) => tx.set(a, 5))
    expect(fires).toEqual([4, 10])
  })

  /**
   * A throwing projection during a Phase G re-run must not abort
   * the commit pipeline. The throw is reported through the
   * observer-error channel; the registration's `recordedDeps` is
   * left intact so the next commit retries.
   */
  it('isolates a throwing projection during Phase G re-run', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const errors: Array<{ source: string }> = []
    const g2 = createCausl({
      onObserverError: (_err, ctx) => {
        errors.push({ source: ctx.source })
      },
    })
    const a2 = g2.input('a', 1)
    let shouldThrow = false
    g2.subscribeReads<number>(
      () => {},
      () => {
        if (shouldThrow) throw new Error('proj-fail')
        return g2.read(a2)
      },
    )
    shouldThrow = true
    expect(() =>
      g2.commit('a→2', (tx) => tx.set(a2, 2)),
    ).not.toThrow()
    expect(errors.some((e) => e.source === 'subscribe-reads-projection')).toBe(
      true,
    )
    // Ensure original graph still runs cleanly (sanity).
    g.commit('a→2', (tx) => tx.set(a, 2))
  })
})
