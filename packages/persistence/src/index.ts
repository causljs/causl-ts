/**
 * @causljs/persistence — framework-neutral UI-preference persistence
 * for Causl. The information model (the user's mental world: cells
 * with formulas, assets, bookings) and the editor-controller state
 * (the user's tools: cursor, selection, column widths, the mode the
 * editor is in) live in separate identifier namespaces with separate
 * lifetimes. This package persists the latter only. Inputs only;
 * derived values are pure functions of their inputs at the same
 * `GraphTime`, so they recompute on rehydration rather than being
 * written to disk — anything else would be a glitch-freedom hazard and
 * a redundant cache.
 */

export type { StorageAdapter } from './storage.js'
export { localStorageAdapter, memoryAdapter } from './storage.js'

export type {
  PersistedInputOptions,
  PersistenceError,
  PersistenceErrorHandler,
  PersistenceGraph,
} from './persistedInput.js'
export { persistedInput } from './persistedInput.js'

export const VERSION = '0.0.0'
