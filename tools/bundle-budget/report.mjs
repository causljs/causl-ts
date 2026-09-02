#!/usr/bin/env node
// bundle-budget reporting, written against the GitHub API this repo runs on.
//
// Why this file exists at all: the workflow used to hand the whole job to
// `andresz1/size-limit-action@v1`, and that action cannot do the job we need.
// Its `src/main.ts` opens with
// `if (!pr) throw new Error("No PR found. Only pull_request workflows are
// supported.")`, so every `push:` and `workflow_dispatch` run failed by
// construction, before a single byte got measured. Run 26002600496 (push to
// `main`, 2026-05-17) and run 33647348710 (dispatch on `main`, 2026-09-02) are
// both that one line and nothing else.
//
// That mattered more than a red badge. `size-limit` is the only place the JS
// bundle ceilings are enforced: `wasm.yml`'s size step sat behind a guard that
// is always false in this repo, and `main-fast.yml` says in its own header that
// size-limit is release-side. So while this lane was dead the 11 cells declared
// under `size-limit` in the root `package.json` were gated by nothing.
//
// So I do the two halves myself, and I keep them apart on purpose. `gate` is
// the blocking half and reads the `passed` flag size-limit already computes per
// cell, so it works on any event. `render` builds the delta table and `post`
// puts it on the pull request, which is the half that genuinely needs a PR, and
// now it is the only half that needs one.
//
// Every subcommand refuses loudly on an unreadable input. An empty or
// unparseable size-limit payload is exactly what a crashed measurement looks
// like, and reporting green off one of those is the failure mode this workflow
// spent four months in.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { realpath } from 'node:fs/promises'

// The comment is updated in place rather than appended to, so a PR that gets
// twelve pushes carries one table and not twelve. This marker is how I find the
// previous one.
const MARKER = '<!-- bundle-budget-report -->'
const HEADING = '## bundle-budget report'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

/**
 * One size-limit payload, validated.
 *
 * size-limit prints its array on stdout and exits non-zero when a cell is over,
 * so the file is written either way. What it does NOT write on a crash is valid
 * JSON, and that is the case worth naming: a truncated or empty file means the
 * measurement never happened, and the only honest answer is a refusal.
 */
export function parseResults(text, label) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${label}: size-limit output is not JSON, so nothing was measured (${error.message})`,
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${label}: size-limit reported no cells, so nothing was measured`)
  }
  for (const cell of parsed) {
    if (typeof cell?.name !== 'string' || typeof cell?.size !== 'number') {
      throw new Error(`${label}: a size-limit cell is missing name or size`)
    }
  }
  return parsed
}

const kB = (bytes) => `${(bytes / 1000).toFixed(2)} kB`

function delta(before, after) {
  if (before === undefined) return 'new'
  const diff = after - before
  if (diff === 0) return '0'
  const sign = diff > 0 ? '+' : '-'
  return `${sign}${(Math.abs(diff) / 1000).toFixed(2)} kB`
}

/**
 * The table a reviewer reads instead of scrolling the log.
 *
 * `base` is optional on purpose. A push has no pull request to diff against,
 * and a base build that fails is a fact about the base rather than about this
 * PR, so both cases degrade to a head-only table rather than to no table.
 */
export function renderComment(head, base, meta = {}) {
  const baseByName = new Map((base ?? []).map((cell) => [cell.name, cell]))
  const withBase = base !== undefined && base !== null

  const rows = head.map((cell) => {
    const before = baseByName.get(cell.name)?.size
    const status = cell.passed === false ? 'OVER' : 'ok'
    const limit = typeof cell.sizeLimit === 'number' ? kB(cell.sizeLimit) : 'none'
    return [
      cell.name,
      withBase ? (before === undefined ? 'n/a' : kB(before)) : null,
      kB(cell.size),
      withBase ? delta(before, cell.size) : null,
      limit,
      status,
    ].filter((column) => column !== null)
  })

  const header = withBase
    ? ['cell', 'base', 'head', 'change', 'limit', 'status']
    : ['cell', 'size', 'limit', 'status']
  const divider = header.map(() => '---')
  const lines = [header, divider, ...rows].map((row) => `| ${row.join(' | ')} |`)

  const over = head.filter((cell) => cell.passed === false)
  const verdict =
    over.length === 0
      ? 'Every cell is inside its ceiling.'
      : `${over.length} cell(s) over budget: ${over.map((cell) => cell.name).join(', ')}.`

  const notes = []
  if (!withBase) {
    notes.push(
      meta.baseNote ??
        'No base measurement, so this is a head-only reading rather than a delta.',
    )
  }
  notes.push(
    'The ceilings live under `size-limit` in the root `package.json` and the reasoning behind each one is in `docs/bundle-budget.md`.',
  )

  return [
    MARKER,
    HEADING,
    '',
    verdict,
    '',
    ...lines,
    '',
    ...notes.map((note) => `> ${note}`),
    '',
  ].join('\n')
}

