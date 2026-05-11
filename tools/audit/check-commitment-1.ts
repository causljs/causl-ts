#!/usr/bin/env node
/**
 * EPIC-13 / Commitment 1 audit — two-primitive runtime universe.
 *
 * Mechanizable as: scan `tools/checker/src/ir.rs` for the `IrNode`
 * enum and assert its variant set is exactly { Input, Derived }.
 * A future PR that adds a third variant fails this script.
 *
 * Exit code:
 *   0 — commitment holds.
 *   1 — commitment violated; diagnostic on stderr.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const irPath = resolve(__dirname, '../../tools/checker/src/ir.rs')
const ir = readFileSync(irPath, 'utf8')

// Find the IrNode enum block.
const m = ir.match(/pub enum IrNode \{([^}]+)\}/s)
if (!m) {
  process.stderr.write('check-commitment-1: could not find IrNode enum\n')
  process.exit(1)
}
const block = m[1]!
const variants = (block.match(/^\s*(Input|Derived|\w+)\(/gm) ?? []).map((s) =>
  s.trim().replace(/\($/, ''),
)
const expected = ['Input', 'Derived'].sort()
const actual = variants.sort()
if (
  actual.length !== expected.length ||
  !actual.every((v, i) => v === expected[i])
) {
  process.stderr.write(
    `check-commitment-1: IrNode variants are [${actual.join(', ')}]; ` +
      `expected [${expected.join(', ')}]\n`,
  )
  process.exit(1)
}
process.stdout.write('check-commitment-1: PASS — IrNode is exactly { Input, Derived }\n')
process.exit(0)
