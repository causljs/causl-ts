/**
 * @packageDocumentation
 *
 * `@causl/sync/resource` — sub-import for adopters who only need
 * the resource primitive. Per SPEC.async §14.2's bundle-budget
 * granularity, callers that don't need the conflict registry pay
 * only for what they import.
 */

export type { ResourceHandle, ResourceOptions, ResourceState } from './resource.js'
export { ForbiddenResourceTransitionError, resource } from './resource.js'
