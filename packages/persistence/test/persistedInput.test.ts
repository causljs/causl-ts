import { createCausl } from '@causl/core'
import { propertyTrials } from '@causl/core-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  memoryAdapter,
  persistedInput,
  type PersistedInputOptions,
  type PersistenceError,
} from '../src/index.js'

function makeOpts<T>(
  overrides: Partial<PersistedInputOptions<T>> = {},
): PersistedInputOptions<T> {
  return {
    key: 'test:key',
    storage: memoryAdapter(),
    version: 1,
    ...overrides,
  } as PersistedInputOptions<T>
}

describe('persistedInput — hydrate-as-initial', () => {
  it('uses initial when storage is empty', () => {
    const g = createCausl()
    const opts = makeOpts<number>({ storage: memoryAdapter() })
    const a = persistedInput(g, 'a', 42, opts)
    expect(g.read(a)).toBe(42)
  })

  it('hydrates from storage when present (matching version)', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 99 }),
    })
    const a = persistedInput(g, 'a', 0, makeOpts<number>({ storage }))
    expect(g.read(a)).toBe(99)
  })
})

describe('persistedInput — write-on-commit', () => {
  it('writes to storage on every commit affecting the input', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    const a = persistedInput(g, 'a', 0, makeOpts<number>({ storage }))
    g.commit('bump', (tx) => tx.set(a, 5))
    const env = JSON.parse(storage.get('test:key')!)
    expect(env).toEqual({ version: 1, value: 5 })
    g.commit('bump-again', (tx) => tx.set(a, 7))
    expect(JSON.parse(storage.get('test:key')!).value).toBe(7)
  })

  it('does not write commits that do not change the input', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    const a = persistedInput(g, 'a', 0, makeOpts<number>({ storage }))
    const other = g.input('other', 0)
    let writes = 0
    const baseSet = storage.set.bind(storage)
    storage.set = (k, v) => {
      writes++
      baseSet(k, v)
    }
    // Commit that doesn't touch `a` — no write.
    const baseline = writes
    g.commit('other', (tx) => tx.set(other, 1))
    expect(writes).toBe(baseline)
  })
})

describe('persistedInput — schema evolution (#138)', () => {
  it('runs `migrate` when the stored version differs', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 'old-string' }),
    })
    const a = persistedInput(
      g,
      'a',
      999,
      makeOpts<number>({
        storage,
        version: 2,
        migrate: (v, ver) => {
          expect(v).toBe('old-string')
          expect(ver).toBe(1)
          return 42
        },
      }),
    )
    expect(g.read(a)).toBe(42)
  })

  it('falls back to `initial` (loud) when stored version differs and no `migrate` supplied', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 'old' }),
    })
    let warned = 0
    const a = persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({
        storage,
        version: 2,
        onMigrationFailure: () => {
          warned++
        },
      }),
    )
    expect(g.read(a)).toBe('fallback')
    expect(warned).toBe(1)
  })

  it('falls back when `migrate` itself throws', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 'x' }),
    })
    let warned: unknown = null
    const a = persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({
        storage,
        version: 2,
        migrate: () => {
          throw new Error('migrate-boom')
        },
        onMigrationFailure: (info) => {
          warned = info.error
        },
      }),
    )
    expect(g.read(a)).toBe('fallback')
    expect((warned as Error).message).toBe('migrate-boom')
  })

  it('refuses corrupt JSON in storage', () => {
    const g = createCausl()
    const storage = memoryAdapter({ 'test:key': '{not-json' })
    let kind: string | null = null
    const a = persistedInput(
      g,
      'a',
      'safe',
      makeOpts<string>({
        storage,
        version: 1,
        onError: (err) => {
          kind = err.kind
        },
      }),
    )
    expect(g.read(a)).toBe('safe')
    expect(kind).toBe('parse')
  })
})

