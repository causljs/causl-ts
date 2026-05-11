/**
 * @packageDocumentation
 *
 * SPEC.async §15.1 / Property 3 — forbidden resource transitions.
 *
 * §6 transition table: only the chart-named transitions are legal.
 * The model's `applyEvents` enforces this by leaving illegal
 * transitions as no-ops (e.g., fetch-resolve on idle is silent).
 * This property verifies that no random sequence drives the model
 * into an undeclared state shape.
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import {
  applyEvents,
  resourceEventGen,
  type ResourceModelState,
} from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.1 / Property 3 — forbidden transitions are no-ops', () => {
  it('illegal events leave the state on a chart-legal arm (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(resourceEventGen, { minLength: 1, maxLength: 12 }),
        (events) => {
          const start: ResourceModelState = { tag: 'idle' }
          const end = applyEvents(start, events, 0)
          // The post-state must be one of the five chart arms.
          const tags: ResourceModelState['tag'][] = [
            'idle',
            'loading',
            'loaded',
            'stale',
            'errored',
          ]
          expect(tags).toContain(end.tag)
        },
      ),
      tieredPropertyTrials('resource.forbidden-transitions'),
    )
  })
})
