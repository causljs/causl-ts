/**
 * @packageDocumentation
 *
 * SPEC.async §11.1 — `ResourceUpdateReason` enumeration plus the
 * `whyUpdated` and `whyNotUpdated` decoders.
 *
 * `whyUpdated(commit, prev, next)` consumes the commit's `intent`
 * label (which the resource adapter sets uniquely per chart edge —
 * `fetch:${key}:start`, `fetch:${key}:loaded`, etc.) plus the
 * pre/post-commit `ResourceState<T>` arms, and returns the matching
 * `ResourceUpdateReason`. The seven tags are total over the §6
 * ResourceFleet chart's transition space.
 *
 * `whyNotUpdated(prev, next)` is the dual: when a subscriber DIDN'T
 * see an update, this decoder names why. The answer is one of
 * `'no-dep-overlap'` (the commit's `changedNodes` set did not
 * include this resource's node) or `'object-is-deduped'` (`prev` and
 * `next` are reference-equal under `Object.is`). Returns `null` when
 * the resource actually DID transition (prev !== next structurally),
 * because there is no "why not" answer in that case.
 *
 * Per SPEC.async §11.1 and the team's reading on "one inspection
 * surface, two layers of interpretation": these decoders are pure
 * functions over commit metadata + DU arms. They do not register
 * derived nodes or subscribe to the graph. Consumers compose them
 * with `subscribeCommits` or `commitMetadataDerived` at the
 * application layer. A future PR (per #587, merged into #577 by
 * the Phase 8 critical review) lifts these into derived nodes via
 * the Phase F.5 seam; this module ships the synchronous helper API
 * first.
 */

import type { ResourceState } from './resource.js'

/**
 * Closed seven-arm enumeration of the reasons a resource node was
 * updated in a commit. Per SPEC.async §11.1.
 */
export type ResourceUpdateReason =
  | 'fetch-begin'
  | 'fetch-resolved'
  | 'fetch-stale'
  | 'fetch-rejected'
  | 'invalidated'
  | 'failed'
  | 'dep-changed'

/**
 * Runtime tuple of the seven `ResourceUpdateReason` values, in the
 * order SPEC.async §11.1 lists them. Frozen so adopters cannot
 * mutate the canonical list.
 *
 * The tuple is the type's value-level dual: TypeScript erases types
 * at runtime, so adopters who need to enumerate the reasons (e.g.,
 * a devtools panel listing every possible reason) reach for this
 * tuple.
 */
export const RESOURCE_UPDATE_REASONS = Object.freeze([
  'fetch-begin',
  'fetch-resolved',
  'fetch-stale',
  'fetch-rejected',
  'invalidated',
  'failed',
  'dep-changed',
] as const) satisfies readonly ResourceUpdateReason[]

/**
 * Reasons a subscriber did NOT see an update on a given commit, as
 * a closed two-arm union. Returned by {@link whyNotUpdated}.
 */
export type WhyNotUpdatedReason = 'no-dep-overlap' | 'object-is-deduped'

/**
 * Minimal commit shape the decoders consume. The full {@link Commit}
 * type lives in `@causljs/core` and carries more fields; the decoders
 * only need `intent`, so we accept the structural subset to avoid
 * an avoidable cross-package import on the helper surface.
 */
export interface CommitForDecoding {
  /** The intent label passed to `graph.commit(intent, ...)`. */
  readonly intent: string
}

/**
 * Decode the reason a resource node was updated by a commit. Returns
 * one of the seven {@link ResourceUpdateReason} values.
 *
 * @param commit - the {@link CommitForDecoding} (carries the intent
 *   label the resource adapter sets per chart edge).
 * @param prev - the resource's state immediately before the commit.
 * @param next - the resource's state immediately after the commit.
 *
 * @remarks
 * The decoder is a pure function: same inputs produce same outputs,
 * no side effects, no graph reads. The decision tree:
 *
 *   1. If the intent prefix is one of the resource adapter's known
 *      labels (`fetch:*:start`, `fetch:*:loaded`, `fetch:*:stale`,
 *      `fetch:*:error`, `invalidate:*`, `fail:*`), return the
 *      matching reason.
 *   2. Otherwise (the commit was on a different node and a
 *      downstream derived's recompute carried the resource into
 *      the changed-set), return `'dep-changed'`.
 *
 * The pre/post arms are not strictly required for any single decode
 * step — the intent label suffices — but they are accepted in the
 * signature so a future schema-bump that needs cross-arm
 * disambiguation does not break adopter call sites.
 */
