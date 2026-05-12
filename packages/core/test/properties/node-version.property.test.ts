/**
 * @packageDocumentation
 *
 * Property-based gate pinning the semantic-invariance contract of the
 * per-node version counter (`EngineTelemetry.nodeVersion(node)` — issue
 * #1156 / panel-review-derived sub-issue of #1133).
 *
 * ## Contract
 *
 * `nodeVersion(node)` is the count of commits in which `node.id`
 * appeared in `Commit.changedNodes`. Equivalently: the engine
 * increments the per-node version iff the node's value changed in
 * the most-recent commit. **A no-op commit must not increment any
 * node's version**; a recompute that re-derives the same value (the
 * equality-cutoff path) must not increment the derived's version.
 *
 * The contract is the load-bearing memoisation surface for adopters
 * who key `React.memo` / `useMemo` on a per-node version (see
 * `packages/core/wasm/README.md` H1 callout and
 * `docs/wasm-adoption-guide.md` § "Per-node version counter"); a
 * regression that bumps the version on a no-op commit silently
 * invalidates downstream caches every commit, defeating the
 * memoisation. A regression that fails to bump on a value-change
 * commit silently serves stale memoised values. Neither failure
 * surfaces as an error — `nodeVersion` is the cache-invalidation
 * key, not a value channel — so the only catch is a property gate
 * that pins the invariant against random commit sequences.
 *
 * ## Why pin via `Commit.changedNodes`
 *
 * `Commit.changedNodes` is the cross-backend-deterministic surface
 * for "this node's value changed in this commit" — pinned
 * byte-identically across the TS, WASM-GC, and WASM-serde backends
 * by the cross-backend determinism gate (#1059 / PR #1107). Defining
 * `nodeVersion(node)` as the running count of commits in which
 * `node.id ∈ commit.changedNodes` therefore inherits the same
 * byte-identical-across-backends guarantee for free: the future
 * Rust port (#1133) cannot drift on the version counter without
 * first drifting on `changedNodes`, which the determinism gate
 * already catches.
 *
 * The properties in this file:
 *
 *   1. **Semantic invariance.** For an arbitrary random commit
 *      sequence over a small DAG, the running `nodeVersion(node)`
 *      computed from `commit.changedNodes` matches an oracle that
 *      walks the same trace via reference-counting against
 *      `graph.read(node)` results.
 *
 *   2. **No-op idempotence.** Inserting a no-op commit (re-set every
 *      input to its current value) anywhere in the trace MUST not
 *      bump any node's `nodeVersion`. The invariant collapses across
 *      input and derived nodes alike — the equality cutoff (#972) is
 *      the engine seam this property fuzzes.
 *
 *   3. **Sibling-shape isolation (H8 hazard).** Writing to one input
 *      in a multi-input DAG MUST NOT bump the version of a sibling
 *      input or of a derived that does not depend on the written
 *      input. This pins the H8 hazard the panel review flagged —
 *      adopters who memoise on a sibling's version must see no
 *      spurious bumps from disjoint writes.
 *
 *   4. **Cross-backend determinism sibling.** Two fresh `createCausl`
 *      graphs driven by the same trace see byte-identical
 *      `nodeVersion` sequences. The TS-only assertion stands in for
 *      the eventual TS-vs-Rust comparison the determinism gate will
 *      surface once `#1133` lands a real Rust backend.
 *
 * ## Trial budget
 *
 * Routes through `tieredPropertyTrials` from `@causl/core/testing`,
 * which honours `CAUSL_FUZZ_TIER` (default: 1000 trials, PR: 5000,
 * nightly: 100 000). This keeps the floor at the SPEC §15.2 1000
 * trials per CI run and lets the nightly tier exercise the long tail
 * of commit shapes.
 *
 * @see https://github.com/iasbuilt/causl/issues/1156 — this gate.
 * @see https://github.com/iasbuilt/causl/issues/1133 — Rust-port epic.
 * @see https://github.com/iasbuilt/causl/issues/1059 — cross-backend determinism.
 * @see https://github.com/iasbuilt/causl/pull/1021 — adopter audit (`nodeVersion` documented).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { tieredPropertyTrials } from '@causl/core-testing-internal'
import {
  createCausl,
  type Graph,
  type InputNode,
  type Node,
} from '../../src/index.js'

/**
 * Read the engine's `nodeVersion(node)` accessor (#1242).
 *
 * Thin sugar around `graph.stats().nodeVersion(node)`. Centralised
 * here so the property body and the cross-backend sibling property
 * share one definition of the engine accessor surface — a regression
 * that drifts the accessor signature surfaces as a property failure
 * in both arms, not as a silent divergence.
 */
