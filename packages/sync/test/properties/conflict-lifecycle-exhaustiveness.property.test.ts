/**
 * @packageDocumentation
 *
 * SPEC.async §15.2 / Property 5 — Conflict lifecycle exhaustiveness.
 *
 * Generator: arbitrary sequences of ConflictEvent. Predicate: every
 * conflict in the resulting registry is in one of the four §4 chart
 * arms (open / resolved / ignored / superseded).
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import { applyConflictEvents, conflictEventGen } from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

const VALID = new Set(['open', 'resolved', 'ignored', 'superseded'])

describe('SPEC.async §15.2 / Property 5 — conflict lifecycle exhaustiveness', () => {
  it('every conflict is in one of the four §4 chart arms (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(conflictEventGen, { minLength: 0, maxLength: 16 }),
        (events) => {
          const map = applyConflictEvents({}, events)
          for (const k of Object.values(map)) {
            expect(VALID.has(k)).toBe(true)
          }
        },
      ),
      tieredPropertyTrials('conflict.lifecycle-exhaustiveness'),
    )
  })
})
