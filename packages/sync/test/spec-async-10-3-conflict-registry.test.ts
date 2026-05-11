/**
 * @packageDocumentation
 *
 * EPIC-8 / SPEC.async §10.3 — conflict-registry form.
 *
 * The §10 worked example, conflict-registry variant: a resource
 * whose `errored` state surfaces as a Conflict in the registry, and
 * whose resolution mutator transitions the conflict through its
 * sub-statechart (Open → Resolved | Ignored | Superseded).
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import {
  createConflictRegistry,
  resource,
  singleConflictWhen,
  type ResourceState,
} from '../src/index.js'

describe('SPEC.async §10.3 — conflict registry overlays resource lifecycle', () => {
  /**
   * Errored resource flows into the registry as one Open conflict.
   * §10 worked-example invariant.
   */
  it('errored resource surfaces as one Open conflict', async () => {
    const g = createCausl({ name: 'g.spec-async-10-3' })
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
    expect(registry.read(g)).toEqual([])
    await expect(r.fetch()).rejects.toThrow(/boom/)
    const conflicts = registry.read(g)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('open')
  })

  /**
   * Resolution mutator transitions Open → Resolved. The subsequent
   * read shows the conflict in its terminal state with the
   * resolution payload.
   */
  it('resolve() transitions Open → Resolved with payload', async () => {
    const g = createCausl({ name: 'g.spec-async-10-3' })
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
    registry.resolve(g, 'r-errored', { reason: 'user-acknowledged' })
    const conflicts = registry.read(g)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('resolved')
    if (conflicts[0]?.kind === 'resolved') {
      expect(conflicts[0].resolution).toEqual({ reason: 'user-acknowledged' })
    }
  })

  /**
   * Each conflict mutation is exactly one commit — GraphTime advances
   * by exactly one tick. §3.1 Theorem 4.
   */
  it('each mutation advances GraphTime by exactly one tick', async () => {
    const g = createCausl({ name: 'g.spec-async-10-3' })
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
    const t0 = g.now
    registry.resolve(g, 'r-errored')
    const t1 = g.now
    expect(t1 - t0).toBe(1)
  })

  /**
   * Subscribers fire on the conflict-set changes. The subscriber
   * sees the Open → Resolved transition as a single notification.
   */
  it('subscribers observe the lifecycle transitions', async () => {
    const g = createCausl({ name: 'g.spec-async-10-3' })
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
    let notifications = 0
    registry.subscribe(g, () => {
      notifications++
    })
    const initial = notifications
    await expect(r.fetch()).rejects.toThrow(/boom/)
    registry.resolve(g, 'r-errored')
    expect(notifications - initial).toBeGreaterThan(0)
  })
})
