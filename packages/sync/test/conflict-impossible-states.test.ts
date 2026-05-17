/**
 * @packageDocumentation
 *
 * SPEC §9 conformance for the {@link Conflict} discriminated union
 * (issue #263). The previous shape — `{ status, resolution? }` —
 * permitted representations the conflict statechart forbids:
 * `{ status: 'open', resolution: ... }` (open variant carrying a
 * resolution) and `{ status: 'resolved' /* missing resolution *\/ }`
 * (resolved variant missing the payload). Reshaping `Conflict<T>` as
 * a tagged union keyed on `kind` makes those impossible states
 * unrepresentable.
 *
 * This file is the "make impossible states impossible" gate: every
 * `@ts-expect-error` line below must surface a `tsc` error in the
 * shipped union — if it doesn't, the suite fails because the comment
 * itself becomes an unused-suppression error.
 *
 * The suite also includes runtime assertions that exercise legal
 * variants and confirm the per-variant payloads match the statechart.
 *
 * @see docs/lifecycle.md §1 — composite chart, Conflict region
 * @see SPEC.md §9 — make impossible states impossible
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '@causljs/core'
import {
  createConflictRegistry,
  singleConflictWhen,
  type Conflict,
} from '../src/index.js'

/**
 * Compile-time probe set. Each function constructs a literal of one
 * variant and the `@ts-expect-error` lines flag fields the discriminator
 * proves are absent (or required) on that tag.
 *
 * The functions are never called at runtime — `tsc` checks them; if
 * any `@ts-expect-error` becomes unnecessary (i.e. the impossible
 * state is no longer rejected) the suppression itself errors and the
 * suite fails to compile, which is the failure mode we want.
 */
function _impossibleStateProbes(): void {
  // Legal: open variant — only the four common members plus the kind tag.
  const _open: Conflict<number> = {
    kind: 'open',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
  }
  void _open

  // Illegal: open + resolution. The discriminator excludes
  // `resolution` from the open variant entirely.
  const _openWithResolution: Conflict<number> = {
    kind: 'open',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    // @ts-expect-error — `resolution` is not a member of the `open` variant.
    resolution: { choice: 'whatever' },
  }
  void _openWithResolution

  // Illegal: open + supersededBy. Linkage lives only on the
  // `superseded` variant.
  const _openWithSupersededBy: Conflict<number> = {
    kind: 'open',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    // @ts-expect-error — `supersededBy` is not a member of the `open` variant.
    supersededBy: 'c2',
  }
  void _openWithSupersededBy

  // Legal: resolved variant — must carry resolution and resolvedAt.
  const _resolved: Conflict<number> = {
    kind: 'resolved',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    resolution: { choice: 'accept' },
    resolvedAt: 1,
  }
  void _resolved

  // Illegal: resolved without `resolution`. The discriminator requires
  // it on this variant.
  // @ts-expect-error — `resolution` is required on the `resolved` variant.
  const _resolvedMissingResolution: Conflict<number> = {
    kind: 'resolved',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    resolvedAt: 1,
  }
  void _resolvedMissingResolution

  // Illegal: resolved without `resolvedAt`. The discriminator requires
  // the GraphTime stamp.
  // @ts-expect-error — `resolvedAt` is required on the `resolved` variant.
  const _resolvedMissingResolvedAt: Conflict<number> = {
    kind: 'resolved',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    resolution: { choice: 'accept' },
  }
  void _resolvedMissingResolvedAt

  // Legal: ignored variant — carries the suppression GraphTime, no
  // resolution.
  const _ignored: Conflict<number> = {
    kind: 'ignored',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    ignoredAt: 2,
  }
  void _ignored

  // Illegal: ignored + resolution. The ignored variant has no
  // resolution member; supplying one is a structural error.
  const _ignoredWithResolution: Conflict<number> = {
    kind: 'ignored',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    ignoredAt: 2,
    // @ts-expect-error — `resolution` is not a member of the `ignored` variant.
    resolution: { choice: 'accept' },
  }
  void _ignoredWithResolution

  // Legal: superseded variant — carries supersededBy + supersededAt.
  const _superseded: Conflict<number> = {
    kind: 'superseded',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    supersededBy: 'c2',
    supersededAt: 3,
  }
  void _superseded

  // Illegal: superseded without `supersededBy`.
  // @ts-expect-error — `supersededBy` is required on the `superseded` variant.
  const _supersededMissingLinkage: Conflict<number> = {
    kind: 'superseded',
    id: 'c1',
    target: 't1',
    value: 1,
    raisedAt: 0,
    supersededAt: 3,
  }
  void _supersededMissingLinkage

  // Exhaustiveness probe: switching on `kind` and handling all four
  // tags type-checks. Removing one arm breaks `assertNever`-style
  // exhaustiveness; we don't import `assertNever` here because the
  // probe's job is to confirm the union shape, not to re-test the
  // helper. Implementation files do call assertNever in their default
  // arms.
  function _exhaustive(c: Conflict<unknown>): string {
    switch (c.kind) {
      case 'open':
        return 'open'
      case 'resolved':
        return `resolved:${String(c.resolvedAt)}`
      case 'ignored':
        return `ignored:${String(c.ignoredAt)}`
      case 'superseded':
        return `superseded:${c.supersededBy}`
    }
  }
  void _exhaustive
}
void _impossibleStateProbes

