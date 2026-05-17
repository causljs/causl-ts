/**
 * @packageDocumentation
 *
 * Phase 4 review fix locking down the ConflictRegistry sub-statechart,
 * which exposes four statuses (`open`, `resolved`, `ignored`,
 * `superseded`) as one orthogonal region of the composite lifecycle.
 * The earlier suite only covered `open`; this file pins the remaining
 * three transitions and the subscriber emissions accompanying them, so
 * a regression in any one transition is caught.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  createConflictRegistry,
  resource,
  singleConflictWhen,
  type ResourceState,
} from '../src/index.js'

/**
 * Constructs a graph plus a conflict registry whose source resource has
 * already been driven into the `errored` state, leaving exactly one
 * conflict in the `open` status. Used as a shared fixture across
 * transition tests so each case starts from a known baseline.
 */
async function buildErroredRegistry(): Promise<{
  graph: ReturnType<typeof createCausl>
  registry: ReturnType<typeof createConflictRegistry<ResourceState<number>>>
}> {
  const graph = createCausl()
  const r = resource<number>(graph, 'r', {
    loader: async () => {
      throw new Error('nope')
    },
  })
  const registry = createConflictRegistry<ResourceState<number>>(graph, {
    id: 'conflicts',
    compute: singleConflictWhen<ResourceState<number>>(
      r.node,
      (v) => v.state === 'errored',
      () => ({ id: 'r-errored', target: r.key }),
    ),
  })
  await expect(r.fetch()).rejects.toThrow()
  return { graph, registry }
}

/**
 * Suite covering each lifecycle transition out of the `open` status,
 * along with subscriber notification semantics and the no-op rule for
 * unknown conflict ids.
 */
describe('Conflict transitions: open → resolved/ignored/superseded', () => {
  /**
   * Confirms the baseline: after the resource fails, the lone conflict
   * sits in the `open` status before any operator intervention.
   */
  it('starts in `open` after the resource enters errored', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // From-state: errored resource → conflict baseline must be `open`.
    const list = registry.read(graph)
    expect(list[0]?.kind).toBe('open')
  })

  /**
   * Validates the open → resolved transition and that an opaque
   * resolution payload supplied by the caller is preserved.
   */
  it('open → resolved with an opaque resolution payload', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // From-state: open. Event: resolve(id, payload). To-state: resolved with payload retained.
    registry.resolve(graph, 'r-errored', { choice: 'use-cache' })
    const after = registry.read(graph)
    const c = after[0]
    expect(c?.kind).toBe('resolved')
    // Tag-narrowed access — `resolution` exists only on the resolved variant.
    if (c?.kind !== 'resolved') throw new Error('unreachable: kind is resolved')
    expect(c.resolution).toEqual({ choice: 'use-cache' })
  })

  /**
   * Validates the open → ignored transition. The discriminated-union
   * shape rules out a `resolution` field on this variant entirely —
   * the prior "resolution stays undefined" assertion is now a
   * compile-time guarantee, replaced by a tag-shape assertion.
   */
  it('open → ignored carries an ignoredAt GraphTime and no resolution field', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // From-state: open. Event: ignore(id). To-state: ignored.
    registry.ignore(graph, 'r-errored')
    const after = registry.read(graph)
    const c = after[0]
    expect(c?.kind).toBe('ignored')
    if (c?.kind !== 'ignored') throw new Error('unreachable: kind is ignored')
    expect(typeof c.ignoredAt).toBe('number')
    // The `ignored` variant has no `resolution` member at all.
    expect('resolution' in c).toBe(false)
  })

  /**
   * Validates the open → superseded transition triggered by referencing
   * a successor conflict id. The discriminated-union shape now surfaces
   * `supersededBy` on the public read — the field that used to be
   * structurally lost.
   */
  it('open → superseded records the superseding id and supersededAt', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // From-state: open. Event: supersede(id, successor). To-state: superseded.
    registry.supersede(graph, 'r-errored', 'r-errored-v2')
    const after = registry.read(graph)
    const c = after[0]
    expect(c?.kind).toBe('superseded')
    if (c?.kind !== 'superseded') throw new Error('unreachable: kind is superseded')
    expect(c.supersededBy).toBe('r-errored-v2')
    expect(typeof c.supersededAt).toBe('number')
  })

  /**
   * Verifies subscriber sees the legal Open→X transition. The
   * conflict statechart forbids transitions out of terminal states
   * (Resolved / Ignored / Superseded — they have no outgoing edges),
   * so back-to-back resolve → ignore → supersede must succeed only on
   * the first call; the rest throw and leave the registry unchanged.
   * Test updated for EPIC #280 / #271.
   */
  it('subscribers see the first legal Open→X transition; subsequent illegal transitions are rejected', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // Arrange: subscribe and discard the initial snapshot so we observe only post-subscribe transitions.
    const seen: string[] = []
    registry.subscribe(graph, (conflicts) => {
      const kind = conflicts[0]?.kind ?? '(none)'
      seen.push(kind)
    })
    seen.length = 0
    // Act: legal Open → Resolved succeeds.
    registry.resolve(graph, 'r-errored', 'fix')
    // Subsequent transitions out of Resolved are forbidden — the
    // conflict statechart has no edges leaving terminal states.
    expect(() => registry.ignore(graph, 'r-errored')).toThrow(
      /Forbidden conflict transition/,
    )
    expect(() =>
      registry.supersede(graph, 'r-errored', 'next'),
    ).toThrow(/Forbidden conflict transition/)
    // Assert: subscriber recorded only the single legal transition.
    expect(seen).toEqual(['resolved'])
  })

  /**
   * The conflict statechart has no edge from the synthetic `unknown`
   * status to any state. Mutators against an id the registry has never
   * observed must throw, not silently no-op — the previous behaviour
   * masked typos and stale ids in adapter UIs. Test updated for
   * EPIC #280 / #271.
   */
  it('resolving an unknown id throws ForbiddenConflictTransitionError', async () => {
    const { graph, registry } = await buildErroredRegistry()
    // Arrange: snapshot the existing conflict status.
    const before = registry.read(graph)
    // Act + assert: attempt resolve against an id that does not exist.
    expect(() => registry.resolve(graph, 'unknown-id', 'whatever')).toThrow(
      /Forbidden conflict transition/,
    )
    // Assert: existing conflict's kind is unchanged.
    const after = registry.read(graph)
    expect(after[0]?.kind).toBe(before[0]?.kind)
  })
})
