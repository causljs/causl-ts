#!/usr/bin/env node
/**
 * EPIC-13 / Adapter Commitment 13 audit — Two-primitive surface
 * stays at two (Resource + Conflict).
 *
 * Per SPEC.async §17 commitment 2: @causljs/sync exports exactly
 * two primitives — `resource` (the Resource factory) and
 * `createConflictRegistry` (the ConflictRegistry factory). A
 * third primitive without a §12.1 audit is a §17.2 violation.
 *
 * Mechanizable as: scan packages/sync/src/index.ts exports for
 * the two primitive factories. Adding a third top-level factory
 * trips this gate (other helpers like singleConflictWhen are
 * compositional helpers, not new primitives — they're
 * whitelisted).
 *
 * Exit code:
 *   0 — exactly resource + createConflictRegistry primitives.
 *   1 — primitive surface widened beyond two.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexPath = resolve(__dirname, '../../packages/sync/src/index.ts')

const text = readFileSync(indexPath, 'utf8')

// The two primitive factories per SPEC.async §17 commitment 2.
const requiredPrimitives = ['resource', 'createConflictRegistry']

for (const p of requiredPrimitives) {
  // Match an `export { ..., name, ... }` or `export { name }` line.
  const re = new RegExp(`export\\s*\\{[^}]*\\b${p}\\b[^}]*\\}`)
  if (!re.test(text)) {
    process.stderr.write(
      `check-commitment-13: primitive '${p}' missing from packages/sync/src/index.ts exports\n`,
    )
    process.exit(1)
  }
}

// Whitelisted compositional helpers — these are NOT primitives,
// they compose over the two primitives.
const whitelistedHelpers = new Set([
  'singleConflictWhen',
  'ForbiddenResourceTransitionError',
  'ForbiddenConflictTransitionError',
  'whyUpdated',
  'whyNotUpdated',
  'RESOURCE_UPDATE_REASONS',
])

// Find every value-export (not type-export). A future PR that
// adds a third top-level factory shows up as a new export name
// not in {primitives, whitelistedHelpers}.
const exportLines = text.match(/export\s*\{[^}]*\}/g) ?? []
const allExportedNames = new Set<string>()
for (const line of exportLines) {
  // Skip `export type` blocks — those are type re-exports, not
  // primitive factories.
  if (line.startsWith('export type')) continue
  const inner = line.replace(/export\s*\{|\}/g, '')
  for (const tok of inner.split(',')) {
    const name = tok.trim().split(/\s+as\s+/)[0]?.trim()
    if (name && name.length > 0) allExportedNames.add(name)
  }
}

const unknownExports = [...allExportedNames].filter(
  (n) => !requiredPrimitives.includes(n) && !whitelistedHelpers.has(n),
)
if (unknownExports.length > 0) {
  process.stderr.write(
    `check-commitment-13: unexpected non-whitelisted value exports: ${unknownExports.join(', ')}. ` +
      `Adding a new primitive requires a §12.1 audit per SPEC.async §17 commitment 2; ` +
      `if these are compositional helpers, add them to the whitelistedHelpers set in this script.\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `check-commitment-13: PASS — exactly 2 primitives (${requiredPrimitives.join(', ')}) plus ${whitelistedHelpers.size} whitelisted helpers\n`,
)
process.exit(0)
