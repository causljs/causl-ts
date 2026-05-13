/**
 * Tests for `causl/no-hardcoded-property-trials` (issue #1151).
 *
 * Uses ESLint's `RuleTester` against the flat-config parser API. Run
 * via `node --test tools/eslint-plugin-causl/test/*.test.js`.
 *
 * Cases
 * -----
 * Valid:
 *   - `fc.assert` with `numRuns: fuzzTier.numRuns` (non-literal — the
 *     resolveCrossBackendFuzzTier-routed pattern).
 *   - `tieredPropertyTrials(label)` with no options bag at all.
 *   - A file on the allowlist with a hardcoded literal — exempt.
 *
 * Invalid:
 *   - `fc.assert(prop, { numRuns: 1000 })` — raw literal.
 *   - `propertyTrials(label, { numRuns: 5000 })` — helper literal.
 *   - `tieredPropertyTrials(label, { numRuns: 1000 })` — helper literal
 *     in the tier-aware variant (still a bypass — the explicit
 *     override defeats the tier resolver).
 *   - `fc.assert(prop, { numRuns: -1, ... })` — unary-negated literal.
 */

import { RuleTester } from 'eslint'
import { describe, it } from 'node:test'
import rule from '../rules/no-hardcoded-property-trials.js'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

describe('causl/no-hardcoded-property-trials', () => {
  it('runs the rule-tester cases', () => {
    tester.run('no-hardcoded-property-trials', rule, {
      valid: [
        // tier-resolver routed — the canonical good pattern.
        {
          code: `
            const fuzzTier = resolveCrossBackendFuzzTier()
            fc.assert(prop, propertyOptions({ numRuns: fuzzTier.numRuns }))
          `,
        },
        // bare propertyTrials with no options bag — defaults internally
        // to the floor, no literal to flag.
        {
          code: `tieredPropertyTrials('my-label')`,
        },
        // helper called with only a label.
        {
          code: `propertyTrials('my-label')`,
        },
        // options bag that doesn't mention numRuns at all.
        {
          code: `propertyTrials('my-label', { seed: 42 })`,
        },
        // fc.assert with a single argument — no options bag.
        {
          code: `fc.assert(prop)`,
        },
        // fc.assert with options whose numRuns is a non-literal
        // expression (function call). The whole point of the tier
        // system is to source numRuns from a call like this.
        {
          code: `fc.assert(prop, { numRuns: resolveCrossBackendFuzzTier().numRuns })`,
        },
        // fc.assert routed through propertyOptions (the wrapper hides
        // the literal inside its own implementation — that's the seam
        // we trust).
        {
          code: `fc.assert(prop, propertyOptions({ numRuns: fuzzTier.numRuns }))`,
        },
        // Allowlisted file — even with a literal, exempt.
        {
          code: `propertyTrials('coverage-spot-check', { numRuns: 5000 })`,
          filename:
            '/repo/packages/react/test/cross-tree.property.test.tsx',
          options: [
            {
              allowlist: [
                'packages/react/test/cross-tree.property.test.tsx',
              ],
            },
          ],
        },
      ],
      invalid: [
        // Pattern 1: raw literal as fc.assert second arg.
        {
          code: `fc.assert(prop, { numRuns: 1000 })`,
          errors: [{ messageId: 'fcAssertLiteral' }],
        },
        // Pattern 1: literal with sibling fields (verbose, seed).
        {
          code: `fc.assert(prop, { numRuns: 5000, verbose: true })`,
          errors: [{ messageId: 'fcAssertLiteral' }],
        },
        // Pattern 1: unary-negated literal (defensive — fast-check
        // would reject this at runtime, but the lint shape should
        // still catch the hardcoded numeric shape).
        {
          code: `fc.assert(prop, { numRuns: +5000 })`,
          errors: [{ messageId: 'fcAssertLiteral' }],
        },
        // Pattern 2: propertyTrials with hardcoded count.
        {
          code: `propertyTrials('label', { numRuns: 5000 })`,
          errors: [{ messageId: 'propertyTrialsLiteral' }],
        },
        // Pattern 2: tieredPropertyTrials with explicit numRuns
        // override — this defeats the tier resolver, so it's a bypass.
        {
          code: `tieredPropertyTrials('label', { numRuns: 1000 })`,
          errors: [{ messageId: 'propertyTrialsLiteral' }],
        },
        // Filename present but not on allowlist — still fires.
        {
          code: `propertyTrials('label', { numRuns: 5000 })`,
          filename: '/repo/packages/react/test/other.test.tsx',
          options: [
            {
              allowlist: [
                'packages/react/test/cross-tree.property.test.tsx',
              ],
            },
          ],
          errors: [{ messageId: 'propertyTrialsLiteral' }],
        },
      ],
    })
  })
})
