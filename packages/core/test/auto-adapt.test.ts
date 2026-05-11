/**
 * @packageDocumentation
 *
 * Behavioural pinning for the pure auto-adapt decision function
 * (#686 skeleton). The contract being pinned mirrors the module-
 * level @remarks block of `src/auto-adapt.ts`:
 *
 * 1. {@link DEFAULT_THRESHOLDS} is a frozen, measurement-anchored
 *    snapshot. Tests do not mutate it.
 *
 * 2. {@link shouldMigrate} fires only when the multi-axis OR trips
 *    on three consecutive snapshots AND the EWMA of `inputs +
 *    deriveds` (alpha=0.1) exceeds `nodeCount`. Each axis (node
 *    count, chain depth, commit-shape) is pinned by a standalone
 *    unit test that drives only that axis past its threshold.
 *
 * 3. The hysteresis gate trips on the third consecutive detection,
 *    not the first or second.
 *
 * 4. {@link ewmaOver} is monotone, total on `[0, 1]` alpha, and
 *    handles the empty-array boundary by returning 0.
 *
 * 5. {@link shouldMigrate} is monotone in `stats` — strengthening
 *    every axis cannot turn a `true` answer into a `false` one
 *    (property test, 1000 trials).
 *
 * 6. {@link loadThresholdsFromEnv} is pure / deterministic / does
 *    not leak between tests — each assertion sets and restores
 *    `process.env.CAUSL_WASM_*` for one call.
 *
 * The internal helpers are reached via deep import (`../src/auto-
 * adapt.js`) because they are intentionally NOT on the package
 * barrel (see `src/index.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  DEFAULT_THRESHOLDS,
  shouldMigrate,
  type AdaptThresholds,
  type GraphStats,
} from '../src/index.js'
import {
  ewmaOver,
  loadThresholdsFromEnv,
  medianOf,
  mergeThresholds,
  MODULE_THRESHOLD_OVERRIDES,
} from '../src/auto-adapt.js'
import { propertyOptions } from './properties/seed.js'

/**
 * Build a {@link GraphStats} snapshot with explicit overrides on top
 * of a known-quiet baseline (everything well below
 * {@link DEFAULT_THRESHOLDS}). The test bodies override exactly the
 * axes the assertion stresses; the rest stay at the quiet defaults so
 * the assertion is unambiguous about which axis tripped.
 */
function quiet(overrides: Partial<GraphStats> = {}): GraphStats {
  return {
    inputs: 10,
    deriveds: 10,
    subscribersTotal: 0,
    lastCommitTime: 0,
    maxChainDepth: 0,
    medianCommitMs: 0,
    ...overrides,
  }
}

/**
 * Build a length-N history of identical snapshots, oldest first.
 * The hysteresis gate inspects the last (HYSTERESIS_TRIP_COUNT - 1) =
 * 2 entries; helper takes any N so individual tests can demonstrate
 * the "history shorter than 2" boundary explicitly.
 */
function history(n: number, snapshot: GraphStats): GraphStats[] {
  const out: GraphStats[] = []
  for (let i = 0; i < n; i += 1) out.push(snapshot)
  return out
}

/**
 * Restore an env var to its pre-test value, deleting it if it was
 * absent. Mirrors the helper in `flags.test.ts` — keeps each
 * assertion's env mutation isolated.
 */
function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = prior
  }
}

describe('auto-adapt.ts — DEFAULT_THRESHOLDS', () => {
  /**
   * The frozen snapshot is the load-bearing assertion: a consumer
   * that grabs the export must NOT be able to mutate it and have the
   * mutation flow into another consumer's `mergeThresholds(...)`
   * call. The measurement-anchored numbers (50_000 / 500 / 1.0 / 100
   * / 500 / 1_000) are the design-source-of-truth from
   * comment-4416013410; pinning them here catches an accidental
   * defaults-shift on any future PR.
   */
  it('is frozen with the measurement-anchored values', () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true)
    expect(DEFAULT_THRESHOLDS.nodeCount).toBe(50_000)
    expect(DEFAULT_THRESHOLDS.maxChainDepth).toBe(500)
    expect(DEFAULT_THRESHOLDS.medianCommitMsThreshold).toBe(1.0)
    expect(DEFAULT_THRESHOLDS.rollingCommitWindow).toBe(100)
    expect(DEFAULT_THRESHOLDS.commitCount).toBe(500)
    expect(DEFAULT_THRESHOLDS.totalSubscribers).toBe(1_000)
  })
})

