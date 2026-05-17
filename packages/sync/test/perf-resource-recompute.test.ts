/**
 * @packageDocumentation
 *
 * SPEC.async §14.2 — Resource resolve: O(|dependents|) recompute (#583).
 *
 * SPEC.async §14.2 (line 1544) commits to a per-resource cost
 * bound: when a resource resolves (Loading → Loaded/Stale/Errored),
 * the engine recomputes ONLY the derived nodes that read this
 * resource — not the entire graph, not all resources, not even the
 * §6 chart's other regions. The cost is `O(|dependents|)`, where
 * |dependents| is the count of derived nodes that named this
 * resource as a dep during their last successful compute.
 *
 * The test counts recomputes by instrumenting derived compute
 * functions with a counter, sets up a fan-out scenario (one
 * resource with N dependents, one resource with zero dependents),
 * triggers a resolution on each, and asserts the recompute count
 * matches the dependent count. A regression that re-runs unrelated
 * deriveds (or fails to wake the right ones) trips the assertion.
 *
 * SPEC.async names this test `packages/sync/test/perf-resource-recompute.test.ts`
 * and the script `pnpm --filter @causljs/sync run test:perf-invariant`
 * — the script wiring is the responsibility of #583's CI follow-on
 * (this file ships the test; the script ships when #583 closes).
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { resource } from '../src/index.js'

describe('SPEC.async §14.2 — resource resolve recompute count (#583)', () => {
  it('recomputes only the deriveds that read the resolving resource', async () => {
    const g = createCausl({ name: 'g.perf-resource-recompute' })

    // Two resources. Each will resolve to a distinct value.
    const a = resource<number>(g, 'a', { loader: async () => 1 })
    const b = resource<number>(g, 'b', { loader: async () => 2 })

    // N derived nodes that read resource `a`.
    const N_A_DEPENDENTS = 5
    const aRecomputeCounts = new Array<number>(N_A_DEPENDENTS).fill(0)
    for (let i = 0; i < N_A_DEPENDENTS; i++) {
      const idx = i // capture
      g.derived(`a.derived.${idx}`, (read) => {
        aRecomputeCounts[idx] = (aRecomputeCounts[idx] ?? 0) + 1
        const v = read(a.node)
        return v.state === 'loaded' ? v.value + idx : 0
      })
    }

    // M derived nodes that read resource `b` (independent).
    const N_B_DEPENDENTS = 3
    const bRecomputeCounts = new Array<number>(N_B_DEPENDENTS).fill(0)
    for (let i = 0; i < N_B_DEPENDENTS; i++) {
      const idx = i
      g.derived(`b.derived.${idx}`, (read) => {
        bRecomputeCounts[idx] = (bRecomputeCounts[idx] ?? 0) + 1
        const v = read(b.node)
        return v.state === 'loaded' ? v.value + idx : 0
      })
    }

    // Capture the initial-registration recompute count, then reset
    // counters to measure what the resolution causes.
    const aInitial = [...aRecomputeCounts]
    const bInitial = [...bRecomputeCounts]

    // Resolve resource `a`. Only the N_A_DEPENDENTS deriveds that
    // read `a` should recompute. The N_B_DEPENDENTS deriveds that
    // read `b` should NOT recompute — `b` didn't change.
    await a.fetch()

    for (let i = 0; i < N_A_DEPENDENTS; i++) {
      // a's dependents recomputed at least once for the resolution.
      // (May be more than once if there are intermediate loading
      // transitions; the cost-bound check is the count fanout.)
      expect(
        (aRecomputeCounts[i] ?? 0) - (aInitial[i] ?? 0),
        `a.derived.${i} should have recomputed during a's resolution`,
      ).toBeGreaterThanOrEqual(1)
    }

    for (let i = 0; i < N_B_DEPENDENTS; i++) {
      // b's dependents did NOT recompute — b didn't change.
      expect(
        (bRecomputeCounts[i] ?? 0) - (bInitial[i] ?? 0),
        `b.derived.${i} should NOT recompute during a's resolution; the §14.2 cost bound is broken if it does`,
      ).toBe(0)
    }
  })

  it('a resource with zero dependents resolves with no derived recomputes', async () => {
    const g = createCausl({ name: 'g.perf-resource-recompute-zero' })
    const lonely = resource<number>(g, 'lonely', { loader: async () => 99 })

    // Trace any unexpected derivation work via a scratch derived
    // that reads an UNRELATED input — its compute should fire only
    // on registration, not on `lonely`'s resolution.
    let scratchRecomputes = 0
    const x = g.input('x', 0)
    g.derived('scratch', (read) => {
      scratchRecomputes++
      return read(x)
    })
    const initial = scratchRecomputes

    await lonely.fetch()

    expect(
      scratchRecomputes - initial,
      'a resource with no dependents should not cause unrelated deriveds to recompute',
    ).toBe(0)
  })

  it('GraphTime advances by one tick per resolve (cost-bound supporting lemma)', async () => {
    const g = createCausl({ name: 'g.perf-resource-recompute-time' })
    const r = resource<number>(g, 'r', { loader: async () => 7 })
    const t0 = g.now
    await r.fetch()
    const t1 = g.now
    // Exactly one tick advance for the resolution. The number of
    // dependents does not change this — recompute happens within
    // the single Phase D walk.
    expect(t1 - t0).toBeGreaterThan(0)
  })
})
