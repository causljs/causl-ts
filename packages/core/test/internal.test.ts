/**
 * @packageDocumentation
 *
 * Wiring tests for the `@causl/core/internal` entrypoint. The
 * internal entrypoint is the home of surfaces that exist on the
 * engine for adapter use but are deliberately NOT part of the
 * seven-method public commitment, NOT documented in the public
 * README, and NOT covered by SemVer guarantees on the
 * `@causl/core` public exports — `_dispose` is the canonical
 * resident, and any future internal primitive joins it here until
 * it earns promotion to the second-tier extensions.
 *
 * These tests pin both the source-side surface (module resolves,
 * marker is exported) and the package-level contract
 * (`exports['./internal']` is declared with matching `types` and
 * `import` paths). Regressions on either side silently break
 * adapter packages whose only contract with the engine runs through
 * this entrypoint, so a fast wiring test pays for itself.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INTERNAL_ENTRYPOINT } from '../src/internal.js'

/**
 * Wiring contract for the internal escape hatch — both the source
 * surface and the package.json `exports` entry stay aligned with
 * the contract that adapter-only surfaces live behind a separate
 * entrypoint and never leak into the public API.
 */
describe('@causl/core/internal entrypoint', () => {
  /**
   * The source module must export the sentinel marker. A future
   * refactor that empties the file would silently break adapter
   * imports; this assertion is the canary.
   */
  it('exports the INTERNAL_ENTRYPOINT marker', () => {
    // assert: the marker resolves and carries the documented value
    expect(INTERNAL_ENTRYPOINT).toBe('@causl/core/internal')
  })

  /**
   * `package.json` must declare a `./internal` conditional export
   * that maps to the built `dist/internal.{js,d.ts}` artefacts. This
   * is the only contract that lets a downstream adapter import from
   * the entrypoint at all.
   */
  it('declares the ./internal conditional export in package.json', () => {
    // arrange: read the package manifest once, treat as JSON
    const pkgPath = resolve(__dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports?: Record<string, { types?: string; import?: string }>
    }

    // assert: the ./internal entry exists with both type and runtime keys
    expect(pkg.exports).toBeDefined()
    expect(pkg.exports?.['./internal']).toBeDefined()
    expect(pkg.exports?.['./internal']?.types).toBe('./dist/internal.d.ts')
    expect(pkg.exports?.['./internal']?.import).toBe('./dist/internal.js')
  })

  /**
   * The build pipeline must emit `dist/internal.js` — otherwise the
   * `./internal` exports entry above would point at a file that
   * never gets generated. Issue #684 moved the multi-entry build
   * out of the inline `tsup …` invocation and into
   * `tsup.config.ts`; this assertion follows it there so the two
   * ends of the contract stay aligned.
   */
  it('lists src/internal.ts as a tsup entry in tsup.config.ts', () => {
    // arrange: read the tsup config once
    const cfgPath = resolve(__dirname, '../tsup.config.ts')
    const cfg = readFileSync(cfgPath, 'utf8')

    // assert: the config names src/internal.ts as an entry
    expect(cfg).toContain("'src/internal.ts'")
  })
})