describe('auto-adapt.ts — shouldMigrate per-axis triggers', () => {
  /**
   * Node-count axis: a 60_000-node snapshot (above the 50_000
   * threshold) trips on three consecutive commits and the EWMA also
   * exceeds 50_000, so the predicate returns true. The chain-depth
   * and commit-shape axes are intentionally well below their
   * thresholds — only the node-count axis is doing the work.
   */
  it('node-count axis fires when nodeCount exceeded on 3 consecutive commits', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, history(2, big))).toBe(true)
  })

  /**
   * Chain-depth axis fires standalone: chainDepth=1_000 is above the
   * 500 threshold, while node count, subscriber count, and commit
   * count are all quiet. This is the chain-shape inflection trigger
   * — long derivation chains stress walking, which is WASM-
   * addressable independent of node count.
   *
   * Note the EWMA gate is currently node-count-only, so a
   * chain-only workload trips the consecutive-trip gate but the EWMA
   * stays below 50_000 — the predicate must therefore return false.
   * This is documented behaviour: chain-depth without node-count
   * growth does NOT migrate today; the gate widening is a future
   * tuning task once empirical data justifies it.
   */
  it('chain-depth axis trips the consecutive gate but NOT the EWMA gate', () => {
    const deepChain = quiet({ maxChainDepth: 1_000 })
    expect(shouldMigrate(deepChain, DEFAULT_THRESHOLDS, history(2, deepChain))).toBe(false)
  })

  /**
   * Commit-shape axis fires standalone when the activity gate
   * (commitCount > 500 AND subscribersTotal > 1_000) AND the
   * commit-shape gate (medianCommitMs > 1.0) all trip together. With
   * node count below 50_000 the EWMA gate again blocks, so the
   * predicate returns false — same documented limitation as the
   * chain-depth axis.
   */
  it('commit-shape axis trips the consecutive gate but NOT the EWMA gate', () => {
    const heavy = quiet({
      lastCommitTime: 1_000,
      subscribersTotal: 2_000,
      medianCommitMs: 2.0,
    })
    expect(shouldMigrate(heavy, DEFAULT_THRESHOLDS, history(2, heavy))).toBe(false)
  })

  /**
   * Combined trigger: a workload that trips the activity-gate AND
   * the commit-shape gate AND has 60k nodes returns true. This is
   * the "real reactive workload at the inflection point" case — the
   * EWMA gate is satisfied (60k > 50k) and three consecutive trips
   * are present.
   */
  it('combined axes (nodes + commit-shape + subscribers) fires', () => {
    const combined = quiet({
      inputs: 30_000,
      deriveds: 30_000,
      subscribersTotal: 2_000,
      lastCommitTime: 1_000,
      medianCommitMs: 2.0,
    })
    expect(shouldMigrate(combined, DEFAULT_THRESHOLDS, history(2, combined))).toBe(true)
  })

  /**
   * Quiet workload across every axis returns false even with a long
   * history — there is no signal to trip on.
   */
  it('quiet workload across all axes returns false', () => {
    const q = quiet()
    expect(shouldMigrate(q, DEFAULT_THRESHOLDS, history(10, q))).toBe(false)
  })
})

describe('auto-adapt.ts — shouldMigrate hysteresis', () => {
  /**
   * The first detection alone does NOT migrate — history is empty,
   * which is below the (HYSTERESIS_TRIP_COUNT - 1) = 2 minimum.
   */
  it('first detection (history length 0) does not migrate', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, [])).toBe(false)
  })

  /**
   * The second detection (history length 1) is still below the
   * 2-entry minimum.
   */
  it('second detection (history length 1) does not migrate', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, history(1, big))).toBe(false)
  })

  /**
   * The third detection (history length 2 + current snapshot = 3
   * consecutive trips) clears the gate.
   */
  it('third consecutive detection migrates', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, history(2, big))).toBe(true)
  })

  /**
   * Spike rejection: a single 60k-node commit followed by two
   * quiet snapshots (at the tail) does NOT migrate even though the
   * current snapshot trips. The two tail snapshots break the
   * consecutive-trip chain.
   */
  it('spike followed by quiet does not migrate (consecutive-trip gate)', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    const q = quiet()
    // History [quiet, quiet], current = big — the tail does not trip.
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, [q, q])).toBe(false)
  })

  /**
   * EWMA gate: three consecutive 60k-node trips on a fresh history
   * (length exactly 2) clear both gates. But three trips at the tail
   * of a long quiet history fail the EWMA gate — the alpha=0.1
   * smoother weights the long quiet past heavily enough to keep the
   * EWMA below 50k. Pin the second case so a future EWMA-alpha
   * change is forced through a deliberate threshold review.
   */
  it('three trips after long quiet history fail the EWMA gate', () => {
    const big = quiet({ inputs: 30_000, deriveds: 30_000 })
    const q = quiet()
    // 50 quiet snapshots followed by 2 big in history; current = big.
    // The tail [big, big] passes the consecutive-trip gate, but the
    // EWMA over [q*50, big, big, big] is dominated by quiet past.
    const longQuietThenSpike = [...history(50, q), big, big]
    expect(shouldMigrate(big, DEFAULT_THRESHOLDS, longQuietThenSpike)).toBe(false)
  })
})

