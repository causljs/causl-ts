#!/usr/bin/env node
/**
 * SARIF 2.1.0 schema-shape audit for `causl-check`.
 *
 * Per #584 A17-12 (EPIC-1 brutal-critical review recommendation #12):
 * the audit identified that `tools/audit/check-sarif-schema.ts` was
 * referenced by SPEC text but never existed. This script closes that
 * gap with a structural-validation approach: it invokes the release
 * binary against a known-violation fixture, captures the SARIF JSON,
 * and asserts the required SARIF 2.1.0 top-level shape.
 *
 * Approach: structural validation (Approach A). We deliberately avoid
 * pulling in `ajv` plus a vendored copy of the SARIF schema — the
 * required-fields shape we care about for CI gating is tiny and the
 * dependency surface would be disproportionate. If a downstream
 * consumer later needs strict validation against the canonical
 * schemastore.org SARIF 2.1.0 schema, that should be a separate
 * predicate that runs only on the publish-time release artifact.
 *
 * Mechanizable shape contract (must hold for every emitted SARIF run):
 *
 *   - `$schema`                          string
 *   - `version`                          === "2.1.0"
 *   - `runs`                             non-empty array
 *   - `runs[0].tool.driver.name`         string
 *   - `runs[0].tool.driver.rules`        array
 *   - `runs[0].results`                  array (may be empty)
 *   - for each result:
 *       - `ruleId`                       string
 *       - `level`                        string
 *       - `message.text`                 string
 *
 * The fixture `tools/checker/tests/fixtures/cycle.json` is chosen
 * because it deterministically produces at least one result entry, so
 * the per-result assertions actually exercise something. A clean
 * fixture would still validate the top-level shape but would skip the
 * result-shape check — defeating part of the audit.
 *
 * Binary discovery: we look for `tools/checker/target/release/causl-check`
 * relative to the repo root. If it is absent, the script exits with a
 * SKIP message and exit code 0 — this is intentional. CI builds the
 * binary in a separate job and audit gating that requires `cargo
 * build --release` to run inside the audit step would be far too
 * heavy. The `pnpm audit:test` cohort and the `audit:commitments`
 * runner both treat exit-0-with-SKIP as "audit not applicable in this
 * environment", which matches how the rest of the suite handles
 * binary-dependent predicates.
 *
 * Exit code:
 *   0 — SARIF shape is valid, OR binary not built (SKIP).
 *   1 — SARIF output is missing or has the wrong shape.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const binPath = resolve(
  repoRoot,
  'tools/checker/target/release/causl-check',
)
const fixturePath = resolve(
  repoRoot,
  'tools/checker/tests/fixtures/cycle.json',
)

type ShapeError = { path: string; reason: string }

/**
 * Validate the structural shape of a parsed SARIF 2.1.0 log.
 *
 * Exported so the optional unit test can exercise this in isolation
 * without spawning the binary. Returns an array of structured errors
 * (empty array means valid). Using a return-array rather than
 * throw-on-first-error is deliberate — surfacing every shape problem
 * at once is more useful for diagnosing a regression than stopping
 * at the first one.
 */
