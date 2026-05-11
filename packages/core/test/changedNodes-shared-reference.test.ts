/**
 * @packageDocumentation
 *
 * Pins #703 Win 6 (#754): the engine allocates and freezes the
 * `changedNodes` array exactly once per commit and shares the
 * resulting reference between the observer-visible `Commit.changedNodes`
 * and the history-append `IRCommit.changedNodes`. The triple
 * `Object.freeze(changedNodes.slice())` the audit flagged becomes a
 * single allocation + freeze; downstream readers (subscribers,
 * `exportModel`, replay tooling) see a referentially-identical array.
 *
 * Why pin the identity? The optimisation is byte-equivalent in
 * observable behaviour but relies on a subtle invariant: no engine
 * code path mutates the shared array post-publication. Pinning
 * `commit.changedNodes === historyEntry.changedNodes` turns any
 * future regression that re-introduces a defensive `.slice()` (or
 * mutates one of the surfaces in place) into a typed test failure
 * rather than a silent throughput regression.
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

describe('#703 Win 6 — shared frozen `changedNodes` reference (#754)', () => {
  /**
   * The Commit returned to observers and the IRCommit appended to
   * `commitHistory` (surfaced through `exportModel().commits`) carry
   * the exact same array instance — not just a structurally-equal
   * copy. Asserted via `Object.is` (referential equality) on the
   * `changedNodes` property of both records.
   */
  it('commit.changedNodes === historyEntry.changedNodes (referential equality)', () => {
    // arrange: graph with retention enabled so the history-append
    // path actually fires (cap=0 short-circuits Phase F per #715).
    const g = createCausl({ commitHistoryCap: 10 })
    const a = g.input('a', 0)
    g.derived('sum', (get) => get(a) + 1)
    // act: drive a commit that produces a non-empty change set.
    const c = g.commit('w1', (tx) => tx.set(a, 1))
    // assert: changedNodes contents are correct (sanity).
    expect(c.changedNodes).toContain('a')
    expect(c.changedNodes).toContain('sum')
    // assert: the IRCommit row in `exportModel().commits` carries the
    // exact same array instance — not a copy. This is the Win 6
    // share: one frozen reference, two surfaces.
    const m = g.exportModel({ maxCommits: 100 })
    expect(m.commits.length).toBe(1)
    const ir0 = m.commits[0]
    if (!ir0) throw new Error('expected one IR commit row')
    expect(ir0.changedNodes).toBe(c.changedNodes)
  })

  /**
   * The shared reference is preserved across multiple commits — every
   * Commit's `changedNodes` matches its corresponding IRCommit row's
   * `changedNodes` by identity, in commit order.
   */
  it('reference identity holds across multiple sequential commits', () => {
    // arrange: graph with retention; multiple commits.
    const g = createCausl({ commitHistoryCap: 10 })
    const a = g.input('a', 0)
    // act: capture each Commit return value as the engine emits it.
    const commits = []
    for (let i = 0; i < 5; i++) {
      commits.push(g.commit(`c${i}`, (tx) => tx.set(a, i + 1)))
    }
    // assert: every committed `changedNodes` is the same instance the
    // history retains. Using `Object.is` semantics via `.toBe`.
    const m = g.exportModel({ maxCommits: 100 })
    expect(m.commits.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      const irRow = m.commits[i]
      const localCommit = commits[i]
      if (!irRow || !localCommit) throw new Error(`missing row at ${i}`)
      expect(irRow.changedNodes).toBe(localCommit.changedNodes)
    }
  })

  /**
   * The shared array is frozen by default (production-mode sharing
   * without `freezeOffInProd`) — pinning the immutability surface
   * the audit relies on. Tampering attempts throw in strict mode.
   */
  it('the shared `changedNodes` array is frozen by default', () => {
    // arrange: graph at default flag settings (freezeIfDev → freezes).
    const g = createCausl({ commitHistoryCap: 10 })
    const a = g.input('a', 0)
    // act: one commit produces the shared array.
    const c = g.commit('w1', (tx) => tx.set(a, 1))
    // assert: the array is frozen — sealing the contract that no
    // post-publication code path can mutate it.
    expect(Object.isFrozen(c.changedNodes)).toBe(true)
  })
})
