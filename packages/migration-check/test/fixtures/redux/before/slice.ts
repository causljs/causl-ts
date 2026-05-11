// Pre-migration Redux Toolkit slice. The drift detector must
// surface R-01 (createSlice), R-02 (useSelector), R-03 (useDispatch)
// for this file — see docs/migration/RULE_CATALOGUE.md and
// docs/migration/from-redux.md.
import { createSlice } from '@reduxjs/toolkit'
import { useSelector, useDispatch } from 'react-redux'

export const counterSlice = createSlice({
  name: 'counter',
  initialState: 0,
  reducers: {
    inc: (s) => s + 1,
  },
})

export function Counter(): unknown {
  const value = useSelector((s: { counter: number }) => s.counter)
  const dispatch = useDispatch()
  return { value, dispatch }
}
