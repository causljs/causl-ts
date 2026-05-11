/**
 * @packageDocumentation
 *
 * Shared `fast-check` configuration for the property-test suite.
 *
 * The race-detection commitment for property-based fuzz lays out three
 * non-negotiables that this module turns into a runtime configuration:
 * (1) every property exercises at least 1000 random graphs and 1000+
 * random commit sequences, every CI run; (2) failing inputs are shrunk
 * and committed back as regression cases; and (3) seeds are deterministic
 * and logged so a CI failure is reproducible on a developer machine.
 * {@link propertyOptions} folds the `CAUSL_FUZZ_SEED` and
 * `CAUSL_FUZZ_VERBOSE` environment variables into an `fc.Parameters`
 * value and installs a custom reporter that prints an explicit
 * reproduction hint whenever a property fails.
 */

import type fc from 'fast-check'

/**
 * Caller-supplied overrides for {@link propertyOptions}. Only the trial count
 * may currently be overridden; the seed is always sourced from the
 * `CAUSL_FUZZ_SEED` env var (when set) so that CI failures are reproducible
 * on a developer machine without code changes — matching the "seeds are
 * deterministic and logged" half of the race-detection commitment.
 */
export interface PropertyOptions {
  /**
   * Number of fast-check trials to run. Defaults to 1000 — the floor that
   * the race-detection commitment imposes on every property in this suite.
   */
  readonly numRuns?: number
}

/**
 * Build an `fc.Parameters` object with the project-wide defaults: a 1000-trial
 * run count, an env-var-driven seed, and a reporter that emits a reproducible
 * `CAUSL_FUZZ_SEED=…` hint on failure. Callers may bump or lower
 * `numRuns` per property; the floor is 1000 for all glitch / atomicity /
 * determinism / dynamic-dep invariants, set by the race-detection commitment
 * that property-based fuzz substitutes for runtime races on every CI run.
 */
export function propertyOptions(
  base: PropertyOptions = {},
): fc.Parameters<unknown> {
  // Read env vars once: `CAUSL_FUZZ_SEED` reproduces a prior CI failure,
  // `CAUSL_FUZZ_VERBOSE=1` enables per-run seed logging via fast-check's
  // own verbose reporter pathway.
  const seedEnv = (typeof process !== 'undefined' && process.env?.['CAUSL_FUZZ_SEED']) || ''
  const verboseEnv = (typeof process !== 'undefined' && process.env?.['CAUSL_FUZZ_VERBOSE']) || ''
  // Assemble fast-check parameters. The 1000-trial default lines up with the
  // race-detection budget — 1000+ random graphs and 1000+ random commit
  // sequences per property, every CI run; individual properties may pass a
  // higher ceiling for stronger coverage.
  const params: fc.Parameters<unknown> = {
    numRuns: base.numRuns ?? 1000,
    verbose: verboseEnv === '1',
    reporter: defaultReporter,
  }
  // If the env-var seed parses as a finite number, pin the run to it so that
  // CI failures replay deterministically against the same shrunk counterexample.
  // This is the "logged seed reproduces a failure locally" half of the
  // race-detection commitment, expressed as a single env var.
  if (seedEnv) {
    const parsed = Number(seedEnv)
    if (Number.isFinite(parsed)) {
      Object.assign(params, { seed: parsed })
    }
  }
  return params
}

/**
 * Cross-backend determinism fuzz tier. Per issue #1073 the WASM-side
 * gate runs at one of four trial budgets selected by env var:
 *
 *   - `default`  — the SPEC §15.2 1000-trial floor (every property in
 *     the suite, no opt-in needed)
 *   - `pr`       —  5 000 trials, run on every PR
 *   - `nightly`  — 100 000 trials, scheduled
 *   - `cargo-fuzz` — opt-in marker. The TS-side property is skipped;
 *     the long-running corpus-driven exercise lives in a separate
 *     `cargo-fuzz`-based workflow (`tools/engine-rs-fuzz/`). Setting
 *     this tier in vitest is a signal to the suite to surface a
 *     structured skip rather than burn a 100k-trial nightly run.
 *
 * The tier is selected via `CAUSL_FUZZ_TIER` (preferred) or
 * `CAUSL_FUZZ_TRIALS` (numeric override — chooses the named tier
 * whose `numRuns` matches, else custom). The latter mirrors the
 * `CAUSL_FUZZ_SEED` ergonomic — a CI run can be rerun with an
 * explicit trial budget via env var without code changes.
 */
export type CrossBackendFuzzTier = 'default' | 'pr' | 'nightly' | 'cargo-fuzz'

/**
 * Resolved tier descriptor. `numRuns` drives `fc.assert`; `skip`
 * tells the property body to log a structured skip and exit cleanly
 * (used by the `cargo-fuzz` tier, which the TS property suite cannot
 * exercise — that work lives in a Rust fuzz harness).
 */
