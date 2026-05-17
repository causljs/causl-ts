/**
 * @packageDocumentation
 *
 * Tagged result type returned by formula evaluation. The earlier draft
 * of the formula type carried four optional fields (`ast?`,
 * `dependencies?`, `value?`, `error?`), permitting representations
 * like "has a value AND an error AND no AST AND no dependencies." That
 * state should not be representable. Make impossible states impossible:
 * instead of throwing or silently returning `0` on divide-by-zero or
 * non-numeric inputs, every compute resolves to a discriminated union
 * that callers pattern match on, and the type narrows on the tag before
 * any payload is exposed. This eliminates two earlier bugs — `=A1/0`
 * quietly evaluating to `0`, and `=A1+1` throwing inside the compute
 * when `A1` held a string and breaking the enclosing commit — by
 * surfacing both cases as `{ kind: 'error', error: … }`.
 *
 * `FormulaError` itself is a discriminated union over `kind`. The
 * `propagated` variant carries a typed `cause: FormulaError` so the
 * original failure chain survives every relay hop; the previous shape
 * rewrote `kind` to `'propagated'` in place and dropped every other
 * field, making "I am a propagated error pointing nowhere" both
 * representable and the actual runtime state after one hop. That was
 * the same §9 "make impossible states impossible" violation one layer
 * down. The required-`ref` variants (`unresolved-ref`, `non-numeric`)
 * encode at the type level the invariant that a reference error
 * cannot exist without naming the cell it failed on.
 */
import { assertNever } from '@causl/core/internal'
import type { FormulaError, FormulaResult } from './ir.js'

// The pure-data IR for `FormulaResult` / `FormulaError` / `FormulaErrorKind`
// now lives in `./ir.ts` so the future Rust evaluator port has a clean
// seam to share types with (issue #697 / epic #680). The constructors,
// `rootCause`, and `valueOr` below stay here because they are behaviour
// — they instantiate, walk, and pattern-match on the IR rather than
// being part of the wire shape. Re-exporting the types from this module
// keeps the historical `@causl/formula/result` import path stable for
// any external consumers that bypass the package barrel.

export type { FormulaError, FormulaErrorKind, FormulaResult } from './ir.js'

/**
 * Construct a successful numeric {@link FormulaResult}.
 *
 * @param value - Numeric value produced by the evaluator.
 * @returns Result with `kind: 'value'`.
 */
export const ok = (value: number): FormulaResult => ({ kind: 'value', value })

/**
 * Construct an error {@link FormulaResult} from a fully built
 * {@link FormulaError} variant.
 *
 * @remarks
 * Preferred constructor for variants that require extra fields beyond
 * `kind` and `message` — `unresolved-ref`, `non-numeric`, and
 * `propagated`. Building the variant object explicitly forces every
 * required field (the `ref` on the reference variants, the `cause` on
 * `propagated`) to be present at the call site, surfacing missing
 * data as a compile error rather than as a silent runtime hole.
 *
 * @param error - The {@link FormulaError} to wrap in an `error`
 *   {@link FormulaResult}.
 * @returns Result with `kind: 'error'` carrying `error`.
 */
export const errResult = (error: FormulaError): FormulaResult => ({
  kind: 'error',
  error,
})

/**
 * Convenience constructor for an error {@link FormulaResult} restricted
 * to the no-extra-field error variants.
 *
 * @remarks
 * Variants requiring extra fields beyond `kind`/`message`
 * (`unresolved-ref`, `non-numeric`, `propagated`) cannot be expressed
 * through this helper without losing the type-level guarantee that
 * those fields are present. Callers needing those variants must build
 * the {@link FormulaError} object directly and use {@link errResult}.
 *
 * @param kind - One of the no-extra-field error tags.
 * @param message - Human-readable description for diagnostics.
 * @param ref - Optional A1 reference for the `div-by-zero` variant
 *   only; `unknown-function`/`argument-error` shapes do not carry one
 *   and the parameter is ignored for those tags.
 * @returns Result with `kind: 'error'` carrying a {@link FormulaError}.
 */
export const err = (
  kind: 'div-by-zero' | 'unknown-function' | 'argument-error',
  message: string,
  ref?: string,
): FormulaResult => {
  switch (kind) {
    case 'div-by-zero':
      return errResult(
        ref !== undefined
          ? { kind: 'div-by-zero', message, ref }
          : { kind: 'div-by-zero', message },
      )
    case 'unknown-function':
      return errResult({ kind: 'unknown-function', message })
    case 'argument-error':
      return errResult({ kind: 'argument-error', message })
    default:
      return assertNever(kind, 'unhandled FormulaError kind in err()')
  }
}

/**
 * Walk a {@link FormulaError} chain and return the originating
 * non-`propagated` variant.
 *
 * @remarks
 * Diagnostics — error reporters, devtool overlays, tests — frequently
 * want to know where a failure actually started, not the relay hop
 * that surfaced it. The walk is bounded by the depth of the dependency
 * chain that produced the error, which is itself bounded by the cycle
 * detector, so unbounded recursion is not representable here.
 *
 * @param error - Any {@link FormulaError}, possibly wrapped in any
 *   number of `propagated` layers.
 * @returns The deepest non-`propagated` variant reachable through
 *   `cause`. If `error` is itself non-`propagated`, it is returned
 *   unchanged.
 */
export function rootCause(error: FormulaError): FormulaError {
  let current: FormulaError = error
  while (current.kind === 'propagated') current = current.cause
  return current
}

/**
 * Extract a numeric value from a {@link FormulaResult}, falling back
 * to a caller-supplied default when the result is an error.
 *
 * @remarks
 * Convenient for tests that exercise success paths and treat errors
 * as out-of-scope.
 *
 * @param result - Result to inspect.
 * @param fallback - Number returned when `result.kind === 'error'`.
 * @returns Either `result.value` or `fallback`.
 */
export function valueOr(result: FormulaResult, fallback: number): number {
  return result.kind === 'value' ? result.value : fallback
}