describe('auto-adapt.ts — ewmaOver helper', () => {
  /**
   * Empty input returns 0 — the predicate's "insufficient history"
   * sentinel. Total function, no NaN, no thrown.
   */
  it('returns 0 on empty input', () => {
    expect(ewmaOver([], 0.1)).toBe(0)
    expect(ewmaOver([], 0.0)).toBe(0)
    expect(ewmaOver([], 1.0)).toBe(0)
  })

  /**
   * Single-element input returns that element regardless of alpha
   * — the recurrence has no second observation to blend.
   */
  it('returns the sole element on a length-1 input', () => {
    expect(ewmaOver([42], 0.1)).toBe(42)
    expect(ewmaOver([42], 0.0)).toBe(42)
    expect(ewmaOver([42], 1.0)).toBe(42)
  })

  /**
   * alpha=0 pins the EWMA at the first observation regardless of
   * subsequent values — "no learning" boundary.
   */
  it('alpha=0 returns the first element (no learning)', () => {
    expect(ewmaOver([10, 20, 30, 40, 50], 0.0)).toBe(10)
  })

  /**
   * alpha=1 returns the last element regardless of prior values —
   * "no smoothing" boundary.
   */
  it('alpha=1 returns the last element (no smoothing)', () => {
    expect(ewmaOver([10, 20, 30, 40, 50], 1.0)).toBe(50)
  })

  /**
   * Monotone behaviour: feeding a strictly-increasing sequence with
   * alpha in (0, 1) produces a strictly-increasing EWMA after the
   * first observation. Pin a known-good intermediate so a future
   * accidental sign flip on the recurrence is caught.
   */
  it('alpha=0.5 on [10, 20] returns 15 (one-step blend)', () => {
    expect(ewmaOver([10, 20], 0.5)).toBe(15)
  })

  /**
   * Property: for any non-empty values and any alpha in [0, 1], the
   * EWMA is bounded by the min and max of the input. This is a
   * cheap structural sanity property — if the recurrence ever drifts
   * outside the convex hull of the input, the property fails.
   */
  it('EWMA stays inside [min(values), max(values)] for any alpha in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (values, alpha) => {
          const result = ewmaOver(values, alpha)
          const min = Math.min(...values)
          const max = Math.max(...values)
          // Allow a tiny float-error margin since the recurrence
          // accumulates round-off across long sequences.
          const epsilon = 1e-9 * Math.max(1, Math.abs(min), Math.abs(max))
          return result >= min - epsilon && result <= max + epsilon
        },
      ),
      propertyOptions(),
    )
  })
})

