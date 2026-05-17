/**
 * @packageDocumentation
 *
 * `@causljs/hypothesis` — temporal-logic hypothesis combinators for
 * the Causl bounded enumerator.
 *
 * Per SPEC §16.5.1, the surface is the closed grammar:
 *   `always | eventually | until | afterCommit | during | never |
 *    implies | and | or | atStart`
 *
 * The companion `evaluate` function consumes an enumerator-recorded
 * `Trace<S>` and returns a three-valued `Verdict`
 * (`holds | fails | unknown`) plus a shrunk counterexample when
 * failing.
 */

export type {
  CommitMatcher,
  Hypothesis,
  HypothesisBody,
  NamedHypothesis,
  PhaseStep,
  Step,
  StatePredicate,
  Trace,
  UntilBuilder,
  Verdict,
} from './types.js'
export {
  afterCommit,
  always,
  and,
  atStart,
  during,
  eventually,
  fromPredicate,
  holds,
  hypothesis,
  implies,
  never,
  or,
  until,
} from './combinators.js'
export {
  shrink,
  shrinkActionArity,
  shrinkPrefix,
  shrinkStatePayload,
  shrinkStepCount,
} from './shrink.js'
export { evaluate, type EvaluateResult } from './evaluate.js'
export {
  pairWithApalacheModel,
  collectPairings,
  type ApalachePairing,
  type TaggedHypothesis,
} from './apalache.js'

/**
 * Package version identifier.
 */
export const VERSION = '0.0.0'
