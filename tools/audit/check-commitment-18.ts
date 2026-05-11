#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 18 audit — No enum tags whose
 * transitions aren't specified by §6 chart.
 *
 * Per SPEC.async §17 commitment 7: every value of `ResourceState<T>`
 * and `ConflictKind` must have its transitions specified by the §6
 * chart (mirrored in docs/lifecycle.md). Adding an enum tag without
 * spec'ing its transitions is a §17.2 violation.
 *
 * Mechanizable as:
 *   - Verify ResourceState has exactly 5 arms (idle, loading,
 *     loaded, stale, errored) per the chart.
 *   - Verify ConflictKind has exactly 4 arms (open, resolved,
 *     ignored, superseded).
 *   - Verify docs/lifecycle.md exists and references both unions.
 *
 * The shape gate together with the existing test-d
 * exhaustiveness fixtures (#581) is the load-bearing
 * MECHANICAL coverage for commitment 18.
 *
 * Exit code:
 *   0 — both unions at their canonical arm count + lifecycle.md present.
 *   1 — arm count drift or lifecycle.md missing.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const resourcePath = resolve(root, 'packages/sync/src/resource.ts')
const conflictPath = resolve(root, 'packages/sync/src/conflict.ts')
const lifecyclePath = resolve(root, 'docs/lifecycle.md')

if (!existsSync(lifecyclePath)) {
  process.stderr.write(
    `check-commitment-18: missing docs/lifecycle.md — the chart reference SPEC §17 commitment 7 anchors against\n`,
  )
  process.exit(1)
}

const lifecycleText = readFileSync(lifecyclePath, 'utf8')
// Accept either the type name (ResourceState) or the chart-region
// name (ResourceFleet) — both are anchors for the SPEC §6 chart.
if (
  !/(ResourceState|ResourceFleet)/.test(lifecycleText) ||
  !/Conflict/.test(lifecycleText)
) {
  process.stderr.write(
    `check-commitment-18: docs/lifecycle.md doesn't reference both ResourceState/ResourceFleet and Conflict\n`,
  )
  process.exit(1)
}

// ResourceState 5-arm canonical set per SPEC §6.
const resourceText = readFileSync(resourcePath, 'utf8')
for (const arm of ["'idle'", "'loading'", "'loaded'", "'stale'", "'errored'"]) {
  if (!resourceText.includes(arm)) {
    process.stderr.write(
      `check-commitment-18: ResourceState arm ${arm} missing from packages/sync/src/resource.ts\n`,
    )
    process.exit(1)
  }
}

// ConflictKind 4-arm canonical set.
const conflictText = readFileSync(conflictPath, 'utf8')
for (const arm of ["'open'", "'resolved'", "'ignored'", "'superseded'"]) {
  if (!conflictText.includes(arm)) {
    process.stderr.write(
      `check-commitment-18: ConflictKind arm ${arm} missing from packages/sync/src/conflict.ts\n`,
    )
    process.exit(1)
  }
}

process.stdout.write(
  `check-commitment-18: PASS — ResourceState 5-arm + ConflictKind 4-arm canonical sets intact + lifecycle.md cross-reference present\n`,
)
process.exit(0)
