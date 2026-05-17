/**
 * Public sub-path entrypoint: `@causljs/core/testing`.
 *
 * Per SPEC.async §15.0, the shared test seam (recomputeCounter,
 * glitchDetector, assertConsistentGraphTime, assertResultStability,
 * propertyTrials, propertyDag, disposedTombstoneSize) is surfaced from
 * `@causljs/core` itself, even though the helpers live in the sibling
 * `@causljs/core-testing-internal` workspace package.
 *
 * The internal workspace exists because the helpers transitively import
 * type-only declarations from `@causljs/core`. Hosting them in a separate
 * package avoids a runtime cycle while keeping the type relationship
 * directional. This barrel re-exports those helpers so that downstream
 * consumers — adapter packages, application test suites, the Rust
 * conformance bridge — can write `import { ... } from '@causljs/core/testing'`
 * without depending on the private workspace name.
 *
 * Build note: tsup is configured with `--noExternal
 * @causljs/core-testing-internal`, which inlines the helper sources into
 * `dist/testing.js`. Inlining is necessary because the internal package
 * ships TypeScript directly (its `main` points at `./src/index.ts`),
 * and a downstream `node_modules` consumer cannot resolve raw `.ts` at
 * runtime. The type-only `@causljs/core` imports inside testing-internal
 * are erased before bundling, so no runtime cycle is introduced.
 */

export * from '@causljs/core-testing-internal'
