/**
 * @packageDocumentation
 *
 * Engine-telemetry semantic-invariance unit tests (issue #1156).
 *
 * Sibling of `packages/core/test/properties/node-version.property.test.ts`:
 * pins the same per-node version contract via hand-authored fixtures
 * the property generator might never produce (or might produce slowly
 * under shrinking). Each `it()` block names the SPEC §15 / panel-
 * review hazard it nails down:
 *
 *   1. **No-op commit** — re-setting an input to its current value
 *      MUST NOT bump that input's version. The equality-cutoff seam
 *      (#972) is the engine surgery this test pins against
 *      regression.
 *   2. **Derived equality cutoff** — when a parent's value changes
 *      but the derived's recomputed value is identical to its prior
 *      value (e.g. `a * 0` written from 1 → 2), the derived's
 *      version MUST NOT bump. Pins the Phase D `Object.is(before, e.value)`
 *      gate against a regression that would propagate "changed"
 *      irrespective of value equality.
 *   3. **H8 sibling-shape isolation** — writing one input in a
 *      multi-input DAG MUST NOT bump the version of an unaffected
 *      sibling input or of a derived that does not depend on the
 *      written input. The panel-review H8 hazard the per-node
 *      version counter is designed to defend against.
 *
 * ## How `nodeVersion(node)` is computed in these tests
 *
 * The current TS engine surfaces "this node's value changed in this
 * commit" through {@link Commit.changedNodes}. The per-node version
 * counter `EngineTelemetry.nodeVersion(node)` documented in
 * `docs/wasm-adoption-guide.md` is the running count of commits in
 * which `node.id ∈ changedNodes` — a pure derivation over the
 * cross-backend-deterministic surface that #1059 / PR #1107 already
 * pins byte-identically across backends. These tests therefore
 * compute the counter inline (a `Map<NodeId, number>` advanced by
 * each commit) and assert the increment semantics directly. When the
 * `EngineTelemetry.nodeVersion(node)` accessor lands as a public
 * surface, these tests swap the inline accumulator for the engine
 * call without changing the assertions.
 *
 * @see https://github.com/iasbuilt/causl/issues/1156 — this gate.
 * @see https://github.com/iasbuilt/causl/pull/1021 — adopter audit.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, type Commit, type NodeId } from '../src/index.js'

/**
 * Running per-node version accumulator. Bumps a node's count by 1
 * iff its id appears in `commit.changedNodes`. Returns the updated
 * map (mutated in place).
 *
 * Defined freestanding so every test block uses the same single
 * helper — a regression that drifts this helper would surface as a
 * test failure across every arm, not as a silent divergence in one
 * fixture.
 */
function applyCommit(versions: Map<NodeId, number>, commit: Commit): void {
  for (const id of commit.changedNodes) {
    if (versions.has(id)) versions.set(id, versions.get(id)! + 1)
  }
}

