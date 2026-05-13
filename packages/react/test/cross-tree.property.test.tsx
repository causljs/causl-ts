/**
 * Cross-tree consistency property suite (#134 v0).
 *
 * Property: across an arbitrary React subtree subscribing to a
 * randomly-shaped DAG (including diamonds — two paths reconverging
 * on a derived node), every consumer's observed value at the post-
 * commit frame resolves at one GraphTime, and matches the engine's
 * read of the same node at the same time.
 *
 * The denotational equation `derived(t) = f(b₁(t), ..., bₙ(t))` makes
 * a diamond glitch (D recomputed off mismatched B and C versions) a
 * non-existent state — derived values at time `t` are a pure function
 * of inputs at the same `t`. This suite proves the implementation
 * matches that semantics under cross-component subscription.
 *
 * Generator: `fc.letrec`-based DAG-shape arbitrary (#244). The prior
 * `buildDagFixture` was parametrically deterministic — given
 * `(inputCount, derivedCount)` the topology was fully determined by
 * `i % earlier.length` modulus arithmetic, so 1000 trials sampled one
 * shape per N. The generator below emits arbitrary DAG shapes per
 * trial: pure diamonds, towers of diamonds, wide fan-out + reconvergence,
 * linear chains, trees, and an inputs-only base case. The shape is
 * recorded on the fixture so a failing trial shrinks structurally and
 * the regression is self-describing.
 *
 * Diamond tip designation: every emitted shape carries a designated
 * diamond apex `tipOrdinal` plus its two named dep ordinals
 * (`tipDepAOrdinal`, `tipDepBOrdinal`). The generator builds the tip
 * during construction — it already knows the shape it built, so
 * marking the tip is free and avoids forcing consumers to walk the
 * DAG to re-derive it. The tip is always `f(a, b) = a + b` for its
 * two named deps, giving the §15.1 glitch-detection oracle a
 * closed-form `f` to compare against without snooping engine
 * internals.
 *
 * Trial count is the 1000-trial property-based fuzz floor enforced by
 * `propertyTrials()` from the @causl/core/testing seam — §15.2. A
 * deterministic generator under that floor undersells the floor; the
 * letrec generator restores its real coverage.
 */

import {
  createCausl,
  type DerivedNode,
  type Graph,
  type InputNode,
  type Node,
} from '@causl/core'
import {
  assertConsistentGraphTime,
  assertResultStability,
  glitchDetector,
  propertyTrials,
  ResultInstability,
  type TraceEntry,
} from '@causl/core/testing'
import { act, cleanup, render } from '@testing-library/react'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CauslProvider, useCausl } from '../src/index.js'

/**
 * Topology spec for one derived node — references earlier nodes by
 * ordinal position in the input-then-derived ordering. Recording the
 * spec (instead of building the engine eagerly) is what gives
 * fast-check a structural anchor to shrink against, and what makes a
 * failing trial self-describing in CI logs.
 */
interface DerivedShapeSpec {
  /** Earlier-node indices this derived reads. Always non-empty. */
  readonly depIndices: readonly number[]
}

/**
 * Topology spec for a whole DAG — input count plus an ordered list of
 * derived specs, plus an explicitly designated diamond apex.
 *
 * The total ordinal `i` of node `derivedSpecs[k]` is `inputCount + k`;
 * its `depIndices` reference earlier ordinals (0..inputCount+k-1), so
 * the DAG is by-construction acyclic.
 *
 * `tipOrdinal` is the ordinal of the designated diamond tip — always a
 * derived node with exactly two deps `[tipDepAOrdinal, tipDepBOrdinal]`
 * that share a common ancestor (a real reconvergence, never a
 * multi-parent tree leaf). The generator places this node and records
 * its ordinals here so the materialisation step doesn't have to walk
 * and re-derive.
 */
interface DagShape {
  readonly inputCount: number
  readonly derivedSpecs: readonly DerivedShapeSpec[]
  readonly tipOrdinal: number
  readonly tipDepAOrdinal: number
  readonly tipDepBOrdinal: number
}

