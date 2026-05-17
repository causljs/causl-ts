/**
 * @packageDocumentation
 *
 * Vitest configuration for the `@causljs/sync` package. Aliases
 * `@causljs/core` and `@causljs/core/internal` directly to the
 * sibling package's source entry points so tests run against in-tree
 * TypeScript without a build step, and scopes test discovery to
 * `test/**\/*.test.ts` under the Node environment (no DOM globals
 * required by the staleness/property suites).
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Absolute filesystem path to the core package's TypeScript entry point.
 * Resolved from `import.meta.url` so the alias works regardless of the
 * cwd Vitest is launched from.
 */
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))

/**
 * Absolute filesystem path to the core package's `/internal` subpath
 * source entry — used by {@link assertNever} and other low-level
 * helpers that the conflict registry depends on. Without this alias,
 * vitest's resolver falls back to the published `dist/` build, which
 * requires a prior `pnpm build` step that the test harness
 * intentionally skips.
 */
const coreInternal = fileURLToPath(
  new URL('../core/src/internal.ts', import.meta.url),
)

export default defineConfig({
  resolve: {
    // Array form so we can order the longer subpath alias first.
    alias: [
      // Order matters: the longer subpath alias is matched first so
      // `@causljs/core/internal` doesn't fall through to the bare
      // `@causljs/core` rule.
      { find: '@causljs/core/internal', replacement: coreInternal },
      // Route `@causljs/core` imports to in-tree source so changes in
      // the sibling package take effect without a build.
      { find: '@causljs/core', replacement: coreSrc },
    ],
  },
  test: {
    // Restrict discovery to the package's `test/` tree.
    include: ['test/**/*.test.ts'],
    // Suites run under Node; no jsdom is needed.
    environment: 'node',
  },
})
