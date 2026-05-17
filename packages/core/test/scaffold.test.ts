/**
 * @packageDocumentation
 *
 * Scaffolding sanity check for the `@causl/core` package. Confirms the
 * top-level barrel actually loads and exposes a `VERSION` placeholder, so
 * downstream tests can rely on the module graph being importable before
 * exercising any engine semantics.
 */

import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

/**
 * Verifies the package barrel is wired up and exports the expected
 * scaffolding surface.
 */
describe('@causl/core scaffolding', () => {
  /**
   * The package must export a `VERSION` string placeholder. Type only —
   * the value is not pinned here.
   */
  it('exports a version placeholder', () => {
    // Assert: the exported VERSION is a string (its content is intentionally unconstrained).
    expect(typeof VERSION).toBe('string')
  })
})
