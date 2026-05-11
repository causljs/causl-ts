/**
 * @packageDocumentation
 *
 * SPEC.async §9.1.1 / row S-2 — open-set drift mid-resolution.
 *
 * Scenario (SPEC.async lines 580-586): a `ConflictRegistry` carries
 * a conflict in the `open` arm; the host invokes
 * `resolve(graph, id, payload)`; between the registry's `requireOpen`
 * guard read of the open set and the resolution-Input commit, the
 * application-supplied open-set compute would emit a different set
 * if it were re-evaluated mid-call.
 *
 * Property under test: the §5 atomicity contract closes the seam
 * structurally — the guard reads through `graph.read(openSet)` and
 * the patch commits through `graph.commit` on the same
 * `ConflictRegistryWriteGraph` slice, both observing the same
 * GraphTime. Between the guard read and the patch commit the engine
 * cannot advance time, so the open-set compute cannot have re-emitted.
 * The patch lands at GraphTime `now + 1`; subsequent open-set
 * re-emission is a downstream Phase D recomputation against the
 * post-patch resolution map — i.e. the public `Conflict<T>[]` overlay
 * reflects the resolved arm, not a phantom open arm.
 *
 * The §5 atomicity contract closes this seam structurally; this
 * property test enforces the structural closure at the
 * `≥1000`-trial floor `SPEC.async` §17 commitment 7 audits against,
 * across randomized open-set-source mutations.
 *
 * Adapter §17 commitments closed: 3 (capability-narrowed
 * `ConflictRegistryWriteGraph` is the only authority surface
 * `resolve` uses) and 7 (chart-conformance: `Open → Resolved` is
 * the only edge fired regardless of mid-call source-map drift).
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import { propertyConflictWithMap } from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §9.1.1 row S-2 — open-set drift mid-resolution', () => {
  it(
    'resolve commits at one GraphTime tick past the guard read regardless ' +
      'of open-set-source mutations applied before the call (≥1000 trials)',
    () => {
      fc.assert(
        fc.property(
          // Target id always present in the open set.
          fc.constantFrom('a', 'b', 'c', 'd'),
          // Additional ids that may be added/removed before the
          // resolve call. The drift fuzzer mutates the source map
          // in random ways before the resolve to simulate an
          // open-set compute whose re-evaluation would emit a
          // different set than the registry's requireOpen sees.
          fc.array(
            fc.tuple(
              fc.boolean(),
              fc.constantFrom('w', 'x', 'y', 'z'),
            ),
            { minLength: 0, maxLength: 6 },
          ),
          // The resolution payload — opaque to the registry.
          fc.integer({ min: -1000, max: 1000 }),
          (targetId, drifts, payload) => {
            // Seed: target id plus one stable companion so the open
            // set is non-singleton (drift only matters across a set
            // of size > 1).
            const seedIds = [targetId, 'seed-companion']
            const harness = propertyConflictWithMap<number>(seedIds)
            const { graph, registry, sourceInput } = harness

            // Apply pre-resolve drift mutations to the source Input.
            // Each drift step adds (true) or removes (false) an id
            // from the open set source. These advance GraphTime
            // and force a re-emission of the open-set compute.
            for (const [add, id] of drifts) {
              graph.commit(`drift:${add ? 'add' : 'remove'}:${id}`, (tx) => {
                const current = graph.read(sourceInput)
                const next = new Map(current)
                if (add) {
                  next.set(id, payload as number)
                } else {
                  next.delete(id)
                }
                tx.set(sourceInput, next as ReadonlyMap<string, number>)
              })
            }

            // Re-establish target invariant after drift: ensure
            // target id is still in the source map (drift could
            // have removed it). The §5 atomicity guarantee is
            // about what happens *during* resolve — the property
            // pre-condition is that target id is in the open arm
            // when resolve is called.
            const beforeMap = graph.read(sourceInput)
            if (!beforeMap.has(targetId)) {
              const restored = new Map(beforeMap)
              restored.set(targetId, payload as number)
              graph.commit(`drift:restore:${targetId}`, (tx) => {
                tx.set(sourceInput, restored as ReadonlyMap<string, number>)
              })
            }

            // Capture the GraphTime the registry's requireOpen will
            // observe. The §5 atomicity contract pins the patch's
            // commit to one tick past this GraphTime — no
            // intermediate re-emission of the open-set compute can
            // sneak in between guard and patch.
            const tBeforeResolve = graph.now

            // Sanity: target is open at this point.
            const preConflicts = registry.read(graph)
            const preTarget = preConflicts.find((c) => c.id === targetId)
            expect(
              preTarget?.kind,
              `target ${targetId} must be open before resolve`,
            ).toBe('open')

            registry.resolve(graph, targetId, payload)

            const tAfterResolve = graph.now

            // §5 atomicity: resolve advances GraphTime by exactly one
            // tick (`commit` is the only mutation API and it produces
            // exactly one new GraphTime per call).
            expect(
              tAfterResolve - tBeforeResolve,
              `resolve must advance GraphTime by exactly one tick; ` +
                `pre=${tBeforeResolve} post=${tAfterResolve}`,
            ).toBe(1)

            // §5 atomicity: the public Conflict<T>[] surface for the
            // target id reflects the resolved arm, not a phantom
            // open arm — even though the open-set compute would
            // re-emit a potentially different set.
            const postConflicts = registry.read(graph)
            const postTarget = postConflicts.find((c) => c.id === targetId)
            expect(
              postTarget,
              `target ${targetId} must remain in the registry surface ` +
                `post-resolve (the open-set compute still emits it)`,
            ).toBeDefined()
            expect(
              postTarget?.kind,
              `target ${targetId} kind must be 'resolved' post-resolve, ` +
                `not 'open' (which would indicate the §5 seam leaked)`,
            ).toBe('resolved')

            // The resolution payload is committed under the same
            // GraphTime the requireOpen guard observed — the patch's
            // record stamps `at: g.now` *at the call site*, before
            // the commit advances the clock. This is the
            // load-bearing closure of the seam: requireOpen and
            // patch read from the same GraphTime, so the open-set
            // compute that requireOpen saw is the same one the
            // resolution lands against.
            if (postTarget?.kind === 'resolved') {
              expect(
                postTarget.resolution,
                `resolution payload must round-trip through the ` +
                  `Conflict<T>[] overlay`,
              ).toBe(payload)
              expect(
                postTarget.resolvedAt,
                `resolvedAt must equal the GraphTime requireOpen ` +
                  `observed (tBeforeResolve = ${tBeforeResolve}); ` +
                  `the §5 atomicity contract pins guard read and ` +
                  `patch record to the same GraphTime`,
              ).toBe(tBeforeResolve)
            }

            // Re-emission witness: subsequent open-set source
            // mutations cannot retroactively flip the resolved arm
            // back to open — the resolution Input's record pins the
            // overlay regardless of the open-set compute's future
            // outputs. Add another drift step and re-read.
            graph.commit('drift:post-resolve', (tx) => {
              const current = graph.read(sourceInput)
              const next = new Map(current)
              next.set('post-drift', payload as number)
              tx.set(sourceInput, next as ReadonlyMap<string, number>)
            })
            const afterPostDrift = registry.read(graph)
            const stillResolved = afterPostDrift.find(
              (c) => c.id === targetId,
            )
            expect(
              stillResolved?.kind,
              `target ${targetId} must remain 'resolved' across ` +
                `post-resolve open-set mutations — the §5 seam ` +
                `closure is irreversible`,
            ).toBe('resolved')
          },
        ),
        tieredPropertyTrials('conflict-registry.open-set-drift'),
      )
    },
  )
})