interface DagFixture {
  graph: Graph
  inputs: InputNode<number>[]
  readables: Node<number>[]
  /**
   * Designated diamond tip. Always present and always equal to
   * `tipDepA + tipDepB` by construction so the glitch oracle has a
   * closed-form `f` to compare against.
   */
  tip: DerivedNode<number>
  tipDepA: Node<number>
  tipDepB: Node<number>
  shape: DagShape
}

/**
 * `fc.Arbitrary<DagShape>` emitting arbitrary acyclic DAGs, each with
 * an explicitly designated diamond apex.
 *
 * Construction:
 *   1. Sample `inputCount ∈ [2, 4]` (≥2 so a real diamond is always
 *      possible — two distinct deps reconverging on the apex).
 *   2. Sample `bodyCount ∈ [0, 7]` body deriveds. For each derived `k`
 *      (in topo order), sample its dep set as a non-empty unique
 *      subset of earlier ordinals `[0, inputCount + k)`. Subset size
 *      `∈ [1, min(earlier, 4)]`.
 *   3. Append the designated diamond tip as the final derived. Its
 *      two deps are picked from the existing nodes such that they
 *      share a common ancestor — guaranteeing a real reconvergence
 *      rather than a multi-parent tree leaf. The simplest choice is
 *      `(input[0], some body derived whose ancestor closure already
 *      contains input[0])`. When no such body derived exists, the
 *      generator synthesises a single-dep stub reading input[0]
 *      immediately before the tip; this costs one extra node in the
 *      worst case and guarantees the diamond invariant by
 *      construction.
 *   4. The chosen ordinals are recorded on the shape so consumers
 *      surface `tip`/`tipDepA`/`tipDepB` directly without walking and
 *      re-deriving.
 *
 * `fc.letrec` is the canonical recursive-arbitrary primitive here;
 * a `chain`-and-`tuple` composition is equivalent for this shape
 * (the DAG is finite-depth, bounded by `bodyCount`, so there is no
 * recursion through `tie(...)`). The chain form gives fast-check a
 * structural anchor it can shrink against — the dep set shrinks
 * independently of the body count, surfacing minimal counterexamples
 * (e.g. "2 inputs, 0 body deriveds, tip = input[0] + stub" for a
 * regression that would also break a 6-derived tower).
 *
 * Shape coverage emitted by this arbitrary:
 *   - **Inputs-only base** when `bodyCount === 0` — only the tip
 *     (and its stub) exists. Regression sentinel: cross-tree
 *     consistency must hold even with the minimum derivation layer.
 *   - **Pure diamonds** — the tip is always a diamond by
 *     construction; additional body diamonds emerge when subset
 *     selection chooses overlapping deps.
 *   - **Towers of diamonds** — multiple stacked diamond layers,
 *     emerging when the dep-subset arbitrary picks earlier deriveds
 *     plus the tip stacked above.
 *   - **Wide fan-out + reconvergence** — one input feeds N siblings
 *     when the dep arbitrary repeatedly picks the same input, then
 *     the tip merges them.
 *   - **Linear chains** — body deriveds read only their immediate
 *     predecessor (subset size 1, picking the latest ordinal); the
 *     tip then reconverges over the chain.
 *
 * No coverage assertion runs at the property level — fast-check's
 * `seed` plus a 1000-trial floor saturates the shape distribution.
 * A separate generator-coverage spot-check runs at the bottom of
 * this file under a smaller trial budget.
 */
