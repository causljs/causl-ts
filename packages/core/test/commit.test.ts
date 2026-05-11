/**
 * @packageDocumentation
 *
 * Behavioural pinning for `graph.commit(intent, tx => ...)`, the sole
 * mechanism by which GraphTime advances in the engine. Each suite below
 * stages a graph, runs one or more commits, and asserts on the resulting
 * `Commit` record (time, intent, changed-node set), on the visibility
 * rules inside the transaction callback, and on the runtime guards that
 * protect against nested commits, derived-node writes, and stale-handle
 * abuse.
 *
 * The contract being pinned: there is one mutation API. `commit` produces
 * exactly one new `GraphTime`. Outside a commit, the graph is read-only.
 * Inside a commit, reads see staged writes; outside, reads see the
 * previous committed snapshot. There is no "concurrent mutation" question
 * because there is no concurrent mutation API. From the denotational side,
 * a transaction creates exactly one new `t` — there is no fractional
 * time, which is what makes atomicity a theorem rather than a goal.
 */

import { describe, expect, it } from 'vitest'
import {
  CommitInProgressError,
  createCausl,
  NodeDisposedError,
  NotAnInputNodeError,
  StaleTxError,
  UnknownNodeError,
} from '../src/index.js'
import { dispose } from '../src/internal.js'

/**
 * Pins the runtime contract of `graph.commit`: time advancement, change-set
 * reporting, intra-commit visibility, and the error-on-misuse guards.
 *
 * Commit is the only operation that advances time, and it advances it by
 * exactly one tick — atomicity is a structural property, not a hope.
 */
