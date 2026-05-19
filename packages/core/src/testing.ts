/**
 * Public sub-path entrypoint: `@causl/core/testing`.
 *
 * Per SPEC.async §15.0, the shared test seam (recomputeCounter,
 * glitchDetector, assertConsistentGraphTime, assertResultStability,
 * propertyTrials, propertyDag, disposedTombstoneSize) is surfaced from
 * `@causl/core` itself, even though the helpers live in the sibling
 * `@causl/core-testing-internal` workspace package
 * (`packages/core/testing/`).
 *
 * The internal workspace exists because the helpers transitively import
 * type-only declarations from `@causl/core`. Hosting them in a separate
 * package avoids a runtime cycle while keeping the type relationship
 * directional. This barrel re-exports those helpers so that downstream
 * consumers — adapter packages, application test suites, the Rust
 * conformance bridge — can write `import { ... } from '@causl/core/testing'`
 * without depending on the private workspace name.
 *
 * Build note: the re-export is written as a relative import into the
 * sibling workspace's `src/` tree rather than the package specifier
 * `@causl/core-testing-internal`. This is load-bearing for type
 * generation: tsup inlines the runtime sources into `dist/testing.js`
 * (the internal package's `main` points at raw `.ts`), but the emitted
 * `dist/testing.d.ts` previously contained
 * `export * from '@causl/core-testing-internal'` — a specifier that does
 * not resolve in any downstream `node_modules` because the workspace
 * package is `private: true` and unpublished (causljs/causl-ts#31).
 * Using a relative path here forces TypeScript to inline the actual
 * declarations into `dist/testing.d.ts`, so consumers get real types
 * for `recomputeCounter`, `glitchDetector`, etc. without any phantom
 * package dependency. The runtime behaviour is unchanged — the helper
 * sources still bundle into `dist/testing.js` exactly as before.
 */

// Relative import (not the `@causl/core-testing-internal` specifier) so
// that `tsup --dts` inlines the declarations into `dist/testing.d.ts`.
// See the block comment above for the full rationale.
export * from '../testing/src/index.js'
