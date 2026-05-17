import { ResourceState } from './resource-entry.js';
export { ForbiddenResourceTransitionError, ResourceHandle, ResourceOptions, resource } from './resource-entry.js';
export { Conflict, ConflictBase, ConflictKind, ConflictRegistry, ConflictRegistryOptions, ConflictRegistryReadGraph, ConflictRegistryWriteGraph, ForbiddenConflictTransitionError, createConflictRegistry, singleConflictWhen } from './conflict-entry.js';
import '@causl/core';

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

/**
 * Closed seven-arm enumeration of the reasons a resource node was
 * updated in a commit. Per SPEC.async §11.1.
 */
type ResourceUpdateReason = 'fetch-begin' | 'fetch-resolved' | 'fetch-stale' | 'fetch-rejected' | 'invalidated' | 'failed' | 'dep-changed';
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
declare const RESOURCE_UPDATE_REASONS: readonly ["fetch-begin", "fetch-resolved", "fetch-stale", "fetch-rejected", "invalidated", "failed", "dep-changed"];
/**
 * Reasons a subscriber did NOT see an update on a given commit, as
 * a closed two-arm union. Returned by {@link whyNotUpdated}.
 */
type WhyNotUpdatedReason = 'no-dep-overlap' | 'object-is-deduped';
/**
 * Minimal commit shape the decoders consume. The full {@link Commit}
 * type lives in `@causl/core` and carries more fields; the decoders
 * only need `intent`, so we accept the structural subset to avoid
 * an avoidable cross-package import on the helper surface.
 */
interface CommitForDecoding {
    /** The intent label passed to `graph.commit(intent, ...)`. */
    readonly intent: string;
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
declare function whyUpdated<T>(commit: CommitForDecoding, _prev: ResourceState<T>, _next: ResourceState<T>): ResourceUpdateReason;
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
declare function whyNotUpdated<T>(prev: ResourceState<T>, next: ResourceState<T>): WhyNotUpdatedReason | null;

/**
 * @packageDocumentation
 *
 * Public barrel for `@causl/sync` — async-resource bindings layered
 * over the Causl engine. The semantic core is deliberately unaware
 * of `fetch`; this package is the adapter that lives above it,
 * modelling external fetches as Events feeding Inputs and surfacing
 * the lifecycle as a tagged {@link ResourceState} discriminated union.
 * Its five tags (Idle / Loading / Loaded / Stale / Errored) are the
 * ResourceFleet sub-statechart — one of the orthogonal regions of the
 * composite lifecycle, with a per-resource sub-machine running inside
 * it. Conflicts ride a different orthogonal region: a derived-view
 * registry that overlays resolution status onto an application-supplied
 * open-set computation.
 *
 * The two entry points re-exported here — {@link resource} and
 * {@link createConflictRegistry} — together cover the staleness-guard
 * contract and the conflict orthogonal region of the composite
 * lifecycle without introducing any state outside the engine's
 * Input/Derived primitives.
 */

/**
 * Semver string for the published `@causl/sync` artifact.
 *
 * @remarks
 * Pinned at `0.0.0` for the pre-release lineage; bumped by the release
 * tooling, not edited by hand.
 */
declare const VERSION = "0.0.0";

export { type CommitForDecoding, RESOURCE_UPDATE_REASONS, ResourceState, type ResourceUpdateReason, VERSION, type WhyNotUpdatedReason, whyNotUpdated, whyUpdated };
