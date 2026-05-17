/**
 * @packageDocumentation
 *
 * SPEC.async §15.2 / Property 6 — forbidden conflict transitions.
 *
 * §4 transition table: only the chart-named transitions are legal.
 * The model's `applyConflictEvents` enforces this by leaving
 * illegal transitions as no-ops (resolve on resolved, etc.). This
 * property verifies that no random sequence drives the model into
 * an undeclared state shape.
 */

import { tieredPropertyTrials } from '@causljs/core-testing-internal'
import { applyConflictEvents, conflictEventGen } from '@causljs/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.2 / Property 6 — forbidden conflict transitions', () => {
  it('illegal events leave the registry on chart-legal arms (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(conflictEventGen, { minLength: 1, maxLength: 12 }),
        (events) => {
          const map = applyConflictEvents({}, events)
          // Every value is one of the four legal arms.
          for (const k of Object.values(map)) {
            expect(['open', 'resolved', 'ignored', 'superseded']).toContain(k)
          }
        },
      ),
      tieredPropertyTrials('conflict.forbidden-transitions'),
    )
  })
})
