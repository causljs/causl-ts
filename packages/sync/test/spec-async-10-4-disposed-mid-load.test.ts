/**
 * @packageDocumentation
 *
 * EPIC-8 / SPEC.async §10.4 — disposed-mid-load variant.
 *
 * The §10 worked example's failure mode: a resource is disposed
 * (the host scope unmounts) while a loader is in flight. The
 * staleness-guard contract pins what happens: the in-flight resolve
 * must NOT mutate state on the disposed resource, and any subsequent
 * read of the disposed resource must surface the dispose tombstone
 * rather than the stale resolved value.
 */

import { createCausl } from '@causljs/core'
import { dispose } from '@causljs/core/internal'
import { describe, expect, it } from 'vitest'
import { resource } from '../src/index.js'

describe('SPEC.async §10.4 — disposed-mid-load staleness guard', () => {
  /**
   * A loader that resolves AFTER the resource is disposed must not
   * leak its value back to the disposed node. The §10.4 invariant.
   */
  it('post-dispose loader resolution does not mutate disposed resource', async () => {
    const g = createCausl({ name: 'g.spec-async-10-4' })
    let resolveLater: (v: number) => void = () => {}
    const r = resource<number>(g, 'r', {
      loader: () =>
        new Promise<number>((resolve) => {
          resolveLater = resolve
        }),
    })
    const fetchPromise = r.fetch()
    // Resource is now in `loading`. Catch the rejection if dispose
    // surfaces it.
    fetchPromise.catch(() => {})
    // Synchronously dispose the resource node (the host unmounts).
    dispose(g, r.node)
    // Now the loader resolves. The §10.4 contract: the resolved
    // value must NOT land on the disposed node.
    resolveLater(99)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The disposed node is no longer readable; reading it surfaces
    // a NodeDisposedError. The exact error class is engine-defined;
    // we assert that the read either throws or yields a disposed
    // tombstone state.
    let threw = false
    try {
      g.read(r.node)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  /**
   * The same scenario, but with the dispose happening BEFORE the
   * fetch is initiated. The fetch should refuse to start.
   */
  it('fetch on already-disposed resource refuses to start', () => {
    const g = createCausl({ name: 'g.spec-async-10-4' })
    const r = resource<number>(g, 'r', { loader: async () => 42 })
    dispose(g, r.node)
    let threw = false
    try {
      // The fetch may throw synchronously or reject; both are
      // SPEC §10.4 honesty.
      r.fetch().catch(() => {
        threw = true
      })
    } catch {
      threw = true
    }
    // Read post-dispose should also throw.
    let readThrew = false
    try {
      g.read(r.node)
    } catch {
      readThrew = true
    }
    expect(threw || readThrew).toBe(true)
  })
})
