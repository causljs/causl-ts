/**
 * @packageDocumentation
 *
 * `@causljs/sync/conflict` — sub-import for adopters who only need
 * the conflict registry primitive. Per SPEC.async §14.2's bundle-
 * budget granularity, callers that don't need the resource
 * primitive pay only for what they import.
 */

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