function dagShapeArb(): fc.Arbitrary<DagShape> {
  return fc
    .record({
      inputCount: fc.integer({ min: 2, max: 4 }),
      bodyCount: fc.integer({ min: 0, max: 7 }),
    })
    .chain(({ inputCount, bodyCount }) => {
      // Per-body-derived: a non-empty unique subset of earlier
      // ordinals (subset size capped at 4 to keep the dep fan-in small
      // enough for 1000 trials × N writes to remain CI-tractable).
      const bodyArbs: Array<fc.Arbitrary<DerivedShapeSpec>> = []
      for (let k = 0; k < bodyCount; k++) {
        const earlier = inputCount + k
        const maxFanIn = Math.min(earlier, 4)
        bodyArbs.push(
          fc
            .uniqueArray(fc.integer({ min: 0, max: earlier - 1 }), {
              minLength: 1,
              maxLength: maxFanIn,
            })
            .map(
              (depIndices) =>
                ({ depIndices } satisfies DerivedShapeSpec),
            ),
        )
      }
      const bodyTuple =
        bodyCount === 0
          ? fc.constant<DerivedShapeSpec[]>([])
          : fc.tuple(...bodyArbs).map((specs) => specs.slice())
      // Tip dep selection: pick two distinct ordinals that share a
      // common ancestor. Two distinct inputs as direct deps would be a
      // multi-parent leaf, NOT a real diamond — the tightened
      // `isReconvergent` (#244 review feedback) requires a SHARED
      // ancestor, not just multiple parents. So tip-dep-A is always
      // input[0], and tip-dep-B is a node whose ancestor closure
      // already contains input[0]. If no such body derived exists we
      // synthesise a stub.
      return bodyTuple.chain((bodySpecs) => {
        // Build the ancestor closure for each body derived, in topo
        // order so each closure can be built from the prior ones.
        const ancestorsOf: Set<number>[] = []
        for (let k = 0; k < bodySpecs.length; k++) {
          const spec = bodySpecs[k]!
          const closure = new Set<number>()
          for (const d of spec.depIndices) {
            closure.add(d)
            if (d >= inputCount) {
              const earlier = ancestorsOf[d - inputCount]!
              for (const e of earlier) closure.add(e)
            }
          }
          ancestorsOf.push(closure)
        }
        const bodyContainingInput0: number[] = []
        for (let k = 0; k < bodySpecs.length; k++) {
          if (ancestorsOf[k]!.has(0)) {
            bodyContainingInput0.push(inputCount + k)
          }
        }
        if (bodyContainingInput0.length === 0) {
          // Synthesise a stub body derived `s` reading input[0],
          // then point the tip at (input[0], s). The tip's two deps
          // then share input[0] in their ancestor closures — a real
          // diamond by construction.
          const stubOrdinal = inputCount + bodySpecs.length
          const tipOrdinal = stubOrdinal + 1
          const finalSpecs: DerivedShapeSpec[] = [
            ...bodySpecs,
            { depIndices: [0] }, // stub: reads input[0] only
            { depIndices: [0, stubOrdinal] }, // tip: input[0] + stub
          ]
          return fc.constant<DagShape>({
            inputCount,
            derivedSpecs: finalSpecs,
            tipOrdinal,
            tipDepAOrdinal: 0,
            tipDepBOrdinal: stubOrdinal,
          })
        }
        // Pick which existing body-derived to reconverge with
        // input[0]. Sampling preserves shrinkability — fast-check
        // can shrink toward the smallest-ordinal candidate.
        return fc
          .integer({ min: 0, max: bodyContainingInput0.length - 1 })
          .map((pickIdx) => {
            const tipDepBOrdinal = bodyContainingInput0[pickIdx]!
            const tipOrdinal = inputCount + bodySpecs.length
            const finalSpecs: DerivedShapeSpec[] = [
              ...bodySpecs,
              { depIndices: [0, tipDepBOrdinal] },
            ]
            return {
              inputCount,
              derivedSpecs: finalSpecs,
              tipOrdinal,
              tipDepAOrdinal: 0,
              tipDepBOrdinal,
            } satisfies DagShape
          })
      })
    })
}

/**
 * Materialise a `DagShape` into a live engine. Each derived computes
 * `sum(get(dep_i))` so its value is structurally a function of every
 * dep edge — the diamond glitch-freedom invariant has something to
 * falsify (any glitch would surface as an off-by-one sum). The
 * designated tip is `f(a, b) = a + b` over its two named deps,
 * matching the closed-form oracle the property test compares against
 * (because the tip's depIndices length is exactly 2 by construction).
 */
