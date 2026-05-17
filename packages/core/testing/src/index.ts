/**
 * @causl/core/testing — shared test seam.
 *
 * Test-only. Do not import from production code. See the package
 * README for the rationale and the per-helper docs.
 */

export { recomputeCounter } from './recomputeCounter.js'
export type { RecomputeCounter } from './recomputeCounter.js'

export { glitchDetector } from './glitchDetector.js'
export type { GlitchDetector } from './glitchDetector.js'

export {
  assertConsistentGraphTime,
  GraphTimeInconsistency,
} from './assertConsistentGraphTime.js'
export type { TraceEntry } from './assertConsistentGraphTime.js'

export {
  assertResultStability,
  ResultInstability,
} from './assertResultStability.js'
export type { StabilityProbe } from './assertResultStability.js'

export { propertyTrials, tieredPropertyTrials } from './propertyTrials.js'
export type { PropertyTrialsOptions, PropertyTrialsConfig } from './propertyTrials.js'

export { propertyDag, buildPropertyDag } from './propertyDag.js'
export type {
  DagSpec,
  DerivedSpec,
  PropertyDagOptions,
} from './propertyDag.js'

export { disposedTombstoneSize } from './disposedTombstoneSize.js'

export { commitLogConsumerCount } from './commitLogConsumerCount.js'

export { derivedDeps } from './derivedDeps.js'

export {
  arbAdversarialValue,
  adversarialBranch,
  ordinaryBranch,
  ADVERSARIAL_NUMBERS_NAN,
  ADVERSARIAL_NUMBERS_SIGNED_ZERO,
  ADVERSARIAL_NUMBERS_BOUNDARY,
  ADVERSARIAL_STRING_LENGTHS,
  ADVERSARIAL_OBJECT_DEPTHS,
} from './arbAdversarialValue.js'
export type { ArbAdversarialValueOptions } from './arbAdversarialValue.js'
