/**
 * @packageDocumentation
 *
 * EPIC-11 / TASK 11.4 — bundle-audit smoke test.
 *
 * Exercises the per-primitive sub-imports the EPIC-11 PR introduced
 * (`@causljs/sync/resource`, `@causljs/sync/conflict`) and asserts they
 * re-export the same symbols as the full barrel. The CI-gated
 * `size-limit` ceilings live in the root `package.json` per
 * SPEC.async §14.2; this file is the runtime smoke test that the
 * sub-imports actually expose what they claim.
 */

import { describe, expect, it } from 'vitest'
import * as fullBarrel from '../src/index.js'
import * as resourceEntry from '../src/resource-entry.js'
import * as conflictEntry from '../src/conflict-entry.js'

describe('SPEC.async §14.2 — bundle audit', () => {
  it('@causljs/sync/resource re-exports the resource primitive', () => {
    expect(typeof resourceEntry.resource).toBe('function')
    expect(resourceEntry.resource).toBe(fullBarrel.resource)
    expect(resourceEntry.ForbiddenResourceTransitionError).toBe(
      fullBarrel.ForbiddenResourceTransitionError,
    )
  })

  it('@causljs/sync/conflict re-exports the conflict primitive', () => {
    expect(typeof conflictEntry.createConflictRegistry).toBe('function')
    expect(conflictEntry.createConflictRegistry).toBe(
      fullBarrel.createConflictRegistry,
    )
    expect(conflictEntry.ForbiddenConflictTransitionError).toBe(
      fullBarrel.ForbiddenConflictTransitionError,
    )
    expect(conflictEntry.singleConflictWhen).toBe(fullBarrel.singleConflictWhen)
  })

  it('the sub-imports do not leak each other (resource entry has no conflict export)', () => {
    expect(
      (resourceEntry as Record<string, unknown>).createConflictRegistry,
    ).toBeUndefined()
  })

  it('the sub-imports do not leak each other (conflict entry has no resource export)', () => {
    expect((conflictEntry as Record<string, unknown>).resource).toBeUndefined()
  })
})
