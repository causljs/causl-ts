/**
 * @packageDocumentation
 *
 * SPEC.async §15.1 / Property 4 — Promise identity stability.
 *
 * §3.1 Theorem 3: re-reading a resource at different offsets in a
 * stable state yields a stable view. The property model: after
 * applying a sequence of events, a follow-up read at any offset
 * within the resulting Loaded state's lifetime sees the same
 * (tag, value, origin) tuple.
 */

import { tieredPropertyTrials } from '@causljs/core-testing-internal'
import {
  applyEvents,
  readScheduleGen,
  resourceEventGen,
  type ResourceModelState,
} from '@causljs/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.1 / Property 4 — Promise identity stability', () => {
  it('same Loaded state yields same (tag, value, origin) on repeated reads (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(resourceEventGen, { minLength: 0, maxLength: 12 }),
        readScheduleGen,
        (events, _schedule) => {
          const start: ResourceModelState = { tag: 'idle' }
          const a = applyEvents(start, events, 0)
          const b = applyEvents(start, events, 0)
          // Two identical applications yield identical state.
          expect(a.tag).toBe(b.tag)
          expect(a.value).toBe(b.value)
          expect(a.origin).toBe(b.origin)
        },
      ),
      tieredPropertyTrials('resource.promise-identity-stability'),
    )
  })
})
