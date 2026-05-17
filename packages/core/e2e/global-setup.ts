/**
 * @packageDocumentation
 *
 * Playwright globalSetup for the `@causljs/core` boundary-rewrite e2e
 * suite (epic #1558 sub-issue #1565).
 *
 * The core-package e2e harness pages import `@causljs/core` from the
 * built `dist/index.js`. On a fresh checkout `dist/` may not have
 * been produced yet, so this setup defensively runs the core
 * package's `build` script before any spec navigates. The build is
 * fast (`tsup` against a small entry surface) and cached on
 * subsequent runs, so a re-invocation from the same shell is cheap.
 *
 * Why a `pnpm --filter` call rather than invoking `tsup` directly
 * (the React-package pattern): the core package's `tsup.config.ts`
 * builds multiple entries (main, internal, testing, wasm) and the
 * `build` script in `package.json` is the canonical invocation
 * shape. Reusing that script keeps the e2e build aligned with the
 * dist build the rest of the workspace produces.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default async function globalSetup(): Promise<void> {
  const corePackageRoot = resolve(here, '..')
  const distEntry = resolve(corePackageRoot, 'dist/index.js')

  // Fast-path: if `dist/index.js` already exists, trust it. The
  // dist build is deterministic and the e2e specs do not require
  // a freshly-rebuilt artifact — they only require that the
  // fixture's import resolves. A developer iterating on engine
  // changes will have re-run `pnpm --filter @causljs/core build`
  // through the normal dev loop; this guard exists to keep a
  // clean-checkout `pnpm --filter @causljs/core test:e2e` from
  // surprise-failing on a missing import.
  if (existsSync(distEntry)) {
    return
  }

  const result = spawnSync('pnpm', ['--filter', '@causljs/core', 'build'], {
    stdio: 'inherit',
    cwd: corePackageRoot,
  })
  if (result.status !== 0) {
    throw new Error(
      `@causljs/core dist build (e2e bootstrap) failed (pnpm exit ${result.status})`,
    )
  }
}
