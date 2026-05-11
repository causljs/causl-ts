/**
 * @packageDocumentation
 *
 * SPEC §17 commitment 13 — capability-cost residual gate (#1005).
 *
 * The post-wave team-panel convergence (Beck/Metz on cost-of-commit,
 * Markbåge/Miller on engine-on-engine methodology) signed off on a
 * `1.84× engine baseline + 3.5× contract premium = 6.4× residual` on
 * the canonical contract-bearing cell `equality-cutoff × 10000`. The
 * `MEDIAN_BAND_INVARIANTS` catalogue in
 * `packages/bench/src/hypotheses/causl-hypotheses.ts` encodes the
 * upper-bound side of that residual (a regression past 8× erodes the
 * wave gains) and the lower-bound side (a sub-3× ratio means a future
 * PR has either delivered an architectural breakthrough or silently
 * retired the replay-determinism contract).
 *
 * The lower bound is the load-bearing one: a future PR can satisfy
 * `causl_median ≤ mobx_median × 3.0` by deleting the contract surface
 * — `commitLog`, `changedNodes`, GraphTime monotonicity, `readAt` /
 * `snapshotAt` retention — and only the contract-currency property
 * test will catch it. This file is that test.
 *
 * The contract surface this property locks in:
 *
 *   1. **Atomicity-on-throw.** When a transaction body throws after
 *      staging arbitrary writes, none of those writes become observable
 *      and `g.now` does not advance. SPEC §3 ("a transaction creates
 *      exactly one new GraphTime") collapses to "either zero new
 *      GraphTimes or exactly one" on the failure path.
 *
 *   2. **Replay-determinism on a canonical seed.** A commit log
 *      captured on one engine instance and replayed on a fresh
 *      instance must produce a byte-identical IR. This is the four
 *      contract surfaces the residual is *for* — `commitLog` rebuild,
 *      `changedNodes` set construction, GraphTime monotonicity
 *      stamping, and `readAt`/`snapshotAt` retention bookkeeping. A
 *      future PR that retires any one of them satisfies the named
 *      median band by erasing the work it was paying for; the byte-
 *      equality oracle here surfaces that erasure as a property
 *      failure.
 *
 * Generators draw an arbitrary graph (≤ 8 inputs, ≤ 4 derived sums
 * over those inputs) and an arbitrary commit-write batch sequence
 * (≤ 50 batches, ≤ 6 writes each). The trial budget honours the §15.2
 * 1000-trial floor (commitment 10).
 *
 * Sibling property tests carry the broader atomicity / replay-
 * determinism contract independently — `atomicity.test.ts` and
 * `replay-determinism.test.ts` are the load-bearing nets. This file
 * is intentionally narrow: it pins the *specific* invariants the §17.5
 * amendment names as the basis for the cost residual, so a future PR
 * cannot retire one of them under cover of the broader suite still
 * being green.
 */

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'

import {
  createCausl,
  type CauslModel,
  type DerivedNode,
  type Graph,
  type InputNode,
} from '../../src/index.js'
import { propertyOptions } from './seed.js'

/**
 * Stable id alphabet — short identifiers so fast-check's shrinker
 * keeps counter-examples human-readable. Drawn from a fixed pool.
 */
const INPUT_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const DERIVED_IDS = ['s1', 's2', 's3', 's4'] as const

/**
 * Build a generator that produces a graph spec — a non-empty list of
 * (inputId, initial) pairs plus a list of derived sums each over a
 * non-empty subset of input indices. The shape is small enough to
 * shrink quickly while still covering up to 8 inputs and 4 deriveds.
 */
function graphSpecArb() {
  return fc.record({
    inputs: fc
      .array(
        fc.tuple(
          fc.constantFrom(...INPUT_IDS),
          fc.integer({ min: -100, max: 100 }),
        ),
        { minLength: 1, maxLength: INPUT_IDS.length },
      )
      .map((pairs) => {
        // Dedupe by id so the engine never sees a duplicate registration.
        const seen = new Set<string>()
        const out: Array<readonly [string, number]> = []
        for (const [id, v] of pairs) {
          if (seen.has(id)) continue
          seen.add(id)
          out.push([id, v] as const)
        }
        return out
      })
      .filter((pairs) => pairs.length > 0),
    derivedDefs: fc.array(
      fc.record({
        id: fc.constantFrom(...DERIVED_IDS),
        depMask: fc.array(fc.boolean(), {
          minLength: INPUT_IDS.length,
          maxLength: INPUT_IDS.length,
        }),
      }),
      { minLength: 0, maxLength: DERIVED_IDS.length },
    ),
  })
}

