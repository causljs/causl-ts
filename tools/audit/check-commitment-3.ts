#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 3 audit — Glitch-freedom (Theorem 2).
 *
 * Per SPEC §3 Theorem 2: every observable derived value satisfies
 * `D(t) = f(b₁(t), …, bₙ(t))` — the dependency snapshot at the
 * time the derived's value is published is consistent with the
 * derived's compute function. Glitch-freedom is the property that
 * no observer ever sees a derived whose value disagrees with its
 * deps' values at the same GraphTime.
 *
 * Mechanizable as: scan
 * `packages/core/test/properties/recompute-count-fuzz.property.test.ts`
 * for the property witness, assert it exists, has at least one
 * it() block, and sources the 1000-trial floor.
 *
 * Lifts commitment 3 from PROPERTY toward MECHANICAL: same shape
 * as commitment-2; the actual glitch-freedom verdict is the test
 * file itself when invoked under vitest.
 *
 * Exit code:
 *   0 — witness present + 1000-trial floor present.
 *   1 — witness missing or below floor.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const witnessPath = resolve(
  __dirname,
  '../../packages/core/test/properties/recompute-count-fuzz.property.test.ts',
)

if (!existsSync(witnessPath)) {
  process.stderr.write(
    `check-commitment-3: missing witness file ${witnessPath}\n`,
  )
  process.exit(1)
}

const text = readFileSync(witnessPath, 'utf8')

if (!/(propertyTrials|propertyOptions)/.test(text)) {
  process.stderr.write(
    `check-commitment-3: ${witnessPath} does not invoke propertyTrials() or propertyOptions()\n`,
  )
  process.exit(1)
}

const itCount = (text.match(/\bit\(/g) ?? []).length
if (itCount < 1) {
  process.stderr.write(
    `check-commitment-3: ${witnessPath} has no it() blocks\n`,
  )
  process.exit(1)
}

// Glitch-freedom-specific: the file should reference the
// "recompute-count" or "glitch" terminology so a refactor that
// repurposes the file silently for a different property trips
// the audit.
if (!/(recompute|glitch)/i.test(text)) {
  process.stderr.write(
    `check-commitment-3: ${witnessPath} doesn't mention 'recompute' or ` +
      `'glitch' — file may have been repurposed away from glitch-freedom\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-3: PASS — glitch-freedom witness present (${itCount} it block(s))\n`,
)
process.exit(0)
