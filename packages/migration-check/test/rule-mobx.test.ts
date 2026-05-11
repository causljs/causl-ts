/**
 * Per-rule fixture corpus for the M-NN (MobX → causl) family.
 */

import { describe, expect, it } from 'vitest'
import { scanFile } from '../src/index.js'

function ids(src: string): string[] {
  return scanFile('src/x.ts', src).map((f) => f.ruleId)
}

describe('rule M-01 — makeAutoObservable', () => {
  it('fires on makeAutoObservable(this)', () => {
    expect(
      ids(`import { makeAutoObservable } from 'mobx'\nclass S { constructor() { makeAutoObservable(this) } }`),
    ).toContain('M-01')
  })
})

describe('rule M-02 — computed', () => {
  it('fires on computed(...) call', () => {
    expect(
      ids(`import { computed } from 'mobx'\nconst c = computed(() => 1)`),
    ).toContain('M-02')
  })
  it('fires on @computed decorator', () => {
    expect(
      ids(
        `import { computed } from 'mobx'\nclass S { @computed get x() { return 1 } }`,
      ),
    ).toContain('M-02')
  })
})

describe('rule M-03 — @observable field', () => {
  it('fires on @observable field decorator', () => {
    expect(
      ids(`import { observable } from 'mobx'\nclass S { @observable x = 0 }`),
    ).toContain('M-03')
  })
})

describe('rule M-04 — runInAction with multiple assigns', () => {
  it('fires on runInAction with two assignments', () => {
    expect(
      ids(
        `import { runInAction } from 'mobx'\nrunInAction(() => { store.x = 1; store.y = 2 })`,
      ),
    ).toContain('M-04')
  })
  it('does not fire on runInAction with a single assignment', () => {
    expect(
      ids(
        `import { runInAction } from 'mobx'\nrunInAction(() => { store.x = 1 })`,
      ),
    ).not.toContain('M-04')
  })
})

describe('rule M-05 — reaction', () => {
  it('fires on reaction call', () => {
    expect(
      ids(`import { reaction } from 'mobx'\nreaction(() => x, (v) => {})`),
    ).toContain('M-05')
  })
})

describe('rule M-06 — autorun', () => {
  it('fires on autorun call', () => {
    expect(
      ids(`import { autorun } from 'mobx'\nautorun(() => log(x))`),
    ).toContain('M-06')
  })
})
