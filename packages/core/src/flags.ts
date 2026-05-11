/**
 * @packageDocumentation
 *
 * Engine-level feature-flag protocol (#706b).
 *
 * Centralises the engine's `CAUSL_*` environment-variable parsing into a
 * single module loaded once at startup, so that hot paths in
 * {@link createCausl | graph.ts} and {@link ./internal-dispatch.ts}
 * pay the env-lookup cost exactly once per process rather than on every
 * commit, derivation walk, or explanation frame allocation.
 *
 * @remarks
 * The design follows three rules:
 *
 * 1. **Read once at module load.** {@link MODULE_FLAGS} is the frozen
 *    snapshot of {@link loadFlagsFromEnv} captured the first time this
 *    module is imported. Subsequent reads of `process.env` by the engine
 *    are forbidden — every flag-driven branch points at this snapshot.
 *    That is the design contract that keeps the per-commit hot path free
 *    of `process.env` lookups.
 *
 * 2. **Engine-instance overrides via `experimentalFlags`.**
 *    {@link createCausl}'s options accept `experimentalFlags?:
 *    Partial<CauslFlags>` so a single test or a single embedded engine
 *    instance can flip a flag without mutating the process-wide env.
 *    The construction-time merge is `{...MODULE_FLAGS, ...overrides}`.
 *
 * 3. **One source of truth per flag.** A consumer module imports either
 *    {@link MODULE_FLAGS} (for module-scope constants) or the merged
 *    flags object captured by `createCausl` (for engine-instance scope).
 *    The same flag is never re-parsed inline elsewhere.
 *
 * The current surface lists exactly one flag — {@link
 * CauslFlags.freezeOffInProd} — because that is the only consumer that
 * has shipped (PR #732 / #702). Additional flags are added when their
 * consumer ships, not preemptively.
 */

/**
 * Engine-level feature flags surfaced through `CAUSL_*` env vars
 * and `createCausl({ experimentalFlags })`.
 *
 * @remarks
 * Every field on this interface is a deliberate, audit-tracked opt-in
 * that gates a measured engine behaviour. Fields are added here only
 * when a consumer module ships that needs them; the bar mirrors the
 * one defended on {@link CreateCauslOptions}: name the unavoidable
 * concept the engine cannot express without the flag, or take the
 * teaching cost of growing every README and every consumer's mental
 * model.
 */
export interface CauslFlags {
  /**
   * Skip engine-internal defensive freezes on inner arrays nested
   * inside frozen Commit / Explanation payloads (#702). Public-surface
   * Commit / Explanation objects stay frozen at the outer boundary
   * unconditionally; this flag controls only the inner defensive
   * `Object.freeze` calls on `changedNodes` and `deps`.
   *
   * @remarks
   * Driven by env var `CAUSL_FREEZE_OFF_IN_PROD`. The flag is `true`
   * iff the env value is exactly `'1'`. Adopters who set it accept
   * that the engine will not freeze the inner arrays — those values
   * are still readable like any other JS value, but they are not
   * runtime-immutable.
   *
   * Audit verdict (#702): land as opt-in measurement only; flip the
   * default only if the measured drop on `scrolling-viewport × 10000`
   * AND `batch-commit × 10000` is ≥ 10%. Until then this stays a
   * deliberate opt-in for adopters running with their own
   * immutability discipline.
   */
  readonly freezeOffInProd: boolean
  /**
   * Enable the SPEC §15.1 NonDeterministicComputeError invariant
   * gate (#750). When on, every derived `compute(get)` is re-invoked
   * a second time against the same dependency snapshot; if the
   * second call's result `!Object.is` the first, the engine throws
   * a {@link NonDeterministicComputeError} naming the offending node.
   *
   * @remarks
   * Driven by env var `CAUSL_ASSERT_DETERMINISTIC_COMPUTE`. The flag
   * is `true` iff the env value is exactly `'1'`; truthy-coercion
   * vectors (`'true'`, `'yes'`, …) leave the flag at `false`.
   *
   * Default `false` because re-running every `compute()` doubles
   * derivation work — the gate is useful only in dev / test / CI
   * environments where the cost is acceptable as the price of a
   * structural invariant check. Production runs leave the flag off
   * and pay zero overhead.
   *
   * The audit's adversarial-fanin scenario (#718) injects 0.1%
   * `Math.random()` returns and asks the engine to detect them via
   * a NonDeterministicComputeError thrown at commit time; this flag
   * is the seam that gates the detection at construction time so
   * adopters opt into the cost only when they want the guarantee.
   */
  readonly assertDeterministicCompute: boolean
}

/**
 * Read every `CAUSL_*` env var the engine recognises and return a
 * frozen {@link CauslFlags} snapshot.
 *
 * @remarks
 * The implementation is defensive against three failure modes a
 * non-Node host can produce:
 *
 * - `process` is undefined (browser / sandboxed runtimes).
 * - `process.env` is `null` or a Proxy that throws on access.
 * - The env value is present but not the literal string `'1'` (we
 *   refuse the truthy-coercion vector — `'true'`, `'yes'`, `0` —
 *   so adopters cannot accidentally enable a flag by exporting the
 *   variable to an arbitrary value).
 *
 * Each branch falls back to the conservative default (the flag is
 * `false`).
 */
export function loadFlagsFromEnv(): CauslFlags {
  let freezeOffInProd = false
  let assertDeterministicCompute = false
  try {
    // `process` may not be globally typed in downstream packages
    // that don't depend on @types/node (devtools-bridge, etc.).
    // Reach through globalThis with a runtime check so the lookup
    // stays browser-safe AND typecheck-friendly across packages.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    if (proc?.env?.CAUSL_FREEZE_OFF_IN_PROD === '1') {
      freezeOffInProd = true
    }
    if (proc?.env?.CAUSL_ASSERT_DETERMINISTIC_COMPUTE === '1') {
      assertDeterministicCompute = true
    }
  } catch {
    // Defensive: a Proxy on `process.env` could throw on access.
    // Conservative fallback is to keep the flag off.
  }
  return Object.freeze({ freezeOffInProd, assertDeterministicCompute })
}

/**
 * Module-load snapshot of {@link loadFlagsFromEnv}.
 *
 * @remarks
 * Read once at module load and reused for the lifetime of the
 * process. Module consumers that want a per-engine override merge
 * this with the `experimentalFlags` argument passed to
 * {@link createCausl}; the merge happens once at construction and
 * the resulting object is captured by the engine's closures so the
 * commit / derivation / explanation hot paths never touch
 * `process.env` again.
 *
 * Frozen so accidental mutation by a consumer triggers a
 * `TypeError` in strict mode rather than silently desynchronising
 * the engine from its declared flag state.
 */
export const MODULE_FLAGS: CauslFlags = loadFlagsFromEnv()

/**
 * Merge a `Partial<CauslFlags>` override on top of
 * {@link MODULE_FLAGS} and return a frozen result.
 *
 * @remarks
 * Centralised so that {@link createCausl} and any future
 * consumer-side flag-merge sites pick up new fields automatically
 * once they are added to {@link CauslFlags}. Construction-time
 * cost only; the merged object is captured by the engine's
 * closures, not re-merged per commit.
 */
export function mergeFlags(
  overrides: Partial<CauslFlags> | undefined,
): CauslFlags {
  if (overrides === undefined) return MODULE_FLAGS
  return Object.freeze({ ...MODULE_FLAGS, ...overrides })
}