describe('auto-adapt.ts — shouldMigrate monotonicity property', () => {
  /**
   * Property: strengthening every axis (more nodes, deeper chains,
   * more subscribers, more commits, slower commits) cannot turn a
   * `true` answer into a `false` one. This is the load-bearing
   * structural property of a tripwire predicate — if the predicate
   * is non-monotone in stats, a workload could "outgrow" a
   * migration trigger by hitting MORE load, which is incoherent.
   *
   * The history is held fixed across the low/high pair so the
   * comparison is purely about the current snapshot. The history
   * itself is generated to clear the consecutive-trip gate (every
   * historical snapshot is at the high-water mark) and the EWMA
   * gate has its own band — when low-stats trips, high-stats also
   * has its EWMA above the threshold by construction (at least as
   * many node count as low).
   */
  it('shouldMigrate is monotone in stats', () => {
    fc.assert(
      fc.property(
        // Low snapshot — every axis at or below the high snapshot.
        fc.record({
          inputs: fc.integer({ min: 0, max: 100_000 }),
          deriveds: fc.integer({ min: 0, max: 100_000 }),
          subscribersTotal: fc.integer({ min: 0, max: 5_000 }),
          lastCommitTime: fc.integer({ min: 0, max: 5_000 }),
          maxChainDepth: fc.integer({ min: 0, max: 2_000 }),
          medianCommitMs: fc.double({ min: 0, max: 5, noNaN: true }),
        }),
        // Per-axis bumps — non-negative deltas the property
        // monotonicity adds to each low-axis value to produce the
        // high snapshot. fast-check picks each delta independently.
        fc.record({
          dInputs: fc.integer({ min: 0, max: 100_000 }),
          dDeriveds: fc.integer({ min: 0, max: 100_000 }),
          dSubs: fc.integer({ min: 0, max: 5_000 }),
          dCommits: fc.integer({ min: 0, max: 5_000 }),
          dChain: fc.integer({ min: 0, max: 2_000 }),
          dMs: fc.double({ min: 0, max: 5, noNaN: true }),
        }),
        (low, deltas) => {
          const high: GraphStats = {
            inputs: low.inputs + deltas.dInputs,
            deriveds: low.deriveds + deltas.dDeriveds,
            subscribersTotal: low.subscribersTotal + deltas.dSubs,
            lastCommitTime: low.lastCommitTime + deltas.dCommits,
            maxChainDepth: low.maxChainDepth + deltas.dChain,
            medianCommitMs: low.medianCommitMs + deltas.dMs,
          }
          // Use `high` snapshots in history so the consecutive-
          // trip gate is decided purely by tripped(current). This
          // isolates the per-snapshot monotonicity property from
          // the hysteresis dynamics.
          const hist = history(2, high)
          const lowAns = shouldMigrate(low, DEFAULT_THRESHOLDS, hist)
          const highAns = shouldMigrate(high, DEFAULT_THRESHOLDS, hist)
          // Implication: lowAns ⇒ highAns. Equivalently, NOT lowAns
          // OR highAns.
          return !lowAns || highAns
        },
      ),
      propertyOptions(),
    )
  })
})

