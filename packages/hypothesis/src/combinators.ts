/**
 * @packageDocumentation
 *
 * Hypothesis grammar combinators per SPEC §16.5.1.
 *
 * The grammar:
 *   - `always(p)` — `p` holds at every state in the trace.
 *   - `eventually(p)` — `p` holds at some state in the trace.
 *   - `never(p)` — `p` holds at no state (dual of `eventually`).
 *   - `until(p, q)` — `p` holds at every state up to and including
 *     the first state where `q` holds.
 *   - `afterCommit(p)` — `p` holds at every state after the first
 *     `Commit` action.
 *   - `during(p)` — `p` holds at every state in a contiguous span
 *     identified by trace position (alias for `always` in v1).
 *   - `implies(antecedent, consequent)` — when `antecedent` holds,
 *     `consequent` holds.
 *   - `and(...hs)` — every hypothesis holds.
 *   - `or(...hs)` — at least one hypothesis holds.
 *
 * All combinators take and return `Hypothesis<S>`; predicates take
 * `StatePredicate<S>`. The leaf `state(p)` lifts a state predicate
 * into a hypothesis equivalent to `always(p)` over a single-state
 * trace.
 */

import type {
  CommitMatcher,
  Hypothesis,
  HypothesisBody,
  NamedHypothesis,
  PhaseStep,
  StatePredicate,
  Trace,
  UntilBuilder,
  Verdict,
} from './types.js'

function statesOf<S>(trace: Trace<S>): readonly S[] {
  return [trace.start, ...trace.steps.map((s) => s.state)]
}

/**
 * `always(p)` — `p` holds at every state in the trace.
 *
 * A trace witness fails as soon as the first state violates `p`;
 * an exhausted trace where every state satisfies `p` holds.
 */
export function always<S>(p: StatePredicate<S>): Hypothesis<S> {
  return (trace) => {
    for (const s of statesOf(trace)) {
      if (!p(s)) return 'fails'
    }
    return 'holds'
  }
}

/**
 * `eventually(p)` — `p` holds at some state in the trace. A trace
 * holds as soon as a state satisfies `p`. Three-valued return per
 * SPEC §16.5.1:
 *
 *   - `'holds'`  — a witness state was found.
 *   - `'fails'`  — every state was checked, none satisfied `p`,
 *                  AND the trace is complete (`bounded === false`).
 *   - `'unknown'` — every state was checked, none satisfied `p`,
 *                   but the trace was truncated by an enumerator
 *                   bound (`bounded === true`). A longer trace
 *                   might satisfy `p`; we cannot conclude either way.
 *
 * The `'unknown'` arm is the three-valued honesty surface #571
 * (and #588's A9-3) called out: pre-fix the impl returned `'fails'`
 * here, conflating "no witness exists" with "we ran out of trace".
 */
export function eventually<S>(p: StatePredicate<S>): Hypothesis<S> {
  return (trace) => {
    for (const s of statesOf(trace)) {
      if (p(s)) return 'holds'
    }
    return trace.bounded === true ? 'unknown' : 'fails'
  }
}

/**
 * `never(p)` — `p` holds at no state. Dual of `eventually`.
 */
export function never<S>(p: StatePredicate<S>): Hypothesis<S> {
  return (trace) => {
    for (const s of statesOf(trace)) {
      if (p(s)) return 'fails'
    }
    return 'holds'
  }
}

/**
 * `until(p, q)` — `p` holds at every state up to and including the
 * first state where `q` holds. If `q` never holds, the trace fails.
 */
export function until<S>(p: StatePredicate<S>, q: StatePredicate<S>): Hypothesis<S> {
  return (trace) => {
    for (const s of statesOf(trace)) {
      if (q(s)) return 'holds'
      if (!p(s)) return 'fails'
    }
    return 'fails' // exhausted without q ever holding
  }
}

/**
 * `afterCommit(p)` — `p` holds at the IMMEDIATE successor state of
 * each commit in the trace.
 *
 * Per SPEC §16.5.1: "p holds at every step that is the immediate
 * successor of a commit matching `match`". The combinator detects
 * a commit by inspecting `step.action.kind === 'commit'`.
 *
 * Two call shapes:
 *
 *   - **Single-arg** (`afterCommit(p)`) — matches every commit in
 *     the trace. The original wave-2 (#595) shape; preserved for
 *     back-compat.
 *
 *   - **Two-arg** (`afterCommit(match, p)`) — applies the
 *     `CommitMatcher` filter before evaluating `p`. Match fields:
 *       - `touches: NodeId` — commit's `changedNodes` includes the id
 *       - `tag: string` — commit's `intent` contains the substring
 *       - `any: true` — match every commit (sugar for the 1-arg form)
 *     When multiple match fields are supplied, they AND together.
 *
 * Implementation behaviors common to both forms:
 *   - A trace with no commits holds vacuously.
 *   - A trace where no commit matches the filter holds vacuously.
 *   - A single failing commit-successor breaks the hypothesis.
 *
 * The original "stays-true-after-first-commit" bug (#588 A9-1)
 * was fixed in wave-2 (#595) and remains fixed here — both call
 * shapes evaluate `p` once per matching commit at the
 * immediate-successor state, never at any other state.
 */
