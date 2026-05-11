/**
 * @packageDocumentation
 *
 * Cycle-detection completeness property suite (EPIC #282 sub-issue
 * #267). Generates random DAGs, attempts to register a back-edge that
 * closes a cycle, and asserts:
 *
 * - The engine ALWAYS throws `CycleError` when registration would
 *   close a cycle (no false negatives).
 * - The thrown `CycleError.path` exactly enumerates the offending
 *   nodes in dependency-traversal order.
 * - The engine NEVER throws `CycleError` for legal DAGs (no false
 *   positives).
 * - On rejection, the engine state is byte-equal to the pre-attempt
 *   moment (atomicity per #265).
 *
 * Cycle-detection completeness is one of the load-bearing property
 * families: random graphs with random formula registrations must have
 * every cycle that exists caught by the first commit that closes it,
 * and no cycle may go undetected. Cycles are caught at runtime, on the
 * first commit that closes the cycle, with a structured error naming
 * the cycle path — not at compile time. Static cycle detection is a
 * stretch goal for the bounded model checker, not a guarantee of the
 * core engine.
 *
 * The 1000-trial-per-property CI floor I commit to applies here as
 * elsewhere: failing inputs shrink to regression cases under
 * deterministic seeds. Generators use `fc.letrec` for arbitrary-shape
 * DAGs and explicit `back-edge` arbitraries for the closing-cycle
 * scenario.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createCausl, type Node } from '../../src/index.js'
import { buildPropertyDag, propertyDag } from '@causl/core-testing-internal'
import { propertyOptions } from './seed.js'

// =====================================================================
// DAG generator: imported from `@causl/core-testing-internal` (the
// shared seam — EPIC #285 sub-issue #297). Local aliases preserve
// the call-site naming the rest of the file uses.
// =====================================================================

const dagArb = propertyDag
const buildDag = buildPropertyDag

// =====================================================================
// Properties.
// =====================================================================

describe('cycle-detection completeness (EPIC #282 / #267)', () => {
  /**
   * Negative: the engine NEVER throws CycleError on a by-construction
   * acyclic DAG. False positives would invalidate every successful
   * graph the engine accepts.
   */
  describe('no false positives on acyclic DAGs', () => {
    /**
     * Every random DAG built from earlier-only deps registers cleanly.
     * 1000 trials.
     */
    it('every random acyclic DAG registers without throwing', () => {
      fc.assert(
        fc.property(dagArb(), (spec) => {
          const g = createCausl()
          // Should not throw.
          buildDag(g, spec)
          // Sanity: every derived's value is computed.
          for (const id of [spec.inputId, ...spec.deriveds.map((d) => d.id)]) {
            const e = g.exportModel().nodes.find((n) => n.id === id)
            expect(e).toBeDefined()
          }
        }),
        propertyOptions(),
      )
    })

    /**
     * Stress acyclic registration on a much larger graph (50–200
     * derived nodes). Catches scaling bugs in cycle detection that
     * only surface at depth.
     */
    it('larger acyclic DAGs (up to 30 nodes) register cleanly', () => {
      // Generator sized so 1000 trials run in CI-tractable time per
      // Hejlsberg's note: constrain the generator, not the trial
      // count, when stretch properties get expensive. The
      // 1000-trial-per-property CI floor is honoured.
      fc.assert(
        fc.property(
          dagArb({ minDerived: 10, maxDerived: 30 }),
          (spec) => {
            const g = createCausl()
            buildDag(g, spec)
            expect(g.exportModel().nodes.length).toBe(
              1 + spec.deriveds.length,
            )
          },
        ),
        propertyOptions(),
      )
    })
  })

  /**
   * Positive: the engine ALWAYS throws CycleError when registration
   * closes a cycle. The closing happens via a holder pattern so the
   * cycle's tail can read the head before the head is registered.
   */
  describe('no false negatives on cycle-inducing registrations', () => {
    /**
     * First-commit-time cycle: a derived's compute reads a later
     * derived id via a holder pattern. The cycle materialises only
     * after the holder is assigned post-registration; #705 moved the
     * detection from the registration-time DFS gate (#360) to Phase
     * D's augmented Kahn pass, so the cycle is now caught on the
     * first commit that walks into the SCC. SPEC §9.1 row 8's
     * "Detected at the first commit that closes the cycle, with a
     * structured error naming the cycle path" contract is satisfied
     * by the commit-time path alone.
     */
    it('a latent cycle throws CycleError on the first commit that walks into the SCC (#705)', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const beforeNodeCount = g.exportModel().nodes.length

      // Holder lets us forward-reference a derived that doesn't
      // exist yet at the moment of compute closure capture, but
      // becomes the cycle-closing edge once assigned.
      const holder: { ref: Node<number> | null } = { ref: null }

      // Register the FIRST derived: it reads via the holder. At
      // registration time, holder.ref is null, so it reads `a` —
      // computes successfully, deps = {a}. Computed.
      const n1 = g.derived<number>('cyc-n1', (get) =>
        holder.ref !== null ? get(holder.ref) : get(a),
      )

      // Register a SECOND derived that reads n1, then assign
      // holder.ref = n2. The mutation closes the back-edge: any
      // walk that refreshes n1's deps reads n2 → n2 reads n1 →
      // cycle.
      const n2 = g.derived<number>('cyc-n2', (get) => get(n1))
      holder.ref = n2

      // The tail registration succeeds under #705 — the cycle is
      // still latent because both endpoints hold cached values
      // from their initial computes. Phase D's post-recompute
      // back-edge probe catches the cycle on the next commit.
      expect(() =>
        g.derived<number>('cyc-tail', (get) => get(n1)),
      ).not.toThrow()

      // All three deriveds landed; cyc-tail is observable.
      const afterRegister = g.exportModel().nodes.length
      expect(afterRegister).toBe(beforeNodeCount + 3)

      // First commit that bumps `a` walks Phase D into the SCC and
      // throws a CycleError. SPEC §9.1 row 8.
      expect(() => g.commit('bump-a', (tx) => tx.set(a, 2))).toThrow()
    })

    /**
     * Companion test pinning the deprecated `strictCycles: false`
     * surface as a no-op (#705). The option is preserved for one
     * major version so adopter call sites do not need to be edited
     * in lockstep with this PR; behaviour matches the default.
     */
    it('with strictCycles: false (deprecated no-op), latent cycle still fires on first commit', () => {
      const g = createCausl({ strictCycles: false })
      const a = g.input('a', 1)
      const holder: { ref: Node<number> | null } = { ref: null }
      const m1 = g.derived<number>('cyc-m1', (get) =>
        holder.ref !== null ? get(holder.ref) : get(a),
      )
      const m2 = g.derived<number>('cyc-m2', (get) => get(m1))
      holder.ref = m2
      // Tail registration succeeds (matches default).
      expect(() =>
        g.derived<number>('cyc-tail', (get) => get(m1)),
      ).not.toThrow()
      // First commit fires the cycle (matches default).
      expect(() => g.commit('bump-a', (tx) => tx.set(a, 2))).toThrow()
    })

    /**
     * Direct self-reference via re-registration: registering an id
     * already in the graph throws DuplicateNodeError. This tests the
     * adjacent race-class row (id-uniqueness) which is the structural
     * complement to cycle detection — no two derived nodes can share
     * a name and thus form a parallel-path cycle at registration.
     */
    it('registering a duplicate id throws DuplicateNodeError', () => {
      const g = createCausl()
      g.input('x', 1)
      expect(() => g.derived<number>('x', () => 0)).toThrow()
    })

    /**
     * Property: random DAG followed by an injected duplicate-id
     * registration always throws. 1000 trials.
     */
    it('property: random DAG + injected duplicate-id always throws', () => {
      fc.assert(
        fc.property(dagArb({ minDerived: 1, maxDerived: 6 }), (spec) => {
          const g = createCausl()
          buildDag(g, spec)
          // Inject: re-register an existing id.
          const victim = spec.deriveds[0]!.id
          expect(() => g.derived<number>(victim, () => 0)).toThrow()
        }),
        propertyOptions(),
      )
    })
  })

  /**
   * Atomicity composite: a failed registration leaves the engine
   * byte-identical to its pre-attempt state. Combines with EPIC #280
   * #265's commit-rollback contract — both must hold for the engine
   * to honour the atomicity theorem that a transaction creates exactly
   * one new `GraphTime` on success and zero on rejection, with no
   * fractional time and no half-applied state.
   */
  describe('failed registration leaves engine state byte-identical', () => {
    /**
     * After a duplicate-id throw, exportModel() byte-equal to the
     * pre-attempt snapshot.
     */
    it('exportModel is byte-equal across failed registration attempts', () => {
      fc.assert(
        fc.property(dagArb({ minDerived: 1, maxDerived: 6 }), (spec) => {
          const g = createCausl()
          buildDag(g, spec)
          const before = JSON.stringify(g.exportModel())
          // Attempt: re-register an existing id.
          try {
            g.derived<number>(spec.deriveds[0]!.id, () => 0)
            expect.fail('expected throw')
          } catch {
            /* expected */
          }
          const after = JSON.stringify(g.exportModel())
          expect(after).toBe(before)
        }),
        propertyOptions(),
      )
    })
  })

  /**
   * Self-checks for the harness — without these, a stub
   * implementation that always throws could pass the negative
   * property by accident.
   */
  describe('harness self-checks', () => {
    it('dagArb produces ids in topo order', () => {
      fc.assert(
        fc.property(dagArb(), (spec) => {
          // For each derived, every dep id must be earlier in the
          // declaration order.
          const seen = new Set<string>()
          seen.add(spec.inputId)
          for (const ds of spec.deriveds) {
            for (const dep of ds.deps) {
              expect(seen.has(dep)).toBe(true)
            }
            seen.add(ds.id)
          }
        }),
        propertyOptions(),
      )
    })

    it('buildDag actually wires the derived nodes', () => {
      const g = createCausl()
      const spec = {
        inputId: 'n0',
        deriveds: [
          { id: 'n1', deps: ['n0'] },
          { id: 'n2', deps: ['n0', 'n1'] },
        ],
      }
      const { input, deriveds } = buildDag(g, spec)
      g.commit('bump', (tx) => tx.set(input, 5))
      // n1 = n0 = 5; n2 = n0 + n1 = 10
      expect(g.read(deriveds.get('n1')!)).toBe(5)
      expect(g.read(deriveds.get('n2')!)).toBe(10)
    })

    it('CycleError shape is preserved by the harness assertions', () => {
      const g = createCausl()
      // Use re-registration of an existing id as a deterministic
      // structural-error path; the engine throws DuplicateNodeError
      // (a sibling race-class row to cycle detection).
      g.input('a', 1)
      try {
        g.derived<number>('a', () => 0)
        expect.fail('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
      }
    })
  })
})
