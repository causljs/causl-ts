/**
 * Shared `fast-check` configuration for the migration-check
 * property suite. Mirrors `packages/core/test/properties/seed.ts`
 * so the SPEC §15.2 1000-trial floor (EPIC #285 / #292) holds
 * across the migration-validation axis as well.
 *
 * The trial floor is the bounds-and-seeds half of the
 * race-detection commitment: 1000+ random trials per property on
 * every CI run; failing inputs are shrunk and committed back as
 * regression cases; seeds are deterministic and logged so a CI
 * failure replays on a developer machine via `CAUSL_FUZZ_SEED`.
 */

import type fc from 'fast-check'

export interface PropertyOptions {
  /**
   * Number of fast-check trials. Floor is 1000 per SPEC §15.2.
   * Lowering below 1000 is rejected by the conformance meta-test
   * in `packages/core/test/spec-15.2-conformance.test.ts`.
   */
  readonly numRuns?: number
}

/**
 * Build an `fc.Parameters` object with the project-wide defaults:
 * a 1000-trial run count, an env-var-driven seed, and a reporter
 * that emits a reproducible `CAUSL_FUZZ_SEED=…` hint on failure.
 */
export function propertyOptions(
  base: PropertyOptions = {},
): fc.Parameters<unknown> {
  const seedEnv =
    (typeof process !== 'undefined' && process.env?.['CAUSL_FUZZ_SEED']) || ''
  const verboseEnv =
    (typeof process !== 'undefined' && process.env?.['CAUSL_FUZZ_VERBOSE']) || ''
  const params: fc.Parameters<unknown> = {
    numRuns: base.numRuns ?? 1000,
    verbose: verboseEnv === '1',
    reporter: defaultReporter,
  }
  if (seedEnv) {
    const parsed = Number(seedEnv)
    if (Number.isFinite(parsed)) {
      Object.assign(params, { seed: parsed })
    }
  }
  return params
}

function defaultReporter(out: fc.RunDetails<unknown>): void {
  if (out.failed) {

    console.error(
      `[causl fuzz] property failed after ${out.numRuns} run(s); seed=${out.seed} path=${out.counterexamplePath ?? '(n/a)'}\n` +
        `  Reproduce: CAUSL_FUZZ_SEED=${out.seed} pnpm test:run`,
    )
    if (out.counterexample) {

      console.error('  counterexample:', out.counterexample)
    }
  }
}
