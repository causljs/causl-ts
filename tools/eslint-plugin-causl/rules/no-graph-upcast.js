/**
 * `causl/no-graph-upcast` (issue #9) — S-3 third gate.
 *
 * Why this exists
 * ---------------
 * SPEC.async §S-3 names three gates against the dispatch-shape leak
 * across capability narrowing:
 *
 *   1. The compile-time `tsc` error — `ReadOnlyGraph` does not have
 *      `commit`/`input`/`derived`/`exportModel`, so a selector or
 *      listener that tries to invoke them fails to typecheck.
 *   2. The runtime `narrowCapability` Proxy in
 *      `packages/core/src/internal.ts` — any property access not in
 *      the allow-list throws `CapabilityViolation`.
 *   3. A static lint pass that catches `as Graph` upcasts in source —
 *      the only escape hatch by which adopter code can quiet (1) and
 *      smuggle a full-Graph reference past the narrowing boundary
 *      before (2) has a chance to fire on the wrong method.
 *
 * Gate 3 was deferred (TASK 12.4) and never wired. This rule closes
 * the loop: any `value as Graph` / `value as unknown as Graph` /
 * `value as any as Graph` cast in adopter source fails the build.
 *
 * Scope
 * -----
 * The rule fires on `TSAsExpression` whose top-level type annotation
 * is a `TSTypeReference` named `Graph` (the engine handle from
 * `@causl/core`), including the chained `as unknown as Graph` /
 * `as any as Graph` bypass shapes. Brand-casts to `GraphTime`,
 * `GraphSnapshot`, `GraphParam`, etc. are NOT flagged — those are
 * unrelated TS branding patterns used by the wasm marshaler and test
 * fixtures, not the S-3 capability-leak shape.
 *
 * Allowlist
 * ---------
 * The rule accepts an `allowlist` option. The two `as Graph` casts
 * already in the workspace
 * (`packages/react/test/useCausl.test.tsx`,
 * `packages/react/test/useCauslSuspense.test.tsx`) deliberately
 * synthesise the leak shape to assert that `narrowCapability`'s Proxy
 * throws `CapabilityViolation` at runtime — they ARE the test for
 * gate 2. Each allowlist entry must carry a comment at the call site
 * explaining why the cast is structurally required.
 */

const RULE_NAME = 'no-graph-upcast'

/** Suffix-anchored allowlist match (per the no-hardcoded-property-trials seam). */
function isAllowlisted(filename, allowlist) {
  if (!allowlist || allowlist.length === 0) return false
  const norm = filename.replace(/\\/g, '/')
  for (const entry of allowlist) {
    const e = entry.replace(/\\/g, '/')
    if (norm === e || norm.endsWith('/' + e) || norm.endsWith(e)) return true
  }
  return false
}

/**
 * True if a `TSTypeReference` node names `Graph`. Covers both plain
 * `Graph` and qualified forms like `causl.Graph` /
 * `import('x').Graph` where the rightmost name is `Graph`.
 */
function isGraphTypeReference(typeAnnotation) {
  if (!typeAnnotation || typeAnnotation.type !== 'TSTypeReference') return false
  const name = typeAnnotation.typeName
  if (!name) return false
  if (name.type === 'Identifier') return name.name === 'Graph'
  if (name.type === 'TSQualifiedName') {
    return name.right && name.right.type === 'Identifier' && name.right.name === 'Graph'
  }
  return false
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag `as Graph` / `as unknown as Graph` / `as any as Graph` upcasts in source — the S-3 capability-narrowing leak shape (SPEC.async §S-3, EPIC-12 TASK 12.4).',
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
              'File paths (relative, suffix-match) exempt from this rule. Reserved for fixtures that deliberately synthesise the leak shape to test the runtime Proxy gate.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      asGraphUpcast:
        '`as Graph` upcast bypasses the S-3 capability-narrowing boundary (SPEC.async §S-3). The compile-time and runtime-Proxy gates exist precisely to forbid this shape. Use the narrowed-capability factory (`narrowCapability(graph)` returning `ReadOnlyGraph`) and consume the appropriate seam, or move this file to the rule\'s allowlist with a documented reason at the call site.',
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
      TSAsExpression(node) {
        if (isGraphTypeReference(node.typeAnnotation)) {
          context.report({ node, messageId: 'asGraphUpcast' })
        }
      },
    }
  },
}

rule.ruleName = RULE_NAME

export default rule
