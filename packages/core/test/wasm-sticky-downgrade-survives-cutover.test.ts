/**
 * Phase 5 #1564 + V2.5 #1544 — sticky-downgrade survives default flip.
 *
 * Acceptance gate: the structured `RustSsotDowngradedError` class and
 * its stable `RUST_SSOT_DOWNGRADE_ERROR_CODE` export
 * (`'CAUSL_RUST_SSOT_DOWNGRADED'`) must outlive the Phase 5 default
 * flip. After the flip, a graph created without an explicit `engine`
 * option (which then resolves to the new `'rust-ssot'` default) must
 * still surface a sticky downgrade via the same error class + code
 * when divergence is injected — i.e. the V2.5 (#1544) contract is
 * not silently weakened by the cutover.
 *
 * Expected initial state (today, on `epic/1558-zero-boundary`): the
 * class + code constant already ship, so the first `it()` runs and
 * passes today and continues to pass post-cutover. The second case
 * is `it.todo` because it depends on the flipped default; the
 * implementer fills its body when Phase 5 lands.
 */

import { describe, it, expect } from 'vitest'
import {
  RustSsotDowngradedError,
  RUST_SSOT_DOWNGRADE_ERROR_CODE,
} from '../wasm/index.js'

describe('Phase 5 #1564 — sticky-downgrade survives default-flip cutover', () => {
  it('RustSsotDowngradedError class and error code constant survive', () => {
    expect(RUST_SSOT_DOWNGRADE_ERROR_CODE).toBe('CAUSL_RUST_SSOT_DOWNGRADED')
    const err = new RustSsotDowngradedError('test divergence detail')
    expect(err.code).toBe('CAUSL_RUST_SSOT_DOWNGRADED')
    expect(err).toBeInstanceOf(RustSsotDowngradedError)
  })

  it.todo(
    'after Phase 5: a graph with engine: undefined (now defaulting to rust-ssot) still surfaces sticky-downgrade on injected divergence',
  )
})