describe('persistedInput — typed PersistenceError dispatch (review-209 P0)', () => {
  it('dispatches { kind: "parse" } on corrupt JSON', () => {
    const g = createCausl()
    const storage = memoryAdapter({ 'test:key': '{not-json' })
    const seen: PersistenceError[] = []
    persistedInput(
      g,
      'a',
      'safe',
      makeOpts<string>({
        storage,
        onError: (err) => seen.push(err),
      }),
    )
    expect(seen.length).toBe(1)
    expect(seen[0]!.kind).toBe('parse')
    expect((seen[0] as { key: string }).key).toBe('test:key')
  })

  it('dispatches { kind: "migrate-missing" } when stored version differs and no migrate', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 'old' }),
    })
    const seen: PersistenceError[] = []
    persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({
        storage,
        version: 2,
        onError: (err) => seen.push(err),
      }),
    )
    expect(seen.length).toBe(1)
    const e = seen[0]!
    expect(e.kind).toBe('migrate-missing')
    if (e.kind === 'migrate-missing') {
      expect(e.expectedVersion).toBe(2)
      expect(e.storedVersion).toBe(1)
      // The `migrate-missing` arm has no `cause` field at all (#370).
      // The previous shape encoded "no cause" as `cause: undefined` on
      // a single `migrate` arm; that is the optional-field state
      // machine SPEC §17.4 forbids. The new tag literally lacks the
      // property — `'cause' in e` is false, not just `e.cause ===
      // undefined`.
      expect('cause' in e).toBe(false)
    }
  })

  it('dispatches { kind: "migrate-threw", cause } when migrate throws', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 'x' }),
    })
    const seen: PersistenceError[] = []
    persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({
        storage,
        version: 2,
        migrate: () => {
          throw new Error('boom')
        },
        onError: (err) => seen.push(err),
      }),
    )
    expect(seen.length).toBe(1)
    const e = seen[0]!
    expect(e.kind).toBe('migrate-threw')
    if (e.kind === 'migrate-threw') {
      expect((e.cause as Error).message).toBe('boom')
      expect(e.expectedVersion).toBe(2)
      expect(e.storedVersion).toBe(1)
    }
  })

  it('dispatches { kind: "quota" } when storage.set throws', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    storage.set = () => {
      throw new Error('QuotaExceededError')
    }
    const seen: PersistenceError[] = []
    const a = persistedInput(
      g,
      'a',
      0,
      makeOpts<number>({
        storage,
        onError: (err) => seen.push(err),
      }),
    )
    g.commit('bump', (tx) => tx.set(a, 1))
    expect(seen.length).toBe(1)
    expect(seen[0]!.kind).toBe('quota')
  })

  it('dispatches { kind: "serialise" } when JSON.stringify throws', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    const seen: PersistenceError[] = []
    // Engineer a value that cannot be JSON-serialised. We commit a
    // BigInt by widening through `unknown`; the engine accepts any T,
    // and JSON.stringify(BigInt) throws.
    const a = persistedInput(
      g,
      'a',
      0 as unknown,
      makeOpts<unknown>({
        storage,
        onError: (err) => seen.push(err),
      }),
    )
    g.commit('bump', (tx) => tx.set(a as never, 1n as never))
    expect(seen.length).toBe(1)
    expect(seen[0]!.kind).toBe('serialise')
  })
})

