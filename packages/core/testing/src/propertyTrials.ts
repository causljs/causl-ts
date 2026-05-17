/**
 * propertyTrials — a `fast-check` configuration wrapper that enforces
 * the engine's contracted ≥1000-trials floor and logs failing seeds for
 * regression-as-fixture replay.
 *
 * Why this exists: PRs in flight currently run property suites at 50
 * trials, 100 trials, and once with the dependency not even installed.
 * The engine's testing contract is concrete: 1000+ random graphs and
 * 1000+ random commit sequences per property, every CI run; failing
 * inputs are shrunk and committed as regression cases; seeds are
 * deterministic and logged so a CI failure is reproducible. Property-
 * based tests *are* the race-detection layer for everything the type
 * system and API shape don't catch — under-trialling them silently
 * weakens that layer. This helper makes the floor a structural check
 * — every property that uses it cannot drop below 1000 without
 * `unsafeTrials: <n>`, which the lint rule rejects.
 *
 * Usage:
 *
 *   import fc from 'fast-check'
 *   import { propertyTrials } from '@causl/core/testing'
 *
 *   it('diamond is glitch-free for any commit sequence', () => {
 *     fc.assert(
 *       fc.property(genCommits, (commits) => {
 *         const detector = glitchDetector(...)
 *         applyCommits(graph, commits)
 *         expect(detector.observed).toBe(0)
 *       }),
 *       propertyTrials('diamond-glitch'),
 *     )
 *   })
 *
 * The label is included in failure messages and seed logs so a CI
 * failure tells you which property fired without spelunking.
 */

export interface PropertyTrialsOptions {
  /**
   * Override trial count. Defaults to 1000 (the engine's contracted
   * per-property floor). `unsafeTrials` is banned by lint when below
   * 1000.
   */
  readonly numRuns?: number
  /**
   * Allow trial count below 1000. Use only for prohibitively-slow
   * properties; document the rationale at the call site. Lint rule
   * `causl/no-unsafe-trials` rejects this without a `// eslint-disable-line`
   * with a comment.
   */
  readonly unsafeTrials?: number
  /**
   * Seed for reproducibility. Defaults to a deterministic seed derived
   * from the env var `CAUSL_FUZZ_SEED` if set, else a random seed
   * logged at the start of every run.
   */
  readonly seed?: number
}

/**
 * Returned configuration shape. Mirrors the subset of `fast-check`'s
 * `Parameters<T>` that this helper drives, plus a `label` field used
 * in failure messages and seed logs. Property fields are mutable
 * (matching fast-check's `Parameters` shape exactly) so the value can
 * be passed to `fc.assert(..., cfg)` without a cast.
 */
export interface PropertyTrialsConfig {
  label: string
  numRuns: number
  seed: number
  verbose: boolean
  markInterruptAsFailure: boolean
}

const DEFAULT_TRIALS = 1000

export function propertyTrials(
  label: string,
  options: PropertyTrialsOptions = {},
): PropertyTrialsConfig {
  const numRuns =
    options.unsafeTrials !== undefined
      ? options.unsafeTrials
      : (options.numRuns ?? DEFAULT_TRIALS)

  if (
    options.unsafeTrials === undefined &&
    options.numRuns !== undefined &&
    options.numRuns < DEFAULT_TRIALS
  ) {
    throw new Error(
      `propertyTrials('${label}'): numRuns ${options.numRuns} below the ` +
        `SPEC §15.2 floor of ${DEFAULT_TRIALS}. Use \`unsafeTrials\` if you ` +
        `genuinely need fewer (with documented rationale).`,
    )
  }

  const seed =
    options.seed !== undefined
      ? options.seed
      : seedFromEnv() ?? Math.floor(Math.random() * 0x7fffffff)

  // fast-check allows passing a `Parameters<T>` shape — we declare a
  // structurally-compatible config that covers the fields fast-check
  // recognises without depending on its types here (so this module
  // remains importable in environments that haven't installed it yet).
  // We intentionally omit `examples` (defaults to `[]` inside fast-check)
  // because typing it `readonly never[]` here would be incompatible with
  // every property tuple shape under `exactOptionalPropertyTypes`.
  return {
    label,
    numRuns,
    seed,
    verbose: false,
    markInterruptAsFailure: true,
  }
}