export function whyUpdated<T>(
  commit: CommitForDecoding,
  _prev: ResourceState<T>,
  _next: ResourceState<T>,
): ResourceUpdateReason {
  const intent = commit.intent
  // The adapter's intent labels are `${verb}:${key}` or
  // `fetch:${key}:${suffix}`. Order matters: longer prefixes first,
  // so `fetch:k:start` doesn't match `fetch:` alone.
  if (intent.startsWith('fetch:') && intent.endsWith(':start')) {
    return 'fetch-begin'
  }
  if (intent.startsWith('fetch:') && intent.endsWith(':loaded')) {
    return 'fetch-resolved'
  }
  if (intent.startsWith('fetch:') && intent.endsWith(':stale')) {
    return 'fetch-stale'
  }
  if (intent.startsWith('fetch:') && intent.endsWith(':error')) {
    return 'fetch-rejected'
  }
  if (intent.startsWith('invalidate:')) {
    return 'invalidated'
  }
  if (intent.startsWith('fail:')) {
    return 'failed'
  }
  // The commit was not directly on this resource — the update
  // observed by a downstream derived that carries this resource as
  // a dep. SPEC.async §11.1 names this 'dep-changed'.
  return 'dep-changed'
}

/**
 * Decode the reason a subscriber did NOT see an update on a given
 * commit. Returns one of {@link WhyNotUpdatedReason}, or `null` if
 * the resource actually did transition (prev !== next structurally).
 *
 * @remarks
 * Total over the engine's update-suppression logic:
 *   - Reference equality (`Object.is`) returns `'object-is-deduped'`
 *     because the engine's Phase B equality cutoff would have
 *     suppressed any commit producing a reference-equal next value.
 *   - Structural inequality but no actual update (a different
 *     object, different reference, same shape) returns
 *     `'no-dep-overlap'` — the commit's `changedNodes` set did not
 *     include this node.
 *   - Structural inequality WITH an update (different shape between
 *     prev and next) returns `null` — the dual is undefined here
 *     because the resource DID transition.
 *
 * Per SPEC.async §11.1, the typical "no update" reasons for a
 * resource are the two named in {@link WhyNotUpdatedReason}. A
 * future bump that surfaces additional reasons widens this union
 * and the decoder.
 */
export function whyNotUpdated<T>(
  prev: ResourceState<T>,
  next: ResourceState<T>,
): WhyNotUpdatedReason | null {
  if (Object.is(prev, next)) {
    return 'object-is-deduped'
  }
  // Structurally identical but different reference: the engine's
  // Object.is would NOT have suppressed (the references differ),
  // so reaching this branch means the commit was on a different
  // node and didn't include this resource in changedNodes.
  if (statesAreStructurallyEqual(prev, next)) {
    return 'no-dep-overlap'
  }
  // The resource actually transitioned; whyNotUpdated has no answer.
  return null
}

/**
 * Cheap structural-equality check over the closed five-arm
 * `ResourceState<T>` shape. Tag-aware so the same-tag case
 * compares only the fields that arm carries.
 */
function statesAreStructurallyEqual<T>(
  a: ResourceState<T>,
  b: ResourceState<T>,
): boolean {
  if (a.state !== b.state) return false
  switch (a.state) {
    case 'idle':
      return true
    case 'loading':
      // Promise identity is checked via Object.is intentionally —
      // SPEC.async §3.1 Theorem 3 commits to promise-identity stability
      // across the loading episode.
      return (
        a.origin === (b as typeof a).origin &&
        Object.is(a.promise, (b as typeof a).promise)
      )
    case 'loaded':
    case 'stale':
      return (
        Object.is(a.value, (b as typeof a).value) &&
        a.origin === (b as typeof a).origin &&
        a.loadedAt === (b as typeof a).loadedAt
      )
    case 'errored':
      return (
        Object.is(a.error, (b as typeof a).error) &&
        a.origin === (b as typeof a).origin &&
        a.erroredAt === (b as typeof a).erroredAt
      )
  }
}
