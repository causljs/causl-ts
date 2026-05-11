/**
 * @packageDocumentation
 *
 * Behavioural pinning for `graph.derived(id, compute)`: initial-value
 * computation, dynamic dependency tracking via `get`, dependency-set cleanup
 * across branches, transitive recomputation through stacked derivations,
 * glitch-freedom on diamond shapes, and the registration-time guards against
 * duplicate ids and cycles. Each test stages a small graph, triggers
 * commits where relevant, and reads or counts recomputations to pin the
 * contract.
 *
 * The denotational rule we are anchoring against is
 * `derived(f, b₁,…,bₙ)(t) = f(b₁(t), …, bₙ(t))` — a derived value at time
 * `t` is a pure function of its inputs at the same time `t`. There is no
 * intermediate "B updated but C did not" state because there is no
 * intermediate time. Two consequences fall out for free: glitch-freedom
 * (the bad state is not representable), and determinism (two
 * implementations either agree or one of them is wrong). The performance
 * shape we lean on is the correctness criterion that a commit producing
 * N derived recomputations runs in O(N), bounded by the affected
 * subgraph — dirty marking and dependency walking do not scan the whole
 * graph.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, CycleError, DuplicateNodeError } from '../src/index.js'

/**
 * Pins the contract of derived nodes: registration semantics, dependency
 * capture, recomputation, glitch-free reads, and structural guards.
 *
 * Derived values are defined as `derived(t) = f(b₁(t), …, bₙ(t))`, and the
 * scheduler must keep recompute cost proportional to the affected subgraph
 * rather than to total graph size.
 */
describe('graph.derived(id, compute)', () => {
  /**
   * On registration, the compute function runs once with the current input
   * values, so a subsequent read returns that derived value without needing
   * an intervening commit.
   */
  it('computes its initial value from its inputs at registration', () => {
    // arrange: two inputs feeding a sum derivation.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    // assert: derived value is computed at registration time.
    expect(g.read(sum)).toBe(3)
  })

  /**
   * Dependencies are tracked dynamically through the `get` callback supplied
   * to the compute function, so each subsequent commit on a tracked input
   * propagates into the derived value on the next read.
   */
  it('captures dynamic dependencies through `get` calls', () => {
    // arrange: two inputs feeding a sum derivation.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 10)
    const sum = g.derived('sum', (get) => get(a) + get(b))
    // act + assert: each input mutation flows through to the derived value.
    g.commit('a→5', (tx) => tx.set(a, 5))
    expect(g.read(sum)).toBe(15)
    g.commit('b→100', (tx) => tx.set(b, 100))
    expect(g.read(sum)).toBe(105)
  })

  /**
   * Conditional reads imply branch-sensitive dependency sets. After a branch
   * flips, inputs that were read on the prior branch but not the current one
   * are dropped from the dep set, so mutating them no longer triggers a
   * recompute.
   */
  it('cleans up old dependencies when a derivation switches inputs', () => {
    // arrange: a flag-controlled choice between x and y; initially picks y.
    const g = createCausl()
    const flag = g.input('flag', false)
    const x = g.input('x', 1)
    const y = g.input('y', 100)
    const choice = g.derived('choice', (get) => (get(flag) ? get(x) : get(y)))
    expect(g.read(choice)).toBe(100)

    // act: flip to the x branch; choice now reads x and ignores y.
    g.commit('flip', (tx) => tx.set(flag, true))
    expect(g.read(choice)).toBe(1)

    // arrange: counter derivation observes recompute frequency of choice.
    // Mutating y should NOT cause a recompute of choice now that flag=true.
    let recomputes = 0
    g.derived('observed', (get) => {
      recomputes++
      return get(choice)
    })
    const baseline = recomputes
    // act + assert: a y-only commit must not propagate to choice.
    g.commit('y→999', (tx) => tx.set(y, 999))
    expect(recomputes).toBe(baseline) // y is no longer in choice's dep set
    expect(g.read(choice)).toBe(1)

    // act + assert: an x commit, in contrast, does propagate.
    // But mutating x should.
    g.commit('x→42', (tx) => tx.set(x, 42))
    expect(g.read(choice)).toBe(42)
  })

  /**
   * Derivations that read other derivations (chain B → C → D) recompute in
   * topological order, so a single input mutation flows through all
   * downstream layers before any reader observes the new state.
   */
  it('supports stacked derivations (B → C → D)', () => {
    // arrange: chain a → b → c.
    const g = createCausl()
    const a = g.input('a', 2)
    const b = g.derived('b', (get) => get(a) * 2)
    const c = g.derived('c', (get) => get(b) + 1)
    expect(g.read(c)).toBe(5)
    // act: mutate the leaf input.
    g.commit('a→10', (tx) => tx.set(a, 10))
    // assert: both intermediate and tail derivations reflect the new state.
    expect(g.read(b)).toBe(20)
    expect(g.read(c)).toBe(21)
  })

  /**
   * Glitch-freedom: in a diamond `a → {b, c} → d`, every observation of `d`
   * combines `b(t)` and `c(t)` for the same GraphTime `t`. Subscribers never
   * see a transient mix of pre- and post-commit values across siblings,
   * because a derived value at time `t` is a pure function of its inputs at
   * that same `t` — there is no intermediate "B updated but C did not"
   * state because there is no intermediate time. The denotational equation
   * makes the bad state non-existent, so this test asserts what the
   * semantics already require.
   */
  it('produces glitch-free diamond reads', () => {
    // arrange: diamond a → {b, c} → d, with a subscriber on d.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.derived('b', (get) => get(a) + 1)
    const c = g.derived('c', (get) => get(a) * 10)
    const observed: string[] = []
    const d = g.derived('d', (get) => `${get(b)}|${get(c)}`)
    g.subscribe(d, (v) => observed.push(v))
    // act: two commits on the shared root.
    g.commit('a→5', (tx) => tx.set(a, 5))
    g.commit('a→7', (tx) => tx.set(a, 7))
    // assert: every observation pairs b(t) and c(t) at the same GraphTime.
    // Every observed value is f(b(t), c(t)) for the SAME t.
    expect(observed).toEqual(['2|10', '6|50', '8|70'])
  })

  /**
   * Node ids form a global namespace within a graph. Registering a second
   * node under an id already in use throws `DuplicateNodeError` synchronously
   * at registration.
   */
  it('rejects duplicate ids', () => {
    // arrange + act: register a derivation at id "foo".
    const g = createCausl()
    g.derived('foo', () => 1)
    // assert: a second registration at the same id throws.
    expect(() => g.derived('foo', () => 2)).toThrow(DuplicateNodeError)
  })

  /**
   * Cycles in the dependency graph are illegal. Registering a derivation
   * that reads its own id closes a cycle on first evaluation, and the
   * engine surfaces this as `CycleError` rather than recursing or stalling.
   */
  it('detects cycles at the first commit that closes them', () => {
    // arrange + act + assert: a self-referential derivation must throw.
    const g = createCausl()
    // Static cycle: derive a node that reads itself.
    expect(() =>
      g.derived<number>('cyc', (get) =>
        get<number>({ id: 'cyc' }),
      ),
    ).toThrow(CycleError)
  })
})
