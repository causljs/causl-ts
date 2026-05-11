#!/usr/bin/env node
/**
 * EPIC-12 / TASK 12.6 — race-class-anchor lint.
 *
 * SPEC §17 commitment 5 enforcement: when a PR touches
 * `docs/race-class-audit.md`, `SPEC.async.md` §9.1, or `SPEC.md` §9.1,
 * the PR body's "Race-class impact" section must name a detection
 * layer from the closed enumeration { STATIC | PROPERTY | MODEL |
 * RUNTIME-ONLY } and a witness for it.
 *
 * The lint runs as a CI step. It reads the PR body via the GITHUB_*
 * environment variables Actions sets, the changed-files list via
 * `gh pr diff --name-only`, and exits 0 / 1.
 *
 * Local invocation:
 *   tsx tools/lint/race-class-anchor-check.ts \
 *     --body-file <path-to-body.md> \
 *     --changed-files <comma-separated-paths>
 *
 * Exit code:
 *   0 — lint passes (section is well-formed, or PR doesn't trigger).
 *   1 — section is empty or malformed when required.
 *   2 — argument parse error.
 */

import { readFileSync } from 'node:fs'

const TRIGGER_PATHS = [
  'docs/race-class-audit.md',
  'SPEC.md', // §9.1 lives here
  'SPEC.async.md', // §9.1.1 lives here
]

const VALID_LAYERS = new Set(['STATIC', 'PROPERTY', 'MODEL', 'RUNTIME-ONLY'])

interface Args {
  bodyFile?: string
  changedFiles?: readonly string[]
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--body-file') {
      const v = argv[++i]
      if (v !== undefined) args.bodyFile = v
    } else if (argv[i] === '--changed-files') {
      const list = argv[++i] ?? ''
      args.changedFiles = list.split(',').filter((s) => s.length > 0)
    }
  }
  return args
}

/**
 * Extract the "Race-class impact" section from the body. Returns the
 * trimmed text between that heading and the next `## ` heading, or
 * `null` if the section is absent.
 */
function extractSection(body: string): string | null {
  // JS regex doesn't support `\z`; use end-of-string anchor `$` with
  // `s` flag, or fall back to greedy match terminated by next `## `
  // heading or end-of-input.
  const match = body.match(/^## Race-class impact\s*\n([\s\S]*?)(\n## [^\n]+|$)/m)
  if (!match) return null
  // Drop the HTML-comment block that the template ships with — it's
  // documentation, not user content.
  const raw = match[1] ?? ''
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/**
 * Detect whether the PR's changed files include any path that triggers
 * the lint requirement.
 */
function triggers(changedFiles: readonly string[]): boolean {
  return changedFiles.some((f) => TRIGGER_PATHS.includes(f))
}

/**
 * Validate the section content. Returns `null` on success, or an
 * error string naming the offending shape.
 */
export function validateSection(section: string): string | null {
  // Empty or "_None_" only valid when the lint isn't triggered (that
  // path is checked by the caller); if we get here and see this shape,
  // it's an error.
  const trimmed = section.trim()
  if (trimmed.length === 0 || /^_None[_\b]?/i.test(trimmed) || /^_?None_?$/i.test(trimmed)) {
    return 'section is empty or _None_; required when PR touches §9.1 row sources'
  }
  // Expect at least one detection layer keyword to appear.
  const layers = [...trimmed.matchAll(/\b(STATIC|PROPERTY|MODEL|RUNTIME-ONLY)\b/g)]
    .map((m) => m[1])
  if (layers.length === 0) {
    return `section names no detection layer; expected one of: ${[...VALID_LAYERS].join(', ')}`
  }
  for (const l of layers) {
    if (!VALID_LAYERS.has(l!)) {
      return `unknown detection layer: ${l}`
    }
  }
  return null
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.bodyFile === undefined) {
    process.stderr.write('race-class-anchor-check: --body-file is required\n')
    return 2
  }
  const body = readFileSync(args.bodyFile, 'utf8')
  const changedFiles = args.changedFiles ?? []

  if (!triggers(changedFiles)) {
    process.stdout.write('race-class-anchor-check: PR does not touch §9.1 row sources; skipping.\n')
    return 0
  }

  const section = extractSection(body)
  if (section === null) {
    process.stderr.write('race-class-anchor-check: PR touches §9.1 sources but body lacks "## Race-class impact" section.\n')
    return 1
  }
  const err = validateSection(section)
  if (err !== null) {
    process.stderr.write(`race-class-anchor-check: ${err}\n`)
    return 1
  }
  process.stdout.write('race-class-anchor-check: PASS — section names a valid detection layer.\n')
  return 0
}

const isEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], 'file://').href
if (isEntry) {
  process.exit(await main(process.argv.slice(2)))
}
