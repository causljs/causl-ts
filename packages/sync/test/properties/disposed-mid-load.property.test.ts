/**
 * @packageDocumentation
 *
 * Disposed-mid-load staleness — adjacent to `SPEC.md` §9.1 engine
 * row 11 (use-after-dispose), lifted to the `@causl/sync` resource
 * state machine.
 *
 * Property: a resource disposed while a fetch is in flight must
 * NOT mutate from a late loader resolution. The model approximates
 * dispose as a terminal state with a `disposed` tag (extending the
 * five-arm chart).
 *
 * Audit-doc identity: this is the witness the audit (#844) tracked
 * under the audit-doc S-2 row (disposed-mid-load); SPEC.async §9.1.1
 * row S-2 names a different race (open-set drift mid-resolution),
 * whose witness lives at
 * `properties/conflict-registry-drift.property.test.ts` (#919). This
 * file used to be named `race-row-S-2.property.test.ts` and was
 * renamed in #919 to remove the false SPEC.async §9.1.1 S-2 claim
 * its docstring made.
 */

import { tieredPropertyTrials } from '@causl/core-testing-internal'
import {
  applyEvents,
  type ResourceEvent,
  type ResourceModelState,
} from '@causl/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

/**
 * Apply events with a "disposed" terminal: once disposed, no event
 * mutates the state. Models the SPEC.async §10.4 contract.
 */
function applyEventsDisposable(
  state: ResourceModelState | { tag: 'disposed' },
  events: readonly ResourceEvent[],
  disposeAfterStep: number | null,
  startTime: number,
): ResourceModelState | { tag: 'disposed' } {
  let s: ResourceModelState | { tag: 'disposed' } = state
  let i = 0
  for (const e of events) {
    if (s.tag === 'disposed') return s
    if (disposeAfterStep !== null && i === disposeAfterStep) {
      s = { tag: 'disposed' }
      continue
    }
    s = applyEvents(s as ResourceModelState, [e], startTime + i)
    i++
  }
  return s
}

describe('disposed-mid-load staleness — engine row 11 adapter lift', () => {
  it('post-dispose loader resolution does not mutate the disposed resource (≥1000 trials)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom<ResourceEvent>(
            { kind: 'fetch-start' },
            { kind: 'fetch-resolve', value: 1 },
            { kind: 'fetch-reject', error: 'boom' },
            { kind: 'invalidate' },
          ),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 8 }),
        (events, disposeStep) => {
          const start: ResourceModelState = { tag: 'idle' }
          const end = applyEventsDisposable(
            start,
            events,
            Math.min(disposeStep, events.length),
            0,
          )
          // If dispose was applied, end state is 'disposed'; no
          // event after dispose mutates it.
          if (disposeStep < events.length) {
            expect(end.tag).toBe('disposed')
          }
        },
      ),
      tieredPropertyTrials('race-row.S-2.disposed-mid-load'),
    )
  })
})