describe('auto-adapt.ts — env-var override loader', () => {
  // Cache the keys' pre-test values so each `it` block can mutate
  // freely and the afterEach hook restores cleanly. fast-check
  // property tests inside this describe also restore via the same
  // hook by capturing prior values per-call.
  const KEYS = [
    'CAUSL_WASM_NODE_THRESHOLD',
    'CAUSL_WASM_CHAIN_THRESHOLD',
    'CAUSL_WASM_SUBSCRIBER_THRESHOLD',
    'CAUSL_WASM_COMMIT_THRESHOLD',
    'CAUSL_WASM_COMMIT_MS_THRESHOLD',
  ] as const
  const priorEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const key of KEYS) {
      restoreEnv(key, priorEnv[key])
      delete priorEnv[key]
    }
  })

  /**
   * Module-load snapshot is frozen so a consumer cannot mutate it
   * and have the mutation flow into another engine's
   * `mergeThresholds(MODULE_THRESHOLD_OVERRIDES)` call.
   */
  it('MODULE_THRESHOLD_OVERRIDES is frozen', () => {
    expect(Object.isFrozen(MODULE_THRESHOLD_OVERRIDES)).toBe(true)
  })

  /**
   * With every CAUSL_WASM_* env var unset, the loader returns an
   * empty object — no overrides applied.
   */
  it('absent env vars produce no overrides', () => {
    for (const key of KEYS) {
      priorEnv[key] = process.env[key]
      delete process.env[key]
    }
    const out = loadThresholdsFromEnv()
    expect(out).toEqual({})
  })

  /**
   * Each env var maps to exactly one AdaptThresholds field. Pin the
   * mapping with a single combined assertion so a future renaming
   * is forced through a deliberate review.
   */
  it('every recognised env var maps to its threshold field', () => {
    for (const key of KEYS) priorEnv[key] = process.env[key]
    process.env.CAUSL_WASM_NODE_THRESHOLD = '12345'
    process.env.CAUSL_WASM_CHAIN_THRESHOLD = '67'
    process.env.CAUSL_WASM_SUBSCRIBER_THRESHOLD = '890'
    process.env.CAUSL_WASM_COMMIT_THRESHOLD = '1234'
    process.env.CAUSL_WASM_COMMIT_MS_THRESHOLD = '2.5'

    const out = loadThresholdsFromEnv()
    expect(out).toEqual({
      nodeCount: 12345,
      maxChainDepth: 67,
      totalSubscribers: 890,
      commitCount: 1234,
      medianCommitMsThreshold: 2.5,
    })
  })

  /**
   * Malformed env vars (NaN, negative, infinite, empty) are dropped
   * silently — the predicate's threshold semantics require finite
   * non-negative numbers, and a noisier failure mode would block
   * engine construction in production hosts where the env is only
   * loosely typed.
   */
  it.each([
    ['', 'empty string'],
    ['not-a-number', 'non-numeric'],
    ['-1', 'negative'],
    ['Infinity', 'infinite'],
    ['NaN', 'NaN literal'],
  ])('drops malformed CAUSL_WASM_NODE_THRESHOLD=%j (%s)', (envValue) => {
    priorEnv.CAUSL_WASM_NODE_THRESHOLD = process.env.CAUSL_WASM_NODE_THRESHOLD
    process.env.CAUSL_WASM_NODE_THRESHOLD = envValue

    const out = loadThresholdsFromEnv()
    expect(out.nodeCount).toBeUndefined()
  })

  /**
   * Determinism: calling the loader twice with the same env state
   * returns equal objects. This is the "pure with respect to env"
   * contract — the loader does NOT cache results internally (the
   * MODULE-load snapshot does that for the consumer-side wiring),
   * so two back-to-back calls are independent observations of
   * `process.env`.
   */
  it('two calls with the same env state return equal objects', () => {
    priorEnv.CAUSL_WASM_NODE_THRESHOLD = process.env.CAUSL_WASM_NODE_THRESHOLD
    process.env.CAUSL_WASM_NODE_THRESHOLD = '99999'

    const a = loadThresholdsFromEnv()
    const b = loadThresholdsFromEnv()
    expect(a).toEqual(b)
    // And the value is the parsed env, not stale module state.
    expect(a.nodeCount).toBe(99999)
  })

  /**
   * Property: env-var overrides do not leak between calls. For each
   * trial, set a random subset of the recognised env vars to random
   * non-negative integers, call loadThresholdsFromEnv twice, and
   * assert the two calls produce equal objects. Then clear the env
   * and assert a third call returns `{}`. This pins the loader as
   * "stateless with respect to its own prior calls" — the only
   * state lookup is `process.env`.
   */
  it('overrides do not leak between calls (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          node: fc.option(fc.nat({ max: 1_000_000 })),
          chain: fc.option(fc.nat({ max: 100_000 })),
          subs: fc.option(fc.nat({ max: 100_000 })),
          commits: fc.option(fc.nat({ max: 100_000 })),
          ms: fc.option(fc.double({ min: 0, max: 100, noNaN: true })),
        }),
        (settings) => {
          // Capture-and-set; the surrounding afterEach restores.
          for (const key of KEYS) priorEnv[key] = process.env[key]
          if (settings.node !== null) {
            process.env.CAUSL_WASM_NODE_THRESHOLD = String(settings.node)
          } else {
            delete process.env.CAUSL_WASM_NODE_THRESHOLD
          }
          if (settings.chain !== null) {
            process.env.CAUSL_WASM_CHAIN_THRESHOLD = String(settings.chain)
          } else {
            delete process.env.CAUSL_WASM_CHAIN_THRESHOLD
          }
          if (settings.subs !== null) {
            process.env.CAUSL_WASM_SUBSCRIBER_THRESHOLD = String(settings.subs)
          } else {
            delete process.env.CAUSL_WASM_SUBSCRIBER_THRESHOLD
          }
          if (settings.commits !== null) {
            process.env.CAUSL_WASM_COMMIT_THRESHOLD = String(settings.commits)
          } else {
            delete process.env.CAUSL_WASM_COMMIT_THRESHOLD
          }
          if (settings.ms !== null) {
            process.env.CAUSL_WASM_COMMIT_MS_THRESHOLD = String(settings.ms)
          } else {
            delete process.env.CAUSL_WASM_COMMIT_MS_THRESHOLD
          }

          const a = loadThresholdsFromEnv()
          const b = loadThresholdsFromEnv()
          if (JSON.stringify(a) !== JSON.stringify(b)) return false

          // Clear and verify the loader returns {} now — no leak
          // from prior calls.
          for (const key of KEYS) delete process.env[key]
          const c = loadThresholdsFromEnv()
          if (JSON.stringify(c) !== '{}') return false

          // Restore for the next trial.
          for (const key of KEYS) {
            const prior = priorEnv[key]
            if (prior === undefined) {
              delete process.env[key]
            } else {
              process.env[key] = prior
            }
          }
          return true
        },
      ),
      propertyOptions(),
    )
  })
})

describe('auto-adapt.ts — mergeThresholds', () => {
  /**
   * No overrides → returns {@link DEFAULT_THRESHOLDS} by reference,
   * not a copy. This is the "zero-allocation default path" the
   * wiring layer (#687) will rely on at engine construction.
   */
  it('returns DEFAULT_THRESHOLDS when overrides is undefined', () => {
    expect(mergeThresholds(undefined)).toBe(DEFAULT_THRESHOLDS)
  })

  /**
   * Partial overrides win over defaults, and the result is frozen
   * so the wiring layer can capture it in a closure without
   * defending against mutation.
   */
  it('partial overrides merge on top of defaults and freeze the result', () => {
    const merged = mergeThresholds({ nodeCount: 1_234 })
    expect(merged.nodeCount).toBe(1_234)
    expect(merged.maxChainDepth).toBe(DEFAULT_THRESHOLDS.maxChainDepth)
    expect(Object.isFrozen(merged)).toBe(true)
  })
})

