#!/usr/bin/env node
/**
 * Adapter Commitment 14 audit — Capability narrowing on
 * ConflictRegistry per SPEC §7 / §12.3.
 *
 * The conflict registry's read and write halves must hand callers
 * only the engine authority each method actually exercises. The
 * narrowing is type-level: instance-method parameters are `Pick`
 * subsets of `Graph`, and a fixture pins the forbidden methods out
 * of reach via `// @ts-expect-error` directives — the same lock
 * pattern #257 introduced for `persistedInput`, `useCauslFamily`,
 * and the inspector seam.
 *
 * Mechanizable as: scan the fixture file
 *
 *   packages/sync/test/conflictRegistry.narrowCapability.test.ts
 *
 * and assert
 *   1. it exists,
 *   2. it carries at least 12 `// @ts-expect-error` directives
 *      (6 forbidden methods × 2 slices is the structural floor),
 *   3. it references both `ConflictRegistryReadGraph` and
 *      `ConflictRegistryWriteGraph` — the two narrowed slice types
 *      that this commitment is about.
 *
 * If a future change broadens any slice, the directives stop being
 * errors and the fixture stops type-checking; this script is the
 * cheap structural pre-flight that catches the fixture going
 * missing or being gutted before the type-check ever runs.
 *
 * Exit code:
 *   0 — fixture present, directive count meets the floor, both
 *       narrowed slice types referenced.
 *   1 — any of the above checks fail.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const fixturePath = resolve(
  root,
  'packages/sync/test/conflictRegistry.narrowCapability.test.ts',
)

// 6 forbidden methods × 2 slices is the structural floor that
// "capability narrowing" entails. The fixture today carries
// substantially more directives (it locks ~12 methods per slice
// plus the four cross-slice strictness checks); the floor is the
// minimum below which the commitment can no longer be considered
// held.
const MIN_TS_EXPECT_ERROR_DIRECTIVES = 12

const REQUIRED_TYPE_REFERENCES = [
  'ConflictRegistryReadGraph',
  'ConflictRegistryWriteGraph',
] as const

let allOk = true

if (!existsSync(fixturePath)) {
  process.stderr.write(
    `check-commitment-14: missing fixture ${fixturePath} — ` +
      `ConflictRegistry capability narrowing has no compile-time witness\n`,
  )
  process.exit(1)
}

const text = readFileSync(fixturePath, 'utf8')

const directiveCount = (text.match(/@ts-expect-error/g) ?? []).length
if (directiveCount < MIN_TS_EXPECT_ERROR_DIRECTIVES) {
  process.stderr.write(
    `check-commitment-14: ${fixturePath} has ${directiveCount} ` +
      `'@ts-expect-error' directives; expected at least ` +
      `${MIN_TS_EXPECT_ERROR_DIRECTIVES} (6 forbidden methods × 2 slices). ` +
      `Capability narrowing on ConflictRegistry is no longer locked at ` +
      `the structural floor SPEC §17 commitment 14 requires\n`,
  )
  allOk = false
}

for (const typeName of REQUIRED_TYPE_REFERENCES) {
  if (!text.includes(typeName)) {
    process.stderr.write(
      `check-commitment-14: ${fixturePath} does not reference ` +
        `'${typeName}' — the narrowed slice type is the surface this ` +
        `commitment locks; if it isn't in the fixture, the fixture isn't ` +
        `auditing the commitment\n`,
    )
    allOk = false
  }
}

if (allOk) {
  process.stdout.write(
    `check-commitment-14: PASS — capability-narrowing fixture present ` +
      `with ${directiveCount} '@ts-expect-error' directives ` +
      `(floor ${MIN_TS_EXPECT_ERROR_DIRECTIVES}); both ` +
      `${REQUIRED_TYPE_REFERENCES.join(' and ')} referenced\n`,
  )
  process.exit(0)
} else {
  process.exit(1)
}
