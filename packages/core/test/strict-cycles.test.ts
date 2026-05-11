/**
 * createCausl({ strictCycles }) — first-commit-time cycle detection
 * (#360 → updated by #670/#705).
 *
 * The pre-#705 strict-mode gate forced every transitive upstream
 * derived to recompute during a fresh registration's eager walk,
 * paying an O(N) DFS per `derived()` call. The cost was load-bearing
 * on `linear-chain × 1000` (420ms median, audit floor 5ms) and
 * structurally lethal on `linear-chain × 10000` (V8 stack overflow on
 * the registration recursion). #670 + #705 retired the registration-
 * time DFS in favour of a Phase D Kahn cycle probe at first-commit
 * time: the augmented `recomputeAffected` walk catches a latent cycle
 * the moment a commit advances `now` into the SCC, with the same
 * structured `CycleError` SPEC §9.1 row 8 commits to. The
 * `strictCycles` option is preserved for backward compatibility but
 * is now a no-op for one major version (the surface accepts both
 * `true` and `false` and behaves identically).
 *
 * The behavioural shift this file pins: a holder-mutation cycle is
 * accepted at registration and thrown on the first commit that walks
 * into the SCC — not at the eager registration of the closing
 * derived as the pre-#705 gate did.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, CycleError } from '../src/index.js'
import type { Node } from '../src/types.js'

describe('createCausl({ strictCycles }) — first-commit-time detection (#705)', () => {
  // Test 1 — the default (no options) accepts a holder-mutated latent
  // cycle at registration but throws on the first commit that walks
  // into the SCC. SPEC §9.1 row 8 ("Detected at the first commit that
  // closes the cycle, with a structured error naming the cycle path")
  // is satisfied at commit-time without paying the O(N²) registration-
  // time DFS the pre-#705 gate ran.
  it('default (no options) catches a latent post-registration cycle at first commit (#705)', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const holder: { ref: Node<number> | null } = { ref: null }
    // m1's compute reads `holder.ref` if non-null, else `a`. At
    // registration the holder is null, so m1.deps = {a} and the
    // graph is a clean DAG.
    const m1 = g.derived<number>('m1', (get) =>
      holder.ref !== null ? get(holder.ref) : get(a),
    )
    // m2 reads m1; deps = {m1}.
    const m2 = g.derived<number>('m2', (get) => get(m1))
    // The mutation that closes the back-edge: m1's compute will,
    // on its next walk, try to read m2 via the holder.
    holder.ref = m2
    // Register a fresh tail derived that reads m1. Under #705, the
    // eager-walk no longer refreshes upstream deps, so the
    // registration succeeds — the cycle is still latent because both
    // m1 and m2 hold cached values from their initial computes.
    expect(() =>
      g.derived<number>('cyc-tail', (get) => get(m1)),
    ).not.toThrow()
    // The first commit that bumps `a` walks into the SCC: Phase D
    // BFS reaches m1 via the (still-recorded) a→m1 edge, m1's
    // recompute reads m2 via holder.ref, m1's deps gain m2, m2 is
    // recomputed and gains m1 — Phase D's post-recompute back-edge
    // probe sees the cycle and throws.
    expect(() => g.commit('bump', (tx) => tx.set(a, 2))).toThrow(CycleError)
  })

  // Test 2 — explicit opt-out is a no-op as of #705 but remains
  // accepted on the surface so adopters do not have to edit
  // construction sites. Behaviour is identical to the default: the
  // latent cycle is accepted at registration and thrown at first
  // commit. This is the back-compat half of the deprecation contract.
  it('with strictCycles: false (deprecated no-op), latent-cycle behaviour matches the default', () => {
    const g = createCausl({ strictCycles: false })
    const a = g.input('a', 1)
    const holder: { ref: Node<number> | null } = { ref: null }
    const m1 = g.derived<number>('m1', (get) =>
      holder.ref !== null ? get(holder.ref) : get(a),
    )
    const m2 = g.derived<number>('m2', (get) => get(m1))
    holder.ref = m2
    expect(() =>
      g.derived<number>('cyc-tail', (get) => get(m1)),
    ).not.toThrow()
    expect(() => g.commit('bump', (tx) => tx.set(a, 2))).toThrow(CycleError)
  })

  // Test 3 — explicit `strictCycles: true` is also a no-op but stays
  // accepted on the surface; the latent cycle fires at first commit
  // exactly like the default. Pinned so call sites that still pass
  // the option (legacy adopter code) do not need to be edited in
  // lockstep with this PR.
  it('with strictCycles: true (deprecated no-op), latent cycle fires on first commit', () => {
    const g = createCausl({ strictCycles: true })
    const a = g.input('a', 1)
    const holder: { ref: Node<number> | null } = { ref: null }
    const m1 = g.derived<number>('m1', (get) =>
      holder.ref !== null ? get(holder.ref) : get(a),
    )
    const m2 = g.derived<number>('m2', (get) => get(m1))
    holder.ref = m2
    expect(() =>
      g.derived<number>('cyc-tail', (get) => get(m1)),
    ).not.toThrow()
    expect(() => g.commit('bump', (tx) => tx.set(a, 2))).toThrow(CycleError)
  })

  // Test 4 — the default does not produce false positives on a
  // legal DAG. Phase D's Kahn pass settles cleanly and registrations
  // succeed with the expected values. This is the negative-space
  // gate: every legal graph must remain registrable AND committable
  // under the default.
  it('default mode does not false-positive on a clean DAG', () => {
    const g = createCausl()
    const a = g.input('a', 2)
    const b = g.input('b', 3)
    const sum = g.derived<number>('sum', (get) => get(a) + get(b))
    const doubled = g.derived<number>('doubled', (get) => get(sum) * 2)
    expect(g.read(doubled)).toBe(10)
    // Add another derived layer to exercise multi-hop recompute under
    // the new commit-time path.
    const tripled = g.derived<number>('tripled', (get) => get(sum) * 3)
    expect(g.read(tripled)).toBe(15)
    // A commit that bumps an input must recompute the affected
    // sub-graph cleanly without firing the cycle probe.
    expect(() => g.commit('bump', (tx) => tx.set(a, 5))).not.toThrow()
    expect(g.read(doubled)).toBe(16)
    expect(g.read(tripled)).toBe(24)
  })

  // Test 5 — multi-hop cycle under the default: the CycleError.path
  // enumerates every node in the offending loop and closes back on
  // the entry point so the caller knows exactly which edge closed
  // the cycle. Construct a four-node cycle through a holder-mutated
  // chain, register the back-edge (which now succeeds), then bump
  // an input that walks Phase D into the SCC. The post-recompute
  // back-edge probe surfaces the cycle path.
  it('default mode multi-hop cycle reports the full path on first commit', () => {
    const g = createCausl()
    const seed = g.input('seed', 0)
    const holder: { ref: Node<number> | null } = { ref: null }
    // n1 → seed (initial) or holder.ref (after mutation).
    const n1 = g.derived<number>('n1', (get) =>
      holder.ref !== null ? get(holder.ref) : get(seed),
    )
    // n2 reads n1.
    const n2 = g.derived<number>('n2', (get) => get(n1))
    // n3 reads n2.
    const n3 = g.derived<number>('n3', (get) => get(n2))
    // Close the loop: n1's compute will, on refresh, read n3 →
    // n3 reads n2 → n2 reads n1 → cycle.
    holder.ref = n3
    // Tail registration succeeds — the cycle is still latent until
    // the first commit walks into the SCC.
    expect(() =>
      g.derived<number>('n4', (get) => get(n1)),
    ).not.toThrow()
    let caught: CycleError | null = null
    try {
      g.commit('bump-seed', (tx) => tx.set(seed, 1))
    } catch (e) {
      if (e instanceof CycleError) caught = e
      else throw e
    }
    expect(caught).not.toBeNull()
    if (caught === null) throw new Error('unreachable')
    // The cycle path includes the three nodes in the loop and
    // closes back on the entry point.
    expect(caught.path).toContain('n1')
    expect(caught.path).toContain('n2')
    expect(caught.path).toContain('n3')
    // Path closes on a repeated id — that's what "closing a cycle"
    // means structurally; the engine's path closure is the load-
    // bearing invariant the caller's recovery path leans on.
    expect(caught.path.length).toBeGreaterThanOrEqual(2)
    const closingId = caught.path[caught.path.length - 1]
    const firstOccurrence = caught.path.indexOf(closingId as string)
    expect(firstOccurrence).toBeLessThan(caught.path.length - 1)
    // Atomicity gate: the failed commit must leave the engine in
    // its pre-commit state. `now` should not have advanced past the
    // registrations' baseline.
    const beforeNow = g.now
    try {
      g.commit('retry', (tx) => tx.set(seed, 2))
    } catch {
      /* expected — same cycle */
    }
    expect(g.now).toBe(beforeNow)
  })
})
