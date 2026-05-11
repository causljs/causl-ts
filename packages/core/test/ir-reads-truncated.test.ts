/**
 * @packageDocumentation
 *
 * `CauslModel.readsTruncated` field per EPIC-1 brutal-critical
 * review #4 / #584 A17-4.
 *
 * Tests pin:
 *   - The field is optional on the type — pre-#584 documents
 *     omitting it still parse.
 *   - When `true`, the field flows through JSON round-trip.
 *   - When `false` or absent, the field is back-compat with the
 *     pre-#584 wire format.
 *   - parseCauslModel accepts both shapes.
 */

import { describe, expect, test } from 'vitest'
import {
  CAUSL_MODEL_SCHEMA,
  parseCauslModel,
  type CauslModel,
} from '../src/ir.js'

const baseModel = {
  schema: CAUSL_MODEL_SCHEMA,
  time: 0,
  nodes: [],
  commits: [],
  events: [],
  scopes: [],
  bridges: [],
} as const

describe('CauslModel.readsTruncated (#584 A17-4)', () => {
  test('field is optional — model without it parses cleanly', () => {
    const result = parseCauslModel({ ...baseModel })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.readsTruncated).toBeUndefined()
    }
  })

  test('field accepts true via the type', () => {
    const m: CauslModel = { ...baseModel, readsTruncated: true }
    const result = parseCauslModel(m)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.readsTruncated).toBe(true)
    }
  })

  test('field accepts false via the type', () => {
    const m: CauslModel = { ...baseModel, readsTruncated: false }
    const result = parseCauslModel(m)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.readsTruncated).toBe(false)
    }
  })

  test('round-trip preserves readsTruncated when true', () => {
    const m: CauslModel = { ...baseModel, readsTruncated: true }
    const json = JSON.parse(JSON.stringify(m))
    const result = parseCauslModel(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.readsTruncated).toBe(true)
    }
  })

  test('absence of readsTruncated equals false (back-compat default)', () => {
    // Pre-#584 documents have no readsTruncated field. Adopters
    // checking `if (model.readsTruncated)` see false (undefined
    // is falsy). The semantic-default-of-false is what makes the
    // back-compat work — no migration needed for existing models.
    const result = parseCauslModel({ ...baseModel })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Idiomatic check: explicit treatment.
      const truncated = result.value.readsTruncated === true
      expect(truncated).toBe(false)
    }
  })
})