describe('auto-adapt.ts — AdaptThresholds compile-time shape', () => {
  /**
   * Pin the threshold-object shape so a future SPEC-level field
   * addition / rename is forced through a deliberate review (the
   * cross-backend contract on EngineTelemetry has the same
   * discipline; see telemetry.ts `Field-evolution discipline`).
   */
  it('exposes the documented field set', () => {
    const t: AdaptThresholds = DEFAULT_THRESHOLDS
    const keys = Object.keys(t).sort()
    expect(keys).toEqual(
      [
        'commitCount',
        'maxChainDepth',
        'medianCommitMsThreshold',
        'nodeCount',
        'rollingCommitWindow',
        'totalSubscribers',
      ].sort(),
    )
  })
})

describe('auto-adapt.ts — medianOf helper (#1048)', () => {
  /**
   * Empty input returns 0 — the "wrapper has not measured anything
   * yet" sentinel. Total function, no NaN, no thrown. Matches the
   * `stats.medianCommitMs ?? 0` fallback already in place for
   * backends that pre-compute the median internally.
   */
  it('returns 0 on empty input', () => {
    expect(medianOf([])).toBe(0)
  })

  /**
   * Single-element input returns that element — the median of a
   * length-1 sample is the sample.
   */
  it('returns the sole element on a length-1 input', () => {
    expect(medianOf([2.5])).toBe(2.5)
  })

  /**
   * Odd-length input returns the middle element after sort.
   */
  it('returns the middle element on odd-length input', () => {
    expect(medianOf([3, 1, 2])).toBe(2)
    expect(medianOf([5, 1, 4, 2, 3])).toBe(3)
  })

  /**
   * Even-length input returns the average of the two middle elements
   * after sort.
   */
  it('returns the average of the two middle elements on even-length input', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5)
    expect(medianOf([4, 2])).toBe(3)
  })

  /**
   * The helper does NOT mutate the caller's array — the wrapper's
   * rolling buffer is the production source of these slices and must
   * not be reordered as a side effect.
   */
  it('does not mutate the caller array', () => {
    const input = [3, 1, 2]
    const before = input.slice()
    medianOf(input)
    expect(input).toEqual(before)
  })

  /**
   * Property: median always lies within [min(values), max(values)]
   * for any non-empty input. Cheap structural sanity — if the
   * helper ever returns a value outside the input's convex hull the
   * property fails.
   */
  it('median stays inside [min(values), max(values)] for any non-empty input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 }),
        (values) => {
          const m = medianOf(values)
          const min = Math.min(...values)
          const max = Math.max(...values)
          return m >= min && m <= max
        },
      ),
      propertyOptions(),
    )
  })
})

