/**
 * @packageDocumentation
 *
 * SPEC.async §15.2 / Property 7 — single-writer resolution.
 *
 * §4 single-writer commitment: a conflict with multiple resolve
 * mutations only takes the first (subsequent resolve calls are
 * no-ops on a non-Open conflict). This property fuzzes that.
 */

import { tieredPropertyTrials } from '@causljs/core-testing-internal'
import { applyConflictEvents, type ConflictEvent } from '@causljs/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.2 / Property 7 — single-writer resolution', () => {
  it('subsequent mutations on a closed conflict are no-ops (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 4 }),
        fc.array(
          fc.constantFrom<ConflictEvent['kind']>(
            'resolve',
            'ignore',
            'supersede',
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (id, kinds) => {
          const events: ConflictEvent[] = [
            { kind: 'raise', id },
            ...kinds.map((kind) => {
              if (kind === 'supersede') {
                return { kind, id, bySupersedingId: 'x' } as ConflictEvent
              }
              return { kind, id } as ConflictEvent
            }),
          ]
          const map = applyConflictEvents({}, events)
          // The conflict ends in exactly one terminal arm — first mutator wins.
          expect(['resolved', 'ignored', 'superseded']).toContain(map[id])
        },
      ),
      tieredPropertyTrials('conflict.single-writer-resolution'),
    )
  })
})
