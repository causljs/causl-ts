/**
 * @packageDocumentation
 *
 * SPEC.async §3.1 Theorem 1 — origin pinning.
 *
 * "A fetch's resolved value lands on exactly the resource node it
 * was issued against. No cross-talk between resources."
 *
 * Tested at the runtime level (sequential and same-graph fetches);
 * the property model in `packages/sync/test/properties/
 * origin-bound-resolution.property.test.ts` covers the random
 * interleaving angle.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { resource } from '../../src/index.js'

describe('SPEC.async §3.1 Theorem 1 — origin pinning', () => {
  it('two resources fetched sequentially each carry their loader value', async () => {
    const g = createCausl({ name: 'g.theorem-1' })
    const a = resource<number>(g, 'a', { loader: async () => 100 })
    const b = resource<number>(g, 'b', { loader: async () => 200 })
    await a.fetch()
    await b.fetch()
    const va = g.read(a.node)
    const vb = g.read(b.node)
    if (va.state !== 'loaded' || vb.state !== 'loaded') throw new Error('narrow')
    expect(va.value).toBe(100)
    expect(vb.value).toBe(200)
  })

  it('a re-fetch on the same resource overwrites its previous value', async () => {
    const g = createCausl({ name: 'g.theorem-1' })
    let counter = 1
    const r = resource<number>(g, 'r', {
      loader: async () => counter++,
    })
    await r.fetch()
    r.invalidate()
    await r.fetch()
    const v = g.read(r.node)
    if (v.state !== 'loaded') throw new Error('narrow')
    expect(v.value).toBe(2)
  })
})
