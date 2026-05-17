/**
 * @packageDocumentation
 *
 * Scaffolding-level smoke test for `@causl/devtools`. Confirms the
 * package exports a `VERSION` string, anchoring the public entry point
 * for the inspection-primitive surface — the engine is meant to be
 * inspectable through its own primitives rather than through a parallel
 * devtools panel, and this package is the data layer those primitives
 * live in. Pinning the entry point lets downstream consumers rely on
 * the package shape before deeper APIs land.
 */

import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

/**
 * Package-level scaffolding contract: the devtools entry point must export
 * an identifiable `VERSION` placeholder so consumers and tooling can
 * detect that the inspection-primitive package is wired before any of its
 * deeper APIs are reached for.
 */
describe('@causl/devtools scaffolding', () => {
  /**
   * `VERSION` is exposed as a string so consumers (and tooling) can
   * introspect the shipped devtools build at runtime.
   */
  it('exports a version placeholder', () => {
    // Assert: the named export resolves to a string value.
    expect(typeof VERSION).toBe('string')
  })
})
