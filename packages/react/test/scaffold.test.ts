/**
 * @packageDocumentation
 *
 * Smoke test for the `@causl/react` package scaffold. Confirms the
 * public entry point is wired up and the build pipeline emits a
 * loadable module by checking for the `VERSION` placeholder export.
 * Acts as the lightest possible canary: if this fails, the package
 * itself failed to assemble.
 */

import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

/**
 * Suite covering minimal scaffolding guarantees of `@causl/react`.
 */
describe('@causl/react scaffolding', () => {
  /**
   * Asserts the package re-exports a string-typed `VERSION` constant.
   * Used as a placeholder until release tooling stamps real versions.
   */
  it('exports a version placeholder', () => {
    // A successful import plus a string typeof is sufficient evidence
    // that the entry point resolves and re-exports the constant.
    expect(typeof VERSION).toBe('string')
  })
})
