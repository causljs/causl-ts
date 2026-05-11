/**
 * Engine-status deopt audit invariants (#917).
 *
 * Pins the negative-finding decisions documented in
 * `packages/bench/report/engine-status-deopts/SUMMARY.md` as
 * source-state assertions, so a future PR that re-introduces a
 * per-commit code shape one of those findings ruled out trips here
 * before the catalogue regresses.
 *
 * Three findings on `causl x scrolling-viewport x 10000` were
 * investigated and documented as non-actionable:
 *
 *   1. `wrong map` on `<JSFunction next>` -- V8 builtin Map.prototype
 *      iterator, not user code. The only user-code `.next()` call site
 *      in `packages/core/src/` is `disposed.keys().next().value` at the
 *      FIFO disposal-tombstone-eviction loop, which the
 *      `scrolling-viewport` cell never enters (the harness holds every
 *      subscriber until tear-down).
 *   2. `Insufficient type feedback for call` on `lineLengths` -- not
 *      in the Causl codebase; lives in `node:internal/source_map`.
 *   3. `dependent allocation site tenuring changed` on `makeInputNode`
 *      -- V8 allocation-site retune during graph construction; not on
 *      the steady-state per-commit critical path.
 *
 * The test reads `packages/core/src/graph.ts` directly and asserts:
 *
 *   - Exactly one user-code `.next()` call shape exists, at the
 *     disposal-tombstone-eviction site.
 *   - Both audited source-line annotations (#917 audit comments at
 *     `makeInputNode` and at the disposal eviction loop) are present.
 *
 * Adding a Map / Set / generator iteration in the per-commit hot path
 * via `.next()` would need to either (a) deliberately re-run the
 * engine-status audit and update SUMMARY.md, or (b) document the new
 * site in this test's allowlist.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const GRAPH_TS_PATH = resolve(__dirname, '..', 'src', 'graph.ts')
const SUMMARY_MD_PATH = resolve(
  __dirname,
  '..',
  '..',
  'bench',
  'report',
  'engine-status-deopts',
  'SUMMARY.md',
)

describe('#917 engine-status deopt audit invariants', () => {
  it('the only user-code `.next()` call in graph.ts is the disposal-tombstone eviction', () => {
    const src = readFileSync(GRAPH_TS_PATH, 'utf8')
    // Strip line-comments and block-comments so doc-comment occurrences
    // do not count as call sites. We do not need a full AST parse; the
    // surface is small and the comment-stripping pass is a structural
    // approximation that's correct for this file's discipline (no
    // string literals contain `.next(`).
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
    // Match `.next(` allowing arbitrary whitespace before the `(`.
    const calls = Array.from(stripped.matchAll(/\.next\s*\(/g))
    expect(calls.length).toBe(1)
    // Locate the surviving `.next(` and assert its line context names
    // the disposal tombstone eviction (the only audited call site).
    const idx = stripped.search(/\.next\s*\(/)
    const start = stripped.lastIndexOf('\n', Math.max(0, idx - 200))
    const end = stripped.indexOf('\n', idx + 50)
    const window = stripped.slice(
      start === -1 ? 0 : start,
      end === -1 ? stripped.length : end,
    )
    expect(window).toContain('disposed.keys().next().value')
  })

  it('the makeInputNode #917 audit annotation is present', () => {
    const src = readFileSync(GRAPH_TS_PATH, 'utf8')
    expect(src).toMatch(/#917 audit:[\s\S]{0,800}makeInputNode/)
  })

  it('the #1014 / #1123 pretenure helper covers BOTH makeInputNode and the per-instance input() callsite', () => {
    // #1014 (PR #1036) extracted the InputEntry literal into
    // module-level `makeInputEntry` and added a warmup loop driving
    // `makeInputNode` + `makeInputEntry` past the young→old tenuring
    // transition. #1123 extended the same helper to also drive the
    // per-instance `input()` SFI (the closure inside `createCausl`)
    // because the post-#1036 engine-status audit surfaced a residual
    // `dependent allocation site tenuring changed` deopt pair on
    // `input` itself.
    //
    // Pin both pieces in source so a future PR that drops the
    // extension trips here BEFORE the bench-side integration test
    // (which is slower to fire) catches the deopt count regression.
    const src = readFileSync(GRAPH_TS_PATH, 'utf8')
    // Helper exists.
    expect(src).toMatch(/function pretenureInputAllocationSites\s*\(/)
    // Latch exists.
    expect(src).toMatch(/let pretenureLatchTripped\s*=\s*false/)
    // Helper warmup body drives `makeInputNode` (#1014 / #1036).
    expect(src).toMatch(/makeInputNode<unknown>/)
    // Helper warmup body drives `makeInputEntry` (#1014 / #1036).
    expect(src).toMatch(/makeInputEntry<number>/)
    // Helper warmup body drives per-instance `input()` via the
    // throwaway-graph reentry the #1123 extension introduced.
    expect(src).toContain('__causl_pretenure_input__')
    expect(src).toMatch(/warmupGraph\.input\s*\(/)
    // `createCausl()` invokes the helper exactly once per process.
    expect(src).toMatch(/pretenureInputAllocationSites\s*\(\s*\)/)
  })

  it('the disposal-tombstone-eviction #917 audit annotation is present', () => {
    const src = readFileSync(GRAPH_TS_PATH, 'utf8')
    // The annotation lives in the comment block before the `while` loop
    // that calls `disposed.keys().next().value`.
    expect(src).toMatch(/#917 audit:[\s\S]{0,1500}disposed\.keys\(\)\.next\(\)/)
  })

  it('the engine-status-deopts SUMMARY.md exists and names all three findings', () => {
    const md = readFileSync(SUMMARY_MD_PATH, 'utf8')
    expect(md).toContain('# Engine-status deopt audit (#917)')
    // Each per-finding section is named explicitly.
    expect(md).toMatch(/wrong map.*on.*next/)
    expect(md).toMatch(/Insufficient type feedback for call.*lineLengths/)
    expect(md).toMatch(/tenuring changed.*makeInputNode/)
    // The decision header is present.
    expect(md).toContain('## Decision')
    expect(md).toContain('Closes #917')
  })
})
