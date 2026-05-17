/**
 * @causljs/drift — drift detector. Finds unmigrated patterns and
 * emits a DriftReport JSON for CI / dashboards.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DriftCategory, DriftFinding, DriftReport } from './ir.js'
import { scanFile } from './scan.js'

export type { DriftCategory, DriftFinding, DriftReport } from './ir.js'
export { scanFile } from './scan.js'

export interface ScanOptions {
  /** File extensions to scan; default ts/tsx/js/jsx. */
  readonly extensions?: readonly string[]
  /** Path globs to skip. v0: simple substring matches. */
  readonly skip?: readonly string[]
}

const DEFAULT_EXT = ['.ts', '.tsx', '.js', '.jsx']
const DEFAULT_SKIP = ['node_modules', 'dist', '.git', '.next', 'coverage']

export async function scanDirectory(
  root: string,
  options: ScanOptions = {},
): Promise<DriftReport> {
  const exts = options.extensions ?? DEFAULT_EXT
  const skip = options.skip ?? DEFAULT_SKIP
  const findings: DriftFinding[] = []
  let filesScanned = 0

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (skip.some((s) => entry.name === s || entry.name.includes(s))) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        const source = await fs.readFile(full, 'utf8')
        findings.push(...scanFile(path.relative(root, full), source))
        filesScanned++
      }
    }
  }
  await walk(root)

  const byCategory: Partial<Record<DriftCategory, number>> = {}
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    stats: { filesScanned, findings: findings.length, byCategory },
    findings,
  }
}