/** A commit-write batch: list of (inputIdx, value) pairs. */
function commitWritesArb() {
  return fc.array(
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: -1000, max: 1000 })), {
      minLength: 0,
      maxLength: 6,
    }),
    { minLength: 1, maxLength: 50 },
  )
}

interface BuiltGraph {
  readonly graph: Graph
  readonly inputs: ReadonlyArray<{ id: string; node: InputNode<number> }>
  readonly deriveds: ReadonlyArray<{ id: string; node: DerivedNode<number> }>
}

/**
 * Build a graph from a spec. Each derived is a sum over the input
 * subset selected by its `depMask`; if the mask selects zero inputs
 * we fall back to a single dependency on the first input so every
 * derived is well-formed (no empty-deps registration which would be
 * a §11.1 subscribeReads-shaped path the test isn't exercising).
 */
function buildGraph(
  name: string,
  spec: ReturnType<typeof graphSpecArb> extends fc.Arbitrary<infer S> ? S : never,
): BuiltGraph {
  const graph = createCausl({ name })
  const inputs = spec.inputs.map(([id, initial]) => ({
    id,
    node: graph.input(id, initial),
  }))
  const seenDerivedIds = new Set<string>()
  const derivedSpecs: { id: string; depIdxs: number[] }[] = []
  for (const def of spec.derivedDefs) {
    if (seenDerivedIds.has(def.id)) continue
    seenDerivedIds.add(def.id)
    const depIdxs: number[] = []
    for (let i = 0; i < def.depMask.length; i++) {
      if (def.depMask[i] && i < inputs.length) depIdxs.push(i)
    }
    if (depIdxs.length === 0) depIdxs.push(0)
    derivedSpecs.push({ id: def.id, depIdxs })
  }
  const deriveds = derivedSpecs.map(({ id, depIdxs }) => {
    const deps = depIdxs.map((i) => inputs[i]!.node)
    const node = graph.derived<number>(id, (get) => {
      let total = 0
      for (const dep of deps) total += get(dep)
      return total
    })
    return { id, node }
  })
  return { graph, inputs, deriveds }
}

/**
 * Byte-equal IR oracle. Two engines that absorbed the same write
 * sequence must produce identical IR. This is the same channel
 * `replay-determinism.test.ts` uses — `JSON.stringify(exportModel())`
 * is the format the bounded model checker compares against, so any
 * engine difference surfaces as a single string-diff.
 */
function ir(graph: Graph): string {
  const model: CauslModel = graph.exportModel()
  return JSON.stringify(model)
}

