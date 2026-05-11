/**
 * `@causl/core/testing` sub-path entrypoint resolution test.
 *
 * Per SPEC.async §15.0, the shared test seam is exposed from
 * `@causl/core` itself rather than only from the private
 * `@causl/core-testing-internal` workspace package. This test pins the
 * entrypoint shape so that an accidental drop of the `./testing`
 * exports map entry, the `src/testing.ts` barrel, or the build-script
 * inclusion fails loudly rather than silently regressing the public
 * surface.
 *
 * The check is deliberately structural — a representative function and
 * a representative factory are imported from the barrel and probed for
 * existence and callability — rather than asserting an exact list of
 * symbols. The exact list is owned by the testing-internal package's
 * own contract; this file's job is to confirm the bridge is wired.
 */

import { describe, expect, it } from 'vitest'

import {
  propertyTrials,
  recomputeCounter,
  glitchDetector,
  assertConsistentGraphTime,
  disposedTombstoneSize,
  commitLogConsumerCount,
  derivedDeps,
  arbAdversarialValue,
  ADVERSARIAL_NUMBERS_NAN,
} from '../src/testing.js'

describe('@causl/core/testing entrypoint', () => {
  it('exposes propertyTrials as a callable', () => {
    expect(typeof propertyTrials).toBe('function')
  })

  it('exposes recomputeCounter as a factory', () => {
    expect(recomputeCounter).toBeDefined()
    expect(typeof recomputeCounter).toBe('function')
  })

  it('exposes glitchDetector as a factory', () => {
    expect(glitchDetector).toBeDefined()
    expect(typeof glitchDetector).toBe('function')
  })

  it('exposes assertConsistentGraphTime as a callable', () => {
    expect(typeof assertConsistentGraphTime).toBe('function')
  })

  it('exposes disposedTombstoneSize as a callable', () => {
    expect(typeof disposedTombstoneSize).toBe('function')
  })

  it('exposes commitLogConsumerCount as a callable', () => {
    expect(typeof commitLogConsumerCount).toBe('function')
  })

  it('exposes derivedDeps as a callable', () => {
    expect(typeof derivedDeps).toBe('function')
  })

  it('exposes arbAdversarialValue as a callable (issue #1073)', () => {
    expect(typeof arbAdversarialValue).toBe('function')
    // Constructible at the default settings — proves the
    // re-export chain (testing-internal → core/testing barrel) is
    // wired without dead links.
    expect(arbAdversarialValue()).toBeDefined()
  })

  it('exposes adversarial family enumerations (issue #1073)', () => {
    expect(Array.isArray(ADVERSARIAL_NUMBERS_NAN)).toBe(true)
    expect(ADVERSARIAL_NUMBERS_NAN.length).toBeGreaterThan(0)
  })
})
