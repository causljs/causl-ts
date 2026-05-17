/**
 * @packageDocumentation
 *
 * Conflict-registry sub-statechart conformance (EPIC #280, sub-issue
 * #271). Pins the legal-transition table for the per-conflict
 * orthogonal region of the composite lifecycle: every transition
 * originates from `Open`. There are NO edges leaving `Resolved`,
 * `Ignored`, or `Superseded`. Shipping enum tags whose transitions
 * are not specified by the composite statechart is one of the
 * engine's explicit don'ts, so mutators called against a non-Open
 * conflict throw a typed `ForbiddenConflictTransitionError` and leave
 * the registry's serialised state byte-identical to the pre-call
 * snapshot rather than silently no-op'ing.
 *
 * @see docs/lifecycle.md §1 — composite chart, Conflict region
 * @see docs/lifecycle.md §4 — invariant 5: Superseded → * is a no-op
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { propertyTrials } from '@causljs/core-testing-internal'
import { createCausl, type Graph } from '@causljs/core'
import {
  createConflictRegistry,
  ForbiddenConflictTransitionError,
  singleConflictWhen,
  type Conflict,
  type ConflictRegistry,
} from '../src/index.js'

/**
 * Build a conflict registry over a single source node, with a
 * predicate-driven trigger. The registry raises one conflict whenever
 * the source value is the toxic value, and that conflict's id is
 * deterministic (`conflict:source-toxic`) so tests can drive transitions
 * against a known id.
 */
function harness(): {
  graph: Graph
  registry: ConflictRegistry<unknown>
  raise(): void
  conflictId: string
} {
  const graph = createCausl()
  const source = graph.input('src', 'safe')
  const conflictId = 'conflict:src-toxic'
  const registry = createConflictRegistry<unknown>(graph, {
    id: 'test-conflict-registry',
    compute: singleConflictWhen<string>(source, (v) => v === 'toxic', () => ({
      id: conflictId,
      target: 'src',
    })),
  })

  return {
    graph,
    registry,
    raise: () => graph.commit('raise', (tx) => tx.set(source, 'toxic')),
    conflictId,
  }
}

/**
 * Snapshot the registry's serialised state — the value of its derived
 * Conflict[] node — so post-throw byte-equality assertions have an
 * exact oracle.
 */
function snapshot(graph: Graph, registry: ConflictRegistry<unknown>): string {
  return JSON.stringify(registry.read(graph))
}

