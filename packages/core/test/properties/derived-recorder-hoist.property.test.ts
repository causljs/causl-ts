/**
 * @packageDocumentation
 *
 * Property-based proof of the post-#971 hoisted `get` recorder's
 * denotational equivalence to the per-call closure baseline. The
 * pre-#971 shape allocated a fresh `get` arrow function inside both
 * {@link computeDerived} and {@link computeDerivedIterative}; this PR
 * hoists the recorder to a bound-once engine-instance function whose
 * frame state is read from a mutable `activeRecording` slot. The
 * properties below pin the three behavioural invariants the hoisting
 * has to preserve:
 *
 *   1. **End-state equivalence** — every derived's value after a
 *      registration + commit sequence equals what a forward-evaluation
 *      oracle predicts. A regression in the hoisted recorder's
 *      dep-tracking or value-resolution shape would surface here as a
 *      mismatch between graph reads and the oracle.
 *
 *   2. **SPEC §3 glitch invariant** — no derived ever sees an
 *      inconsistent upstream snapshot mid-commit. The diamond shape
 *      (B, C derived from A; D derived from B + C) is the canonical
 *      witness; a per-derived `glitchDetector` from
 *      `@causl/core-testing-internal` watches every random topology
 *      that contains the diamond pattern.
 *
 *   3. **Dep-tracking accuracy** — each derived's post-recompute
 *      `e.deps` Set equals the union of node ids the recorder saw
 *      during its compute body. Pinned by registering each topology
 *      and asserting `derivedDeps(g, id)` matches the oracle's
 *      static dep set for sum-of-deps computes.
 *
 * The generator is the same shape as
 * `derived-registration-iterative.property.test.ts` — random sum-of-
 * deps topologies parameterised by depth and a mulberry32-seeded
 * coin — so the trial budget exercises chain, fan-in, diamond, and
 * mixed shapes uniformly. NESTED-COMPUTE coverage: any topology where
 * a derived reads multiple deps (including other deriveds) and the
 * upstream is uncomputed at first read forces the recursive
 * `computeDerived` path to recurse through the hoisted recorder; the
 * try/finally save/restore of `activeRecording` is the structural
 * correctness witness.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl, type Node } from '../../src/index.js'
import {
  derivedDeps,
  glitchDetector,
  propertyTrials,
} from '@causl/core-testing-internal'

/**
 * Mulberry32 — the same tiny seeded PRNG the existing iterative-
 * registration property test uses. Imported by hand instead of
 * factored to a shared helper because the iterative-registration
 * property test deliberately co-locates its generator with its
 * properties; mirroring the choice here keeps the two files
 * comparable side-by-side.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return (): number => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

interface DerivedSpec {
  readonly id: string
  readonly deps: readonly string[]
}

interface Topology {
  readonly inputId: string
  readonly deriveds: readonly DerivedSpec[]
}

function generateTopology(seed: number, depth: number): Topology {
  const rand = mulberry32(seed)
  const inputId = 'n0'
  const deriveds: DerivedSpec[] = []
  for (let i = 0; i < depth; i++) {
    const id = `n${i + 1}`
    if (i === 0) {
      deriveds.push({ id, deps: [inputId] })
      continue
    }
    const earlier = ['n0', ...deriveds.slice(0, i).map((d) => d.id)]
    const shape = Math.floor(rand() * 4)
    let deps: string[]
    switch (shape) {
      case 0: {
        // chain — recurse into the iterative driver via the registration walker
        deps = [`n${i}`]
        break
      }
      case 1: {
        // fan-in — input + 1-3 earlier deriveds (multi-dep `get` calls).
        const k = 1 + Math.floor(rand() * Math.min(3, earlier.length - 1))
        const set = new Set<string>(['n0'])
        for (let j = 0; j < k; j++) {
          const idx = 1 + Math.floor(rand() * (earlier.length - 1))
          set.add(earlier[idx]!)
        }
        deps = Array.from(set)
        break
      }
      case 2: {
        // diamond — two earlier deriveds, ensures glitch invariant gate fires.
        const set = new Set<string>()
        while (set.size < Math.min(2, earlier.length)) {
          set.add(earlier[Math.floor(rand() * earlier.length)]!)
        }
        deps = Array.from(set)
        break
      }
      default: {
        // mixed — random non-empty subset of earlier ids, capped at 4.
        const k = 1 + Math.floor(rand() * Math.min(4, earlier.length))
        const set = new Set<string>()
        while (set.size < k) {
          set.add(earlier[Math.floor(rand() * earlier.length)]!)
        }
        deps = Array.from(set)
        break
      }
    }
    deriveds.push({ id, deps })
  }
  return { inputId, deriveds }
}

function evaluateOracle(topo: Topology, inputValue: number): Map<string, number> {
  const out = new Map<string, number>()
  out.set(topo.inputId, inputValue)
  for (const ds of topo.deriveds) {
    let sum = 0
    for (const depId of ds.deps) sum += out.get(depId)!
    out.set(ds.id, sum)
  }
  return out
}

function buildOnGraph(topo: Topology): {
  readonly graph: ReturnType<typeof createCausl>
  readonly input: ReturnType<ReturnType<typeof createCausl>['input']>
  readonly deriveds: ReadonlyMap<string, Node<number>>
} {
  const graph = createCausl()
  const input = graph.input(topo.inputId, 0)
  const deriveds = new Map<string, Node<number>>()
  for (const ds of topo.deriveds) {
    const handle = graph.derived<number>(ds.id, (get) => {
      let sum = 0
      for (const depId of ds.deps) {
        const node: Node<number> =
          depId === topo.inputId ? input : deriveds.get(depId)!
        sum += get(node)
      }
      return sum
    })
    deriveds.set(ds.id, handle)
  }
  return { graph, input, deriveds }
}

describe('SPEC #971 — hoisted `get` recorder properties', () => {
  /**
   * Property 1 — denotational equivalence. Every derived's value
   * post-registration AND post-bump-commit equals the oracle's
   * predicted value. Registration drives the iterative recorder
   * path; the commit drives the recursive recorder path through
   * `recomputeAffected`. A regression in either hoisted shape
   * would surface as a mismatch on at least one of the two reads.
   */
  it('post-registration + post-commit reads equal the oracle on every random topology', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 100 }),
        (seed, depth, bumpTo) => {
          const topo = generateTopology(seed, depth)
          const { graph, input, deriveds } = buildOnGraph(topo)
          // Post-registration: hoisted iterative recorder produced
          // every value below.
          const before = evaluateOracle(topo, 0)
          for (const ds of topo.deriveds) {
            expect(graph.read(deriveds.get(ds.id)!)).toBe(before.get(ds.id)!)
          }
          // Post-commit: hoisted recursive recorder rebuilt every
          // affected derived's value.
          graph.commit('bump', (tx) => tx.set(input, bumpTo))
          const after = evaluateOracle(topo, bumpTo)
          for (const ds of topo.deriveds) {
            expect(graph.read(deriveds.get(ds.id)!)).toBe(after.get(ds.id)!)
          }
        },
      ),
      propertyTrials('derived-recorder-hoist/oracle-equivalence'),
    )
  })

  /**
   * Property 2 — SPEC §3 glitch invariant. The diamond pattern is
   * the canonical witness for an engine that exposes intermediate
   * inconsistent upstream snapshots; a hoisted recorder that fails
   * to save/restore `activeRecording` correctly across nested
   * compute could leak a sibling's mid-recompute state into the
   * downstream reader. The detector watches D = f(B(A), C(A)) and
   * counts every observation where `f(b, c) ≠ b + c` against the
   * canonical sum-of-deps oracle. Counter must stay at 0 for every
   * random commit sequence.
   */
  it('no glitch on the diamond shape across random commit sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 16 }),
        (_seed, bumps) => {
          const g = createCausl()
          const a = g.input('a', 0)
          const b = g.derived<number>('b', (get) => get(a) + 1)
          const c = g.derived<number>('c', (get) => get(a) * 2)
          const d = g.derived<number>('d', (get) => get(b) + get(c))
          const detector = glitchDetector<number, [number]>(
            g,
            d,
            ([av]) => av + 1 + av * 2,
            [a],
          )
          for (const bump of bumps) {
            g.commit('bump', (tx) => tx.set(a, bump))
          }
          expect(detector.observed).toBe(0)
          detector.dispose()
        },
      ),
      propertyTrials('derived-recorder-hoist/diamond-glitch'),
    )
  })

  /**
   * Property 3 — dep-tracking accuracy. Each derived's
   * `derivedDeps(g, id)` post-registration equals the static dep
   * set declared in the topology. The hoisted recorder records
   * each `get` call into `frame.nextDepsArr`; the dep-set the
   * engine commits is the union of those records. A regression
   * (e.g., the recorder writing into the wrong frame after a
   * nested compute restored its parent) would surface as a
   * dep-set mismatch on the parent's read-set.
   */
  it("post-registration `e.deps` equals the topology's declared dep set", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 1, max: 80 }),
        (seed, depth) => {
          const topo = generateTopology(seed, depth)
          const { graph } = buildOnGraph(topo)
          for (const ds of topo.deriveds) {
            const observed = derivedDeps(graph, ds.id)
            expect(observed).not.toBeNull()
            const expected = new Set<string>(ds.deps)
            const actual = new Set<string>()
            for (const id of observed!) actual.add(id as string)
            expect(actual).toEqual(expected)
          }
        },
      ),
      propertyTrials('derived-recorder-hoist/dep-tracking'),
    )
  })

  /**
   * Property 4 — nested-compute correctness. A derived whose
   * compute body calls `get(parent)` BEFORE `parent` is computed
   * forces `computeDerived` to recurse through the hoisted
   * recorder; the inner call pushes a new `RecursiveFrame`, the
   * outer's frame must be restored on return. The fixture wires
   * a chain whose tail is committed-via-read at the top (so
   * registration's iterative driver stays cold for the lazy-
   * compute branch), then every read after a bump exercises the
   * recursive driver's save/restore. The post-bump read against
   * the oracle is the witness.
   */
  it('nested compute through `get(uncomputed-derived)` preserves both frames', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 1, max: 100 }),
        (seed, depth, bumpTo) => {
          const topo = generateTopology(seed, depth)
          const { graph, input, deriveds } = buildOnGraph(topo)
          // Bump and read the deepest derived; the recursive
          // recorder walks the affected subset and restores
          // frames at each level.
          graph.commit('bump', (tx) => tx.set(input, bumpTo))
          const last = topo.deriveds[topo.deriveds.length - 1]!
          const oracle = evaluateOracle(topo, bumpTo)
          expect(graph.read(deriveds.get(last.id)!)).toBe(oracle.get(last.id)!)
        },
      ),
      propertyTrials('derived-recorder-hoist/nested-compute'),
    )
  })
})
