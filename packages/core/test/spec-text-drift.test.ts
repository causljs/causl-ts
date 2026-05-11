/**
 * SPEC.md §4 / §5 / §5.4 ↔ implementation parity (#567).
 *
 * Three concrete drift instances the audit identified:
 *
 *   1. SPEC §4 narrative claims `schema: 2` and four top-level
 *      fields. The shipped IR is `CAUSL_MODEL_SCHEMA = 3` with
 *      seven top-level fields (see #569 for the §16.2.1 type-spec
 *      side; this test pins the narrative side).
 *
 *   2. SPEC §5 prelude documents `graph.commit(intent, run): void`.
 *      The shipped signature returns `Commit` — adopters reading
 *      §5 to learn the API would not see the lookahead behavior
 *      that downstream callers (devtools, async-pump, sync's
 *      ConflictRegistry) depend on.
 *
 *   3. SPEC §5.4 documents `SimulateResult` as
 *      `{ ok: true, ... } | { ok: false, ... }`. The shipped type
 *      uses `{ status: 'clean', ... } | { status: 'failed', ... }`
 *      with `stagedDiff` / `derivedDiff` field names — neither
 *      `ok` nor `diff` is in the shipped surface.
 *
 * These tests are structural-mention checks (not byte-for-byte
 * code-block comparisons) — a SPEC editor doing prose cleanup
 * shouldn't have to reproduce the typescript verbatim, but the
 * key API tokens (`Commit`, `'clean'`, `'failed'`, `stagedDiff`,
 * `derivedDiff`, schema `3`) must remain present so an adopter
 * searching SPEC for the API gets the impl-accurate answer.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CAUSL_MODEL_SCHEMA } from '../src/ir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const specPath = resolve(__dirname, '../../../SPEC.md')
const specText = readFileSync(specPath, 'utf8')

function extractSection(headingPattern: RegExp, nextHeadingPattern: RegExp): string {
  const m = specText.match(headingPattern)
  if (!m || m.index === undefined) {
    throw new Error(`spec-text-drift: could not locate heading ${headingPattern}`)
  }
  const after = specText.slice(m.index)
  const nextM = after.slice(m[0].length).match(nextHeadingPattern)
  if (!nextM || nextM.index === undefined) {
    throw new Error(`spec-text-drift: could not locate next heading after ${headingPattern}`)
  }
  return after.slice(0, m[0].length + nextM.index)
}

describe('SPEC §4 narrative ↔ shipped schema (#567)', () => {
  const section = extractSection(
    /^## 4\. Two primitives.*$/m,
    /^## 5\. Commit boundary/m,
  )

  test('mentions the current schema version (no `schema: 2` drift)', () => {
    // SPEC §4's wire-boundary paragraph names the schema version.
    // After EPIC-1 PR-A bumped to schema 3, the narrative needs to
    // either match (schema: 3) or stop pinning a number; #567 chose
    // the former. The shipped value is the source of truth.
    expect(
      section,
      `SPEC §4 must reflect the shipped CAUSL_MODEL_SCHEMA = ${CAUSL_MODEL_SCHEMA}; ` +
        `the previous draft pinned 'schema: 2' and silently lied to adopters reading §4 first.`,
    ).toMatch(new RegExp(`schema:\\s*${CAUSL_MODEL_SCHEMA}\\b`))
    // Negative: no stale `schema: 2` reference in §4.
    expect(
      section,
      `SPEC §4 must not still reference 'schema: 2' after the bump; that's the audit drift #567 caught`,
    ).not.toMatch(/schema:\s*2\b/)
  })
})

describe('SPEC §5 prelude ↔ commit signature (#567)', () => {
  const section = extractSection(
    /^## 5\. Commit boundary/m,
    /^## 6\. Composite statechart/m,
  )

  test('documents commit return type as Commit (not void)', () => {
    // The shipped signature is `commit(intent, run): Commit`. The
    // §5 prelude before #567 used `: void`, which mis-led adopters
    // into thinking the commit record was inaccessible synchronously
    // (it isn't — it's the return value).
    //
    // Regex uses `[\s\S]` (rather than `[^)]`) because the run
    // parameter type contains nested parens — `run: (tx: Tx) => void`.
    // The non-greedy quantifier stops at the first `): Commit` it
    // finds, which is the outer return-type position.
    expect(
      section,
      'SPEC §5 must document `commit(...): Commit` (not `: void`); ' +
        'the impl returns the frozen Commit record synchronously',
    ).toMatch(/graph\.commit\([\s\S]*?\):\s*Commit\b/)
  })
})

describe('SPEC §5.4 ↔ SimulateResult discriminator (#567)', () => {
  const section = extractSection(
    /^### 5\.4 `simulate`/m,
    /^### 5\.5/m,
  )

  test('documents the status discriminator (clean | failed), not the prior {ok} shape', () => {
    // The shipped discriminator is `status: 'clean' | 'failed'`;
    // SPEC §5.4 in the previous draft used `{ ok: true | false }`
    // — those are different on the wire and via narrowing.
    expect(
      section,
      "SPEC §5.4 must document the 'clean' arm of SimulateResult",
    ).toMatch(/'clean'|"clean"/)
    expect(
      section,
      "SPEC §5.4 must document the 'failed' arm of SimulateResult",
    ).toMatch(/'failed'|"failed"/)
    // Negative: the prior `{ ok: true, ... }` discriminator must
    // not still appear as the documented shape.
    expect(
      section,
      'SPEC §5.4 must not document SimulateResult with `ok: true` discriminator (#567)',
    ).not.toMatch(/SimulateResult\s*=\s*\{\s*ok:\s*true/)
  })

  test('documents stagedDiff and derivedDiff field names', () => {
    // Adopters reading §5.4 to learn what fields the success arm
    // carries need to find the impl-accurate names so their code
    // compiles. The previous draft used `diff: SimulateDiff`.
    for (const field of ['stagedDiff', 'derivedDiff']) {
      expect(
        section,
        `SPEC §5.4 must document SimulateResult field ${field} (impl ships these names)`,
      ).toContain(field)
    }
  })
})