describe('ConflictRegistry sub-statechart conformance (SPEC §6, EPIC #280 / #271)', () => {
  /**
   * Legal transitions: Open → Resolved | Ignored | Superseded. These
   * must succeed and produce the documented status.
   */
  describe('legal transition table', () => {
    /**
     * Open → Resolved: the canonical happy path. Status updates,
     * resolution payload surfaces on the public Conflict shape.
     */
    it('Open → Resolved sets kind and surfaces the resolution payload', () => {
      // arrange: raise a conflict
      const { graph, registry, raise, conflictId } = harness()
      raise()

      // act: resolve it
      registry.resolve(graph, conflictId, { choice: 'accept' })

      // assert: surfaced as Resolved with resolution
      const cs = registry.read(graph)
      expect(cs).toHaveLength(1)
      const c = cs[0]!
      expect(c.id).toBe(conflictId)
      expect(c.kind).toBe('resolved')
      // Tag-narrowed access — `resolution` lives only on the resolved variant.
      if (c.kind !== 'resolved') throw new Error('unreachable: kind is resolved')
      expect(c.resolution).toEqual({ choice: 'accept' })
    })

    /**
     * Open → Ignored: operator suppresses the conflict. Tag flips
     * to ignored; the discriminated-union shape excludes a resolution
     * field on this variant entirely.
     */
    it('Open → Ignored sets kind to ignored', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.ignore(graph, conflictId)
      const c = registry.read(graph)[0]!
      expect(c.kind).toBe('ignored')
    })

    /**
     * Open → Superseded: another conflict subsumes this one. Tag
     * flips; the linkage now surfaces on the public `supersededBy`
     * member (post #263 — used to be silently dropped).
     */
    it('Open → Superseded sets kind to superseded and exposes the linkage', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.supersede(graph, conflictId, 'conflict:replacement')
      const c = registry.read(graph)[0]!
      expect(c.kind).toBe('superseded')
      if (c.kind !== 'superseded') throw new Error('unreachable: kind is superseded')
      expect(c.supersededBy).toBe('conflict:replacement')
    })
  })

  /**
   * Forbidden transitions out of Resolved, Ignored, Superseded.
   * Every such call must throw `ForbiddenConflictTransitionError`
   * and leave the registry byte-identical.
   */
  describe('rejects forbidden transitions out of terminal states', () => {
    /**
     * Resolved → resolve, ignore, supersede are all forbidden.
     */
    it('rejects resolve(), ignore(), supersede() on a Resolved conflict', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.resolve(graph, conflictId, { choice: 'accept' })
      const before = snapshot(graph, registry)

      // re-resolve — forbidden
      expect(() =>
        registry.resolve(graph, conflictId, { choice: 'reject' }),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)

      // ignore — forbidden
      expect(() => registry.ignore(graph, conflictId)).toThrow(
        ForbiddenConflictTransitionError,
      )
      expect(snapshot(graph, registry)).toBe(before)

      // supersede — forbidden
      expect(() =>
        registry.supersede(graph, conflictId, 'conflict:replacement'),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)
    })

    /**
     * Ignored → resolve, ignore, supersede are all forbidden.
     */
    it('rejects resolve(), ignore(), supersede() on an Ignored conflict', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.ignore(graph, conflictId)
      const before = snapshot(graph, registry)

      expect(() =>
        registry.resolve(graph, conflictId, { choice: 'accept' }),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)

      expect(() => registry.ignore(graph, conflictId)).toThrow(
        ForbiddenConflictTransitionError,
      )
      expect(snapshot(graph, registry)).toBe(before)

      expect(() =>
        registry.supersede(graph, conflictId, 'conflict:other'),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)
    })

    /**
     * Superseded → resolve, ignore, supersede are all forbidden.
     * docs/lifecycle.md §4 invariant 5 explicitly: "A Superseded
     * conflict's resolve(choice) is a no-op." We make it a typed
     * error rather than silently no-op so callers can audit.
     */
    it('rejects resolve(), ignore(), supersede() on a Superseded conflict', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.supersede(graph, conflictId, 'conflict:replacement')
      const before = snapshot(graph, registry)

      expect(() =>
        registry.resolve(graph, conflictId, { choice: 'accept' }),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)

      expect(() => registry.ignore(graph, conflictId)).toThrow(
        ForbiddenConflictTransitionError,
      )
      expect(snapshot(graph, registry)).toBe(before)

      expect(() =>
        registry.supersede(graph, conflictId, 'conflict:other'),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)
    })

    /**
     * The thrown error carries enough metadata for adapter code to
     * route the failure to a useful UI message — `from` (current
     * status), `to` (attempted status), `id` (the conflict).
     */
    it('the thrown error carries (from, to, id) for adapter UI routing', () => {
      const { graph, registry, raise, conflictId } = harness()
      raise()
      registry.resolve(graph, conflictId, { choice: 'accept' })

      try {
        registry.ignore(graph, conflictId)
        expect.fail('expected ForbiddenConflictTransitionError')
      } catch (e) {
        if (!(e instanceof ForbiddenConflictTransitionError)) throw e
        expect(e.id).toBe(conflictId)
        expect(e.from).toBe('resolved')
        expect(e.to).toBe('ignored')
      }
    })
  })

  /**
   * Open is the only status with outgoing edges. Every test in this
   * block confirms that calling a mutator on a not-yet-raised id is
   * also rejected — there's no "open by default" silent behaviour.
   */
  describe('rejects mutators on unknown conflicts', () => {
    /**
     * Calling resolve on an id the registry has never observed must
     * throw, not silently materialise a Resolved record.
     */
    it('rejects resolve() on an unknown id', () => {
      const { graph, registry } = harness()
      // No raise — the conflict id is not present.
      const before = snapshot(graph, registry)
      expect(() =>
        registry.resolve(graph, 'never-raised', { choice: 'accept' }),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)
    })

    /**
     * Same contract for ignore() and supersede().
     */
    it('rejects ignore() and supersede() on unknown ids', () => {
      const { graph, registry } = harness()
      const before = snapshot(graph, registry)
      expect(() => registry.ignore(graph, 'never-raised')).toThrow(
        ForbiddenConflictTransitionError,
      )
      expect(snapshot(graph, registry)).toBe(before)
      expect(() =>
        registry.supersede(graph, 'never-raised', 'conflict:other'),
      ).toThrow(ForbiddenConflictTransitionError)
      expect(snapshot(graph, registry)).toBe(before)
    })
  })

  /**
   * Property-based statechart conformance: generate an arbitrary
   * sequence of mutator calls and assert that the resulting status
   * matches the conflict statechart's reachability table exactly —
   * legal edges only out of `Open`, no edges out of the terminals.
   * Property tests are this engine's race-detection layer, with a
   * minimum of 1000 trials per property on every CI run.
   */
  describe('property: status reachability matches §6 statechart', () => {
    /**
     * For any sequence of legal-followed-by-illegal transitions, the
     * registry's final status is determined by the FIRST legal
     * transition (Open → X). Subsequent illegal transitions throw
     * and do not change state. The property generates random
     * sequences and asserts the final status matches the first
     * legal transition (or Open if none was made).
     */
    it('any sequence terminates at the first legal Open→X transition', () => {
      type Action =
        | { kind: 'raise' }
        | { kind: 'resolve' }
        | { kind: 'ignore' }
        | { kind: 'supersede' }

      const actionArb = fc.constantFrom<Action>(
        { kind: 'raise' },
        { kind: 'resolve' },
        { kind: 'ignore' },
        { kind: 'supersede' },
      )

      fc.assert(
        fc.property(fc.array(actionArb, { minLength: 0, maxLength: 8 }), (actions) => {
          const { graph, registry, raise, conflictId } = harness()
          let raised = false
          let firstLegalTerminal:
            | 'resolved'
            | 'ignored'
            | 'superseded'
            | null = null

          for (const action of actions) {
            if (action.kind === 'raise') {
              if (!raised) {
                raise()
                raised = true
              }
              continue
            }
            // For mutator calls, decide whether legal or illegal.
            const legal = raised && firstLegalTerminal === null
            try {
              switch (action.kind) {
                case 'resolve':
                  registry.resolve(graph, conflictId, { c: 1 })
                  break
                case 'ignore':
                  registry.ignore(graph, conflictId)
                  break
                case 'supersede':
                  registry.supersede(graph, conflictId, 'conflict:other')
                  break
              }
              // Reached only on legal call (else throw above).
              expect(legal).toBe(true)
              firstLegalTerminal =
                action.kind === 'resolve'
                  ? 'resolved'
                  : action.kind === 'ignore'
                    ? 'ignored'
                    : 'superseded'
            } catch (e) {
              if (!(e instanceof ForbiddenConflictTransitionError)) throw e
              expect(legal).toBe(false)
            }
          }

          // Terminal-state check.
          const conflicts = registry.read(graph)
          if (!raised) {
            expect(conflicts).toHaveLength(0)
          } else if (firstLegalTerminal === null) {
            expect(conflicts[0]!.kind).toBe('open')
          } else {
            expect(conflicts[0]!.kind).toBe(firstLegalTerminal)
          }
        }),
        // Routed through the seam helper so the engine's 1000-trial
        // per-property floor is enforced structurally and so failing
        // seeds emit the `CAUSL_FUZZ_SEED=… pnpm test:run`
        // reproduction hint. The §15.2 conformance walker rejects raw
        // `{ numRuns: N }` literals here.
        propertyTrials('conflict-statechart-action-walk'),
      )
    })
  })

  /**
   * Self-checks for the harness — without these, a stub
   * implementation that always throws could pass the legal-transition
   * tests by accident.
   */
  describe('harness self-checks', () => {
    /**
     * `raise()` actually raises a conflict and the registry sees it
     * before any mutator runs.
     */
    it('raise() materialises an Open conflict in the registry', () => {
      const { graph, registry, raise, conflictId } = harness()
      // Before raising — registry is empty.
      expect(registry.read(graph)).toHaveLength(0)
      raise()
      const cs = registry.read(graph)
      expect(cs).toHaveLength(1)
      expect(cs[0]!.id).toBe(conflictId)
      expect(cs[0]!.kind).toBe('open')
    })

    /**
     * `snapshot()` is byte-stable across repeated reads of a
     * quiescent registry.
     */
    it('snapshot() is byte-stable on a quiescent registry', () => {
      const { graph, registry, raise } = harness()
      raise()
      const a = snapshot(graph, registry)
      const b = snapshot(graph, registry)
      expect(a).toBe(b)
    })
  })
})

// Surface assertion to ensure `Conflict` type is properly tagged on
// the SPEC §9 discriminator (`kind`). This is a compile-time guard
// rather than a runtime check.
function _conflictTypeProbe(c: Conflict<unknown>): void {
  switch (c.kind) {
    case 'open':
    case 'resolved':
    case 'ignored':
    case 'superseded':
      return
  }
}