describe('graph.commit(intent, tx => ...)', () => {
  /**
   * A successful commit advances `graph.now` by exactly one tick and stamps
   * the returned `Commit` record with that fresh GraphTime plus the caller's
   * intent label.
   */
  it('produces exactly one new GraphTime per call', () => {
    // arrange: a single input node on a fresh graph at t=0.
    const g = createCausl()
    const a = g.input('a', 0)
    // act: two sequential commits, each mutating `a`.
    const c1 = g.commit('w1', (tx) => tx.set(a, 1))
    expect(c1.time).toBe(1)
    expect(g.now).toBe(1)
    const c2 = g.commit('w2', (tx) => tx.set(a, 2))
    // assert: time advanced by one per commit, and intents round-trip.
    expect(c2.time).toBe(2)
    expect(c1.intent).toBe('w1')
    expect(c2.intent).toBe('w2')
  })

  /**
   * The `changedNodes` field of a `Commit` enumerates every node id whose
   * value differs at the new GraphTime, including transitively-affected
   * derivations, but excludes nodes that retained their previous value.
   */
  it('returns the set of changed node ids', () => {
    // arrange: two inputs feeding one derived sum.
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    g.derived('sum', (get) => get(a) + get(b))
    // act: commit mutates only `a`; `sum` recomputes; `b` stays untouched.
    const c = g.commit('bump-a', (tx) => tx.set(a, 5))
    // assert: change-set covers the input and its dependent, excludes the bystander.
    expect(c.changedNodes).toContain('a')
    expect(c.changedNodes).toContain('sum')
    expect(c.changedNodes).not.toContain('b')
  })

  /**
   * Atomicity of intent: staged writes performed earlier in the transaction
   * callback are observable to derivations evaluated later in the same
   * commit, so a single commit yields one consistent post-state to subscribers.
   */
  it('writes inside a tx are visible to derivations within the same commit', () => {
    // arrange: subscriber captures sum values across commits.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    const observed: number[] = []
    g.subscribe(sum, (v) => observed.push(v))
    // act: a commit setting both inputs at once.
    g.commit('bump-both', (tx) => {
      tx.set(a, 10)
      tx.set(b, 20)
    })
    // assert: a single post-commit notification with the joint result, no
    // intermediate `12` glitch from observing the half-applied state.
    expect(observed).toEqual([3, 30])
  })

  /**
   * GraphTime is reserved for post-commit observers. Reads issued inside the
   * transaction callback see the staged values (intra-commit visibility),
   * but `g.now` does not tick until the callback returns successfully.
   */
  it('does not advance time mid-commit; reads outside see the old value', () => {
    // arrange: lone input at value 1.
    const g = createCausl()
    const a = g.input('a', 1)
    let observedDuring = -1
    // act: stage a write and immediately re-read inside the same callback.
    g.commit('peek', (tx) => {
      tx.set(a, 99)
      observedDuring = g.read(a)
    })
    // assert: intra-commit reads observe the staged value.
    expect(observedDuring).toBe(99)
  })

  /**
   * Re-entering `commit` from within a running transaction violates the
   * single-writer invariant. The engine surfaces this as `CommitInProgressError`
   * at the inner call site rather than allowing interleaved time advancement.
   */
  it('rejects nested commits with CommitInProgressError', () => {
    // arrange: graph with a single input.
    const g = createCausl()
    const a = g.input('a', 0)
    // act + assert: an inner `commit` invoked while the outer one is open
    // should throw before performing any mutation.
    expect(() =>
      g.commit('outer', () => {
        g.commit('inner', (tx) => tx.set(a, 1))
      }),
    ).toThrow(CommitInProgressError)
  })

  /**
   * Only input nodes are writable. Attempting to stage a value onto a derived
   * node via `tx.set` is a category error and throws `NotAnInputNodeError`
   * even though the type system already discourages it.
   */
  it('rejects tx.set on a derived node with NotAnInputNodeError', () => {
    // arrange: an input plus a derivation depending on it.
    const g = createCausl()
    const a = g.input('a', 0)
    const d = g.derived('d', (get) => get(a))
    // act + assert: writing to the derived handle is a runtime error,
    // bypassing the `@ts-expect-error` to validate the guard, not the types.
    expect(() =>
      g.commit('bad', (tx) => {
        // @ts-expect-error — runtime guard test
        tx.set(d, 1)
      }),
    ).toThrow(NotAnInputNodeError)
  })

  /**
   * The transaction handle is bound to the lifetime of its callback. Holding
   * onto `tx` past callback return and writing through it must fail with
   * `StaleTxError` rather than silently mutating the next commit's state.
   */
  it('rejects tx.set after the callback returned (StaleTxError)', () => {
    // arrange: capture the tx handle past the end of its commit.
    const g = createCausl()
    const a = g.input('a', 0)
    let stolen: { set: (n: typeof a, v: number) => void } | null = null
    g.commit('steal', (tx) => {
      stolen = tx
    })
    // act + assert: reusing the now-expired handle throws.
    expect(() => stolen!.set(a, 1)).toThrow(StaleTxError)
  })

  /**
   * Every successful `commit` is a discrete Event Commit, including those
   * that perform no writes. The denotational definition makes commit the
   * sole event that advances `GraphTime`; whether or not the callback
   * staged a write, the call still creates exactly one new `t` and
   * returns the resulting `Commit` record.
   */
  /**
   * `tx.set` validates the target through the same `getEntry` gate as
   * every read-side primitive: a fabricated node descriptor whose id
   * was never registered on this graph faults with `UnknownNodeError`
   * rather than silently allocating a slot. Pinning the write-side
   * symmetry of SPEC §12.1's canonical-seven entry guard closes the
   * fabricated-id row of SPEC §9.1.
   */
  it('rejects tx.set on an unregistered node id with UnknownNodeError', () => {
    // arrange: graph with one real input plus a hand-crafted fake handle
    // that mimics the InputNode shape but carries an id no graph has seen.
    const g = createCausl()
    g.input('a', 0)
    const fake = { id: 'never-registered' } as unknown as ReturnType<
      typeof g.input<number>
    >
    // act + assert: the entry-table guard fires at the write site.
    expect(() =>
      g.commit('fake', (tx) => {
        tx.set(fake, 1)
      }),
    ).toThrow(UnknownNodeError)
  })

  /**
   * Disposal records a tombstone keyed by node id; subsequent `tx.set`
   * calls on the released handle surface `NodeDisposedError` rather
   * than the generic `UnknownNodeError`, so adapter authors can branch
   * on "released" vs. "never registered" — the discriminated-tag
   * contract on the use-after-dispose row of SPEC §9.1.
   */
  it('rejects tx.set on a disposed node with NodeDisposedError', () => {
    // arrange: register an input, then release it through the adapter hook.
    const g = createCausl()
    const a = g.input('a', 0)
    dispose(g, a)
    // act + assert: the tombstone routes the write through the typed guard.
    expect(() =>
      g.commit('after-dispose', (tx) => {
        tx.set(a, 1)
      }),
    ).toThrow(NodeDisposedError)
  })

  it('a commit with no writes still advances time', () => {
    // arrange: pristine graph at t=0.
    const g = createCausl()
    expect(g.now).toBe(0)
    // act: commit with an empty callback.
    const c = g.commit('noop', () => {
      /* no-op */
    })
    // assert: the new GraphTime is recorded even with no state delta.
    expect(c.time).toBe(1)
    expect(g.now).toBe(1)
  })
})
