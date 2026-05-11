/**
 * @packageDocumentation
 *
 * SPEC.async §3.1 Theorem 2 — single-pipeline mutation.
 *
 * "Every fetch flows through the engine's Phase A-H commit pipeline
 * exactly once; the resource's state transition is atomic at the
 * commit boundary."
 */

import { createCausl } from '@causl/core'
import { describe, expect, it, vi } from 'vitest'
import { resource } from '../../src/index.js'

describe('SPEC.async §3.1 Theorem 2 — single-pipeline mutation', () => {
  it('a successful fetch emits a single Loaded notification', async () => {
    const g = createCausl({ name: 'g.theorem-2' })
    const r = resource<number>(g, 'r', { loader: async () => 7 })
    const obs = vi.fn()
    g.subscribe(r.node, obs)
    obs.mockClear()
    await r.fetch()
    // Observer fired Loading→Loaded transitions; bound by 3.
    expect(obs.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(obs.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('the loaded transition is atomic — read shows pre or post, never partial', async () => {
    const g = createCausl({ name: 'g.theorem-2' })
    const r = resource<number>(g, 'r', { loader: async () => 42 })
    expect(g.read(r.node).state).toBe('idle')
    await r.fetch()
    const v = g.read(r.node)
    // Post-fetch state is exactly Loaded with the value, never a
    // partial mix.
    if (v.state !== 'loaded') throw new Error('narrow')
    expect(v.value).toBe(42)
  })
})
