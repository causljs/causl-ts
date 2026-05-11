/**
 * @packageDocumentation
 *
 * Hypothesis grammar types — the temporal-logic surface adopters
 * write hypotheses in. Per SPEC §16.5.1, the grammar is:
 *   `always | eventually | until | afterCommit | during | never |
 *    implies | and | or`
 *
 * A `Hypothesis<S>` is a predicate over a `Trace<S>` (the BFS path
 * recorded by the bounded enumerator). Evaluation produces a
 * three-valued `Verdict`: `holds | fails | unknown`. The `unknown`
 * arm is the honesty surface — when the bound was hit before the
 * predicate could be decided, we don't lie about it.
 */

/**
 * Phase tag attached to a step per SPEC §16.5.1's `during(phase, p)`
 * combinator. Identifies which scheduler phase the step was emitted
 * from, so phase-targeted hypotheses can filter the trace down to
 * the relevant slice (e.g., only the `commit-fanout` steps of a
 * commit transaction).
 *
 * The seven phases mirror the scheduler's commit/dispatch state
 * machine:
 *   - `idle` — no active transaction.
 *   - `commit-prepare` — entering a commit; pre-resolution.
 *   - `commit-resolve-async` — async-resolution sub-phase.
 *   - `commit-fanout` — committed value fan-out to derivers.
 *   - `commit-finalize` — closing out the commit.
 *   - `msg-dispatch` — message dispatch entry.
 *   - `msg-fanout` — message fan-out to subscribers.
 */
export type PhaseStep =
  | 'idle'
  | 'commit-prepare'
  | 'commit-resolve-async'
  | 'commit-fanout'
  | 'commit-finalize'
  | 'msg-dispatch'
  | 'msg-fanout'

/**
 * One step in a recorded trace — the action taken from the
 * predecessor state plus the post-transition state. The state is
 * generic so adopters can plug in their own state shape (the
 * enumerator emits `EnumeratorState`; tests can use a simpler
 * `{ now, value }`-style state).
 *
 * @remarks
 * The optional `phase` field identifies the scheduler phase the
 * step was emitted in. Used by SPEC §16.5.1's `during(phase, p)`
 * combinator to filter the trace by phase. Optional for back-compat
 * — adopters and older traces that omit it have steps treated as
 * having no phase (skipped by phase-filtered combinators).
 */
export interface Step<S> {
  readonly action: unknown
  readonly state: S
  readonly phase?: PhaseStep
}

/**
 * Recorded trace — start state plus ordered post-state list.
 *
 * @remarks
 * `bounded` is set to `true` by the enumerator when the trace was
 * truncated by a configured bound (depth cap, K-prefix cap, visited-
 * set cap). Hypotheses whose verdict depends on whether a property
 * "ever holds" — like {@link Hypothesis | `eventually`} — return
 * `'unknown'` when `bounded` is true and the predicate didn't hold
 * within the partial trace. The truthful answer in that case is
 * "we cannot conclude either way", and `'unknown'` is the
 * three-valued honesty surface SPEC §16.5.1 commits to.
 *
 * Defaults to `false` when omitted (older traces and adopters that
 * construct traces by hand are treated as complete).
 */
export interface Trace<S> {
  readonly start: S
  readonly steps: readonly Step<S>[]
  /**
   * Whether the trace was truncated by an enumerator bound. Optional
   * for backwards compatibility — a missing flag is treated as
   * `false` (complete trace).
   */
  readonly bounded?: boolean
}

/**
 * Three-valued verdict. `unknown` is the honesty surface for
 * bounded evaluations.
 */
export type Verdict = 'holds' | 'fails' | 'unknown'

/**
 * Hypothesis predicate — a function from a trace to a verdict.
 * The verdict is `'holds'` when the predicate is satisfied across
 * the trace; `'fails'` when a witness counterexample was found;
 * `'unknown'` when the bound was hit before the predicate could be
 * decided.
 */
export type Hypothesis<S> = (trace: Trace<S>) => Verdict

/**
 * State predicate — used as the leaf of the hypothesis grammar.
 */
export type StatePredicate<S> = (state: S) => boolean

/**
 * Body shape for a {@link NamedHypothesis}, per SPEC §16.5.1's
 * `hypothesis(name, body)` factory. Splits the safety part
 * (invariant — checked at every step) from the temporal part
 * (predicate — evaluated once over the whole trace), mirroring
 * TLA+'s split between the safety part of `Spec` and the
 * temporal-formula part.
 */
export interface HypothesisBody<S> {
  /**
   * Optional invariant — checked at every step. A `false` return
   * fails the hypothesis with `'fails'` before the predicate is
   * evaluated. Per SPEC §16.5.1: this is where 'safety' lives.
   */
  readonly invariant?: StatePredicate<S>
  /**
   * The temporal predicate — evaluated once against the full
   * trace after the invariant has cleared every step. Use the
   * combinators (`always`, `eventually`, `holds(p).until(q)`,
   * `afterCommit`, etc.) to construct this.
   */
  readonly predicate: Hypothesis<S>
}

/**
 * Named hypothesis — the object returned by the `hypothesis(name,
 * body)` factory per SPEC §16.5.1. Carries the `name` (surfaced
 * in counterexample reports), the `body`, and a `run(trace)`
 * method that walks the trace and returns the verdict.
 */
export interface NamedHypothesis<S> {
  /** Diagnostic name. Surfaced in counterexample reports. */
  readonly name: string
  /** The body the factory was constructed with. */
  readonly body: HypothesisBody<S>
  /**
   * Walk the trace: invariant fail-fast at every step, then the
   * predicate over the full trace. Returns the verdict.
   */
  run(trace: Trace<S>): Verdict
}

/**
 * `afterCommit` matcher per SPEC §16.5.1. Filters which commits
 * the predicate is checked against. All three fields are AND'd
 * when supplied; the filter is empty when no field is set
 * (equivalent to `{ any: true }`).
 */
export interface CommitMatcher {
  /**
   * Match commits whose `changedNodes` includes the named id.
   * Adopters use this to target a specific input or derived's
   * commit footprint.
   */
  readonly touches?: string
  /**
   * Match commits whose `intent` contains the tag as a substring.
   * Adopters use this to target a class of commits — e.g.,
   * `tag: 'fetch:'` matches every resource fetch commit per
   * SPEC.async §6.
   */
  readonly tag?: string
  /**
   * Explicit match-all marker. Equivalent to passing the
   * single-arg `afterCommit(p)` form. Useful when an adopter
   * wants the 2-arg form for syntactic consistency.
   */
  readonly any?: true
}

/**
 * Builder shape for `holds(p).until(q)` — Lamport's strong-U.
 * Per SPEC §16.5.1.
 */
export interface UntilBuilder<S> {
  /**
   * Strong-`until`: `q` MUST hold somewhere in the trace, and `p`
   * MUST hold at every step up to and including the step where
   * `q` first holds. If `q` is never witnessed within the trace,
   * the hypothesis fails.
   */
  until(q: StatePredicate<S>): Hypothesis<S>
  /**
   * Weak-`until`: `q` is NOT required to be witnessed. If `p`
   * holds for the entire trace without `q` ever being reached,
   * the hypothesis still holds. Useful when the adopter doesn't
   * care whether the post-condition fires, only that the
   * pre-condition was preserved.
   */
  weakUntil(q: StatePredicate<S>): Hypothesis<S>
}
