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

export type { ResourceHandle, ResourceOptions, ResourceState } from './resource.js'
export { ForbiddenResourceTransitionError, resource } from './resource.js'

// SPEC.async §11.1 — `whyUpdated` / `whyNotUpdated` decoders + the
// closed seven-arm `ResourceUpdateReason` enumeration (#577).
export type {
  CommitForDecoding,
  ResourceUpdateReason,
  WhyNotUpdatedReason,
} from './whyUpdated.js'
export {
  RESOURCE_UPDATE_REASONS,
  whyUpdated,
  whyNotUpdated,
} from './whyUpdated.js'

export type {
  Conflict,
  ConflictBase,
  ConflictKind,
  ConflictRegistry,
  ConflictRegistryOptions,
  ConflictRegistryReadGraph,
  ConflictRegistryWriteGraph,
} from './conflict.js'
export {
  createConflictRegistry,
  ForbiddenConflictTransitionError,
  singleConflictWhen,
} from './conflict.js'

/**
 * Semver string for the published `@causl/sync` artifact.
 *
 * @remarks
 * Pinned at `0.0.0` for the pre-release lineage; bumped by the release
 * tooling, not edited by hand.
 */
export const VERSION = '0.0.0'
