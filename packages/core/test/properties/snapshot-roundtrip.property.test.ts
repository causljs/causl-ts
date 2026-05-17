/**
 * @packageDocumentation
 *
 * Property-based proof of snapshot/hydrate round-trip identity (#234,
 * adjusted for #366/#378).
 *
 * The §12.2 / §12.4 denotational claim is: a `GraphSnapshot` is a
 * wire-format envelope `{schema, time, inputs, schemaHash}`; hydrating
 * that envelope into a graph with the same id-set produces a state
 * whose *input map and schemaHash* are byte-equal to the originating
 * envelope. Derived nodes are intentionally absent from the wire format
 * — they are pure functions of inputs by the §3 invariant, so identity
 * over the input map is the whole identity claim.
 *
 * Post-#366/#378, `time` is NOT preserved by the round-trip: hydrate
 * routes through the commit pipeline and advances `now` by exactly one
 * tick (the §3 monotonicity invariant), so `dest.now` after hydrate is
 * `dest_pre_hydrate_now + 1`, not `snap.time`. The snapshot's recorded
 * `time` is preserved on the published `Commit.originatedAt` instead;
 * the engine clock is monotonic across all commits, hydrate included.
 * This file's properties assert the input-map identity and the §3
 * monotonicity floor; the `time` round-trip is intentionally not
 * asserted.
 *
 * `snapshot.test.ts` covers the hand-authored fixtures. What's missing
 * here is universal quantification: for ANY legal graph, ANY legal
 * commit trace, and ANY hydrate point in the trace, `snapshot → mutate
 * → hydrate → snapshot` round-trips the input map and schemaHash. The
 * race-detection commitment for property-based fuzz is the §15.2 floor
 * — 1000 trials, deterministic seeds, failing inputs shrink to
 * regression cases — and this file inherits it via `propertyOptions`.
 *
 * The §3 GraphTime invariant is asserted across the round trip with
 * `assertConsistentGraphTime(trace)`: tuples observed at the same
 * frame must agree on `time`. A hydrate that "almost" round-trips but
 * tears time would surface here as a frame-internal time disagreement.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  assertConsistentGraphTime,
  type DagSpec,
  type TraceEntry,
} from '@causljs/core-testing-internal'
import {
  createCausl,
  type Graph,
  type InputNode,
  type Node,
} from '../../src/index.js'
import { tieredPropertyOptions } from './seed.js'

/**
 * Wire a fresh graph to the same id-set as a {@link DagSpec}. Hydrate
 * requires the live graph to declare every input id present in the
 * snapshot; the destination graph must therefore mirror the source
 * graph's structure before `hydrate()` is called.
 */
function buildMatching(spec: DagSpec): {
  readonly graph: Graph
  readonly input: InputNode<number>
  readonly deriveds: ReadonlyMap<string, Node<number>>
} {
  const graph = createCausl()
  const built = buildPropertyDag(graph, spec)
  return {
    graph,
    input: built.input,
    deriveds: built.deriveds as ReadonlyMap<string, Node<number>>,
  }
}

/**
 * Replay a list of integer writes against the single input id of a
 * `propertyDag` graph. Each write is one commit, advancing GraphTime
 * by exactly one (the §3 atomicity invariant).
 */
function replay(
  graph: Graph,
  input: InputNode<number>,
  writes: readonly number[],
  prefix: string,
): void {
  for (let i = 0; i < writes.length; i++) {
    const v = writes[i] ?? 0
    graph.commit(`${prefix}-${i}`, (tx) => tx.set(input, v))
  }
}