describe('persistedInput — preserveOnError keeps existing envelope (#138 P0)', () => {
  it('preserves the corrupt envelope on parse failure (default preserveOnError=true)', () => {
    const g = createCausl()
    const corrupt = '{not-json'
    const storage = memoryAdapter({ 'test:key': corrupt })
    persistedInput(
      g,
      'a',
      'safe',
      makeOpts<string>({ storage, onError: () => {} }),
    )
    expect(storage.get('test:key')).toBe(corrupt)
  })

  it('preserves the on-disk envelope when stored version differs and no migrate', () => {
    const g = createCausl()
    const stored = JSON.stringify({ version: 1, value: 'old' })
    const storage = memoryAdapter({ 'test:key': stored })
    persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({ storage, version: 2, onError: () => {} }),
    )
    expect(storage.get('test:key')).toBe(stored)
  })

  it('preserves the on-disk envelope when migrate throws', () => {
    const g = createCausl()
    const stored = JSON.stringify({ version: 1, value: 'x' })
    const storage = memoryAdapter({ 'test:key': stored })
    persistedInput(
      g,
      'a',
      'fallback',
      makeOpts<string>({
        storage,
        version: 2,
        migrate: () => {
          throw new Error('boom')
        },
        onError: () => {},
      }),
    )
    expect(storage.get('test:key')).toBe(stored)
  })

  it('preserves the on-disk envelope when a write hits quota', () => {
    const g = createCausl()
    const initialOnDisk = JSON.stringify({ version: 1, value: 7 })
    const storage = memoryAdapter({ 'test:key': initialOnDisk })
    let throwOnSet = false
    const baseSet = storage.set.bind(storage)
    storage.set = (k, v) => {
      if (throwOnSet) throw new Error('Quota')
      baseSet(k, v)
    }
    const a = persistedInput(
      g,
      'a',
      0,
      makeOpts<number>({ storage, onError: () => {} }),
    )
    expect(g.read(a)).toBe(7)
    throwOnSet = true
    g.commit('bump', (tx) => tx.set(a, 99))
    // Envelope on disk is unchanged because the quota-throwing set
    // never wrote — preserveOnError leaves the previous bytes intact.
    expect(storage.get('test:key')).toBe(initialOnDisk)
  })

  it('preserveOnError=false drops the corrupt envelope on parse failure', () => {
    const g = createCausl()
    const storage = memoryAdapter({ 'test:key': '{not-json' })
    persistedInput(
      g,
      'a',
      'safe',
      makeOpts<string>({
        storage,
        preserveOnError: false,
        onError: () => {},
      }),
    )
    expect(storage.get('test:key')).toBe(null)
  })
})

describe('persistedInput — boot-write skip (review-209 P0)', () => {
  it('does not write to storage when constructed (cold start)', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    let writes = 0
    const baseSet = storage.set.bind(storage)
    storage.set = (k, v) => {
      writes++
      baseSet(k, v)
    }
    persistedInput(g, 'a', 42, makeOpts<number>({ storage }))
    expect(writes).toBe(0)
    expect(storage.get('test:key')).toBe(null)
  })

  it('does not write on hydrate-from-storage cold start', () => {
    const g = createCausl()
    const storage = memoryAdapter({
      'test:key': JSON.stringify({ version: 1, value: 99 }),
    })
    let writes = 0
    const baseSet = storage.set.bind(storage)
    storage.set = (k, v) => {
      writes++
      baseSet(k, v)
    }
    persistedInput(g, 'a', 0, makeOpts<number>({ storage }))
    expect(writes).toBe(0)
  })

  it('still writes on the first real commit after construction', () => {
    const g = createCausl()
    const storage = memoryAdapter()
    const a = persistedInput(g, 'a', 0, makeOpts<number>({ storage }))
    g.commit('bump', (tx) => tx.set(a, 1))
    expect(JSON.parse(storage.get('test:key')!).value).toBe(1)
  })
})

