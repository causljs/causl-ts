/**
 * @packageDocumentation
 *
 * EPIC-1 PR-B1 / TASK 1.B1.4 — schema-2 → schema-3 PR-B1 migration codemod.
 *
 * Walks a directory of `.json` IR fixtures (or a single file) and
 * produces schema-3 PR-B1 output. Idempotent on schema-3 input —
 * the codemod adds, it does not edit.
 *
 * Usage:
 *   pnpm exec tsx tools/migrate-ir-2-to-3.ts \
 *     --in <path> [--out <path>] [--in-place] \
 *     [--graphId <name>] [--seed <hex>] [--check]
 *
 * Flags:
 *   --in <path>      input directory (recursive .json walk) or single file
 *   --out <path>     output directory (mirrors input tree)
 *   --in-place       overwrite the input (mutually exclusive with --out)
 *   --graphId <name> explicit graphId; must match `GRAPH_ID_REGEX`
 *   --seed <hex>     deterministic UUID seed; if --graphId is also given,
 *                    the explicit graphId wins
 *   --check          dry-run; exit 1 if any file would change
 *
 * The codemod imports `GRAPH_ID_REGEX` from `@causl/core` so a regex
 * drift between the runtime validator and the migration tool is
 * impossible by construction.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { GRAPH_ID_REGEX } from '../packages/core/src/index.js'

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Loose IR shape — accepts schema-2 (no graphId), schema-3 PR-A
 * (events: []), and schema-3 PR-B1 (events / scopes / bridges all
 * present). The codemod normalizes any of these to PR-B1 shape.
 *
 * Permissive on purpose: the codemod's job is to migrate any
 * schema-2-shaped JSON the wild produces, not to enforce structural
 * validity (that's the linter's job after the migration). Every
 * indexed field is `unknown`-typed so a malformed input doesn't
 * trip the type-checker before reaching the migration core.
 */
export interface LooseIR {
  readonly schema?: number
  readonly time?: number
  readonly nodes?: readonly LooseNode[]
  readonly commits?: readonly LooseCommit[]
  readonly events?: readonly unknown[]
  readonly scopes?: readonly unknown[]
  readonly bridges?: readonly unknown[]
}

export interface LooseNode {
  readonly kind: string
  readonly id: string
  readonly graphId?: string
  readonly [key: string]: unknown
}

export interface LooseCommit {
  readonly time: number
  readonly intent: string
  readonly graphId?: string
  readonly [key: string]: unknown
}

export interface MigrateOptions {
  /** Explicit graphId (must match `GRAPH_ID_REGEX`). */
  readonly graphId?: string
  /** Deterministic UUID seed for fixture migrations. */
  readonly seed?: string
}

// ─── Pure migration core ───────────────────────────────────────────────

/**
 * Mint a deterministic graphId from a seed string. The seed is
 * hashed with FNV-1a and emitted as 32 hex characters; the result
 * is wrapped in `g.fixture-<hash>` to match `GRAPH_ID_REGEX`.
 *
 * @remarks
 * Determinism is the property that lets the codemod produce
 * byte-stable fixture output across CI runs (the §16.2.1.4
 * "running the codemod twice produces byte-identical output"
 * acceptance criterion). FNV-1a is a fast, well-distributed
 * non-cryptographic hash — sufficient for this use because we are
 * not defending against adversaries, only producing a stable id.
 */
function deterministicGraphId(seed: string): string {
  // FNV-1a 32-bit, twice, to fill 16 hex chars total — enough
  // entropy for the fixture-migration ergonomic, not enough to
  // claim cryptographic uniqueness.
  let h1 = 2166136261 >>> 0
  let h2 = 0x9e3779b1 >>> 0
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i)
    h1 = ((h1 ^ c) * 16777619) >>> 0
    h2 = ((h2 ^ c) * 2246822519) >>> 0
  }
  const hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  return `g.fixture-${hex}`
}

/**
 * Resolve the graphId to inject. Explicit `--graphId` wins; absent,
 * the codemod mints a deterministic id from `--seed` (or the
 * default seed `migrate-ir-2-to-3`).
 *
 * @throws if `options.graphId` is supplied but fails `GRAPH_ID_REGEX`.
 */
function resolveGraphId(options: MigrateOptions): string {
  if (options.graphId !== undefined) {
    if (!GRAPH_ID_REGEX.test(options.graphId)) {
      throw new Error(
        `migrate-ir-2-to-3: invalid --graphId ${JSON.stringify(
          options.graphId,
        )}; must match ${GRAPH_ID_REGEX.source}`,
      )
    }
    return options.graphId
  }
  return deterministicGraphId(options.seed ?? 'migrate-ir-2-to-3')
}

/**
 * Migrate a single IR document from schema-2 (or schema-3 PR-A) to
 * schema-3 PR-B1. Pure function — does not mutate the input.
 *
 * @remarks
 * Idempotent on schema-3 PR-B1 input: every additive step
 * (`graphId` injection, `events`/`scopes`/`bridges` array
 * defaulting) is a no-op when the field already carries the
 * target shape.
 */
