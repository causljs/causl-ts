// Pre-migration MobX counter store. The drift detector must
// surface M-01 (makeAutoObservable) for this file — see
// docs/migration/RULE_CATALOGUE.md and docs/migration/from-mobx.md.
import { makeAutoObservable } from 'mobx'

export class CounterStore {
  count = 0
  constructor() {
    makeAutoObservable(this)
  }
  inc(): void {
    this.count += 1
  }
}
