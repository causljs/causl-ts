/**
 * Tree-shake / zero-cost gate (review-209 P0).
 *
 * The bridge claims that consumers pay nothing at runtime when the
 * Redux DevTools Extension is absent. These tests assert that claim
 * via observable side-effect counts: when `__REDUX_DEVTOOLS_EXTENSION__`
 * is undefined, `connectDevtools` must not subscribe to commits, must
 * not allocate a connection, and must return a stable shared no-op
 * disposer.
 *
 * Bundle-size gating is enforced separately via `size-limit` once the
 * package ships a build artifact (#146). These tests are the
 * unit-level proof that the runtime path is allocation-free in the
 * absent-extension case.
 */

import { createCausl } from '@causljs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDevtools, isExtensionAvailable } from '../src/connect.js'

describe('connectDevtools zero-cost gate when extension is absent (review-209 P0)', () => {
  beforeEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })
  afterEach(() => {
    delete (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: unknown })
      .__REDUX_DEVTOOLS_EXTENSION__
  })

  it('reports the extension absent', () => {
    expect(isExtensionAvailable()).toBe(false)
  })

  it('does NOT subscribe to commits when the extension is absent', () => {
    const g = createCausl()
    const subscribeCommitsSpy = vi.spyOn(g, 'subscribeCommits')
    connectDevtools(g)
    expect(subscribeCommitsSpy).not.toHaveBeenCalled()
  })

  it('does NOT call snapshot() when the extension is absent', () => {
    const g = createCausl()
    const snapshotSpy = vi.spyOn(g, 'snapshot')
    connectDevtools(g)
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('returns the same shared no-op disposer reference across calls', () => {
    const g1 = createCausl()
    const g2 = createCausl()
    const d1 = connectDevtools(g1)
    const d2 = connectDevtools(g2)
    // Reference identity: the absent-extension path must not allocate a
    // fresh closure per call. Pinning the identity here is the
    // tree-shake / zero-cost contract surface.
    expect(d1).toBe(d2)
  })

  it('disposer is callable any number of times without side effects', () => {
    const g = createCausl()
    const dispose = connectDevtools(g)
    expect(() => {
      dispose()
      dispose()
      dispose()
    }).not.toThrow()
  })

  it('does NOT touch any public Graph method beyond the absence check', () => {
    const g = createCausl()
    const inputSpy = vi.spyOn(g, 'input')
    const commitSpy = vi.spyOn(g, 'commit')
    const readSpy = vi.spyOn(g, 'read')
    const subscribeSpy = vi.spyOn(g, 'subscribe')
    const subscribeCommitsSpy = vi.spyOn(g, 'subscribeCommits')
    const explainSpy = vi.spyOn(g, 'explain')
    const exportModelSpy = vi.spyOn(g, 'exportModel')
    const snapshotSpy = vi.spyOn(g, 'snapshot')
    const hydrateSpy = vi.spyOn(g, 'hydrate')

    connectDevtools(g)

    expect(inputSpy).not.toHaveBeenCalled()
    expect(commitSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
    expect(subscribeSpy).not.toHaveBeenCalled()
    expect(subscribeCommitsSpy).not.toHaveBeenCalled()
    expect(explainSpy).not.toHaveBeenCalled()
    expect(exportModelSpy).not.toHaveBeenCalled()
    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(hydrateSpy).not.toHaveBeenCalled()
  })
})
