// Post-migration causl counter (from MobX). No MobX imports;
// no transitional bridge. See docs/migration/from-mobx.md.
import { createCausl } from '@causl/core'
import { createUpdate } from '@causl/react'

type Msg = { kind: 'inc' }

export const graph = createCausl()
export const counter = graph.input('counter', 0)

export const update = createUpdate<Msg>(({ commit }) => {
  commit('counter:inc', (tx) => tx.write(counter, tx.read(counter) + 1))
})
