/**
 * @packageDocumentation
 *
 * Tests for the live-Graph event appliers (#578).
 *
 * SPEC.async §15.0 prescribes applyEvents / applyConflictEvents
 * variants that drive a LIVE harness through real chart
 * transitions. Pre-#578 only the model-state versions existed;
 * this commit adds the live variants alongside.
 */

import { describe, expect, it } from 'vitest'
import {
  applyConflictEventsLive,
  applyEventsLive,
  preserveLoadingEpisode,
  preserveOpenPriming,
  propertyConflict,
  propertyResource,
  type ConflictEvent,
  type ResourceEvent,
} from '../src/index.js'
import fc from 'fast-check'

describe('applyEventsLive — drives live Resource through events (#578)', () => {
  it('fetch-start → fetch-resolve transitions through loading to loaded', async () => {
    const harness = propertyResource<number>()
    const events: readonly ResourceEvent[] = [
      { kind: 'fetch-start' },
      { kind: 'fetch-resolve', value: 42 },
    ]
    await applyEventsLive(harness, events)
    const state = harness.graph.read(harness.handle.node)
    expect(state.state).toBe('loaded')
    if (state.state === 'loaded') {
      expect(state.value).toBe(42)
    }
  })

  it('fetch-start → fetch-reject transitions to errored', async () => {
    const harness = propertyResource<number>()
    const events: readonly ResourceEvent[] = [
      { kind: 'fetch-start' },
      { kind: 'fetch-reject', error: 'boom' },
    ]
    await applyEventsLive(harness, events)
    const state = harness.graph.read(harness.handle.node)
    expect(state.state).toBe('errored')
  })

  it('full lifecycle: idle → loading → loaded → stale', async () => {
    const harness = propertyResource<number>()
    await applyEventsLive(harness, [
      { kind: 'fetch-start' },
      { kind: 'fetch-resolve', value: 7 },
      { kind: 'invalidate' },
    ])
    const state = harness.graph.read(harness.handle.node)
    expect(state.state).toBe('stale')
  })

  it('chart-illegal fail() events are swallowed (not crashing)', async () => {
    const harness = propertyResource<number>()
    // fail() from idle is forbidden — should not throw out of the
    // helper.
    await expect(
      applyEventsLive(harness, [{ kind: 'fail', error: 'forbidden' }]),
    ).resolves.toBeUndefined()
    expect(harness.graph.read(harness.handle.node).state).toBe('idle')
  })

  it('empty event sequence leaves the resource at idle', async () => {
    const harness = propertyResource<number>()
    await applyEventsLive(harness, [])
    expect(harness.graph.read(harness.handle.node).state).toBe('idle')
  })
})

describe('applyConflictEventsLive — drives live ConflictRegistry (#578)', () => {
  it('raise events surface conflicts in the registry', () => {
    const harness = propertyConflict<number>()
    const events: readonly ConflictEvent[] = [
      { kind: 'raise', id: 'c1' },
      { kind: 'raise', id: 'c2' },
    ]
    applyConflictEventsLive(harness, events, { target: 't', value: 1 })
    const conflicts = harness.registry.read(harness.graph)
    expect(conflicts).toHaveLength(2)
    for (const c of conflicts) {
      expect(c.kind).toBe('open')
    }
  })

  it('raise then resolve transitions Open → Resolved', () => {
    const harness = propertyConflict<number>()
    applyConflictEventsLive(
      harness,
      [
        { kind: 'raise', id: 'c1' },
        { kind: 'resolve', id: 'c1' },
      ],
      { target: 't', value: 99 },
    )
    const conflicts = harness.registry.read(harness.graph)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('resolved')
  })

  it('forbidden transitions are swallowed (resolve on unknown id)', () => {
    const harness = propertyConflict<number>()
    // Resolve before raise — chart-illegal. The helper swallows the
    // ForbiddenConflictTransitionError and continues processing.
    applyConflictEventsLive(
      harness,
      [
        { kind: 'resolve', id: 'never-raised' },
        { kind: 'raise', id: 'c1' },
      ],
      { target: 't', value: 1 },
    )
    const conflicts = harness.registry.read(harness.graph)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.id).toBe('c1')
  })

  it('supersede uses bySupersedingId from event when supplied', () => {
    const harness = propertyConflict<number>()
    applyConflictEventsLive(
      harness,
      [
        { kind: 'raise', id: 'c1' },
        { kind: 'supersede', id: 'c1', bySupersedingId: 'c2-replacement' },
      ],
      { target: 't', value: 1 },
    )
    const conflicts = harness.registry.read(harness.graph)
    const c = conflicts[0]
    expect(c?.kind).toBe('superseded')
    if (c?.kind === 'superseded') {
      expect(c.supersededBy).toBe('c2-replacement')
    }
  })
})

describe('preserveLoadingEpisode / preserveOpenPriming — generic Arbitrary transformers (#578)', () => {
  it('preserveLoadingEpisode is a generic Arbitrary -> Arbitrary transform', () => {
    const arb = fc.integer()
    const preserved = preserveLoadingEpisode(arb)
    // The transform passes through today (default fast-check
    // shrinker is sufficient). Future PRs add a custom shrink
    // function; the API contract is the generic signature.
    expect(preserved).toBeDefined()
    // Sample to verify it produces values of the same type.
    const samples = fc.sample(preserved, 5)
    for (const s of samples) {
      expect(typeof s).toBe('number')
    }
  })

  it('preserveOpenPriming is a generic Arbitrary -> Arbitrary transform', () => {
    const arb = fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 })
    const preserved = preserveOpenPriming(arb)
    expect(preserved).toBeDefined()
    const samples = fc.sample(preserved, 5)
    for (const s of samples) {
      expect(Array.isArray(s)).toBe(true)
    }
  })
})
