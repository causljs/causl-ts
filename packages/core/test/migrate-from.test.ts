/**
 * @packageDocumentation
 *
 * `_migrateFrom(graph, snap)` tests — issue #1090.
 *
 * The internal-API migration hydrate path applies a `GraphSnapshot` to
 * a fresh graph WITHOUT publishing the synthetic `'hydrate'` commit
 * record that `Graph.hydrate` appends for SPEC §3 monotonicity. The
 * §3 invariant is preserved by adopting `snap.time` as the engine
 * clock directly: a fresh graph at `now = 0` with no commit history
 * can take `snap.time` as its genesis because there is no preceding
 * `t` for the new clock to break ordering against.
 *
 * `_migrateFrom` exists only for two consumers:
 *
 *   1. The WASM auto-adapt wrapper (`WasmBackend.__migrateFrom`),
 *      so a JS → WASM migration reaches the wasm-side engine without
 *      an intervening synthetic record.
 *
 *   2. The cross-backend determinism property test
 *      (`packages/core/test/properties/cross-backend-determinism.
 *      property.test.ts`), so the migration matrix can compare literal
 *      IR byte-equality against an (N+M)-commit pure-TS baseline that
 *      has no `'hydrate'` entry.
 *
 * Adopters MUST use `Graph.hydrate` for the documented SSR-restore
 * path; the synthetic `'hydrate'` commit is the structural marker that
 * says "the engine clock advanced because state was bulk-loaded, not
 * because of a user commit" and is the right shape for the running-
 * graph case.
 */

import { describe, expect, it } from 'vitest'
import {
  CommitInProgressError,
  HydrationSchemaError,
  createCausl,
} from '../src/index.js'
import { _migrateFrom } from '../src/internal.js'