export function afterCommit<S>(p: StatePredicate<S>): Hypothesis<S>
export function afterCommit<S>(
  match: CommitMatcher,
  p: StatePredicate<S>,
): Hypothesis<S>
export function afterCommit<S>(
  matchOrP: CommitMatcher | StatePredicate<S>,
  maybeP?: StatePredicate<S>,
): Hypothesis<S> {
  // Disambiguate the overload at runtime: a function is the
  // single-arg shape; an object is the two-arg shape with matcher.
  const [match, predicate]: [CommitMatcher, StatePredicate<S>] =
    typeof matchOrP === 'function'
      ? [{ any: true }, matchOrP]
      : [matchOrP, maybeP as StatePredicate<S>]
  return (trace) => {
    for (const step of trace.steps) {
      const action = step.action as
        | { kind?: string; intent?: string; changedNodes?: readonly string[] }
        | null
      const isCommit =
        action !== null &&
        action !== undefined &&
        action.kind === 'commit'
      if (!isCommit) continue
      if (!commitMatches(action, match)) continue
      if (!predicate(step.state)) {
        // The post-commit state of a matching commit must satisfy p.
        return 'fails'
      }
    }
    return 'holds'
  }
}

/**
 * Test whether a commit matches a {@link CommitMatcher}. AND
 * semantics: every supplied filter field must hold.
 */
function commitMatches(
  action: {
    intent?: string
    changedNodes?: readonly string[]
  },
  match: CommitMatcher,
): boolean {
  // Empty matcher (or `any: true`) matches everything.
  if (match.any === true && match.touches === undefined && match.tag === undefined) {
    return true
  }
  if (match.touches !== undefined) {
    const nodes = action.changedNodes ?? []
    if (!nodes.includes(match.touches)) return false
  }
  if (match.tag !== undefined) {
    const intent = action.intent ?? ''
    if (!intent.includes(match.tag)) return false
  }
  return true
}

/**
 * `during(phase, p)` — at every step where `step.phase === phase`,
 * evaluate `p` against the step's state. Per SPEC §16.5.1.
 *
 * Two call shapes:
 *
 *   - **Single-arg** (`during(p)`) — alias for `always(p)`. The
 *     original v1 shape; preserved for back-compat.
 *
 *   - **Two-arg** (`during(phase, p)`) — phase-targeted filter.
 *     `p` is evaluated only at steps whose `phase` field equals
 *     the supplied phase. Steps without a `phase` field, or whose
 *     phase doesn't match, are skipped. The start state has no
 *     phase and is always skipped by the two-arg form. A trace
 *     where no step matches the phase holds vacuously.
 *
 * The two-arg form is the SPEC §16.5.1 surface; the one-arg form
 * stays available for code that pre-dates the phase tag on
 * {@link Step | `Step<S>`}.
 *
 * Runtime dispatch: a function as the first argument selects the
 * single-arg shape; a string selects the two-arg shape.
 */
export function during<S>(p: StatePredicate<S>): Hypothesis<S>
export function during<S>(phase: PhaseStep, p: StatePredicate<S>): Hypothesis<S>
export function during<S>(
  phaseOrP: PhaseStep | StatePredicate<S>,
  maybeP?: StatePredicate<S>,
): Hypothesis<S> {
  // Disambiguate the overload at runtime: a function is the
  // single-arg shape (back-compat alias of `always`); a string
  // is the two-arg shape with phase filter.
  if (typeof phaseOrP === 'function') {
    return always(phaseOrP)
  }
  const phase = phaseOrP
  const predicate = maybeP as StatePredicate<S>
  return (trace) => {
    for (const step of trace.steps) {
      if (step.phase !== phase) continue
      if (!predicate(step.state)) return 'fails'
    }
    return 'holds'
  }
}

/**
 * `implies(antecedent, consequent)` — when `antecedent` holds,
 * `consequent` holds. Equivalent to `or(not(antecedent), consequent)`
 * in classical logic.
 */
export function implies<S>(
  antecedent: Hypothesis<S>,
  consequent: Hypothesis<S>,
): Hypothesis<S> {
  return (trace) => {
    const a = antecedent(trace)
    if (a === 'fails') return 'holds' // vacuously true
    if (a === 'unknown') return 'unknown'
    return consequent(trace)
  }
}

/**
 * `and(...hs)` — every hypothesis holds. Short-circuits on first
 * `'fails'`; collects `'unknown'`s and returns `'unknown'` if any
 * unsettled when no fail.
 */
export function and<S>(...hs: readonly Hypothesis<S>[]): Hypothesis<S> {
  return (trace) => {
    let anyUnknown = false
    for (const h of hs) {
      const v = h(trace)
      if (v === 'fails') return 'fails'
      if (v === 'unknown') anyUnknown = true
    }
    return anyUnknown ? 'unknown' : 'holds'
  }
}

