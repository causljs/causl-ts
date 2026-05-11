import { describe, it, expect } from 'vitest'
import {
  assertConsistentGraphTime,
  GraphTimeInconsistency,
} from '../assertConsistentGraphTime.js'

describe('assertConsistentGraphTime', () => {
  it('passes on an empty trace', () => {
    expect(() => assertConsistentGraphTime([])).not.toThrow()
  })

  it('passes when every selector in a frame agrees on the time', () => {
    expect(() =>
      assertConsistentGraphTime([
        { frameId: 1, selector: 'A', value: 1, time: 7 },
        { frameId: 1, selector: 'B', value: 2, time: 7 },
        { frameId: 1, selector: 'C', value: 3, time: 7 },
      ]),
    ).not.toThrow()
  })

  it('throws GraphTimeInconsistency when one frame has selectors at different times', () => {
    expect(() =>
      assertConsistentGraphTime([
        { frameId: 1, selector: 'A', value: 1, time: 7 },
        { frameId: 1, selector: 'B', value: 2, time: 8 }, // tear
      ]),
    ).toThrow(GraphTimeInconsistency)
  })

  it('passes when frames disagree but each frame is internally consistent', () => {
    // Two render frames; each is consistent within itself.
    expect(() =>
      assertConsistentGraphTime([
        { frameId: 1, selector: 'A', value: 1, time: 7 },
        { frameId: 1, selector: 'B', value: 2, time: 7 },
        { frameId: 2, selector: 'A', value: 1, time: 8 },
        { frameId: 2, selector: 'B', value: 2, time: 8 },
      ]),
    ).not.toThrow()
  })

  it('error message names the offending selectors', () => {
    try {
      assertConsistentGraphTime([
        { frameId: 'render-42', selector: 'header', value: 1, time: 7 },
        { frameId: 'render-42', selector: 'footer', value: 2, time: 8 },
      ])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(GraphTimeInconsistency)
      expect((e as Error).message).toContain('render-42')
      expect((e as Error).message).toContain('header')
      expect((e as Error).message).toContain('footer')
    }
  })

  it('exposes the observed grouping on the error for downstream inspection', () => {
    try {
      assertConsistentGraphTime([
        { frameId: 1, selector: 'A', value: 1, time: 7 },
        { frameId: 1, selector: 'B', value: 2, time: 8 },
      ])
      expect.unreachable()
    } catch (e) {
      const err = e as GraphTimeInconsistency
      expect(err.observed.size).toBe(2)
      expect(err.observed.get(7)?.[0]?.selector).toBe('A')
      expect(err.observed.get(8)?.[0]?.selector).toBe('B')
    }
  })
})
