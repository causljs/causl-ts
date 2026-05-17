import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('@causljs/devtools-bridge', () => {
  it('exports a version', () => {
    expect(typeof VERSION).toBe('string')
  })
})
