/**
 * @packageDocumentation
 *
 * Vitest configuration for `@causl/formula`. Aliases
 * `@causl/core` to the sibling package's TypeScript source so
 * tests run against the in-tree implementation without requiring a
 * prior build step. Restricts the test runner to `test/**` and pins
 * the `node` environment since the formula package has no DOM
 * dependencies.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Absolute filesystem path to the in-repo source entry of
 * `@causl/core`, resolved relative to this config file.
 */
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))
const coreInternal = fileURLToPath(new URL('../core/src/internal.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // Order matters: the longer subpath alias is matched first so
      // `@causl/core/internal` doesn't fall through to the bare
      // `@causl/core` rule.
      { find: '@causl/core/internal', replacement: coreInternal },
      { find: '@causl/core', replacement: coreSrc },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
