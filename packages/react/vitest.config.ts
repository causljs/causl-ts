/**
 * @packageDocumentation
 *
 * Vitest configuration for the `@causljs/react` package. Aliases
 * `@causljs/core` to its source entry so tests run against in-tree
 * code instead of a built artifact, and configures a jsdom environment
 * for React Testing Library plus a shared setup file.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Absolute path to the in-tree `@causljs/core` source entry.
 * Resolved via `import.meta.url` so the alias works regardless of the
 * cwd from which Vitest is invoked.
 */
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))

/**
 * Absolute path to the in-tree `@causljs/core/internal` entrypoint —
 * the not-publicly-exported escape hatch consumed by adapters. It
 * exists on the engine for adapter use but is NOT documented in the
 * public README and NOT covered by SemVer guarantees on the
 * `@causljs/core` public exports; the React adapter's family-hook
 * disposal channel is its primary consumer. Aliased separately so the
 * subpath import resolves to source (not a built artefact) during
 * in-tree testing.
 */
const coreInternal = fileURLToPath(
  new URL('../core/src/internal.ts', import.meta.url),
)

/**
 * Absolute path to the in-tree `@causljs/core/testing` shared test seam
 * (helpers like `propertyTrials`, `recomputeCounter`, `narrowCapability`).
 * Aliased so tests under `@causljs/react` can consume the seam without
 * a published subpath export.
 */
const coreTesting = fileURLToPath(
  new URL('../core/testing/src/index.ts', import.meta.url),
)

/**
 * Absolute path to the in-tree `@causljs/core/wasm` opt-in entry
 * point. Aliased so tests covering hooks that dynamic-import the
 * subpath (e.g. {@link useCauslTypedArrayNode}'s WASM-availability
 * probe in #688) resolve to source instead of `node_modules`. Until
 * the WASM artefacts (#682 / #683 / #693) ship, the loader throws
 * `WasmBackendUnavailableError` and the hooks take their JS-engine
 * fallback path — exactly what the unit tests assert on today.
 */
const coreWasm = fileURLToPath(new URL('../core/wasm/index.ts', import.meta.url))

/**
 * Default-exported Vitest config.
 *
 * - `resolve.alias`: redirects `@causljs/core` imports to the source
 *   entry so tests exercise current code without a build step.
 * - `test.include`: matches every `*.test.ts` / `*.test.tsx` under
 *   `test/`.
 * - `test.environment`: jsdom — required for React Testing Library
 *   DOM assertions.
 * - `test.globals`: disabled; tests must import `describe`/`it`/etc.
 *   explicitly from `vitest`.
 * - `test.setupFiles`: shared `./test/setup.ts` runs before each test
 *   file (e.g. for jest-dom matchers).
 */
export default defineConfig({
  resolve: {
    // Order matters — Vite resolves aliases in declaration order, so
    // the more-specific `/internal` subpath must precede the bare
    // `@causljs/core` entry to avoid an unintended prefix match.
    alias: [
      { find: '@causljs/core/testing', replacement: coreTesting },
      { find: '@causljs/core/internal', replacement: coreInternal },
      { find: '@causljs/core/wasm', replacement: coreWasm },
      { find: '@causljs/core', replacement: coreSrc },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    // The property-based suite floor is 1000+ random graphs / 1000+
    // random commit sequences per property, every CI run; React
    // render() in jsdom is ~10-30ms per trial, so 1000 trials per
    // test cannot fit in vitest's default 5 s timeout. Per-suite
    // override gives the property tests headroom while keeping unit
    // tests responsive.
    testTimeout: 120000,
  },
})
