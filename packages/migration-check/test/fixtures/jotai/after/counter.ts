// Post-migration causl counter. The drift detector must report
// findings.length === 0 for this file (no Jotai imports, no
// transitional bridge package). See docs/migration/from-jotai.md
// for the worked example this fixture mirrors.
import { createCausl } from '@causl/core'
import { useCausl, useDispatch, createUpdate } from '@causl/react'

type Msg = { kind: 'inc' } | { kind: 'set'; value: number }

export const graph = createCausl()
export const counter = graph.input('counter', 0)
export const doubled = graph.derived('doubled', (g) => g.read(counter) * 2)

export const update = createUpdate<Msg>(({ msg, commit }) => {
  if (msg.kind === 'inc') commit('counter:inc', (tx) => tx.write(counter, tx.read(counter) + 1))
  else commit('counter:set', (tx) => tx.write(counter, msg.value))
})

export function Counter(): unknown {
  const value = useCausl((g) => g.read(counter))
  const view = useCausl((g) => g.read(doubled))
  const dispatch = useDispatch<Msg>()
  return { value, view, dispatch }
}
