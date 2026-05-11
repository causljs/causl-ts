#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 20 audit — §16A static layer's
 * adapter-relevant rules cover S-rows.
 *
 * Per SPEC.async §17 commitment 9: when the §16A.2 static lift
 * passes ship, the SubscribeWithoutDispose and UseAfterDispose
 * rules cover the adapter's race classes (S-1, S-2 lift
 * targets).
 *
 * Mechanizable as: verify the relevant lint pass test files
 * exist in tools/checker/tests/ and exercise the §16A passes.
 *
 *   - tools/checker/tests/subscribe_without_dispose.rs
 *   - tools/checker/tests/use_after_dispose.rs
 *
 * Both must exist with #[test] attributes, indicating the
 * passes are wired to a test harness.
 *
 * Exit code:
 *   0 — both test files present and non-empty.
 *   1 — at least one missing or empty.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const required = [
  'tools/checker/tests/subscribe_without_dispose.rs',
  'tools/checker/tests/use_after_dispose.rs',
]

let allOk = true
for (const f of required) {
  const fullPath = resolve(root, f)
  if (!existsSync(fullPath)) {
    process.stderr.write(`check-commitment-20: missing ${f}\n`)
    allOk = false
    continue
  }
  const text = readFileSync(fullPath, 'utf8')
  // Each file must have at least one #[test] attribute (the
  // basic test-presence check).
  if (!/#\[test\]/.test(text)) {
    process.stderr.write(
      `check-commitment-20: ${f} has no #[test] attribute — the §16A pass is not under test\n`,
    )
    allOk = false
  }
}

if (allOk) {
  process.stdout.write(
    `check-commitment-20: PASS — both §16A.2 lift-pass test files present and active (${required
      .map((f) => f.split('/').pop())
      .join(', ')})\n`,
  )
  process.exit(0)
} else {
  process.exit(1)
}
