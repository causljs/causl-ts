/**
 * @packageDocumentation
 *
 * Vitest configuration for the shared testing seam. Discovery covers the
 * co-located `src/__tests__/*.test.ts` suites alongside the source files
 * they exercise, and the `@causl/core` alias points at the in-tree
 * source so seam helpers and their tests share a single engine instance.
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Resolve the in-tree core source so the seam picks up unreleased engine
// changes without an intermediate build step.
const coreSrc = resolve(__dirname, '../src');

export default defineConfig({
  resolve: {
    alias: {
      '@causl/core': coreSrc,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
