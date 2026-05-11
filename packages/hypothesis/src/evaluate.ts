/**
 * @packageDocumentation
 *
 * Hypothesis evaluator. Per SPEC §16.5, a hypothesis is a pure
 * function from `Trace<S>` to `Verdict`; the evaluator is the thin
 * layer that runs that function and packages the result with a
 * shrunk counterexample when the verdict is `'fails'`.
 */

import { shrinkStepCount } from './shrink.js'
import type { Hypothesis, Trace, Verdict } from './types.js'

/**
 * Evaluation result — verdict + (when failing) the shrunk
 * counterexample trace adopters use to debug.
 */
export interface EvaluateResult<S> {
  readonly verdict: Verdict
  /** Shrunk counterexample, present only when verdict === 'fails'. */
  readonly counterexample?: Trace<S>
}

/**
 * Evaluate a hypothesis against a trace. Returns the verdict;
 * when failing, also returns the shrunk minimal counterexample.
 */
export function evaluate<S>(hypothesis: Hypothesis<S>, trace: Trace<S>): EvaluateResult<S> {
  const verdict = hypothesis(trace)
  if (verdict !== 'fails') {
    return { verdict }
  }
  return {
    verdict,
    counterexample: shrinkStepCount(hypothesis, trace),
  }
}
