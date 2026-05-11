/**
 * @packageDocumentation
 *
 * Vitest global setup for the React package's test suite. Registers a
 * post-test hook that unmounts every component rendered through
 * `@testing-library/react`, ensuring isolation between tests so leftover
 * DOM nodes from one case cannot leak into the next.
 */

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * Tear down any components left mounted by `render(...)` after each
 * test completes. Without this, the jsdom container accumulates trees
 * across cases and selectors return stale matches.
 */
afterEach(() => {
  // Unmount React trees and detach event listeners between tests.
  cleanup()
})