export function migrateOne(
  input: LooseIR,
  options: MigrateOptions = {},
): {
  readonly schema: 3
  readonly time: number
  readonly nodes: readonly LooseNode[]
  readonly commits: readonly LooseCommit[]
  readonly events: readonly unknown[]
  readonly scopes: readonly unknown[]
  readonly bridges: readonly unknown[]
} {
  const graphIdToInject = resolveGraphId(options)
  // Deep-clone the input so the codemod is non-destructive. The IR
  // is a JSON-only payload, so structuredClone (or JSON.parse +
  // JSON.stringify) is sufficient.
  const cloned = JSON.parse(JSON.stringify(input)) as LooseIR

  const nodes: LooseNode[] = (cloned.nodes ?? []).map((n) => {
    if (n.graphId === undefined) {
      return { ...n, graphId: graphIdToInject }
    }
    return n
  })

  const commits: LooseCommit[] = (cloned.commits ?? []).map((c) => {
    if (c.graphId === undefined) {
      return { ...c, graphId: graphIdToInject }
    }
    return c
  })

  return {
    schema: 3,
    time: cloned.time ?? 0,
    nodes,
    commits,
    events: cloned.events ?? [],
    scopes: cloned.scopes ?? [],
    bridges: cloned.bridges ?? [],
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────

interface CliArgs {
  readonly inPath: string
  readonly outPath?: string
  readonly inPlace: boolean
  readonly graphId?: string
  readonly seed?: string
  readonly check: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  let inPath: string | undefined
  let outPath: string | undefined
  let inPlace = false
  let graphId: string | undefined
  let seed: string | undefined
  let check = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--in':
        inPath = argv[++i]
        break
      case '--out':
        outPath = argv[++i]
        break
      case '--in-place':
        inPlace = true
        break
      case '--graphId':
        graphId = argv[++i]
        break
      case '--seed':
        seed = argv[++i]
        break
      case '--check':
        check = true
        break
      default:
        throw new Error(`migrate-ir-2-to-3: unknown flag ${JSON.stringify(a)}`)
    }
  }
  if (inPath === undefined) {
    throw new Error('migrate-ir-2-to-3: --in is required')
  }
  if (inPlace && outPath !== undefined) {
    throw new Error(
      'migrate-ir-2-to-3: --in-place and --out are mutually exclusive',
    )
  }
  // exactOptionalPropertyTypes: only set the optional fields when
  // the user actually supplied them, so the CliArgs shape doesn't
  // carry explicit-undefined stub values.
  const out: CliArgs = { inPath, inPlace, check }
  if (outPath !== undefined) (out as { outPath?: string }).outPath = outPath
  if (graphId !== undefined) (out as { graphId?: string }).graphId = graphId
  if (seed !== undefined) (out as { seed?: string }).seed = seed
  return out
}

async function processFile(
  inFile: string,
  outFile: string,
  options: MigrateOptions,
  check: boolean,
): Promise<boolean> {
  const raw = await fs.readFile(inFile, 'utf8')
  const parsed = JSON.parse(raw) as LooseIR
  const out = migrateOne(parsed, options)
  // Stable, deterministic JSON formatting: 2-space indent matches
  // the existing fixture style and is what the property test's
  // round-trip diff expects.
  const serialized = `${JSON.stringify(out, null, 2)}\n`
  const existing = inFile === outFile ? raw : await readOrEmpty(outFile)
  const changed = existing !== serialized
  if (check) return changed
  if (changed) {
    await fs.mkdir(path.dirname(outFile), { recursive: true })
    await fs.writeFile(outFile, serialized, 'utf8')
  }
  return changed
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function walk(
  inRoot: string,
  outRoot: string,
  options: MigrateOptions,
  check: boolean,
): Promise<{ scanned: number; changed: number }> {
  let scanned = 0
  let changed = 0
  async function visit(dir: string): Promise<void> {
    const rel = path.relative(inRoot, dir)
    const outDir = path.join(outRoot, rel)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await visit(full)
      } else if (e.isFile() && full.endsWith('.json')) {
        const outFile = path.join(outDir, e.name)
        const didChange = await processFile(full, outFile, options, check)
        scanned++
        if (didChange) changed++
      }
    }
  }
  await visit(inRoot)
  return { scanned, changed }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const options: MigrateOptions = {}
  if (args.graphId !== undefined) (options as { graphId?: string }).graphId = args.graphId
  if (args.seed !== undefined) (options as { seed?: string }).seed = args.seed
  const stat = await fs.stat(args.inPath)
  let summary: { scanned: number; changed: number }
  if (stat.isFile()) {
    const out = args.inPlace
      ? args.inPath
      : args.outPath ?? args.inPath
    const didChange = await processFile(args.inPath, out, options, args.check)
    summary = { scanned: 1, changed: didChange ? 1 : 0 }
  } else if (stat.isDirectory()) {
    const outRoot = args.inPlace
      ? args.inPath
      : args.outPath ?? args.inPath
    summary = await walk(args.inPath, outRoot, options, args.check)
  } else {
    process.stderr.write('migrate-ir-2-to-3: --in is neither a file nor a directory\n')
    return 2
  }
  process.stdout.write(
    `migrate-ir-2-to-3: ${summary.scanned} scanned, ${summary.changed} ${args.check ? 'would change' : 'changed'}\n`,
  )
  if (args.check && summary.changed > 0) return 1
  return 0
}

// `import.meta.url`-driven entrypoint detection: only run main() when
// invoked as the script. Importing the module from a test file does
// not trigger CLI execution.
const isEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], 'file://').href
if (isEntry) {
  // top-level await is supported under Node ≥14.8 ESM
  process.exit(await main(process.argv.slice(2)))
}