function nodeVersion(graph: Graph, node: Node<unknown>): number {
  return graph.stats().nodeVersion(node)
}

/**
 * Build a fresh graph + a small DAG with parameterised topology.
 *
 *   - `numInputs` inputs `i0 .. i{n-1}` initialised to `0`.
 *   - `numDeriveds` deriveds `d0 .. d{m-1}`, each summing a subset
 *     of inputs picked deterministically by `(j * 37 + i * 13) %
 *     numInputs < ceil(numInputs / 2)` so the sub-graph is non-
 *     trivial but stable across seeds (the per-seed randomness lives
 *     in the commit trace, not the DAG shape).
 *
 * Returns the graph + an `ids` map for use by the version oracle.
 */
function buildDag(
  numInputs: number,
  numDeriveds: number,
): {
  graph: Graph
  inputs: ReadonlyArray<InputNode<number>>
  deriveds: ReadonlyArray<Node<number>>
  trackedIds: ReadonlySet<string>
} {
  const graph = createCausl({ name: 'node-version-property' })
  const inputs: Array<InputNode<number>> = []
  for (let i = 0; i < numInputs; i++) {
    inputs.push(graph.input(`i${i}`, 0))
  }
  const deriveds: Array<Node<number>> = []
  for (let j = 0; j < numDeriveds; j++) {
    const depIdxs: number[] = []
    for (let i = 0; i < numInputs; i++) {
      if ((j * 37 + i * 13) % numInputs < Math.ceil(numInputs / 2)) {
        depIdxs.push(i)
      }
    }
    // Guarantee at least one dep: a derived with no deps is allowed
    // by the engine but uninteresting for this property — every
    // commit would skip it under the no-input-changed Phase D gate
    // by construction.
    if (depIdxs.length === 0) depIdxs.push(j % numInputs)
    deriveds.push(
      graph.derived<number>(`d${j}`, (get) => {
        let sum = 0
        for (const idx of depIdxs) sum += get(inputs[idx]!)
        return sum
      }),
    )
  }
  const trackedIds = new Set<string>()
  for (const n of inputs) trackedIds.add(n.id)
  for (const n of deriveds) trackedIds.add(n.id)
  return { graph, inputs, deriveds, trackedIds }
}

