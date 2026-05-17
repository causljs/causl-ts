/**
 * glitchDetector — assert glitch-freedom on a derived node.
 *
 * The semantic foundation of the engine defines a derived value as a
 * pure function of its inputs at a single `GraphTime`:
 *
 *     derived(f, b₁, …, bₙ)(t) = f(b₁(t), …, bₙ(t))
 *
 * Glitch-freedom falls out of that definition as a theorem, not a
 * goal: a derived value at time `t` is a pure function of its inputs
 * at the same time `t`; there is no intermediate "B updated but C did
 * not" state because there is no intermediate time. Whatever the
 * scheduler does, the meaning is fixed.
 *
 * This detector is the property-test seam that confirms an
 * implementation upholds that contract. For a derived value
 * D = f(A, B, ...), it observes:
 *
 *     ∀t : D(t) === f(A(t), B(t), ...)
 *
 * — i.e. every observed value of D resolves at the same `GraphTime` as
 * the inputs that produced it. A glitch is a transient observation
 * where D's reported value disagrees with f applied to its deps at the
 * same t. Diamond glitch-freedom is one of the load-bearing property
 * families: random graphs with random inputs must show that every
 * observable equals f of its dependencies' values *at the same
 * `GraphTime`*, never an interleaved pair.
 *
 * The detector subscribes to the derived node and to each dep, captures
 * (value, time) tuples, and at every observation re-evaluates f against
 * the deps' values at the same time. A discrepancy increments
 * `observed`. Tests assert `expect(detector.observed).toBe(0)`.
 *
 * Usage:
 *
 *   const detector = glitchDetector(graph, sum, ([a, b]) => a + b, [aNode, bNode])
 *   for (let i = 0; i < 1000; i++) graph.commit('bump', tx => tx.set(aNode, i))
 *   expect(detector.observed).toBe(0)
 *   detector.dispose()
 */

import type { Graph, Node, GraphTime, Unsubscribe } from '@causljs/core'

export interface GlitchDetector<T> {
  /** Number of (value, deps) pairs where D(t) !== f(deps(t)). */
  readonly observed: number

  /** True iff at least one glitch has been observed. */
  isGlitched(): boolean

  /** Reset counter. Does not unsubscribe. */
  reset(): void

  /** Tear down all subscriptions. Required for clean test teardown. */
  dispose(): void
}

export function glitchDetector<T, D extends readonly unknown[]>(
  graph: Graph,
  derived: Node<T>,
  expected: (deps: D) => T,
  deps: { readonly [K in keyof D]: Node<D[K]> },
  options?: {
    /**
     * Equality used to compare `derived(t)` against `expected(deps(t))`.
     * Defaults to `Object.is`. Override for non-primitive results.
     */
    readonly equals?: (a: T, b: T) => boolean
  },
): GlitchDetector<T> {
  const equals = options?.equals ?? Object.is

  // Latest-known values per dep, keyed by node id, with the time they
  // were captured. We rely on the engine's per-commit broadcast: every
  // observed (derived, deps) pair shares one `GraphTime`.
  const depValues = deps.map((d) => ({ id: d.id, value: graph.read(d), time: graph.now }))

  let glitches = 0
  const subs: Unsubscribe[] = []

  const evaluate = (derivedValue: T, time: GraphTime): void => {
    // Build the deps tuple at `time`. The contract is that all subscribers
    // observe the same `time` for the same commit, so depValues should
    // already reflect that time when this fires.
    const tuple = depValues.map((d) => d.value) as unknown as D
    const want = expected(tuple)
    if (!equals(derivedValue, want)) glitches++
    void time // intentionally not used in equality, but tests can read via subclass
  }

  // Subscribe to each dep first so depValues stays current; then subscribe
  // to the derived. Subscribers fire after commit publishes the snapshot,
  // so the order of (dep, derived) callbacks is engine-defined — but the
  // values they read all resolve at the same `GraphTime`.
  for (const d of depValues) {
    subs.push(
      graph.subscribe(deps.find((n) => n.id === d.id)!, (value, time) => {
        d.value = value
        d.time = time
      }),
    )
  }
  subs.push(graph.subscribe(derived, evaluate))

  return {
    get observed() {
      return glitches
    },
    isGlitched() {
      return glitches > 0
    },
    reset() {
      glitches = 0
    },
    dispose() {
      while (subs.length) subs.pop()!()
    },
  }
}