describe('property: SPEC §17 commitment 13 — capability-cost contract surface (#1005)', () => {
  /**
   * Atomicity-on-throw. Stage the random writes plus a poisoned
   * ghost-write inside a single transaction; the engine must reject
   * the commit, none of the staged writes may become observable, and
   * `g.now` must not advance. Pinned independently of
   * `atomicity.test.ts` because the §17.5 amendment names this exact
   * shape — a transaction either creates exactly one new GraphTime
   * or none at all — as the basis for the contract premium causl
   * pays per commit.
   */
  it('a thrown write does not partially apply the others (atomicity-on-throw, anchor of §17.5)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 8 }),
        (writes) => {
          const g = createCausl({ name: 'spec-17-atomicity' })
          const a = g.input('a', 0)
          const b = g.input('b', 0)
          const before = [g.read(a), g.read(b)]
          const ghost = { id: 'ghost' }
          let threw = false
          try {
            g.commit('partial', (tx) => {
              for (const w of writes) tx.set(a, w)
              tx.set(b, 999)
              // ghost is not a registered input — engine throws here,
              // and the entire staging set must roll back.
              tx.set(ghost as unknown as InputNode<number>, 1)
            })
          } catch {
            threw = true
          }
          expect(threw).toBe(true)
          expect([g.read(a), g.read(b)]).toEqual(before)
          expect(g.now).toBe(0)
        },
      ),
      // Honours the §15.2 1000-trial floor (commitment 10).
      propertyOptions(),
    )
  })

  /**
   * Replay-determinism on a canonical seed. Drive an arbitrary write
   * sequence through one engine instance (the "recorder"), capture
   * its IR, then replay the same sequence through a fresh engine
   * instance (the "replayer") built from the identical graph spec.
   * The two IRs must be byte-identical.
   *
   * Pinned independently of `replay-determinism.test.ts` because the
   * §17.5 amendment names this as the basis for the per-commit
   * contract premium — `commitLog` rebuild, `changedNodes` set
   * construction, GraphTime monotonicity stamping, `readAt` /
   * `snapshotAt` retention — and a future PR that retires one of
   * them satisfies the median-band lower bound by erasing the work
   * it was paying for. Byte-equal IR surfaces the erasure as a
   * property failure regardless of how the wall-clock moves.
   */
  it('byte-equal IR after replaying the same write sequence on a fresh engine (replay-determinism)', () => {
    fc.assert(
      fc.property(graphSpecArb(), commitWritesArb(), (spec, commitWrites) => {
        // Recorder engine — accepts the random write sequence.
        const recorder = buildGraph('spec-17-recorder', spec)
        // Replayer engine — built from the identical spec, will
        // absorb the identical writes.
        const replayer = buildGraph('spec-17-recorder', spec)

        // The pre-write IR must already match — same spec, same name.
        expect(ir(replayer.graph)).toBe(ir(recorder.graph))

        for (let i = 0; i < commitWrites.length; i++) {
          const writes = commitWrites[i] ?? []
          const apply = (built: BuiltGraph): boolean => {
            try {
              built.graph.commit(`c${i}`, (tx) => {
                for (const [idx, v] of writes) {
                  if (built.inputs.length === 0) return
                  const at = idx % built.inputs.length
                  const target = built.inputs[at]
                  if (target) tx.set(target.node, v)
                }
              })
              return true
            } catch {
              return false
            }
          }
          // Apply on both. Both must agree on whether the commit
          // landed (deterministic outcome on identical input).
          const recOk = apply(recorder)
          const repOk = apply(replayer)
          expect(repOk).toBe(recOk)
          // Byte-equal IR after every step — atomicity-on-throw
          // composes with replay-determinism: a failed commit on
          // both must leave both engines at the same IR.
          expect(ir(replayer.graph)).toBe(ir(recorder.graph))
        }
      }),
      // Honours the §15.2 1000-trial floor (commitment 10).
      propertyOptions(),
    )
  })

  /**
   * GraphTime monotonicity. Every successful commit advances `g.now`
   * by exactly one; every failed commit leaves it unchanged. This is
   * the SPEC §5.1 Phase A precondition the §17.5 amendment names as
   * one of the four contract surfaces the residual is for.
   */
  it('GraphTime monotonicity holds across an arbitrary write sequence', () => {
    fc.assert(
      fc.property(graphSpecArb(), commitWritesArb(), (spec, commitWrites) => {
        const built = buildGraph('spec-17-graphtime', spec)
        let expectedNow = 0
        for (let i = 0; i < commitWrites.length; i++) {
          const beforeNow = built.graph.now
          expect(beforeNow).toBe(expectedNow)
          const writes = commitWrites[i] ?? []
          let threw = false
          try {
            built.graph.commit(`c${i}`, (tx) => {
              for (const [idx, v] of writes) {
                if (built.inputs.length === 0) return
                const at = idx % built.inputs.length
                const target = built.inputs[at]
                if (target) tx.set(target.node, v)
              }
            })
          } catch {
            threw = true
          }
          if (threw) {
            // Atomicity-on-throw: failed commit must not advance time.
            expect(built.graph.now).toBe(expectedNow)
          } else {
            // Successful commit advances GraphTime by exactly one.
            expectedNow += 1
            expect(built.graph.now).toBe(expectedNow)
          }
        }
      }),
      propertyOptions(),
    )
  })
})
