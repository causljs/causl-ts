/**
 * @packageDocumentation
 *
 * EPIC-4 / TASK 4.5 — Apalache differential-test scaffold for the
 * hypothesis combinator surface.
 *
 * Per SPEC §16.5: when the bounded enumerator emits a `Trace<S>` and
 * the hypothesis evaluator returns a `Verdict`, the Apalache
 * differential checks that Apalache's verdict on the matching TLA+
 * model agrees. The pairing maps to the `tools/enumerator/corpus/`
 * tree from EPIC-7.
 *
 * v1 status: scaffold. The `pairWithApalacheModel` function records
 * the (hypothesis name → TLA+ model path) mapping so adopters can
 * declare the pairing at hypothesis-construction time. The actual
 * differential runner (`apalache-diff` binary in
 * `tools/enumerator/diff/`) ships the corpus-walker; this file is
 * the TS-side hook that the runner consumes.
 */

import type { Hypothesis } from './types.js'

/**
 * One entry in the Apalache differential pairing table. Maps a
 * hypothesis name to the path of its paired TLA+ model relative to
 * the corpus root.
 */
export interface ApalachePairing {
  readonly hypothesisName: string
  readonly tlaPath: string
}

/**
 * Tag a hypothesis with the path of its paired Apalache TLA+ model.
 * The pairing is consumed by `apalache-diff` when the differential
 * harness lands; today it's metadata.
 *
 * @example
 *
 * ```ts
 * const h = pairWithApalacheModel(
 *   'glitch-freedom',
 *   always((s) => s.sum === s.a + s.b),
 *   'corpus/apalache/glitch_propagation_minimal.tla',
 * )
 * ```
 */
export function pairWithApalacheModel<S>(
  name: string,
  hypothesis: Hypothesis<S>,
  tlaPath: string,
): TaggedHypothesis<S> {
  return {
    name,
    tlaPath,
    run: hypothesis,
  }
}

/**
 * A hypothesis tagged with its Apalache pairing. The `run` method is
 * the original `Hypothesis<S>`; `name` and `tlaPath` are metadata.
 */
export interface TaggedHypothesis<S> {
  readonly name: string
  readonly tlaPath: string
  readonly run: Hypothesis<S>
}

/**
 * Collect a list of pairings from a set of tagged hypotheses. Used
 * by `apalache-diff`'s consumer to enumerate the differential
 * targets.
 */
export function collectPairings<S>(
  hypotheses: readonly TaggedHypothesis<S>[],
): readonly ApalachePairing[] {
  return hypotheses.map((h) => ({
    hypothesisName: h.name,
    tlaPath: h.tlaPath,
  }))
}
