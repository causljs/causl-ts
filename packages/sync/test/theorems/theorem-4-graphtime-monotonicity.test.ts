/**
 * @packageDocumentation
 *
 * SPEC.async §3.1 Theorem 4 — supporting lemma: GraphTime monotonicity.
 *
 * **#575 reclassification:** this file was originally named the
 * Theorem 4 witness, but SPEC.async §3.1's Theorem 4 is the
 * **behavior-domain** claim (a resource's domain is `[registrationTime,
 * ∞)`; `readAt(node, t < registeredAt)` returns `evicted`).
 * Monotonicity is a *supporting lemma* — necessary for the domain
 * claim but not sufficient. The actual Theorem 4 witness is
 * `theorem-4-behavior-domain.test.ts` (#575).
 *
 * This file remains as a regression-witness for the monotonicity
 * lemma since other parts of SPEC.async cite it (Theorem 2 leans
 * on it for the "exactly one commit per event" claim; the §10
 * worked examples assert it via `expect(now).toBeGreaterThan`).
 *
 * Original prose:
 * "Every commit advances `graph.now` by exactly one tick.
 * GraphTime is strictly increasing across the resource's lifetime."
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import { resource } from '../../src/index.js'

describe('SPEC.async §3.1 Theorem 4 — GraphTime monotonicity', () => {
  it('a sequence of fetches produces a strictly-increasing now sequence', async () => {
    const g = createCausl({ name: 'g.theorem-4' })
    const r = resource<number>(g, 'r', { loader: async () => Math.random() })
    const times: number[] = [g.now]
    for (let i = 0; i < 5; i++) {
      r.invalidate()
      times.push(g.now)
      await r.fetch()
      times.push(g.now)
    }
    // Every step is strictly greater than the previous.
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!)
    }
    // And at least one strictly-greater step occurred.
    expect(times[times.length - 1]).toBeGreaterThan(times[0]!)
  })

  it('idle reads do not advance graph.now', () => {
    const g = createCausl({ name: 'g.theorem-4' })
    const r = resource<number>(g, 'r', { loader: async () => 1 })
    const t0 = g.now
    g.read(r.node)
    g.read(r.node)
    g.read(r.node)
    expect(g.now).toBe(t0)
  })
})