/**
 * Runtime suite — confirms the registry produces only legal variants
 * for each lifecycle state, and that the per-variant fields the
 * discriminator promises are populated correctly.
 */
describe('Conflict<T> discriminated union — SPEC §9 conformance (#263)', () => {
  /**
   * Build a tiny harness raising one conflict on demand.
   */
  function harness() {
    const graph = createCausl()
    const source = graph.input('src', 'safe')
    const conflictId = 'c'
    const registry = createConflictRegistry<unknown>(graph, {
      id: 'reg',
      compute: singleConflictWhen<string>(
        source,
        (v) => v === 'toxic',
        () => ({ id: conflictId, target: 'src' }),
      ),
    })
    return {
      graph,
      registry,
      conflictId,
      raise: () => graph.commit('raise', (tx) => tx.set(source, 'toxic')),
    }
  }

  /**
   * Open variant has exactly the common members plus `kind: 'open'` —
   * no `resolution`, no `supersededBy`, no `ignoredAt`/`resolvedAt`/
   * `supersededAt`.
   */
  it('open variant exposes only the common members and the kind tag', () => {
    const { graph, registry, raise } = harness()
    raise()
    const c = registry.read(graph)[0]!
    expect(c.kind).toBe('open')
    expect('resolution' in c).toBe(false)
    expect('resolvedAt' in c).toBe(false)
    expect('ignoredAt' in c).toBe(false)
    expect('supersededBy' in c).toBe(false)
    expect('supersededAt' in c).toBe(false)
  })

  /**
   * Resolved variant carries `resolution` and `resolvedAt`. The
   * resolution payload is the exact value the caller supplied.
   */
  it('resolved variant carries the resolution payload and resolvedAt', () => {
    const { graph, registry, raise, conflictId } = harness()
    raise()
    registry.resolve(graph, conflictId, { choice: 'accept' })
    const c = registry.read(graph)[0]!
    expect(c.kind).toBe('resolved')
    if (c.kind !== 'resolved') throw new Error('unreachable')
    expect(c.resolution).toEqual({ choice: 'accept' })
    expect(typeof c.resolvedAt).toBe('number')
  })

  /**
   * Ignored variant carries `ignoredAt`; no resolution leaks onto it.
   */
  it('ignored variant carries ignoredAt and exposes no resolution member', () => {
    const { graph, registry, raise, conflictId } = harness()
    raise()
    registry.ignore(graph, conflictId)
    const c = registry.read(graph)[0]!
    expect(c.kind).toBe('ignored')
    if (c.kind !== 'ignored') throw new Error('unreachable')
    expect(typeof c.ignoredAt).toBe('number')
    expect('resolution' in c).toBe(false)
  })

  /**
   * Superseded variant carries `supersededBy` (the linkage that used
   * to be lost) and `supersededAt`.
   */
  it('superseded variant exposes the linkage and supersededAt — closes the #263 information-loss bug', () => {
    const { graph, registry, raise, conflictId } = harness()
    raise()
    registry.supersede(graph, conflictId, 'replacement-id')
    const c = registry.read(graph)[0]!
    expect(c.kind).toBe('superseded')
    if (c.kind !== 'superseded') throw new Error('unreachable')
    expect(c.supersededBy).toBe('replacement-id')
    expect(typeof c.supersededAt).toBe('number')
  })
})