export interface CrossBackendFuzzTierConfig {
  readonly tier: CrossBackendFuzzTier
  readonly numRuns: number
  readonly skip: boolean
  /** Optional per-trial command-list ceiling. Tracks the issue body's
   *  `maxLength` recommendation (PR-lane: 500, nightly: 2000). */
  readonly maxCommands?: number
}

/**
 * Tier table — single source of truth for the (tier → numRuns,
 * maxCommands) mapping. The dimensions are pinned at the issue body's
 * values; a future PR widening or narrowing them must update this
 * table and the cross-reference test that pins it.
 */
export const CROSS_BACKEND_FUZZ_TIERS: Readonly<
  Record<CrossBackendFuzzTier, CrossBackendFuzzTierConfig>
> = {
  default: { tier: 'default', numRuns: 1000, skip: false, maxCommands: 40 },
  pr: { tier: 'pr', numRuns: 5_000, skip: false, maxCommands: 500 },
  nightly: { tier: 'nightly', numRuns: 100_000, skip: false, maxCommands: 2_000 },
  'cargo-fuzz': {
    tier: 'cargo-fuzz',
    numRuns: 0,
    skip: true,
  },
} as const

/**
 * Resolve the active fuzz tier from environment. The precedence is:
 *
 *   1. `CAUSL_FUZZ_TIER` — explicit named tier. The most ergonomic
 *      and the one CI workflows set.
 *   2. `CAUSL_FUZZ_TRIALS` — explicit numeric override. Useful for
 *      ad-hoc local runs ("bump to 10k for an afternoon"); a custom
 *      number that doesn't match any named tier surfaces under a
 *      `custom` synthetic descriptor with `tier: 'default'` so the
 *      structured failure-trace channels stay populated.
 *   3. Fallback: `default` (1000 trials).
 *
 * The tier descriptor flows into both `propertyOptions({ numRuns })`
 * and the cross-backend property body's command-arbitrary
 * `maxCommands` knob.
 */
export function resolveCrossBackendFuzzTier(): CrossBackendFuzzTierConfig {
  const env =
    typeof process !== 'undefined' && process.env ? process.env : undefined
  const named = env?.['CAUSL_FUZZ_TIER']?.toLowerCase().trim()
  if (named && named in CROSS_BACKEND_FUZZ_TIERS) {
    return CROSS_BACKEND_FUZZ_TIERS[named as CrossBackendFuzzTier]
  }
  const trialsRaw = env?.['CAUSL_FUZZ_TRIALS']
  if (trialsRaw) {
    const parsed = Number.parseInt(trialsRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      // Synthesise a custom descriptor — no maxCommands ceiling (let
      // the caller's own `commandArbitrary()` default ride).
      return { tier: 'default', numRuns: parsed, skip: false }
    }
  }
  return CROSS_BACKEND_FUZZ_TIERS.default
}

/**
 * Convenience wrapper around {@link propertyOptions} that auto-resolves
 * the active fuzz tier via {@link resolveCrossBackendFuzzTier} and
 * applies the tier's `numRuns` to the returned `fc.Parameters`.
 *
 * Use this in property tests instead of hardcoding
 * `propertyOptions({ numRuns: 1000 })`: a `numRuns` literal at a
 * callsite silently bypasses the tier system shipped by PR #1097
 * (issue #1073), pinning every property at the 1000-trial floor
 * regardless of `CAUSL_FUZZ_TIER`. Routing through this helper
 * preserves the same default-tier behaviour (1000 trials) while
 * letting the PR-lane and nightly tiers actually take effect.
 *
 * Callers may still override `numRuns` (e.g. for a property that
 * deliberately stays at the floor); an explicit override takes
 * precedence over the resolved tier so the override-by-callsite
 * ergonomic is preserved.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1153}
 */
export function tieredPropertyOptions(
  base: PropertyOptions = {},
): fc.Parameters<unknown> {
  const tier = resolveCrossBackendFuzzTier()
  return propertyOptions({ numRuns: base.numRuns ?? tier.numRuns })
}

/**
 * Failure reporter that augments fast-check's default with an explicit
 * `CAUSL_FUZZ_SEED=… pnpm test:run` reproduction hint. This realises the
 * "seeds are deterministic and logged so a CI failure is reproducible" half
 * of the race-detection commitment: a CI artifact alone — without source
 * changes, without rerunning the whole matrix — is sufficient to replay the
 * exact shrunk counterexample on a developer machine.
 */
function defaultReporter(out: fc.RunDetails<unknown>): void {
  if (out.failed) {
    // Mirror fast-check's default failure log, plus an explicit re-run hint
    // pointing at the env var the test harness honours.

    console.error(
      `[causl fuzz] property failed after ${out.numRuns} run(s); seed=${out.seed} path=${out.counterexamplePath ?? '(n/a)'}\n` +
        `  Reproduce: CAUSL_FUZZ_SEED=${out.seed} pnpm test:run`,
    )
    if (out.counterexample) {

      console.error('  counterexample:', out.counterexample)
    }
  }
}
