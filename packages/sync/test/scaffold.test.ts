/**
 * @packageDocumentation
 *
 * Smoke test verifying the `@causljs/sync` package barrel is wired up
 * and ships a version placeholder. Acts as the canary for the package
 * scaffolding so that build or export-mapping regressions surface
 * immediately rather than only when a downstream test imports a real
 * symbol.
 */

import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

/**
 * Suite exercising the package scaffolding and exported metadata.
 */
describe('@causljs/sync scaffolding', () => {
  /**
   * Confirms the barrel exports a string-typed `VERSION` constant.
   */
  it('exports a version placeholder', () => {
    // Assert: VERSION is exported and is of type string.
    expect(typeof VERSION).toBe('string')
  })
})
