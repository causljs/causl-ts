// Unit cover for the bundle-budget reporter.
//
// The half worth pinning is the refusal. The workflow this feeds spent four
// months red, and the way a size gate goes quietly wrong is by reporting green
// off a measurement that never happened, so an empty or unparseable size-limit
// payload must throw rather than render an empty table.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseResults, renderComment } from '../report.mjs'

const cell = (name, size, sizeLimit, passed = true) => ({ name, size, sizeLimit, passed })

test('parseResults refuses an empty reading', () => {
  assert.throws(() => parseResults('', 'head'), /not JSON/)
  assert.throws(() => parseResults('[]', 'head'), /no cells/)
  assert.throws(() => parseResults('[{"name":"a"}]', 'head'), /missing name or size/)
})

test('parseResults accepts a real size-limit payload', () => {
  const parsed = parseResults(JSON.stringify([cell('@causlts/core', 17063, 20000)]), 'head')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].size, 17063)
})

test('renderComment diffs head against base and signs the change', () => {
  const body = renderComment(
    [cell('@causlts/core', 17063, 20000), cell('@causlts/react', 1853, 8000)],
    [cell('@causlts/core', 16000, 20000), cell('@causlts/react', 2000, 8000)],
  )
  assert.match(body, /\| cell \| base \| head \| change \| limit \| status \|/)
  assert.match(body, /@causlts\/core \| 16\.00 kB \| 17\.06 kB \| \+1\.06 kB \| 20\.00 kB \| ok/)
  assert.match(body, /@causlts\/react \| 2\.00 kB \| 1\.85 kB \| -0\.15 kB \| 8\.00 kB \| ok/)
  assert.match(body, /Every cell is inside its ceiling/)
})

test('renderComment names the cell that went over', () => {
  const body = renderComment([cell('@causlts/core', 21000, 20000, false)], null)
  assert.match(body, /1 cell\(s\) over budget: @causlts\/core\./)
  assert.match(body, /OVER/)
  assert.match(body, /head-only reading/)
})

test('renderComment marks a cell the base did not have', () => {
  const body = renderComment([cell('brand new', 100, 8000)], [cell('@causlts/core', 16000, 20000)])
  assert.match(body, /brand new \| n\/a \| 0\.10 kB \| new \|/)
})

test('renderComment carries the update marker so one PR keeps one comment', () => {
  const body = renderComment([cell('@causlts/core', 17063, 20000)], null)
  assert.match(body, /^<!-- bundle-budget-report -->/)
})

test('renderComment points at the file that actually holds the ceilings', () => {
  // The cells live under `size-limit` in the root package.json here, not in a
  // standalone `.size-limit.cjs`. A note that names the wrong file sends the
  // one reader who cares to the wrong place.
  const body = renderComment([cell('@causlts/core', 17063, 20000)], null)
  assert.match(body, /root `package\.json`/)
  assert.doesNotMatch(body, /\.size-limit\.cjs/)
})