export function validateSarif(doc: unknown): ShapeError[] {
  const errors: ShapeError[] = []

  if (typeof doc !== 'object' || doc === null) {
    return [{ path: '$', reason: 'root must be a JSON object' }]
  }
  const root = doc as Record<string, unknown>

  if (typeof root.$schema !== 'string') {
    errors.push({ path: '$.$schema', reason: 'must be a string' })
  }
  if (root.version !== '2.1.0') {
    errors.push({
      path: '$.version',
      reason: `must be "2.1.0"; got ${JSON.stringify(root.version)}`,
    })
  }
  if (!Array.isArray(root.runs) || root.runs.length === 0) {
    errors.push({ path: '$.runs', reason: 'must be a non-empty array' })
    // Without runs we cannot check the per-run shape; bail.
    return errors
  }

  const run0 = root.runs[0]
  if (typeof run0 !== 'object' || run0 === null) {
    errors.push({ path: '$.runs[0]', reason: 'must be an object' })
    return errors
  }
  const r0 = run0 as Record<string, unknown>

  const tool = r0.tool as Record<string, unknown> | undefined
  const driver = tool?.driver as Record<string, unknown> | undefined
  if (!driver) {
    errors.push({
      path: '$.runs[0].tool.driver',
      reason: 'must be an object',
    })
  } else {
    if (typeof driver.name !== 'string') {
      errors.push({
        path: '$.runs[0].tool.driver.name',
        reason: 'must be a string',
      })
    }
    if (!Array.isArray(driver.rules)) {
      errors.push({
        path: '$.runs[0].tool.driver.rules',
        reason: 'must be an array',
      })
    }
  }

  if (!Array.isArray(r0.results)) {
    errors.push({ path: '$.runs[0].results', reason: 'must be an array' })
    return errors
  }

  for (let i = 0; i < r0.results.length; i++) {
    const result = r0.results[i]
    const base = `$.runs[0].results[${i}]`
    if (typeof result !== 'object' || result === null) {
      errors.push({ path: base, reason: 'must be an object' })
      continue
    }
    const res = result as Record<string, unknown>
    if (typeof res.ruleId !== 'string') {
      errors.push({ path: `${base}.ruleId`, reason: 'must be a string' })
    }
    if (typeof res.level !== 'string') {
      errors.push({ path: `${base}.level`, reason: 'must be a string' })
    }
    const message = res.message as Record<string, unknown> | undefined
    if (!message || typeof message.text !== 'string') {
      errors.push({
        path: `${base}.message.text`,
        reason: 'must be a string',
      })
    }
  }

  return errors
}

function main(): void {
  if (!existsSync(binPath)) {
    process.stdout.write(
      `check-sarif-schema: SKIP — ${binPath} not built ` +
        `(run \`cargo build --release\` in tools/checker first)\n`,
    )
    process.exit(0)
  }
  if (!existsSync(fixturePath)) {
    process.stderr.write(
      `check-sarif-schema: missing fixture ${fixturePath}\n`,
    )
    process.exit(1)
  }

  const proc = spawnSync(
    binPath,
    ['--input', fixturePath, '--format', 'sarif'],
    { encoding: 'utf8' },
  )

  // The checker exits non-zero when it finds violations — that is the
  // expected case for the cycle fixture. We only treat truly broken
  // outcomes (signal kills, binary missing) as audit failures.
  if (proc.error) {
    process.stderr.write(
      `check-sarif-schema: failed to spawn ${binPath}: ${proc.error.message}\n`,
    )
    process.exit(1)
  }
  if (proc.signal) {
    process.stderr.write(
      `check-sarif-schema: ${binPath} killed by signal ${proc.signal}\n`,
    )
    process.exit(1)
  }
  if (!proc.stdout || proc.stdout.trim().length === 0) {
    process.stderr.write(
      `check-sarif-schema: ${binPath} produced no stdout ` +
        `(stderr: ${proc.stderr})\n`,
    )
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(proc.stdout)
  } catch (e) {
    process.stderr.write(
      `check-sarif-schema: stdout is not valid JSON: ${(e as Error).message}\n`,
    )
    process.exit(1)
  }

  const errors = validateSarif(parsed)
  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(`check-sarif-schema: ${err.path} ${err.reason}\n`)
    }
    process.exit(1)
  }

  const root = parsed as Record<string, unknown>
  const run0 = (root.runs as unknown[])[0] as Record<string, unknown>
  const results = run0.results as unknown[]
  process.stdout.write(
    `check-sarif-schema: PASS — SARIF 2.1.0 shape valid ` +
      `(${results.length} result(s) on cycle.json fixture)\n`,
  )
  process.exit(0)
}

// Run only when invoked as a CLI; remain importable from tests.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main()
}
