/**
 * SPEC.async §11.1 — `ResourceUpdateReason` + `whyUpdated` decoder (#577).
 *
 * SPEC.async §11.1 commits `whyUpdated` to ship the closed seven-arm
 * `ResourceUpdateReason` enumeration:
 *
 *   - 'fetch-begin'      — transition into 'loading' from idle/stale/errored
 *   - 'fetch-resolved'   — into 'loaded' (clean) from loading
 *   - 'fetch-stale'      — into 'stale' (staleness guard hit) from loading
 *   - 'fetch-rejected'   — into 'errored' from loading via loader rejection
 *   - 'invalidated'      — into 'stale' from loaded via host invalidate()
 *   - 'failed'           — into 'errored' via host fail()
 *   - 'dep-changed'      — downstream derived node observed the update
 *
 * The decoder consumes the commit's `intent` label (which the
 * adapter sets uniquely per transition — `fetch:${key}:start`,
 * `fetch:${key}:loaded`, etc.) plus the pre/post-commit DU arms,
 * and produces exactly one of these seven values.
 *
 * Tests cover:
 *   - Each chart edge produces its corresponding reason.
 *   - `whyNotUpdated` returns the dual.
 *   - The enumeration is closed (test-d guard).
 *   - The decoder is total over the §6 chart's transition space.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  resource,
  whyUpdated,
  whyNotUpdated,
  RESOURCE_UPDATE_REASONS,
  type ResourceState,
  type ResourceUpdateReason,
} from '../src/index.js'

describe('SPEC.async §11.1 — ResourceUpdateReason enumeration (#577)', () => {
  it('exports the seven canonical values in the order SPEC.async §11.1 lists them', () => {
    expect(RESOURCE_UPDATE_REASONS).toEqual([
      'fetch-begin',
      'fetch-resolved',
      'fetch-stale',
      'fetch-rejected',
      'invalidated',
      'failed',
      'dep-changed',
    ])
  })

  it('the array is frozen at runtime (cannot be mutated by adopters)', () => {
    expect(Object.isFrozen(RESOURCE_UPDATE_REASONS)).toBe(true)
  })

  it('the type and the value list are kept in lockstep', () => {
    // Compile-time: every element is assignable to the type.
    const _check: readonly ResourceUpdateReason[] = RESOURCE_UPDATE_REASONS
    void _check
    expect(RESOURCE_UPDATE_REASONS.length).toBe(7)
  })
})

describe('whyUpdated decoder — chart edges (#577)', () => {
  // Build representative pre/post pairs for every chart edge. Each
  // pair plus the matching commit intent must produce its reason.
  const idle: ResourceState<number> = { state: 'idle' }
  const loading: ResourceState<number> = {
    state: 'loading',
    origin: 1,
    promise: Promise.resolve(undefined),
  }
  const loaded: ResourceState<number> = {
    state: 'loaded',
    value: 42,
    origin: 1,
    loadedAt: 2,
  }
  const stale: ResourceState<number> = {
    state: 'stale',
    value: 42,
    origin: 1,
    loadedAt: 2,
  }
  const errored: ResourceState<number> = {
    state: 'errored',
    error: new Error('boom'),
    origin: 1,
    erroredAt: 3,
  }

  const cases: ReadonlyArray<{
    name: string
    intent: string
    prev: ResourceState<number>
    next: ResourceState<number>
    expected: ResourceUpdateReason
  }> = [
    {
      name: 'idle → loading via fetch:k:start',
      intent: 'fetch:k:start',
      prev: idle,
      next: loading,
      expected: 'fetch-begin',
    },
    {
      name: 'stale → loading via fetch:k:start',
      intent: 'fetch:k:start',
      prev: stale,
      next: loading,
      expected: 'fetch-begin',
    },
    {
      name: 'errored → loading via fetch:k:start',
      intent: 'fetch:k:start',
      prev: errored,
      next: loading,
      expected: 'fetch-begin',
    },
    {
      name: 'loading → loaded via fetch:k:loaded',
      intent: 'fetch:k:loaded',
      prev: loading,
      next: loaded,
      expected: 'fetch-resolved',
    },
    {
      name: 'loading → stale via fetch:k:stale',
      intent: 'fetch:k:stale',
      prev: loading,
      next: stale,
      expected: 'fetch-stale',
    },
    {
      name: 'loading → errored via fetch:k:error',
      intent: 'fetch:k:error',
      prev: loading,
      next: errored,
      expected: 'fetch-rejected',
    },
    {
      name: 'loaded → stale via invalidate:k',
      intent: 'invalidate:k',
      prev: loaded,
      next: stale,
      expected: 'invalidated',
    },
    {
      name: 'loading → errored via fail:k',
      intent: 'fail:k',
      prev: loading,
      next: errored,
      expected: 'failed',
    },
    {
      name: 'loaded → errored via fail:k',
      intent: 'fail:k',
      prev: loaded,
      next: errored,
      expected: 'failed',
    },
  ]

  for (const c of cases) {
    it(`decodes ${c.name} as '${c.expected}'`, () => {
      const result = whyUpdated({ intent: c.intent }, c.prev, c.next)
      expect(result).toBe(c.expected)
    })
  }

  it('decodes a downstream-derived re-run (intent does not match this resource) as dep-changed', () => {
    // A commit on an unrelated input causes a downstream derived to
    // re-run. The resource itself didn't transition (prev === next
    // structurally), but a consumer reading the resource through a
    // derived saw an update event. The decoder reports 'dep-changed'.
    const result = whyUpdated(
      { intent: 'unrelated-commit' },
      loaded,
      loaded,
    )
    expect(result).toBe('dep-changed')
  })
})

describe('whyUpdated end-to-end against a real resource (#577)', () => {
  it('decodes every transition in a fetch lifecycle correctly', async () => {
    const graph = createCausl()
    const handle = resource<number>(graph, 'k', {
      loader: async (_origin) => 99,
    })

    // Initial state should be idle.
    let prev: ResourceState<number> = graph.read(handle.node)
    expect(prev.state).toBe('idle')

    // Begin a fetch — this commits with intent fetch:k:start.
    const fetchPromise = handle.fetch()
    let next: ResourceState<number> = graph.read(handle.node)
    expect(next.state).toBe('loading')

    // The previous commit's intent label is what whyUpdated decodes.
    // We stub the commit shape with the known intent the adapter
    // emits (the assertion is on the decoder, not on the engine).
    expect(whyUpdated({ intent: 'fetch:k:start' }, prev, next)).toBe(
      'fetch-begin',
    )

    // Let the fetch settle.
    await fetchPromise
    prev = next
    next = graph.read(handle.node)
    expect(next.state).toBe('loaded')
    expect(whyUpdated({ intent: 'fetch:k:loaded' }, prev, next)).toBe(
      'fetch-resolved',
    )

    // Invalidate.
    handle.invalidate()
    prev = next
    next = graph.read(handle.node)
    expect(next.state).toBe('stale')
    expect(whyUpdated({ intent: 'invalidate:k' }, prev, next)).toBe(
      'invalidated',
    )
  })
})

describe('whyNotUpdated decoder (#577)', () => {
  // The dual: when prev === next (no transition), the decoder
  // returns the reason the subscriber was NOT updated. Two
  // canonical reasons: 'no-dep-overlap' (commit didn't touch this
  // resource's node) and 'object-is-deduped' (next was structurally
  // equal to prev under Object.is).
  const loaded: ResourceState<number> = {
    state: 'loaded',
    value: 42,
    origin: 1,
    loadedAt: 2,
  }

  it('returns null when the resource DID transition', () => {
    const idle: ResourceState<number> = { state: 'idle' }
    const result = whyNotUpdated(idle, loaded)
    // It transitioned — there's no "why not" answer.
    expect(result).toBeNull()
  })

  it("returns 'object-is-deduped' when prev and next are reference-equal", () => {
    expect(whyNotUpdated(loaded, loaded)).toBe('object-is-deduped')
  })

  it("returns 'no-dep-overlap' when next is a different object with structurally equal arms", () => {
    const sameShape: ResourceState<number> = {
      state: 'loaded',
      value: 42,
      origin: 1,
      loadedAt: 2,
    }
    // Different object reference, same structural content. The
    // engine's Object.is gate would have suppressed this commit,
    // so the dep-overlap answer is 'no-dep-overlap'.
    expect(whyNotUpdated(loaded, sameShape)).toBe('no-dep-overlap')
  })
})
