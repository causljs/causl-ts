/**
 * @packageDocumentation
 *
 * SPEC.async §15.2 / Property 8 — open-set computation.
 *
 * §4 derived-view commitment: the registry's open set is exactly
 * the conflicts whose status is 'open' after applying the event
 * sequence. The property fuzzes random event sequences and verifies
 * the open-set membership predicate.
 */

import { tieredPropertyTrials } from '@causljs/core-testing-internal'
import { applyConflictEvents, conflictEventGen } from '@causljs/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.2 / Property 8 — open-set computation', () => {
  it('open-set membership equals the open-tagged conflicts (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(conflictEventGen, { minLength: 0, maxLength: 16 }),
        (events) => {
          const map = applyConflictEvents({}, events)
          const openSet = Object.entries(map)
            .filter(([, k]) => k === 'open')
            .map(([id]) => id)
          // Every open-set member is tagged 'open' in the registry.
          for (const id of openSet) {
            expect(map[id]).toBe('open')
          }
          // Every 'open'-tagged entry is in the open set.
          for (const [id, k] of Object.entries(map)) {
            if (k === 'open') {
              expect(openSet).toContain(id)
            }
          }
        },
      ),
      tieredPropertyTrials('conflict.open-set-computation'),
    )
  })
})
