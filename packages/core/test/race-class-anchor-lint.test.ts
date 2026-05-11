/**
 * @packageDocumentation
 *
 * EPIC-12 / TASK 12.6 — race-class-anchor lint tests.
 *
 * Pins the validator function (`validateSection`) the lint script
 * uses. The full CLI is exercised in CI via the workflow integration
 * (TASK 12.6's wiring step); this file pins the predicate so a
 * regression to the parsing surface trips here.
 */

import { describe, expect, it } from 'vitest'
import { validateSection } from '../../../tools/lint/race-class-anchor-check.js'

describe('TASK 12.6 — race-class-anchor lint', () => {
  it('passes when the section names a STATIC layer', () => {
    expect(
      validateSection(
        'Row 14: STATIC\nWitness: tools/checker/src/check.rs::subscribe_without_dispose_pass',
      ),
    ).toBeNull()
  })

  it('passes when the section names a PROPERTY layer', () => {
    expect(
      validateSection(
        'Row S-1: PROPERTY\nWitness: packages/sync/test/properties/race-row-S-1.property.test.ts',
      ),
    ).toBeNull()
  })

  it('passes when the section names a MODEL layer', () => {
    expect(
      validateSection(
        'Row 11: MODEL\nWitness: tools/enumerator/corpus/apalache/dispose_then_read.tla',
      ),
    ).toBeNull()
  })

  it('passes when the section names RUNTIME-ONLY with justification', () => {
    expect(
      validateSection(
        'Row 16: RUNTIME-ONLY\nJustification: synchronous dispose-during-commit window guarded by Phase F.5',
      ),
    ).toBeNull()
  })

  it('fails when the section is empty', () => {
    expect(validateSection('')).toMatch(/empty or _None_/i)
  })

  it('fails when the section is the _None_ placeholder', () => {
    expect(validateSection('_None_')).toMatch(/empty or _None_/i)
  })

  it('fails when the section names no detection layer', () => {
    expect(validateSection('Some prose without a layer keyword')).toMatch(
      /no detection layer/i,
    )
  })

  it('fails when the section names an unknown layer', () => {
    expect(validateSection('Row X: BOGUS\nWitness: somewhere')).toMatch(
      /no detection layer/i,
    )
  })
})
