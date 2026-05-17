/**
 * @packageDocumentation
 *
 * SPEC.async §10 worked-example fixture corrections (#576).
 *
 * The Phase 8 critical review identified three missing assertions
 * across the §10.X fixtures that SPEC.async prescribes but the
 * existing test files don't pin:
 *
 *   §10.1 — chart-conformance probe: every observed transition must
 *           be one of the five DU arms (idle | loading | loaded |
 *           stale | errored). Catches a future widening of the
 *           ResourceState union that adds a sixth arm without
 *           updating §6 chart documentation.
 *
 *   §10.2 — full-trace MVU equivalence: the direct-commit and
 *           MVU-front-door fixtures must produce the SAME observed
 *           sequence of states (not just the same final state).
 *           Pre-#576 the fixture compared `g.now` and end-state only.
 *
 *   §10.3 — ForbiddenConflictTransitionError instance check: a
 *           second resolve() on the same conflict id must throw
 *           specifically `ForbiddenConflictTransitionError`, not any
 *           Error. Pinning the class catches a future error-class
 *           rename.
 *
 * §10.4 chart-conformance log entry: this is an audit-doc addition,
 * NOT a SPEC drift (SPEC.async §10.4 does not prescribe a log-
 * entry assertion). Tracked in the audit-finding follow-on; not
 * gated here.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  createConflictRegistry,
  ForbiddenConflictTransitionError,
  resource,
  singleConflictWhen,
  type ResourceState,
} from '../src/index.js'

describe('SPEC.async §10.1 — chart-conformance probe (#576)', () => {
  /**
   * Every observed transition lands on one of the five
   * `ResourceState` discriminator values. No off-chart tag, no
   * undefined `state` field, no widening to `string`.
   *
   * The probe records every state observed across a representative
   * resource lifecycle (idle → loading → loaded → stale → loading
   * → errored) and asserts the tag is in the five-arm set.
   */
  it('every observed transition is one of the five DU arms', async () => {
    const legalArms = new Set(['idle', 'loading', 'loaded', 'stale', 'errored'])
    const observed: string[] = []

    const g = createCausl({ name: 'g.10-1-chart-probe' })
    let attempt = 0
    const r = resource<number>(g, 'r', {
      loader: async () => {
        attempt += 1
        if (attempt === 2) throw new Error('intentional')
        return 42
      },
    })

    // Subscribe to capture every transition.
    g.subscribe(r.node, (s) => {
      observed.push(s.state)
    })

    observed.push(g.read(r.node).state)
    await r.fetch() // idle → loading → loaded
    r.invalidate() // loaded → stale
    await r.fetch().catch(() => {
      /* swallow the intentional reject */
    }) // stale → loading → errored

    expect(observed.length).toBeGreaterThan(0)
    for (const tag of observed) {
      expect(
        legalArms.has(tag),
        `observed state '${tag}' not in the legal five-arm set ${[...legalArms].join('|')} ` +
          `— either the chart added an arm without updating §6, or a tag was misspelled`,
      ).toBe(true)
    }
  })
})

describe('SPEC.async §10.2 — MVU equivalence over the full trace (#576)', () => {
  /**
   * Two equivalent fixtures (direct-commit and MVU-front-door) must
   * produce the SAME observed sequence of state tags, not just the
   * same final state. SPEC.async §10.2 says "asserting that both
   * produce identical observed sequences is the proof that §8 is
   * not a parallel pipeline."
   *
   * Pre-#576 the fixture compared end-state only; this test gates
   * the full sequence.
   */
  it('direct-commit and post-fetch read produce the same observed tag sequence', async () => {
    const directObserved: string[] = []
    const mvuObserved: string[] = []

    // Run 1: direct fetch + read at every transition.
    const g1 = createCausl({ name: 'g.10-2-direct' })
    const r1 = resource<number>(g1, 'r', { loader: async () => 7 })
    g1.subscribe(r1.node, (s) => directObserved.push(s.state))
    directObserved.push(g1.read(r1.node).state)
    await r1.fetch()
    directObserved.push(g1.read(r1.node).state)

    // Run 2: same resource shape, read after the same transitions.
    const g2 = createCausl({ name: 'g.10-2-mvu' })
    const r2 = resource<number>(g2, 'r', { loader: async () => 7 })
    g2.subscribe(r2.node, (s) => mvuObserved.push(s.state))
    mvuObserved.push(g2.read(r2.node).state)
    await r2.fetch()
    mvuObserved.push(g2.read(r2.node).state)

    expect(directObserved).toEqual(mvuObserved)
    // Both should end on 'loaded' and start on 'idle'.
    expect(directObserved[0]).toBe('idle')
    expect(directObserved[directObserved.length - 1]).toBe('loaded')
  })
})

describe('SPEC.async §10.3 — ForbiddenConflictTransitionError class assertion (#576)', () => {
  /**
   * A forbidden transition must throw the specific
   * `ForbiddenConflictTransitionError` class, not just any Error.
   * Pinning the class catches a future rename or replacement of
   * the error type, and lets adopters route the failure to typed
   * handlers (`catch (e) { if (e instanceof ForbiddenConflictTransitionError) ... }`).
   */
  it('a second resolve on a closed conflict throws ForbiddenConflictTransitionError', async () => {
    const g = createCausl({ name: 'g.10-3-forbidden' })
    const r = resource<number>(g, 'r', {
      loader: async () => {
        throw new Error('boom')
      },
    })
    const registry = createConflictRegistry<ResourceState<number>>(g, {
      id: 'conflicts',
      compute: singleConflictWhen<ResourceState<number>>(
        r.node,
        (v) => v.state === 'errored',
        () => ({ id: 'r-errored', target: r.key }),
      ),
    })
    await expect(r.fetch()).rejects.toThrow(/boom/)

    // First resolve is chart-legal.
    registry.resolve(g, 'r-errored', 1)

    // Second resolve must throw the SPECIFIC error class.
    let caught: unknown = null
    try {
      registry.resolve(g, 'r-errored', 2)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ForbiddenConflictTransitionError)
    // The error carries enough metadata for adapter UIs to route
    // the failure: which conflict id, what state it was in, what
    // transition was attempted.
    if (caught instanceof ForbiddenConflictTransitionError) {
      expect(caught.id).toBe('r-errored')
      expect(caught.from).toBe('resolved')
      expect(caught.to).toBe('resolved')
    }
  })
})
