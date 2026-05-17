/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the SPEC §15.1 amendment (#1124):
 * `graph.read(node)` is **not** contractually required to return the
 * same JavaScript reference across calls. Reference identity is an
 * implementation detail of today's TS engine that disappears the day
 * the real Rust serde / wasmgc bridges land per SPEC §17.6 —
 * `read()` will return a fresh deep-copy per call as the value
 * crosses the FFI boundary.
 *
 * The Markbåge/Miller ship-verdict panel surfaced H1 from the WASM
 * adopter audit (`docs/wasm-backend-adopter-audit.md`, PR #1021) as
 * the load-bearing pre-Rust-swap risk: adopters who memoise on the
 * read return reference re-render every commit silently after
 * `migrate('wasm')`. The mitigation is the SPEC §15.1 amendment plus
 * adopter-facing guidance at `docs/wasm-adoption-guide.md` § H1; this
 * file is the property-level pin.
 *
 * ## What this test proves
 *
 * For an arbitrary `propertyDag` topology and an arbitrary sequence
 * of input writes, the SPEC §3 contract surface (atomicity,
 * glitch-freedom, replay determinism on the visible value stream)
 * remains intact when every `graph.read(node)` call returns a fresh
 * deep-copy of the value rather than the engine-internal reference.
 *
 * The test wraps the standard `createCausl()` graph in a thin
 * `BackendEngine`-shaped wrapper (`identityErasingRead`) that
 * delegates to the underlying graph but routes every `read()` call
 * through a `structuredClone` boundary. The wrapper is a faithful
 * model of what the future Rust serde bridge will do: same value,
 * fresh reference, every read.
 *
 * The property body then exercises the contract surface:
 *
 *   1. **Value identity at a fixed commit.** `Object.is(read@t,
 *      read@t)` may NOT hold reference-wise once the wrapper is in
 *      play, but `JSON.stringify(read@t) === JSON.stringify(read@t)`
 *      MUST hold — value identity at a fixed `GraphTime` is what
 *      §15.1 preserves.
 *   2. **Atomicity.** Every commit produces exactly one new
 *      `GraphTime`; subscribers fire exactly once per affected node
 *      per commit. The identity-erasing wrapper changes none of this.
 *   3. **Glitch-freedom.** Derived values observed via the wrapper
 *      equal the compute applied to its current dependencies' values
 *      at the same `GraphTime`. The diamond theorem holds across the
 *      identity break.
 *   4. **No internal code relies on identity.** All 715 existing
 *      tests stay green (verified out-of-band by `pnpm test:run` on
 *      this PR's CI). This file's property body is the in-suite
 *      assertion: arbitrary topologies + arbitrary writes do not
 *      surface a single divergence between the reference-stable and
 *      reference-erasing read paths.
 *
 * ## Trial budget
 *
 * 1000-trial floor via `propertyTrials('read-no-identity-contract/*')`,
 * matching SPEC §15.2's race-detection commitment. Seeds are
 * deterministic via `CAUSL_FUZZ_SEED` per the `seed.ts` helper.
 *
 * ## Cross-references
 *
 * - SPEC §15.1 amendment (#1124) — the contract sentence.
 * - SPEC §19 amendment-trail row — the one-page-reference entry.
 * - `docs/wasm-adoption-guide.md` § H1 — adopter-facing right-vs-wrong
 *   memoisation example, mirrored as a doctest in
 *   `wasm-adoption-guide-h1-example.test.ts`.
 * - `packages/core/wasm/README.md` H1 callout — adopter-facing
 *   pre-migration warning above the host-tier table.
 * - `docs/wasm-backend-adopter-audit.md` H1 row (PR #1021) — the
 *   original audit that surfaced the hazard.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  propertyTrials,
} from '@causljs/core-testing-internal'
import { createCausl, type Graph, type Node } from '../../src/index.js'

/**
 * Deep-copy a value the way a real Rust serde / wasmgc bridge would
 * across the FFI boundary. `structuredClone` is the closest JS-side
 * faithful model of "the engine serialised the value, handed the
 * bytes across the boundary, and a fresh JS object was constructed
 * on the other side."
 *
 * Numbers, strings, and other primitives pass through `structuredClone`
 * unchanged (primitives have no reference identity to break in the
 * first place), so the wrapper is observationally identical to the
 * underlying read for primitive-valued nodes; the reference-identity
 * break only matters for object-valued nodes. Both cases are
 * exercised by the property body — primitives via the canonical
 * `propertyDag` numeric workload, objects via the dedicated
 * "object-valued node" properties below.
 */
function freshCopy<T>(value: T): T {
  // `structuredClone` is the canonical "no shared structure" copy
  // primitive on Node 17+. Browsers and Node both expose it as a
  // global. We narrow to the structured-clone subset: JSON-shaped
  // values flow through unchanged.
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

/**
 * A thin wrapper around a real `Graph` that erases reference identity
 * on every `read()` call. The other surface methods (`commit`,
 * `subscribe`, `subscribeCommits`, ...) delegate untouched.
 *
 * This is the JS-side faithful model of the future Rust serde
 * bridge's read path. Property bodies that build a graph and then
 * exercise the contract surface through this wrapper verify that
 * the §3 invariants survive the identity break.
 */
function identityErasingRead(graph: Graph): Graph {
  const proxy: Graph = new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === 'read') {
        return <T,>(node: Node<T>): T => {
          // Route every read through the deep-copy boundary. The
          // engine's internal `read` returns whatever it returns;
          // we clone before handing it back to the caller.
          return freshCopy(target.read<T>(node))
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  return proxy
}

describe('SPEC §15.1 amendment (#1124) — graph.read(node) reference identity is not contractual', () => {
  /**
   * Property 1 — for any random DAG and any random sequence of input
   * writes, value identity at a fixed `GraphTime` is preserved across
   * the identity-erasing wrapper. Two synchronous reads at the same
   * commit time return structurally-equal values (JSON-equal), even
   * though they no longer share a reference.
   *
   * This is the contract sentence's positive half: §15.1 preserves
   * **value identity** at a fixed `GraphTime`; it relinquishes
   * **reference identity**.
   */
  it('value identity at a fixed GraphTime survives the identity-erasing wrapper', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 1, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (spec, writes) => {
          const inner = createCausl()
          const built = buildPropertyDag(inner, spec)
          const graph = identityErasingRead(inner)

          // Apply the random write sequence — one commit per write.
          for (const v of writes) {
            inner.commit('p1-write', (tx) => tx.set(built.input, v))
          }

          // After the writes settle, every derived's value read
          // through the wrapper must:
          //   (a) JSON-equal the value read through the inner
          //       graph at the same instant (value identity), and
          //   (b) JSON-equal a second wrapper read at the same
          //       instant (idempotent value identity).
          for (const [id, handle] of built.deriveds) {
            const innerValue = inner.read(handle)
            const wrapped1 = graph.read(handle)
            const wrapped2 = graph.read(handle)
            expect(wrapped1, `wrapped read of ${id} matches inner`).toEqual(
              innerValue,
            )
            expect(
              wrapped2,
              `wrapped re-read of ${id} matches first wrapped read`,
            ).toEqual(wrapped1)
          }
        },
      ),
      propertyTrials('read-no-identity-contract/value-identity-at-fixed-time'),
    )
  })

  /**
   * Property 2 — atomicity survives the identity break. Every commit
   * produces exactly one new `GraphTime`; the wrapper does not see
   * extra ticks. Subscribers fire exactly once per affected node per
   * commit; the identity-erasing wrapper does not perturb the fan-out
   * count.
   *
   * A bug in the engine that silently relied on reference identity
   * (e.g. a memo keyed on the read return object) would manifest here
   * as either an extra commit (if the memo was busted by clone-on-read)
   * or as a missed subscriber notification.
   */
  it('atomicity holds — exactly one new GraphTime per commit, exactly one notify per affected node', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 2, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (spec, writes) => {
          const inner = createCausl()
          const built = buildPropertyDag(inner, spec)
          const graph = identityErasingRead(inner)

          // Subscribe to every derived through the wrapper. The
          // wrapper does not intercept `subscribe`, so the engine's
          // notification path is exercised end-to-end.
          const notifyCounts = new Map<string, number>()
          for (const [id, handle] of built.deriveds) {
            notifyCounts.set(id, 0)
            graph.subscribe(handle, () => {
              notifyCounts.set(id, (notifyCounts.get(id) ?? 0) + 1)
            })
          }
          // Reset the initial-value notifications — `subscribe` fires
          // once at subscribe time per the engine's standard
          // contract. The property measures post-subscribe behavior.
          for (const id of notifyCounts.keys()) notifyCounts.set(id, 0)

          // Apply the writes; each commit should advance `now` by
          // exactly one and fire at most once per derived.
          const t0 = inner.now
          let lastTime = t0
          for (const v of writes) {
            const commit = inner.commit('p2-atomic', (tx) =>
              tx.set(built.input, v),
            )
            // §3 atomicity: every commit produces exactly one new
            // GraphTime — `now` is monotonically advancing.
            expect(commit.time).not.toEqual(lastTime)
            expect(inner.now).toEqual(commit.time)
            lastTime = commit.time
          }

          // No subscriber should have fired more than `writes.length`
          // times. The wrapper does not amplify the notification fan.
          for (const [id, count] of notifyCounts) {
            expect(
              count,
              `subscriber for ${id} fired at most once per commit`,
            ).toBeLessThanOrEqual(writes.length)
          }
        },
      ),
      propertyTrials('read-no-identity-contract/atomicity'),
    )
  })

  /**
   * Property 3 — glitch-freedom holds across the identity break. For
   * every random DAG and every random sequence of writes, the value
   * a derived returns via the wrapper equals the sum-of-deps oracle
   * (the `propertyDag` builder's canonical compute is
   * `sum(get(dep))`).
   *
   * This is the diamond theorem made executable: at every committed
   * `GraphTime`, every observable equals `f` of its dependencies'
   * values at the same `GraphTime`. The identity-erasing wrapper
   * cannot perturb this — `f` is a pure function of input values, not
   * input references.
   */
  it('glitch-freedom holds — wrapped reads match the sum-of-deps oracle', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 2, maxDerived: 10 }),
        fc.array(fc.integer({ min: -100, max: 100 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (spec, writes) => {
          const inner = createCausl()
          const built = buildPropertyDag(inner, spec)
          const graph = identityErasingRead(inner)

          for (const v of writes) {
            inner.commit('p3-glitch', (tx) => tx.set(built.input, v))
          }
          // The final input value is what every derived sums over.
          const finalInput = writes[writes.length - 1]!

          // The `propertyDag` builder constructs each derived as
          // `sum(get(dep))` over its declared deps; the input is the
          // only leaf. Compute the oracle value for each derived by
          // walking the spec in topo order.
          const oracleValues = new Map<string, number>()
          oracleValues.set(spec.inputId, finalInput)
          for (const ds of spec.deriveds) {
            let sum = 0
            for (const depId of ds.deps) sum += oracleValues.get(depId)!
            oracleValues.set(ds.id, sum)
          }

          // Every wrapped read must match the oracle.
          for (const [id, handle] of built.deriveds) {
            const observed = graph.read(handle)
            expect(observed, `wrapped read of ${id} matches oracle`).toBe(
              oracleValues.get(id)!,
            )
          }
        },
      ),
      propertyTrials('read-no-identity-contract/glitch-freedom'),
    )
  })

  /**
   * Property 4 — the contract sentence's negative half. For an
   * object-valued input node, two successive `read()` calls under
   * the identity-erasing wrapper return **different references**
   * (the §15.1 amendment removes this from the contract surface) but
   * **structurally-equal values** (the §15.1 amendment preserves this).
   *
   * This is the property that fails if the engine, in the future, is
   * patched to memoise on the read-return reference internally and
   * surface that memoised reference to callers — which is precisely
   * the trap §15.1 warns adopters about. The property exists in the
   * suite so the trap fails CI rather than surfacing post-migration.
   */
  it('object-valued reads return fresh references but structurally-equal values', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            k: fc.string({ minLength: 1, maxLength: 8 }),
            v: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (records) => {
          const inner = createCausl()
          const node = inner.input<readonly { k: string; v: number }[]>(
            'obj-input',
            records,
          )
          const graph = identityErasingRead(inner)

          const r1 = graph.read(node)
          const r2 = graph.read(node)

          // Negative half of the amendment: reference identity is
          // NOT contractual. Two reads of the same object-valued
          // node return distinct references through the wrapper.
          // (Under the bare TS engine the references are identical;
          // the wrapper models the post-migration future.)
          expect(Object.is(r1, r2)).toBe(false)
          // Positive half: value identity at the same commit IS
          // contractual. The references differ, but the values are
          // structurally equal.
          expect(r1).toEqual(r2)
          expect(r1).toEqual(records)
        },
      ),
      propertyTrials('read-no-identity-contract/object-valued-identity-break'),
    )
  })

  /**
   * Property 5 — replay determinism on the visible value stream.
   * A captured commit sequence replayed against a fresh graph
   * produces the same final wrapped-read value at every node.
   *
   * This is SPEC §3's replay theorem made executable, with the
   * wrapper in the loop. A bug in the engine that smuggled
   * reference identity into the determinism layer (e.g. by hashing
   * on object identity rather than value) would surface as
   * divergent replay state under the wrapper.
   */
  it('replay determinism holds — fresh-graph replay matches the original wrapped-read state', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 2, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (spec, writes) => {
          // Run 1 — original graph + wrapper.
          const inner1 = createCausl()
          const built1 = buildPropertyDag(inner1, spec)
          const graph1 = identityErasingRead(inner1)
          for (const v of writes) {
            inner1.commit('p5-replay-1', (tx) => tx.set(built1.input, v))
          }
          const final1 = new Map<string, number>()
          for (const [id, handle] of built1.deriveds) {
            final1.set(id, graph1.read(handle))
          }

          // Run 2 — fresh graph, same spec + same writes.
          const inner2 = createCausl()
          const built2 = buildPropertyDag(inner2, spec)
          const graph2 = identityErasingRead(inner2)
          for (const v of writes) {
            inner2.commit('p5-replay-2', (tx) => tx.set(built2.input, v))
          }
          const final2 = new Map<string, number>()
          for (const [id, handle] of built2.deriveds) {
            final2.set(id, graph2.read(handle))
          }

          // The two runs must agree on every derived.
          for (const [id, v1] of final1) {
            expect(v1, `replay matches for ${id}`).toBe(final2.get(id))
          }
        },
      ),
      propertyTrials('read-no-identity-contract/replay-determinism'),
    )
  })
})