function buildDagFixture(shape: DagShape): DagFixture {
  // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped the
  // `commitHistoryCap` / `snapshotRetentionCap` defaults to 0; the
  // cross-tree consistency property uses `readAt` against this
  // fixture's engine as its snapshot oracle.
  const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
  const inputs = Array.from({ length: shape.inputCount }, (_, i) =>
    g.input<number>(`a${i}`, i + 1),
  )
  const derived: DerivedNode<number>[] = []
  // Total node ordering: inputs first (ordinals 0..inputCount-1),
  // then deriveds (ordinals inputCount..). Dep ordinals reference
  // this combined order.
  const allByOrdinal = (k: number): Node<number> => {
    if (k < shape.inputCount) return inputs[k]!
    return derived[k - shape.inputCount]!
  }
  for (let k = 0; k < shape.derivedSpecs.length; k++) {
    const { depIndices } = shape.derivedSpecs[k]!
    const ordinal = shape.inputCount + k
    const isTip = ordinal === shape.tipOrdinal
    const id = isTip ? 'tip' : `d${k}`
    const node = g.derived<number>(id, (get) => {
      let sum = 0
      for (const di of depIndices) sum += get(allByOrdinal(di))
      return sum
    })
    derived.push(node)
  }
  // Pull the designated tip + named deps from the shape — the
  // generator placed them, so we don't have to walk and re-derive.
  const tip = allByOrdinal(shape.tipOrdinal) as DerivedNode<number>
  const tipDepA = allByOrdinal(shape.tipDepAOrdinal)
  const tipDepB = allByOrdinal(shape.tipDepBOrdinal)
  return {
    graph: g,
    inputs,
    readables: [...inputs, ...derived],
    tip,
    tipDepA,
    tipDepB,
    shape,
  }
}

/**
 * Build a `getSnapshot`-shaped probe that mirrors `useCausl`'s
 * cache exactly: an `Object.is`-keyed cache pinned to the graph
 * identity. `useSyncExternalStore` calls `getSnapshot` repeatedly
 * within one render and from the store-change callback; if the
 * function returns a fresh reference every call with no intervening
 * commit, React enters a render loop. This probe is the test seam
 * through which `assertResultStability` observes the contract.
 *
 * The probe is intentionally a duplicate of `useCausl.ts`'s
 * `getSnapshot` rather than reaching through the hook — the hook is
 * private to React's render scheduler, so the only way to make the
 * stability contract observable from outside a render pass is to
 * mirror the cache logic at the test boundary. A regression in the
 * hook that broke the cache would still be caught by the in-render
 * tearing assertions; this probe is the *extra* gate that catches a
 * regression in the *cache contract* (e.g. a selector that
 * unintentionally allocates a fresh tuple, defeating dedup).
 */
function buildSnapshotProbe<T>(
  graph: Graph,
  selector: (g: Graph) => T,
): () => T {
  let cached: { value: T; from: Graph } | null = null
  return (): T => {
    const next = selector(graph)
    if (cached && cached.from === graph && Object.is(cached.value, next)) {
      return cached.value
    }
    cached = { value: next, from: graph }
    return next
  }
}

