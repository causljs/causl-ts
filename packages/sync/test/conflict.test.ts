/**
 * @packageDocumentation
 *
 * Tests covering the conflict registry exposed as a derived view over
 * a source node. Confirms the registry produces an empty list when the
 * source sits in an acceptable state, surfaces a single open conflict
 * when the source enters a flagged state, and notifies subscribers as
 * the conflict set changes commit-by-commit.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  createConflictRegistry,
  resource,
  singleConflictWhen,
  type Conflict,
  type ResourceState,
} from '../src/index.js'

/**
 * Suite asserting the conflict registry behaves as a pure derivation
 * of the source node's state, with stable open/closed semantics and
 * subscriber notifications.
 */
describe('Conflict registry as a derived view', () => {
  /**
   * Verifies an empty conflict list when the source resource has not
   * entered the flagged predicate state.
   */
  it('emits no conflicts when the source is in an OK state', () => {
    // Arrange: source resource whose loader succeeds; predicate looks for `errored`.
    const g = createCausl()
    const r = resource<number>(g, 'r', { loader: async () => 1 })
    const registry = createConflictRegistry<ResourceState<number>>(g, {
      id: 'conflicts',
      compute: singleConflictWhen<ResourceState<number>>(
        r.node,
        (v) => v.state === 'errored',
        () => ({ id: 'r-errored', target: r.key }),
      ),
    })
    // Assert: idle source → empty conflict list.
    expect(registry.read(g)).toEqual([])
  })

  /**
   * Verifies that once the source resource lands in `errored`, the
   * registry yields exactly one open conflict targeting that source.
   */
  it('emits one conflict when the source enters a flagged state', async () => {
    // Arrange: source resource whose loader rejects, registry watches for `errored`.
    const g = createCausl()
    const r = resource<number>(g, 'r', {
      loader: async () => {
        throw new Error('nope')
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
    // Act: trigger a fetch that lands the resource into `errored`.
    await expect(r.fetch()).rejects.toThrow()
    // Assert: exactly one conflict, targeting the resource key, status `open`.
    const list = registry.read(g)
    expect(list.length).toBe(1)
    expect(list[0]?.target).toBe(r.key)
    expect(list[0]?.kind).toBe('open')
  })

  /**
   * Verifies subscribers receive an initial fire on subscription and at
   * least one additional fire after a commit changes the conflict set.
   */
  it('subscribers see conflict-set changes per commit', async () => {
    const g = createCausl()
    const r = resource<number>(g, 'r', {
      loader: async () => {
        throw new Error('nope')
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
    // Arrange: capture every emission delivered to the subscriber.
    const fires: Array<readonly Conflict<ResourceState<number>>[]> = []
    registry.subscribe(g, (xs) => fires.push(xs))
    // Assert: subscribing fires once with the current snapshot.
    expect(fires.length).toBe(1) // initial fire on subscribe
    // Act: failed fetch drives idle → loading → errored, growing the conflict set.
    await expect(r.fetch()).rejects.toThrow()
    // Assert: at least one additional fire, with the latest emission carrying the open conflict.
    expect(fires.length).toBeGreaterThanOrEqual(2)
    expect(fires.at(-1)?.length).toBe(1)
  })
})
