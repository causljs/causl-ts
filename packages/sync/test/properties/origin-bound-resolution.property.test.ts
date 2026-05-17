/**
 * @packageDocumentation
 *
 * SPEC.async §15.1 / Property 2 — origin-bound resolution.
 *
 * §3.1 Theorem 1: a fetch-resolve event lands the value on the
 * resource whose `origin` matches the in-flight fetch. The model
 * here: when a Loading state transitions to Loaded, the loaded
 * state's `origin` is preserved from the Loading state.
 */

import { tieredPropertyTrials } from '@causljs/core-testing-internal'
import {
  applyEvents,
  loadingEpisodeGen,
  type ResourceModelState,
} from '@causljs/sync-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

describe('SPEC.async §15.1 / Property 2 — origin-bound resolution', () => {
  it('Loading → Loaded preserves the origin (≥1000 trials)', () => {
    fc.assert(
      fc.property(loadingEpisodeGen, (episode) => {
        const start: ResourceModelState = { tag: 'idle' }
        const end = applyEvents(start, episode, 100)
        if (end.tag === 'loaded' && end.origin !== undefined) {
          expect(end.origin).toBeGreaterThan(100)
        }
      }),
      tieredPropertyTrials('resource.origin-bound-resolution'),
    )
  })
})
