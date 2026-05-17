import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.js'
import { VERSION } from '../src/index.js'

// `process.cwd()` is the package directory under vitest workspace runs,
// which keeps the test honest about the package.json under inspection.
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

describe('@causljs/persistence scaffolding', () => {
  it('exports a version placeholder', () => {
    expect(typeof VERSION).toBe('string')
  })

  // §13 boundary posture: persistence wraps the host's own engine,
  // so `@causljs/core` belongs in peerDependencies — declaring it as a
  // runtime dep risks duplicate-graph hazards (two `createCausl`
  // instances with divergent identity) when a consumer pins core.
  it('declares @causljs/core as a peerDependency, not a runtime dependency', () => {
    expect(pkg.peerDependencies?.['@causljs/core']).toBeDefined()
    expect(pkg.dependencies?.['@causljs/core']).toBeUndefined()
  })

  // §7.2 surface lock: the public barrel is the editor-controller-state
  // contract. Asserting the named exports here — by reading from the
  // public barrel only, never a deep import — pins the surface against
  // shape drift in every downstream PR.
  it('exposes persistedInput as a named export', () => {
    expect(typeof mod.persistedInput).toBe('function')
  })

  it('exposes localStorageAdapter factory as a named export', () => {
    expect(typeof mod.localStorageAdapter).toBe('function')
  })

  it('exposes memoryAdapter factory as a named export', () => {
    expect(typeof mod.memoryAdapter).toBe('function')
  })

  // `StorageAdapter` is a type-level export with no runtime form. We
  // exercise its shape transitively via the factory: the result of
  // `memoryAdapter()` must satisfy the `get/set/delete` contract,
  // which is what the type names. If the type is dropped from the
  // barrel a future TS build will fail — and so will this smoke.
  it('exposes the StorageAdapter shape via memoryAdapter (get/set/delete)', () => {
    const a = mod.memoryAdapter()
    expect(typeof a.get).toBe('function')
    expect(typeof a.set).toBe('function')
    expect(typeof a.delete).toBe('function')
  })

  // `migrate` is shipped as an option on `PersistedInputOptions`, not as
  // a top-level helper. We lock the as-shipped surface in two pieces:
  //  (a) positive — the option is callable and reachable from a real
  //      `persistedInput` call.
  //  (b) negative — no top-level `migrate` symbol exists. A future PR
  //      that adds one without updating the README §13 boundary will
  //      trip this assertion.
  it('exposes migrate as a PersistedInputOptions field, not a top-level helper', () => {
    const g = createCausl()
    let migrateCalls = 0
    const storage = mod.memoryAdapter({
      'scaffold:m': JSON.stringify({ version: 1, value: 'old' }),
    })
    mod.persistedInput(g, 'scaffold-m', 'fallback', {
      key: 'scaffold:m',
      storage,
      version: 2,
      migrate: (_v, _ver) => {
        migrateCalls++
        return 'migrated'
      },
      onError: () => {},
    })
    expect(migrateCalls).toBe(1)
    expect((mod as Record<string, unknown>).migrate).toBeUndefined()
  })

  // §13 non-goal: `persistedGraph` is deliberately not part of the
  // surface. Persisting an entire graph would require persisting
  // derived caches, which is the §3 glitch-freedom hazard the package
  // exists to refuse. Lock the absence at runtime, not just in prose.
  it('does not export a persistedGraph helper', () => {
    expect((mod as Record<string, unknown>).persistedGraph).toBeUndefined()
  })

  // The compile-time `persistedInput` refuses-derived contract is
  // covered by the sibling tsd fixture in `test-d/persistedInput.test-d.ts`
  // (issue #232). It is intentionally not an `it.todo` here — runtime
  // checks cannot prove a compile-time refusal.
})
