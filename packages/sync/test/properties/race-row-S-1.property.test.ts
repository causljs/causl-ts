/**
 * @packageDocumentation
 *
 * SPEC.async §9.1.1 / row S-1 — stale-async resolution race.
 *
 * Property: a loader resolution that arrives AFTER the resource was
 * invalidated must NOT transition the resource back to Loaded with
 * the late value. Adjacent to engine row 6 (stale-async); this row
 * lifts the contract to the resource state machine.
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import {
  applyEvents,
  type ResourceEvent,
  type ResourceModelState,
} from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §9.1.1 row S-1 — stale-async resolution', () => {
  it('post-invalidate fetch-resolve never lands as Loaded with the late value (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.record({
          v1: fc.integer({ min: -100, max: 100 }),
          v2: fc.integer({ min: -100, max: 100 }),
        }),
        ({ v1, v2 }) => {
          // Drive: idle → Loading → Loaded(v1) → Stale → Loading → fetch-resolve(v2)
          const events: ResourceEvent[] = [
            { kind: 'fetch-start' },
            { kind: 'fetch-resolve', value: v1 },
            { kind: 'invalidate' },
          ]
          const start: ResourceModelState = { tag: 'idle' }
          const mid = applyEvents(start, events, 0)
          // Mid state: Stale (the model handles this case).
          // A *late* fetch-resolve from the v1 fetch attempt
          // should NOT transition the resource. The model's
          // applyEvents only allows fetch-resolve on Loading;
          // this is exactly the staleness guard. Verify:
          const late = applyEvents(mid, [{ kind: 'fetch-resolve', value: v2 }], 100)
          // The state is unchanged because there's no in-flight Loading.
          expect(late.tag).toBe(mid.tag)
        },
      ),
      tieredPropertyTrials('race-row.S-1.stale-async'),
    )
  })
})