/**
 * `or(...hs)` — at least one hypothesis holds. Short-circuits on
 * first `'holds'`.
 */
export function or<S>(...hs: readonly Hypothesis<S>[]): Hypothesis<S> {
  return (trace) => {
    let anyUnknown = false
    for (const h of hs) {
      const v = h(trace)
      if (v === 'holds') return 'holds'
      if (v === 'unknown') anyUnknown = true
    }
    return anyUnknown ? 'unknown' : 'fails'
  }
}

/**
 * Lift a state predicate into a single-state hypothesis (evaluates
 * only the start state). Useful for "the start state satisfies X"
 * checks.
 */
export function atStart<S>(p: StatePredicate<S>): Hypothesis<S> {
  return (trace): Verdict => (p(trace.start) ? 'holds' : 'fails')
}

/**
 * Wrap a state predicate as a named hypothesis equivalent to
 * `always(p)`. The supplied `name` is exposed on the returned
 * function as `hypothesisName` so counterexample reports can label
 * the failing predicate.
 *
 * Per SPEC §16.5.1's named-predicate factory (#571).
 *
 * @param name - Diagnostic name surfaced in counterexample reports.
 * @param p - State predicate to lift.
 * @returns A {@link Hypothesis} equivalent to `always(p)`, with
 *   `name` attached as a non-enumerable function property.
 */
export function fromPredicate<S>(
  name: string,
  p: StatePredicate<S>,
): Hypothesis<S> {
  const h: Hypothesis<S> = (trace) => {
    for (const s of statesOf(trace)) {
      if (!p(s)) return 'fails'
    }
    return 'holds'
  }
  Object.defineProperty(h, 'hypothesisName', {
    value: name,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return h
}

/**
 * `hypothesis(name, body)` factory — per SPEC §16.5.1's named-
 * hypothesis surface (#571).
 *
 * Returns a {@link NamedHypothesis} with `{ name, body, run }`.
 * `run(trace)` walks the trace:
 *   1. At every step, if `body.invariant` is supplied and returns
 *      `false`, fail-fast with `'fails'`.
 *   2. Otherwise evaluate `body.predicate` over the full trace
 *      and return its verdict.
 *
 * The split between `invariant` (per-step safety) and `predicate`
 * (whole-trace temporal) mirrors TLA+'s split between the safety
 * part of `Spec` and the temporal-formula part. Adopters compose
 * `body.predicate` from the existing combinators (`always`,
 * `eventually`, `holds(p).until(q)`, etc.).
 *
 * @param name - Diagnostic name surfaced in counterexample reports.
 * @param body - The hypothesis body.
 * @returns A {@link NamedHypothesis} whose `run` evaluates the
 *   trace per the (invariant, predicate) protocol.
 */
export function hypothesis<S>(
  name: string,
  body: HypothesisBody<S>,
): NamedHypothesis<S> {
  return {
    name,
    body,
    run(trace: Trace<S>): Verdict {
      // Step 1: invariant fail-fast across every observed state
      // (start + each post-step state). The first invariant
      // violation short-circuits before the predicate runs.
      if (body.invariant !== undefined) {
        const inv = body.invariant
        for (const s of statesOf(trace)) {
          if (!inv(s)) return 'fails'
        }
      }
      // Step 2: evaluate the temporal predicate over the full trace.
      return body.predicate(trace)
    },
  }
}

/**
 * `holds(p).until(q)` / `holds(p).weakUntil(q)` — Lamport's
 * strong/weak-U operators (#571).
 *
 * Per SPEC §16.5.1, `holds(p)` returns an {@link UntilBuilder}
 * exposing two methods:
 *
 *   - `until(q)` — strong-U. `q` MUST hold somewhere in the trace,
 *     and `p` MUST hold at every state up to and including the
 *     state where `q` first holds. If `q` is never witnessed
 *     within the trace, the hypothesis fails.
 *
 *   - `weakUntil(q)` — weak-U. Same as `until` except `q` is NOT
 *     required to be witnessed; if `p` holds for the entire trace
 *     without `q` ever being reached, the hypothesis still holds.
 *
 * Per the SPEC, strong-U is the default expectation for
 * "post-condition follows pre-condition" assertions. Use
 * `weakUntil` only when the adopter doesn't require the
 * post-condition to fire.
 */
export function holds<S>(p: StatePredicate<S>): UntilBuilder<S> {
  return {
    until(q: StatePredicate<S>): Hypothesis<S> {
      return (trace) => {
        for (const s of statesOf(trace)) {
          if (q(s)) return 'holds'
          if (!p(s)) return 'fails'
        }
        // Trace exhausted without q ever holding. Strong-U fails
        // — q must be witnessed for strong-U to hold.
        return 'fails'
      }
    },
    weakUntil(q: StatePredicate<S>): Hypothesis<S> {
      return (trace) => {
        for (const s of statesOf(trace)) {
          if (q(s)) return 'holds'
          if (!p(s)) return 'fails'
        }
        // Trace exhausted without q ever holding. Weak-U holds
        // vacuously — p never failed, q never required.
        return 'holds'
      }
    },
  }
}
