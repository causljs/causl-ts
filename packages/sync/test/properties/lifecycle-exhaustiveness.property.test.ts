/**
 * @packageDocumentation
 *
 * SPEC.async §15.1 / Property 1 — Resource lifecycle exhaustiveness.
 *
 * Generator: arbitrary sequences of ResourceEvent. Predicate: the
 * post-state is one of the five §6 chart arms. A regression that
 * synthesises a sixth arm fails this property.
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import { applyEvents, resourceEventGen, type ResourceModelState } from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

const VALID_TAGS = new Set<ResourceModelState['tag']>([
  'idle',
  'loading',
  'loaded',
  'stale',
  'errored',
])

describe('SPEC.async §15.1 / Property 1 — lifecycle exhaustiveness', () => {
  it('every reachable post-state is one of the five §6 chart arms (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(resourceEventGen, { minLength: 0, maxLength: 16 }),
        (events) => {
          const start: ResourceModelState = { tag: 'idle' }
          const end = applyEvents(start, events, 0)
          expect(VALID_TAGS.has(end.tag)).toBe(true)
        },
      ),
      tieredPropertyTrials('resource.lifecycle-exhaustiveness'),
    )
  })
})