describe('cross-tree consistency property suite v0 (#134)', () => {
  it(
    'every consumer in a DAG-shaped tree resolves at one GraphTime per commit and matches the engine read',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          dagShapeArb(),
          fc.integer({ min: 1, max: 6 }),
          fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 100 })), {
            minLength: 1,
            maxLength: 4,
          }),
          async (shape, consumerCount, writes) => {
            const { graph, inputs, readables, tip, tipDepA, tipDepB } =
              buildDagFixture(shape)
            const trace: Array<TraceEntry & { targetId: string }> = []
            let frameId = 0

            // §15.1 glitch-freedom oracle. The detector subscribes to
            // `tip` and to each dep, then at every observation
            // re-evaluates the closed-form `f = a + b` against the
            // dep values captured at the same GraphTime. Any
            // disagreement increments `observed`. This is the
            // canonical external-f form of the diamond glitch gate;
            // before this commit the suite asserted internal
            // consistency only (`graph.read === graph.read`) and would
            // have silently passed an engine that produced glitched
            // tip values for the right `GraphTime`.
            const detector = glitchDetector(
              graph,
              tip,
              ([a, b]: readonly [number, number]) => a + b,
              [tipDepA, tipDepB],
            )

            function Consumer({ idx }: { idx: number }) {
              // Every consumer reads readables[idx % readables.length] —
              // the modulus stride guarantees that for any consumerCount
              // ≥ 2, two consumers will pick the same derived node and
              // observe it across separate subtrees. This is the
              // cross-tree leg of the denotational invariant — two
              // observers of the same Behavior at one GraphTime must
              // agree, regardless of which subtree houses them.
              const target = readables[idx % readables.length]!
              const v = useCausl((g) => g.read(target))
              // Capture the post-commit observation for the GraphTime
              // consistency check. Reading `graph.now` here is safe —
              // we're inside React's commit phase, after the useCausl
              // selector has resolved against the current snapshot.
              trace.push({
                frameId,
                selector: `c-${idx}->${target.id}`,
                value: v,
                time: graph.now,
                targetId: target.id,
              })
              return null
            }

            // Snapshot-stability probe targeting the same selector
            // shape `useCausl` uses for its consumers. The cache
            // mirrors the hook's `getSnapshot` algorithm verbatim:
            // `Object.is`-keyed against the graph identity. After
            // every quiescent point (initial mount, post-commit) we
            // call `assertResultStability`, which fires `getSnapshot`
            // twice in a row and asserts the second call returns the
            // same reference — the React contract that prevents the
            // `useSyncExternalStore` render-loop foot-gun. Targeting
            // `readables[0]` ties the probe to the same root slice the
            // first consumer subscribes to (mod consumerCount), so a
            // shape-specific cache regression shrinks against the same
            // selector path the property already exercises.
            const stabilityProbe = buildSnapshotProbe(graph, (g) =>
              g.read(readables[0]!),
            )

            try {
              render(
                <CauslProvider graph={graph}>
                  {Array.from({ length: consumerCount }, (_, i) => (
                    <Consumer key={i} idx={i} />
                  ))}
                </CauslProvider>,
              )
              // Initial-mount stability: with no commits between
              // back-to-back probe calls, `getSnapshot` must return
              // the cached reference. A regression that bypassed the
              // cache would render-loop in production; the helper
              // throws `ResultInstability` here and shrinks against
              // the offending shape.
              assertResultStability({ getSnapshot: stabilityProbe })
              // Per-write act boundary: each commit gets its own React
              // commit, so the trace is captured per-frame. This is
              // what surfaces a torn intermediate render — checking
              // only post-batch state would hide it.
              for (const [idx, v] of writes) {
                frameId++
                act(() => {
                  const target = inputs[idx % shape.inputCount]!
                  graph.commit('w', (tx) => tx.set(target, v))
                })
                // Post-commit stability: the commit advanced
                // `GraphTime`, so the probe's first call MAY return a
                // fresh value (when the input change propagated to
                // the selector). The contract is on the SECOND call:
                // with no further commit between the first and second
                // invocations, the second must hand back the first's
                // reference. `assertResultStability` invokes the
                // probe twice and pins exactly that.
                assertResultStability({ getSnapshot: stabilityProbe })
              }
              // Glitch-freedom invariant: within each render frame,
              // every entry resolves at one GraphTime — there is no
              // intermediate "B updated but C did not" state because
              // there is no intermediate time. Whatever the scheduler
              // does, the meaning is fixed.
              assertConsistentGraphTime(trace)
              // §15.1 external-oracle gate: zero glitches observed at
              // the diamond tip across the entire trial. This is the
              // canonical form `D(t) === f(deps(t))` checked against
              // an externally-supplied `f`, not against the engine's
              // own internal consistency.
              expect(detector.observed).toBe(0)
              // §3 cross-tree correspondence: every observation in
              // the trace must equal `graph.readAt(target, time)` at
              // the trace entry's captured time. This replaces the
              // earlier `graph.read(target) === graph.read(target)`
              // tautology — that one only checked engine determinism
              // (already trivially true) and never checked that the
              // *consumer* saw the same value as the engine at the
              // same `GraphTime`. With `readAt` we resolve the
              // observation against the canonical retained snapshot
              // for that exact time.
              for (const entry of trace) {
                const target = readables.find(
                  (n) => n.id === entry.targetId,
                )!
                const at = graph.readAt(target, entry.time)
                if (at.status === 'retained') {
                  expect(entry.value).toBe(at.value)
                } else {
                  // Retention buffer evicted the snapshot for that
                  // time. The fall-back oracle is the engine's
                  // current read — a divergence here would still mean
                  // the consumer disagreed with the engine at SOME
                  // canonical reference, which is what the §3
                  // invariant forbids.
                  expect(entry.value).toBe(graph.read(target))
                }
              }
            } finally {
              detector.dispose()
              cleanup()
            }
          },
        ),
        // 1000-trial property-fuzz floor, enforced via the testing
        // seam (see PR #189 review comments — P0: was 50 trials).
        // Failing inputs are shrunk and committed as regression cases;
        // seeds are deterministic and logged so a CI failure is
        // reproducible.
        propertyTrials('cross-tree-consistency'),
      )
    },
    // Long-running property: 1000 trials × (mount + N writes + cleanup)
    // exceeds the default 5 s. 60 s gives ample headroom on CI.
    60_000,
  )

  it('assertResultStability catches a fresh-reference selector — proves the gate is load-bearing', () => {
    // Negative control: a selector that allocates a fresh array per
    // call would render-loop under `useSyncExternalStore`. This test
    // proves the gate fires on that exact regression — without this,
    // the post-mount + post-commit invocations above would be
    // vacuously passing (every primitive return is `Object.is`-equal,
    // so a stripped-cache regression on primitive selectors is
    // structurally hidden). With this control we know the helper is
    // actually catching the contract violation.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    // No cache wrapper — every call allocates a fresh tuple. This
    // mirrors a misguided `useCausl` selector that returns
    // `(g) => [g.read(a), g.read(b)]` without `useCauslShallow`.
    const unstable = (): readonly [number, number] => [g.read(a), g.read(b)]
    expect(() => assertResultStability({ getSnapshot: unstable })).toThrow(
      ResultInstability,
    )
    // Positive leg: a primitive selector wrapped in the
    // `useCausl`-style `Object.is` cache returns the cached
    // reference on the second call (the values are `Object.is`-equal,
    // the cache hits). This is the exact contract the hook upholds
    // and that the property suite asserts on every quiescent point.
    const stable = buildSnapshotProbe(g, (gg) => gg.read(a))
    expect(() =>
      assertResultStability({ getSnapshot: stable }),
    ).not.toThrow()
  })

  it(
    'paired selectors stay consistent across random commit sequences',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: -50, max: 50 }), {
            minLength: 1,
            maxLength: 6,
          }),
          async (writes) => {
            // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped the
            // `commitHistoryCap` / `snapshotRetentionCap` defaults to
            // 0; this property uses `graph.readAt(target, entry.time)`
            // as the snapshot oracle, which requires opt-in retention.
            const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
            const a = g.input('a', 0)
            const trace: TraceEntry[] = []
            let frameId = 0

            function View() {
              const v = useCausl((graph) => graph.read(a))
              const v2 = useCausl((graph) => graph.read(a) * 2)
              // Pair-tearing leg: v and 2·v MUST both resolve at the
              // same GraphTime in every render frame. Recording two
              // entries per frame turns this into an
              // assertConsistentGraphTime check.
              trace.push({
                frameId,
                selector: 'v',
                value: v,
                time: g.now,
              })
              trace.push({
                frameId,
                selector: 'v2',
                value: v2,
                time: g.now,
              })
              expect(v2).toBe(v * 2) // never torn
              return null
            }

            try {
              render(
                <CauslProvider graph={g}>
                  <View />
                </CauslProvider>,
              )
              for (const w of writes) {
                frameId++
                act(() => {
                  g.commit('w', (tx) => tx.set(a, w))
                })
              }
              assertConsistentGraphTime(trace)
            } finally {
              cleanup()
            }
          },
        ),
        // 1000-trial property-fuzz floor, enforced via the testing
        // seam — same shrink-and-record discipline as the suite above.
        propertyTrials('paired-selector-tearing'),
      )
    },
    60_000,
  )

  /**
   * Generator-coverage spot-check (#244).
   *
   * The `dagShapeArb()` generator above must actually emit each
   * canonical DAG family — inputs-only, linear chain, diamond, wide
   * fan-out — over a small trial budget. This is a coverage
   * assertion, not a correctness invariant: it confirms the
   * generator's distribution covers the shapes it claims to. A
   * regression that narrowed the generator (e.g. fixed `bodyCount
   * >= 2`) would silently weaken the property suite above; this
   * spot-check fails loudly.
   *
   * Additionally, every emitted shape must carry a real diamond at
   * the designated tip — a tip whose two deps share a common
   * ancestor, not a multi-parent tree leaf. The brutal-review
   * distinction (#244): a derived with two distinct input parents
   * and no shared ancestry is structurally NOT a diamond. The
   * generator is supposed to guarantee a real diamond at the apex
   * by construction; this spot-check enforces that contract.
   *
   * The trial count is the §15.2 1000-trial floor. Earlier drafts
   * of this spot-check used `unsafeTrials: 200` on the rationale
   * that 200 was "enough to observe each canonical shape with high
   * probability"; in practice the linear-chain family is rare
   * enough (~1/600 per trial under the body distribution) that a
   * 200-trial budget went flaky on CI. Holding the spot-check to
   * the floor costs nothing — shape generation alone is microseconds
   * per trial — and removes the seed-flake risk.
   */
  it('generator emits inputs-only base, diamonds, towers, fan-outs, and linear chains', () => {
    /**
     * Compute the set of ordinals reachable from `start` along the
     * dep edges (ancestors of `start`, exclusive of itself).
     */
    function ancestors(
      shape: DagShape,
      start: number,
    ): Set<number> {
      const visited = new Set<number>()
      const stack: number[] = []
      // `start` is a derived ordinal: its depIndices live at
      // shape.derivedSpecs[start - inputCount].depIndices.
      const seedDeps = shape.derivedSpecs[start - shape.inputCount]
      if (seedDeps) for (const d of seedDeps.depIndices) stack.push(d)
      while (stack.length > 0) {
        const k = stack.pop()!
        if (visited.has(k)) continue
        visited.add(k)
        if (k >= shape.inputCount) {
          const spec = shape.derivedSpecs[k - shape.inputCount]
          if (spec) for (const d of spec.depIndices) stack.push(d)
        }
      }
      return visited
    }

    /**
     * A derived node with ≥2 deps is a "real diamond" only if at
     * least two of its deps share a common ancestor (or are the
     * same input). Otherwise it's a multi-parent tree leaf, not a
     * reconvergence. This is the brutal-review distinction (#244):
     * the prior cheap check `depIndices.length >= 2` over-counted
     * trees as diamonds.
     */
    function isReconvergent(
      shape: DagShape,
      derivedOrdinal: number,
    ): boolean {
      const spec = shape.derivedSpecs[derivedOrdinal - shape.inputCount]
      if (!spec || spec.depIndices.length < 2) return false
      // For each pair of deps (a, b): if they share any ancestor
      // (or one IS an ancestor of the other, or they're identical),
      // there is a reconvergence path through this node.
      const deps = spec.depIndices
      for (let i = 0; i < deps.length; i++) {
        for (let j = i + 1; j < deps.length; j++) {
          const a = deps[i]!
          const b = deps[j]!
          if (a === b) return true
          // Inputs have no ancestors of their own; if both deps are
          // distinct inputs they cannot share a common ancestor.
          if (a < shape.inputCount && b < shape.inputCount) continue
          const aAnc = ancestors(shape, a)
          const bAnc = ancestors(shape, b)
          aAnc.add(a)
          bAnc.add(b)
          for (const x of aAnc) if (bAnc.has(x)) return true
        }
      }
      return false
    }

    let inputsOnlyBase = 0
    let pureDiamond = 0
    let towerOfDiamonds = 0
    let wideFanOut = 0
    let linearChain = 0
    let everyShapeHasTipDiamond = true
    fc.assert(
      fc.property(dagShapeArb(), (shape) => {
        // Tip invariant: every emitted shape MUST have a real
        // reconvergent diamond at the designated tip ordinal. This
        // is the construction-time guarantee — if it ever fails the
        // generator silently weakened.
        if (!isReconvergent(shape, shape.tipOrdinal)) {
          everyShapeHasTipDiamond = false
        }
        // The "body" of the shape excludes the tip (and any stub the
        // generator synthesised when no body derived contained
        // input[0]). Counting the canonical families against the body
        // tells us the generator's body distribution still spans the
        // claimed shape space — counting the tip itself would mask a
        // body collapse since the tip is a guaranteed diamond by
        // construction.
        //
        // Body count: derivedSpecs.length - 1 (drop the tip), or
        // - 2 when the synthesised stub is present (no body derived
        // contained input[0], so the second-to-last spec is the stub
        // reading [0]). The stub is identifiable: a single-dep spec
        // whose only dep is 0, immediately preceding the tip.
        const tipIdx = shape.derivedSpecs.length - 1
        const tipSpec = shape.derivedSpecs[tipIdx]!
        const stubIdx = tipIdx - 1
        const maybeStub = stubIdx >= 0 ? shape.derivedSpecs[stubIdx]! : null
        const stubOrdinal = shape.inputCount + stubIdx
        const tipReadsStub = tipSpec.depIndices.includes(stubOrdinal)
        const isStub =
          maybeStub !== null &&
          maybeStub.depIndices.length === 1 &&
          maybeStub.depIndices[0] === 0 &&
          tipReadsStub
        const bodyEnd = isStub ? stubIdx : tipIdx
        const bodySpecs = shape.derivedSpecs.slice(0, bodyEnd)
        if (bodySpecs.length === 0) {
          inputsOnlyBase++
          return
        }
        // Linear chain: every body-derived has exactly one dep AND
        // each points to its immediate predecessor.
        const isLinear = bodySpecs.every(
          (spec, k) =>
            spec.depIndices.length === 1 &&
            spec.depIndices[0] === shape.inputCount + k - 1,
        )
        if (isLinear && bodySpecs.length >= 2) {
          linearChain++
        }
        // Pure diamond: at least one body derived is a reconvergence
        // — two of its deps share a common ancestor (or are the
        // same input). Walks the ancestor set so a tree with ≥2-
        // parent leaves is NOT counted as a diamond.
        const reconvergentLayers: number[] = []
        for (let k = 0; k < bodySpecs.length; k++) {
          if (isReconvergent(shape, shape.inputCount + k)) {
            reconvergentLayers.push(k)
          }
        }
        if (reconvergentLayers.length >= 1) pureDiamond++
        // Tower: at least two reconvergent layers in the body
        // (stacked diamonds beyond the guaranteed tip).
        if (reconvergentLayers.length >= 2) towerOfDiamonds++
        // Wide fan-out: a single input is referenced as a dep by ≥3
        // distinct body-deriveds.
        for (let inputOrdinal = 0; inputOrdinal < shape.inputCount; inputOrdinal++) {
          const refs = bodySpecs.filter((spec) =>
            spec.depIndices.includes(inputOrdinal),
          ).length
          if (refs >= 3) {
            wideFanOut++
            break
          }
        }
      }),
      // Coverage spot-check above the §15.2 1000-trial floor. Shape
      // generation is microseconds per trial so the budget is free
      // here, and the rare linear-chain family hits ~1/600 per trial:
      // at 1000 trials, P(0 hits) ≈ e^(-1.67) ≈ 19%, which already
      // burned us in CI. Bumped to 5000 — P(0) ≈ 2e-4 — comfortably
      // below the once-per-decade-per-PR threshold the §15.2 seam
      // floor implicitly targets. The earlier bump 200 → 1000 was
      // not enough; this bump pins the math.
      //
      // Issue #1151 — this file is on the `causl/no-hardcoded-property-
      // trials` allowlist in `eslint.config.js`. Routing through
      // `tieredPropertyTrials` would let the default tier drop to 1000
      // trials and burn CI again on the rare linear-chain shape; the
      // coverage-math requires the literal here. Do NOT replace with a
      // tier-resolved count.
      propertyTrials('dag-shape-coverage', { numRuns: 5000 }),
    )
    // Tip-diamond invariant: must hold for every shape, no
    // exceptions. Failing this means the generator emitted a tip
    // that wasn't a real reconvergence — the property suite above
    // would then silently undersample the diamond shape.
    expect(everyShapeHasTipDiamond).toBe(true)
    // Each canonical body family must be observed at least once
    // over 200 trials. If any of these is zero, the generator's
    // distribution is too narrow and the property suite above is
    // undersampling its claimed shape space.
    expect(inputsOnlyBase).toBeGreaterThan(0)
    expect(pureDiamond).toBeGreaterThan(0)
    expect(towerOfDiamonds).toBeGreaterThan(0)
    expect(wideFanOut).toBeGreaterThan(0)
    expect(linearChain).toBeGreaterThan(0)
  })
})