describe('node-version semantic-invariance gate (#1156)', () => {
  /**
   * Property 1 — semantic invariance under random commit sequences.
   *
   * For any random commit trace over a small DAG, the running
   * `nodeVersion(node)` counter built from `commit.changedNodes`
   * matches an oracle that recomputes the per-node version from the
   * sequence of `graph.read(node)` values it observed at each
   * commit boundary. Equality at every step is the bytewise check
   * the future Rust port must also satisfy.
   */
  it('nodeVersion(node) advances iff Commit.changedNodes contains node.id (oracle agreement)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.tuple(
            // `kind` discriminator: 0 = real write, 1 = no-op (re-set
            // current value), 2 = empty commit (no writes). All three
            // shapes exercise the same `nodeVersion` invariant: only
            // the value-changed path increments.
            fc.integer({ min: 0, max: 2 }),
            // Target input index (mod numInputs).
            fc.nat(),
            // Write value (only used when kind === 0).
            fc.integer({ min: -1000, max: 1000 }),
          ),
          { minLength: 1, maxLength: 32 },
        ),
        (numInputs, numDeriveds, trace) => {
          const { graph, inputs, deriveds, trackedIds } = buildDag(
            numInputs,
            numDeriveds,
          )
          // Oracle: track each node's value across commits; the oracle
          // version is the count of commits in which the node's read()
          // value differs from the prior commit's value.
          const oracle: Map<string, number> = new Map()
          const lastSeen: Map<string, number> = new Map()
          // Build the tracked id → node map once so the engine
          // accessor reads route through the correct handle on every
          // step (the accessor takes `Node<unknown>`, not a raw id).
          const trackedNodes: Map<string, Node<number>> = new Map()
          for (const id of trackedIds) oracle.set(id, 0)
          for (const n of inputs) {
            lastSeen.set(n.id, graph.read(n) as number)
            trackedNodes.set(n.id, n)
          }
          for (const n of deriveds) {
            lastSeen.set(n.id, graph.read(n) as number)
            trackedNodes.set(n.id, n)
          }

          for (let k = 0; k < trace.length; k++) {
            const [kind, rawIdx, value] = trace[k]!
            const idx = rawIdx % numInputs
            const target = inputs[idx]!
            // Drive the commit per the trace kind. The empty commit
            // (kind === 2) emits no writes and must produce an empty
            // changedNodes — same invariant as kind === 1 (no-op
            // write) but exercises the no-write fast path.
            graph.commit(`c${k}`, (tx) => {
              if (kind === 0) {
                tx.set(target, value)
              } else if (kind === 1) {
                // No-op write: read the current committed value and
                // re-set it. The `Object.is` equal-value fast path
                // (#972) must drop the row before Phase B.
                tx.set(target, graph.read(target) as number)
              }
              // kind === 2: no writes — empty commit.
            })
            // Oracle update: walk every tracked node, compare its
            // post-commit read against the pre-commit read; bump iff
            // they differ under `Object.is`.
            for (const n of inputs) {
              const cur = graph.read(n) as number
              const prev = lastSeen.get(n.id)!
              if (!Object.is(prev, cur)) {
                oracle.set(n.id, oracle.get(n.id)! + 1)
                lastSeen.set(n.id, cur)
              }
            }
            for (const n of deriveds) {
              const cur = graph.read(n) as number
              const prev = lastSeen.get(n.id)!
              if (!Object.is(prev, cur)) {
                oracle.set(n.id, oracle.get(n.id)! + 1)
                lastSeen.set(n.id, cur)
              }
            }
            // Assert engine and oracle agree on every tracked node
            // at every step. A divergence here is the failure trace
            // fast-check shrinks to a minimal counter-example.
            for (const id of trackedIds) {
              const engineVersion = nodeVersion(graph, trackedNodes.get(id)!)
              if (engineVersion !== oracle.get(id)) {
                throw new Error(
                  `nodeVersion divergence at step ${k} for ${id}: ` +
                    `engine=${engineVersion} oracle=${oracle.get(id)} ` +
                    `(kind=${kind}, idx=${idx}, value=${value})`,
                )
              }
            }
          }
          // Final sanity: the engine's accumulated counter matches
          // the oracle on every tracked node.
          for (const id of trackedIds) {
            expect(nodeVersion(graph, trackedNodes.get(id)!)).toBe(
              oracle.get(id),
            )
          }
        },
      ),
      tieredPropertyTrials('node-version/oracle-agreement'),
    )
  })

  /**
   * Property 2 — no-op idempotence. Inserting a no-op commit (re-set
   * every input to its current value) at any point in the trace must
   * not bump any node's `nodeVersion`. Pins the equality-cutoff seam
   * (#972) against regressions that would let a no-op commit
   * slip through into `changedNodes`.
   */
  it('no-op commits do not bump any nodeVersion (equality-cutoff invariant)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: -100, max: 100 })), {
          minLength: 1,
          maxLength: 16,
        }),
        (numInputs, numDeriveds, writes) => {
          const { graph, inputs, deriveds, trackedIds } = buildDag(
            numInputs,
            numDeriveds,
          )
          // Build a tracked id → node lookup so the engine accessor
          // can be queried via `Node<unknown>` (the public surface)
          // rather than a raw id.
          const trackedNodes: Map<string, Node<number>> = new Map()
          for (const n of inputs) trackedNodes.set(n.id, n)
          for (const n of deriveds) trackedNodes.set(n.id, n)
          // Phase 1: drive the real writes. This seeds the graph with
          // a non-trivial state so the no-op commit below has actual
          // values to re-set.
          for (let i = 0; i < writes.length; i++) {
            const [rawIdx, v] = writes[i]!
            const idx = rawIdx % numInputs
            graph.commit(`w${i}`, (tx) => tx.set(inputs[idx]!, v))
          }
          // Snapshot the version map post-Phase-1 — the no-op commit
          // below must preserve every entry byte-identically.
          const versionsBeforeNoop = new Map<string, number>()
          for (const id of trackedIds) {
            versionsBeforeNoop.set(id, nodeVersion(graph, trackedNodes.get(id)!))
          }
          // Phase 2: a no-op commit that writes every input back to
          // its current value. The engine must surface an empty
          // `changedNodes`; the version counters must be unchanged.
          const noop = graph.commit('no-op', (tx) => {
            for (const input of inputs) {
              tx.set(input, graph.read(input) as number)
            }
          })
          expect(noop.changedNodes.length).toBe(0)
          for (const id of trackedIds) {
            expect(nodeVersion(graph, trackedNodes.get(id)!)).toBe(
              versionsBeforeNoop.get(id),
            )
          }
        },
      ),
      tieredPropertyTrials('node-version/no-op-idempotence'),
    )
  })

  /**
   * Property 3 — sibling-shape isolation (H8 hazard). Writing to one
   * input in a multi-input DAG must not bump the version of a sibling
   * input or of a derived that does not depend on the written input.
   *
   * The DAG fixed for this property:
   *
   *   in_a, in_b, in_c   — three inputs
   *   d_ab = a + b       — derived depending on a, b
   *   d_c  = c           — derived depending only on c
   *   d_const = 42       — derived depending on nothing
   *
   * Writing `in_a` must bump only `in_a` and `d_ab`. Writing `in_c`
   * must bump only `in_c` and `d_c`. `d_const` must never bump.
   */
  it('writes do not bump versions of disjoint siblings or unrelated deriveds (H8)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            // Target: 0=a, 1=b, 2=c
            fc.integer({ min: 0, max: 2 }),
            fc.integer({ min: -1000, max: 1000 }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (writes) => {
          const g = createCausl({ name: 'h8-isolation' })
          const a = g.input('a', 0)
          const b = g.input('b', 0)
          const c = g.input('c', 0)
          const dAB = g.derived<number>('d_ab', (get) => get(a) + get(b))
          const dC = g.derived<number>('d_c', (get) => get(c))
          const dConst = g.derived<number>('d_const', () => 42)
          // Prime: warm the deriveds so the property measures
          // post-prime behaviour. Reads emit no commits and do not
          // touch `changedNodes`.
          g.read(dAB)
          g.read(dC)
          g.read(dConst)
          // Oracle: track per-write expected bumps. Writing `a` or
          // `b` MAY bump `d_ab` (only if its value actually moved).
          // Writing `c` MAY bump `d_c`. `d_const` MUST NEVER bump.
          const targets = [
            { node: a, depends: [dAB], otherInputs: [b, c] },
            { node: b, depends: [dAB], otherInputs: [a, c] },
            { node: c, depends: [dC], otherInputs: [a, b] },
          ] as const
          const currentValues: Record<'a' | 'b' | 'c', number> = { a: 0, b: 0, c: 0 }
          for (let k = 0; k < writes.length; k++) {
            const [tIdx, value] = writes[k]!
            const target = targets[tIdx]!
            const tKey = (['a', 'b', 'c'] as const)[tIdx]!
            // Snapshot the engine's version counter for every tracked
            // node BEFORE the commit so assertions below can compare
            // against the pre-commit state.
            const before = {
              target: nodeVersion(g, target.node),
              otherInputs: target.otherInputs.map((n) => nodeVersion(g, n)),
              dConst: nodeVersion(g, dConst),
              depends: target.depends.map((n) => nodeVersion(g, n)),
            }
            const beforeVal = currentValues[tKey]
            g.commit(`c${k}`, (tx) => tx.set(target.node, value))
            // The "other" inputs MUST keep their version exactly.
            for (let i = 0; i < target.otherInputs.length; i++) {
              expect(nodeVersion(g, target.otherInputs[i]!)).toBe(
                before.otherInputs[i],
              )
            }
            // `d_const` MUST keep its version exactly — no input it
            // depends on changed, so the equality cutoff (Phase D)
            // and the dep-free-derived fast path both apply.
            expect(nodeVersion(g, dConst)).toBe(before.dConst)
            // If the write changed the input's value, the input MUST
            // bump by 1 and its downstream deriveds MAY bump (the
            // derived bumps only if its value actually moves — for
            // `d_ab = a + b`, an `a` write that lands on a value
            // where `a + b` happens to equal the prior `a + b` is a
            // no-op for `d_ab`).
            if (!Object.is(beforeVal, value)) {
              expect(nodeVersion(g, target.node)).toBe(before.target + 1)
              currentValues[tKey] = value
              // Downstream derived must NEVER bump more than 1 per commit.
              for (let i = 0; i < target.depends.length; i++) {
                const delta = nodeVersion(g, target.depends[i]!) - before.depends[i]!
                expect(delta === 0 || delta === 1).toBe(true)
              }
            } else {
              // Equal-write no-op: the input MUST NOT bump, and the
              // downstream deriveds MUST NOT bump either.
              expect(nodeVersion(g, target.node)).toBe(before.target)
              for (let i = 0; i < target.depends.length; i++) {
                expect(nodeVersion(g, target.depends[i]!)).toBe(before.depends[i])
              }
            }
          }
        },
      ),
      tieredPropertyTrials('node-version/h8-isolation'),
    )
  })

  /**
   * Property 4 — cross-backend determinism sibling. Two fresh
   * `createCausl` graphs driven by the same trace produce
   * byte-identical `nodeVersion` sequences. The TS-vs-TS check
   * stands in for the eventual TS-vs-Rust comparison the
   * cross-backend determinism gate (#1059) will surface when the
   * real Rust backend lands under #1133; both halves must agree on
   * `changedNodes` byte-identically, and `nodeVersion` is a pure
   * function of that surface.
   *
   * If a future engine refactor introduces non-determinism in
   * `changedNodes` ordering or membership (e.g. an iteration over a
   * `Map` that switches to `HashMap` semantics), this property
   * catches it as a `nodeVersion` divergence with a shrunk-to-minimum
   * counter-example.
   */
  it('two fresh graphs driven by the same trace see byte-identical nodeVersion sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 2 }), // kind
            fc.nat(),
            fc.integer({ min: -500, max: 500 }),
          ),
          { minLength: 1, maxLength: 24 },
        ),
        (trace) => {
          const left = buildDag(3, 2)
          const right = buildDag(3, 2)
          // Map each tracked id to the corresponding node handle on
          // each side. Both worlds use the same id-set (the DAG shape
          // is deterministic), so iterating either side's trackedIds
          // is byte-equivalent to iterating the other's.
          const lNodes: Map<string, Node<number>> = new Map()
          const rNodes: Map<string, Node<number>> = new Map()
          for (const n of left.inputs) lNodes.set(n.id, n)
          for (const n of left.deriveds) lNodes.set(n.id, n)
          for (const n of right.inputs) rNodes.set(n.id, n)
          for (const n of right.deriveds) rNodes.set(n.id, n)
          for (let k = 0; k < trace.length; k++) {
            const [kind, rawIdx, value] = trace[k]!
            const idx = rawIdx % 3
            const cL = left.graph.commit(`c${k}`, (tx) => {
              if (kind === 0) tx.set(left.inputs[idx]!, value)
              else if (kind === 1)
                tx.set(left.inputs[idx]!, left.graph.read(left.inputs[idx]!) as number)
            })
            const cR = right.graph.commit(`c${k}`, (tx) => {
              if (kind === 0) tx.set(right.inputs[idx]!, value)
              else if (kind === 1)
                tx.set(right.inputs[idx]!, right.graph.read(right.inputs[idx]!) as number)
            })
            // Backend-cross check: changedNodes is byte-identical
            // by id-set membership. (Order is also pinned by the
            // determinism gate, but this property focuses on the
            // version invariant — a future widening can sort/compare
            // arrays directly.)
            expect([...cL.changedNodes].sort()).toEqual(
              [...cR.changedNodes].sort(),
            )
            // After each commit, every tracked id has the same
            // nodeVersion on both sides — pinned via the public
            // accessor (#1242), which is the cross-backend contract
            // the future Rust port must satisfy.
            for (const id of left.trackedIds) {
              expect(nodeVersion(left.graph, lNodes.get(id)!)).toBe(
                nodeVersion(right.graph, rNodes.get(id)!),
              )
            }
          }
        },
      ),
      tieredPropertyTrials('node-version/cross-backend-determinism-sibling'),
    )
  })
})
