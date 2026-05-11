#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 7 audit — Forbidden transitions throw
 * structured errors.
 *
 * Per SPEC §17 commitment 7: enum tags whose transitions are not
 * specified by the §6 chart MUST throw at runtime rather than ship
 * silently. The two named errors:
 *
 *   - ForbiddenResourceTransitionError (sync resource adapter)
 *   - ForbiddenConflictTransitionError (sync conflict adapter)
 *
 * Mechanizable as: scan packages/sync/src/{resource,conflict}.ts
 * for both error classes' definitions, asserting they exist and
 * are exported.
 *
 * Exit code:
 *   0 — both error classes defined and exported.
 *   1 — at least one missing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

interface ErrorCheck {
  className: string
  sourcePath: string
}

const checks: ErrorCheck[] = [
  {
    className: 'ForbiddenResourceTransitionError',
    sourcePath: resolve(root, 'packages/sync/src/resource.ts'),
  },
  {
    className: 'ForbiddenConflictTransitionError',
    sourcePath: resolve(root, 'packages/sync/src/conflict.ts'),
  },
]

let allOk = true
for (const c of checks) {
  const text = readFileSync(c.sourcePath, 'utf8')
  // Must be exported (export class ForbiddenXTransitionError extends Error)
  const declRe = new RegExp(`export\\s+class\\s+${c.className}\\b`)
  if (!declRe.test(text)) {
    process.stderr.write(
      `check-commitment-7: ${c.sourcePath} does not declare 'export class ${c.className}' — ` +
        `forbidden transitions must throw a structured typed error per SPEC §17 commitment 7\n`,
    )
    allOk = false
  }
}

// The barrel must re-export both classes so adopters can
// instanceof-check. Inspect packages/sync/src/index.ts.
const barrelPath = resolve(root, 'packages/sync/src/index.ts')
const barrelText = readFileSync(barrelPath, 'utf8')
for (const c of checks) {
  if (!barrelText.includes(c.className)) {
    process.stderr.write(
      `check-commitment-7: ${barrelPath} does not re-export ${c.className}; ` +
        `adopters cannot instanceof-check the structured error\n`,
    )
    allOk = false
  }
}

if (allOk) {
  process.stdout.write(
    `check-commitment-7: PASS — both forbidden-transition errors declared and re-exported (${checks
      .map((c) => c.className)
      .join(', ')})\n`,
  )
  process.exit(0)
} else {
  process.exit(1)
}
