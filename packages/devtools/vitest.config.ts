/**
 * @packageDocumentation
 *
 * Vitest configuration for the `@causljs/devtools` package. Aliases the
 * `@causljs/core` import specifier directly to the sibling package's
 * TypeScript source so tests run against the in-repo implementation rather
 * than a built artefact, and constrains discovery to `.test.ts` files
 * executed under the Node environment.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Absolute path to `@causljs/core`'s TypeScript entry, resolved relative to
 * this config file so the alias works regardless of the caller's CWD.
 */
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))

/**
 * Absolute path to `@causljs/core`'s `/internal` entry — the adapter-level
 * escape hatch that exports `assertNever` (and other adapter primitives)
 * for consumers like the lineage explainers in this package.
 */
const coreInternalSrc = fileURLToPath(
  new URL('../core/src/internal.ts', import.meta.url),
)

/**
 * Vitest config for devtools tests.
 *
 * - `resolve.alias` redirects `@causljs/core` to its in-repo source so test
 *   runs always exercise the latest checked-in code without a prior build.
 * - `test.include` scopes discovery to the `test/` directory using the
 *   `.test.ts` suffix convention.
 * - `test.environment` pins execution to Node since devtools APIs are
 *   environment-agnostic but the tests have no DOM dependencies.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Order matters: longer specifier must come first so `/internal`
      // is matched before the `@causljs/core` prefix is consumed.
      '@causljs/core/internal': coreInternalSrc,
      '@causljs/core': coreSrc,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
