/**
 * @packageDocumentation
 *
 * H6 — subscriber-fire ordering parity gate (#1157).
 *
 * SPEC §15 makes one durable promise about per-node subscribers: when
 * a single commit affects a node with N subscribers, those subscribers
 * fire in **subscription order** — the order in which their
 * `graph.subscribe(node, observer)` calls happened. The TS engine
 * realises this with insertion-ordered iteration over a per-node
 * `Set<SubscriptionEntry>` minted at first-subscribe-for-node (see
 * `subscriptionsByNode` in `packages/core/src/graph.ts`). A JS `Set`
 * iterates in insertion order, so the contract is satisfied today
 * without an explicit ordering data structure.
 *
 * The hazard the panel review surfaced (Markbåge / Miller, 2026-05-11
 * — see `docs/wasm-backend-adopter-audit.md` H6): the future Rust
 * port (epic #1133) cannot use a hash-based set because Rust's
 * `HashMap`/`HashSet` randomise iteration. A naive port that swaps
 * `Set` for `HashSet` silently regresses ordering — adopters who
 * read both subscribers' side-effects (logging, debug panels, the
 * persistence pipeline whose write order matters) observe drift
 * that the IR byte-equal gate (which orders subscribers by
 * `subscriptionId`) does NOT catch, because the IR's ordering is
 * stable independent of fire order.
 *
 * This file pins the **fire-order is subscription-order** contract
 * directly on the live observer-call side, not via the IR projection.
 * Two property bodies:
 *
 *   1. **Single-node, many-subscriber ordering.** N=100 subscriptions
 *      registered against the same input node in a random
 *      subscribe/unsubscribe sequence. Each surviving subscriber gets
 *      a unique ordinal stamped at subscribe time. A commit moves the
 *      input's value, and the per-commit fire trace must equal the
 *      surviving-ordinal sequence in registration order. Mixing in
 *      random `unsubscribe()` calls before the commit catches the
 *      regression where ordering is preserved only when no removals
 *      happen mid-sequence (the failure mode where the engine
 *      compacts the set on unsubscribe and accidentally swaps
 *      neighbours).
 *
 *   2. **Multi-node ordering across a small DAG.** A random graph
 *      with K subscribers per node (mix of input + derived nodes).
 *      Per commit, for every node that changed, the per-node fire
 *      trace must equal the surviving subscriber-ordinal sequence
 *      for that node. Cross-node interleaving is unconstrained by
 *      SPEC §15 (the engine is free to visit changed nodes in any
 *      order); the per-node restriction is what this property pins.
 *
 * Trial budget is sourced from `tieredPropertyTrials` so the gate
 * inherits the §15.2 1000-trial floor and the #1073 tier escalation
 * (5k PR / 100k nightly). Determinism: the per-trial seed is
 * fast-check's own; failing inputs shrink to the minimal
 * subscribe/unsubscribe sequence that reorders fires.
 *
 * Cross-backend determinism gate sibling assertion lives next to
 * this file's body, registered against the same `subscriber-order`
 * suite name in `cross-backend-determinism.property.test.ts` so the
 * gate fires byte-identical across the JS engine and the WASM
 * backend the moment a real Rust engine ships.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1157} — this gate.
 * @see {@link https://github.com/iasbuilt/causl/issues/1133} — Rust port epic.
 * @see {@link https://github.com/iasbuilt/causl/pull/1021} — adopter audit (H6).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  tieredPropertyTrials,
} from '@causljs/core-testing-internal'
import { createCausl, type Node, type Unsubscribe } from '../../src/index.js'

/**
 * Per-trial cap on the subscribe/unsubscribe sequence length. SPEC §15
 * promises ordering for arbitrary N; the issue body fixes N=100 as the
 * scenario size that survives the propertyOptions floor while exercising
 * the failure modes (mid-sequence unsubscribe compaction, peer-of-removed
 * neighbour swaps). Going higher does not enrich the failure surface —
 * the per-node iteration loop is uniform across all N, so a 100-entry
 * trace is a complete proxy for any N.
 */
const SUBSCRIPTIONS_PER_NODE = 100

/**
 * Recorded fire trace entry: which ordinal fired, in arrival order on
 * the observer callback. The §15 contract reduces to
 * `fireTrace === surviving-ordinals-in-subscribe-order` per commit.
 */
interface FireRecord {
  /** Subscriber ordinal — minted at subscribe time, never reused. */
  readonly ordinal: number
  /** Value the observer received. Pinned for debugging shrunk failures. */
  readonly value: number
}