describe('property: snapshot/hydrate round-trip identity (#234)', () => {
  /**
   * P1 — round-trip identity (input map + schemaHash):
   *   For every random DAG (input + 0..N derived) and every random
   *   write trace, `dest.snapshot().inputs` deep-equals `snap.inputs`
   *   and `dest.snapshot().schemaHash === snap.schemaHash` after
   *   `dest.hydrate(src.snapshot())`. The §3 monotonicity invariant
   *   (#366) is asserted alongside: `dest.now` advances by exactly one
   *   tick from its pre-hydrate value, regardless of `snap.time`. The
   *   snapshot's recorded `time` is preserved on the published
   *   `Commit.originatedAt` (covered in `snapshot.test.ts`), not on
   *   the dest engine's clock.
   *
   * Generators cover both input-only graphs (`minDerived: 0`) and
   * input+derived graphs (`maxDerived: 8`), satisfying the acceptance
   * row "generators cover both input-only and input+derived graph
   * shapes". Trial budget is the §15.2 1000-trial floor.
   */
  it('snapshot → hydrate → snapshot preserves inputs and schemaHash for any DAG and write trace (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 0, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: 25,
        }),
        (spec, writes) => {
          // Source graph: build the random DAG, replay the write trace
          // so the snapshot captures a non-trivial state.
          const src = buildMatching(spec)
          replay(src.graph, src.input, writes, 'src')
          const snap = src.graph.snapshot()

          // Destination graph: same id-set so the schemaHash matches.
          const dest = buildMatching(spec)
          const beforeNow = dest.graph.now
          dest.graph.hydrate(snap)

          // Identity assertion over inputs and schemaHash. `time` is
          // intentionally NOT round-tripped post-#366 — hydrate
          // advances the dest clock by exactly one tick rather than
          // copying `snap.time`, preserving the §3 monotonicity
          // invariant (`t₀ < t₁ < t₂ < …`) across mixed commit/hydrate
          // sequences. The structural defence against mismatched id-
          // sets is the schemaHash equality; the input-map equality is
          // the denotational claim that `snapshot` captures the full
          // input set.
          const after = dest.graph.snapshot()
          expect(after.inputs).toEqual(snap.inputs)
          expect(after.schemaHash).toBe(snap.schemaHash)
          expect(after.schema).toBe(snap.schema)
          // §3 monotonicity (#366): `dest.now` advanced by exactly one
          // tick, regardless of `snap.time`.
          expect(dest.graph.now).toBe(beforeNow + 1)
        },
      ),
      tieredPropertyOptions(),
    )
  })

  /**
   * P2 — re-entrant round-trip:
   *   Two snapshot/hydrate cycles back-to-back are idempotent. If
   *   `snap1 = src.snapshot()`, then `dest.hydrate(snap1)` followed by
   *   `snap2 = dest.snapshot()` yields `snap2 === snap1`, and
   *   `dest.hydrate(snap2)` followed by another `snapshot()` yields the
   *   same envelope again. Catches latent state — any field that the
   *   hydrate writes but the next snapshot can't observe — that would
   *   surface as drift across cycles.
   */
  it('two snapshot/hydrate cycles are idempotent on inputs and schemaHash; time advances by one tick per hydrate', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 0, maxDerived: 6 }),
        fc.array(fc.integer({ min: -500, max: 500 }), {
          minLength: 0,
          maxLength: 15,
        }),
        (spec, writes) => {
          const src = buildMatching(spec)
          replay(src.graph, src.input, writes, 'src')
          const snap1 = src.graph.snapshot()

          const dest = buildMatching(spec)
          const t0 = dest.graph.now
          dest.graph.hydrate(snap1)
          const snap2 = dest.graph.snapshot()
          dest.graph.hydrate(snap2)
          const snap3 = dest.graph.snapshot()

          // First-cycle identity over inputs and schemaHash (the P1
          // contract restated). `time` is intentionally not asserted
          // — hydrate advances `now` by one tick (#366), so
          // `snap2.time === t0 + 1` and `snap3.time === t0 + 2`.
          expect(snap2.inputs).toEqual(snap1.inputs)
          expect(snap2.schemaHash).toBe(snap1.schemaHash)
          // Second-cycle identity (idempotence): hydrating the
          // graph's own snapshot must not drift inputs or schemaHash.
          expect(snap3.inputs).toEqual(snap2.inputs)
          expect(snap3.schemaHash).toBe(snap2.schemaHash)
          // §3 monotonicity (#366): each hydrate advances `now` by one.
          expect(snap2.time).toBe(t0 + 1)
          expect(snap3.time).toBe(t0 + 2)
        },
      ),
      tieredPropertyOptions(),
    )
  })

  /**
   * P3 — GraphTime consistency across the round trip:
   *   Capture `(frameId, selector, value, time)` tuples for every
   *   derived value at three phases — pre-snapshot, post-hydrate,
   *   post-mutate — and feed the trace to `assertConsistentGraphTime`.
   *   Each phase is one frame; within a frame, every tuple must agree
   *   on `time`. A hydrate that tears time across selectors would fail
   *   this assertion, even if the round-trip identity in P1 happened
   *   to hold by accident.
   */
  it('GraphTime is consistent within each phase frame across the round trip', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 6 }),
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 0,
          maxLength: 8,
        }),
        (spec, srcWrites, postHydrateWrites) => {
          const src = buildMatching(spec)
          replay(src.graph, src.input, srcWrites, 'src')
          const snap = src.graph.snapshot()

          const dest = buildMatching(spec)

          // Phase 1 (pre-hydrate destination): observe every derived
          // at the dest graph's current GraphTime — should be 0
          // (fresh graph).
          const trace: TraceEntry[] = []
          let frame = 0
          const observeAll = (g: Graph, label: string): void => {
            for (const [id, node] of dest.deriveds) {
              trace.push({
                frameId: `${label}-${frame}`,
                selector: id,
                value: g.read(node),
                time: g.now,
              })
            }
            frame++
          }
          observeAll(dest.graph, 'pre-hydrate')

          // Phase 2 (post-hydrate): hydrate, then re-observe. Every
          // selector in this frame must agree on the dest's current
          // `g.now` — post-#366 that is `pre_hydrate_now + 1`, not
          // `snap.time`. The §3 within-frame consistency claim holds
          // either way: all selectors read at the same GraphTime.
          dest.graph.hydrate(snap)
          observeAll(dest.graph, 'post-hydrate')

          // Phase 3 (post-mutate): replay further writes on the
          // destination, observing after each commit. Each commit
          // forms its own frame; within that frame, all selectors
          // must agree on the new time.
          for (let i = 0; i < postHydrateWrites.length; i++) {
            const v = postHydrateWrites[i] ?? 0
            dest.graph.commit(`post-${i}`, (tx) => tx.set(dest.input, v))
            observeAll(dest.graph, `post-mutate-${i}`)
          }

          // The §3 invariant in test form: every render frame agrees
          // on what time it is. A glitchy hydrate that updated a
          // subset of derived caches at one time and the rest at
          // another would fail here.
          assertConsistentGraphTime(trace)
        },
      ),
      tieredPropertyOptions(),
    )
  })

  /**
   * P4 — derived recomputation reflects hydrated input set:
   *   §12.4's denotational claim is that derived = f(inputs). After
   *   hydrate, every derived's value must equal what its compute
   *   function would return with the hydrated input values plugged in.
   *   The sum-of-deps compute used by `buildPropertyDag` makes this
   *   exact: every derived equals the sum of its dep values, and since
   *   every dep chain bottoms out at the single input, every derived
   *   equals `dep_count_along_paths * input_value` for the linear
   *   sum-of-deps shape.
   *
   * The test reads the source graph's derived values *before*
   * hydrating the destination, then asserts the destination's derived
   * values equal the source's after hydrate. Equivalent to: derived
   * is a function of (id, input-set), so identical input-sets yield
   * identical derived values regardless of how the graph got there.
   */
  it('post-hydrate derived values equal the source graph derived values', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: 20,
        }),
        (spec, writes) => {
          const src = buildMatching(spec)
          replay(src.graph, src.input, writes, 'src')

          // Capture src derived values for the oracle comparison.
          const expected: Record<string, number> = {}
          for (const [id, node] of src.deriveds) {
            expected[id] = src.graph.read(node)
          }

          // Hydrate a fresh dest graph, then read the same derived
          // ids. §12.4's f(inputs) claim: identical input-sets ⇒
          // identical derived values, no path-dependence.
          const dest = buildMatching(spec)
          dest.graph.hydrate(src.graph.snapshot())
          for (const [id, node] of dest.deriveds) {
            expect(dest.graph.read(node)).toBe(expected[id])
          }
        },
      ),
      tieredPropertyOptions(),
    )
  })
})
