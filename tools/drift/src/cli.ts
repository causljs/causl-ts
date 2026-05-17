#!/usr/bin/env node
/**
 * causl-drift CLI — `npx @causljs/drift [path]`
 *
 * Exits 0 on clean. Exits 1 with the report on stdout if findings exist.
 */

import process from 'node:process'
import { scanDirectory } from './index.js'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const target = args[0] ?? process.cwd()
  const report = await scanDirectory(target)
  process.stdout.write(JSON.stringify(report, null, 2))
  process.stdout.write('\n')
  return report.findings.length > 0 ? 1 : 0
}

main().then(
  (code) => {
    process.exit(code)
  },
  (err) => {
    process.stderr.write(`causl-drift: ${err}\n`)
    process.exit(2)
  },
)
