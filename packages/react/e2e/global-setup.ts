/**
 * @packageDocumentation
 *
 * Playwright globalSetup for the `@causljs/react` dropped-frames gate.
 *
 * Bundles `e2e/fixtures/viewport-1000.tsx` into
 * `e2e/fixtures/viewport-1000.js` (a single browser ESM module that
 * bakes in React, react-dom/client, `@causljs/core`, and `@causljs/react`)
 * before the spec runs. We do this in globalSetup rather than as a
 * `package.json` `pretest` so the playwright test is hermetic — `pnpm
 * test:e2e` produces a runnable artifact tree without a separate build
 * step the developer might forget. The bundle is deterministic, so
 * one build per test invocation is enough.
 *
 * Why `tsup` rather than calling `esbuild` directly: `tsup` is already
 * a `devDependency` of `@causljs/react` (it builds `dist/`), and the
 * monorepo doesn't ship a free-standing esbuild dep at the workspace
 * root. Reusing the same toolchain that builds `dist/` keeps the
 * fixture bundle's TypeScript / JSX transform pipeline aligned with
 * the dist build — no risk of the fixture compiling under a different
 * tsconfig than the package itself.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default async function globalSetup(): Promise<void> {
  // Use the locally-installed tsup binary with the e2e tsup config.
  // The config flips `noExternal` for `@causljs/*` and `react*` so the
  // fixture bundle is self-contained — see `e2e/tsup.config.ts` for
  // the rationale. We resolve the binary via the package root so this
  // works on a fresh clone where tsup is hoisted into
  // `packages/react/node_modules/.bin`.
  const tsupBin = resolve(here, '../node_modules/.bin/tsup')
  const config = resolve(here, 'tsup.config.ts')
  const result = spawnSync(tsupBin, ['--config', config], {
    stdio: 'inherit',
    // Workspace-dep resolution (`@causljs/core`, `@causljs/react`) needs
    // the package root as cwd — that is where the dependency closure
    // is hoisted from.
    cwd: resolve(here, '..'),
  })
  if (result.status !== 0) {
    throw new Error(
      `viewport-1000 fixture bundle failed (tsup exit ${result.status})`,
    )
  }
}
