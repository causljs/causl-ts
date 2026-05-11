/**
 * @packageDocumentation
 *
 * Three-axis counterexample shrinker per SPEC §16.5. When a
 * hypothesis fails, the shrinker reduces the failing trace to the
 * minimal counterexample along three axes:
 *   1. Step count — drop suffix steps that aren't witnesses.
 *   2. Action arguments — simplify each action to its minimum form.
 *   3. State payload — collapse irrelevant state fields.
 *
 * v1 ships axis-1 only (suffix shrinking via binary search). Axes
 * 2 and 3 are deferred to a follow-on PR; the trait shape reserves
 * the slots so adopters can plug in custom axis shrinkers without
 * a SemVer break.
 */

import type { Hypothesis, Trace } from './types.js'

/**
 * Shrink a failing trace along the step-count axis. Binary-searches
 * the prefix that still produces a `'fails'` verdict; returns the
 * shortest such prefix.
 *
 * Determinism: the shrinker is a pure function over `(hypothesis,
 * trace)`; two invocations on the same input produce byte-identical
 * output.
 */
export function shrinkStepCount<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
): Trace<S> {
  if (hypothesis(trace) !== 'fails') {
    return trace
  }
  let lo = 0
  let hi = trace.steps.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const candidate = sliceSuffix(trace, mid)
    if (hypothesis(candidate) === 'fails') {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return sliceSuffix(trace, lo)
}

/**
 * Symmetric to {@link shrinkStepCount}: drop leading steps that
 * aren't necessary to witness the failure. Per SPEC §16.5.2
 * "axis-1b". One-pass linear walk from the front; for each step,
 * tries to remove it and asserts the trace still fails.
 *
 * The pass is O(steps × hypothesis-cost) — slower than the
 * binary-search suffix shrink, but the front of a trace is
 * typically much shorter than the back since failures are
 * concentrated at the end.
 */
export function shrinkPrefix<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
): Trace<S> {
  if (hypothesis(trace) !== 'fails') {
    return trace
  }
  // Try removing steps from the front until removing one stops
  // producing a fails verdict. This is one pass, NOT binary
  // search: removing leading steps changes the start state of
  // each subsequent step, so the property of "failing under
  // truncation" isn't monotonic over prefix length.
  let prefix = 0
  while (prefix < trace.steps.length) {
    const candidate = slicePrefix(trace, prefix + 1)
    if (hypothesis(candidate) === 'fails') {
      prefix += 1
    } else {
      break
    }
  }
  if (prefix === 0) return trace
  return slicePrefix(trace, prefix)
}

/**
 * Multi-axis shrinker orchestrator per SPEC §16.5.2 (#571).
 *
 * Runs every available shrinker (axis-1 suffix, axis-1b prefix)
 * to convergence: each pass shrinks until no further reduction
 * is possible, then the orchestrator re-runs every axis. The
 * fixpoint is bounded by the number of steps — at most
 * O(steps × axes) iterations.
 *
 * Adopter-supplied axis shrinkers (axis-2 action arity, axis-3
 * value lattice) plug in via the same `(Hypothesis<S>, Trace<S>)
 * → Trace<S>` signature passed in `extraAxes`. A future PR adds
 * the stock implementations once the action / state shapes
 * settle.
 *
 * Determinism: pure function. Same input → same output,
 * byte-stable.
 */
export function shrink<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
  extraAxes: readonly ((
    h: Hypothesis<S>,
    t: Trace<S>,
  ) => Trace<S>)[] = [],
): Trace<S> {
  if (hypothesis(trace) !== 'fails') {
    return trace
  }
  const axes = [shrinkStepCount, shrinkPrefix, ...extraAxes]
  let current = trace
  // Bound the fixpoint loop by the original step count plus
  // a small constant — every iteration must strictly shrink at
  // least one axis or terminate.
  const maxIterations = trace.steps.length + 4
  for (let i = 0; i < maxIterations; i++) {
    let changed = false
    for (const axis of axes) {
      const next = axis(hypothesis, current)
      if (next.steps.length < current.steps.length) {
        current = next
        changed = true
      }
    }
    if (!changed) break
  }
  return current
}

/**
 * Stock axis-2 shrinker — action arity. For each step's action,
 * if the action is a JSON-like object, try removing each
 * optional/non-discriminator field one at a time. Re-run the
 * hypothesis after each removal; keep the removal if the trace
 * still fails. Per SPEC §16.5.2.
 *
 * Discriminator-anchor fields are preserved by name match:
 * `kind`, `state`, `status`, `tag`, `type`. A future PR can pass
 * the anchor list through an options object — today the four
 * named anchors cover every closed DU the engine ships.
 */
export function shrinkActionArity<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
): Trace<S> {
  if (hypothesis(trace) !== 'fails') {
    return trace
  }
  return shrinkPerStepObjectField(hypothesis, trace, 'action')
}

