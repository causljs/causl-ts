#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 6 audit — §10 worked example as acceptance
 * gate.
 *
 * Per SPEC §17 commitment 6: until the §10 worked example works,
 * no other phase begins. The §10 fixtures are the load-bearing
 * acceptance gate that pins engine semantics against the smallest
 * runnable proof.
 *
 * Mechanizable as: scan packages/sync/test/spec-async-10-{1,2,3,4}-*.test.ts
 * AND packages/core/test/spec-10-worked-example.test.ts for
 * presence + non-empty bodies. (The check-commitment-17 script
 * is the SPEC.async §10 cousin; this one is the engine-side gate
 * for the original SPEC §10.)
 *
 * Exit code:
 *   0 — engine §10 fixture present and non-empty.
 *   1 — fixture missing or empty.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const fixturePath = resolve(
  root,
  'packages/core/test/spec-10-worked-example.test.ts',
)

if (!existsSync(fixturePath)) {
  process.stderr.write(
    `check-commitment-6: missing engine §10 fixture ${fixturePath}\n`,
  )
  process.exit(1)
}

const text = readFileSync(fixturePath, 'utf8')
const itCount = (text.match(/\bit\(/g) ?? []).length
if (itCount < 1) {
  process.stderr.write(
    `check-commitment-6: ${fixturePath} has no it() blocks — empty test file\n`,
  )
  process.exit(1)
}

// SPEC §10 specifies four invariants per the worked example.
// The fixture must reference at least three of: input, derived,
// commit, subscribe. A fixture missing all four is suspicious.
const tokens = ['input', 'derived', 'commit', 'subscribe']
const present = tokens.filter((t) => text.includes(t))
if (present.length < 3) {
  process.stderr.write(
    `check-commitment-6: ${fixturePath} mentions only ${present.length}/${tokens.length} ` +
      `core API tokens (${present.join(', ')}); the §10 worked example must exercise the full primitive surface\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-6: PASS — §10 worked example fixture present (${itCount} it block(s), ${present.length}/${tokens.length} primitive surface coverage)\n`,
)
process.exit(0)
