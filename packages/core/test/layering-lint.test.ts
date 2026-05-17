/**
 * @packageDocumentation
 *
 * SPEC §17 commitment 3 / issue #393 — package-boundary layering
 * gate.
 *
 * §17.3 says the §7 layering (information model / editor-controller
 * state / engine substrate) is enforced at the package boundary:
 * `@causl/core` is the engine substrate and must not export
 * controller types. The mechanical enforcement is an ESLint
 * `no-restricted-imports` rule scoped to `packages/core/src/**` (and
 * `packages/core/test/**`) that bans imports of every sibling adapter
 * package — see the root `eslint.config.js`.
 *
 * This test is the negative fixture for that rule. It runs ESLint
 * programmatically against a synthetic file path inside
 * `packages/core/src/` whose content imports `@causl/react`, and
 * asserts the diagnostic fires with the §17.3 message. A green
 * production lint run plus a red diagnostic on the fixture together
 * pin the contract.
 *
 * The fixture content lives at
 * `tools/lint-fixtures/core-illegal-import.fixture.ts`; the
 * `.fixture.ts` suffix and the location outside `packages/*` keep it
 * out of every production lint glob.
 */

import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Repo root, computed from this test file's location. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** Path to the fixture content on disk (read-only). */
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  'tools/lint-fixtures/core-illegal-import.fixture.ts'
)

/**
 * Synthetic file path used when feeding the fixture content to
 * ESLint. The path matches the rule's `files` glob
 * (`packages/core/**`); the file does not need to exist on disk
 * because we pass the source as a string via `lintText`. The path
 * deliberately sits OUTSIDE `packages/core/src/**` so the type-aware
 * `switch-exhaustiveness-check` block (which requires the file to be
 * in the tsconfig project service) does not refuse to parse it.
 */
const SYNTHETIC_CORE_PATH = resolve(
  REPO_ROOT,
  'packages/core/__layering-fixture__.ts'
)

describe('SPEC §17.3 — package-boundary layering enforcement', () => {
  it('flags `@causl/react` imports from inside `@causl/core`', async () => {
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      // Use the repo's flat config; no overrides — this is exactly
      // what `pnpm lint` runs.
      overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.js'),
    })

    const source = readFileSync(FIXTURE_PATH, 'utf8')
    const results = await eslint.lintText(source, {
      filePath: SYNTHETIC_CORE_PATH,
    })
    const result = results[0]
    expect(result).toBeDefined()

    const restrictedImports = result!.messages.filter(
      (m) => m.ruleId === 'no-restricted-imports'
    )

    expect(restrictedImports.length).toBeGreaterThan(0)
    const first = restrictedImports[0]!
    // The diagnostic message is part of the contract — it tells
    // future contributors which SPEC clause the gate enforces. If the
    // wording in the root config drifts, this assertion catches it.
    expect(first.message).toMatch(/SPEC §17\.3/)
    expect(first.message).toMatch(/@causl\/core/)
  })

  it('does not flag `@causl/core/internal` from inside an adapter', async () => {
    // §12.3 seam — adapter packages may reach engine internals only
    // through `@causl/core/internal`. Pin the positive case so a
    // future overzealous addition to the restricted patterns cannot
    // silently break the seam.
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.js'),
    })

    const reactPath = resolve(
      REPO_ROOT,
      'packages/react/__layering-positive__.ts'
    )
    const source = `import { assertNever } from '@causl/core/internal'\nexport const _ = assertNever\n`

    const results = await eslint.lintText(source, { filePath: reactPath })
    const result = results[0]
    expect(result).toBeDefined()

    const restrictedImports = result!.messages.filter(
      (m) => m.ruleId === 'no-restricted-imports'
    )
    expect(restrictedImports).toEqual([])
  })

  it('flags `@causl/core/dist/...` deep imports from an adapter', async () => {
    // §12.3 seam — deep paths into core's dist/ or src/ bypass the
    // package's `exports` map and break the SemVer guarantee. The
    // adapter-scoped rule block in the root config refuses them.
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.js'),
    })

    const reactPath = resolve(
      REPO_ROOT,
      'packages/react/__layering-deep-path__.ts'
    )
    const source = `import { x } from '@causl/core/dist/graph.js'\nexport const _ = x\n`

    const results = await eslint.lintText(source, { filePath: reactPath })
    const result = results[0]
    expect(result).toBeDefined()

    const restrictedImports = result!.messages.filter(
      (m) => m.ruleId === 'no-restricted-imports'
    )
    expect(restrictedImports.length).toBeGreaterThan(0)
    expect(restrictedImports[0]!.message).toMatch(/SPEC §12\.3/)
  })
})
