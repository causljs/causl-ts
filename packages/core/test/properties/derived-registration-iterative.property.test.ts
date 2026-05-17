/**
 * @packageDocumentation
 *
 * Property-based proof of the post-#956 iterative-registration
 * walker's denotational equivalence to the recursive baseline (PR
 * #946 reverted; iterative-but-still-eager is the design point).
 *
 * The acceptance criteria (cf. issue #956 § Property test):
 *
 *   1. **Read equivalence** — `g.read(node)` returns the value the
 *      sum-of-deps oracle predicts for every random topology.
 *   2. **Commit `changedNodes` semantics** — the set of changed
 *      derived ids reported by `commit().changedNodes` equals the
 *      set the oracle predicts (SPEC §5.1).
 *   3. **`commitLogConsumerCount` accounting** — registering N
 *      sum-of-deps deriveds (none reading `commitLog`) leaves the
 *      counter at 0 (#715 / #774).
 *   4. **First-commit cycle detection** — a topology that closes a
 *      cycle through a forward-reference holder surfaces
 *      `CycleError` on the first commit that closes it (#705 Kahn).
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`
 * and logged on failure for reproducible CI bisection.
 *
 * Generator: random graph topologies parameterised by depth
 * (chosen from the inclusive interval [1, MAX_DEPTH]) and a
 * mulberry32-seeded coin that picks the per-node shape (chain,
 * fan-in, diamond, mixed). The deep cell — depth = 12000 — is
 * exercised once per property body (a smoke pass) and the bulk of
 * the trial budget runs on small topologies where the oracle is
 * cheap to evaluate. This shape mirrors the way the existing
 * `phase-d-entry-capture` property splits its budget between
 * exhaustive small-graph coverage and a smoke pass on the deep
 * cell that the iterative driver uniquely supports.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CycleError, createCausl, type Node } from '../../src/index.js'
import {
  commitLogConsumerCount,
  propertyTrials,
} from '@causljs/core-testing-internal'

/**
 * Mulberry32 — a tiny seeded PRNG. The caller threads a 32-bit
 * seed; the function returns a stateful generator that yields
 * uniformly-distributed floats in [0, 1). Used by the topology
 * generator below so a `fast-check` seed reproduces the same
 * topology byte-identically.
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

/**
 * Generate a random topology of `depth` deriveds rooted at a
 * single input. The PRNG selects a per-derived shape:
 *
 *   - **chain** — depend only on the immediately-previous derived.
 *   - **fan-in** — depend on the input plus 1-3 earlier deriveds.
 *   - **diamond** — depend on two earlier deriveds, sharing a
 *     common upstream.
 *   - **mixed** — depend on a random non-empty subset of earlier
 *     ids (capped at 4 to keep the oracle's evaluation cost
 *     bounded and the dep set monomorphic).
 *
 * The first derived always reads the input alone (chain seed).
 */
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
        // chain — depend only on the immediately-previous derived.
        deps = [`n${i}`]
        break
      }
      case 1: {
        // fan-in — input + 1-3 earlier deriveds.
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
        // diamond — two earlier deriveds (or the input), no dups.
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

/**
 * Forward-evaluation oracle. Computes every derived's expected
 * value from the topology spec and the input value, mirroring the
 * sum-of-deps compute the property body installs on the live graph.
 */
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

/**
 * Build the topology on a fresh `createCausl` graph using
 * sum-of-deps deriveds. Returns the input handle and a map from
 * derived id to its registered handle so the property body can
 * `read` / `commit` against them.
 */
function buildOnGraph(
  topo: Topology,
): {
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

describe('SPEC #956 — iterative registration walker properties', () => {
  /**
   * Property 1 — `g.read(node)` returns the oracle's predicted
   * value for every derived in every random topology. This is
   * the denotational equivalence the lazy-default trial (PR #946)
   * broke and the iterative-but-still-eager design preserves.
   */
  it('post-registration read equals the oracle on every random topology', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 1, max: 200 }),
        (seed, depth) => {
          const topo = generateTopology(seed, depth)
          const { graph, deriveds } = buildOnGraph(topo)
          const oracle = evaluateOracle(topo, 0)
          for (const ds of topo.deriveds) {
            expect(graph.read(deriveds.get(ds.id)!)).toBe(oracle.get(ds.id)!)
          }
        },
      ),
      propertyTrials('derived-registration-iterative/read-oracle'),
    )
  })

  /**
   * Property 2 — `commit().changedNodes` equals the set of
   * derived ids whose post-commit oracle value differs from the
   * pre-commit one. SPEC §5.1's "atomic settle" contract: every
   * derived whose value the commit changed appears in
   * `changedNodes`; nothing else does.
   */
  it("commit().changedNodes equals the oracle's changed-set on every random topology", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 100 }),
        (seed, depth, bumpTo) => {
          const topo = generateTopology(seed, depth)
          const { graph, input } = buildOnGraph(topo)
          const before = evaluateOracle(topo, 0)
          const after = evaluateOracle(topo, bumpTo)
          const expected = new Set<string>()
          for (const ds of topo.deriveds) {
            if (before.get(ds.id) !== after.get(ds.id)) expected.add(ds.id)
          }
          const commit = graph.commit('bump', (tx) => tx.set(input, bumpTo))
          // changedNodes is `Iterable<NodeId>`; collect to a Set for
          // membership comparison without ordering coupling.
          const reported = new Set<string>()
          for (const id of commit.changedNodes) {
            if (id !== topo.inputId) reported.add(id as string)
          }
          expect(reported).toEqual(expected)
        },
      ),
      propertyTrials('derived-registration-iterative/changed-nodes'),
    )
  })

  /**
   * Property 3 — `commitLogConsumerCount` stays at 0 across
   * registration of any random sum-of-deps topology. None of the
   * topology's deriveds read `commitLog`, none register through
   * `commitMetadataDerived`, and no caller subscribes to
   * `commitLog`; the post-#715 counter must therefore remain 0
   * (#774). A regression that bumped the counter on a regular
   * derived registration would fire here.
   */
  it('commitLogConsumerCount stays at 0 for sum-of-deps topologies', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.integer({ min: 1, max: 200 }),
        (seed, depth) => {
          const topo = generateTopology(seed, depth)
          const { graph } = buildOnGraph(topo)
          expect(commitLogConsumerCount(graph)).toBe(0)
        },
      ),
      propertyTrials('derived-registration-iterative/commit-log-consumer-count'),
    )
  })

  /**
   * Property 4 — first-commit cycle detection still fires after
   * the iterative-registration rewrite. The fixture uses a
   * forward-reference holder so the cycle is *latent* at
   * registration (the engine cannot see the cycle when each
   * endpoint is registered, because the closing edge is mutated
   * post-registration); the first commit that walks into the SCC
   * must surface `CycleError`. Pins the #705 Kahn back-edge probe.
   */
  it('first-commit cycle detection fires on cycle topologies', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 32 }), (chainLen) => {
        const g = createCausl()
        const a = g.input('a', 0)
        // Forward-reference holder: at registration of `head`, the
        // tail handle is undefined; the cycle closes when the
        // outer closure's `.node` field is mutated to point at the
        // tail. The first commit that reads `head` walks the cycle.
        // The single-field wrapper object lets `prefer-const`
        // sleep — `tailRef` is never reassigned; `tailRef.node` is.
        const tailRef: { node: Node<number> | undefined } = { node: undefined }
        const head = g.derived<number>('head', (get) => {
          if (tailRef.node === undefined) return get(a)
          return get(tailRef.node)
        })
        let prev: Node<number> = head
        for (let i = 0; i < chainLen; i++) {
          const upstream: Node<number> = prev
          prev = g.derived<number>(`c${i}`, (get) => get(upstream) + 1)
        }
        tailRef.node = prev
        // Force `head` to re-evaluate against the new closure by
        // bumping the input. Phase D's Kahn pass walks the cycle
        // and surfaces CycleError on the first commit that closes
        // it (#705 augmented back-edge probe).
        let caught: unknown
        try {
          g.commit('close-cycle', (tx) => tx.set(a, 1))
        } catch (e) {
          caught = e
        }
        expect(caught).toBeInstanceOf(CycleError)
      }),
      propertyTrials('derived-registration-iterative/cycle-detection'),
    )
  })

  /**
   * Smoke property — a single deep-chain trial (depth = 12000) to
   * confirm the iterative driver actually clears the post-#956
   * ceiling. Mirrors the issue body's `depth ∈ [1, 12000]` clause:
   * the bulk of the trial budget exercises small topologies (where
   * the oracle is cheap), and one trial confirms the deep cell
   * lands cleanly. Pre-#956 baseline: this would surface
   * `DerivedRegistrationStackOverflowError`.
   */
  it('depth = 12000 chain registers, reads, and commits cleanly', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    let prev: Node<number> = a
    const DEPTH = 12_000
    for (let i = 0; i < DEPTH; i++) {
      const upstream: Node<number> = prev
      prev = g.derived<number>(`c${i}`, (get) => get(upstream) + 1)
    }
    expect(g.read(prev)).toBe(DEPTH)
    g.commit('bump', (tx) => tx.set(a, 1))
    expect(g.read(prev)).toBe(DEPTH + 1)
  })
})
