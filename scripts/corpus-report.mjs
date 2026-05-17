#!/usr/bin/env node
/**
 * CI dashboard aggregator for the `failing_against_stub` corpus.
 *
 * Per `docs/epic-1133/PLAN.md` §6: the test runner at
 * `packages/core/test/properties/failing-against-stub.property.test.ts`
 * emits one JSON object per category on stderr:
 *
 *     {"corpus":"failing-against-stub","category":"<id>","backend":"<b>","engineModeled":<bool>}
 *
 * The vitest pass/fail outcome for the corresponding test names the
 * `<id>` in the test title (`[backend] <id> — ...`). This script
 * reads piped-in stdin OR a vitest JSON report and aggregates a
 * one-line summary:
 *
 *     <sha> <backend> X/20 passing  (categories: id1=pass, id2=fail, ...)
 *
 * Designed to be tiny — no fancy UI. The single concrete consumer is
 * a future CI gate that asserts:
 *   - `BACKEND=stub`  → X == 0 (all 20 must fail today)
 *   - `BACKEND=ts`    → X == 20 (oracle is the TS engine)
 *   - `BACKEND=rust`  → X is the progress meter; a regression
 *     (decrease) blocks merge.
 *
 * Usage:
 *
 *     CAUSL_BACKEND=stub pnpm --filter @causljs/core exec vitest run \
 *       --reporter=json \
 *       test/properties/failing-against-stub.property.test.ts \
 *       2>/dev/null | node scripts/corpus-report.mjs
 *
 * Or pipe the human reporter output:
 *
 *     CAUSL_BACKEND=ts pnpm --filter @causljs/core exec vitest run \
 *       test/properties/failing-against-stub.property.test.ts 2>&1 \
 *       | node scripts/corpus-report.mjs
 *
 * The script accepts either format — it greps for the JSON-line
 * marker and the vitest `✓`/`×`/`FAIL` markers in tandem.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** @returns {string} short git SHA of dev HEAD, or `unknown` if not in a repo. */
function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Read all of stdin and return as a string. Synchronous via the
 * file-descriptor 0 read because the pipeline is short and the
 * aggregator is a one-shot.
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const raw = readStdin()
if (raw.length === 0) {
  console.error('corpus-report: no input on stdin')
  process.exit(2)
}

// Try JSON-reporter shape first. Vitest --reporter=json emits a single
// JSON document at the end of stdout. pnpm's workspace command-runner
// can prepend `WARN ...` lines on stdout (including stray `{}`
// fragments inside warning text), so anchor on the vitest report
// envelope key `"numTotalTestSuites"`. pnpm can ALSO append a
// non-JSON `ELIFECYCLE` line after the document on failing runs, so
// walk the brace count forward and slice at the matching `}`.
let categories = []
try {
  const anchor = raw.indexOf('{"numTotalTestSuites"')
  let jsonSlice = anchor >= 0 ? raw.slice(anchor) : raw
  if (anchor >= 0) {
    let depth = 0
    let end = -1
    let inString = false
    let escape = false
    for (let i = 0; i < jsonSlice.length; i++) {
      const c = jsonSlice[i]
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\' && inString) {
        escape = true
        continue
      }
      if (c === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end > 0) jsonSlice = jsonSlice.slice(0, end)
  }
  const doc = JSON.parse(jsonSlice)
  if (Array.isArray(doc.testResults)) {
    for (const file of doc.testResults) {
      for (const t of file.assertionResults ?? []) {
        // The test name is shaped `[<backend>] <id> — <description>`.
        const m = /\[(stub|ts|rust)\]\s+([A-Za-z0-9-]+)\s+—/.exec(t.title ?? t.fullName ?? '')
        if (m === null) continue
        categories.push({
          backend: m[1],
          id: m[2],
          status: t.status === 'passed' ? 'pass' : 'fail',
        })
      }
    }
  }
} catch {
  // Fall back to human-reporter parsing — look for `✓`/`×`/`FAIL`
  // lines that name a `[backend] <id> — ...` test.
  const re = /\[(stub|ts|rust)\]\s+([A-Za-z0-9-]+)\s+—/
  for (const line of raw.split('\n')) {
    const m = re.exec(line)
    if (m === null) continue
    const status = line.includes('FAIL') || line.includes(' ×') ? 'fail' : 'pass'
    categories.push({ backend: m[1], id: m[2], status })
  }
  // Dedupe (vitest emits both the `>` outline line and the FAIL header
  // for failed tests).
  const seen = new Map()
  for (const c of categories) {
    const key = `${c.backend}:${c.id}`
    // FAIL wins over pass — if any line for the same id says FAIL,
    // record it as fail.
    const prev = seen.get(key)
    if (prev === undefined || c.status === 'fail') seen.set(key, c)
  }
  categories = [...seen.values()]
}

if (categories.length === 0) {
  console.error('corpus-report: no failing-against-stub test results found in input')
  process.exit(2)
}

const backend = categories[0].backend
const passing = categories.filter((c) => c.status === 'pass').length
const total = categories.length

const sha = gitSha()
const summary = `${sha} ${backend} ${passing}/${total} passing`

// One-line summary on stdout — easy to grep in CI logs.
console.log(summary)

// Per-category breakdown on stderr — for human inspection without
// polluting the grep-friendly stdout line.
const breakdown = categories
  .map((c) => `${c.id}=${c.status}`)
  .sort()
  .join(', ')
console.error(`corpus-report: ${breakdown}`)

// Exit code: 0 if the count matches the backend's contract; non-zero
// to surface drift in CI.
//   - stub: passing MUST be 0 (PLAN.md §6 acceptance: "all categories
//     must FAIL" — was 20 in Phase 0; extended to 22 by A.1 / issue
//     #1338 with the two precondition-guard categories).
//   - ts:   passing MUST equal total.
//   - rust: any count is reportable; non-zero exit only on regression
//     (the regression check is a future CI gate, not this script).
if (backend === 'stub' && passing !== 0) {
  console.error(`corpus-report: STUB CONTRACT VIOLATED — expected 0/${total} passing, got ${passing}`)
  process.exit(3)
}
if (backend === 'ts' && passing !== total) {
  console.error(`corpus-report: TS CONTRACT VIOLATED — expected ${total}/${total} passing, got ${passing}`)
  process.exit(4)
}
process.exit(0)