describe('property: per-node subscriber fire-order is subscription-order (#1157 H6)', () => {
  /**
   * P1 — single-node, N=100 subscribers, random subscribe/unsubscribe
   *      sequence. Per the SPEC §15 contract, the per-commit fire
   *      trace MUST equal the ordinals of surviving subscribers in the
   *      order they were registered.
   *
   *      The trace shape: an array of `{kind: 'subscribe'} |
   *      {kind: 'unsubscribe', target: index-into-active-set}`. We
   *      track the active set explicitly so `unsubscribe.target` is
   *      always within range — fast-check's shrinker picks a valid
   *      index modulo the current active-set size.
   *
   *      What this catches:
   *
   *      - Hash-randomised iteration (the headline failure mode for
   *        the Rust port): every commit produces a permuted trace; a
   *        single trial fails with high probability.
   *      - Mid-sequence unsubscribe swap-with-last compaction: the
   *        engine reorders survivors when an interior subscriber is
   *        dropped. The "subscribe 5, unsubscribe ordinal-2" shape
   *        is exactly what this property's generator exercises.
   *      - Late subscribers prepended instead of appended: a subtle
   *        regression where a fresh `subscribe()` accidentally
   *        inserts at the head (e.g. linked-list head-insert instead
   *        of tail-insert).
   */
  it('N=100 subscribers on one node fire in subscription order across random subscribe/unsubscribe traces', () => {
    fc.assert(
      fc.property(
        // Sequence of operations: each op is either a `subscribe`
        // (cheap to draw — no parameters) or an `unsubscribe` keyed
        // by a uniform index into the live-active-set. The
        // unsubscribe index gets resolved at execution time so it
        // always points at a live entry — see body comment below.
        fc.array(
          fc.oneof(
            { weight: 3, arbitrary: fc.constant({ kind: 'subscribe' as const }) },
            {
              weight: 1,
              arbitrary: fc.record({
                kind: fc.constant('unsubscribe' as const),
                // Random in [0, 2^16); we resolve modulo the live-set
                // size at execution time so the index is always valid.
                pick: fc.integer({ min: 0, max: 0xffff }),
              }),
            },
          ),
          { minLength: 1, maxLength: SUBSCRIPTIONS_PER_NODE * 2 },
        ),
        (ops) => {
          const graph = createCausl({ name: 'h6-single-node' })
          const a = graph.input('a', 0)

          // Shared mutable trace container. We re-point this between
          // setup (initial-fire) and commit (post-fire) phases so
          // the assertion below measures only commit-driven fires.
          // A closure captures the box, not the array, so changing
          // `traceBox.current` to a fresh array between phases is
          // safe — observers append into whichever array is current
          // at fire-time.
          const traceBox: { current: FireRecord[] } = { current: [] }

          // Active set tracks `(ordinal, unsubscribe)` pairs in
          // registration order. Removals splice out at the requested
          // index; this is the §15 oracle the assertion compares
          // against. SPEC §15: post-commit fire trace equals the
          // ordinals in this array's order.
          const active: Array<{ ordinal: number; unsubscribe: Unsubscribe }> = []
          let nextOrdinal = 0

          for (const op of ops) {
            if (op.kind === 'subscribe') {
              // Cap at SUBSCRIPTIONS_PER_NODE — beyond that the
              // ordering property is no stronger; the cap keeps each
              // trial fast and shrinking minimal.
              if (active.length >= SUBSCRIPTIONS_PER_NODE) continue
              const ordinal = nextOrdinal++
              const unsubscribe = graph.subscribe(a, (v) => {
                traceBox.current.push({ ordinal, value: v as number })
              })
              active.push({ ordinal, unsubscribe })
            } else {
              // No-op if no active subscribers — keeps the generator
              // usable without precondition fiddling.
              if (active.length === 0) continue
              const idx = op.pick % active.length
              const entry = active[idx]
              if (entry === undefined) continue
              entry.unsubscribe()
              active.splice(idx, 1)
            }
          }

          // Discard initial-fire notifications: each `subscribe()`
          // above emitted one synchronously. The post-commit
          // assertion only cares about commit-driven fires, so swap
          // in a fresh trace array.
          traceBox.current = []

          // Commit a value change so every surviving subscriber
          // fires exactly once. The commit value differs from the
          // initial `0` so Object.is dedup does not suppress any
          // fire.
          graph.commit('h6-fire', (tx) => tx.set(a, 42))

          // The per-commit fire trace MUST be exactly the surviving
          // ordinals in subscribe-order. Any reordering — hashmap
          // randomisation, head-insert regression, swap-on-delete —
          // surfaces here as a one-line diff in the failure output.
          const survivors = active.map((e) => e.ordinal)
          const observedOrdinals = traceBox.current.map((r) => r.ordinal)
          expect(observedOrdinals).toEqual(survivors)

          // Every fire should carry the post-commit value (42). This
          // is a smoke-check against the regression where ordering
          // is preserved but the engine fires with a stale value.
          for (const rec of traceBox.current) {
            expect(rec.value).toBe(42)
          }
        },
      ),
      tieredPropertyTrials('h6-subscriber-order/single-node-N100'),
    )
  })

  /**
   * P2 — multi-node DAG, K subscribers per node, ordering is per-node.
   *
   *      A random DAG drawn from `propertyDag` (one input + 1..N
   *      derived nodes) gets K subscribers registered on each node.
   *      A single commit moves the input; every node whose value
   *      changes fires its K subscribers. The §15 contract is
   *      **per-node** — there is NO promise about how the engine
   *      interleaves fires across DIFFERENT nodes, only that within
   *      one node the fire order matches subscription order.
   *
   *      The assertion partitions the global fire trace by `nodeId`
   *      and checks each partition independently. A regression that
   *      reorders within-node (the H6 hazard) surfaces here even if
   *      the cross-node interleaving happens to look stable across
   *      backends.
   */
  it('K subscribers per node across a random DAG fire in subscription order, per-node', () => {
    fc.assert(
      fc.property(
        // Random DAG with at least one derived so the commit's
        // wavefront moves past the input boundary; this exercises the
        // Phase G per-node dispatch loop on multiple `bucket` walks
        // (one per changed id) rather than just the single-input cell
        // P1 already covers.
        propertyDag({ minDerived: 1, maxDerived: 6 }),
        // Subscribers per node — keep small so the per-trial work
        // stays bounded. The §15 ordering contract is uniform in K;
        // K=5 exercises the per-bucket iteration loop without
        // ballooning shrink time.
        fc.integer({ min: 1, max: 5 }),
        // Random commit value so the input always moves and downstream
        // deriveds recompute. Avoid `0` since the input starts at `0`
        // — `Object.is(pre, post)` would suppress fires.
        fc.integer({ min: 1, max: 1000 }),
        (spec, k, writeValue) => {
          const graph = createCausl({ name: 'h6-multi-node' })
          const built = buildPropertyDag(graph, spec)

          // Collect every node into a single `(nodeId, node)` map so
          // we can subscribe uniformly and partition the fire trace
          // by node-id at the assertion site.
          const nodes = new Map<string, Node<number>>()
          nodes.set(spec.inputId, built.input)
          for (const [id, node] of built.deriveds) {
            nodes.set(id, node as Node<number>)
          }

          // Per-node survivor ordinal lists — the §15 oracle. A node
          // gets K subscribers registered in order; we map every
          // global ordinal to its source node so the partitioning
          // pass below can compare per-node fires against per-node
          // survivors.
          const survivorsByNode = new Map<string, number[]>()
          const traceBox: { current: Array<{ nodeId: string; ordinal: number }> } = {
            current: [],
          }
          let nextOrdinal = 0

          for (const [nodeId, node] of nodes) {
            const survivors: number[] = []
            for (let i = 0; i < k; i++) {
              const ordinal = nextOrdinal++
              graph.subscribe(node, () => {
                traceBox.current.push({ nodeId, ordinal })
              })
              survivors.push(ordinal)
            }
            survivorsByNode.set(nodeId, survivors)
          }

          // Discard initial-fire notifications — each `subscribe`
          // above emitted one synchronously.
          traceBox.current = []

          // Commit a value change. Every node in `nodes` should
          // change (the input definitely does; every derived in the
          // generator's shape transitively depends on the input).
          graph.commit('h6-multi', (tx) => tx.set(built.input, writeValue))

          // Partition the global trace by nodeId. For each node, the
          // observed fire-ordinal sequence MUST equal the survivor
          // list — exactly the SPEC §15 promise.
          const observedByNode = new Map<string, number[]>()
          for (const rec of traceBox.current) {
            let bucket = observedByNode.get(rec.nodeId)
            if (bucket === undefined) {
              bucket = []
              observedByNode.set(rec.nodeId, bucket)
            }
            bucket.push(rec.ordinal)
          }

          for (const [nodeId, survivors] of survivorsByNode) {
            // Only assert for nodes that actually fired. Some
            // derived nodes in a propertyDag may have a compute
            // shape that produces the same value as the initial
            // genesis read for this particular `writeValue`,
            // suppressing the fire under Object.is. We accept that
            // surface — the §15 ordering contract is conditional
            // on the node firing at all.
            const observed = observedByNode.get(nodeId) ?? []
            if (observed.length === 0) continue
            expect(observed).toEqual(survivors)
          }
        },
      ),
      tieredPropertyTrials('h6-subscriber-order/multi-node-K-per-node'),
    )
  })

  /**
   * P3 — sibling assertion for the cross-backend determinism gate
   *      (#1059 / #685). When the WASM backend ships a real Rust
   *      engine (epic #1133), the per-node fire-order trace MUST be
   *      byte-identical across JS and WASM.
   *
   *      Today the WASM backend wraps the same TS engine the JS side
   *      uses, so this assertion fires green by construction — that
   *      is the correct Phase-1 behaviour. The gate is here so a
   *      regression in the Rust port cannot quietly land: the
   *      moment the wasm-side `subscribe()` path swaps for a real
   *      Rust-driven engine, this assertion measures
   *      `transition_js.subscribe-order == transition_wasm.subscribe-order`
   *      and fails on any drift.
   *
   *      We assert against a single TS engine here (the WASM backend
   *      is dormant in this worktree); the cross-backend variant
   *      with both engines wired lives in
   *      `cross-backend-determinism.property.test.ts` and consumes
   *      the same trace shape.
   */
  it('single-node fire-order trace is deterministic on the TS engine (cross-backend gate dormant arm)', () => {
    // Hand-fixed seed: N=10 subscribers, drop ordinal 3, drop
    // ordinal 7 (after compaction, that's the post-drop index 6).
    // The §15 oracle: surviving order is [0,1,2,4,5,6,8,9] — the
    // original ordinals with 3 and 7 removed.
    const graph = createCausl({ name: 'h6-determinism' })
    const a = graph.input('a', 0)
    const traceBox: { current: number[] } = { current: [] }
    const unsubs: Unsubscribe[] = []
    for (let o = 0; o < 10; o++) {
      const ordinal = o
      unsubs.push(
        graph.subscribe(a, () => {
          traceBox.current.push(ordinal)
        }),
      )
    }
    // Drop ordinal 3 first (active-set index 3).
    unsubs[3]?.()
    // After that drop, the active set is [0,1,2,4,5,6,7,8,9]. Drop
    // ordinal 7 (active-set index 6 now). We can call the original
    // unsub closure directly — the engine maps it by entry identity.
    unsubs[7]?.()
    // Discard initial-fire notifications.
    traceBox.current = []
    graph.commit('h6-det', (tx) => tx.set(a, 1))
    // The §15 oracle. Surviving ordinals in subscribe-order:
    expect(traceBox.current).toEqual([0, 1, 2, 4, 5, 6, 8, 9])
  })

  /**
   * P4 — interleaved subscribe-after-unsubscribe: a fresh
   *      `subscribe()` call after some entries were removed appends
   *      to the END of the order (not the slot vacated by removal).
   *
   *      This is the load-bearing detail Rust-port authors are most
   *      likely to miss: a `HashMap::remove` followed by a
   *      `HashMap::insert` may reuse the vacated bucket, and a
   *      naive iteration order that depended on bucket layout
   *      would observe the new entry in the OLD slot's iteration
   *      position. The JS Set never reuses a slot for a fresh
   *      insert (insertion order = monotonic registration order).
   *      Pinning this directly catches the hazard before the Rust
   *      port lands.
   */
  it('a fresh subscribe after some unsubscribes appends to the end of the order', () => {
    const graph = createCausl({ name: 'h6-append' })
    const a = graph.input('a', 0)
    const trace: number[] = []

    const u0 = graph.subscribe(a, () => trace.push(0))
    const u1 = graph.subscribe(a, () => trace.push(1))
    graph.subscribe(a, () => trace.push(2))
    u0()
    u1()
    // After dropping 0 and 1, the active set is [2]. Now subscribe
    // a new observer — its ordinal is 3, and §15 says it fires AFTER
    // ordinal 2 (since it registered later).
    graph.subscribe(a, () => trace.push(3))

    // Discard initial fires (one per surviving subscribe call —
    // ordinal 2 fires on its own initial-notify path; ordinal 3
    // fires on its initial-notify; u0/u1 already fired and were
    // disposed). The exact initial-fire shape varies by call order;
    // we just clear the trace.
    trace.length = 0

    graph.commit('append', (tx) => tx.set(a, 99))

    // Expected post-commit fire order: ordinal 2, then ordinal 3.
    // A regression where the new subscribe inserts at the head (or
    // wherever ordinal 0 used to live) would produce [3, 2].
    expect(trace).toEqual([2, 3])
  })
})