/**
 * Stock axis-3 shrinker — state payload. Same shape as
 * {@link shrinkActionArity} but operates on each step's state.
 * The trace's start-state is also walked for field reduction.
 * Per SPEC §16.5.2.
 */
export function shrinkStatePayload<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
): Trace<S> {
  if (hypothesis(trace) !== 'fails') {
    return trace
  }
  // Walk the per-step state.
  let current = shrinkPerStepObjectField(hypothesis, trace, 'state')
  // Walk the start state.
  if (
    current.start !== null &&
    typeof current.start === 'object' &&
    !Array.isArray(current.start)
  ) {
    const reduced = reduceObjectFields(
      current.start as Record<string, unknown>,
      (candidate) => {
        const trial: Trace<S> = {
          start: candidate as unknown as S,
          steps: current.steps,
          ...(current.bounded === undefined ? {} : { bounded: current.bounded }),
        }
        return hypothesis(trial) === 'fails'
      },
    )
    if (reduced !== null) {
      current = {
        start: reduced as unknown as S,
        steps: current.steps,
        ...(current.bounded === undefined ? {} : { bounded: current.bounded }),
      }
    }
  }
  return current
}

/**
 * Field names treated as discriminator anchors and preserved
 * during axis-2 / axis-3 field reduction. A property test that
 * narrows on `state.kind === 'foo'` would be defeated if the
 * shrinker dropped the `kind` field; pinning these names keeps
 * the shrinker safe-by-default.
 */
const DISCRIMINATOR_ANCHORS = new Set([
  'kind',
  'state',
  'status',
  'tag',
  'type',
])

/**
 * Try removing each non-anchor field from `obj` one at a time.
 * Calls `accept(candidate)` to test whether the resulting trace
 * still fails. Returns the smallest accepted object, or `null`
 * if no field could be removed.
 */
function reduceObjectFields(
  obj: Record<string, unknown>,
  accept: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  let current = { ...obj }
  let changed = false
  for (const key of Object.keys(obj)) {
    if (DISCRIMINATOR_ANCHORS.has(key)) continue
    const trial = { ...current }
    delete trial[key]
    if (accept(trial)) {
      current = trial
      changed = true
    }
  }
  return changed ? current : null
}

/**
 * Walk every step in a trace, attempting object-field reduction
 * on the named field (`'action'` or `'state'`). Returns a new
 * trace with reduced steps.
 */
function shrinkPerStepObjectField<S>(
  hypothesis: Hypothesis<S>,
  trace: Trace<S>,
  fieldName: 'action' | 'state',
): Trace<S> {
  const newSteps = [...trace.steps]
  let changedAny = false
  for (let i = 0; i < newSteps.length; i++) {
    const step = newSteps[i]!
    const target = step[fieldName]
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      continue
    }
    const reduced = reduceObjectFields(
      target as Record<string, unknown>,
      (candidate) => {
        // Build a trial trace where step[i][fieldName] is replaced
        // with the candidate object, leaving everything else
        // unchanged.
        const trialStep =
          fieldName === 'action'
            ? { ...step, action: candidate }
            : { ...step, state: candidate as unknown as S }
        const trialSteps = [...newSteps]
        trialSteps[i] = trialStep
        const trial: Trace<S> = {
          start: trace.start,
          steps: trialSteps,
          ...(trace.bounded === undefined ? {} : { bounded: trace.bounded }),
        }
        return hypothesis(trial) === 'fails'
      },
    )
    if (reduced !== null) {
      newSteps[i] =
        fieldName === 'action'
          ? { ...step, action: reduced }
          : { ...step, state: reduced as unknown as S }
      changedAny = true
    }
  }
  if (!changedAny) return trace
  return {
    start: trace.start,
    steps: newSteps,
    ...(trace.bounded === undefined ? {} : { bounded: trace.bounded }),
  }
}

/**
 * Helper: keep the first `end` steps, preserving start + bounded.
 */
function sliceSuffix<S>(trace: Trace<S>, end: number): Trace<S> {
  return {
    start: trace.start,
    steps: trace.steps.slice(0, end),
    ...(trace.bounded === undefined ? {} : { bounded: trace.bounded }),
  }
}

/**
 * Helper: drop the first `prefix` steps. The new start state is
 * the post-state of the last dropped step; preserves bounded.
 */
function slicePrefix<S>(trace: Trace<S>, prefix: number): Trace<S> {
  if (prefix <= 0) return trace
  const newStart = trace.steps[prefix - 1]?.state
  if (newStart === undefined) return trace
  return {
    start: newStart,
    steps: trace.steps.slice(prefix),
    ...(trace.bounded === undefined ? {} : { bounded: trace.bounded }),
  }
}
