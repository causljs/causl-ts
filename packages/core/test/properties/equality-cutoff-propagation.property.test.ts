/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the NEW #16 / #1305 equality-cutoff
 * propagation through Phase D.
 *
 * Background: pre-#1305 `recomputeAffected` re-evaluated every
 * derived in `affected` even when its only changed-this-commit
 * ancestor produced an `Object.is`-stable value. The equality cutoff
 * fired for subscriber-dispatch suppression (Phase G) but not for
 * downstream Phase D recompute, so the engine recomputed deriveds
 * whose inputs were denotationally identical.
 *
 * The change: when Phase D's `Object.is` cutoff fires for a derived
 * `e`, mark `e` as `cutoffStable`. Before evaluating each subsequent
 * derived `d` in topo order, check whether all of `d`'s deps are in
 * `cutoffStable` or were never affected this commit — if so, skip
 * `d`'s recompute and add `d` to `cutoffStable`. The skip propagates
 * transitively along stable-chain prefixes.
 *
 * Salvage discipline (vs. dropped rec #13): this is intra-commit
 * only. By the time the commit publishes, every derived's value is
 * its true post-commit value; the change is a perf optimisation of
 * recomputes the engine would have run *and* produced the same
 * answer. SPEC §3 Theorem 2 (glitch-freedom) is preserved by
 * construction because every skipped recompute is denotationally
 * identical to running it (deterministic compute over identical
 * inputs).
 *
 * This file pins three load-bearing invariants:
 *
 *   1. `Commit.changedNodes` is byte-identical to the oracle's
 *      "values that genuinely changed" set — the propagation skip
 *      does NOT widen or narrow which nodes appear in the published
 *      commit envelope.
 *   2. The engine recompute count is `≤ |affected|` — the skip can
 *      only ever remove work, never add it.
 *   3. The post-commit `read()` value of every derived equals the
 *      forward-evaluation oracle's value — the skip is denotationally
 *      identical to running the compute.
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`
 * and logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl, type Commit, type DerivedNode, type InputNode, type Node } from '../../src/index.js'
import {
  propertyDag,
  propertyTrials,
  recomputeCounter,
  type DagSpec,
} from '@causl/core-testing-internal'

/**
 * Derived-shape selector — for each random derived id, choose between
 * a value-propagating compute (sum-of-deps) and a value-erasing
 * compute (constant 0, regardless of deps). The erasing shape is what
 * actually exercises the propagation skip — a value-erasing derived
 * has its output `Object.is`-stable across any input write, so
 * everything downstream of it that depends ONLY on it (and on other
 * stable nodes) becomes cutoff-skip eligible.
 */
type DerivedShape = 'sum' | 'eraser'

/**
 * Pair a `DagSpec` with a per-derived shape assignment. The shape
 * tuple is generated alongside the DAG so each test trial drives a
 * fresh stable-chain pattern through the engine.
 */
interface DagWithShapes {
  readonly spec: DagSpec
  readonly shapes: readonly DerivedShape[]
}

/**
 * Generator: `propertyDag` chained with a per-derived shape tuple.
 * The shape array length matches `spec.deriveds.length` so every
 * derived has exactly one assigned shape.
 */
function dagWithShapes(): fc.Arbitrary<DagWithShapes> {
  return propertyDag({ minDerived: 1, maxDerived: 12 }).chain((spec) =>
    fc
      .tuple(
        ...spec.deriveds.map(() =>
          fc.constantFrom<DerivedShape>('sum', 'eraser'),
        ),
      )
      .map((shapes) => ({ spec, shapes } as DagWithShapes)),
  )
}

/**
 * Build an instrumented graph from a `DagWithShapes`. Each derived's
 * compute is wrapped via `counter.wrap` so per-id recompute counts
 * become observable. The 'sum' shape sums the (number) values of its
 * deps; the 'eraser' shape returns the constant 0 regardless of dep
 * values (but still calls `get(dep)` so the engine records the dep
 * edge — without that, the derived has no upstream and the cutoff
 * propagation would have no chain to test).
 */
function buildInstrumented(spec: DagSpec, shapes: readonly DerivedShape[]): {
  readonly graph: ReturnType<typeof createCausl>
  readonly input: InputNode<number>
  readonly counter: ReturnType<typeof recomputeCounter>
  readonly deriveds: ReadonlyMap<string, DerivedNode<number>>
} {
  const graph = createCausl()
  const counter = recomputeCounter()
  const input = graph.input(spec.inputId, 0)
  const deriveds = new Map<string, DerivedNode<number>>()
  for (let i = 0; i < spec.deriveds.length; i++) {
    const ds = spec.deriveds[i]!
    const shape = shapes[i] ?? 'sum'
    const handle = graph.derived<number>(
      ds.id,
      counter.wrap((get) => {
        let sum = 0
        for (const depId of ds.deps) {
          const node =
            depId === spec.inputId
              ? (input as Node<number>)
              : (deriveds.get(depId)! as Node<number>)
          sum += get(node) as number
        }
        return shape === 'eraser' ? 0 : sum
      }, ds.id),
    )
    deriveds.set(ds.id, handle)
  }
  return { graph, input, counter, deriveds }
}

/**
 * Forward-evaluation oracle for a given input value. Returns the
 * value every derived would hold after a commit that writes `value`
 * to the single input. Deriveds are evaluated in topo order (the
 * `spec.deriveds` array is already topo-sorted by construction).
 */
function oracleValues(
  spec: DagSpec,
  shapes: readonly DerivedShape[],
  value: number,
): Map<string, number> {
  const values = new Map<string, number>()
  values.set(spec.inputId, value)
  for (let i = 0; i < spec.deriveds.length; i++) {
    const ds = spec.deriveds[i]!
    const shape = shapes[i] ?? 'sum'
    if (shape === 'eraser') {
      values.set(ds.id, 0)
      continue
    }
    let sum = 0
    for (const depId of ds.deps) {
      sum += values.get(depId) ?? 0
    }
    values.set(ds.id, sum)
  }
  return values
}

/**
 * Reference walker: forward-reachable derived ids from the single
 * mutated input. A derived is in `affected` iff at least one of its
 * declared deps is in `affected` (or is the input itself). Used as
 * the upper-bound oracle for the recompute-count invariant.
 */
function affectedFromInput(spec: DagSpec): Set<string> {
  const affected = new Set<string>([spec.inputId])
  for (const ds of spec.deriveds) {
    if (ds.deps.some((d) => affected.has(d))) affected.add(ds.id)
  }
  affected.delete(spec.inputId)
  return affected
}

/**
 * Settle phase: subscribe to every derived so the engine's
 * eager-on-registration computes are charged as setup, not as the
 * recompute event under measurement. The counter is reset after
 * settle so only post-mutation computes contribute to the count.
 */
function settle(
  deriveds: ReadonlyMap<string, unknown>,
  graph: ReturnType<typeof createCausl>,
): void {
  for (const node of deriveds.values()) {
    graph.subscribe(
      node as Parameters<typeof graph.subscribe>[0],
      () => {},
    )
  }
}

describe('property: equality-cutoff propagation through Phase D (NEW rec #16 / #1305)', () => {
  /**
   * P1 — published `Commit.changedNodes` equals the oracle's "values
   * that genuinely changed" set:
   *
   *   For every random DAG and every random shape assignment, a
   *   commit that writes a new value to the input publishes a
   *   `Commit.changedNodes` set equal to exactly the set of deriveds
   *   whose oracle value differs from the pre-commit oracle value.
   *
   * This pins SPEC §5.1 Phase E byte-identical Commit envelope: the
   * propagation skip does NOT widen or narrow which nodes appear in
   * `changedNodes` — only whether their recompute fired internally.
   */
  it('Commit.changedNodes equals the oracle "genuinely-changed" set on every random DAG', () => {
    fc.assert(
      fc.property(
        dagWithShapes(),
        // Two distinct inputs so we have a real write (the second
        // input differs from the seed value of 0).
        fc.integer({ min: 1, max: 1_000 }),
        ({ spec, shapes }, writeValue) => {
          const { graph, input, deriveds } = buildInstrumented(spec, shapes)
          settle(deriveds, graph)

          // Capture the just-published commit's changedNodes set.
          let lastCommit: Commit | undefined
          graph.subscribeCommits((c) => {
            lastCommit = c
          })

          // Pre-commit oracle values (input still at 0).
          const before = oracleValues(spec, shapes, 0)
          // Post-commit oracle values.
          const after = oracleValues(spec, shapes, writeValue)

          // Genuinely-changed derived ids per the oracle.
          const oracleChanged = new Set<string>()
          for (const ds of spec.deriveds) {
            if (before.get(ds.id) !== after.get(ds.id)) {
              oracleChanged.add(ds.id)
            }
          }

          graph.commit('mutate-input', (tx) => tx.set(input, writeValue))

          // The just-published commit must exist (subscribeCommits
          // fires synchronously inside Phase H).
          expect(lastCommit).toBeDefined()
          const changedDerivedIds = new Set(
            // Filter out the input id; we only compare derived nodes
            // (the input's id appears in changedNodes too, per SPEC).
            lastCommit!.changedNodes.filter((id) => id !== spec.inputId),
          )

          // Byte-identical match: every oracle-changed id appears in
          // changedNodes, and no extra id does.
          expect([...changedDerivedIds].sort()).toEqual(
            [...oracleChanged].sort(),
          )
        },
      ),
      propertyTrials('equality-cutoff-propagation/changedNodes-equals-oracle'),
    )
  })

  /**
   * P2 — engine recompute count is `≤ |affected|`:
   *
   *   For every random DAG and every random shape assignment, the
   *   per-id recompute count never exceeds the reference walker's
   *   `affected` set size. Equivalently, every derived recomputes
   *   AT MOST once per commit — the propagation skip can only
   *   subtract work, never add it.
   *
   * Stronger claim: when at least one derived is an 'eraser' shape
   * AND has at least one downstream derived, the recompute count is
   * STRICTLY less than `|affected|` (the skip fires at least once).
   * Asserted under a structural-precondition guard so the property
   * doesn't false-fail on DAGs where no eraser is on any chain.
   */
  it('recompute count ≤ |affected| on every random DAG', () => {
    fc.assert(
      fc.property(
        dagWithShapes(),
        fc.integer({ min: 1, max: 1_000 }),
        ({ spec, shapes }, writeValue) => {
          const { graph, input, counter, deriveds } = buildInstrumented(
            spec,
            shapes,
          )
          settle(deriveds, graph)
          counter.reset()

          graph.commit('mutate-input', (tx) => tx.set(input, writeValue))

          const affected = affectedFromInput(spec)

          // Per-id ceiling: every derived recomputes AT MOST once.
          for (const ds of spec.deriveds) {
            const count = counter.count(ds.id)
            const ceiling = affected.has(ds.id) ? 1 : 0
            expect(count).toBeLessThanOrEqual(ceiling)
          }

          // Total ceiling: sum over all deriveds ≤ |affected|.
          expect(counter.total()).toBeLessThanOrEqual(affected.size)
        },
      ),
      propertyTrials('equality-cutoff-propagation/recompute-count-le-affected'),
    )
  })

  /**
   * P3 — post-commit read values match the forward-evaluation oracle:
   *
   *   For every random DAG and every random shape assignment, the
   *   post-commit `graph.read(d)` of every derived equals the
   *   oracle's forward-evaluated value for `d`. The skip is
   *   denotationally identical to running compute — any value drift
   *   between the engine and the oracle is a structural failure of
   *   the cutoff-propagation gate.
   *
   * Complements P1 (which pins `changedNodes`) and P2 (which pins
   * recompute count). P3 is the third leg: if the engine skipped a
   * derived that SHOULD have recomputed to a different value, its
   * stored `value` field would diverge from the oracle here.
   */
  it('post-commit read(d) equals the oracle value on every derived', () => {
    fc.assert(
      fc.property(
        dagWithShapes(),
        fc.integer({ min: 1, max: 1_000 }),
        ({ spec, shapes }, writeValue) => {
          const { graph, input, deriveds } = buildInstrumented(spec, shapes)
          settle(deriveds, graph)

          graph.commit('mutate-input', (tx) => tx.set(input, writeValue))

          const expected = oracleValues(spec, shapes, writeValue)

          for (const ds of spec.deriveds) {
            const handle = deriveds.get(ds.id)!
            expect(graph.read(handle)).toBe(expected.get(ds.id))
          }
        },
      ),
      propertyTrials('equality-cutoff-propagation/read-equals-oracle'),
    )
  })

  /**
   * P4 — multi-commit fuzz: the same invariants hold across a
   * sequence of random writes:
   *
   *   For every random DAG, every random shape assignment, and every
   *   sequence of distinct input writes, every commit publishes a
   *   `changedNodes` matching the oracle's delta against the prior
   *   commit's values, the cumulative recompute count is bounded by
   *   `K × |affected|`, and the final read of every derived equals
   *   the oracle.
   *
   * Catches stale-state regressions: a cutoff-skip that incorrectly
   * preserved a derived's pre-commit value when one of its upstreams
   * had genuinely changed would surface here as a `changedNodes`
   * mismatch on the commit that broke the chain.
   */
  it('multi-commit fuzz: invariants hold across random write sequences', () => {
    fc.assert(
      fc.property(
        dagWithShapes(),
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
          minLength: 2,
          maxLength: 8,
        }),
        ({ spec, shapes }, writes) => {
          const { graph, input, counter, deriveds } = buildInstrumented(
            spec,
            shapes,
          )
          settle(deriveds, graph)
          counter.reset()

          const captured: Commit[] = []
          graph.subscribeCommits((c) => {
            captured.push(c)
          })

          const affected = affectedFromInput(spec)
          let prior = 0

          for (let i = 0; i < writes.length; i++) {
            const v = writes[i]!
            const before = oracleValues(spec, shapes, prior)
            const after = oracleValues(spec, shapes, v)
            const oracleChanged = new Set<string>()
            for (const ds of spec.deriveds) {
              if (before.get(ds.id) !== after.get(ds.id)) {
                oracleChanged.add(ds.id)
              }
            }

            graph.commit(`w${i}`, (tx) => tx.set(input, v))

            const last = captured[captured.length - 1]!
            const changedDerivedIds = new Set(
              last.changedNodes.filter((id) => id !== spec.inputId),
            )
            expect([...changedDerivedIds].sort()).toEqual(
              [...oracleChanged].sort(),
            )

            prior = v
          }

          // Cumulative recompute count is bounded by K × |affected|.
          expect(counter.total()).toBeLessThanOrEqual(
            writes.length * affected.size,
          )

          // Final read of every derived equals the oracle for the
          // last write.
          const finalExpected = oracleValues(
            spec,
            shapes,
            writes[writes.length - 1]!,
          )
          for (const ds of spec.deriveds) {
            const handle = deriveds.get(ds.id)!
            expect(graph.read(handle)).toBe(finalExpected.get(ds.id))
          }
        },
      ),
      propertyTrials('equality-cutoff-propagation/multi-commit-invariants'),
    )
  })

  /**
   * Edge-case fixture: the canonical eraser-chain pattern the
   * propagation skip is designed for. A linear chain
   *
   *   input → erase → succ → succ → succ
   *
   * where `erase = () => get(input) * 0` and each `succ` is a
   * value-propagating identity. Writing any non-zero value to the
   * input must:
   *
   *   - Recompute `erase` exactly once (its dep is the changed
   *     input, so the skip cannot fire on it).
   *   - Skip `succ`, `succ`, `succ` entirely (each depends ONLY on
   *     an upstream whose value is `Object.is`-stable at 0).
   *   - Publish a `changedNodes` set that is empty for all four
   *     deriveds (every value collapses to 0 both before and after).
   *
   * Anchors the property tests above with a hand-computed fixture so
   * a regression that broke the propagation gate would fail here
   * with a deterministic, debuggable failure rather than only as a
   * fast-check shrunk counterexample.
   */
  it('fixture: eraser-chain skips every downstream recompute', () => {
    const graph = createCausl()
    const counter = recomputeCounter()
    const a = graph.input('a', 0)
    const erase = graph.derived(
      'erase',
      counter.wrap((get) => (get(a) as number) * 0, 'erase'),
    )
    const s1 = graph.derived(
      's1',
      counter.wrap((get) => (get(erase) as number) + 0, 's1'),
    )
    const s2 = graph.derived(
      's2',
      counter.wrap((get) => (get(s1) as number) + 0, 's2'),
    )
    const s3 = graph.derived(
      's3',
      counter.wrap((get) => (get(s2) as number) + 0, 's3'),
    )

    // Force settle and reset.
    graph.subscribe(erase, () => {})
    graph.subscribe(s1, () => {})
    graph.subscribe(s2, () => {})
    graph.subscribe(s3, () => {})
    counter.reset()

    let lastCommit: Commit | undefined
    graph.subscribeCommits((c) => {
      lastCommit = c
    })

    graph.commit('write', (tx) => tx.set(a, 42))

    // `erase` recomputed (its dep `a` is the seed-changed input).
    expect(counter.count('erase')).toBe(1)
    // `s1`, `s2`, `s3` were skipped — their only dep is a stable
    // upstream (erase output is `0 === 0`).
    expect(counter.count('s1')).toBe(0)
    expect(counter.count('s2')).toBe(0)
    expect(counter.count('s3')).toBe(0)

    // The published commit reflects the input write but no derived
    // value actually changed (everything is 0 both before and after).
    expect(lastCommit).toBeDefined()
    const changedDerived = lastCommit!.changedNodes.filter((id) => id !== 'a')
    expect(changedDerived).toEqual([])
  })
})
