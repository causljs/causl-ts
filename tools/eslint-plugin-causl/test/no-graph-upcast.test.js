/**
 * Tests for `causl/no-graph-upcast` (issue #9 — S-3 third gate).
 *
 * SPEC.async §S-3 names three gates against the dispatch-shape leak
 * across capability narrowing: a `tsc` error (compile time), a runtime
 * Proxy throw (the `narrowCapability` Proxy in
 * `packages/core/src/internal.ts`), and a static lint pass that catches
 * `as Graph` upcasts in source. The first two are already wired; this
 * rule closes the third gate.
 *
 * Pattern coverage
 * ----------------
 * - `value as Graph`                — TSAsExpression with TSTypeReference `Graph`.
 * - `value as unknown as Graph`     — chained TSAsExpression resolving to `Graph`.
 * - `value as import('x').Graph`    — import-qualified `Graph` reference.
 *
 * Non-`Graph` upcasts (e.g. `as GraphTime`, `as GraphSnapshot`,
 * `as GraphParam`) MUST NOT fire — those are unrelated TS branding
 * casts that pepper the wasm marshaler / test fixtures and are not the
 * S-3 capability-narrowing leak shape.
 *
 * Allowlist
 * ---------
 * The two `as Graph` casts that already exist in the workspace are
 * the React adapter's runtime-gate tests
 * (`packages/react/test/useCausl.test.tsx`,
 * `packages/react/test/useCauslSuspense.test.tsx`). They deliberately
 * synthesise the leak shape to assert that the `narrowCapability` Proxy
 * throws `CapabilityViolation`. The rule MUST allow these via a
 * suffix-matched `allowlist`, with each entry justified by a comment at
 * the call site.
 */

import { RuleTester } from 'eslint'
import { describe, it } from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from '../rules/no-graph-upcast.js'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

describe('causl/no-graph-upcast', () => {
  it('runs the rule-tester cases', () => {
    tester.run('no-graph-upcast', rule, {
      valid: [
        // Brand-cast on a numeric literal — `GraphTime` is not `Graph`.
        { code: `const t = 42 as GraphTime` },
        // Brand-cast through `unknown` to `GraphTime` — same: not `Graph`.
        { code: `const t = (x as unknown) as GraphTime` },
        // Brand-cast to `GraphSnapshot` — not the S-3 shape.
        { code: `const s = obj as unknown as GraphSnapshot` },
        // Brand-cast to `GraphParam` — not the S-3 shape.
        { code: `const p = null as unknown as GraphParam` },
        // Identifier called `Graph` used as a value, not a type — fine.
        { code: `const G = Graph; const x = G.create()` },
        // Allowlisted file — the runtime-gate test fixture.
        {
          code: `const leaked = captured as Graph`,
          filename: '/repo/packages/react/test/useCausl.test.tsx',
          options: [
            {
              allowlist: [
                'packages/react/test/useCausl.test.tsx',
                'packages/react/test/useCauslSuspense.test.tsx',
              ],
            },
          ],
        },
        // Allowlisted file with chained `as unknown as Graph` shape.
        {
          code: `const leaked = captured as unknown as Graph`,
          filename: '/repo/packages/react/test/useCauslSuspense.test.tsx',
          options: [
            {
              allowlist: [
                'packages/react/test/useCausl.test.tsx',
                'packages/react/test/useCauslSuspense.test.tsx',
              ],
            },
          ],
        },
      ],
      invalid: [
        // Bare `as Graph` upcast — the canonical S-3 leak shape.
        {
          code: `const leaked = captured as Graph`,
          errors: [{ messageId: 'asGraphUpcast' }],
        },
        // `as unknown as Graph` chain — the more aggressive bypass.
        {
          code: `const leaked = captured as unknown as Graph`,
          errors: [{ messageId: 'asGraphUpcast' }],
        },
        // `as any as Graph` — also a bypass shape worth catching.
        {
          code: `const leaked = captured as any as Graph`,
          errors: [{ messageId: 'asGraphUpcast' }],
        },
        // Filename present but NOT on the allowlist — still fires.
        {
          code: `const leaked = captured as Graph`,
          filename: '/repo/packages/app/src/leaky.ts',
          options: [
            {
              allowlist: [
                'packages/react/test/useCausl.test.tsx',
              ],
            },
          ],
          errors: [{ messageId: 'asGraphUpcast' }],
        },
      ],
    })
  })
})
