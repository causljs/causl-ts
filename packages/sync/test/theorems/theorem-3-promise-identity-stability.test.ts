/**
 * @packageDocumentation
 *
 * SPEC.async §3.1 Theorem 3 — Promise identity stability.
 *
 * "Reading a resource at two different points within the same
 * Loaded lifetime yields the same value tuple. The Promise's
 * resolved value is stable until the next state transition."
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { resource } from '../../src/index.js'

describe('SPEC.async §3.1 Theorem 3 — Promise identity stability', () => {
  it('repeated reads in the same Loaded state see the same value', async () => {
    const g = createCausl({ name: 'g.theorem-3' })
    const r = resource<number>(g, 'r', { loader: async () => 99 })
    await r.fetch()
    const v1 = g.read(r.node)
    const v2 = g.read(r.node)
    const v3 = g.read(r.node)
    expect(v1).toEqual(v2)
    expect(v2).toEqual(v3)
  })

  it('value remains stable across reads until invalidate / fail', async () => {
    const g = createCausl({ name: 'g.theorem-3' })
    const r = resource<number>(g, 'r', { loader: async () => 1 })
    await r.fetch()
    const before = g.read(r.node)
    // Many reads, no mutators — state is invariant.
    for (let i = 0; i < 10; i++) {
      const v = g.read(r.node)
      expect(v).toEqual(before)
    }
  })
})