describe('_migrateFrom (internal-API migration hydrate, #1090)', () => {
  it('applies the snapshot to a fresh graph without publishing a hydrate commit', () => {
    // arrange: a fresh graph mirroring the snapshot's id-set
    const g = createCausl({ name: 'migrate-from-basic' })
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    g.derived<number>('c', (get) => get(a) + get(b))
    const seenCommits: string[] = []
    g.subscribeCommits((c) => seenCommits.push(c.intent))

    // act: migrate from a snapshot whose recorded time is 5
    _migrateFrom(g, {
      schema: 1,
      time: 5,
      inputs: { a: 10, b: 20 },
    })

    // assert: engine clock adopts snap.time directly
    expect(g.now).toBe(5)
    // assert: no commit observer fired — the migration boundary is
    //   not a commit
    expect(seenCommits).toEqual([])
    // assert: input values landed and the derived recomputed
    expect(g.read(a)).toBe(10)
    expect(g.read(b)).toBe(20)
    expect(g.exportModel().commits).toEqual([])
  })

  it('post-migration commits tick forward from snap.time (§3 monotonicity preserved)', () => {
    const g = createCausl({ name: 'migrate-from-monotonic' })
    const a = g.input('a', 1)
    _migrateFrom(g, { schema: 1, time: 5, inputs: { a: 10 } })
    expect(g.now).toBe(5)

    // The next commit moves the clock to snap.time + 1, not 1.
    g.commit('post-migrate', (tx) => tx.set(a, 99))
    expect(g.now).toBe(6)
    g.commit('post-migrate-2', (tx) => tx.set(a, 100))
    expect(g.now).toBe(7)
  })

  it('produces literal-IR byte-equal state vs a pure-TS replay of the same write sequence (closes #1090)', () => {
    const N = 5
    const M = 5
    const graphName = 'migrate-from-byte-equal'
    // Use the default `commitHistoryCap` (=0). The cross-backend
    // determinism migration matrix also runs at the default cap, so
    // the byte-equality this test asserts is the contract that gate
    // depends on. Adopters who opt into a positive cap retain a
    // fresh post-migration history on the dest side (which is the
    // intentional shape — `snapshot` carries state, not the source's
    // commit log).

    // pure-TS baseline: a single graph with (N + M) sequential commits.
    const baseline = createCausl({ name: graphName })
    const bA = baseline.input('a', 1)
    const bB = baseline.input('b', 2)
    baseline.derived<number>('c', (get) => get(bA) + get(bB))
    for (let i = 0; i < N + M; i++) {
      const target = i % 2 === 0 ? bA : bB
      baseline.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
    }

    // migrated path: build the same N-commit prefix on one graph,
    //   snapshot, then `_migrateFrom` onto a fresh graph and run
    //   the remaining M commits on it.
    const src = createCausl({ name: graphName })
    const sA = src.input('a', 1)
    const sB = src.input('b', 2)
    src.derived<number>('c', (get) => get(sA) + get(sB))
    for (let i = 0; i < N; i++) {
      const target = i % 2 === 0 ? sA : sB
      src.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
    }
    const snap = src.snapshot()

    const dest = createCausl({ name: graphName })
    const dA = dest.input('a', 1)
    const dB = dest.input('b', 2)
    dest.derived<number>('c', (get) => get(dA) + get(dB))
    _migrateFrom(dest, snap)
    for (let i = N; i < N + M; i++) {
      const target = i % 2 === 0 ? dA : dB
      dest.commit(`seed-${i}`, (tx) => tx.set(target, i * 10))
    }

    // literal-IR byte-equality — the load-bearing #1090 contract.
    expect(JSON.stringify(dest.exportModel())).toBe(
      JSON.stringify(baseline.exportModel()),
    )
  })

  it('rejects unsupported schema versions with HydrationSchemaError', () => {
    const g = createCausl()
    g.input('a', 1)
    expect(() =>
      _migrateFrom(g, {
        schema: 99 as unknown as 1,
        time: 0,
        inputs: {},
      }),
    ).toThrowError(HydrationSchemaError)
  })

  it('rejects snapshots whose schemaHash does not match the live graph', () => {
    // arrange: produce a snapshot whose schemaHash is computed against
    //   a graph with one set of nodes…
    const src = createCausl()
    src.input('a', 1)
    src.input('b', 2)
    const snap = src.snapshot()

    // …and try to migrate onto a graph with a different node-set.
    const dest = createCausl()
    dest.input('a', 1)
    expect(() => _migrateFrom(dest, snap)).toThrowError(HydrationSchemaError)
  })

  it('rejects misuse on a non-fresh graph (now !== 0)', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    g.commit('advance', (tx) => tx.set(a, 99))
    expect(g.now).toBe(1)

    expect(() =>
      _migrateFrom(g, { schema: 1, time: 5, inputs: { a: 10 } }),
    ).toThrowError(/fresh migration-boundary state/)
  })

  it('rejects re-entrant invocation from inside an in-flight commit', () => {
    const g = createCausl()
    g.input('a', 1)
    expect(() => {
      g.commit('outer', () => {
        _migrateFrom(g, { schema: 1, time: 5, inputs: { a: 10 } })
      })
    }).toThrowError(CommitInProgressError)
  })

  it('silently drops snapshot ids that the live graph does not register', () => {
    // arrange: snapshot carries an `extra` id the dest graph does not
    //   register. The schemaHash gate is the structural rejection path
    //   for id-set drift; when no hash is supplied, unknown ids drop.
    const g = createCausl()
    const a = g.input('a', 1)
    _migrateFrom(g, {
      schema: 1,
      time: 3,
      inputs: { a: 42, extra: 'ignored' },
      // no schemaHash on purpose: the silent-drop path is the contract
      //   for an explicitly-trusted caller (e.g. a runtime migration
      //   where the wire shape is known to diverge from the engine's
      //   id-set in a permitted way).
    })
    expect(g.now).toBe(3)
    expect(g.read(a)).toBe(42)
  })

  it('input values that match the registered initial are skipped (no spurious lastWriteTime stamp)', () => {
    // arrange: a fresh graph whose `a` already carries the snapshot's
    //   recorded value at registration time.
    const g = createCausl()
    g.input('a', 1)
    // act: migrate a snapshot that re-asserts the same value
    _migrateFrom(g, { schema: 1, time: 5, inputs: { a: 1 } })
    // assert: the clock still adopted snap.time even though no write
    //   was needed (the §3 invariant is `now` monotonic, not
    //   "must touch an input")
    expect(g.now).toBe(5)
  })
})
