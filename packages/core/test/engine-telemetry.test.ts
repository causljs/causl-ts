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
 * ## How `nodeVersion(node)` is wired in these tests
 *
 * Issue #1242 promoted `EngineTelemetry.nodeVersion(node)` from an
 * inline test oracle to a public accessor — the engine now maintains
 * a per-node version counter map alongside its existing `changed`-set
 * state and surfaces the count through `engine.stats().nodeVersion(
 * node)`. These tests therefore call the accessor directly; the
 * earlier `Map<NodeId, number>` inline oracle is gone. The semantic
 * contract is unchanged: a no-op commit MUST NOT bump any node's
 * version, a real commit advances the version of every node in
 * `commit.changedNodes` by exactly 1, and a derived's version
 * advances only when its recomputed value actually moved (the
 * equality-cutoff seam at #972).
 *
 * @see https://github.com/iasbuilt/causl/issues/1156 — this gate.
 * @see https://github.com/iasbuilt/causl/issues/1242 — the accessor PR.
 * @see https://github.com/iasbuilt/causl/pull/1021 — adopter audit.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, type Graph, type Node } from '../src/index.js'

/**
 * Read the engine's `nodeVersion(node)` accessor for a given node.
 *
 * Thin sugar around `graph.stats().nodeVersion(node)`. Centralised
 * here so every test block calls the same one-line helper — a future
 * regression that drifts the accessor's signature surfaces as a test
 * failure across every arm, not as a silent divergence in one
 * fixture.
 */
function nodeVersion(graph: Graph, node: Node<unknown>): number {
  return graph.stats().nodeVersion(node)
}

describe('EngineTelemetry.nodeVersion semantic-invariance (issue #1156)', () => {
  // -----------------------------------------------------------------
  // Arm 1: No-op commit (same value re-set) → nodeVersion unchanged.
  // -----------------------------------------------------------------
  describe('no-op commit (same value re-set)', () => {
    it('re-setting an input to its current value does NOT bump the input version', () => {
      const g = createCausl({ name: 'noop-arm' })
      const a = g.input('a', 7)
      // Pre-write: a never-changed input reports nodeVersion 0.
      expect(nodeVersion(g, a)).toBe(0)
      // Real write — version advances by 1.
      const c1 = g.commit('first', (tx) => tx.set(a, 99))
      expect(c1.changedNodes).toContain(a.id)
      expect(nodeVersion(g, a)).toBe(1)
      // No-op write — version MUST NOT bump.
      const c2 = g.commit('noop', (tx) => tx.set(a, 99))
      expect(c2.changedNodes.length).toBe(0)
      expect(nodeVersion(g, a)).toBe(1)
      // Second real write — version advances again.
      g.commit('second', (tx) => tx.set(a, 100))
      expect(nodeVersion(g, a)).toBe(2)
    })

    it('an entirely empty commit (no writes) does NOT bump any version', () => {
      const g = createCausl({ name: 'empty-commit-arm' })
      const a = g.input('a', 0)
      const b = g.input('b', 0)
      const d = g.derived<number>('d', (get) => get(a) + get(b))
      g.read(d)
      // Seed: a write that bumps a and d.
      g.commit('seed', (tx) => tx.set(a, 1))
      const before = {
        a: nodeVersion(g, a),
        b: nodeVersion(g, b),
        d: nodeVersion(g, d),
      }
      // Empty commit — no writes inside the tx body.
      const empty = g.commit('empty', () => {})
      expect(empty.changedNodes.length).toBe(0)
      // Every tracked node keeps its prior version exactly.
      expect(nodeVersion(g, a)).toBe(before.a)
      expect(nodeVersion(g, b)).toBe(before.b)
      expect(nodeVersion(g, d)).toBe(before.d)
    })

    it('re-setting every input to its current value across a multi-input DAG bumps no version', () => {
      const g = createCausl({ name: 'multi-input-noop-arm' })
      const inputs = Array.from({ length: 5 }, (_, i) => g.input(`i${i}`, i))
      const d = g.derived<number>('sum', (get) =>
        inputs.reduce<number>((acc, n) => acc + (get(n) as number), 0),
      )
      g.read(d)
      // No-op commit — re-set every input to its current value.
      const c = g.commit('noop', (tx) => {
        for (const n of inputs) tx.set(n, g.read(n) as number)
      })
      expect(c.changedNodes.length).toBe(0)
      for (const n of inputs) expect(nodeVersion(g, n)).toBe(0)
      expect(nodeVersion(g, d)).toBe(0)
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
      // Write a different `a` — input version bumps, but derived
      // value is `0` either way so the derived version MUST NOT bump.
      const c = g.commit('a:1→2', (tx) => tx.set(a, 2))
      expect(c.changedNodes).toContain(a.id)
      expect(c.changedNodes).not.toContain(d.id)
      expect(nodeVersion(g, a)).toBe(1)
      expect(nodeVersion(g, d)).toBe(0)
    })

    it('derived `a + b` does not bump when `a` and `b` change but the sum is the same', () => {
      const g = createCausl({ name: 'sum-eq-cutoff-arm' })
      const a = g.input('a', 1)
      const b = g.input('b', 9)
      const d = g.derived<number>('sum', (get) => get(a) + get(b))
      g.read(d) // sum = 10
      // Write a=2, b=8 in one tx — both inputs change, but sum is
      // still 10. The derived's version MUST NOT bump.
      const c = g.commit('a+b=10', (tx) => {
        tx.set(a, 2)
        tx.set(b, 8)
      })
      expect(c.changedNodes).toContain(a.id)
      expect(c.changedNodes).toContain(b.id)
      expect(c.changedNodes).not.toContain(d.id)
      expect(nodeVersion(g, a)).toBe(1)
      expect(nodeVersion(g, b)).toBe(1)
      expect(nodeVersion(g, d)).toBe(0)
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
      const commit = g.commit('a:1→2', (tx) => tx.set(a, 2))
      expect(commit.changedNodes).toContain(a.id)
      expect(commit.changedNodes).not.toContain(b.id)
      expect(commit.changedNodes).not.toContain(c.id)
      expect(nodeVersion(g, a)).toBe(1)
      expect(nodeVersion(g, b)).toBe(0)
      expect(nodeVersion(g, c)).toBe(0)
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
      // Write only `a` — the version of `b`, `c`, and `d_c` MUST
      // NOT change. `a` and `d_a` MUST advance by exactly 1.
      g.commit('write-a', (tx) => tx.set(a, 42))
      expect(nodeVersion(g, a)).toBe(1)
      expect(nodeVersion(g, dA)).toBe(1)
      expect(nodeVersion(g, b)).toBe(0)
      expect(nodeVersion(g, c)).toBe(0)
      expect(nodeVersion(g, dC)).toBe(0)
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
      // Write only into the L sub-DAG.
      g.commit('L:a→1', (tx) => tx.set(lA, 1))
      g.commit('L:b→2', (tx) => tx.set(lB, 2))
      // R-side versions MUST still be 0.
      expect(nodeVersion(g, rA)).toBe(0)
      expect(nodeVersion(g, rB)).toBe(0)
      expect(nodeVersion(g, rSum)).toBe(0)
      // L-side: each input bumped once, sum bumped on each (both
      // commits changed the sum value).
      expect(nodeVersion(g, lA)).toBe(1)
      expect(nodeVersion(g, lB)).toBe(1)
      expect(nodeVersion(g, lSum)).toBe(2)
      // Snapshot L-side counters before R-side writes.
      const lSnapshot = {
        lA: nodeVersion(g, lA),
        lB: nodeVersion(g, lB),
        lSum: nodeVersion(g, lSum),
      }
      // Now write into the R sub-DAG — L-side versions MUST stay put.
      g.commit('R:a→1', (tx) => tx.set(rA, 1))
      g.commit('R:b→2', (tx) => tx.set(rB, 2))
      expect(nodeVersion(g, lA)).toBe(lSnapshot.lA)
      expect(nodeVersion(g, lB)).toBe(lSnapshot.lB)
      expect(nodeVersion(g, lSum)).toBe(lSnapshot.lSum)
      // R-side: each input bumped once, sum bumped on each.
      expect(nodeVersion(g, rA)).toBe(1)
      expect(nodeVersion(g, rB)).toBe(1)
      expect(nodeVersion(g, rSum)).toBe(2)
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
        graph: Graph
        a: ReturnType<Graph['input']>
        b: ReturnType<Graph['input']>
        d: ReturnType<Graph['derived']>
      } {
        const g = createCausl({ name: 'cross-backend-sibling' })
        const a = g.input('a', 0)
        const b = g.input('b', 0)
        const d = g.derived<number>('d', (get) => get(a) + get(b))
        g.read(d)
        return { graph: g, a, b, d }
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
        // Cross-backend nodeVersion parity at every step.
        expect(nodeVersion(left.graph, left.a)).toBe(nodeVersion(right.graph, right.a))
        expect(nodeVersion(left.graph, left.b)).toBe(nodeVersion(right.graph, right.b))
        expect(nodeVersion(left.graph, left.d)).toBe(nodeVersion(right.graph, right.d))
      }
      // Final tally: a wrote twice with distinct values (0→1, 1→5)
      // and re-wrote 1 (no-op) and 5 (no-op). b wrote twice with
      // distinct values (0→1, 1→-4). The derived sum: 0→1 (first),
      // then 1→2 (b→1), no-op (a re-write 1), 2→6 (a→5), 6→1 (b→-4),
      // no-op (a re-write 5). So d bumps 4 times.
      expect(nodeVersion(left.graph, left.a)).toBe(2)
      expect(nodeVersion(left.graph, left.b)).toBe(2)
      expect(nodeVersion(left.graph, left.d)).toBe(4)
    })
  })

  // -----------------------------------------------------------------
  // Arm 5: Disposed-node lifecycle. A disposed node's counter is
  // reset; subsequent reuse (#1164 generational NodeId) starts from
  // counter 0. Pins the dispose-then-reuse semantics flagged by
  // #1242's acceptance row.
  // -----------------------------------------------------------------
  describe('disposed-node lifecycle', () => {
    it('disposing a node and re-registering the same id starts the new node at version 0', async () => {
      const g = createCausl({ name: 'disposed-reuse-arm' })
      const a = g.input('a', 0)
      g.commit('w1', (tx) => tx.set(a, 1))
      g.commit('w2', (tx) => tx.set(a, 2))
      expect(nodeVersion(g, a)).toBe(2)
      // Dispose via the internal-dispatch surface (the only public path).
      const { dispose } = await import('../src/internal.js')
      dispose(g, a)
      // Re-register at the same id — the new node MUST start at version 0.
      const a2 = g.input('a', 0)
      expect(nodeVersion(g, a2)).toBe(0)
      g.commit('w3', (tx) => tx.set(a2, 9))
      expect(nodeVersion(g, a2)).toBe(1)
    })
  })
})
