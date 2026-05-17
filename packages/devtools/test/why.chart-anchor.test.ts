/**
 * @packageDocumentation
 *
 * Pins every {@link WhyReason} variant to the §6 / §1.1 chart-named edge
 * that justifies it. Each behavioural row constructs a graph whose commit
 * window forces the engine through one specific Engine-region transition,
 * then asserts the explainer reports the corresponding tag.
 *
 * The `lifecycle-§5.4 conformance` block is the closed-set check from the
 * issue: every literal in the `WhyReason` union must appear under the
 * `### 5.4 WhyReason region` heading of `docs/lifecycle.md`, with one row
 * per value. New tag → broken test → must add a row before merge,
 * mirroring §5.3's `ObserverErrorContext.source` discipline mechanically.
 *
 * @see docs/lifecycle.md §5.4 — WhyReason region
 * @see docs/lifecycle.md §1.1 — Engine region edges
 * @see SPEC.md §17 commitment 7 — no enum tags without §6 transitions
 *
 * Tests construct the engine with explicit `commitHistoryCap` /
 * `snapshotRetentionCap` because SPEC §5.1 Amendment 2 (#716) flipped
 * the default to 0; the chart-anchor pins ride on the §11 explainer
 * primitives, which walk `graph.commitLog` — opt-in retention is a
 * hard precondition.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'

import { whyNotUpdated, whyUpdated } from '../src/index.js'

/**
 * Closed enumeration of every `WhyReason` literal currently shipped by
 * `packages/devtools/src/why.ts`. The doc-conformance block below treats
 * this list as the authoritative source: any new tag added to the union
 * must also appear here, fail the doc check, and gain a §5.4 row.
 */
const WHY_REASONS = [
  'recomputed',
  'directly-set',
  'no-cause',
  'did-update',
  'no-dep-overlap',
  'object-is-deduped',
] as const

/**
 * Resolve the repository's `docs/lifecycle.md` from this test file's
 * location so the conformance check is robust to monorepo CWD differences.
 */
function readLifecycleDoc(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // packages/devtools/test → repo root is three levels up.
  const repoRoot = resolve(here, '..', '..', '..')
  return readFileSync(resolve(repoRoot, 'docs', 'lifecycle.md'), 'utf8')
}

/**
 * Behavioural pinning: every `WhyReason` literal must be reachable by a
 * commit window that drives the Engine region through the §1.1 edge that
 * the §5.4 row claims justifies the tag.
 */
describe('WhyReason chart-anchor (§6 / §1.1)', () => {
  /**
   * `directly-set` ← `Publishing` reached via `Staging` (the node was
   * written inside `Staging.CollectingWrites`, not produced by recompute).
   */
  it('directly-set: Publishing via Staging — node written in tx callback', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyUpdated(g, a)
    g.commit('a→7', (tx) => tx.set(a, 7))
    expect(g.read(why).reason).toBe('directly-set')
  })

  /**
   * `recomputed` ← `Publishing` reached via `Recomputing → Validating`
   * (the node was rewalked during `Recomputing.WalkingDirty`).
   */
  it('recomputed: Publishing via Recomputing → Validating — derived rewalked', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const sum = g.derived('sum', (get) => get(a) + 1)
    const why = whyUpdated(g, sum)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(g.read(why).reason).toBe('recomputed')
  })

  /**
   * `no-cause` (whyUpdated): no `Publishing` event in the window touched
   * the node — every commit's `changedNodes` is disjoint from `{ node }`.
   */
  it('no-cause via whyUpdated: no Publishing edge touched the node', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const why = whyUpdated(g, b)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(g.read(why).reason).toBe('no-cause')
  })

  /**
   * `no-cause` (whyNotUpdated): empty window — no `Publishing` event to
   * reason against.
   */
  it('no-cause via whyNotUpdated: empty commit window', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyNotUpdated(g, a)
    expect(g.read(why).reason).toBe('no-cause')
  })

  /**
   * `did-update` ← latest `Publishing` *did* include the node in
   * `changedNodes`; the caller's premise was wrong.
   */
  it('did-update: latest Publishing edge included the node', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const why = whyNotUpdated(g, a)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(g.read(why).reason).toBe('did-update')
  })

  /**
   * `no-dep-overlap` ← `Publishing` fired but `changedNodes ∩ deps(node)`
   * was empty; the engine never re-entered `Recomputing` for this node.
   */
  it('no-dep-overlap: Publishing fired but deps disjoint from changedNodes', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const sum = g.derived('sum', (get) => get(a) + 0)
    const why = whyNotUpdated(g, sum)
    g.commit('b→7', (tx) => tx.set(b, 7))
    expect(g.read(why).reason).toBe('no-dep-overlap')
  })

  /**
   * `object-is-deduped` ← `Publishing` fired and dependencies overlapped,
   * so `Recomputing.ComputingDerived` ran, but the engine's `Object.is`
   * short-circuit suppressed the propagation edge.
   */
  it('object-is-deduped: Recomputing ran but Object.is short-circuited propagation', () => {
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    const sum = g.derived('sum', (get) => Math.max(get(a), 0))
    const why = whyNotUpdated(g, sum)
    g.commit('a→-1', (tx) => tx.set(a, -1))
    expect(g.read(why).reason).toBe('object-is-deduped')
  })
})

/**
 * Doc-conformance for the §5.4 closed-set commitment: each literal in the
 * `WhyReason` union must appear in `docs/lifecycle.md` under the §5.4
 * heading. New tag → broken test → must add a row before merge.
 */
describe('lifecycle-§5.4 conformance — WhyReason closed set', () => {
  /**
   * The §5.4 heading must exist; the closed-set commitment lives there.
   */
  it('docs/lifecycle.md contains the §5.4 WhyReason region heading', () => {
    const doc = readLifecycleDoc()
    expect(doc).toMatch(/^### 5\.4 WhyReason region\s*$/m)
  })

  /**
   * Every literal in the union must appear in backticks somewhere under
   * the §5.4 region. The test slices the doc between §5.4 and §6 (the
   * next top-level heading after §5) and asserts each tag is named.
   */
  it.each(WHY_REASONS)('tag %s appears in the §5.4 region', (tag) => {
    const doc = readLifecycleDoc()
    const start = doc.indexOf('### 5.4 WhyReason region')
    expect(start).toBeGreaterThanOrEqual(0)
    // §5.4 ends at the next top-level heading (§6).
    const after = doc.indexOf('\n## ', start)
    const region = after === -1 ? doc.slice(start) : doc.slice(start, after)
    expect(region).toContain('`' + tag + '`')
  })

  /**
   * The §5.4 region must contain a row per tag — count the leading
   * `| \`<tag>\` |` table-row prefix. Six rows today, mechanically gated
   * against §17.7 in the future.
   */
  it('the §5.4 region has one table row per tag', () => {
    const doc = readLifecycleDoc()
    const start = doc.indexOf('### 5.4 WhyReason region')
    const after = doc.indexOf('\n## ', start)
    const region = after === -1 ? doc.slice(start) : doc.slice(start, after)
    for (const tag of WHY_REASONS) {
      // Each tag gets its own row in the reason→edge mapping table.
      const rowPrefix = '| `' + tag + '` |'
      expect(region).toContain(rowPrefix)
    }
  })
})
