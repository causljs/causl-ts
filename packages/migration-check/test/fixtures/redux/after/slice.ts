// Post-migration causl counter (from Redux Toolkit). No
// react-redux / @reduxjs/toolkit imports; no transitional bridge.
// See docs/migration/from-redux.md.
import { createCausl } from '@causl/core'
import { useCausl, useDispatch, createUpdate } from '@causl/react'

type Msg = { kind: 'inc' }

export const graph = createCausl()
export const counter = graph.input('counter', 0)

export const update = createUpdate<Msg>(({ commit }) => {
  commit('counter:inc', (tx) => tx.write(counter, tx.read(counter) + 1))
})

export function Counter(): unknown {
  const value = useCausl((g) => g.read(counter))
  const dispatch = useDispatch<Msg>()
  return { value, dispatch }
}