function seedFromEnv(): number | undefined {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.CAUSL_FUZZ_SEED
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

// ---------------------------------------------------------------------------
// Tiered fuzz-budget integration (issue #1073 / PR #1097, follow-up #1153).
//
// PR #1097 shipped a fuzz tier system in
// `packages/core/test/properties/seed.ts` whose resolver reads
// `CAUSL_FUZZ_TIER` (named: 'default' | 'pr' | 'nightly' | 'cargo-fuzz')
// and `CAUSL_FUZZ_TRIALS` (numeric override). That resolver lives in a
// `test/` path and cannot be imported from this published-testing-seam
// module; the tier env-var contract is therefore mirrored here so
// `propertyTrials` callers (predominantly in `@causl/sync` and
// `@causl/migration-check` property tests) can route trial budgets
// through the same env-var lever.
// ---------------------------------------------------------------------------

/**
 * Tier table mirrored from
 * `packages/core/test/properties/seed.ts`. The tier definitions are
 * intentionally duplicated rather than imported because the seed.ts
 * version lives in a `test/` path that is not importable from a
 * published-testing-seam module. The cross-reference is pinned by a
 * harness self-check in the cross-backend determinism suite that
 * imports both definitions and asserts they remain aligned.
 *
 * @internal
 */
const FUZZ_TIER_NUM_RUNS = {
  default: 1000,
  pr: 5_000,
  nightly: 100_000,
  // 'cargo-fuzz' is a skip marker in seed.ts; the property-trials
  // path has no skip-shape, so cargo-fuzz callers fall through to the
  // default floor — the heavy corpus-driven work lives in the Rust
  // fuzz harness, not in property tests routed through this helper.
  'cargo-fuzz': 1000,
} as const

/**
 * Resolve the active fuzz tier's `numRuns` from environment, mirroring
 * `resolveCrossBackendFuzzTier()` in
 * `packages/core/test/properties/seed.ts`. Precedence:
 *
 *   1. `CAUSL_FUZZ_TIER` — named tier ('default' | 'pr' | 'nightly' |
 *      'cargo-fuzz').
 *   2. `CAUSL_FUZZ_TRIALS` — numeric override.
 *   3. Fallback: 1000 (the SPEC §15.2 floor).
 *
 * @internal
 */
function resolveTierNumRuns(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env
  if (!env) return DEFAULT_TRIALS
  const named = env.CAUSL_FUZZ_TIER?.toLowerCase().trim()
  if (named && named in FUZZ_TIER_NUM_RUNS) {
    return FUZZ_TIER_NUM_RUNS[named as keyof typeof FUZZ_TIER_NUM_RUNS]
  }
  const trialsRaw = env.CAUSL_FUZZ_TRIALS
  if (trialsRaw) {
    const parsed = Number.parseInt(trialsRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_TRIALS
}

/**
 * Tier-aware variant of {@link propertyTrials}. Resolves the active
 * fuzz tier (`CAUSL_FUZZ_TIER` / `CAUSL_FUZZ_TRIALS` env vars) and
 * applies the tier's `numRuns` unless the caller explicitly overrides
 * it. Use this instead of `propertyTrials(label, { numRuns: 1000 })`:
 * the hardcoded `numRuns: 1000` callsite silently bypasses the tier
 * system shipped by PR #1097 (issue #1073), pinning every property at
 * the 1000-trial floor regardless of `CAUSL_FUZZ_TIER`.
 *
 * Callers may still pass `unsafeTrials` to drop below the floor; the
 * SPEC §15.2 ≥1000 floor enforcement is preserved exactly as
 * `propertyTrials` enforces it.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/1153}
 */
export function tieredPropertyTrials(
  label: string,
  options: PropertyTrialsOptions = {},
): PropertyTrialsConfig {
  // Explicit numRuns / unsafeTrials override the resolved tier — the
  // override-by-callsite ergonomic is preserved so a single property
  // can still pin a custom budget if needed.
  if (options.numRuns !== undefined || options.unsafeTrials !== undefined) {
    return propertyTrials(label, options)
  }
  return propertyTrials(label, { ...options, numRuns: resolveTierNumRuns() })
}
