#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 16 audit — §9.1 race-class
 * catalogue currency for adapter rows.
 *
 * Per SPEC.async §17 commitment 5: docs/race-class-audit.md
 * stays current as the adapter grows. The audit doc must enumerate
 * every adapter S-row (S-1, S-2, S-3) AND surface the SPEC.async
 * §9.1.1 row-identity divergence (per #566).
 *
 * Mechanizable as: scan docs/race-class-audit.md for the three
 * S-row identifiers AND the divergence callout naming
 * 'Abandon-then-resume' (the SPEC.async-canonical S-1 name)
 * plus 'Open-set drift' or 'Dispatch-shape leak'.
 *
 * Exit code:
 *   0 — three S-rows present + divergence callout intact.
 *   1 — at least one S-row missing or divergence callout absent.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const auditPath = resolve(__dirname, '../../docs/race-class-audit.md')

if (!existsSync(auditPath)) {
  process.stderr.write(`check-commitment-16: missing ${auditPath}\n`)
  process.exit(1)
}

const text = readFileSync(auditPath, 'utf8')

// Three S-row sections (### S-1, ### S-2, ### S-3).
for (const row of ['S-1', 'S-2', 'S-3']) {
  if (!new RegExp(`### ${row}\\b`).test(text)) {
    process.stderr.write(
      `check-commitment-16: ${auditPath} missing ### ${row} section\n`,
    )
    process.exit(1)
  }
}

// SPEC.async §9.1.1 divergence callout (per #566).
if (!text.includes('Abandon-then-resume')) {
  process.stderr.write(
    `check-commitment-16: ${auditPath} missing the 'Abandon-then-resume' divergence ` +
      `callout — the SPEC.async §9.1.1 row-identity gap (per #566) is no longer surfaced\n`,
  )
  process.exit(1)
}

if (!/Open-set drift|Dispatch-shape leak/.test(text)) {
  process.stderr.write(
    `check-commitment-16: ${auditPath} missing 'Open-set drift' or 'Dispatch-shape leak' ` +
      `from the SPEC.async §9.1.1 divergence callout\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-16: PASS — 3 S-rows present + SPEC.async §9.1.1 divergence callout intact\n`,
)
process.exit(0)
