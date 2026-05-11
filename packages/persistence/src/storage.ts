/**
 * StorageAdapter contract — minimum surface a backing store must
 * provide to be a persistedInput sink.
 *
 * Sync-only by design (#119): hydration must run before the first
 * commit. The engine's only mutation API is `graph.commit`, which
 * advances time by exactly one per call; there is no fractional time
 * and no concurrent-mutation API. Hydration therefore must produce a
 * fully-loaded initial value before the first `commit` runs, or that
 * commit would be observing a half-loaded snapshot. Async stores
 * (`chrome.storage`, `IndexedDB`) wrap a sync hot cache; the hot
 * cache implements this interface.
 */

export interface StorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

/** Default localStorage-backed adapter. */
export function localStorageAdapter(): StorageAdapter {
  if (typeof localStorage === 'undefined') {
    return memoryAdapter() // SSR / non-DOM safety
  }
  return {
    get(key) {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value)
      } catch {
        // QuotaExceeded / private mode — silent drop, app continues.
      }
    },
    delete(key) {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
    },
  }
}

/** In-memory adapter. Useful for tests and SSR. */
export function memoryAdapter(initial?: Record<string, string>): StorageAdapter {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v)
    },
    delete: (k) => {
      map.delete(k)
    },
  }
}