async function api(base, token, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...(init ?? {}),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const method = init?.method ?? 'GET'
    const body = await res.text().catch(() => '')
    throw new Error(`${method} ${path} answered ${res.status} ${body.slice(0, 200)}`)
  }
  return res.status === 204 ? null : res.json()
}

/**
 * Put the table on the pull request, replacing my own previous one.
 *
 * I read the thread first and match on the marker, which keeps one comment per
 * PR. A repeat push therefore edits rather than appends.
 */
async function post({ apiBase, token, repo, pr, body }) {
  const existing = await api(apiBase, token, `/repos/${repo}/issues/${pr}/comments?per_page=100`)
  const mine = Array.isArray(existing)
    ? existing.find((comment) => String(comment.body ?? '').includes(MARKER))
    : undefined

  if (mine) {
    await api(apiBase, token, `/repos/${repo}/issues/comments/${mine.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
    return `updated comment ${mine.id}`
  }

  const created = await api(apiBase, token, `/repos/${repo}/issues/${pr}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  return `created comment ${created.id}`
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (command === 'render') {
    const head = parseResults(await readFile(args.head, 'utf8'), 'head')
    let base = null
    let baseNote
    if (args.base) {
      try {
        base = parseResults(await readFile(args.base, 'utf8'), 'base')
      } catch (error) {
        base = null
        baseNote = `I could not measure the base branch, so this is a head-only reading: ${error.message}`
      }
    }
    const body = renderComment(head, base, { baseNote })
    await writeFile(args.out, body, 'utf8')
    process.stdout.write(body)
    return
  }

  if (command === 'gate') {
    const head = parseResults(await readFile(args.head, 'utf8'), 'head')
    const over = head.filter((cell) => cell.passed === false)
    if (over.length > 0) {
      for (const cell of over) {
        process.stdout.write(
          `::error::${cell.name} is ${kB(cell.size)} against a ceiling of ${kB(cell.sizeLimit)}\n`,
        )
      }
      process.exitCode = 1
      return
    }
    process.stdout.write(`bundle-budget: ${head.length} cells, all inside their ceilings\n`)
    return
  }

  if (command === 'post') {
    const apiBase = process.env.BUDGET_API_BASE
    const token = process.env.BUDGET_TOKEN
    const repo = process.env.BUDGET_REPO
    const pr = process.env.BUDGET_PR
    for (const [name, value] of Object.entries({
      BUDGET_API_BASE: apiBase,
      BUDGET_TOKEN: token,
      BUDGET_REPO: repo,
      BUDGET_PR: pr,
    })) {
      if (!value) throw new Error(`post needs ${name} and it is empty`)
    }
    const body = await readFile(args.body, 'utf8')
    process.stdout.write(`${await post({ apiBase, token, repo, pr, body })}\n`)
    return
  }

  throw new Error(`unknown command '${command ?? ''}', expected render | gate | post`)
}

// The tests import this file rather than run it, so the guard keeps a unit test
// from firing the CLI. I compare resolved real paths because the workflow
// invokes the script through a path that may differ from `import.meta.url` by a
// symlink.
const invokedDirectly = await (async () => {
  if (!process.argv[1]) return false
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((error) => {
    process.stdout.write(`::error::${error.message}\n`)
    process.exitCode = 1
  })
}