describe('persistedInput — round-trip property tests', () => {
  // Property: for any JSON-serialisable value T, hydrate→commit→hydrate
  // is a fixed point under the JSON.stringify/JSON.parse normalisation
  // that `persistedInput` actually performs. This is the central §13
  // claim of the package — "persistence is an overlay; the in-memory
  // graph is the source of truth, the on-disk envelope is the same
  // value modulo serialisation". Asserting it on a single example
  // (the existing eq-skip suite) verifies behaviour for one shape;
  // the §15.2 property suite is what catches the next regression
  // before it ships, by exploring the JSON value space at scale.
  //
  // Generator: `fc.jsonValue()` covers nulls, booleans, finite numbers
  // (no NaN/Infinity per fast-check's JsonConstraintsBuilder), strings,
  // arrays, and nested objects. BigInt and `undefined` are deliberately
  // excluded — those are the `kind: 'serialise'` cases covered by the
  // `dispatches { kind: 'serialise' }` example test above.
  //
  // Normalisation: `JSON.stringify(JSON.parse(...))` is not the
  // identity for every JSON value (`-0` round-trips to `0` because
  // JSON has no `-0` representation, even though `JSON.parse('-0')`
  // does yield `-0`). Comparing against `JSON.parse(JSON.stringify(v))`
  // matches the contract `persistedInput` actually exposes — anything
  // stricter would catch a generator artefact, not a bug in the
  // package.
  //
  // Trial floor: `propertyTrials('persistedInput-roundtrip')` enforces
  // the §15.2 ≥1000-trial floor structurally; `unsafeTrials` below
  // 1000 is rejected by lint. The label is namespaced so a CI
  // failure points at this suite without spelunking, and the seed is
  // logged for regression-as-fixture replay.
  it('property: round-trip preserves T for any JSON-serialisable T at 1000 trials', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const storage = memoryAdapter()
        const g1 = createCausl()
        const a1 = persistedInput(
          g1,
          'rt',
          null as unknown,
          makeOpts<unknown>({ storage }),
        )
        g1.commit('rt-set', (tx) => tx.set(a1, value as never))

        // Hydrate a *fresh* graph from the same storage envelope. This
        // is what a page reload looks like to the package: a new
        // engine, the same on-disk bytes, and the §13 claim that the
        // in-memory value at t=0 matches the value just committed
        // before the reload.
        const g2 = createCausl()
        const a2 = persistedInput(
          g2,
          'rt',
          null as unknown,
          makeOpts<unknown>({ storage }),
        )

        // Compare against the JSON.parse(JSON.stringify(...)) image
        // because that is the actual normalisation `persistedInput`
        // performs. `-0 → 0` is the common case where strict equality
        // diverges from the package's contracted behaviour.
        const normalised: unknown = JSON.parse(JSON.stringify(value))
        expect(g2.read(a2)).toEqual(normalised)
      }),
      propertyTrials('persistedInput-roundtrip'),
    )
  })

  // Eq-skip companion: re-committing the *same reference* the engine
  // currently holds for a freshly hydrated input must not write to
  // storage. The engine uses `Object.is` for input-value equality
  // (see `graph.ts` Phase B publish, gated by `!Object.is(e.value, v)`),
  // so the only contract we can fuzz at structural-property scale is
  // "set the value to itself is a no-op". For primitive shapes this
  // is also a structural equality; for object / array shapes it is a
  // reference equality, which is what the engine's contract actually
  // commits to. This catches an eq-skip regression where a future
  // refactor accidentally writes on every commit regardless of
  // whether the input changed. (The cross-graph structural-equal
  // skip is a separate contract the engine does not promise — see
  // `Object.is` cutoff, line 858 of `graph.ts`.)
  it('property: eq-skip on no-op re-commit of the held reference after rehydration', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const storage = memoryAdapter()
        const g1 = createCausl()
        const a1 = persistedInput(
          g1,
          'rt-eq',
          null as unknown,
          makeOpts<unknown>({ storage, key: 'test:key:eq' }),
        )
        g1.commit('rt-set', (tx) => tx.set(a1, value as never))

        // Wrap the adapter on g2 so we can count its writes
        // independently of g1's first commit.
        let writes = 0
        const wrapped = {
          get: (k: string) => storage.get(k),
          set: (k: string, v: string) => {
            writes++
            storage.set(k, v)
          },
          delete: (k: string) => {
            storage.delete(k)
          },
        }
        const g2 = createCausl()
        const a2 = persistedInput(
          g2,
          'rt-eq',
          null as unknown,
          makeOpts<unknown>({ storage: wrapped, key: 'test:key:eq' }),
        )
        // Re-commit the *exact reference* g2 currently holds. Under
        // the engine's `Object.is` cutoff this is a no-op write, so
        // the adapter must observe zero writes during this commit.
        const held: unknown = g2.read(a2)
        g2.commit('rt-noop', (tx) => tx.set(a2, held as never))
        expect(writes).toBe(0)
      }),
      propertyTrials('persistedInput-roundtrip-eqskip'),
    )
  })
})
