#!/usr/bin/env node
/**
 * Run every `check-commitment-*.ts` audit script in this directory
 * and report a per-script PASS/FAIL summary. Used by:
 *
 *   - The `pnpm audit:commitments` workspace script (PR-level gate).
 *   - The quarterly cron in `.github/workflows/quarterly-audit.yml`.
 *
 * Replaces the v1 quarterly-audit invocation that ran each script
 * via `pnpm --filter @causljs/core exec tsx`, which silently reset cwd
 * to `packages/core/` and broke every script's relative-path
 * resolution. See #565 for the full incident.
 *
 * Exit code: 0 if every script passed; 1 if any failed.
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const commitmentScripts = readdirSync(__dirname)
  .filter((f) => /^check-commitment-\d+\.ts$/.test(f))
  .sort()

if (commitmentScripts.length === 0) {
  process.stderr.write('run-all: no check-commitment-*.ts scripts found\n')
  process.exit(1)
}

// Predicate-style audits that are not numbered commitments but
// belong in the same PR-level gate. Append explicitly — the auto-
// glob above is intentionally narrow so an accidentally-renamed
// commitment script can't sneak in. When adding a new entry here,
// also add a row to docs/commitment-audit.md (or the equivalent)
// so the ledger and the orchestrator stay in sync.
const extraScripts = ['check-apalache-mapping.ts', 'check-exemptions.ts']

const scripts = [...commitmentScripts, ...extraScripts]

let anyFailed = false

for (const name of scripts) {
  const scriptPath = resolve(__dirname, name)
  process.stdout.write(`\n=== ${name} ===\n`)
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', scriptPath],
    { stdio: 'inherit', encoding: 'utf8' },
  )
  if (result.status !== 0) {
    anyFailed = true
    process.stderr.write(`run-all: ${name} FAILED (exit ${result.status})\n`)
  }
}

if (anyFailed) {
  process.stderr.write('\nrun-all: one or more audits failed\n')
  process.exit(1)
}
process.stdout.write('\nrun-all: ALL AUDITS PASSED\n')
