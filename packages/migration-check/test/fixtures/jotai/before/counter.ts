// Pre-migration Jotai counter store. The drift detector must
// surface J-01 (input atom), J-02 (derived atom), J-05
// (useAtomValue), and J-06 (useSetAtom) for this file — see
// docs/migration/RULE_CATALOGUE.md and docs/migration/from-jotai.md.
import { atom, useAtomValue, useSetAtom } from 'jotai'

export const counterAtom = atom(0)
export const doubledAtom = atom((get) => get(counterAtom) * 2)

export function Counter(): unknown {
  const counter = useAtomValue(counterAtom)
  const doubled = useAtomValue(doubledAtom)
  const setCounter = useSetAtom(counterAtom)
  return { counter, setCounter, doubled }
}
