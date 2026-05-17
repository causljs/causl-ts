/**
 * `eslint-plugin-causl` — workspace-local ESLint plugin housing the
 * project's bespoke lint rules. Loaded by the root `eslint.config.js`
 * via a relative-path `import` and registered under the `causl/`
 * namespace.
 *
 * Rules
 * -----
 *
 * - `no-hardcoded-property-trials` (issue #1151):
 *     Flags hardcoded numeric literals passed as the `numRuns` option to
 *     `fc.assert(prop, { numRuns: <literal>, ... })` and to
 *     `propertyTrials(label, { numRuns: <literal> })` /
 *     `tieredPropertyTrials(label, { numRuns: <literal> })`. The tier
 *     system shipped by PR #1097 (`resolveCrossBackendFuzzTier()`,
 *     `tieredPropertyOptions()`, `tieredPropertyTrials()`) silently
 *     bypasses any hardcoded count, pinning the suite at one tier
 *     regardless of `CAUSL_FUZZ_TIER`. The rule has an `allowlist`
 *     option keyed by relative file path so prohibitively-slow or
 *     coverage-math-pinned properties can opt out with a documented
 *     reason at the call site.
 *
 * - `no-graph-upcast` (issue #9):
 *     Closes the S-3 third gate from SPEC.async §S-3 / EPIC-12. Flags
 *     `value as Graph` / `value as unknown as Graph` /
 *     `value as any as Graph` upcasts in source — the only escape hatch
 *     by which adopter code can silence the compile-time gate and
 *     smuggle a full-Graph reference past the narrowing boundary
 *     before the runtime `narrowCapability` Proxy gets a chance to
 *     fire. Brand-casts (`as GraphTime`, `as GraphSnapshot`, etc.) are
 *     NOT flagged. The rule has an `allowlist` option for the runtime-
 *     gate test fixtures that deliberately synthesise the leak shape.
 */

import noHardcodedPropertyTrials from './rules/no-hardcoded-property-trials.js'
import noGraphUpcast from './rules/no-graph-upcast.js'

const plugin = {
  meta: {
    name: 'eslint-plugin-causl',
    version: '0.0.0',
  },
  rules: {
    'no-hardcoded-property-trials': noHardcodedPropertyTrials,
    'no-graph-upcast': noGraphUpcast,
  },
}

export default plugin
