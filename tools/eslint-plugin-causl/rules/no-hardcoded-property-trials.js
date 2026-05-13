/**
 * `causl/no-hardcoded-property-trials` (issue #1151).
 *
 * Why this exists
 * ---------------
 * PR #1097 (issue #1073) shipped the tiered fuzz-budget system:
 * `default=1000 / pr=5000 / nightly=100_000 / cargo-fuzz=skip` via
 * `resolveCrossBackendFuzzTier()`, with `tieredPropertyOptions()` and
 * `tieredPropertyTrials()` as the helper seams. Property tests that
 * hardcode the `numRuns` literal silently bypass that system — the
 * PR-lane 5k tier and nightly 100k tier never apply, so adversarial
 * seeds that would surface in a tiered run go unexercised.
 *
 * Pattern coverage
 * ----------------
 * The rule flags BOTH of these shapes:
 *
 *   1. `fc.assert(prop, { numRuns: <numeric literal>, ... })`
 *      — raw object literal as the second positional arg.
 *   2. `propertyTrials(label, { numRuns: <numeric literal> })` /
 *      `tieredPropertyTrials(label, { numRuns: <numeric literal> })`
 *      — the helper's options-bag positional arg.
 *
 * In all cases the `numRuns` value must be a non-literal expression
 * (e.g. `fuzzTier.numRuns`, a function call, or a property access)
 * sourced from the tier resolver. A bare identifier or any non-`Literal`
 * AST node passes.
 *
 * Allowlist
 * ---------
 * The rule accepts a single options object with an `allowlist` array.
 * Each entry is a relative path (from the project root) matching the
 * file under lint. If the file matches, the rule does not fire. Use the
 * allowlist for files where a hardcoded count is structurally required
 * (e.g. coverage-math spot-checks whose statistical guarantee depends
 * on a specific trial budget, or properties whose per-trial cost makes
 * the 100k nightly tier infeasible). Each allowlist entry must be
 * justified by a comment at the call site.
 *
 * Default: empty allowlist. Severity is configured at the consumer.
 */

const RULE_NAME = 'no-hardcoded-property-trials'

/**
 * Trial-count helpers whose first options-bag argument we lint. Listed
 * by name so a renamed import (the test suites all import the helpers
 * directly under these names) is still caught.
 */
const TRIAL_HELPERS = new Set([
  'propertyTrials',
  'tieredPropertyTrials',
])

/**
 * Compare an ESLint context's filename against the allowlist. The
 * comparison is suffix-anchored (path-from-anywhere) so the allowlist
 * works regardless of the working directory ESLint was invoked from
 * (per-package vs root).
 */
function isAllowlisted(filename, allowlist) {
  if (!allowlist || allowlist.length === 0) return false
  // Normalize path separators to forward slash so allowlist entries
  // written with `/` work on both POSIX and Windows.
  const norm = filename.replace(/\\/g, '/')
  for (const entry of allowlist) {
    const e = entry.replace(/\\/g, '/')
    if (norm === e || norm.endsWith('/' + e) || norm.endsWith(e)) return true
  }
  return false
}

/**
 * Return the `numRuns` property node of an object-expression argument
 * whose value is a numeric `Literal`, or `null` if the argument either
 * isn't an object expression, doesn't have a `numRuns` key, or has a
 * `numRuns` whose value is not a numeric literal.
 *
 * Numeric literals include `Literal` with a `number` value and also
 * `UnaryExpression` wrapping a numeric literal (e.g. `-1`, `+5000`)
 * since fast-check accepts those too.
 */
function findHardcodedNumRuns(node) {
  if (!node || node.type !== 'ObjectExpression') return null
  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue
    if (prop.computed) continue
    const key = prop.key
    const keyName =
      key.type === 'Identifier'
        ? key.name
        : key.type === 'Literal'
          ? key.value
          : null
    if (keyName !== 'numRuns') continue
    const v = prop.value
    if (
      v.type === 'Literal' &&
      typeof v.value === 'number'
    ) {
      return prop
    }
    if (
      v.type === 'UnaryExpression' &&
      (v.operator === '-' || v.operator === '+') &&
      v.argument.type === 'Literal' &&
      typeof v.argument.value === 'number'
    ) {
      return prop
    }
  }
  return null
}

/**
 * `fc.assert(...)` member-expression check: returns true if `callee`
 * is a MemberExpression whose object name is `fc` and property name is
 * `assert`. Computed access (`fc['assert']`) also matches.
 */
function isFcAssertCallee(callee) {
  if (callee.type !== 'MemberExpression') return false
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'fc') {
    return false
  }
  if (callee.computed) {
    return (
      callee.property.type === 'Literal' &&
      callee.property.value === 'assert'
    )
  }
  return (
    callee.property.type === 'Identifier' &&
    callee.property.name === 'assert'
  )
}

/** True if the callee is a bare identifier in {@link TRIAL_HELPERS}. */
function isTrialHelperCallee(callee) {
  return callee.type === 'Identifier' && TRIAL_HELPERS.has(callee.name)
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag hardcoded numRuns literals in fc.assert and propertyTrials/tieredPropertyTrials — route them through the tier system (resolveCrossBackendFuzzTier / tieredPropertyOptions / tieredPropertyTrials) so PR-lane and nightly tiers actually take effect.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: {
            type: 'array',
            items: { type: 'string' },
            description:
              'File paths (relative, suffix-match) exempt from this rule. Use only for documented prohibitively-slow or coverage-math-pinned properties; the rationale must be at the call site.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      fcAssertLiteral:
        'fc.assert({ numRuns: <literal> }) bypasses the fuzz-tier system (issue #1073 / PR #1097). Source numRuns from resolveCrossBackendFuzzTier() or use tieredPropertyOptions() / tieredPropertyTrials() instead.',
      propertyTrialsLiteral:
        '{{helper}}(label, { numRuns: <literal> }) bypasses the fuzz-tier system (issue #1073 / PR #1097). Use tieredPropertyTrials(label) so CAUSL_FUZZ_TIER actually takes effect, or move this file to the rule\'s allowlist with a documented reason.',
    },
  },
  create(context) {
    const options = context.options[0] || {}
    const allowlist = options.allowlist || []
    const filename =
      typeof context.filename === 'string'
        ? context.filename
        : (context.getFilename && context.getFilename()) || ''
    if (isAllowlisted(filename, allowlist)) return {}
    return {
      CallExpression(node) {
        const callee = node.callee
        // Pattern 1: fc.assert(prop, { numRuns: <literal>, ... })
        if (isFcAssertCallee(callee) && node.arguments.length >= 2) {
          const opts = node.arguments[1]
          const hit = findHardcodedNumRuns(opts)
          if (hit) {
            context.report({ node: hit, messageId: 'fcAssertLiteral' })
            return
          }
        }
        // Pattern 2: propertyTrials(label, { numRuns: <literal> })
        // and tieredPropertyTrials(label, { numRuns: <literal> })
        if (isTrialHelperCallee(callee) && node.arguments.length >= 2) {
          const opts = node.arguments[1]
          const hit = findHardcodedNumRuns(opts)
          if (hit) {
            context.report({
              node: hit,
              messageId: 'propertyTrialsLiteral',
              data: { helper: callee.name },
            })
          }
        }
      },
    }
  },
}

rule.ruleName = RULE_NAME

export default rule