describe('EngineTelemetry.nodeVersion semantic-invariance (issue #1156)', () => {
  // -----------------------------------------------------------------
  // Arm 1: No-op commit (same value re-set) → nodeVersion unchanged.
  // -----------------------------------------------------------------
  describe('no-op commit (same value re-set)', () => {
    it('re-setting an input to its current value does NOT bump the input version', () => {
      const g = createCausl({ name: 'noop-arm' })
      const a = g.input('a', 7)
      const versions = new Map<NodeId, number>([[a.id, 0]])
      // Real write — version advances by 1.
      const c1 = g.commit('first', (tx) => tx.set(a, 99))
      applyCommit(versions, c1)
      expect(versions.get(a.id)).toBe(1)
      // No-op write — version MUST NOT bump.
      const c2 = g.commit('noop', (tx) => tx.set(a, 99))
      expect(c2.changedNodes.length).toBe(0)
      applyCommit(versions, c2)
      expect(versions.get(a.id)).toBe(1)
      // Second real write — version advances again.
      const c3 = g.commit('second', (tx) => tx.set(a, 100))
      applyCommit(versions, c3)
      expect(versions.get(a.id)).toBe(2)
    })

    it('an entirely empty commit (no writes) does NOT bump any version', () => {
      const g = createCausl({ name: 'empty-commit-arm' })
      const a = g.input('a', 0)
      const b = g.input('b', 0)
      const d = g.derived<number>('d', (get) => get(a) + get(b))
      g.read(d)
      const versions = new Map<NodeId, number>([
        [a.id, 0],
        [b.id, 0],
        [d.id, 0],
      ])
      // Seed: a write that bumps a and d.
      applyCommit(versions, g.commit('seed', (tx) => tx.set(a, 1)))
      const versionsBefore = new Map(versions)
      // Empty commit — no writes inside the tx body.
      const empty = g.commit('empty', () => {})
      expect(empty.changedNodes.length).toBe(0)
      applyCommit(versions, empty)
      // Every tracked id keeps its prior version exactly.
      for (const [id, v] of versionsBefore) {
        expect(versions.get(id)).toBe(v)
      }
    })

    it('re-setting every input to its current value across a multi-input DAG bumps no version', () => {
      const g = createCausl({ name: 'multi-input-noop-arm' })
      const inputs = Array.from({ length: 5 }, (_, i) => g.input(`i${i}`, i))
      const d = g.derived<number>('sum', (get) =>
        inputs.reduce<number>((acc, n) => acc + (get(n) as number), 0),
      )
      g.read(d)
      const versions = new Map<NodeId, number>()
      for (const n of inputs) versions.set(n.id, 0)
      versions.set(d.id, 0)
      // No-op commit — re-set every input to its current value.
      const c = g.commit('noop', (tx) => {
        for (const n of inputs) tx.set(n, g.read(n) as number)
      })
      expect(c.changedNodes.length).toBe(0)
      applyCommit(versions, c)
      for (const v of versions.values()) expect(v).toBe(0)
    })
  })

  // -----------------------------------------------------------------
  // Arm 2: Derived equality cutoff (Phase D `Object.is` gate).
  //   Parent changes, but derived value is identical → derived's
  //   nodeVersion MUST NOT bump.
  // -----------------------------------------------------------------
  describe('derived equality cutoff (parent changed, derived value identical)', () => {
    it('derived `a * 0` does not bump when `a` changes', () => {
      const g = createCausl({ name: 'derived-eq-cutoff-arm' })
      const a = g.input('a', 1)
      const d = g.derived<number>('d', (get) => get(a) * 0)
      g.read(d)
      const versions = new Map<NodeId, number>([
        [a.id, 0],
        [d.id, 0],
      ])
      // Write a different `a` — input version bumps, but derived
      // value is `0` either way so the derived version MUST NOT bump.
      const c = g.commit('a:1→2', (tx) => tx.set(a, 2))
      applyCommit(versions, c)
      expect(c.changedNodes).toContain(a.id)
      expect(c.changedNodes).not.toContain(d.id)
      expect(versions.get(a.id)).toBe(1)
      expect(versions.get(d.id)).toBe(0)
    })

    it('derived `a + b` does not bump when `a` and `b` change but the sum is the same', () => {
      const g = createCausl({ name: 'sum-eq-cutoff-arm' })
      const a = g.input('a', 1)
      const b = g.input('b', 9)
      const d = g.derived<number>('sum', (get) => get(a) + get(b))
      g.read(d) // sum = 10
      const versions = new Map<NodeId, number>([
        [a.id, 0],
        [b.id, 0],
        [d.id, 0],
      ])
      // Write a=2, b=8 in one tx — both inputs change, but sum is
      // still 10. The derived's version MUST NOT bump.
      const c = g.commit('a+b=10', (tx) => {
        tx.set(a, 2)
        tx.set(b, 8)
      })
      applyCommit(versions, c)
      expect(c.changedNodes).toContain(a.id)
      expect(c.changedNodes).toContain(b.id)
      expect(c.changedNodes).not.toContain(d.id)
      expect(versions.get(a.id)).toBe(1)
      expect(versions.get(b.id)).toBe(1)
      expect(versions.get(d.id)).toBe(0)
    })

    it('derived nested chain — middle derived unchanged blocks downstream version bumps', () => {
      // Chain: a → b = a*0 → c = b + 1. A change to `a` propagates
      // into `b`'s recompute, but `b`'s value is `0` either way, so
      // the equality cutoff stops propagation at `b`; `c` never
      // recomputes, hence its version MUST NOT bump.
      const g = createCausl({ name: 'chain-eq-cutoff-arm' })
      const a = g.input('a', 1)
      const b = g.derived<number>('b', (get) => get(a) * 0)
      const c = g.derived<number>('c', (get) => get(b) + 1)
      g.read(c)
      const versions = new Map<NodeId, number>([
        [a.id, 0],
        [b.id, 0],
        [c.id, 0],
      ])
      const commit = g.commit('a:1→2', (tx) => tx.set(a, 2))
      applyCommit(versions, commit)
      expect(commit.changedNodes).toContain(a.id)
      expect(commit.changedNodes).not.toContain(b.id)
      expect(commit.changedNodes).not.toContain(c.id)
      expect(versions.get(a.id)).toBe(1)
      expect(versions.get(b.id)).toBe(0)
      expect(versions.get(c.id)).toBe(0)
    })
  })

  // -----------------------------------------------------------------
  // Arm 3: H8 sibling-shape isolation. Writing one input MUST NOT
  // bump the version of an unaffected sibling input or unrelated
  // derived.
  // -----------------------------------------------------------------
  describe('H8 sibling-shape isolation', () => {
    it('writing input A does not bump unrelated input B or unrelated derived', () => {
      const g = createCausl({ name: 'h8-isolation-arm' })
      const a = g.input('a', 0)
      const b = g.input('b', 0)
      const c = g.input('c', 0)
      const dA = g.derived<number>('d_a', (get) => get(a) + 1)
      const dC = g.derived<number>('d_c', (get) => get(c) + 1)
      g.read(dA)
      g.read(dC)
      const versions = new Map<NodeId, number>([
        [a.id, 0],
        [b.id, 0],
        [c.id, 0],
        [dA.id, 0],
        [dC.id, 0],
      ])
      // Write only `a` — the version of `b`, `c`, and `d_c` MUST
      // NOT change. `a` and `d_a` MUST advance by exactly 1.
      const commit = g.commit('write-a', (tx) => tx.set(a, 42))
      applyCommit(versions, commit)
      expect(versions.get(a.id)).toBe(1)
      expect(versions.get(dA.id)).toBe(1)
      expect(versions.get(b.id)).toBe(0)
      expect(versions.get(c.id)).toBe(0)
      expect(versions.get(dC.id)).toBe(0)
    })

    it('disjoint sibling sub-DAG writes never cross-contaminate version counters', () => {
      // Two disjoint sub-DAGs in one graph. A write in DAG L must
      // never bump any node in DAG R, and vice versa. The H8 hazard
      // the panel-review flagged is exactly the failure mode where a
      // shared engine-internal Map iteration leaks "changed" across
      // disjoint sub-graphs.
      const g = createCausl({ name: 'h8-disjoint-arm' })
      const lA = g.input('L_a', 0)
      const lB = g.input('L_b', 0)
      const lSum = g.derived<number>('L_sum', (get) => get(lA) + get(lB))
      const rA = g.input('R_a', 0)
      const rB = g.input('R_b', 0)
      const rSum = g.derived<number>('R_sum', (get) => get(rA) + get(rB))
      g.read(lSum)
      g.read(rSum)
      const versions = new Map<NodeId, number>([
        [lA.id, 0],
        [lB.id, 0],
        [lSum.id, 0],
        [rA.id, 0],
        [rB.id, 0],
        [rSum.id, 0],
      ])
      // Write only into the L sub-DAG.
      applyCommit(versions, g.commit('L:a→1', (tx) => tx.set(lA, 1)))
      applyCommit(versions, g.commit('L:b→2', (tx) => tx.set(lB, 2)))
      // R-side versions MUST still be 0.
      expect(versions.get(rA.id)).toBe(0)
      expect(versions.get(rB.id)).toBe(0)
      expect(versions.get(rSum.id)).toBe(0)
      // L-side: each input bumped once, sum bumped on each (both
      // commits changed the sum value).
      expect(versions.get(lA.id)).toBe(1)
      expect(versions.get(lB.id)).toBe(1)
      expect(versions.get(lSum.id)).toBe(2)
      // Now write into the R sub-DAG — L-side versions MUST stay put.
      const lSnapshot = new Map([
        [lA.id, versions.get(lA.id)!],
        [lB.id, versions.get(lB.id)!],
        [lSum.id, versions.get(lSum.id)!],
      ])
      applyCommit(versions, g.commit('R:a→1', (tx) => tx.set(rA, 1)))
      applyCommit(versions, g.commit('R:b→2', (tx) => tx.set(rB, 2)))
      for (const [id, v] of lSnapshot) {
        expect(versions.get(id)).toBe(v)
      }
      // R-side: each input bumped once, sum bumped on each.
      expect(versions.get(rA.id)).toBe(1)
      expect(versions.get(rB.id)).toBe(1)
      expect(versions.get(rSum.id)).toBe(2)
    })
  })

  // -----------------------------------------------------------------
  // Arm 4: Cross-backend determinism sibling. Two fresh graphs see
  // byte-identical nodeVersion sequences when driven by the same
  // trace. Pins the cross-backend invariant the future Rust port
  // (#1133) must satisfy: nodeVersion is a pure function of
  // Commit.changedNodes, which is already pinned byte-identically
  // by the determinism gate (#1059 / PR #1107).
  // -----------------------------------------------------------------
  describe('cross-backend determinism sibling arm', () => {
    it('two TS-engine graphs driven by the same trace agree on every nodeVersion at every step', () => {
      function makeWorld(): {
        graph: ReturnType<typeof createCausl>
        a: ReturnType<ReturnType<typeof createCausl>['input']>
        b: ReturnType<ReturnType<typeof createCausl>['input']>
        d: ReturnType<ReturnType<typeof createCausl>['derived']>
        versions: Map<NodeId, number>
      } {
        const g = createCausl({ name: 'cross-backend-sibling' })
        const a = g.input('a', 0)
        const b = g.input('b', 0)
        const d = g.derived<number>('d', (get) => get(a) + get(b))
        g.read(d)
        return {
          graph: g,
          a,
          b,
          d,
          versions: new Map([
            [a.id, 0],
            [b.id, 0],
            [d.id, 0],
          ]),
        }
      }
      const left = makeWorld()
      const right = makeWorld()
      const trace = [
        { target: 'a' as const, value: 1 },
        { target: 'b' as const, value: 1 },
        { target: 'a' as const, value: 1 }, // no-op
        { target: 'a' as const, value: 5 },
        { target: 'b' as const, value: -4 }, // a+b = 1 → identical sum
        { target: 'a' as const, value: 5 }, // no-op
      ]
      for (let k = 0; k < trace.length; k++) {
        const step = trace[k]!
        const cL = left.graph.commit(`c${k}`, (tx) => {
          tx.set(step.target === 'a' ? left.a : left.b, step.value)
        })
        const cR = right.graph.commit(`c${k}`, (tx) => {
          tx.set(step.target === 'a' ? right.a : right.b, step.value)
        })
        // changedNodes membership must agree on both engines.
        expect([...cL.changedNodes].sort()).toEqual([...cR.changedNodes].sort())
        applyCommit(left.versions, cL)
        applyCommit(right.versions, cR)
        for (const id of left.versions.keys()) {
          expect(left.versions.get(id)).toBe(right.versions.get(id))
        }
      }
      // Final tally: a wrote twice with distinct values (0→1, 1→5)
      // and re-wrote 1 (no-op) and 5 (no-op). b wrote twice with
      // distinct values (0→1, 1→-4). The derived sum: 0→1 (first),
      // then 1→2 (b→1), no-op (a re-write 1), 2→6 (a→5), 6→1 (b→-4),
      // no-op (a re-write 5). So d bumps 4 times.
      expect(left.versions.get(left.a.id)).toBe(2)
      expect(left.versions.get(left.b.id)).toBe(2)
      expect(left.versions.get(left.d.id)).toBe(4)
    })
  })
})
