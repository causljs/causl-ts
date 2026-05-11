/**
 * Per-rule fixture corpus for the R-NN (Redux/RTK → causl) family.
 */

import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

function ids(src: string): string[] {
  return scanFile('src/x.ts', src).map((f) => f.ruleId)
}

describe('rule R-01 — createSlice', () => {
  it('fires on createSlice call', () => {
    expect(
      ids(
        `import { createSlice } from '@reduxjs/toolkit'\nconst s = createSlice({ name: 'x', initialState: 0, reducers: {} })`,
      ),
    ).toContain('R-01')
  })
})

describe('rule R-02 — useSelector', () => {
  it('fires on useSelector call', () => {
    expect(
      ids(
        `import { useSelector } from 'react-redux'\nfunction C() { return useSelector((s) => s) }`,
      ),
    ).toContain('R-02')
  })
})

describe('rule R-03 — useDispatch', () => {
  it('fires on useDispatch call', () => {
    expect(
      ids(
        `import { useDispatch } from 'react-redux'\nfunction C() { const d = useDispatch(); return null }`,
      ),
    ).toContain('R-03')
  })
})

describe('rule R-04 — createAsyncThunk', () => {
  it('fires on createAsyncThunk call', () => {
    expect(
      ids(
        `import { createAsyncThunk } from '@reduxjs/toolkit'\nconst t = createAsyncThunk('x', async () => 0)`,
      ),
    ).toContain('R-04')
  })
})

describe('rule R-05 — createSelector', () => {
  it('fires on createSelector call', () => {
    expect(
      ids(
        `import { createSelector } from '@reduxjs/toolkit'\nconst s = createSelector([sel], (x) => x)`,
      ),
    ).toContain('R-05')
  })
  it('fires on reselect import', () => {
    expect(
      ids(
        `import { createSelector } from 'reselect'\nconst s = createSelector([sel], (x) => x)`,
      ),
    ).toContain('R-05')
  })
})

describe('rule R-06 — extraReducers with addCase pending', () => {
  it('fires on extraReducers builder with pending', () => {
    expect(
      ids(`const slice = { extraReducers: (b) => { b.addCase(thunk.pending, () => {}) } }`),
    ).toContain('R-06')
  })
})
