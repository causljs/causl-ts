// SPEC §17 commitment 3 / issue #393 — negative fixture for the
// package-boundary layering rule.
//
// This file deliberately violates the layering: it imports from
// `@causl/react` (a sibling adapter) as if it lived inside
// `@causl/core`. The layering-lint test in
// `packages/core/test/layering-lint.test.ts` lints this content via
// the ESLint Node API at a synthetic file path under
// `packages/core/` and asserts the rule fires.
//
// The `.fixture.ts` suffix and the `tools/lint-fixtures/` location
// keep this file out of every per-package lint glob (src + test) so
// production lint never flags it. The negative test is the only
// consumer.
//
// DO NOT import this file from production code. It does not
// type-check cleanly because it imports a name from an arbitrary
// adapter; that is fine because the test feeds the source string to
// ESLint directly and never asks tsc to compile it.

import { useCausl } from '@causl/react'

export const _useCausl = useCausl