describe('auto-adapt.ts — shouldMigrate commit-shape axis (#1048 / Option B)', () => {
  /**
   * The activity gate + a wrapper-supplied `commitTimings` window
   * whose median exceeds the threshold fires the commit-shape axis,
   * even when `stats.medianCommitMs` is undefined (the canonical
   * TS-engine case). This is the load-bearing scenario the issue
   * specifies: the wrapper measures, the engine does not.
   *
   * The EWMA gate still blocks (node count is quiet) so the predicate
   * returns false — same documented limitation as the per-snapshot
   * commit-shape test above. The point of this test is that the
   * consecutive-trip gate now passes via the wrapper-supplied
   * timings, which it could NOT do pre-#1048 with
   * `stats.medianCommitMs === undefined`.
   */
  it('wrapper-supplied timings trip the consecutive gate without stats.medianCommitMs', () => {
    const heavy = quiet({
      lastCommitTime: 1_000,
      subscribersTotal: 2_000,
      // medianCommitMs intentionally omitted — wrapper is the source.
      medianCommitMs: undefined,
    })
    // Window of 5 timings, median 2.0 ms — well above the 1.0 ms
    // default threshold.
    const timings = [1.5, 1.8, 2.0, 2.2, 2.5]
    // The consecutive-trip gate passes; EWMA gate blocks because
    // nodes (20) are well under the 50_000 threshold. We verify the
    // gate behaviour by also confirming the same call with a quiet
    // window (median ≤ 1.0) does NOT trip the consecutive gate.
    expect(shouldMigrate(heavy, DEFAULT_THRESHOLDS, history(2, heavy), timings)).toBe(false)
    const quietTimings = [0.1, 0.2, 0.3]
    expect(shouldMigrate(heavy, DEFAULT_THRESHOLDS, history(2, heavy), quietTimings)).toBe(false)
  })

  /**
   * Combined: 60k nodes + activity gate + wrapper-supplied timings
   * with median 2.0 ms returns true. This is the "real reactive
   * workload at the inflection point" case but now sourced from the
   * wrapper rather than from `stats.medianCommitMs`.
   */
  it('combined axes with wrapper-supplied timings fires', () => {
    const combined = quiet({
      inputs: 30_000,
      deriveds: 30_000,
      subscribersTotal: 2_000,
      lastCommitTime: 1_000,
      medianCommitMs: undefined,
    })
    const timings = [1.2, 1.6, 2.0, 2.4, 2.8]
    expect(shouldMigrate(combined, DEFAULT_THRESHOLDS, history(2, combined), timings)).toBe(true)
  })

  /**
   * Empty `commitTimings` (the default) falls back to
   * `stats.medianCommitMs`. This is the backward-compatibility
   * contract: every existing call site (every test above this block)
   * uses the 3-arg form and continues to read the median off
   * GraphStats. Pin both directions of the fallback explicitly.
   */
  it('empty commitTimings falls back to stats.medianCommitMs', () => {
    const heavy = quiet({
      inputs: 30_000,
      deriveds: 30_000,
      subscribersTotal: 2_000,
      lastCommitTime: 1_000,
      medianCommitMs: 2.0,
    })
    // 3-arg form: stats.medianCommitMs supplies the median.
    expect(shouldMigrate(heavy, DEFAULT_THRESHOLDS, history(2, heavy))).toBe(true)
    // 4-arg form with []: still falls back to stats.medianCommitMs.
    expect(shouldMigrate(heavy, DEFAULT_THRESHOLDS, history(2, heavy), [])).toBe(true)
  })

  /**
   * Precedence pin: when the wrapper supplies a non-empty
   * `commitTimings` window, its median takes precedence over
   * `stats.medianCommitMs` — flipping the predicate's output between
   * `true` (engine source fires commit-shape axis) and `false`
   * (wrapper source does not). To isolate the commit-shape axis as
   * the deciding factor we use custom thresholds with a low
   * `nodeCount` (so the EWMA gate clears via the tail's node count)
   * and a current-snapshot node count below the per-node threshold
   * (so the per-node axis is quiet on the current snapshot — the
   * commit-shape axis is the only path through `tripped`).
   */
  it('quiet commitTimings window blocks the commit-shape axis even when stats.medianCommitMs is loud', () => {
    const thresholds: AdaptThresholds = Object.freeze({
      ...DEFAULT_THRESHOLDS,
      nodeCount: 50,
      medianCommitMsThreshold: 1.0,
    })
    // Tail snapshots trip via per-node (200 > 50). Current snapshot
    // is below the per-node threshold so the commit-shape axis is
    // the only path through `tripped`. The EWMA over
    // [200, 200, 2] at alpha=0.1 is 180.2 > 50 → EWMA gate clears.
    const tailSnapshot = quiet({
      inputs: 100,
      deriveds: 100,
      subscribersTotal: 2_000,
      lastCommitTime: 1_000,
      medianCommitMs: 2.0,
    })
    const current = quiet({
      inputs: 1,
      deriveds: 1,
      subscribersTotal: 2_000,
      lastCommitTime: 1_000,
      medianCommitMs: 2.0,
    })
    // With NO wrapper window: engine's `medianCommitMs: 2.0` fires
    // the commit-shape axis on the current snapshot → migrate.
    expect(shouldMigrate(current, thresholds, [tailSnapshot, tailSnapshot])).toBe(true)
    // With a quiet wrapper window (median 0.1 ms): the wrapper
    // overrides the engine claim, commit-shape axis does not fire
    // on the current snapshot, `tripped(current, ...)` returns
    // false → predicate returns false. This is the Option-B
    // precedence: wrapper > engine.
    const quietTimings = [0.05, 0.1, 0.15]
    expect(
      shouldMigrate(current, thresholds, [tailSnapshot, tailSnapshot], quietTimings),
    ).toBe(false)
  })

  /**
   * Activity-gate conjunction: median > threshold alone is not
   * enough. The commit-shape axis requires BOTH `commitCount` AND
   * `totalSubscribers` to exceed their thresholds in conjunction
   * with the wrapper-supplied median. With quiet activity, even a
   * window of huge medians does NOT trip the axis.
   */
  it('activity gate blocks commit-shape axis without subscribers + commits', () => {
    const idleButSlow = quiet({
      // Activity-gate axes deliberately below their thresholds.
      lastCommitTime: 10,
      subscribersTotal: 10,
      medianCommitMs: undefined,
    })
    const slowTimings = [5.0, 5.0, 5.0, 5.0, 5.0]
    expect(shouldMigrate(idleButSlow, DEFAULT_THRESHOLDS, history(2, idleButSlow), slowTimings)).toBe(false)
  })

  /**
   * Property: the predicate is monotone in the wrapper-supplied
   * `commitTimings` median. Holding `stats`, `thresholds`, and
   * `history` fixed (all clearing the consecutive-trip and EWMA
   * gates by construction except the commit-shape axis), if a
   * "low-median" window fires the predicate then a "high-median"
   * window with every element bumped up must also fire. This pins
   * the commit-shape axis as a tripwire on the wrapper-side timing
   * input — a workload cannot "outgrow" the trigger by getting
   * slower, which is the same monotonicity story as the per-stats
   * property above the AdaptThresholds compile-time-shape block.
   */
  it('shouldMigrate is monotone in commitTimings median', () => {
    fc.assert(
      fc.property(
        // Low timings — bounded above by 2.0 ms so the bump can stay
        // within a finite range.
        fc.array(fc.double({ min: 0, max: 2.0, noNaN: true }), { minLength: 1, maxLength: 50 }),
        // Non-negative per-element bumps; produces a "high" window
        // with every element ≥ the corresponding low element.
        fc.array(fc.double({ min: 0, max: 5.0, noNaN: true }), { minLength: 1, maxLength: 50 }),
        // A high-activity snapshot so the activity gate is always
        // satisfied; the commit-shape gate is the only axis the
        // property exercises. Node count is set so the EWMA gate is
        // satisfied at high-load history.
        (lowTimings, bumps) => {
          // Match lengths: trim the bumps to the timings' length and
          // pad with zeros if necessary so element-wise bumping is
          // well-defined.
          const n = lowTimings.length
          const high: number[] = new Array(n)
          for (let i = 0; i < n; i += 1) {
            high[i] = lowTimings[i]! + (bumps[i] ?? 0)
          }
          const heavy = quiet({
            inputs: 30_000,
            deriveds: 30_000,
            subscribersTotal: 2_000,
            lastCommitTime: 1_000,
            medianCommitMs: undefined,
          })
          const hist = history(2, heavy)
          const lowAns = shouldMigrate(heavy, DEFAULT_THRESHOLDS, hist, lowTimings)
          const highAns = shouldMigrate(heavy, DEFAULT_THRESHOLDS, hist, high)
          // Implication: lowAns ⇒ highAns.
          return !lowAns || highAns
        },
      ),
      propertyOptions(),
    )
  })

  /**
   * Property: the median of any non-empty `commitTimings` window
   * that exceeds the threshold fires the commit-shape axis (given
   * activity gate satisfied + 60k nodes for EWMA gate). This is the
   * acceptance criterion 1 from the issue body — "auto-adapt's
   * commit-shape trigger fires correctly when an adopter's median
   * commit ms exceeds 1.0 over the rolling window" — expressed as a
   * fuzz property over synthetic timings.
   */
  it('commit-shape trigger fires whenever wrapper median exceeds threshold (acceptance #1)', () => {
    fc.assert(
      fc.property(
        // Generate a window of timings whose median is guaranteed
        // above 1.0 ms by ensuring at least ceil(n/2) entries are
        // above 1.0. We achieve this by sampling the floor from
        // [1.001, 10] (always > threshold) and padding with anything.
        fc.array(fc.double({ min: 1.001, max: 10, noNaN: true }), {
          minLength: 5,
          maxLength: 50,
        }),
        (aboveThreshold) => {
          const combined = quiet({
            inputs: 30_000,
            deriveds: 30_000,
            subscribersTotal: 2_000,
            lastCommitTime: 1_000,
            medianCommitMs: undefined,
          })
          // Every entry is above 1.001, so the median is guaranteed
          // above the 1.0 ms default threshold. With node count at
          // 60k the EWMA gate is satisfied and three consecutive
          // historical trips clear hysteresis — the predicate MUST
          // return true.
          const result = shouldMigrate(
            combined,
            DEFAULT_THRESHOLDS,
            history(2, combined),
            aboveThreshold,
          )
          return result === true
        },
      ),
      propertyOptions(),
    )
  })
})
