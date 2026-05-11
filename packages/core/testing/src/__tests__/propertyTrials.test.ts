import { describe, it, expect } from 'vitest'
import { propertyTrials } from '../propertyTrials.js'

describe('propertyTrials', () => {
  it('defaults to the SPEC §15.2 floor of 1000 runs', () => {
    const cfg = propertyTrials('label')
    expect(cfg.numRuns).toBe(1000)
    expect(cfg.label).toBe('label')
  })

  it('accepts an explicit numRuns at or above the floor', () => {
    expect(propertyTrials('label', { numRuns: 1000 }).numRuns).toBe(1000)
    expect(propertyTrials('label', { numRuns: 5000 }).numRuns).toBe(5000)
  })

  it('throws when numRuns is below the floor without unsafeTrials', () => {
    expect(() => propertyTrials('label', { numRuns: 50 })).toThrow(
      /below the SPEC §15\.2 floor/,
    )
    expect(() => propertyTrials('label', { numRuns: 999 })).toThrow()
  })

  it('allows a sub-floor count via the explicit unsafeTrials escape hatch', () => {
    const cfg = propertyTrials('label', { unsafeTrials: 50 })
    expect(cfg.numRuns).toBe(50)
  })

  it('seeds from CAUSL_FUZZ_SEED env var when present', () => {
    const orig = process.env.CAUSL_FUZZ_SEED
    process.env.CAUSL_FUZZ_SEED = '12345'
    try {
      const cfg = propertyTrials('label')
      expect(cfg.seed).toBe(12345)
    } finally {
      if (orig === undefined) delete process.env.CAUSL_FUZZ_SEED
      else process.env.CAUSL_FUZZ_SEED = orig
    }
  })

  it('uses an explicit seed when provided, ignoring env var', () => {
    const orig = process.env.CAUSL_FUZZ_SEED
    process.env.CAUSL_FUZZ_SEED = '12345'
    try {
      const cfg = propertyTrials('label', { seed: 99 })
      expect(cfg.seed).toBe(99)
    } finally {
      if (orig === undefined) delete process.env.CAUSL_FUZZ_SEED
      else process.env.CAUSL_FUZZ_SEED = orig
    }
  })

  it('label appears in the returned config for failure messages', () => {
    expect(propertyTrials('diamond-glitch').label).toBe('diamond-glitch')
  })

  it('floor error message names the label and the threshold', () => {
    try {
      propertyTrials('my-property', { numRuns: 50 })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain('my-property')
      expect((e as Error).message).toContain('1000')
    }
  })
})
