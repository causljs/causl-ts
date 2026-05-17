/**
 * @packageDocumentation
 *
 * Smoke tests for the `@causljs/formula` package scaffolding. These checks
 * confirm the public entry point loads cleanly and exposes the baseline
 * surface (currently the `VERSION` placeholder) before deeper modules are
 * exercised by the other suites in this directory.
 */

import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

/**
 * Top-level scaffolding suite covering the package's bootstrap exports.
 */
describe('@causljs/formula scaffolding', () => {
  /**
   * Asserts the package re-exports a `VERSION` string constant so consumers
   * can perform feature/version detection at runtime.
   */
  it('exports a version placeholder', () => {
    // Confirm the placeholder is wired through the barrel and is a string.
    expect(typeof VERSION).toBe('string')
  })
})
