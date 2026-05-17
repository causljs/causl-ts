/**
 * Phase 5 #1564 — DEFAULT_WASM_ENGINE_MODE flip contract.
 *
 * Acceptance gate: after Phase 5 lands the rust-ssot cutover, the
 * exported `DEFAULT_WASM_ENGINE_MODE` constant in
 * `packages/core/wasm/index.ts` must equal `'rust-ssot'`. Today
 * (epic/1558-zero-boundary, pre-cutover) it is still `'js-ssot'`.
 *
 * Expected initial state: this test is marked `it.fails(...)` so the
 * vitest runner expects the body to throw. While the constant is
 * still `'js-ssot'` the assertion throws and the test is GREEN. When
 * Phase 5 flips the constant to `'rust-ssot'`, the assertion stops
 * throwing, `it.fails` then reports RED, and the implementer removes
 * the `.fails` marker to lock in the new default.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_WASM_ENGINE_MODE } from '../wasm/index.js'

describe('Phase 5 #1564 — DEFAULT_WASM_ENGINE_MODE flip', () => {
  it.fails(
    "after Phase 5, DEFAULT_WASM_ENGINE_MODE === 'rust-ssot' (today still 'js-ssot')",
    () => {
      expect(DEFAULT_WASM_ENGINE_MODE).toBe('rust-ssot')
    },
  )
})
