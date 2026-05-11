import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('@causl/devtools-bridge', () => {
  it('exports a version', () => {
    expect(typeof VERSION).toBe('string')
  })
})
