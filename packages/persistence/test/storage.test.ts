import { describe, expect, it } from 'vitest'
import { localStorageAdapter, memoryAdapter } from '../src/index.js'

describe('memoryAdapter', () => {
  it('round-trips set/get/delete', () => {
    const a = memoryAdapter()
    expect(a.get('k')).toBe(null)
    a.set('k', 'v')
    expect(a.get('k')).toBe('v')
    a.delete('k')
    expect(a.get('k')).toBe(null)
  })

  it('seeds from initial state', () => {
    const a = memoryAdapter({ pre: '1', set: '2' })
    expect(a.get('pre')).toBe('1')
    expect(a.get('set')).toBe('2')
  })
})

describe('localStorageAdapter', () => {
  it('round-trips through window.localStorage', () => {
    if (
      typeof localStorage === 'undefined' ||
      typeof localStorage.setItem !== 'function'
    ) {
      // jsdom build without full Storage; the adapter falls back to
      // memory which the memoryAdapter test already covers.
      return
    }
    localStorage.setItem('test:k', 'previous')
    const a = localStorageAdapter()
    a.set('test:k', 'value')
    expect(a.get('test:k')).toBe('value')
    a.delete('test:k')
    expect(a.get('test:k')).toBe(null)
  })

  // SSR-fallback path is tested at the unit level in persistedInput
  // tests via memoryAdapter() — overriding the global causes order-
  // dependent leakage between vitest test files.
})
