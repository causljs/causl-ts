/**
 * @packageDocumentation
 *
 * Vitest configuration for `@causljs/core`. Runs the unit / property
 * test suite under Node, scopes test discovery to `test/**` and
 * collects v8 coverage against the engine sources in `src/**`.
 *
 * The property-based tests executed under this configuration are not a
 * separate test family — they are the engine's race-detection layer
 * for everything the type system and API shape don't catch. For each
 * runtime / pre-deploy-fuzz race class in the engine's catalogue
 * (stale-async correctness, dynamic-dependency cleanup, cycle
 * detection completeness, diamond glitch-freedom, replay determinism),
 * this suite runs 1000+ random graphs and 1000+ random commit
 * sequences on every CI run; failing inputs are shrunk and committed
 * as regression cases, and seeds are deterministic and logged so a CI
 * failure is reproducible. Property fuzz cannot prove the absence of a
 * bug or explore unbounded state spaces — it can only fail to find
 * one — so coverage remains statistical and is complemented by the
 * bounded model checker that runs alongside this suite.
 */

import { defineConfig } from 'vitest/config'

// Vitest configuration for the @causljs/core package.
export default defineConfig({
  test: {
    // Restrict discovery to TypeScript test files under ./test.
    include: ['test/**/*.test.ts'],
    // Engine logic is host-agnostic; Node is the canonical target.
    environment: 'node',
    // Vitest's default 5s per-test timeout is tight for the heap-leak
    // gate (10k commits, two `globalThis.gc()` passes) and the
    // disposed-tombstone property fuzz (1000+ trials, each
    // synthesising a graph) when the suite runs concurrently with
    // sibling-package compilation in `pnpm -r test:run`. Linux CI
    // runners finish both well under 5s; local macOS worktrees under
    // active load can drift past that floor. The signal these gates
    // produce is "memory delta vs. structural ceiling" and "every
    // disposed id surfaces NodeDisposedError", not wall-clock — so a
    // generous 30s timeout protects the assertions from environmental
    // noise without weakening them.
    testTimeout: 30_000,
    coverage: {
      // v8 provider keeps coverage close to the runtime profiler.
      provider: 'v8',
      // Reporters: human-readable text plus lcov for CI consumers.
      reporter: ['text', 'lcov'],
      // Score coverage against engine sources only.
      include: ['src/**/*.ts'],
    },
  },
})
